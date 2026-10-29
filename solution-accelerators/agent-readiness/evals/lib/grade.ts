import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validatePart1 } from "../../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../../skill/agent-readiness/scripts/lib/rubric.ts";
import { validateAgainst } from "../../skill/agent-readiness/scripts/lib/schema.ts";
import type { ReportJson } from "../../skill/agent-readiness/scripts/lib/types.ts";
import { expected } from "../../tools/fixture.ts";
import type { ExpectedRun } from "../../tools/fixture.ts";
import { trajectoryGate } from "./trajectory.ts";
import type { EvalCase, Gate, GateResult, Trajectory, Workspace } from "./types.ts";

const rubric = loadRubric();

export function latestReport(ws: Workspace): ReportJson | null {
  const f = join(ws.dir, ".agent-readiness/latest/report.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ReportJson) : null;
}

export function roadmap(ws: Workspace): { items: { id: string; status: string; fixes: { condition: string }[] }[] } | null {
  const f = join(ws.dir, ".agent-readiness/roadmap.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

export function historyLines(ws: Workspace): { id: string; kind: string; repoLevel: number }[] {
  const f = join(ws.dir, ".agent-readiness/history/history.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// Oldest first. Audit IDs embed the commit hash, so directory order isn't chronological.
export function sealedAudits(ws: Workspace): Record<string, any>[] {
  const dir = join(ws.dir, ".agent-readiness/history/audits");
  if (!existsSync(dir)) return [];
  const order = historyLines(ws).map((h) => h.id);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return readdirSync(dir)
    .map((id) => JSON.parse(readFileSync(join(dir, id, "audit.json"), "utf8")) as Record<string, any>)
    .sort((a, b) => rank(a.id) - rank(b.id) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function readiness(ws: Workspace, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ws.dir, ".cursor/skills/agent-readiness/scripts/readiness.ts"), ...args], { cwd: ws.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function runFor(c: EvalCase): ExpectedRun {
  const exp = expected(c.fixture);
  return exp.runs.find((r) => r.name === (c.expectedRun ?? "default")) ?? exp.runs[0];
}

const CHECK_OF: Record<string, string> = { "clean.install": "bootstrap.cold_replay", "clean.build": "bootstrap.cold_replay", "clean.test": "bootstrap.cold_replay", toolchain: "bootstrap.cold_replay", lockfile: "bootstrap.cold_replay", commands: "verify.canonical_interface", faults: "verify.behavioral_oracle", instructions: "context.instructions_verified", safety: "safety.execution_boundary" };

export const sealedGate: Gate = (ws) => {
  if (!latestReport(ws) || historyLines(ws).filter((h) => h.kind === "audit").length === 0) return { name: "sealed audit and verify-seal", pass: false, detail: "no sealed audit" };
  const v = readiness(ws, ["verify-seal", "latest", "--allow-eval"]);
  return { name: "sealed audit and verify-seal", pass: v.code === 0, detail: v.out.split("\n").filter((l) => l.startsWith("FAIL") || l.startsWith("readiness:")).join(" ") || "verify-seal passed" };
};

export type ExpectedLevels = Pick<ExpectedRun, "level" | "levels">;

// The repo rollup and each component's standard level, as report.json gives them.
export function levelsMatch(want: ExpectedLevels, name: string): Gate {
  return (ws) => {
    const r = latestReport(ws);
    if (!r) return { name, pass: false, detail: "no report" };
    const got: Record<string, number | null> = {};
    for (const comp of r.components.included) got[comp.id] = comp.level;
    const ok = JSON.stringify(sortKeys(got)) === JSON.stringify(sortKeys(want.levels));
    return { name, pass: ok && r.maturity.level === want.level, detail: ok ? `Level ${r.maturity.level}` : `got ${JSON.stringify(got)}, repo ${r.maturity.level}` };
  };
}

export const levelsGate: Gate = (ws, t, c) => levelsMatch(runFor(c), "levels match expected.json")(ws, t, c);

function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v && typeof v === "object" ? sortKeys(v as Record<string, unknown>) : v])) as T;
}

export const topGate: Gate = (ws, _t, c) => {
  const r = latestReport(ws);
  const rm = roadmap(ws);
  const run = runFor(c);
  if (!r || !rm) return { name: "top items match expected.json", pass: false, detail: "no report" };
  const top = r.actions.filter((a) => !a.startNow).map((a) => a.itemId);
  const passed = new Set(r.details.checks.filter((x) => x.ok === true).map((x) => x.id));
  const bad = top.filter((id) => rm.items.find((i) => i.id === id)?.fixes.some((f) => passed.has(CHECK_OF[f.condition])));
  const primaryOk = top[0] === run.top[0];
  return { name: "top items match expected.json", pass: primaryOk && bad.length === 0, detail: primaryOk ? (bad.length ? `items name passed checks: ${bad.join(", ")}` : `primary blocker ${top[0]}`) : `primary blocker ${top[0] ?? "none"}, expected ${run.top[0]}` };
};

export const reportGate: Gate = (ws) => {
  const r = latestReport(ws);
  if (!r) return { name: "report.json schema and part 1 rules", pass: false, detail: "no report" };
  const errors = [...validateAgainst("report", r), ...validatePart1(r, rubric, null)];
  return { name: "report.json schema and part 1 rules", pass: errors.length === 0, detail: errors.slice(0, 3).join("; ") || "valid" };
};

export const trajectory: Gate = (ws, t, c) => trajectoryGate(ws, t, Boolean(c.remediation));

export const DEFAULT_GATES: Gate[] = [sealedGate, levelsGate, topGate, reportGate, trajectory];

export function gradeCase(ws: Workspace, t: Trajectory, c: EvalCase): GateResult[] {
  const gates = (c.gates ?? DEFAULT_GATES).slice(0, 5);
  return gates.map((g) => {
    try {
      return g(ws, t, c);
    } catch (e) {
      return { name: g.name || "gate", pass: false, detail: `gate crashed: ${(e as Error).message}` };
    }
  });
}

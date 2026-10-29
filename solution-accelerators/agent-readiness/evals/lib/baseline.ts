import { writeFileSync } from "node:fs";
import type { CaseRun } from "./types.ts";

export interface CaseSummary {
  runs: number;
  gates: Record<string, string>;
  allGatesPass: string;
  judge: number | null;
  page: number | null;
  wallMs: number;
  toolCalls: number;
  tokens: number | null;
}

export interface Baseline {
  schema: "agent-readiness/eval-baseline@1";
  recordedAt: string;
  model: string;
  driver: string;
  repeats: number;
  note?: string;
  cases: Record<string, CaseSummary>;
  totals: { cases: number; allGatesPass: string; judgeAverage: number | null; pageAverage: number | null };
}

function avg(xs: number[]): number | null {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null;
}

export function summarize(runs: CaseRun[], model: string, driver: string, repeats: number, note?: string): Baseline {
  const byCase = new Map<string, CaseRun[]>();
  for (const r of runs) byCase.set(r.id, [...(byCase.get(r.id) ?? []), r]);
  const cases: Record<string, CaseSummary> = {};
  let allPass = 0;
  const judges: number[] = [];
  const pages: number[] = [];
  for (const [id, list] of [...byCase.entries()].sort()) {
    const gateNames = [...new Set(list.flatMap((r) => r.grade.gates.map((g) => g.name)))];
    const gates: Record<string, string> = {};
    for (const g of gateNames) gates[g] = `${list.filter((r) => r.grade.gates.find((x) => x.name === g)?.pass).length}/${list.length}`;
    const passing = list.filter((r) => r.grade.gates.every((g) => g.pass)).length;
    if (passing === list.length) allPass++;
    const js = list.map((r) => r.grade.soft.judge).filter((x): x is number => x !== null);
    judges.push(...js);
    const ps = list.map((r) => r.grade.soft.page).filter((x): x is number => x !== null && x !== undefined);
    pages.push(...ps);
    cases[id] = {
      runs: list.length,
      gates,
      allGatesPass: `${passing}/${list.length}`,
      judge: avg(js),
      page: avg(ps),
      wallMs: Math.round(avg(list.map((r) => r.grade.soft.wallMs)) ?? 0),
      toolCalls: Math.round(avg(list.map((r) => r.grade.soft.toolCalls)) ?? 0),
      tokens: avg(list.map((r) => r.grade.soft.tokens).filter((x): x is number => x !== null)),
    };
  }
  return { schema: "agent-readiness/eval-baseline@1", recordedAt: new Date().toISOString(), model, driver, repeats, note, cases, totals: { cases: byCase.size, allGatesPass: `${allPass}/${byCase.size}`, judgeAverage: avg(judges), pageAverage: avg(pages) } };
}

function ratio(s: string): number {
  const [a, b] = s.split("/").map(Number);
  return b ? a / b : 0;
}

export function compare(current: Baseline, base: Baseline): { regressions: string[]; flags: string[] } {
  const regressions: string[] = [];
  const flags: string[] = [];
  for (const [id, c] of Object.entries(current.cases)) {
    const b = base.cases[id];
    if (!b) continue;
    for (const [g, v] of Object.entries(c.gates)) if (b.gates[g] && ratio(v) < ratio(b.gates[g])) regressions.push(`${id}: "${g}" ${b.gates[g]} -> ${v}`);
    if (b.judge !== null && c.judge !== null && b.judge - c.judge > 0.1) flags.push(`${id}: judge ${b.judge} -> ${c.judge}`);
    if (b.page != null && c.page != null && b.page - c.page > 0.1) flags.push(`${id}: page judge ${b.page} -> ${c.page}`);
  }
  return { regressions, flags };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function writeJunit(path: string, runs: CaseRun[]): void {
  const cases = runs.flatMap((r) => r.grade.gates.map((g) => ({ name: `${r.id} #${r.repeat} ${g.name}`, g, r })));
  const failures = cases.filter((c) => !c.g.pass).length;
  const body = cases
    .map((c) => `  <testcase classname="agent-readiness.${esc(c.r.id)}" name="${esc(c.name)}" time="${(c.r.grade.soft.wallMs / 1000).toFixed(1)}">${c.g.pass ? "" : `<failure message="${esc(c.g.detail)}"/>`}</testcase>`)
    .join("\n");
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="agent-readiness skill evals" tests="${cases.length}" failures="${failures}">\n${body}\n</testsuite>\n`);
}

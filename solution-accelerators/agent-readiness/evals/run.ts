import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, summarize, writeJunit } from "./lib/baseline.ts";
import type { Baseline } from "./lib/baseline.ts";
import { gradeCase, latestReport } from "./lib/grade.ts";
import { renderMarkdown } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import type { ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import { PROMPTS, judge } from "./lib/judge.ts";
import type { JudgeResult } from "./lib/judge.ts";
import { rerenderLatest } from "./lib/rerender.ts";
import { runWithSdk } from "./lib/sdk.ts";
import type { CaseRun, EvalCase, Trajectory } from "./lib/types.ts";
import { applyTurnHook, externalPreamble, fillPrompt, loadWorkspace, prepare, skillPreamble } from "./lib/workspace.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = process.env.SA_READINESS_EVAL_MODEL ?? "composer-2";
const JUDGE_MODEL = process.env.SA_READINESS_JUDGE_MODEL ?? DEFAULT_MODEL;

function args() {
  const a = process.argv.slice(2);
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const key = a[i].slice(2);
    const next = a[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

async function loadCases(): Promise<EvalCase[]> {
  const dir = join(HERE, "cases");
  const out: EvalCase[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")).sort()) {
    const mod = (await import(join(dir, f))) as { cases?: EvalCase[]; default?: EvalCase };
    const list = mod.cases ?? (mod.default ? [mod.default] : []);
    const prefix = basename(f, ".ts");
    for (const c of list) out.push({ ...c, id: `${prefix}/${c.id}` });
  }
  return out;
}

function select(all: EvalCase[], flags: Record<string, string | true>): EvalCase[] {
  const tag = typeof flags.tag === "string" ? flags.tag : undefined;
  const only = typeof flags.case === "string" ? flags.case.split(",") : undefined;
  return all.filter((c) => (!tag || c.tags.includes(tag as "smoke" | "full")) && (!only || only.some((o) => c.id === o || c.id.endsWith("/" + o))));
}

function writeJudgePrompts(dir: string, r: ReportJson): void {
  for (const [kind, prompt] of Object.entries(PROMPTS)) writeFileSync(join(dir, `${kind}-prompt.txt`), prompt(r));
}

function readJudge(file: string): JudgeResult {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as JudgeResult) : { score: null, reasons: ["judge not run"] };
}

function externalTrajectory(root: string, wallMs: number): Trajectory {
  const reply = join(root, "reply.md");
  return { driver: "external", toolCalls: [], text: existsSync(reply) ? readFileSync(reply, "utf8") : "", durationMs: wallMs, tokens: null, error: null };
}

async function worker(flags: Record<string, string | true>): Promise<void> {
  const all = await loadCases();
  const c = all.find((x) => x.id === flags.case)!;
  const model = String(flags.model);
  const ws = prepare(c);
  const t = await runWithSdk(ws, c, model, process.env.CURSOR_API_KEY!, Number(flags["timeout-min"] ?? 30) * 60000);
  const gates = gradeCase(ws, t, c);
  const [h, p] = await Promise.all((["headline", "page"] as const).map((k) => judge(k, latestReport(ws), JUDGE_MODEL, process.env.CURSOR_API_KEY)));
  const run: CaseRun = { id: c.id, repeat: Number(flags.repeat), model, driver: "sdk", workspace: ws.dir, grade: { gates, soft: { judge: h.score, judgeReasons: h.reasons, page: p.score, pageReasons: p.reasons, wallMs: t.durationMs, toolCalls: t.toolCalls.length, tokens: t.tokens } }, error: t.error };
  writeFileSync(String(flags.out), JSON.stringify({ run, trajectory: t }, null, 2));
}

function spawnWorker(c: EvalCase, repeat: number, model: string, out: string, timeoutMin: string): Promise<void> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), "--worker", "--case", c.id, "--repeat", String(repeat), "--model", model, "--out", out, "--timeout-min", timeoutMin], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
    child.on("close", () => done());
  });
}

function collect(dir: string): CaseRun[] {
  const runs: CaseRun[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === "result.json" || n.endsWith(".run.json")) runs.push((JSON.parse(readFileSync(p, "utf8")) as { run: CaseRun }).run);
    }
  };
  walk(dir);
  return runs;
}

function report(runs: CaseRun[], flags: Record<string, string | true>, model: string, driver: string, repeats: number): number {
  const summary = summarize(runs, model, driver, repeats, typeof flags.note === "string" ? flags.note : undefined);
  for (const [id, s] of Object.entries(summary.cases)) process.stdout.write(`${s.allGatesPass.padStart(5)}  ${id.padEnd(48)} judge ${s.judge ?? "n/a"} page ${s.page ?? "n/a"}  ${Object.entries(s.gates).filter(([, v]) => !v.startsWith(String(s.runs))).map(([g, v]) => `${g} ${v}`).join("; ")}\n`);
  process.stdout.write(`All gates passed in ${summary.totals.allGatesPass} cases. Headline judge average ${summary.totals.judgeAverage ?? "n/a"}; page judge average ${summary.totals.pageAverage ?? "n/a"}.\n`);
  if (typeof flags.json === "string") {
    mkdirSync(dirname(resolve(flags.json)), { recursive: true });
    writeFileSync(resolve(flags.json), JSON.stringify({ summary, runs }, null, 2));
  }
  if (typeof flags.junit === "string") {
    mkdirSync(dirname(resolve(flags.junit)), { recursive: true });
    writeJunit(resolve(flags.junit), runs);
  }
  if (typeof flags["write-baseline"] === "string") writeFileSync(resolve(flags["write-baseline"]), JSON.stringify(summary, null, 2) + "\n");
  let code = 0;
  if (typeof flags.compare === "string" && existsSync(resolve(flags.compare))) {
    const base = JSON.parse(readFileSync(resolve(flags.compare), "utf8")) as Baseline;
    const { regressions, flags: soft } = compare(summary, base);
    for (const r of regressions) process.stdout.write(`REGRESSION ${r}\n`);
    for (const f of soft) process.stdout.write(`FLAG ${f}\n`);
    if (regressions.length) code = 1;
  }
  if (runs.some((r) => !r.grade.gates.every((g) => g.pass))) code = code || 2;
  return code;
}

async function main(): Promise<void> {
  const flags = args();
  if (flags.worker) return worker(flags);
  const all = await loadCases();
  if (flags.list) {
    for (const c of all) process.stdout.write(`${c.id.padEnd(48)} [${c.tags.join(",")}] ${c.description}\n`);
    return;
  }
  const repeats = Number(flags.repeats ?? 1);
  const models = String(flags.model ?? DEFAULT_MODEL).split(",");
  if (typeof flags.hook === "string") {
    const { ws, id } = loadWorkspace(resolve(flags.hook));
    const c = all.find((x) => x.id === id)!;
    const applied = applyTurnHook(ws, c.turns[Number(flags.turn ?? 2) - 1]);
    process.stdout.write(applied ? "Applied the user's change for this turn.\n" : "Nothing to apply for this turn.\n");
    return;
  }
  if (typeof flags.rerender === "string") {
    const root = resolve(flags.rerender);
    const { ws } = loadWorkspace(root);
    const r = rerenderLatest(ws);
    if (!r) throw new Error(`${root} has no sealed audit.`);
    const out = join(root, "rerender", String(flags.label ?? "current"));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "report.md"), renderMarkdown(r, loadRubric(r.audit.rubric)));
    writeJudgePrompts(out, r);
    process.stdout.write(`${out}\n`);
    return;
  }
  if (typeof flags.grade === "string") {
    const root = resolve(flags.grade);
    const { ws, id } = loadWorkspace(root);
    const c = all.find((x) => x.id === id)!;
    const t = externalTrajectory(root, Number(flags["wall-ms"] ?? 0));
    const gates = gradeCase(ws, t, c);
    const report = latestReport(ws);
    if (report) writeJudgePrompts(root, report);
    const h = readJudge(join(root, "headline.json"));
    const p = readJudge(join(root, "page.json"));
    const run: CaseRun = { id, repeat: Number(flags.repeat ?? 1), model: String(flags.model ?? "external"), driver: "external", workspace: ws.dir, grade: { gates, soft: { judge: h.score, judgeReasons: h.reasons, page: p.score, pageReasons: p.reasons, wallMs: t.durationMs, toolCalls: 0, tokens: null } }, error: null };
    writeFileSync(join(root, "result.json"), JSON.stringify({ run }, null, 2));
    for (const g of gates) process.stdout.write(`${g.pass ? "PASS" : "FAIL"}  ${g.name}: ${g.detail}\n`);
    return;
  }
  if (typeof flags.collect === "string") {
    process.exitCode = report(collect(resolve(flags.collect)), flags, String(flags.model ?? "external"), String(flags.driver ?? "external"), repeats);
    return;
  }
  const selected = select(all, flags);
  if (selected.length === 0) throw new Error("No cases match.");
  if (flags.prepare) {
    const manifest = [];
    for (const c of selected) {
      for (let r = 1; r <= repeats; r++) {
        const ws = prepare(c);
        manifest.push({ id: c.id, repeat: r, root: dirname(ws.dir), dir: ws.dir, env: c.env ?? {}, prompts: c.turns.map((t, i) => (i === 0 ? externalPreamble(ws.dir) + skillPreamble(ws.dir) : "") + fillPrompt(t.prompt, ws)), turnHooks: c.turns.map((t) => Boolean(t.before)) });
      }
    }
    const out = typeof flags.out === "string" ? resolve(flags.out) : join(HERE, "runs", "prepared.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(manifest, null, 2));
    process.stdout.write(`Prepared ${manifest.length} workspaces. Manifest: ${out}\n`);
    return;
  }
  if (!process.env.CURSOR_API_KEY) {
    process.stdout.write("CURSOR_API_KEY isn't set, so skill evals are skipped. Add it as a secret to run them.\n");
    return;
  }
  const maxRuns = Number(flags["max-runs"] ?? 120);
  const jobs = selected.flatMap((c) => models.flatMap((m) => Array.from({ length: repeats }, (_, i) => ({ c, m, r: i + 1 }))));
  if (jobs.length > maxRuns) throw new Error(`${jobs.length} runs exceed --max-runs ${maxRuns}.`);
  const outDir = join(HERE, "runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  const concurrency = Number(flags.concurrency ?? 2);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        await spawnWorker(j.c, j.r, j.m, join(outDir, `${j.c.id.replace(/\//g, "__")}.${j.m}.${j.r}.run.json`), String(flags["timeout-min"] ?? 30));
      }
    }),
  );
  let code = 0;
  for (const m of models) code = report(collect(outDir).filter((r) => r.model === m), flags, m, "sdk", repeats) || code;
  process.exitCode = code;
}

main().catch((e: Error) => {
  process.stderr.write(`evals: ${e.message}\n`);
  process.exitCode = 1;
});

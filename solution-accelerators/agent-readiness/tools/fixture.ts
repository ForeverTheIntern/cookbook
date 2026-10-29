import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ACCELERATOR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = join(ACCELERATOR, "fixtures");
export const SKILL = join(ACCELERATOR, "skill", "agent-readiness");
export const CLI = join(SKILL, "scripts", "readiness.ts");

export interface HistorySpec {
  commits: { author: string; email: string; daysAgo: number; paths: string[]; message?: string }[];
}

function restoreNames(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let target = full;
    if (name.startsWith("dot_")) target = join(dir, "." + name.slice(4));
    else if (name === "AGENTS.fixture.md") target = join(dir, "AGENTS.md");
    else if (name === "CLAUDE.fixture.md") target = join(dir, "CLAUDE.md");
    else if (name === "SKILL.fixture.md") target = join(dir, "SKILL.md");
    if (target !== full) renameSync(full, target);
    if (statSync(target).isDirectory()) restoreNames(target);
  }
}

function at(nowIso: string, daysAgo: number): string {
  const d = new Date(nowIso);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

function gitc(cwd: string, args: string[], date: string, author: string, email: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

export function materialize(fixture: string, opts: { now?: string; into?: string } = {}): string {
  const now = opts.now ?? process.env.READINESS_NOW ?? new Date().toISOString();
  const root = opts.into ?? mkdtempSync(join(tmpdir(), `fixture-${fixture}-`));
  const repo = join(root, fixture);
  mkdirSync(repo, { recursive: true });
  cpSync(join(FIXTURES, fixture, "repo"), repo, { recursive: true });
  restoreNames(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  gitc(repo, ["add", "-A"], at(now, 120), "Contributor A", "a@example.com");
  gitc(repo, ["commit", "-q", "-m", "Initial commit"], at(now, 120), "Contributor A", "a@example.com");
  const specPath = join(FIXTURES, fixture, "history.json");
  if (existsSync(specPath)) {
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as HistorySpec;
    spec.commits.forEach((c, i) => {
      for (const p of c.paths) {
        mkdirSync(dirname(join(repo, p)), { recursive: true });
        appendFileSync(join(repo, p), `change ${i + 1}\n`);
      }
      const date = at(now, c.daysAgo);
      gitc(repo, ["add", "-A"], date, c.author, c.email);
      gitc(repo, ["commit", "-q", "-m", c.message ?? `Change ${i + 1}`], date, c.author, c.email);
    });
  }
  return repo;
}

export function readiness(repo: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

interface PrTemplate {
  agent?: { number: number; head: string; labels: string[]; created: number; merged: number | null; files: string[]; firstCheck: "success" | "failure"; changesRequested: boolean }[];
  agentGroups?: { files: string[]; count: number; firstPass: number; merged: number; changesRequested: number; labels: string[] }[];
  other: { count: number; startNumber: number; firstPass: number; merged: number; changesRequested: number };
}

const OTHER_FILES = [["packages/api/src/orders.js"], ["packages/worker/src/retry.js"], ["packages/shared/src/money.js"], ["infra/main.tf"]];

export function materializePrs(fixture: string, now: string, file = "prs.template.json"): string {
  const t = JSON.parse(readFileSync(join(FIXTURES, fixture, file), "utf8")) as PrTemplate;
  const prs: unknown[] = [];
  for (const a of t.agent ?? []) {
    prs.push({ number: a.number, headRefName: a.head, author: "agent-bot", labels: a.labels, createdAt: at(now, a.created), mergedAt: a.merged === null ? null : at(now, a.merged), state: a.merged === null ? "OPEN" : "MERGED", files: a.files, firstCheck: a.firstCheck, changesRequested: a.changesRequested });
  }
  let n = 500;
  for (const g of t.agentGroups ?? []) {
    for (let i = 0; i < g.count; i++) {
      const created = 2 + ((n * 7) % 26);
      prs.push({ number: n++, headRefName: `cursor/task-${n}`, author: "agent-bot", labels: g.labels, createdAt: at(now, created), mergedAt: i < g.merged ? at(now, created - 1) : null, state: i < g.merged ? "MERGED" : "OPEN", files: g.files, firstCheck: i < g.firstPass ? "success" : "failure", changesRequested: i >= g.count - g.changesRequested });
    }
  }
  const o = t.other;
  for (let i = 0; i < o.count; i++) {
    const created = 1 + ((i * 11) % 28);
    prs.push({ number: o.startNumber + i, headRefName: `feature/change-${i}`, author: `contributor-${String.fromCharCode(97 + (i % 4))}`, labels: i % 3 === 0 ? ["bug"] : i % 3 === 1 ? ["feature"] : [], createdAt: at(now, created), mergedAt: i < o.merged ? at(now, Math.max(0, created - 2)) : null, state: i < o.merged ? "MERGED" : "OPEN", files: OTHER_FILES[i % OTHER_FILES.length], firstCheck: i < o.firstPass ? "success" : "failure", changesRequested: i >= o.count - o.changesRequested });
  }
  const out = join(mkdtempSync(join(tmpdir(), "prs-")), "prs.json");
  writeFileSync(out, JSON.stringify(prs, null, 2));
  return out;
}

export interface ExpectedRun {
  name: string;
  registryEnv?: Record<string, string>;
  level: number;
  levels: Record<string, Record<string, number>>;
  repoLevels: Record<string, number>;
  top: string[];
  startNow: string | null;
  noBlocker: boolean;
  safety: "pass" | "fail";
  notAssessed?: string[];
  waiting?: string[];
  diagnosis?: string;
}

export interface Expected {
  goal: string;
  purpose: string;
  outcomes?: string;
  runs: ExpectedRun[];
}

export function expected(fixture: string): Expected {
  return JSON.parse(readFileSync(join(FIXTURES, fixture, "expected.json"), "utf8")) as Expected;
}

export interface FixtureAudit {
  repo: string;
  code: number;
  out: string;
  report: Record<string, any>;
  roadmap: Record<string, any>;
}

export function auditFixture(fixture: string, run: ExpectedRun, opts: { seed?: string; image?: string; now?: string } = {}): FixtureAudit {
  const exp = expected(fixture);
  const now = opts.now ?? new Date().toISOString();
  const repo = materialize(fixture, { now });
  const args = ["audit", "--goal", exp.goal, "--tier", "local-exec"];
  const env: Record<string, string> = { READINESS_EVAL_SEED: opts.seed ?? "fixture-seed" };
  if (run.registryEnv) {
    args.push("--registry-env", Object.keys(run.registryEnv).join(","));
    Object.assign(env, run.registryEnv);
  }
  if (exp.outcomes) args.push("--outcomes-input", materializePrs(fixture, now, exp.outcomes));
  if (opts.image) args.push("--image", opts.image);
  const r = readiness(repo, args, env);
  const read = (p: string) => (existsSync(join(repo, p)) ? JSON.parse(readFileSync(join(repo, p), "utf8")) : {});
  return { repo, code: r.code, out: r.out, report: read(".agent-readiness/latest/report.json"), roadmap: read(".agent-readiness/roadmap.json") };
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURES).filter((n) => existsSync(join(FIXTURES, n, "repo"))).sort();
}

export function commitAll(repo: string, message: string, daysAgo = 0, now?: string): void {
  const date = at(now ?? process.env.READINESS_NOW ?? new Date().toISOString(), daysAgo);
  gitc(repo, ["add", "-A"], date, "Contributor B", "b@example.com");
  gitc(repo, ["commit", "-q", "-m", message], date, "Contributor B", "b@example.com");
}

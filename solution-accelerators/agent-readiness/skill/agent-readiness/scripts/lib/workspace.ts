import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { latestRubricVersion, rubricDigest } from "./rubric.ts";
import type { ActivityId, Audit, Tier } from "./types.ts";
import { SKILL_ROOT, ensureDir, exists, fail, git, gitOrThrow, nowIso, randomHex, readJson, readText, sha256, today, writeJson, writeText } from "./util.ts";

export interface Paths {
  repo: string;
  records: string;
  work: string;
  history: string;
  latest: string;
  roadmap: string;
  feedback: string;
}

export function resolveRepo(start: string): string {
  const r = git(["rev-parse", "--show-toplevel"], resolve(start));
  if (!r.ok) fail(`Not a git repository: ${start}`);
  return r.stdout.trim();
}

export function paths(repo: string): Paths {
  const records = join(repo, ".agent-readiness");
  const history = process.env.READINESS_HISTORY_DIR ? resolve(process.env.READINESS_HISTORY_DIR) : join(records, "history");
  return {
    repo,
    records,
    work: join(records, "work"),
    history,
    latest: join(records, "latest"),
    roadmap: join(records, "roadmap.json"),
    feedback: join(records, "feedback"),
  };
}

function skillFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  for (const sub of ["scripts", "rubric", "schema", "templates"]) walk(join(SKILL_ROOT, sub));
  return out;
}

export function skillDigest(): string {
  const parts = skillFiles().map((f) => `${relative(SKILL_ROOT, f)}\n${sha256(readText(f))}`);
  return sha256(parts.join("\n"));
}

export interface ReleaseManifest {
  version: string;
  tag: string;
  scriptsDigest: string;
}

export function releaseManifest(): ReleaseManifest | null {
  const p = join(SKILL_ROOT, "RELEASE.json");
  return exists(p) ? readJson<ReleaseManifest>(p) : null;
}

export interface LocalInfo {
  tree: string;
  createdAt: string;
}

export interface InitOptions {
  repo: string;
  goal: ActivityId;
  tier: Tier;
  registryEnv: string[];
  inheritEnv: boolean;
  force: boolean;
}

function repoName(repo: string): string {
  const remote = git(["config", "--get", "remote.origin.url"], repo);
  if (remote.ok && remote.stdout.trim()) {
    const m = remote.stdout.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  }
  return basename(repo);
}

export function isDirty(repo: string): boolean {
  const r = git(["status", "--porcelain"], repo);
  return r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .some((l) => !l.slice(3).startsWith(".agent-readiness/"));
}

export function exportTree(repo: string, commit: string, dest: string): void {
  ensureDir(dest);
  execSync(`git archive ${commit} | tar -x -C ${JSON.stringify(dest)}`, { cwd: repo, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1024 * 1024 * 1024 });
}

export function writeRecordsIgnore(p: Paths): void {
  const ignore = join(p.records, ".gitignore");
  if (!exists(ignore)) writeText(ignore, "work/\nhistory/\nfeedback/\ncli.log\n");
}

function priorAudits(p: Paths): number {
  const local = join(p.history, "history.jsonl");
  const text = exists(local) ? readText(local) : git(["show", "agent-readiness/history:history.jsonl"], p.repo).stdout;
  return text.split("\n").filter((l) => l.includes('"kind":"audit"')).length;
}

export function initAudit(opts: InitOptions): { audit: Audit; local: LocalInfo; paths: Paths } {
  const p = paths(opts.repo);
  const current = currentDraftId(p);
  if (current && !opts.force) fail(`A draft audit is already open: ${current}. Seal it, or pass --force to abandon it.`);
  const commit = gitOrThrow(["rev-parse", "HEAD"], opts.repo).trim();
  const seedEnv = process.env.READINESS_EVAL_SEED;
  const id = `aud-${today()}-${commit.slice(0, 7)}-${seedEnv ? sha256(`${seedEnv}:${commit}:${nowIso()}`).slice(0, 4) : randomHex(2)}`;
  const tree = join(mkdtempSync(join(tmpdir(), `readiness-${id}-`)), "tree");
  exportTree(opts.repo, commit, tree);
  const rubric = latestRubricVersion();
  const manifest = releaseManifest();
  const audit: Audit = {
    schema: "agent-readiness/audit@1",
    id,
    kind: "audit",
    createdAt: nowIso(),
    state: "draft",
    repo: { name: repoName(opts.repo), commit, dirtyTree: isDirty(opts.repo) },
    goal: opts.goal,
    tier: opts.tier,
    rubric,
    skill: { version: manifest?.version ?? "0.0.0", scriptsDigest: skillDigest(), rubricDigest: rubricDigest(rubric), release: manifest?.tag ?? null },
    seed: seedEnv ? { value: sha256(`${seedEnv}:${priorAudits(p)}`).slice(0, 32), pinned: true } : { value: randomHex(16), pinned: false },
    environment: { containerRuntime: null, image: null, registryEnv: opts.registryEnv, inheritEnv: opts.inheritEnv },
    profile: null,
    assets: [],
    contract: [],
    instructions: [],
    safety: [],
    evidence: [],
    mutants: [],
    outcomes: null,
    narration: null,
  };
  const local: LocalInfo = { tree, createdAt: audit.createdAt };
  writeRecordsIgnore(p);
  writeJson(join(p.work, id, "audit.json"), audit);
  writeJson(join(p.work, id, "local.json"), local);
  writeText(join(p.work, "CURRENT"), id + "\n");
  return { audit, local, paths: p };
}

export function currentDraftId(p: Paths): string | null {
  const f = join(p.work, "CURRENT");
  if (!exists(f)) return null;
  const id = readText(f).trim();
  return id && exists(join(p.work, id, "audit.json")) ? id : null;
}

export function loadDraft(repo: string, id?: string): { audit: Audit; local: LocalInfo; paths: Paths } {
  const p = paths(repo);
  const draftId = id ?? currentDraftId(p);
  if (!draftId) fail("No draft audit is open. Run `readiness init` first.");
  const audit = readJson<Audit>(join(p.work, draftId, "audit.json"));
  const local = readJson<LocalInfo>(join(p.work, draftId, "local.json"));
  return { audit, local, paths: p };
}

export function assertDraft(audit: Audit): void {
  if (audit.state !== "draft") fail(`Audit ${audit.id} is sealed and refuses further writes.`);
}

export function saveDraft(p: Paths, audit: Audit): void {
  assertDraft(audit);
  writeJson(join(p.work, audit.id, "audit.json"), audit);
}

export function clearCurrent(p: Paths): void {
  writeText(join(p.work, "CURRENT"), "");
}

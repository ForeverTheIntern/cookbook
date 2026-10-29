import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText } from "./redact.ts";
import type { Audit, HistoryLine, ReportJson, Roadmap } from "./types.ts";
import { ensureDir, exists, fail, git, nowIso, readJson, readText, writeJson, writeText } from "./util.ts";
import type { Paths } from "./workspace.ts";

export const HISTORY_BRANCH = "agent-readiness/history";

function guardSecrets(label: string, text: string): void {
  const hits = scanText(text);
  if (hits.length > 0) fail(`Refusing to write ${label}: it contains ${hits.map((h) => `${h.type} (line ${h.line})`).join(", ")}. Nothing was written.`);
}

export function storeAudit(p: Paths, audit: Audit, report: ReportJson, md: string): string {
  const dir = join(p.history, "audits", audit.id);
  const auditText = JSON.stringify(audit, null, 2) + "\n";
  const reportText = JSON.stringify(report, null, 2) + "\n";
  guardSecrets(`audit ${audit.id}`, auditText + reportText + md);
  writeText(join(dir, "audit.json"), auditText);
  writeText(join(dir, "report.json"), reportText);
  writeText(join(dir, "report.md"), md);
  return dir;
}

export function writeLatest(p: Paths, report: ReportJson, md: string): void {
  writeJson(join(p.latest, "report.json"), report);
  writeText(join(p.latest, "report.md"), md);
}

export function readRoadmap(p: Paths): Roadmap | null {
  return exists(p.roadmap) ? readJson<Roadmap>(p.roadmap) : null;
}

export function writeRoadmap(p: Paths, roadmap: Roadmap): void {
  writeJson(p.roadmap, roadmap);
}

export function appendHistory(p: Paths, line: HistoryLine): void {
  const f = join(p.history, "history.jsonl");
  const text = JSON.stringify(line) + "\n";
  guardSecrets("the history line", text);
  ensureDir(p.history);
  let prev = "";
  if (exists(f)) prev = readText(f);
  else {
    const fromBranch = git(["show", `${HISTORY_BRANCH}:history.jsonl`], p.repo);
    if (fromBranch.ok) prev = fromBranch.stdout;
  }
  writeText(f, prev + text);
}

export function readHistory(p: Paths): HistoryLine[] {
  const f = join(p.history, "history.jsonl");
  if (exists(f)) return parseHistory(readText(f));
  const fromBranch = git(["show", `${HISTORY_BRANCH}:history.jsonl`], p.repo);
  return fromBranch.ok ? parseHistory(fromBranch.stdout) : [];
}

function parseHistory(text: string): HistoryLine[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HistoryLine);
}

export function auditIds(p: Paths): string[] {
  const dir = join(p.history, "audits");
  return exists(dir) ? readdirSync(dir).sort() : [];
}

export function loadSealedAudit(p: Paths, ref: string): { audit: Audit; dir: string } {
  let id = ref;
  if (ref === "latest" || ref === "previous") {
    const audits = readHistory(p).filter((h) => h.kind === "audit");
    const pick = ref === "latest" ? audits[audits.length - 1] : audits[audits.length - 2];
    if (!pick) fail(`No ${ref} sealed audit in ${p.history}`);
    id = pick.id;
  }
  const dir = join(p.history, "audits", id);
  if (exists(join(dir, "audit.json"))) return { audit: readJson<Audit>(join(dir, "audit.json")), dir };
  const fromBranch = git(["show", `${HISTORY_BRANCH}:audits/${id}/audit.json`], p.repo);
  if (fromBranch.ok) return { audit: JSON.parse(fromBranch.stdout) as Audit, dir: `${HISTORY_BRANCH}:audits/${id}` };
  return fail(`No sealed audit ${id}`);
}

export function storeRecheck(p: Paths, id: string, record: unknown): string {
  const f = join(p.history, "rechecks", `${id}.json`);
  const text = JSON.stringify(record, null, 2) + "\n";
  guardSecrets(`recheck ${id}`, text);
  writeText(f, text);
  return f;
}

export function pushHistory(p: Paths, opts: { push: boolean; remote: string }): string {
  if (!exists(p.history)) fail(`Nothing to push: ${p.history} doesn't exist`);
  const wt = join(mkdtempSync(join(tmpdir(), "readiness-history-")), "wt");
  const hasLocal = git(["rev-parse", "--verify", HISTORY_BRANCH], p.repo).ok;
  const hasRemote = git(["rev-parse", "--verify", `${opts.remote}/${HISTORY_BRANCH}`], p.repo).ok;
  try {
    if (hasLocal) git(["worktree", "add", wt, HISTORY_BRANCH], p.repo);
    else if (hasRemote) git(["worktree", "add", "-b", HISTORY_BRANCH, wt, `${opts.remote}/${HISTORY_BRANCH}`], p.repo);
    else {
      const r = git(["worktree", "add", "--detach", wt], p.repo);
      if (!r.ok) fail(r.stderr);
      git(["checkout", "--orphan", HISTORY_BRANCH], wt);
      git(["rm", "-rf", "--quiet", "."], wt);
    }
    cpSync(p.history, wt, { recursive: true });
    git(["add", "-A"], wt);
    const status = git(["status", "--porcelain"], wt).stdout.trim();
    let message = "history branch already up to date";
    if (status) {
      const c = git(["-c", "user.name=agent-readiness", "-c", "user.email=agent-readiness@example.com", "commit", "-q", "-m", `Agent readiness history ${nowIso().slice(0, 10)}`], wt);
      if (!c.ok) fail(`Could not commit history: ${c.stderr}`);
      message = `committed history to ${HISTORY_BRANCH}`;
    }
    if (opts.push) {
      const pr = git(["push", opts.remote, HISTORY_BRANCH], wt);
      if (!pr.ok) fail(`Could not push ${HISTORY_BRANCH}: ${pr.stderr}`);
      message += ` and pushed to ${opts.remote}`;
    }
    return message;
  } finally {
    git(["worktree", "remove", "--force", wt], p.repo);
    rmSync(join(wt, ".."), { recursive: true, force: true });
  }
}

/**
 * Launch, drive and clean up one local verification. Cleanup stops the pids
 * this run recorded and closes the issue this run opened. It does not delete
 * the evidence directory.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { FactoryConfig } from "../../foreman/bot/lib/config/factory.ts";
import { api, type GitHub } from "../../foreman/bot/lib/github/rest.ts";

const exec = promisify(execFile);

export const ISSUE_MARK = "Opened by verify-factory.";

export interface PidRecord {
  pid: number;
  pgid: number;
  started: string;
  command: string;
}

export interface Started {
  repo: string;
  issue: number;
  runId: string | null;
  branch: string | null;
  createdAt: string;
}

export function issueBody(): string {
  return `${ISSUE_MARK}\n\nThis issue exists to prove Foreman claims a labeled issue. Close it when the check is done.`;
}

/** True when the comment is Foreman claiming the issue. */
export function claimedRun(comments: { body?: string }[]): string | null {
  for (const comment of comments) {
    const body = comment.body ?? "";
    const match = body.match(/<!-- factory:claim id=[\w-]+ run=([\w-]+) -->/);
    if (match !== null) return match[1];
    if (body.includes("started by this factory")) return "unknown";
  }
  return null;
}

/** The distinct Foreman ids that claimed the issue. More than one means another Foreman watches the same label. */
export function claimants(comments: { body?: string }[]): string[] {
  const ids = comments.flatMap((comment) => [...(comment.body ?? "").matchAll(/<!-- factory:claim id=([\w-]+) run=[\w-]+ -->/g)].map((m) => m[1]));
  return [...new Set(ids)];
}

export async function claimantsOf(gh: GitHub, issue: number): Promise<string[]> {
  return claimants((await api(gh, "GET", `/repos/${gh.repo}/issues/${issue}/comments?per_page=100`)) ?? []);
}

export async function startDetached(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logPath: string): Promise<PidRecord> {
  mkdirSync(resolve(logPath, ".."), { recursive: true });
  const fd = openSync(logPath, "a");
  const child: ChildProcess = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  closeSync(fd);
  const pid = child.pid;
  if (pid === undefined) throw new Error(`could not start ${command}`);
  const started = await startedAt(pid);
  return { pid, pgid: pid, started, command: [command, ...args].join(" ") };
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "not tried";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`${url} was not ready after ${timeoutMs}ms (${last})`);
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Stop one recorded process group, and only when it is still the process we started. */
export async function stopRecorded(record: PidRecord): Promise<string> {
  const live = await startedAt(record.pid).catch(() => "");
  if (live === "") return `pid ${record.pid} is already gone`;
  if (live !== record.started) return `pid ${record.pid} was reused (started ${live}); left it alone`;
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-record.pgid, signal);
    } catch {
      // the group is already empty
    }
  };
  signalGroup("SIGTERM");
  const deadline = Date.now() + 8_000;
  let gone = false;
  while (Date.now() < deadline) {
    if ((await startedAt(record.pid).catch(() => "")) === "") {
      gone = true;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  // A child can ignore SIGTERM and keep the group after the recorded pid exits.
  // Foreman's `bdk serve` did that and left port 3000 open. SIGKILL the group
  // in this same call, while the start time above still proves it is ours.
  signalGroup("SIGKILL");
  return gone ? `stopped pid ${record.pid}` : `killed pid ${record.pid}`;
}

export async function openVerificationIssue(gh: GitHub, config: FactoryConfig): Promise<number> {
  const created = await api(gh, "POST", `/repos/${config.repo}/issues`, {
    title: `verify-factory intake ${new Date().toISOString().slice(0, 16)}`,
    body: issueBody(),
  });
  await api(gh, "POST", `/repos/${config.repo}/issues/${created.number}/labels`, { labels: [config.intakeLabel] });
  return created.number as number;
}

export async function waitForClaim(gh: GitHub, issue: number, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const comments = await api(gh, "GET", `/repos/${gh.repo}/issues/${issue}/comments?per_page=100`);
    const runId = claimedRun(comments ?? []);
    if (runId !== null) return runId;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  return null;
}

/** Close the issue only when its body still carries our marker. */
export async function closeVerificationIssue(gh: GitHub, issue: number): Promise<string> {
  const found = await api(gh, "GET", `/repos/${gh.repo}/issues/${issue}`);
  if (found === null) return `issue ${issue} is gone`;
  if (!String(found.body ?? "").includes(ISSUE_MARK)) return `issue ${issue} was not opened by verify-factory; left it open`;
  if (found.state !== "open") return `issue ${issue} is already ${found.state}`;
  await api(gh, "PATCH", `/repos/${gh.repo}/issues/${issue}`, { state: "closed", state_reason: "not_planned" });
  return `closed ${gh.repo}#${issue}`;
}

/** Delete the run branch when it is one this drive recorded. Never a branch outside factory/. */
export async function deleteRunBranch(gh: GitHub, branch: string | null): Promise<string> {
  if (branch === null || !branch.startsWith("factory/")) return "no run branch to delete";
  const ref = await api(gh, "GET", `/repos/${gh.repo}/git/ref/heads/${branch}`);
  if (ref === null) return `${branch} is already gone`;
  await api(gh, "DELETE", `/repos/${gh.repo}/git/refs/heads/${branch}`);
  return `deleted ${branch}`;
}

export async function stopAgentsOnBranch(apiKey: string, repo: string, branch: string | null): Promise<string> {
  if (branch === null) return "no branch, so no cloud agent was stopped";
  const response = await fetch("https://api.cursor.com/v0/agents?limit=20", {
    headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
  });
  if (!response.ok) return `listing cloud agents returned ${response.status}; none were stopped`;
  const body = (await response.json()) as { agents?: { id?: string; status?: string; target?: { branchName?: string }; source?: { repository?: string } }[] };
  const matches = (body.agents ?? []).filter((agent) => agent.target?.branchName === branch && (agent.source?.repository ?? "").endsWith(repo));
  if (matches.length === 0) return `no cloud agent is on ${branch}`;
  const stopped: string[] = [];
  for (const agent of matches) {
    if (typeof agent.id !== "string") continue;
    if (agent.status === "FINISHED" || agent.status === "ERROR" || agent.status === "EXPIRED") continue;
    const stop = await fetch(`https://api.cursor.com/v0/agents/${agent.id}/stop`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
    });
    stopped.push(`${agent.id} ${stop.status}`);
  }
  return stopped.length === 0 ? `cloud agents on ${branch} were already finished` : `stopped ${stopped.join(", ")}`;
}

async function startedAt(pid: number): Promise<string> {
  const { stdout } = await exec("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000 });
  return stdout.trim();
}

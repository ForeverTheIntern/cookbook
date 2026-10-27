/**
 * Which source a verdict or a deploy is about. The factory folder is copied
 * between repositories (a mirror, a subtree split, a customer's repo), which
 * rewrites commit SHAs but not file contents, so a deploy is pinned by a
 * digest of the folder's files. `setup/verdicts/` is left out of both the digest
 * and the code SHA, so committing a verdict or a deploy record voids nothing.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const LEDGER_DIR = "setup/verdicts";
/** Folders that are not the factory's code: the verdict ledger. */
export const NOT_CODE = [LEDGER_DIR];
const EXCLUDE = NOT_CODE.map((dir) => `:(exclude)${dir}`);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 16_000_000 });
  return stdout.trim();
}

/** sha256 over `git ls-tree -r` of the folder at `ref`, paths relative to the folder, without NOT_CODE. */
export async function sourceDigest(folder: string, ref = "HEAD"): Promise<string> {
  return digestOf(await git(folder, ["ls-tree", "-r", ref, "."]));
}

export function digestOf(lsTree: string): string {
  const lines = lsTree.split("\n").filter((line) => line !== "" && !NOT_CODE.some((dir) => line.split("\t")[1]?.startsWith(`${dir}/`)));
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The newest commit that changed the folder outside NOT_CODE. Verdicts are keyed by this SHA. */
export async function codeSha(folder: string): Promise<string> {
  return git(folder, ["log", "-1", "--format=%H", "--", ".", ...EXCLUDE]);
}

export async function headSha(folder: string): Promise<string> {
  return git(folder, ["rev-parse", "HEAD"]);
}

/** The folder's path from the repository root, "" at the root, no trailing slash. */
export async function folderPrefix(folder: string): Promise<string> {
  return (await git(folder, ["rev-parse", "--show-prefix"])).replace(/\/$/, "");
}

/**
 * What `agent-sdk deploy` builds: the factory folder's own repository and its path
 * there, never the repositories it works on. The factory may be its own
 * repository (prefix "") or a folder inside one it serves.
 */
export function deployTarget(source: { remoteUrl: string; prefix: string }, served: string[]) {
  return {
    repo: deployRepoUrl(source.remoteUrl),
    agentPath: source.prefix === "" ? "foreman" : `${source.prefix}/foreman`,
    eventRepos: served,
  };
}

export async function currentBranch(folder: string): Promise<string> {
  return git(folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function originUrl(folder: string): Promise<string> {
  return git(folder, ["remote", "get-url", "origin"]);
}

/**
 * The repository URL the Agent SDK builds from and the deploy record names: https, no
 * `.git`, and never the credentials a CI or cloud-agent clone keeps in its
 * remote URL (`https://x-access-token:…@github.com/…`).
 */
export function deployRepoUrl(url: string): string {
  const ssh = /^git@github\.com:(.+?)(?:\.git)?$/.exec(url);
  if (ssh !== null) return `https://github.com/${ssh[1]}`;
  return url.replace(/^(https?:\/\/)[^@/]*@/, "$1").replace(/\.git$/, "");
}

/** The SHA a remote branch points at, or null when it does not exist. `repo` is a remote name or URL. */
export async function remoteSha(folder: string, repo: string, ref: string): Promise<string | null> {
  const out = await git(folder, ["ls-remote", repo, `refs/heads/${ref}`]);
  return out === "" ? null : out.split(/\s+/)[0];
}

/** Uncommitted changes in the folder, outside NOT_CODE. */
export async function dirtyFiles(folder: string): Promise<string[]> {
  const out = await git(folder, ["status", "--porcelain", "--", ".", ...EXCLUDE]);
  return out === "" ? [] : out.split("\n");
}

/**
 * The hosted deployment as BDK reports it, and the deploy records
 * `npm run deploy` writes. `deployment get` is a read. It does not deploy, and
 * it reports no commit, so the record is what ties a release to its source.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { BDK_SPEC } from "./bdk.ts";

const exec = promisify(execFile);

export interface Deployment {
  releaseId: string | null;
  teamId: string | null;
  status: string | null;
  secretNames: string[];
  error: string | null;
}

/** One `npm run deploy`: the release BDK built, and the source it built from. */
export interface DeployRecord {
  at: string;
  slug: string;
  releaseId: string;
  teamId: string | null;
  repo: string;
  ref: string;
  sha: string;
  path: string;
  digest: string;
}

/** The first JSON object in a BDK command's stdout; BDK prints notes like "Using team …" around it. */
export function jsonFrom(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    const value = JSON.parse(stdout.slice(start, end + 1));
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

export function deploymentFrom(body: Record<string, unknown> | null, fallbackError: string): Deployment {
  if (body === null) return { releaseId: null, teamId: null, status: null, secretNames: [], error: fallbackError };
  const error = body.error as { message?: string } | undefined;
  if (typeof error?.message === "string") return { releaseId: null, teamId: null, status: null, secretNames: [], error: error.message };
  return {
    releaseId: typeof body.releaseId === "string" ? body.releaseId : null,
    teamId: body.teamId === undefined || body.teamId === null ? null : String(body.teamId),
    status: typeof body.status === "string" ? body.status : null,
    secretNames: Array.isArray(body.secretNames) ? body.secretNames.filter((n): n is string => typeof n === "string") : [],
    error: null,
  };
}

export async function deployment(slug: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Deployment> {
  const { stdout, stderr, code } = await bdk(["deployment", "get", slug, "--json"], cwd, env);
  const detail = lastLines(stderr, stdout);
  return deploymentFrom(jsonFrom(stdout), detail === "" ? `deployment get ${slug} exited ${code}` : detail);
}

export async function bdk(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await exec("npx", ["--yes", BDK_SPEC, ...args], {
      cwd,
      env,
      timeout: 900_000,
      maxBuffer: 16_000_000,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string; message: string };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr?.trim() ? failed.stderr : failed.message,
      code: typeof failed.code === "number" ? failed.code : 1,
    };
  }
}

function lastLines(...texts: string[]): string {
  return texts.join("\n").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("npm warn")).slice(-4).join(" ").slice(0, 400);
}

export function readDeploys(path: string): DeployRecord[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as DeployRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function appendDeploy(path: string, record: DeployRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export function lastDeploy(records: DeployRecord[], slug: string): DeployRecord | null {
  return [...records].reverse().find((r) => r.slug === slug) ?? null;
}

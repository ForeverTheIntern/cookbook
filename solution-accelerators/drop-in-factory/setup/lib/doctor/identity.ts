/**
 * Live account calls for `npm run doctor`. Values stay in this module; the
 * script prints emails, team names and ids, never key material.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { SDK_SPEC } from "./sdk.ts";
import { cliConfigEmail } from "./report.ts";

const exec = promisify(execFile);

export interface Account {
  email: string | null;
  apiKeyName: string | null;
  teamId: string | null;
  teamName: string | null;
  /** Set when the dashboard account call failed. /v0/me can still have succeeded. */
  teamError: string | null;
}

export async function accountOf(apiKey: string): Promise<Account> {
  const me = await fetch("https://api.cursor.com/v0/me", { headers: { authorization: basic(apiKey) } });
  if (!me.ok) throw new Error(`key was rejected (${me.status})`);
  const body = (await me.json()) as { userEmail?: string; apiKeyName?: string };
  const team = await dashboardAccount(apiKey);
  return {
    email: body.userEmail ?? null,
    apiKeyName: body.apiKeyName ?? null,
    teamId: team.id,
    teamName: team.name,
    teamError: team.error,
  };
}

export async function visibleRepositories(apiKey: string): Promise<{ owner: string; name: string }[]> {
  const listed = await fetch("https://api.cursor.com/v0/repositories", { headers: { authorization: basic(apiKey) } });
  if (listed.status === 429) throw new Error("GET /v0/repositories is rate limited; run the doctor again in a minute");
  if (!listed.ok) throw new Error(`GET /v0/repositories returned ${listed.status}`);
  const { repositories } = (await listed.json()) as { repositories: { owner: string; name: string }[] };
  return repositories;
}

export async function modelIds(apiKey: string): Promise<string[]> {
  const response = await fetch("https://api.cursor.com/v0/models", { headers: { authorization: basic(apiKey) } });
  if (!response.ok) throw new Error(`GET /v0/models returned ${response.status}`);
  const { models } = (await response.json()) as { models: string[] };
  return models;
}

export async function githubLogin(token: string): Promise<string> {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "drop-in-factory" },
  });
  if (!response.ok) throw new Error(`GitHub token was rejected (${response.status})`);
  const body = (await response.json()) as { login?: string };
  if (typeof body.login !== "string" || body.login === "") throw new Error("GitHub /user returned no login");
  return body.login;
}

export interface Whoami {
  email: string | null;
  teamName: string | null;
  source: string | null;
  error: string | null;
}

/** `agent-sdk whoami --json`. The CLI uses CURSOR_API_KEY before a stored login, and it does not read CURSOR_AUTH_TOKEN. */
export async function whoami(env: NodeJS.ProcessEnv): Promise<Whoami> {
  let stdout = "";
  let stderr = "";
  try {
    // npx is npx.cmd on Windows. execFile does not run a .cmd unless shell is set,
    // and the ENOENT comes back with an empty stderr, which hid the real failure.
    const result = await exec("npx", ["--yes", SDK_SPEC, "whoami", "--json"], {
      env,
      timeout: 120_000,
      maxBuffer: 1_000_000,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message: string };
    stdout = failed.stdout ?? "";
    stderr = failed.stderr?.trim() ? failed.stderr : failed.message;
  }
  const parsed = parseWhoami(stdout);
  if (parsed !== null) return parsed;
  const detail = stderr.trim().split("\n").filter((line) => !line.startsWith("npm warn")).slice(-3).join(" ").slice(0, 300);
  return { email: null, teamName: null, source: null, error: detail === "" ? "agent-sdk whoami returned no JSON" : detail };
}

export function parseWhoami(stdout: string): Whoami | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    const body = JSON.parse(stdout.slice(start, end + 1)) as { email?: unknown; teamName?: unknown; credentialSource?: unknown };
    return {
      email: typeof body.email === "string" ? body.email : null,
      teamName: typeof body.teamName === "string" ? body.teamName : null,
      source: typeof body.credentialSource === "string" ? body.credentialSource : null,
      error: null,
    };
  } catch {
    return null;
  }
}

export function storedCliEmail(path: string): string | null {
  try {
    return cliConfigEmail(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The same account call `agent-sdk whoami` makes. whoami's JSON omits the team id,
 * and the id is what a deploy targets, so the doctor reads it here.
 */
async function dashboardAccount(apiKey: string): Promise<{ id: string | null; name: string | null; error: string | null }> {
  try {
    const exchange = await fetch("https://api2.cursor.sh/auth/exchange_user_api_key", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    if (!exchange.ok) return { id: null, name: null, error: `account exchange returned ${exchange.status}` };
    const { accessToken } = (await exchange.json()) as { accessToken?: string };
    if (typeof accessToken !== "string" || accessToken === "") return { id: null, name: null, error: "account exchange returned no session" };
    const me = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    if (!me.ok) return { id: null, name: null, error: `GetMe returned ${me.status}` };
    const body = (await me.json()) as { teamId?: number | string; teamName?: string };
    const id = body.teamId === undefined || body.teamId === null ? null : String(body.teamId);
    return { id, name: body.teamName ?? null, error: null };
  } catch (error) {
    return { id: null, name: null, error: (error as Error).message };
  }
}

function basic(key: string): string {
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

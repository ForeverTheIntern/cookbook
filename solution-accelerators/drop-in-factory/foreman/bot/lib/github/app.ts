/**
 * A GitHub App as Foreman's own identity: an RS256 JWT signed with the app's
 * private key buys an installation token per repository owner, good for an
 * hour. Tokens are cached per owner and renewed five minutes early. The key
 * and id are arguments; this file does not read the environment.
 */

import { createPrivateKey, createSign } from "node:crypto";

export interface GitHubApp {
  appId: string;
  /** PEM. Literal `\n` sequences (one-line `.env` values) are accepted. */
  privateKey: string;
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** The app's JWT: issued a minute in the past for clock drift, valid nine minutes (GitHub allows ten). */
export function appJwt(app: GitHubApp, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId }));
  const key = createPrivateKey(app.privateKey.replace(/\\n/g, "\n"));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${base64url(signature)}`;
}

async function appApi(app: GitHubApp, method: string, path: string): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt(app)}`, "user-agent": "drop-in-factory" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub App ${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** The app's slug and its bot login (`<slug>[bot]`). */
export async function appIdentity(app: GitHubApp): Promise<{ slug: string; login: string }> {
  const body = await appApi(app, "GET", "/app");
  return { slug: body.slug, login: `${body.slug}[bot]` };
}

/** The installation that covers `repo`, with the permissions it was granted. Throws when the app is not installed there. */
export async function installationFor(app: GitHubApp, repo: string): Promise<{ id: number; permissions: Record<string, string> }> {
  const body = await appApi(app, "GET", `/repos/${repo}/installation`);
  return { id: body.id, permissions: body.permissions ?? {} };
}

const cache = new Map<string, { token: string; expiresAt: number }>();

/** An installation token for the owner of `repo`, from the cache while it has five minutes left. */
export async function installationToken(app: GitHubApp, repo: string, nowMs: number = Date.now()): Promise<string> {
  const key = `${app.appId}/${repo.split("/")[0].toLowerCase()}`;
  const hit = cache.get(key);
  if (hit !== undefined && hit.expiresAt - nowMs > 5 * 60_000) return hit.token;
  const { id } = await installationFor(app, repo);
  const body = await appApi(app, "POST", `/app/installations/${id}/access_tokens`);
  cache.set(key, { token: body.token, expiresAt: Date.parse(body.expires_at) });
  return body.token;
}

/** The permissions Foreman's own posts need: branches, comments, reviews, labels, ready for review, and reading checks. */
export const APP_PERMISSIONS: Record<string, "read" | "write"> = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  checks: "read",
  metadata: "read",
};

/** Permissions from APP_PERMISSIONS that an installation lacks, as `name:level`. */
export function missingPermissions(granted: Record<string, string>): string[] {
  return Object.entries(APP_PERMISSIONS)
    .filter(([name, level]) => granted[name] !== "write" && granted[name] !== level)
    .map(([name, level]) => `${name}:${level}`);
}

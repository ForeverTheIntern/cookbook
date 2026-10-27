/**
 * The words `npm run doctor` prints. No network and no processes: the script
 * gathers facts and these functions decide the line. A new head SHA voids an
 * older verdict; that rule lives in ledger.ts.
 */

import type { DeployRecord } from "./deployed.ts";
import type { GitHubIdentity } from "../../../foreman/bot/lib/config/factory.ts";

export type Status = "ok" | "info" | "fail";

export interface Line {
  status: Status;
  text: string;
}

/** The oldest Node the factory runs on: type stripping and `process.loadEnvFile`. `.nvmrc` and every `engines.node` name it. */
export const NODE_MINIMUM = "22.14.0";

/** Fails below NODE_MINIMUM; any newer major passes. */
export function nodeLine(version: string): Line {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [have, want] = [parse(version), parse(NODE_MINIMUM)];
  const cmp = have.map((n, i) => n - (want[i] ?? 0)).find((d) => d !== 0) ?? 0;
  if (cmp < 0) return { status: "fail", text: `Node ${version} is older than ${NODE_MINIMUM}. Install ${NODE_MINIMUM} or later (nvm install ${NODE_MINIMUM})` };
  return { status: "ok", text: `Node ${version} (${NODE_MINIMUM} or later)` };
}

export interface Listener {
  port: number;
  /** Null when nothing is listening. */
  pid: number | null;
  command: string;
  cwd: string;
}

/** Ports the verification run recorded, plus every child of those pids. */
export function expandPids(roots: number[], rows: { pid: number; ppid: number }[]): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const out = new Set(roots);
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    for (const child of children.get(pid) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return [...out];
}

/**
 * Who owns each watched port. The portal port may belong to the dashboard.
 * Any other listener is a leftover (the 8790 case) unless it is a child of a
 * pid this verification run started. When `allowedPids` is set, the portal
 * port has to be one of those pids too.
 */
export function portsLine(listeners: Listener[], portalPort: number, allowedPids: number[] | null): Line {
  const problems: string[] = [];
  const parts = listeners.map((listener) => {
    if (listener.pid === null) {
      if (allowedPids !== null && listener.port === portalPort) problems.push(`${listener.port} is free; this run's dashboard is not listening`);
      return `${listener.port} free`;
    }
    const owned = `${listener.port} pid ${listener.pid} ${listener.command} (${listener.cwd})`;
    const ours = allowedPids !== null && allowedPids.includes(listener.pid);
    if (listener.port !== portalPort && !ours) problems.push(`${owned} is not the dashboard and was not started by this run`);
    if (allowedPids !== null && listener.port === portalPort && !ours) problems.push(`${owned} is not a process this run started`);
    return owned;
  });
  const text = parts.join("; ");
  return problems.length === 0 ? { status: "ok", text } : { status: "fail", text: `${text}. ${problems.join(". ")}` };
}

/**
 * LISTEN rows from Linux `/proc/net/tcp` or `/proc/net/tcp6`.
 * State `0A` is LISTEN. The inode is how a later scan finds the pid.
 */
export function parseProcNet(text: string): { port: number; inode: string }[] {
  const rows: { port: number; inode: string }[] = [];
  for (const line of text.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || parts[3] !== "0A") continue;
    const port = Number.parseInt(parts[1]?.split(":")[1] ?? "", 16);
    const inode = parts[9] ?? "";
    if (!Number.isInteger(port) || inode === "" || inode === "0") continue;
    rows.push({ port, inode });
  }
  return rows;
}

/** `lsof -F pcn` output. A new process starts at each `p` field. */
export function parseLsof(output: string): { pid: number; command: string }[] {
  const found: { pid: number; command: string }[] = [];
  let current: { pid: number; command: string } | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      if (current !== null) found.push(current);
      const pid = Number(line.slice(1));
      current = Number.isInteger(pid) ? { pid, command: "" } : null;
    } else if (line.startsWith("c") && current !== null && current.command === "") {
      current.command = line.slice(1);
    }
  }
  if (current !== null) found.push(current);
  return found.filter((row) => row.command !== "");
}

/**
 * Windows `netstat -ano`: the listening rows' local port and pid. Windows
 * translates the state word, so a row counts as listening by its remote port
 * being 0 instead.
 */
export function parseNetstat(output: string): { port: number; pid: number }[] {
  const rows: { port: number; pid: number }[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 5 || !/^TCP/i.test(parts[0])) continue;
    const port = Number(parts[1].slice(parts[1].lastIndexOf(":") + 1));
    const remotePort = parts[2].slice(parts[2].lastIndexOf(":") + 1);
    const pid = Number(parts[4]);
    if (remotePort !== "0" || !Number.isInteger(port) || !Number.isInteger(pid) || pid === 0) continue;
    rows.push({ port, pid });
  }
  return rows;
}

export interface CliFacts {
  whoamiEmail: string | null;
  whoamiTeam: string | null;
  source: string | null;
  whoamiError: string | null;
  keyEmail: string;
  /** Email from ~/.cursor/cli-config.json authInfo, when the file has one. */
  storedEmail: string | null;
  authTokenSet: boolean;
}

/** The CLI session and the launch key have to be the same account. A stored login that disagrees is the stale-auth failure. */
export function cliLine(facts: CliFacts): Line {
  if (facts.whoamiError !== null) return { status: "fail", text: facts.whoamiError };
  const email = facts.whoamiEmail ?? "";
  if (email === "") return { status: "fail", text: "whoami returned no email" };
  if (!sameEmail(email, facts.keyEmail)) {
    return { status: "fail", text: `CLI credential (${facts.source ?? "unknown"}) is ${email}, but the launch key belongs to ${facts.keyEmail}` };
  }
  if (facts.storedEmail !== null && !sameEmail(facts.storedEmail, facts.keyEmail)) {
    return {
      status: "fail",
      text: `stored CLI login in ~/.cursor/cli-config.json is ${facts.storedEmail}, but the launch key belongs to ${facts.keyEmail}. That stored login is what the CLI uses when CURSOR_API_KEY is unset`,
    };
  }
  const token = facts.authTokenSet ? " CURSOR_AUTH_TOKEN is also set; the BDK CLI does not read it, and a Cursor agent session might." : "";
  const team = facts.whoamiTeam === null || facts.whoamiTeam === "" ? "" : `, team ${facts.whoamiTeam}`;
  return { status: "ok", text: `${email} via ${facts.source ?? "unknown"}${team}.${token}` };
}

export function cliConfigEmail(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const root = json as Record<string, unknown>;
  const auth = root.authInfo ?? root.auth;
  if (typeof auth !== "object" || auth === null) return null;
  const record = auth as Record<string, unknown>;
  const email = record.email ?? record.userEmail;
  return typeof email === "string" && email !== "" ? email : null;
}

export interface TeamFacts {
  id: string | null;
  name: string | null;
  error: string | null;
  expectedId: string;
  expectedName: string;
}

/** Team id and name come from the account call. They are compared with SA_EXPECTED_TEAM_* only when those are set. */
export function teamLine(facts: TeamFacts): Line {
  if (facts.id === null && facts.name === null) {
    return { status: "fail", text: facts.error ?? "the account call returned no team id or name" };
  }
  const label = `${facts.name ?? "unnamed"} (${facts.id ?? "no id"})`;
  if (facts.expectedId !== "" && facts.id !== facts.expectedId) {
    return { status: "fail", text: `team is ${label}; SA_EXPECTED_TEAM_ID is ${facts.expectedId}` };
  }
  if (facts.expectedName !== "" && (facts.name ?? "").toLowerCase() !== facts.expectedName.toLowerCase()) {
    return { status: "fail", text: `team is ${label}; SA_EXPECTED_TEAM_NAME is ${facts.expectedName}` };
  }
  if (facts.id === null) return { status: "fail", text: `team name is ${facts.name}, and the account call returned no team id` };
  const expected = facts.expectedId !== "" || facts.expectedName !== "" ? ", matching SA_EXPECTED_TEAM_ID and SA_EXPECTED_TEAM_NAME" : "";
  return { status: "ok", text: `${label}${expected}` };
}

/** One key's owner. Service accounts often have a key name and no email. */
export function keyOwnerLine(identity: { email: string | null; apiKeyName: string | null; teamId: string | null; teamName: string | null }): Line {
  const who = identity.email ?? (identity.apiKeyName !== null ? `service account ${identity.apiKeyName}` : "no email");
  const team = identity.teamName === null && identity.teamId === null ? "" : `, team ${identity.teamName ?? "unnamed"} (${identity.teamId ?? "no id"})`;
  return { status: "ok", text: `belongs to ${who}${team}` };
}

/** The launch key and a service-account key have to be on the same team, or a hosted deploy lands on the wrong one. */
export function sameTeamLine(launchTeamId: string | null, service: { name: string; teamId: string | null; teamName: string | null; email: string | null; apiKeyName: string | null }): Line {
  const owner = keyOwnerLine(service);
  if (launchTeamId !== null && service.teamId !== null && launchTeamId !== service.teamId) {
    return { status: "fail", text: `${service.name} ${owner.text}, which is not the launch key's team (${launchTeamId})` };
  }
  if (service.teamId === null) return { status: "fail", text: `${service.name} authenticated, and the account call returned no team id` };
  return owner;
}

/**
 * Repositories the launch account's GitHub App installation can see.
 * The error text is the one the tutorial names.
 */
export function githubAppLine(repos: string[], visible: { owner: string; name: string }[]): Line {
  const seen = new Set(visible.map((repo) => `${repo.owner}/${repo.name}`.toLowerCase()));
  const unseen = repos.filter((repo) => !seen.has(repo.toLowerCase()));
  if (unseen.length > 0) {
    return {
      status: "fail",
      text: `the account behind CURSOR_API_KEY cannot see ${unseen.join(", ")} through the Cursor GitHub app (it sees ${visible.length} repositories); connect that account to GitHub in Cursor and give it access to each repository, or use a key from an account that has it`,
    };
  }
  return { status: "ok", text: `installation reaches ${repos.join(", ")} (${visible.length} repositories visible)` };
}

/**
 * The hosted release against the last `npm run deploy` record: the release
 * must be the recorded one, and the recorded source must have the same files
 * as this folder at HEAD.
 */
export function deploySourceLine(input: {
  enabled: boolean;
  slug: string;
  record: DeployRecord | null;
  liveReleaseId: string | null;
  headDigest: string;
  error: string | null;
}): Line {
  if (!input.enabled) return { status: "info", text: "skipped (SA_VERIFY_HOSTED is not 1), so the hosted release was not compared with HEAD" };
  if (input.error !== null) return { status: "fail", text: input.error };
  if (input.liveReleaseId === null) return { status: "fail", text: `${input.slug} reports no release; deploy it with npm run deploy` };
  const record = input.record;
  if (record === null) return { status: "fail", text: `${input.slug} runs release ${input.liveReleaseId}, and no deploy of it is recorded in setup/verdicts/deploys.jsonl; deploy with npm run deploy` };
  const source = `${record.repo}@${record.sha.slice(0, 7)}`;
  if (record.releaseId !== input.liveReleaseId) {
    return { status: "fail", text: `${input.slug} runs release ${input.liveReleaseId}, but the last recorded deploy is release ${record.releaseId} from ${source}; deploy with npm run deploy` };
  }
  if (record.digest !== input.headDigest) {
    return { status: "fail", text: `release ${record.releaseId} was built from ${source}, whose files differ from this folder at HEAD; deploy again with npm run deploy` };
  }
  return { status: "ok", text: `release ${record.releaseId} was built from ${source}, with the same files as this folder at HEAD` };
}

/** The deployment's secrets against the names the factory reads there. Values are never read. */
export function hostedSecretsLine(input: { enabled: boolean; slug: string; secretNames: string[] | null; required: string[]; error: string | null }): Line {
  if (!input.enabled) return { status: "info", text: "skipped (SA_VERIFY_HOSTED is not 1)" };
  if (input.error !== null || input.secretNames === null) return { status: "fail", text: input.error ?? "the deployment listed no secrets" };
  const missing = input.required.filter((name) => !input.secretNames!.includes(name));
  if (missing.length > 0) {
    return { status: "fail", text: `${input.slug} lacks ${missing.join(", ")}; set each with npx --yes @cursor/bdk@0.2.28 secret set ${input.slug} <NAME>` };
  }
  return { status: "ok", text: `${input.slug} has ${input.required.join(", ")}` };
}

/** `owner/name` from a GitHub remote URL, or null. */
export function repoFromRemote(url: string): string | null {
  const match = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return match === null ? null : match[1];
}

function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The secrets each `github.identity` needs, by name. */
export const IDENTITY_SECRETS: Record<GitHubIdentity, string[]> = {
  app: ["SA_GH_APP_ID", "SA_GH_APP_PRIVATE_KEY"],
  "bot-user": ["SA_GH_BOT_TOKEN"],
  personal: [],
};

/**
 * Whether Foreman can post as the identity factory.yaml chose. `facts` is
 * what the live calls found: the login the identity posts as, whether it
 * can write to the repository, and for an app, the permissions its
 * installation lacks.
 */
export function identityLine(identity: GitHubIdentity, repo: string, set: string[], facts: { login: string | null; canWrite: boolean; missing: string[]; error: string | null }): Line {
  const absent = IDENTITY_SECRETS[identity].filter((name) => !set.includes(name));
  if (absent.length > 0) return { status: "fail", text: `github.identity is ${identity}, so ${absent.join(" and ")} must be set in .env (see docs/agent-setup.md, "GitHub identity")` };
  if (facts.error !== null) return { status: "fail", text: facts.error };
  if (facts.missing.length > 0) return { status: "fail", text: `the app's installation on ${repo} lacks ${facts.missing.join(", ")}; grant them in the app's settings and accept the new permissions on the installation` };
  if (!facts.canWrite) return { status: "fail", text: `${facts.login ?? "the identity"} cannot write to ${repo}; it needs contents, issues and pull requests write` };
  const how = identity === "personal" ? "the operator's own token (github.identity: personal)" : identity === "app" ? "the factory GitHub App" : "the bot user's token";
  return { status: "ok", text: `Foreman's comments post as ${facts.login} through ${how}, and it can write to ${repo}` };
}

/** The `review.bots` names against the GitHub accounts that exist (`<name>[bot]`). */
export function reviewBotsLine(bots: string[], found: string[]): Line {
  if (bots.length === 0) return { status: "info", text: "review.bots is empty, so no bot's findings send work back; human change requests and failed checks still do" };
  const unknown = bots.filter((b) => !found.includes(b));
  if (unknown.length > 0) return { status: "fail", text: `no GitHub bot account ${unknown.map((b) => `${b}[bot]`).join(", ")}; fix review.bots in factory.yaml (Bugbot and the security reviewer post as cursor[bot])` };
  return { status: "ok", text: `findings from ${bots.map((b) => `${b}[bot]`).join(", ")} send work back while a run waits to merge` };
}

/** The Slack scopes Foreman's features need, against the token's granted scopes. */
export const SLACK_SCOPES = ["chat:write", "files:write", "reactions:read", "users:read"];

export function slackScopesLine(granted: string[]): Line {
  const missing = SLACK_SCOPES.filter((s) => !granted.includes(s));
  if (missing.length > 0) {
    return { status: "fail", text: `the bot token lacks ${missing.join(", ")} (inline verify videos need files:write, reaction approvals reactions:read); add them to the Slack app manifest, reinstall the app and update FOREMAN_SLACK_BOT_TOKEN` };
  }
  return { status: "ok", text: `the bot token has ${SLACK_SCOPES.join(", ")}` };
}

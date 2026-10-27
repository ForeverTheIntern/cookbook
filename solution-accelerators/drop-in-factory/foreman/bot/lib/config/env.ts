/**
 * The only module that reads process.env. One name per setting; a missing
 * required name fails here with that name.
 */

import { homedir } from "node:os";

// While cursor-events runs, BDK replaces process.env.GH_TOKEN with the
// Cursor account's GitHub credential, which cannot create branches. Keep the
// operator's token as it was when the process started.
const STARTUP_GH_TOKEN = process.env.GH_TOKEN ?? "";

/**
 * Everything the factory needs at run time. Read inside handlers, never at
 * module load: a hosted deployment receives its secrets per request.
 * On Cursor hosting CURSOR_API_KEY is the deployment's own credential, so
 * the key that launches cloud agents is SA_CURSOR_API_KEY there, and the
 * GitHub token is SA_GH_TOKEN for the same reason. CURSOR_* names are
 * reserved there, so the Admin API key is SA_CURSOR_ADMIN_API_KEY. Locally
 * the plain names work as before.
 */
export function workerEnv() {
  const { env, missing } = workerEnvChecked();
  if (missing.length > 0) throw new Error(`${missing[0]} is not set. Set it and run again.`);
  return env;
}

/** workerEnv for the doctor: a missing key is "" and named in `missing`, so every other check still runs. */
export function workerEnvChecked() {
  const missing: string[] = [];
  const cursorApiKey = process.env.SA_CURSOR_API_KEY || process.env.CURSOR_API_KEY || "";
  if (cursorApiKey === "") missing.push("SA_CURSOR_API_KEY (or CURSOR_API_KEY locally)");
  const githubToken = process.env.SA_GH_TOKEN || STARTUP_GH_TOKEN;
  if (githubToken === "") missing.push("SA_GH_TOKEN (or GH_TOKEN locally)");
  const env = {
    githubToken,
    cursorApiKey,
    /** OTLP/HTTP collector; unset means no OTel export. */
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
    /** Slack status posts. Set only when factory.yaml has a slack block; config load checks that. */
    slackBotToken: slackBotToken(),
    /** Invoice cents for role runs. Unset means cost is not read. */
    adminApiKey: process.env.SA_CURSOR_ADMIN_API_KEY || process.env.CURSOR_ADMIN_API_KEY || "",
    ...identityEnv(),
  };
  return { env, missing };
}

/** The secrets for `github.identity` in factory.yaml: a GitHub App's id and private key, or a bot user's token. "" when unset. */
export function identityEnv() {
  return {
    appId: process.env.SA_GH_APP_ID ?? "",
    appPrivateKey: process.env.SA_GH_APP_PRIVATE_KEY ?? "",
    botToken: process.env.SA_GH_BOT_TOKEN ?? "",
  };
}

/** The process environment, for child commands. Scripts do not read `process.env` themselves. */
export function shellEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/** Foreman's Slack bot token, or "" when Slack is not set up. */
export function slackBotToken(): string {
  return process.env.FOREMAN_SLACK_BOT_TOKEN ?? "";
}

/** factory.yaml, and the SQLite file of a store from before host.kv (imported once). Relative to the factory folder. */
export function pathsEnv() {
  return {
    factoryConfig: process.env.SA_FACTORY_CONFIG || "factory.yaml",
    legacyStorePath: process.env.SA_STORE_PATH || ".factory/factory.sqlite",
  };
}

/** A secret that is set, named by the variable the operator actually filled in. The value never goes in a log. */
export interface NamedSecret {
  name: string;
  value: string;
}

/** Settings for `npm run doctor` and `npm run verify`. Unset optionals use the defaults below. */
export function verifyEnv() {
  return {
    ports: portList(process.env.SA_DOCTOR_PORTS ?? "8787,8790"),
    /** The portal port may be taken by the dashboard. Every other port in `ports` must be free. */
    portalPort: portalPort(),
    /** 1 compares the hosted release and its secrets with the last deploy record and HEAD. Anything else is off, because a hosted deploy is a separate step. */
    hosted: flag("SA_VERIFY_HOSTED"),
    pidFile: process.env.SA_VERIFY_PID_FILE ?? "",
    evidenceDir: process.env.SA_VERIFY_EVIDENCE || ".factory/verify",
    /** Committed, so verdicts outlive the machine that recorded them. */
    ledgerPath: process.env.SA_VERIFY_LEDGER || "setup/verdicts/ledger.jsonl",
    deploysPath: process.env.SA_DEPLOYS_LEDGER || "setup/verdicts/deploys.jsonl",
    expectedTeamId: process.env.SA_EXPECTED_TEAM_ID ?? "",
    expectedTeamName: process.env.SA_EXPECTED_TEAM_NAME ?? "",
    deploymentSlug: process.env.SA_DEPLOYMENT_SLUG || "foreman",
    driveRepo: process.env.SA_VERIFY_REPO ?? "",
    driveTimeoutMs: positiveInt(process.env.SA_VERIFY_DRIVE_TIMEOUT_MS ?? "240000", "SA_VERIFY_DRIVE_TIMEOUT_MS"),
    /** Set to 1 by the verification skill before it opens an issue. Unset, `npm run verify -- drive` refuses. */
    drive: flag("SA_VERIFY_DRIVE"),
    chromeBin: process.env.SA_CHROME_BIN ?? "",
    otelcolBin: process.env.SA_OTELCOL_BIN ?? "",
    authTokenSet: (process.env.CURSOR_AUTH_TOKEN ?? "") !== "",
    cliConfigPath: `${homedir()}/.cursor/cli-config.json`,
    launchKeys: present("SA_CURSOR_API_KEY", "CURSOR_API_KEY"),
    adminKeys: present("SA_CURSOR_ADMIN_API_KEY", "CURSOR_ADMIN_API_KEY"),
    githubKeys: present("SA_GH_TOKEN", "GH_TOKEN"),
    serviceAccount: present("CURSOR_SERVICE_ACCOUNT_KEY"),
  };
}

function present(...names: string[]): NamedSecret[] {
  return names.filter((name) => (process.env[name] ?? "") !== "").map((name) => ({ name, value: process.env[name] ?? "" }));
}

function flag(name: string): boolean {
  const value = process.env[name] ?? "";
  if (value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be 1 or unset. It is ${value}.`);
}

function portList(raw: string): number[] {
  const nums = raw.split(",").map((s) => s.trim()).filter((s) => s !== "").map((s) => Number(s));
  if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 65535)) {
    throw new Error(`SA_DOCTOR_PORTS must be a comma-separated list of ports. It is ${raw}.`);
  }
  return nums;
}

function positiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of at least 1. It is ${raw}.`);
  return n;
}

/** The port the local dashboard binds. `SA_PORTAL_URL` wins, then `SA_PORTAL_PORT`, then 8787. */
function portalPort(): number {
  const url = process.env.SA_PORTAL_URL ?? "";
  if (url !== "") {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`SA_PORTAL_URL must be an http(s) URL. It is ${url}.`);
    }
    if (parsed.port !== "") return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  }
  const explicit = process.env.SA_PORTAL_PORT ?? "";
  if (explicit !== "") return positiveInt(explicit, "SA_PORTAL_PORT");
  return 8787;
}

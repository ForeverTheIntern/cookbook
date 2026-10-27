/**
 * `npm run dev`: Foreman under `agent-sdk serve` for every repository in
 * factory.yaml, plus the dashboard (dashboard/) on 127.0.0.1:8787 when
 * `dashboard.enabled` is true and its URL is on this machine. With no
 * SA_PORTAL_INGEST_SECRET set, both get a fresh random one. Ctrl-C stops
 * both; so does either one exiting, and so does `npm run stop` from another
 * terminal, which reads the pids this writes to `.factory/dev.json`.
 *
 *   npm run dev                       # Foreman and the dashboard
 *   npm run dev -- --foreman-only     # Foreman alone
 */

import "../foreman/bot/lib/config/dotenv.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathsEnv } from "../foreman/bot/lib/config/env.ts";
import { SDK_SPEC } from "./lib/doctor/sdk.ts";
import { loadFactory } from "../foreman/bot/lib/config/load.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const factory = loadFactory(resolve(root, pathsEnv().factoryConfig));
const env: NodeJS.ProcessEnv = { ...process.env };
const children: ChildProcess[] = [];
const names = new Map<ChildProcess, string>();
// npm and npx are .cmd files on Windows, which spawn finds only through a shell.
const onWindows = process.platform === "win32";

// Each child leads its own process group, so stopping it reaches what it started
// (npm run dev's sh, node and next-server), not just the npm process.
function run(name: string, command: string, args: string[], cwd: string, childEnv: NodeJS.ProcessEnv): void {
  const child = spawn(command, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], shell: onWindows, detached: !onWindows });
  names.set(child, name);
  const prefix = (chunk: Buffer, out: NodeJS.WriteStream) => {
    for (const line of chunk.toString().split("\n")) if (line !== "") out.write(`[${name}] ${line}\n`);
  };
  child.stdout?.on("data", (c: Buffer) => prefix(c, process.stdout));
  child.stderr?.on("data", (c: Buffer) => prefix(c, process.stderr));
  child.on("exit", (code, signal) => {
    console.log(`[dev] ${name} exited (${signal ?? code}); stopping the rest`);
    stop(code ?? 1);
  });
  children.push(child);
  writePids();
}

const pidFile = resolve(root, ".factory/dev.json");
function writePids(): void {
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid: process.pid, children: children.map((c) => c.pid).filter((p) => p !== undefined) }));
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (onWindows) {
    if (signal === "SIGKILL") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
    else child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // the group has already exited
  }
}

function groupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  if (onWindows) return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid file goes only once every group is gone, so `npm run stop` can still find a straggler. */
let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) signalGroup(c, "SIGINT");
  const deadline = Date.now() + 30_000;
  const poll = setInterval(() => {
    const left = children.filter(groupAlive);
    if (left.length > 0 && Date.now() < deadline) return;
    clearInterval(poll);
    for (const c of left) {
      console.log(`[dev] ${names.get(c)} did not stop within 30 seconds; killing it`);
      signalGroup(c, "SIGKILL");
    }
    rmSync(pidFile, { force: true });
    process.exit(code);
  }, 250);
}
process.on("SIGINT", () => stop(0));
process.on("SIGHUP", () => stop(0));
process.on("SIGTERM", () => stop(0));

if (process.argv.includes("--foreman-only")) {
  console.log("[dev] dashboard: not started (--foreman-only)");
} else if (!factory.dashboard.enabled) {
  console.log("[dev] dashboard: off (dashboard.enabled: false in factory.yaml), so the dashboard is not started");
} else {
  const port = env.SA_PORTAL_PORT || "8787";
  const url = factory.dashboard.url ?? (env.SA_PORTAL_URL || `http://127.0.0.1:${port}`);
  env.SA_PORTAL_URL = url;
  env.SA_PORTAL_INGEST_SECRET ||= randomBytes(32).toString("hex");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) {
    console.log(`[dev] dashboard: ${url} is not on this machine, so the dashboard is not started here; Foreman pushes to it`);
  } else {
    const portalDir = resolve(root, "dashboard");
    if (!existsSync(resolve(portalDir, "node_modules"))) spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: portalDir, stdio: "inherit", shell: onWindows });
    const port = new URL(url).port || "80";
    run("dashboard", "npm", ["run", "dev"], portalDir, { ...env, SA_PORTAL_PORT: port, SA_PORTAL_AUTH: env.SA_PORTAL_AUTH || "none" });
    console.log(`[dev] dashboard: ${url}`);
  }
}

const repoFlags = factory.repos.flatMap((r) => ["--repo", r.repo]);
run("foreman", "npx", ["--yes", SDK_SPEC, "serve", "--dir", ".", "--cursor-events", ...repoFlags], resolve(root, "foreman"), env);

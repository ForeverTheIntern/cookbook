/**
 * `npm run dev`: Foreman under `bdk serve` for every repository in
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
import { BDK_SPEC } from "./lib/doctor/bdk.ts";
import { loadFactory } from "../foreman/bot/lib/config/load.ts";

const SDK = BDK_SPEC;
const root = fileURLToPath(new URL("..", import.meta.url));
const factory = loadFactory(resolve(root, pathsEnv().factoryConfig));
const env: NodeJS.ProcessEnv = { ...process.env };
const children: ChildProcess[] = [];
// npm and npx are .cmd files on Windows, which spawn finds only through a shell.
const onWindows = process.platform === "win32";

function run(name: string, command: string, args: string[], cwd: string, childEnv: NodeJS.ProcessEnv): void {
  const child = spawn(command, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], shell: onWindows });
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

let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGINT");
  const exit = () => {
    rmSync(pidFile, { force: true });
    process.exit(code);
  };
  setTimeout(exit, 30_000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.once("exit", r))))).then(exit);
}
process.on("SIGINT", () => stop(0));
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
run("foreman", "npx", ["--yes", SDK, "serve", "--dir", ".", "--cursor-events", ...repoFlags], resolve(root, "foreman"), env);

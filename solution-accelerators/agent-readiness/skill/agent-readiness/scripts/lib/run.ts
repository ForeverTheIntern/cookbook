import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "./util.ts";

export interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

const PASS_THROUGH = ["PATH", "LANG", "LC_ALL", "TERM", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

export interface EnvOptions {
  registryEnv?: string[];
  inheritEnv?: boolean;
  extra?: Record<string, string>;
}

export function scrubbedEnv(opts: EnvOptions = {}): Record<string, string> {
  if (opts.inheritEnv) {
    const all: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) all[k] = v;
    return { ...all, ...(opts.extra ?? {}) };
  }
  const home = mkdtempSync(join(tmpdir(), "readiness-home-"));
  const env: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const key of opts.registryEnv ?? []) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  ensureDir(join(home, "cache"));
  Object.assign(env, {
    HOME: home,
    TMPDIR: join(home, "tmp"),
    XDG_CACHE_HOME: join(home, "cache"),
    npm_config_cache: join(home, "cache", "npm"),
    npm_config_update_notifier: "false",
    PIP_CACHE_DIR: join(home, "cache", "pip"),
    COREPACK_HOME: join(home, "cache", "corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    CI: "1",
  });
  ensureDir(env.TMPDIR);
  return { ...env, ...(opts.extra ?? {}) };
}

const MAX_OUTPUT = 1024 * 1024;

export function runCommand(command: string, cwd: string, env: Record<string, string>, timeoutSec: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bash", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    const onData = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutSec * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, timedOut, durationMs: Date.now() - started, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, timedOut: false, durationMs: Date.now() - started, output: output + String(err) });
    });
  });
}

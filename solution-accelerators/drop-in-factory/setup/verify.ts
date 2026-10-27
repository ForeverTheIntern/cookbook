/**
 * `npm run verify -- launch|drive|evidence|cleanup`
 *
 * Launch starts the collector (when its binary is available) and `npm run dev`,
 * and records their pids. Drive opens one labeled issue and waits until
 * Foreman claims it. Cleanup stops those pids and closes that issue. Evidence
 * stays in SA_VERIFY_EVIDENCE.
 */

import "../foreman/bot/lib/config/dotenv.ts";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shellEnv, verifyEnv, workerEnv, pathsEnv } from "../foreman/bot/lib/config/env.ts";
import { loadFactory } from "../foreman/bot/lib/config/load.ts";
import { listeners } from "./lib/doctor/ports.ts";
import type { GitHub } from "../foreman/bot/lib/github/rest.ts";
import {
  claimantsOf,
  closeVerificationIssue,
  deleteRunBranch,
  openVerificationIssue,
  readJson,
  startDetached,
  stopAgentsOnBranch,
  stopRecorded,
  waitForClaim,
  waitForHttp,
  writeJson,
  type PidRecord,
  type Started,
} from "./lib/verify-run.ts";

const factoryDir = fileURLToPath(new URL("..", import.meta.url));
const verify = verifyEnv();
const evidence = resolve(factoryDir, verify.evidenceDir);
const command = process.argv[2] ?? "";

if (command === "launch") await launch();
else if (command === "drive") await drive();
else if (command === "evidence") await evidenceCapture();
else if (command === "cleanup") await cleanup();
else {
  console.error("Usage: npm run verify -- launch|drive|evidence|cleanup");
  process.exit(2);
}

async function launch(): Promise<void> {
  const busy = (await listeners(verify.ports)).filter((row) => row.pid !== null);
  if (busy.length > 0) {
    for (const row of busy) console.error(`port ${row.port} is pid ${row.pid} ${row.command} (${row.cwd})`);
    console.error("Free those ports before launch. This command does not stop processes it did not start.");
    process.exit(1);
  }
  const records: PidRecord[] = [];
  const collector = collectorBin();
  if (collector === null) console.log("note  otelcol-contrib was not found. Set SA_OTELCOL_BIN, or the doctor's collector line will fail.");
  else records.push(await startDetached(collector, ["--config", resolve(factoryDir, "setup/collector.yaml")], factoryDir, shellEnv(), resolve(evidence, "collector.log")));
  records.push(await startDetached("npm", ["run", "dev"], factoryDir, shellEnv(), resolve(evidence, "dev.log")));
  writeJson(resolve(evidence, "pids.json"), { processes: records });
  const health = `http://127.0.0.1:${verify.portalPort}/api/health`;
  try {
    await waitForHttp(health, 180_000);
    console.log(`ready ${health}`);
  } catch (error) {
    console.error((error as Error).message);
    console.error(`pids are in ${resolve(evidence, "pids.json")}. Run npm run verify -- cleanup`);
    process.exit(1);
  }
  console.log(`started ${records.map((row) => row.pid).join(", ")}`);
}

async function drive(): Promise<void> {
  if (!verify.drive && !process.argv.includes("--yes")) {
    console.error("Neither --yes nor SA_VERIFY_DRIVE=1 was given, so no issue was opened.");
    process.exit(2);
  }
  const env = workerEnv();
  const factory = loadFactory(resolve(factoryDir, pathsEnv().factoryConfig));
  const config = verify.driveRepo === "" ? factory.repos[0] : factory.repos.find((repo) => repo.repo === verify.driveRepo || repo.key === verify.driveRepo);
  if (config === undefined) {
    console.error(`SA_VERIFY_REPO ${verify.driveRepo} is not in factory.yaml`);
    process.exit(2);
  }
  const gh: GitHub = { token: env.githubToken, repo: config.repo };
  const issue = await openVerificationIssue(gh, config);
  const started: Started = { repo: config.repo, issue, runId: null, branch: null, createdAt: new Date().toISOString() };
  writeJson(resolve(evidence, "started.json"), started);
  console.log(`opened ${config.repo}#${issue}`);
  const runId = await waitForClaim(gh, issue, verify.driveTimeoutMs);
  if (runId === null) {
    console.error(`Foreman did not claim ${config.repo}#${issue} within ${verify.driveTimeoutMs}ms`);
    process.exit(1);
  }
  started.runId = runId;
  started.branch = runId === "unknown" ? null : `factory/${runId}`;
  writeJson(resolve(evidence, "started.json"), started);
  // Two Foremans on one label claim within a second or two of each other.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000));
  const foremen = await claimantsOf(gh, issue);
  if (foremen.length > 1) {
    console.error(`Foremen ${foremen.join(", ")} all claimed ${config.repo}#${issue}: another Foreman watches ${config.intakeLabel}. Give yours a label of its own, run cleanup, and drive again.`);
    process.exit(1);
  }
  writeJson(resolve(evidence, "drive.json"), started);
  console.log(`claimed ${started.branch ?? runId}`);
}

async function evidenceCapture(): Promise<void> {
  const url = `http://127.0.0.1:${verify.portalPort}/`;
  const shot = resolve(evidence, "portal.png");
  const chrome = verify.chromeBin || which("google-chrome") || which("chromium") || which("chromium-browser");
  if (chrome === null) {
    console.error("No Chrome binary. Set SA_CHROME_BIN to capture portal.png.");
    process.exit(1);
  }
  const profile = mkdtempSync(join(tmpdir(), "verify-chrome-"));
  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-breakpad",
    "--disable-crash-reporter",
    `--user-data-dir=${profile}`,
    `--screenshot=${shot}`,
    "--window-size=1280,800",
    url,
  ], { detached: true, stdio: "ignore" });
  const pid = child.pid;
  child.unref();
  if (pid === undefined) {
    rmSync(profile, { recursive: true, force: true });
    console.error("could not start Chrome");
    process.exit(1);
  }
  let bytes = 0;
  try {
    // The dev dashboard keeps a socket open, so Chrome writes the picture and then stays up.
    // Stop the process group this command started once the file has settled.
    const deadline = Date.now() + 25_000;
    let stable = 0;
    while (Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
      let size = 0;
      try {
        size = statSync(shot).size;
      } catch {
        size = 0;
      }
      if (size > 10_000 && size === bytes) stable += 1;
      else stable = 0;
      bytes = size;
      if (stable >= 2) break;
    }
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Chrome already exited.
      }
    }
    rmSync(profile, { recursive: true, force: true });
  }
  if (bytes < 10_000) {
    console.error(`portal.png was not written (${bytes} bytes)`);
    process.exit(1);
  }
  const files = existsSync(evidence) ? readdirSync(evidence) : [];
  writeJson(resolve(evidence, "manifest.json"), { url, files });
  console.log(`evidence ${evidence}: ${files.join(", ")}`);
}

async function cleanup(): Promise<void> {
  const pids = readJson<{ processes: PidRecord[] }>(resolve(evidence, "pids.json"));
  for (const record of pids?.processes ?? []) console.log(await stopRecorded(record));
  const started = readJson<Started>(resolve(evidence, "started.json"));
  if (started !== null) {
    const env = workerEnv();
    const gh: GitHub = { token: env.githubToken, repo: started.repo };
    console.log(await stopAgentsOnBranch(env.cursorApiKey, started.repo, started.branch));
    console.log(await closeVerificationIssue(gh, started.issue));
    console.log(await deleteRunBranch(gh, started.branch));
  }
  console.log(`evidence kept at ${evidence}`);
}

function collectorBin(): string | null {
  if (verify.otelcolBin !== "") return verify.otelcolBin;
  return which("otelcol-contrib");
}

function which(command: string): string | null {
  try {
    return execFileSync("which", [command], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * `npm run stop`: stop the factory `npm run dev` started, from any terminal,
 * as Ctrl-C would. `npm run stop -- --force` kills what is still running
 * after that; nothing in Foreman's store is lost either way.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processRows } from "./lib/doctor/ports.ts";
import { expandPids } from "./lib/doctor/report.ts";

const pidFile = resolve(fileURLToPath(new URL("..", import.meta.url)), ".factory/dev.json");
const force = process.argv.includes("--force");
if (!existsSync(pidFile)) {
  console.log("stop: no factory started by npm run dev is running here");
  process.exit(0);
}
const { pid, children } = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; children: number[] };
const alive = (p: number) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
const signal = (p: number, s: NodeJS.Signals) => {
  try {
    process.kill(p, s);
  } catch {
    // already gone
  }
};

if (force && process.platform === "win32") for (const p of [pid, ...children]) spawnSync("taskkill", ["/T", "/F", "/PID", String(p)]);
else if (force) {
  for (const p of expandPids([pid, ...children], await processRows())) signal(p, "SIGKILL");
  // npm run dev starts each child as a process group leader; this reaches a member whose parent already exited.
  for (const c of children) signal(-c, "SIGKILL");
} else signal(pid, process.platform === "win32" ? "SIGTERM" : "SIGINT");
const running = () => [pid, ...children].filter((p) => alive(p) || (process.platform !== "win32" && p !== pid && alive(-p)));
const deadline = Date.now() + (force ? 5_000 : 35_000);
while (Date.now() < deadline && running().length > 0) await new Promise((r) => setTimeout(r, 250));
const left = running();
if (left.length > 0) {
  console.log(`stop: pids ${left.join(", ")} are still running. Run npm run stop -- --force`);
  process.exit(1);
}
rmSync(pidFile, { force: true });
console.log("stop: Foreman and the dashboard have stopped");

/**
 * Who is listening. `lsof -F` is the same on Linux and macOS. A missing
 * listener is exit code 1, not an error. On Linux, Next's `next-server`
 * listener is invisible to lsof 4.95, so a miss falls back to `/proc/net/tcp`.
 * Windows uses `netstat -ano` instead.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { promisify } from "node:util";
import { parseLsof, parseNetstat, parseProcNet, type Listener } from "./report.ts";

const exec = promisify(execFile);

export async function listeners(ports: number[]): Promise<Listener[]> {
  if (process.platform === "win32") return windowsListeners(ports);
  const found: Listener[] = [];
  for (const port of ports) {
    const output = await lsof(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pcn"]);
    const row = parseLsof(output)[0] ?? procOwner(port);
    if (row === null) {
      found.push({ port, pid: null, command: "", cwd: "" });
      continue;
    }
    found.push({ port, pid: row.pid, command: row.command, cwd: await cwdOf(row.pid) });
  }
  return found;
}

/** Windows has no lsof or /proc: `netstat -ano` gives the pid and `tasklist` its image name. The working folder is not available. */
async function windowsListeners(ports: number[]): Promise<Listener[]> {
  const { stdout } = await exec("netstat", ["-ano", "-p", "TCP"], { timeout: 10_000, maxBuffer: 4_000_000 });
  const { stdout: v6 } = await exec("netstat", ["-ano", "-p", "TCPv6"], { timeout: 10_000, maxBuffer: 4_000_000 });
  const rows = parseNetstat(`${stdout}\n${v6}`);
  const found: Listener[] = [];
  for (const port of ports) {
    const row = rows.find((r) => r.port === port);
    if (row === undefined) {
      found.push({ port, pid: null, command: "", cwd: "" });
      continue;
    }
    let command = "unknown";
    try {
      const { stdout: task } = await exec("tasklist", ["/FI", `PID eq ${row.pid}`, "/FO", "CSV", "/NH"], { timeout: 5_000 });
      command = task.trim().match(/^"([^"]+)"/)?.[1] ?? "unknown";
    } catch {
      // the pid alone still names the listener
    }
    found.push({ port, pid: row.pid, command, cwd: "unknown" });
  }
  return found;
}

export async function processRows(): Promise<{ pid: number; ppid: number }[]> {
  const { stdout } = await exec("ps", ["-eo", "pid=,ppid="], { timeout: 5_000, maxBuffer: 2_000_000 });
  const rows: { pid: number; ppid: number }[] = [];
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid });
  }
  return rows;
}

/** `lsof` prints nothing and exits 1 when the port is free. */
async function lsof(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("lsof", args, { timeout: 5_000, maxBuffer: 1_000_000 });
    return stdout;
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; message?: string };
    if (failed.code === "ENOENT") throw new Error("lsof is not installed");
    if (failed.code === 1) return failed.stdout ?? "";
    throw new Error(`lsof failed: ${failed.message ?? "unknown error"}`);
  }
}

/**
 * lsof 4.95 does not list Next's `next-server` listener, so a port check
 * that trusts lsof alone calls a live dashboard free. `/proc/net/tcp` is
 * Linux-only; macOS keeps the lsof result.
 */
function procOwner(port: number): { pid: number; command: string } | null {
  const inodes = new Set<string>();
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const row of parseProcNet(text)) {
      if (row.port === port) inodes.add(row.inode);
    }
  }
  if (inodes.size === 0) return null;
  let names: string[] = [];
  try {
    names = readdirSync("/proc");
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target = "";
      try {
        target = readlinkSync(`/proc/${name}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = target.match(/^socket:\[(\d+)\]$/)?.[1];
      if (inode !== undefined && inodes.has(inode)) return { pid: Number(name), command: commandOf(Number(name)) };
    }
  }
  return null;
}

function commandOf(pid: number): string {
  try {
    const text = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();
    if (text !== "") return text.slice(0, 180);
  } catch {
    // the short name is enough when the command line is empty
  }
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "unknown";
  }
}

async function cwdOf(pid: number): Promise<string> {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // macOS has no /proc, and a pid can exit between the listing and this read
  }
  try {
    const { stdout } = await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"], { timeout: 5_000 });
    const line = stdout.split("\n").find((item) => item.startsWith("n"));
    return line === undefined ? "unknown" : line.slice(1);
  } catch {
    return "unknown";
  }
}

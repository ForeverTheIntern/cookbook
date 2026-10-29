import { spawnSync } from "node:child_process";
import { runCommand } from "./run.ts";
import type { RunOutcome } from "./run.ts";

export interface Runtime {
  bin: string;
}

export function detectRuntime(preference: string = "auto"): Runtime | null {
  if (preference === "none") return null;
  const candidates = preference === "auto" ? ["docker", "podman"] : [preference];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20000 });
    if (r.status === 0) return { bin };
  }
  return null;
}

export function buildImage(runtime: Runtime, contextDir: string, dockerfile: string, tag: string): { ok: boolean; output: string } {
  const r = spawnSync(runtime.bin, ["build", "-q", "-t", tag, "-f", dockerfile, contextDir], { encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

export function startArgs(name: string, image: string, hostDir: string, registryEnv: string[]): string[] {
  const args = ["run", "-d", "--name", name, "-v", `${hostDir}:/work`, "-w", "/work", "-e", "CI=1", "-e", "HOME=/tmp/home"];
  for (const key of registryEnv) args.push("-e", key);
  args.push(image, "sleep", "infinity");
  return args;
}

export function execArgs(name: string, command: string, cwd: string): string[] {
  const dir = cwd === "." || cwd === "" ? "/work" : `/work/${cwd}`;
  return ["exec", "-w", dir, name, "bash", "-lc", command];
}

export function disconnectArgs(name: string): string[] {
  return ["network", "disconnect", "bridge", name];
}

export class ContainerSession {
  runtime: Runtime;
  name: string;
  image: string;
  hostDir: string;
  registryEnv: string[];

  constructor(runtime: Runtime, name: string, image: string, hostDir: string, registryEnv: string[]) {
    this.runtime = runtime;
    this.name = name;
    this.image = image;
    this.hostDir = hostDir;
    this.registryEnv = registryEnv;
  }

  start(): { ok: boolean; output: string } {
    const env = { ...process.env } as Record<string, string>;
    const r = spawnSync(this.runtime.bin, startArgs(this.name, this.image, this.hostDir, this.registryEnv), { encoding: "utf8", env, timeout: 300000 });
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  exec(command: string, cwd: string, timeoutSec: number): Promise<RunOutcome> {
    const argv = [this.runtime.bin, ...execArgs(this.name, command, cwd)].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    return runCommand(argv, process.cwd(), process.env as Record<string, string>, timeoutSec);
  }

  disconnectNetwork(): boolean {
    const r = spawnSync(this.runtime.bin, disconnectArgs(this.name), { encoding: "utf8" });
    return r.status === 0;
  }

  stop(): void {
    spawnSync(this.runtime.bin, ["exec", this.name, "chown", "-R", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, "/work"], { encoding: "utf8" });
    spawnSync(this.runtime.bin, ["rm", "-f", this.name], { encoding: "utf8" });
  }
}

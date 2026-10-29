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

export function execArgs(name: string, command: string, cwd: string, user: string | null = null): string[] {
  const dir = cwd === "." || cwd === "" ? "/work" : `/work/${cwd}`;
  return ["exec", ...(user ? ["-u", user] : []), "-w", dir, name, "bash", "-lc", command];
}

// CI runs the repo's commands as an ordinary user, and tests that check file permissions only
// pass there. Root on the host means no ordinary user to borrow, so commands run as the image's.
export function hostUser(): string | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || uid === 0 ? null : `${uid}:${gid}`;
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
  user: string | null;

  constructor(runtime: Runtime, name: string, image: string, hostDir: string, registryEnv: string[], user: string | null = hostUser()) {
    this.runtime = runtime;
    this.name = name;
    this.image = image;
    this.hostDir = hostDir;
    this.registryEnv = registryEnv;
    this.user = user;
  }

  start(): { ok: boolean; output: string } {
    const env = { ...process.env } as Record<string, string>;
    const r = spawnSync(this.runtime.bin, startArgs(this.name, this.image, this.hostDir, this.registryEnv), { encoding: "utf8", env, timeout: 300000 });
    if (r.status === 0) this.asImageUser("mkdir -p /tmp/home && chmod 1777 /tmp/home");
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  // The repo's own declared setup runs as its image's user; everything else as the ordinary user.
  async exec(command: string, cwd: string, timeoutSec: number, opts: { imageUser?: boolean } = {}): Promise<RunOutcome> {
    const user = opts.imageUser ? null : this.user;
    const argv = [this.runtime.bin, ...execArgs(this.name, command, cwd, user)].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
    const out = await runCommand(argv, process.cwd(), process.env as Record<string, string>, timeoutSec);
    if (opts.imageUser && this.user) this.asImageUser(`chown -R ${this.user} /work`);
    return out;
  }

  asImageUser(command: string, timeoutMs = 300000): { ok: boolean; output: string } {
    const r = spawnSync(this.runtime.bin, ["exec", this.name, "bash", "-lc", command], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  enableCorepack(): void {
    spawnSync(this.runtime.bin, ["exec", this.name, "bash", "-lc", "command -v corepack >/dev/null && corepack enable >/dev/null 2>&1 || true"], { encoding: "utf8", timeout: 60000 });
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

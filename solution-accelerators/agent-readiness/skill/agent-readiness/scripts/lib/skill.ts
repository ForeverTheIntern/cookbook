import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { Rubric } from "./rubric.ts";
import { strengthRank } from "./rubric.ts";
import type { Audit, ContractCommand, Diagnosis, Evidence } from "./types.ts";
import { SKILL_ROOT, exists, fail, readText, writeText } from "./util.ts";

function passingEvidence(audit: Audit, cmd: ContractCommand, rubric: Rubric): Evidence | undefined {
  const evs = audit.evidence.filter((e) => e.contractId === cmd.id);
  const last = evs[evs.length - 1];
  if (!last || last.result !== "pass") return undefined;
  if (strengthRank(rubric, last.strength) < strengthRank(rubric, "executed")) return undefined;
  return last;
}

function advice(d: Diagnosis, startCmd: string | null): string {
  switch (d.cause) {
    case "service":
      return startCmd ? `start the services first with \`${startCmd}\`, then retry` : `${d.service ?? "a service"} isn't running; start it, then retry`;
    case "credential":
      return "a test needs a credential; use the sandbox value from the test setup, never a production one";
    case "registry":
      return "the registry needs a token; ask for a read-only registry token and pass it as an environment variable";
    case "missing_tool":
      return `${d.detail}; install it or use the environment setup`;
    case "missing_module":
      return `${d.detail}; rerun the install step`;
    case "network":
      return "tests run offline; mock the network call";
    case "timeout":
      return "the step ran out of time; run the failing test file on its own";
    default:
      return "read the full output and fix the first error";
  }
}

export function renderVerifySkill(audit: Audit, rubric: Rubric, include: string[] = [], earlier: Audit[] = []): { text: string; commands: ContractCommand[] } {
  const allowed = new Set(audit.contract.filter((c) => passingEvidence(audit, c, rubric)).map((c) => c.id));
  for (const id of include) if (!allowed.has(id)) fail(`Refusing to include ${id}: the audit has no passing run of it. Only commands the audit ran and saw pass go into the verify skill.`);
  const pick = (kinds: string[]) => audit.contract.filter((c) => kinds.includes(c.kind) && allowed.has(c.id));
  const doctor = pick(["doctor"]);
  const install = [...pick(["install"]), ...pick(["start"])];
  const verify = pick(["build", "lint", "typecheck", "test"]);
  if (verify.length === 0) fail("No build, lint, type-check or test command passed in this audit, so there is nothing to put in a verify skill. Fix the setup first and re-audit.");
  const line = (c: ContractCommand) => "```bash\n" + (c.cwd && c.cwd !== "." ? `(cd ${c.cwd} && ${c.command})` : c.command) + "\n```";
  const strongest = [...doctor, ...install, ...verify]
    .map((c) => passingEvidence(audit, c, rubric)!.strength)
    .sort((a, b) => strengthRank(rubric, b) - strengthRank(rubric, a))[0];
  const startCmd = audit.contract.find((c) => c.kind === "start" && allowed.has(c.id))?.command ?? null;
  const failures = [audit, ...earlier].flatMap((a) => a.evidence.filter((e) => e.result === "fail" && e.diagnosis));
  const seen = new Set<string>();
  const playbook: string[] = [];
  for (const f of failures) {
    const key = `${f.diagnosis!.cause}:${f.diagnosis!.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    playbook.push(`- \`${f.diagnosis!.detail}\` while running \`${f.command ?? f.kind}\`: ${advice(f.diagnosis!, startCmd)}.`);
  }
  if (playbook.length === 0) playbook.push("- Rerun the failing command on its own and read its output. Every command here passed in the audit, so a new failure most likely comes from the change you made.");
  const template = readText(join(SKILL_ROOT, "templates", "verify-skill.md"));
  const text = template
    .replaceAll("{{repo}}", audit.repo.name)
    .replaceAll("{{auditId}}", audit.id)
    .replace("{{strengthLabel}}", rubric.strengthLabels[strongest])
    .replace("{{doctor}}", doctor.map(line).join("\n\n") || "No setup check was recorded.")
    .replace("{{install}}", install.map(line).join("\n\n") || "No install step is needed.")
    .replace("{{verify}}", verify.map(line).join("\n\n"))
    .replace("{{playbook}}", playbook.join("\n"));
  return { text, commands: [...doctor, ...install, ...verify] };
}

export const ENV_KEYS = new Set(["name", "install", "start", "build"]);

export interface EnvFiles {
  files: Record<string, string>;
  environmentJson: Record<string, unknown>;
  services: string[];
}

const SERVICES: Record<string, { apt: string; start: string; ready: string; label: string }> = {
  postgres: {
    apt: "postgresql",
    start: '$SUDO service postgresql start >/dev/null 2>&1 || $SUDO bash -c "pg_ctlcluster $(ls /etc/postgresql) main start"',
    ready: "pg_isready -q -h 127.0.0.1",
    label: "Postgres",
  },
  redis: { apt: "redis-server", start: "redis-server --daemonize yes >/dev/null", ready: "redis-cli ping >/dev/null 2>&1", label: "Redis" },
};

export function serviceKey(label: string): string | null {
  const l = label.toLowerCase();
  if (l.includes("postgres")) return "postgres";
  if (l.includes("redis")) return "redis";
  return null;
}

export function renderEnvFiles(audit: Audit, services: string[], opts: { dockerfile: boolean }): EnvFiles {
  const install = audit.contract.find((c) => c.kind === "install");
  if (!install) fail("The audit has no install command to build the environment setup from.");
  const svc = services.map((s) => {
    const def = SERVICES[s];
    if (!def) fail(`Unsupported service ${s}. Supported: ${Object.keys(SERVICES).join(", ")}`);
    return def;
  });
  const sudo = 'SUDO=""; if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi';
  const aptLine = svc.length ? `if ! dpkg -s ${svc.map((s) => s.apt).join(" ")} >/dev/null 2>&1; then\n  $SUDO apt-get update -qq\n  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq ${svc.map((s) => s.apt).join(" ")} >/dev/null\nfi\n` : "";
  const installSh = `#!/usr/bin/env bash\n# Installs what agents need to build and test this repo. Safe to rerun.\nset -euo pipefail\n${sudo}\n${aptLine}${install.command}\n`;
  const startLines = svc.map((s) => `${s.start}\nfor i in $(seq 1 30); do\n  if ${s.ready}; then break; fi\n  sleep 1\n  if [ "$i" = 30 ]; then echo "${s.label} didn't become ready" >&2; exit 1; fi\ndone`).join("\n");
  const startSh = `#!/usr/bin/env bash\n# Starts the local services tests need and waits until they are ready. Safe to rerun.\nset -euo pipefail\n${sudo}\n${startLines || "true"}\n`;
  const env: Record<string, unknown> = { name: `${audit.repo.name} agents`, install: "bash scripts/agent-install.sh", start: "bash scripts/agent-start.sh" };
  const files: Record<string, string> = { "scripts/agent-install.sh": installSh, "scripts/agent-start.sh": startSh };
  if (opts.dockerfile && svc.length) {
    const image = audit.environment.image ?? "node:22-bookworm-slim";
    files[".cursor/Dockerfile"] = `FROM ${image}\nRUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${svc.map((s) => s.apt).join(" ")} && rm -rf /var/lib/apt/lists/*\n`;
    env.build = { dockerfile: "Dockerfile", context: "." };
  }
  for (const key of Object.keys(env)) if (!ENV_KEYS.has(key)) fail(`Internal error: ${key} isn't an allowed environment.json field`);
  files[".cursor/environment.json"] = JSON.stringify(env, null, 2) + "\n";
  return { files, environmentJson: env, services };
}

export function writeFiles(repo: string, files: Record<string, string>, force: boolean): string[] {
  const written: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const full = join(repo, rel);
    if (exists(full) && !force) fail(`${rel} already exists. Pass --force to overwrite it.`);
    writeText(full, text);
    if (rel.endsWith(".sh")) chmodSync(full, 0o755);
    written.push(rel);
  }
  return written;
}

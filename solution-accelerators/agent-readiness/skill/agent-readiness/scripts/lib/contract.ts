import { join } from "node:path";
import type { Rubric } from "./rubric.ts";
import type { CommandKind, ContractCommand, Profile, SafetyFinding } from "./types.ts";
import { exists, fail, readText } from "./util.ts";

export const VENV = ".readiness-venv";

const PLACEHOLDER_TEST = /no test specified/;

const SCRIPT_ALIASES: Record<"build" | "lint" | "typecheck" | "test", string[]> = {
  build: ["build"],
  lint: ["lint"],
  typecheck: ["typecheck", "type-check", "check-types", "tsc"],
  test: ["test"],
};

function frozenInstall(profile: Profile, tree: string, ignoreScripts: boolean): { command: string; reason: string } {
  const flag = ignoreScripts ? " --ignore-scripts" : "";
  switch (profile.packageManager) {
    case "npm":
      return exists(join(tree, "package-lock.json"))
        ? { command: `npm ci${flag}`, reason: "frozen install from package-lock.json" }
        : { command: `npm install${flag}`, reason: "no lockfile, so the install can't be frozen" };
    case "pnpm":
      return { command: `corepack pnpm install --frozen-lockfile${flag}`, reason: "frozen install from pnpm-lock.yaml" };
    case "yarn":
      return { command: `corepack yarn install --frozen-lockfile${flag}`, reason: "frozen install from yarn.lock" };
    case "uv":
      return { command: "uv sync --frozen", reason: "frozen install from uv.lock" };
    case "poetry":
      return { command: "poetry install --no-interaction --sync", reason: "install from poetry.lock" };
    case "pip": {
      const req = exists(join(tree, "requirements.txt")) ? " -r requirements.txt" : exists(join(tree, "pyproject.toml")) ? " -e ." : "";
      return { command: `python3 -m venv ${VENV} && ${VENV}/bin/pip install -q --disable-pip-version-check${req}`, reason: "virtualenv install from requirements" };
    }
    default:
      return { command: "true", reason: "no package manager found" };
  }
}

function runScript(pm: string | null, script: string): string {
  if (pm === "pnpm") return `corepack pnpm run ${script}`;
  if (pm === "yarn") return `corepack yarn run ${script}`;
  return `npm run ${script}`;
}

function pythonTest(tree: string, path: string): string | null {
  const dir = join(tree, path);
  const reqs = ["requirements.txt", "requirements-dev.txt", "pyproject.toml"].map((f) => (exists(join(dir, f)) ? readText(join(dir, f)) : "")).join("\n");
  if (/pytest/.test(reqs) || exists(join(dir, "pytest.ini")) || exists(join(dir, "conftest.py"))) return `${VENV}/bin/python -m pytest -q`;
  if (exists(join(dir, "tests"))) return `${VENV}/bin/python -m unittest discover -s tests -t .`;
  return null;
}

export function hasNetworkPipedHook(findings: SafetyFinding[]): boolean {
  return findings.some((f) => f.kind === "network_piped" && f.file.endsWith("package.json"));
}

export function discoverContract(profile: Profile, tree: string, rubric: Rubric, safety: SafetyFinding[]): ContractCommand[] {
  const cmds: ContractCommand[] = [];
  const timeout = rubric.budgets.commandTimeoutSec;
  const pm = profile.packageManager;
  const isPy = pm === "pip" || pm === "uv" || pm === "poetry";
  cmds.push({ id: "cmd-repo-doctor", kind: "doctor", component: "*", cwd: ".", command: isPy ? "python3 --version" : pm && pm !== "npm" ? `node --version && corepack ${pm} --version` : "node --version && npm --version", source: "readiness", reason: "toolchain present", timeoutSec: 60 });
  const ignoreScripts = hasNetworkPipedHook(safety);
  if (profile.environmentJson?.install) {
    cmds.push({ id: "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: profile.environmentJson.install, source: ".cursor/environment.json install", reason: "the repo's declared install", timeoutSec: timeout });
  } else {
    const install = frozenInstall(profile, tree, ignoreScripts);
    cmds.push({ id: "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: install.command, source: "readiness", reason: install.reason + (ignoreScripts ? "; install hooks skipped because one pipes the network into a shell" : ""), timeoutSec: timeout });
  }
  if (profile.environmentJson?.start) {
    cmds.push({ id: "cmd-repo-start", kind: "start", component: "*", cwd: ".", command: profile.environmentJson.start, source: ".cursor/environment.json start", reason: "the repo's declared services", timeoutSec: 180 });
  }
  for (const c of profile.components.filter((x) => x.assessed)) {
    if (c.language === "py") {
      const test = pythonTest(tree, c.path);
      if (test) cmds.push({ id: `cmd-${c.id}-test`, kind: "test", component: c.id, cwd: c.path, command: test, source: c.manifest ?? "readiness", reason: "discovered test runner", timeoutSec: timeout });
      continue;
    }
    for (const kind of ["build", "lint", "typecheck", "test"] as const) {
      const script = SCRIPT_ALIASES[kind].find((s) => c.scripts[s] && !(kind === "test" && PLACEHOLDER_TEST.test(c.scripts[s])));
      if (!script) continue;
      cmds.push({ id: `cmd-${c.id}-${kind}`, kind, component: c.id, cwd: c.path, command: runScript(pm, script), source: `${c.manifest} scripts.${script}`, reason: `discovered ${kind} script`, timeoutSec: timeout });
    }
  }
  return cmds;
}

export function addContractCommand(cmds: ContractCommand[], input: { kind: CommandKind; component: string; cwd: string; command: string; source: string; reason: string; timeoutSec?: number }): ContractCommand {
  if (!input.reason.trim()) fail("contract add needs --reason");
  if (!/^(agent|[^:]+:\d+|readiness|[^\s]+ scripts\.[\w:-]+)$/.test(input.source)) fail("--source must be `agent` or a file:line where the command was found");
  const base = `cmd-${input.component === "*" ? "repo" : input.component}-${input.kind}`;
  let id = base;
  let i = 2;
  while (cmds.some((c) => c.id === id)) id = `${base}-${i++}`;
  const cmd: ContractCommand = { id, timeoutSec: input.timeoutSec ?? 600, ...input };
  cmds.push(cmd);
  return cmd;
}

export function containerImage(profile: Profile, tree: string): string {
  const isPy = profile.packageManager === "pip" || profile.packageManager === "uv" || profile.packageManager === "poetry";
  if (isPy) {
    const pv = exists(join(tree, ".python-version")) ? readText(join(tree, ".python-version")).trim().match(/^(\d+\.\d+)/)?.[1] : null;
    return `python:${pv ?? "3.12"}-slim`;
  }
  let major: string | null = null;
  for (const f of [".nvmrc", ".node-version"]) {
    if (exists(join(tree, f))) major = readText(join(tree, f)).trim().replace(/^v/, "").match(/^(\d+)/)?.[1] ?? null;
    if (major) break;
  }
  if (!major && exists(join(tree, "package.json"))) {
    try {
      const engines = (JSON.parse(readText(join(tree, "package.json"))) as { engines?: { node?: string } }).engines?.node ?? "";
      major = engines.match(/(\d+)/)?.[1] ?? null;
    } catch {
      major = null;
    }
  }
  return `node:${major ?? "22"}-bookworm-slim`;
}

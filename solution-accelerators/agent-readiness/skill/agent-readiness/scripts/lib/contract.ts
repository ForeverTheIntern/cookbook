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

function frozenInstall(pm: Profile["packageManager"], dir: string, ignoreScripts: boolean): { command: string; reason: string } {
  const flag = ignoreScripts ? " --ignore-scripts" : "";
  switch (pm) {
    case "npm":
      return exists(join(dir, "package-lock.json"))
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
      const req = exists(join(dir, "requirements.txt")) ? " -r requirements.txt" : exists(join(dir, "pyproject.toml")) ? " -e ." : "";
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

// uv sync installs into .venv, with the dev dependency group by default.
function pythonTest(tree: string, path: string, pm: Profile["packageManager"]): string | null {
  const dir = join(tree, path);
  const python = pm === "uv" ? ".venv/bin/python" : pm === "poetry" ? "poetry run python" : `${VENV}/bin/python`;
  const reqs = ["requirements.txt", "requirements-dev.txt", "pyproject.toml"].map((f) => (exists(join(dir, f)) ? readText(join(dir, f)) : "")).join("\n");
  if (/pytest/.test(reqs) || exists(join(dir, "pytest.ini")) || exists(join(dir, "conftest.py"))) return `${python} -m pytest -q`;
  if (exists(join(dir, "tests"))) return `${python} -m unittest discover -s tests -t .`;
  return null;
}

function doctorCommand(profile: Profile): string {
  const pms = new Set(profile.components.filter((c) => c.assessed).map((c) => c.packageManager ?? profile.packageManager).filter((x): x is NonNullable<Profile["packageManager"]> => Boolean(x)));
  const parts: string[] = [];
  if ([...pms].some((p) => p === "npm" || p === "pnpm" || p === "yarn")) parts.push("node --version");
  if (pms.has("npm")) parts.push("npm --version");
  if (pms.has("pnpm")) parts.push("corepack pnpm --version");
  if (pms.has("yarn")) parts.push("corepack yarn --version");
  if (pms.has("pip") || pms.has("uv") || pms.has("poetry") || profile.components.some((c) => c.assessed && c.language === "py")) parts.push("python3 --version");
  if (pms.has("uv")) parts.push("uv --version");
  if (pms.has("poetry")) parts.push("poetry --version");
  return parts.length ? parts.join(" && ") : "node --version";
}

// The script a command runs, so `pnpm test` and `corepack pnpm run test` count as one command.
function scriptOf(command: string): string | null {
  const m = command.trim().replace(/^corepack\s+/, "").match(/^(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)(\s|$)/);
  if (!m) return null;
  return ["install", "ci", "add", "exec", "dlx", "x"].includes(m[2]) ? null : m[2];
}

export function hasNetworkPipedHook(findings: SafetyFinding[]): boolean {
  return findings.some((f) => f.kind === "network_piped" && f.file.endsWith("package.json"));
}

export function discoverContract(profile: Profile, tree: string, rubric: Rubric, safety: SafetyFinding[]): ContractCommand[] {
  const cmds: ContractCommand[] = [];
  const timeout = rubric.budgets.commandTimeoutSec;
  const pm = profile.packageManager;
  const assessed = profile.components.filter((c) => c.assessed);
  if (assessed.length === 0) return cmds;
  cmds.push({ id: "cmd-repo-doctor", kind: "doctor", component: "*", cwd: ".", command: doctorCommand(profile), source: "readiness", reason: "the toolchains the assessed components use are present", timeoutSec: 60 });
  const ignoreScripts = hasNetworkPipedHook(safety);
  const hookNote = ignoreScripts ? "; install hooks skipped because one pipes the network into a shell" : "";
  const standalone = assessed.filter((c) => c.packageManager && c.path !== ".");
  const declared = profile.environmentJson?.install;
  if (declared) cmds.push({ id: "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: declared, source: ".cursor/environment.json install", reason: "the repo's declared install", timeoutSec: timeout });
  // Behind a declared install, the frozen installs run only if this machine blocks it, so one
  // component's missing toolchain doesn't keep the others from being checked.
  const fallbackFor = declared ? "cmd-repo-install" : undefined;
  if (pm || (!declared && standalone.length === 0)) {
    const install = frozenInstall(pm, tree, ignoreScripts);
    cmds.push({ id: declared ? "cmd-repo-frozen-install" : "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: install.command, source: "readiness", reason: install.reason + hookNote, timeoutSec: timeout, ...(fallbackFor ? { fallbackFor } : {}) });
  }
  for (const c of standalone) {
    const install = frozenInstall(c.packageManager ?? null, join(tree, c.path), ignoreScripts);
    cmds.push({ id: `cmd-${c.id}-install`, kind: "install", component: c.id, cwd: c.path, command: install.command, source: "readiness", reason: `${install.reason} in ${c.path}${hookNote}`, timeoutSec: timeout, ...(fallbackFor ? { fallbackFor } : {}) });
  }
  if (profile.environmentJson?.start) {
    cmds.push({ id: "cmd-repo-start", kind: "start", component: "*", cwd: ".", command: profile.environmentJson.start, source: ".cursor/environment.json start", reason: "the repo's declared services", timeoutSec: 180 });
  }
  for (const c of profile.components.filter((x) => x.assessed)) {
    if (c.language === "py") {
      const test = pythonTest(tree, c.path, c.packageManager ?? pm);
      if (test) cmds.push({ id: `cmd-${c.id}-test`, kind: "test", component: c.id, cwd: c.path, command: test, source: c.manifest ?? "readiness", reason: "discovered test runner", timeoutSec: timeout });
      continue;
    }
    for (const kind of ["build", "lint", "typecheck", "test"] as const) {
      const script = SCRIPT_ALIASES[kind].find((s) => c.scripts[s] && !(kind === "test" && PLACEHOLDER_TEST.test(c.scripts[s])));
      if (!script) continue;
      cmds.push({ id: `cmd-${c.id}-${kind}`, kind, component: c.id, cwd: c.path, command: runScript(c.packageManager ?? pm, script), source: `${c.manifest} scripts.${script}`, reason: `discovered ${kind} script`, timeoutSec: timeout });
    }
  }
  return cmds;
}

// Replay runs only commands for "*" and assessed components, so anything else would be dropped silently.
export function checkComponent(profile: Profile | null, component: string): void {
  if (!profile) fail("Run `readiness scan` first: commands are added to the components it found.");
  if (component === "*") return;
  const c = profile.components.find((x) => x.id === component);
  const assessed = profile.components.filter((x) => x.assessed).map((x) => x.id);
  const choices = `Use * for a repo-wide command${assessed.length ? ` or one of: ${assessed.join(", ")}` : ""}.`;
  if (!c) fail(`No component named ${component}. ${choices}`);
  if (!c.assessed) fail(`${component} isn't assessed (${c.notAssessedReason ?? "not supported"}), so replay wouldn't run its commands. ${choices}`);
}

export function addContractCommand(cmds: ContractCommand[], input: { kind: CommandKind; component: string; cwd: string; command: string; source: string; reason: string; timeoutSec?: number }, profile: Profile | null): ContractCommand {
  checkComponent(profile, input.component);
  if (!input.reason.trim()) fail("contract add needs --reason");
  if (!/^(agent|[^:]+:\d+|readiness|[^\s]+ scripts\.[\w:-]+)$/.test(input.source)) fail("--source must be `agent` or a file:line where the command was found");
  const dir = (d: string) => d.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
  const script = scriptOf(input.command);
  const same = cmds.find((c) => c.component === input.component && dir(c.cwd) === dir(input.cwd) && (c.command.trim() === input.command.trim() || (script !== null && scriptOf(c.command) === script)));
  if (same) fail(`${same.id} already runs ${script ? `the ${script} script` : "this command"} for ${input.component === "*" ? "the repo" : input.component} (\`${same.command}\`), so it would run twice. Leave it out of the contract.`);
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
    return profile.packageManager === "uv" ? `ghcr.io/astral-sh/uv:python${pv ?? "3.12"}-bookworm-slim` : `python:${pv ?? "3.12"}-slim`;
  }
  const standalone = profile.components.filter((c) => c.packageManager && c.path !== ".");
  if (!profile.packageManager && standalone.length > 0 && standalone.every((c) => c.language === "py")) return "python:3.12-slim";
  let major: string | null = null;
  for (const dir of [".", ...standalone.filter((c) => c.language !== "py").map((c) => c.path)]) {
    for (const f of [".nvmrc", ".node-version"]) {
      if (exists(join(tree, dir, f))) major = readText(join(tree, dir, f)).trim().replace(/^v/, "").match(/^(\d+)/)?.[1] ?? null;
      if (major) break;
    }
    if (!major && exists(join(tree, dir, "package.json"))) {
      try {
        const engines = (JSON.parse(readText(join(tree, dir, "package.json"))) as { engines?: { node?: string } }).engines?.node ?? "";
        major = engines.match(/(\d+)/)?.[1] ?? null;
      } catch {
        major = null;
      }
    }
    if (major) break;
  }
  // The full image, like a CI runner, has python3, make and g++ for native npm builds.
  return `node:${major ?? "22"}-bookworm`;
}

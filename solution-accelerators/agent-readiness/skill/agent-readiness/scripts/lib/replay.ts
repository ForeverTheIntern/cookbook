import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ContainerSession, buildImage, detectRuntime } from "./container.ts";
import { containerImage } from "./contract.ts";
import { diagnose } from "./diagnose.ts";
import { addEvidence } from "./evidence.ts";
import { applySite, chooseSites } from "./mutate.ts";
import { redact, tail } from "./redact.ts";
import type { Rubric } from "./rubric.ts";
import { runCommand, scrubbedEnv } from "./run.ts";
import type { RunOutcome } from "./run.ts";
import type { Audit, CommandKind, CondId, ContractCommand, Diagnosis, Evidence, Mutant, Profile, Strength, Where } from "./types.ts";
import { exists, fail, randomHex, readText, sha256 } from "./util.ts";

export interface Executor {
  where: Where;
  strength: Strength;
  image: string | null;
  root: string;
  exec(command: string, cwd: string, timeoutSec: number): Promise<RunOutcome>;
  offline(): boolean;
  close(): void;
}

export const SUDO = /(^|[\s;&|(`]|\$\()sudo(\s|$)/;
export const SUDO_REFUSED = "not run on the host: it uses sudo, which the audit only runs inside a container";

export function hostExecutor(root: string, registryEnv: string[], inheritEnv: boolean, where: Where = "fresh_copy"): Executor {
  const env = scrubbedEnv({ registryEnv, inheritEnv });
  return {
    where,
    strength: "executed",
    image: null,
    root,
    exec: (command, cwd, timeoutSec) => (SUDO.test(command) ? Promise.resolve({ exitCode: null, timedOut: false, durationMs: 0, output: `readiness: ${SUDO_REFUSED}` }) : runCommand(command, join(root, cwd), env, timeoutSec)),
    offline: () => false,
    close: () => {},
  };
}

export function containerExecutor(session: ContainerSession, root: string): Executor {
  return {
    where: "container",
    strength: "clean_replay",
    image: session.image,
    root,
    exec: (command, cwd, timeoutSec) => session.exec(command, cwd, timeoutSec),
    offline: () => session.disconnectNetwork(),
    close: () => session.stop(),
  };
}

const KIND_CHECK: Record<CommandKind, { check: string; condition?: CondId }> = {
  doctor: { check: "bootstrap.cold_replay" },
  install: { check: "bootstrap.cold_replay", condition: "clean.install" },
  build: { check: "bootstrap.cold_replay", condition: "clean.build" },
  start: { check: "bootstrap.cold_replay" },
  lint: { check: "verify.canonical_interface", condition: "commands" },
  typecheck: { check: "verify.canonical_interface", condition: "commands" },
  test: { check: "bootstrap.cold_replay", condition: "clean.test" },
};

export interface PhaseResult {
  cmd: ContractCommand;
  status: "pass" | "fail" | "not_run";
  outcome: RunOutcome | null;
  diagnosis: Diagnosis | null;
  note: string;
  blocked?: string;
}

export const INSTALL_BLOCKED = "not run because the install was blocked on this machine";

export interface Budget {
  componentMs: number;
  totalMs: number;
  startedAt: number;
  used: Map<string, number>;
}

export function newBudget(componentMinutes: number, totalMinutes: number): Budget {
  return { componentMs: componentMinutes * 60000, totalMs: totalMinutes * 60000, startedAt: Date.now(), used: new Map() };
}

function overBudget(b: Budget, component: string): boolean {
  if (Date.now() - b.startedAt > b.totalMs) return true;
  return component !== "*" && (b.used.get(component) ?? 0) > b.componentMs;
}

function charge(b: Budget, component: string, ms: number): void {
  b.used.set(component, (b.used.get(component) ?? 0) + ms);
}

export async function runContract(
  ex: Executor,
  contract: ContractCommand[],
  opts: { components: Set<string>; budget: Budget; registryValues: string[]; onResult?: (r: PhaseResult) => void },
): Promise<PhaseResult[]> {
  const results: PhaseResult[] = [];
  const push = (r: PhaseResult) => {
    results.push(r);
    opts.onResult?.(r);
  };
  const wanted = (c: ContractCommand) => c.component === "*" || opts.components.has(c.component);
  const order: CommandKind[] = ["doctor", "install", "build", "start"];
  const online = contract.filter((c) => order.includes(c.kind) && wanted(c)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const offlineCmds = contract.filter((c) => !order.includes(c.kind) && wanted(c));
  const failedInstalls = new Set<string>();
  const blockedInstalls = new Set<string>();
  const blockedIds = new Set<string>();
  // Components whose own frozen install passed after the shared install was blocked.
  const rescued = new Set<string>();
  const gated = (cmd: ContractCommand) => {
    if (cmd.kind === "doctor" || cmd.fallbackFor) return false;
    if (failedInstalls.has(cmd.component) && !rescued.has(cmd.component)) return true;
    return failedInstalls.has("*") && !rescued.has(cmd.component) && !rescued.has("*");
  };
  const run = async (cmd: ContractCommand) => {
    if (cmd.fallbackFor && !blockedIds.has(cmd.fallbackFor)) return;
    if (overBudget(opts.budget, cmd.component)) {
      push({ cmd, status: "not_run", outcome: null, diagnosis: null, note: "cut off by the time budget" });
      return;
    }
    if (gated(cmd)) {
      const blocked = blockedInstalls.has(cmd.component) || (blockedInstalls.has("*") && !failedInstalls.has(cmd.component));
      push({ cmd, status: "not_run", outcome: null, diagnosis: null, note: blocked ? INSTALL_BLOCKED : "not run because the install failed", blocked: blocked ? "the install was blocked on this machine" : undefined });
      return;
    }
    if (ex.where !== "container" && SUDO.test(cmd.command)) {
      if (cmd.kind === "install") {
        failedInstalls.add(cmd.component);
        blockedInstalls.add(cmd.component);
        blockedIds.add(cmd.id);
      }
      push({ cmd, status: "not_run", outcome: null, diagnosis: null, note: SUDO_REFUSED, blocked: `the ${cmd.kind} command uses sudo, which the audit never runs on the host` });
      return;
    }
    const out = await ex.exec(cmd.command, cmd.cwd, cmd.timeoutSec);
    charge(opts.budget, cmd.component, out.durationMs);
    const ok = out.exitCode === 0 && !out.timedOut;
    const diagnosis = ok ? null : diagnose(out.output, out.timedOut, cmd.kind);
    const blocked = !ok && ex.where !== "container" && diagnosis?.cause === "missing_tool" ? `${diagnosis.detail} on this machine` : undefined;
    if (!ok && cmd.kind === "install") {
      failedInstalls.add(cmd.component);
      if (blocked) {
        blockedInstalls.add(cmd.component);
        blockedIds.add(cmd.id);
      }
    }
    if (ok && cmd.kind === "install" && cmd.fallbackFor) rescued.add(cmd.component);
    push({ cmd, status: ok ? "pass" : "fail", outcome: out, diagnosis, note: cmd.fallbackFor && ok ? "ran on its own because the shared install was blocked on this machine" : "", blocked });
  };
  for (const cmd of online) await run(cmd);
  const wentOffline = ex.offline();
  for (const cmd of offlineCmds) await run(cmd);
  if (ex.where === "container" && !wentOffline) {
    for (const r of results) if (!r.note) r.note = "network could not be switched off for the test phase";
  }
  return results;
}

export function evidenceFromPhase(audit: Audit, ex: Executor, r: PhaseResult, registryValues: string[]): Evidence {
  const map = KIND_CHECK[r.cmd.kind];
  const redacted = r.outcome ? redact(r.outcome.output, registryValues) : "";
  let summary: string;
  if (r.status === "pass") summary = `${r.cmd.kind} passed`;
  else if (r.status === "not_run") summary = r.note.startsWith("not run") ? `${r.cmd.kind} ${r.note}` : `${r.cmd.kind} not run: ${r.note}`;
  else summary = `${r.cmd.kind} failed: ${r.diagnosis?.detail ?? "non-zero exit"}`;
  if (r.status === "fail" && r.diagnosis?.cause === "registry" && audit.environment.registryEnv.length === 0) summary = `${r.cmd.kind} failed: registry credentials not provided (pass them with --registry-env)`;
  return addEvidence(audit, {
    checkId: map.check,
    condition: map.condition,
    component: r.cmd.component,
    kind: r.cmd.kind,
    contractId: r.cmd.id,
    strength: ex.strength,
    where: ex.where,
    result: r.status,
    command: r.cmd.command,
    cwd: r.cmd.cwd,
    image: ex.image ?? undefined,
    exitCode: r.outcome?.exitCode ?? null,
    timedOut: r.outcome?.timedOut ?? false,
    durationMs: r.outcome?.durationMs,
    outputTail: r.outcome ? tail(redacted) : undefined,
    outputDigest: r.outcome ? sha256(redacted) : undefined,
    summary,
    diagnosis: r.diagnosis ?? undefined,
    blocked: r.blocked,
  });
}

// When the repo's declared image installs the tool this machine lacks, say so: it is the clearest
// sign that the failure is the machine's, not the repo's.
function declaredImageInstalls(copyDir: string, profile: Profile, tool: string): string | null {
  const dockerfile = profile.environmentJson?.build?.dockerfile;
  if (!dockerfile || !/^[\w.+-]+$/.test(tool)) return null;
  const path = join(copyDir, ".cursor", dockerfile);
  return exists(path) && new RegExp(`(^|[^\\w.-])${tool.replace(/[.+]/g, "\\$&")}([^\\w.-]|$)`, "m").test(readText(path)) ? `.cursor/${dockerfile}` : null;
}

export interface ReplayOptions {
  component?: string;
  mutants: boolean;
  instructions: boolean;
  runtime: string;
  image?: string;
  budgetComponentMinutes: number;
  budgetTotalMinutes: number;
  log: (line: string) => void;
}

function lockfileEvidence(audit: Audit, ex: Executor, profile: Profile, copyDir: string, before: Map<string, string>, installCmds: ContractCommand[]): void {
  const pm = profile.packageManager;
  let result: "pass" | "fail" = "pass";
  let summary = "frozen install reproduced the lockfile";
  if (pm === "pip") {
    const req = join(copyDir, "requirements.txt");
    const lines = exists(req) ? readText(req).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("-")) : [];
    const loose = lines.filter((l) => !l.includes("=="));
    if (lines.length === 0 && !exists(join(copyDir, "pyproject.toml"))) {
      result = "fail";
      summary = "no requirements file or lockfile";
    } else if (loose.length > 0) {
      result = "fail";
      summary = `requirements.txt doesn't pin exact versions for ${loose.length} of ${lines.length} packages`;
    }
  } else if (profile.lockfiles.length === 0) {
    result = "fail";
    summary = "no lockfile is committed";
  } else if (installCmds.some((c) => c.source === "readiness" && !/(\bci\b|--frozen|--immutable|--frozen-lockfile)/.test(c.command))) {
    result = "fail";
    summary = "the install isn't frozen";
  } else {
    for (const [f, digest] of before) {
      const now = exists(join(copyDir, f)) ? sha256(readText(join(copyDir, f))) : "";
      if (now !== digest) {
        result = "fail";
        summary = `the install changed ${f}`;
      }
    }
  }
  addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "lockfile", component: "*", strength: ex.strength, where: ex.where, result, summary, image: ex.image ?? undefined });
}

async function plantFaults(audit: Audit, repo: string, tree: string, ex: Executor, rubric: Rubric, testCmd: ContractCommand, budget: Budget, log: (s: string) => void): Promise<void> {
  const comp = audit.profile!.components.find((c) => c.id === testCmd.component)!;
  const sites = chooseSites(repo, tree, comp, audit.seed.value, rubric.mutation.perComponent);
  if (sites.length === 0) {
    addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp.id, strength: ex.strength, where: ex.where, result: "not_run", summary: "no places to plant a fault were found in files the tests import" });
    return;
  }
  const mutants: Mutant[] = [];
  let n = 1;
  for (const site of sites) {
    const id = `mut-${comp.id}-${n++}`;
    if (overBudget(budget, comp.id)) {
      mutants.push({ id, component: comp.id, file: site.file, line: site.line, operator: site.operator, before: redact(site.before), after: redact(site.after), result: "not_run", exitCodes: [] });
      continue;
    }
    const filePath = join(ex.root, site.file);
    const original = readText(filePath);
    writeFileSync(filePath, applySite(original, site));
    const codes: number[] = [];
    let result: Mutant["result"] = "survived";
    try {
      for (let run = 0; run < rubric.mutation.flakeRuns; run++) {
        const out = await ex.exec(testCmd.command, testCmd.cwd, rubric.mutation.runTimeoutSec);
        charge(budget, comp.id, out.durationMs);
        codes.push(out.exitCode ?? -1);
        if (out.timedOut) {
          result = "not_run";
          break;
        }
        if (out.exitCode === 0) {
          result = run === 0 ? "survived" : "discarded";
          break;
        }
        if (diagnose(out.output, false, "test").cause === "compile") {
          result = "discarded";
          break;
        }
        result = "caught";
      }
    } finally {
      writeFileSync(filePath, original);
    }
    mutants.push({ id, component: comp.id, file: site.file, line: site.line, operator: site.operator, before: redact(site.before), after: redact(site.after), result, exitCodes: codes });
  }
  audit.mutants.push(...mutants);
  const counted = mutants.filter((m) => m.result === "caught" || m.result === "survived");
  const caught = counted.filter((m) => m.result === "caught").length;
  const survivedFiles = [...new Set(mutants.filter((m) => m.result === "survived").map((m) => m.file))];
  const operators = [...new Set(mutants.map((m) => m.operator))].join(", ");
  let result: "pass" | "fail" | "not_run";
  let summary: string;
  if (counted.length < rubric.mutation.minForPass) {
    result = "not_run";
    summary = `only ${counted.length} planted faults gave a clear result; at least ${rubric.mutation.minForPass} are needed`;
  } else if (caught === counted.length) {
    result = "pass";
    summary = `caught ${caught} of ${counted.length} planted faults (${operators})`;
  } else {
    result = "fail";
    summary = `caught ${caught} of ${counted.length} planted faults (${operators}); uncaught in ${survivedFiles.join(", ")}`;
  }
  log(`  faults in ${comp.id}: ${summary}`);
  addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp.id, strength: ex.strength, where: ex.where, result, summary, image: ex.image ?? undefined });
}

export function makeExecutor(audit: Audit, copyDir: string, runtimePref: string, log: (s: string) => void, imageOverride?: string): Executor {
  const runtime = detectRuntime(runtimePref);
  let image = imageOverride ?? containerImage(audit.profile!, copyDir);
  const declared = audit.profile?.environmentJson?.build;
  if (runtime && declared && !imageOverride) {
    const dockerfile = join(copyDir, ".cursor", declared.dockerfile);
    const context = join(copyDir, ".cursor", declared.context ?? ".");
    const tag = `readiness-env-${sha256(readText(dockerfile)).slice(0, 12)}`;
    log(`Building the repo's declared environment image from .cursor/${declared.dockerfile}.`);
    const built = buildImage(runtime, context, dockerfile, tag);
    if (!built.ok) fail(`The declared environment image didn't build:\n${tail(built.output, 2000)}`);
    image = tag;
  }
  if (runtime) {
    const session = new ContainerSession(runtime, `readiness-${audit.id}-${randomHex(3)}`, image, copyDir, audit.environment.registryEnv);
    const started = session.start();
    if (started.ok) {
      session.enableCorepack();
      audit.environment.containerRuntime = runtime.bin;
      audit.environment.image = image;
      log(`Replaying in a clean ${runtime.bin} container (${image}).`);
      return containerExecutor(session, copyDir);
    }
    log(`Could not start a container: ${started.output.trim().split("\n").pop()}`);
  }
  audit.environment.containerRuntime = null;
  audit.environment.image = null;
  log("No container runtime: replaying in a fresh copy on the host. Level 1 can't be proved on this machine.");
  return hostExecutor(copyDir, audit.environment.registryEnv, audit.environment.inheritEnv);
}

export async function replay(audit: Audit, repo: string, tree: string, rubric: Rubric, opts: ReplayOptions): Promise<void> {
  if (audit.tier === "read-only") fail("The read-only tier doesn't run repo code. Re-init with --tier local-exec.");
  if (!audit.profile) fail("Run `readiness scan` before `readiness replay`.");
  if (!audit.profile.components.some((c) => c.assessed)) {
    opts.log("Nothing to replay: no component could be assessed. The report says why and gives no level.");
    return;
  }
  const profile = audit.profile;
  const copyDir = join(mkdtempSync(join(tmpdir(), "readiness-replay-")), "work");
  cpSync(tree, copyDir, { recursive: true });
  const before = new Map<string, string>();
  for (const f of profile.lockfiles) before.set(f, sha256(readText(join(copyDir, f))));
  if (opts.image) audit.environment.imageOverride = opts.image;
  const ex = makeExecutor(audit, copyDir, opts.runtime, opts.log, opts.image ?? audit.environment.imageOverride);
  const registryValues = audit.environment.registryEnv.map((k) => process.env[k] ?? "").filter(Boolean);
  const components = new Set(profile.components.filter((c) => c.assessed && (!opts.component || c.id === opts.component)).map((c) => c.id));
  if (opts.component && components.size === 0) fail(`No assessed component named ${opts.component}`);
  const budget = newBudget(opts.budgetComponentMinutes, opts.budgetTotalMinutes);
  try {
    const results = await runContract(ex, audit.contract, {
      components,
      budget,
      registryValues,
      onResult: (r) => opts.log(`  ${r.cmd.kind.padEnd(9)} ${r.cmd.component.padEnd(12)} ${r.status}${r.diagnosis ? ` (${r.diagnosis.detail})` : r.note ? ` (${r.note})` : ""}`),
    });
    for (const r of results) {
      if (r.blocked && r.diagnosis?.cause === "missing_tool") {
        const tool = r.diagnosis.detail.replace(/ is not installed$/, "");
        const declared = declaredImageInstalls(copyDir, profile, tool);
        if (declared) r.blocked += `, though the repo's declared image (${declared}) installs it`;
      }
      const ev = evidenceFromPhase(audit, ex, r, registryValues);
      if (r.diagnosis?.cause === "credential" && !audit.safety.some((s) => s.kind === "credential_needed" && s.detail.includes(r.diagnosis!.detail))) {
        audit.safety.push({ id: `saf-${String(audit.safety.length + 1).padStart(3, "0")}`, kind: "credential_needed", file: ev.id, detail: `tests ${r.diagnosis.detail}`, blocking: true });
      }
    }
    const allInstalls = results.filter((r) => r.cmd.kind === "install");
    // When this machine blocked the shared install, the components' own frozen installs stand in for it.
    const installs = allInstalls.some((r) => r.cmd.fallbackFor) ? allInstalls.filter((r) => r.cmd.fallbackFor || !r.blocked) : allInstalls;
    const installed = installs.length > 0 && installs.every((r) => r.status === "pass");
    if (installed) lockfileEvidence(audit, ex, profile, copyDir, before, installs.map((r) => r.cmd));
    else if (installs.some((r) => r.blocked) && installs.every((r) => r.status === "pass" || r.blocked)) {
      const blocked = installs.find((r) => r.blocked)!.blocked!;
      addEvidence(audit, { checkId: "bootstrap.cold_replay", condition: "lockfile", component: "*", strength: ex.strength, where: ex.where, result: "not_run", summary: "the frozen install couldn't run on this machine", blocked, image: ex.image ?? undefined });
    }
    if (opts.mutants) {
      for (const comp of components) {
        const testRes = results.find((r) => r.cmd.kind === "test" && r.cmd.component === comp);
        if (!testRes || testRes.status !== "pass") {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: testRes ? "tests must pass before faults can be planted" : "no test command found" });
          continue;
        }
        const second = await ex.exec(testRes.cmd.command, testRes.cmd.cwd, testRes.cmd.timeoutSec);
        if (second.exitCode !== 0) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: "tests passed once and failed on a second run, so faults weren't planted (possible flaky tests)" });
          continue;
        }
        const lang = profile.components.find((c) => c.id === comp)!.language;
        if (!rubric.mutation.languages.includes(lang)) {
          addEvidence(audit, { checkId: "verify.behavioral_oracle", condition: "faults", component: comp, strength: ex.strength, where: ex.where, result: "not_run", summary: `faults can't be planted in ${lang} yet` });
          continue;
        }
        await plantFaults(audit, repo, tree, ex, rubric, testRes.cmd, budget, opts.log);
      }
    }
    if (opts.instructions) {
      for (const item of audit.instructions.filter((i) => i.category === "replay" && i.staticResult === "pass")) {
        if (!installed) {
          const blocked = installs.find((r) => r.blocked)?.blocked;
          item.result = "not_run";
          item.reason = blocked ? "not replayed because the install was blocked on this machine" : "not replayed because the install failed";
          item.blocked = blocked;
          continue;
        }
        const cwd = dirname(item.source) === "" ? "." : dirname(item.source);
        const out = await ex.exec(item.text, exists(join(copyDir, cwd)) ? cwd : ".", 300);
        const ok = out.exitCode === 0 && !out.timedOut;
        const redacted = redact(out.output, registryValues);
        const why = ok ? null : diagnose(out.output, out.timedOut, "instruction");
        if (why?.cause === "missing_tool" && ex.where !== "container") {
          item.result = "not_run";
          item.reason = `not replayed: ${why.detail} on this machine, an environment limit rather than a repo defect`;
          item.blocked = `${why.detail} on this machine`;
          continue;
        }
        if (why && (why.cause === "credential" || why.cause === "network" || why.cause === "service" || why.cause === "registry")) {
          item.category = "needs_access";
          item.result = "not_run";
          item.reason = `not replayed: it ${why.cause === "network" ? "needs the network" : why.detail}, which the replay doesn't provide`;
          continue;
        }
        const ev = addEvidence(audit, {
          checkId: "context.instructions_verified",
          condition: "instructions",
          strength: ex.strength,
          where: ex.where,
          result: ok ? "pass" : "fail",
          command: item.text,
          cwd,
          image: ex.image ?? undefined,
          exitCode: out.exitCode,
          timedOut: out.timedOut,
          durationMs: out.durationMs,
          outputTail: tail(redacted, 1500),
          outputDigest: sha256(redacted),
          summary: `${item.source}:${item.line} \`${item.text}\` ${ok ? "replays" : "fails: " + diagnose(out.output, out.timedOut, "instruction").detail}`,
        });
        item.result = ok ? "pass" : "fail";
        item.reason = ok ? undefined : diagnose(out.output, out.timedOut, "instruction").detail;
        item.evidenceId = ev.id;
      }
    }
  } finally {
    ex.close();
    rmSync(dirname(copyDir), { recursive: true, force: true });
  }
}

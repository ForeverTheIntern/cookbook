import type { Rubric } from "./rubric.ts";
import { strengthRank } from "./rubric.ts";
import type { Audit, CondId, CondState, Evidence } from "./types.ts";

export interface CondDetail {
  state: CondState;
  reason: string;
  evidence: string[];
}

export type CompStates = Record<CondId, CondDetail>;

const COMPONENT_CONDS: CondId[] = ["clean.install", "clean.build", "clean.test", "commands", "faults"];
const REPO_CONDS: CondId[] = ["instructions", "safety", "toolchain", "lockfile"];

function latest(evs: Evidence[]): Evidence | undefined {
  return evs[evs.length - 1];
}

function needsContainer(rubric: Rubric, check: string): boolean {
  const c = rubric.checks.find((x) => x.id === check);
  return c?.minStrengthForPass === "clean_replay";
}

// A host fallback runs on whatever this machine has installed. A missing tool there is an
// environment limit: only a clean container from the repo's own setup can show a repo defect.
export function hostToolMissing(ev: Evidence): boolean {
  return ev.result === "fail" && ev.where !== "container" && ev.where !== "static" && ev.diagnosis?.cause === "missing_tool";
}

export function blockedBy(ev: Evidence): string | null {
  if (ev.blocked) return ev.blocked;
  return hostToolMissing(ev) ? `${ev.diagnosis!.detail} on this machine` : null;
}

// No real results, no level: a level needs at least one Level 1 check that ran and passed, or failed
// for a reason in the repo. Returns why there is none, or null when there is one.
export function noRealResults(audit: Audit, states: Map<string, CompStates>): string | null {
  const assessed = audit.profile?.components.filter((c) => c.assessed) ?? [];
  if (assessed.length === 0) return "no component could be assessed";
  const ids = new Set(assessed.map((c) => c.id));
  const ran = audit.evidence.some((e) => (e.kind === "install" || e.kind === "build" || e.kind === "test") && (e.component === "*" || ids.has(e.component ?? "")) && (e.result === "pass" || (e.result === "fail" && !blockedBy(e))));
  const noTests = assessed.some((c) => states.get(c.id)?.["clean.test"].state === "not_met");
  if (ran || noTests) return null;
  if (audit.tier === "read-only") return "the read-only tier runs no repo code";
  const causes = [...new Set(audit.evidence.map(blockedBy).filter((b): b is string => Boolean(b) && b !== "the install was blocked on this machine"))];
  if (causes.length) return `nothing could run on this machine: ${causes.join(" and ")}`;
  return "no check produced a result";
}

function fromEvidence(rubric: Rubric, ev: Evidence | undefined, check: string, missingReason: string): CondDetail {
  if (!ev) return { state: "unknown", reason: missingReason, evidence: [] };
  const blocked = blockedBy(ev);
  if (blocked) return { state: "blocked", reason: `${blocked}, an environment limit rather than a repo defect; Level 1 needs a clean container`, evidence: [ev.id] };
  if (ev.result === "fail") return { state: "not_met", reason: ev.summary, evidence: [ev.id] };
  if (ev.result === "not_run") return { state: "unknown", reason: ev.summary, evidence: [ev.id] };
  const min = rubric.checks.find((c) => c.id === check)?.minStrengthForPass ?? "executed";
  if (strengthRank(rubric, ev.strength) < strengthRank(rubric, min)) {
    if (needsContainer(rubric, check)) return { state: "blocked", reason: "passed on the host, but Level 1 needs a clean container: no container runtime on this machine", evidence: [ev.id] };
    return { state: "unknown", reason: `passed, but only ${rubric.strengthLabels[ev.strength]}`, evidence: [ev.id] };
  }
  return { state: "met", reason: ev.summary, evidence: [ev.id] };
}

export function componentStates(audit: Audit, rubric: Rubric, componentId: string): CompStates {
  const evs = audit.evidence;
  const contract = audit.contract;
  const states = {} as CompStates;
  const repoInstall = latest(evs.filter((e) => e.kind === "install" && (e.component === "*" || !e.component)));
  const ownInstall = latest(evs.filter((e) => e.kind === "install" && e.component === componentId));
  const install = ownInstall && !(repoInstall && repoInstall.result !== "pass") ? ownInstall : (repoInstall ?? ownInstall);
  states["clean.install"] = fromEvidence(rubric, install, "bootstrap.cold_replay", "the clean install hasn't run");
  const hasBuild = contract.some((c) => c.component === componentId && c.kind === "build");
  if (!hasBuild) {
    states["clean.build"] = { state: states["clean.install"].state, reason: "no build step; follows the install", evidence: states["clean.install"].evidence };
  } else {
    const build = latest(evs.filter((e) => e.kind === "build" && e.component === componentId && (e.where === "container" || e.where === "fresh_copy")));
    states["clean.build"] = fromEvidence(rubric, build, "bootstrap.cold_replay", "the clean build hasn't run");
  }
  const hasTest = contract.some((c) => c.component === componentId && c.kind === "test");
  if (!hasTest) {
    states["clean.test"] = { state: "not_met", reason: "no test command was found", evidence: [] };
  } else {
    const test = latest(evs.filter((e) => e.kind === "test" && e.component === componentId && (e.where === "container" || e.where === "fresh_copy")));
    states["clean.test"] = fromEvidence(rubric, test, "bootstrap.cold_replay", "the clean test run hasn't run");
  }
  const cmdKinds = ["build", "lint", "typecheck", "test"] as const;
  const discovered = contract.filter((c) => c.component === componentId && (cmdKinds as readonly string[]).includes(c.kind));
  if (!discovered.some((c) => c.kind === "test")) {
    states.commands = { state: "not_met", reason: "no test command was found", evidence: [] };
  } else {
    const parts = discovered.map((c) => fromEvidence(rubric, latest(evs.filter((e) => e.contractId === c.id)), "verify.canonical_interface", `${c.kind} hasn't run`));
    const failed = parts.filter((p) => p.state === "not_met");
    const unknown = parts.filter((p) => p.state === "unknown");
    const blocked = parts.filter((p) => p.state === "blocked");
    const ids = parts.flatMap((p) => p.evidence);
    if (failed.length > 0) states.commands = { state: "not_met", reason: failed.map((p) => p.reason).join("; "), evidence: ids };
    else if (blocked.length > 0 && unknown.length === 0) states.commands = { state: "blocked", reason: blocked[0].reason, evidence: ids };
    else if (unknown.length > 0 || blocked.length > 0) states.commands = { state: "unknown", reason: [...unknown, ...blocked].map((p) => p.reason).join("; "), evidence: ids };
    else states.commands = { state: "met", reason: `${discovered.length} commands pass`, evidence: ids };
  }
  const faults = latest(evs.filter((e) => e.condition === "faults" && e.component === componentId));
  states.faults = fromEvidence(rubric, faults, "verify.behavioral_oracle", "faults haven't been planted");
  if (states.faults.state === "unknown" && states["clean.test"].state === "blocked" && !faults?.skipped) {
    states.faults = { state: "blocked", reason: "not checked: the clean test run was blocked on this machine", evidence: states.faults.evidence };
  }
  const repo = repoStates(audit, rubric);
  states.instructions = repo.instructions;
  states.safety = repo.safety;
  states.toolchain = repo.toolchain;
  states.lockfile = repo.lockfile;
  return states;
}

export function repoStates(audit: Audit, rubric: Rubric): Record<"instructions" | "safety" | "toolchain" | "lockfile", CondDetail> {
  const items = audit.instructions;
  const failed = items.filter((i) => i.result === "fail");
  const pending = items.filter((i) => i.result === "not_run" && i.category === "replay");
  const insEvidence = items.map((i) => i.evidenceId).filter((x): x is string => Boolean(x));
  const instructions: CondDetail =
    failed.length > 0
      ? { state: "not_met", reason: `${failed.length} of ${items.length} instruction items are wrong`, evidence: insEvidence }
      : pending.length > 0 && pending.every((i) => i.blocked)
        ? { state: "blocked", reason: `${pending.length} instruction commands couldn't be replayed: ${pending[0].blocked}`, evidence: insEvidence }
        : pending.length > 0
          ? { state: "unknown", reason: `${pending.length} instruction commands haven't been replayed`, evidence: insEvidence }
          : { state: "met", reason: items.length ? `${items.length} instruction items check out` : "no agent instructions to check", evidence: insEvidence };
  const blocking = audit.safety.filter((s) => s.blocking);
  const safety: CondDetail = blocking.length > 0 ? { state: "not_met", reason: blocking.map((b) => b.detail).join("; "), evidence: [] } : { state: "met", reason: "no blocking safety findings", evidence: [] };
  const tc = audit.profile?.toolchain;
  const toolchain: CondDetail = !tc ? { state: "unknown", reason: "not scanned", evidence: [] } : tc.pinned ? { state: "met", reason: `pinned in ${tc.files.join(", ")}`, evidence: [] } : { state: "not_met", reason: `missing ${tc.missing.join(" and ")}`, evidence: [] };
  const lockfile = fromEvidence(rubric, latest(audit.evidence.filter((e) => e.condition === "lockfile")), "bootstrap.cold_replay", "the frozen install hasn't run");
  return { instructions, safety, toolchain, lockfile };
}

export interface CheckCounts {
  passed: number;
  failed: number;
  notRun: number;
}

export function checkCounts(audit: Audit, checkId: string): CheckCounts {
  if (checkId === "context.instructions_verified") {
    const items = audit.instructions;
    return { passed: items.filter((i) => i.result === "pass").length, failed: items.filter((i) => i.result === "fail").length, notRun: items.filter((i) => i.result === "not_run").length };
  }
  if (checkId === "safety.execution_boundary") {
    const blocking = audit.safety.filter((s) => s.blocking).length;
    return { passed: blocking === 0 ? 1 : 0, failed: blocking, notRun: 0 };
  }
  const latestByKey = new Map<string, Evidence>();
  for (const e of audit.evidence.filter((x) => x.checkId === checkId)) latestByKey.set(`${e.contractId ?? e.condition ?? e.id}:${e.component ?? ""}`, e);
  const evs = [...latestByKey.values()];
  return { passed: evs.filter((e) => e.result === "pass").length, failed: evs.filter((e) => e.result === "fail").length, notRun: evs.filter((e) => e.result === "not_run").length };
}

export const ALL_COMPONENT_CONDS = COMPONENT_CONDS;
export const ALL_REPO_CONDS = REPO_CONDS;

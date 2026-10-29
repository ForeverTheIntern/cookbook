import type { Rubric } from "./rubric.ts";
import type { CompStates } from "./score.ts";
import type { CondId, CondState, Component, HistoryLine, Level, OutcomeStats, ScenarioId, ScenarioSpec, Targets } from "./types.ts";

export interface LevelResult {
  level: Level;
  couldBe: Level | null;
  missing: CondId[];
  unknown: CondId[];
}

type StateMap = Partial<Record<CondId, CondState>>;

export function statesOf(detail: CompStates): StateMap {
  const out: StateMap = {};
  for (const [k, v] of Object.entries(detail)) out[k as CondId] = v.state;
  return out;
}

function evaluate(conds: CondId[], states: StateMap): { met: boolean; missing: CondId[]; unknown: CondId[] } {
  const missing = conds.filter((c) => states[c] === "not_met");
  const unknown = conds.filter((c) => (states[c] ?? "unknown") === "unknown" || states[c] === "blocked");
  return { met: missing.length === 0 && unknown.length === 0, missing, unknown };
}

// The standard level by default; a scenario swaps in its own Level 2 bar.
export function componentLevel(rubric: Rubric, states: StateMap, scenarioId?: ScenarioId): LevelResult {
  const level2 = scenarioId ? rubric.scenarios.find((a) => a.id === scenarioId)!.level2 : rubric.level2;
  const l1 = evaluate(rubric.level1, states);
  if (!l1.met) return { level: 0, couldBe: l1.missing.length === 0 ? 1 : null, missing: l1.missing, unknown: l1.unknown };
  const l2 = evaluate(level2, states);
  if (!l2.met) return { level: 1, couldBe: l2.missing.length === 0 ? 2 : null, missing: l2.missing, unknown: l2.unknown };
  return { level: 2, couldBe: null, missing: [], unknown: [] };
}

// Which scenarios apply to a component, in rubric order.
export function scenariosFor(rubric: Rubric, specs: ScenarioSpec[], componentId: string): ScenarioId[] {
  const ids = new Set(specs.filter((s) => s.components.includes("*") || s.components.includes(componentId)).map((s) => s.id));
  return rubric.scenarios.filter((s) => ids.has(s.id)).map((s) => s.id);
}

export function activeComponents(rubric: Rubric, components: Component[], previous: HistoryLine[]): Set<string> {
  const threshold = rubric.repoLevel.activeShare;
  const prev = previous.filter((h) => h.kind === "audit");
  const last = prev[prev.length - 1];
  const active = new Set<string>();
  for (const c of components.filter((x) => x.assessed)) {
    const nowAbove = c.changeShare >= threshold;
    if (!last) {
      if (nowAbove) active.add(c.id);
      continue;
    }
    const wasActive = last.active.includes(c.id);
    const lastAbove = (last.shares[c.id] ?? 0) >= threshold;
    if (wasActive) {
      if (!nowAbove && !lastAbove) continue;
      active.add(c.id);
    } else if (nowAbove && lastAbove) active.add(c.id);
  }
  if (active.size === 0) {
    const top = components.filter((x) => x.assessed).sort((a, b) => b.changeShare - a.changeShare)[0];
    if (top) active.add(top.id);
  }
  return active;
}

export function repoLevel(levels: Map<string, LevelResult>, active: Set<string>): { level: Level; couldBe: Level | null; setBy: string[] } {
  const rows = [...levels.entries()].filter(([id]) => active.has(id));
  if (rows.length === 0) return { level: 0, couldBe: null, setBy: [] };
  const min = Math.min(...rows.map(([, l]) => l.level)) as Level;
  const setBy = rows.filter(([, l]) => l.level === min).map(([id]) => id);
  const couldBe = rows.filter(([, l]) => l.level === min).every(([, l]) => l.couldBe !== null) ? ((min + 1) as Level) : null;
  return { level: min, couldBe, setBy };
}

export function partialCoverage(rubric: Rubric, components: Component[]): { partial: boolean; unassessedShare: number } {
  const unassessedShare = components.filter((c) => !c.assessed).reduce((s, c) => s + c.changeShare, 0);
  return { partial: unassessedShare > rubric.repoLevel.partialCoverageShare, unassessedShare };
}

// Levels 3 and 4 are measured per component, on the agent PRs that touch it, against the same
// control group of other PRs.
export interface OutcomeLevelInput {
  level2: boolean;
  targets: Targets | null;
  outcomes: { agent: OutcomeStats; control: OutcomeStats } | null;
  // The agent PRs of the last audit where this component was at Level 3 or above.
  previousAtLevel3: OutcomeStats | null;
}

export function targetsMet(rubric: Rubric, targets: Targets, outcomes: { agent: OutcomeStats; control: OutcomeStats }): { met: boolean; reasons: string[] } {
  const a = outcomes.agent;
  const floor = Math.max(rubric.level3.absoluteMinAgentPRs, targets.minAgentPrs);
  const reasons: string[] = [];
  if (a.opened < floor) reasons.push(`only ${a.opened} agent PRs in the window; at least ${floor} are needed`);
  if (outcomes.control.opened === 0) reasons.push("no other PRs in the window to compare with");
  const merge = a.opened ? a.merged / a.opened : 0;
  const first = a.firstTimeCiKnown ? a.firstTimeCiPass / a.firstTimeCiKnown : 0;
  const cr = a.opened ? a.changesRequested / a.opened : 1;
  if (merge < targets.mergeRate) reasons.push(`merge rate ${Math.round(merge * 100)}% is below the target ${Math.round(targets.mergeRate * 100)}%`);
  if (first < targets.firstPass) reasons.push(`first-time CI pass rate ${Math.round(first * 100)}% is below the target ${Math.round(targets.firstPass * 100)}%`);
  if (cr > targets.maxChangesRequested) reasons.push(`change requests on ${Math.round(cr * 100)}% of agent PRs is above the target ${Math.round(targets.maxChangesRequested * 100)}%`);
  return { met: reasons.length === 0, reasons };
}

export function outcomeLevel(rubric: Rubric, input: OutcomeLevelInput): { level: Level | null; reasons: string[] } {
  if (!input.level2) return { level: null, reasons: [] };
  if (!input.targets) return { level: null, reasons: ["no Level 3 targets are recorded"] };
  if (!input.outcomes) return { level: null, reasons: ["outcomes weren't measured in this audit"] };
  const t = targetsMet(rubric, input.targets, input.outcomes);
  if (!t.met) return { level: null, reasons: t.reasons };
  const prev = input.previousAtLevel3;
  if (prev) {
    const grew = input.outcomes.agent.opened >= rubric.level4.volumeMultiplier * prev.opened;
    const prevCr = prev.opened ? prev.changesRequested / prev.opened : 0;
    const nowCr = input.outcomes.agent.opened ? input.outcomes.agent.changesRequested / input.outcomes.agent.opened : 0;
    if (grew && nowCr <= prevCr) return { level: 4, reasons: [] };
  }
  return { level: 3, reasons: [] };
}

export function previousAtLevel3(history: HistoryLine[], componentId: string): OutcomeStats | null {
  const prev = [...history].reverse().find((h) => h.kind === "audit" && h.outcomes?.byComponent?.[componentId] && (h.levels[componentId] ?? 0) >= 3);
  return prev?.outcomes?.byComponent[componentId] ?? null;
}

export function recheckStates(base: StateMap, failedKinds: Set<string>): StateMap {
  const out: StateMap = { ...base };
  if (failedKinds.has("install")) out["clean.install"] = "not_met";
  if (failedKinds.has("build")) {
    out["clean.build"] = "not_met";
    out.commands = "not_met";
  }
  if (failedKinds.has("test")) {
    out["clean.test"] = "not_met";
    out.commands = "not_met";
  }
  if (failedKinds.has("lint") || failedKinds.has("typecheck")) out.commands = "not_met";
  return out;
}

export function capAt(level: Level, cap: Level): Level {
  return (level > cap ? cap : level) as Level;
}

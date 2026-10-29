import type { LevelResult } from "./levels.ts";
import { describeRate, rate, windowLabel } from "./outcomes.ts";
import { watchFor } from "./roadmap.ts";
import type { Rubric } from "./rubric.ts";
import type { CompStates } from "./score.ts";
import { blockedBy, checkCounts } from "./score.ts";
import type { ActivityId, Asset, Audit, CondId, Component, HistoryLine, Level, OutcomeStats, OutcomesSnapshot, ReportAction, ReportJson, Roadmap, RoadmapItem } from "./types.ts";
import { fmtDate, fmtShortDate, pct, wordCount } from "./util.ts";

export interface RenderInput {
  audit: Audit;
  rubric: Rubric;
  goal: ActivityId;
  components: Component[];
  states: Map<string, CompStates>;
  levels: Map<string, Map<ActivityId, LevelResult>>;
  repoLevels: Map<ActivityId, { level: Level; couldBe: Level | null; setBy: string[] }>;
  goalLevel: { level: Level; couldBe: Level | null; setBy: string[]; outcomeReasons: string[] };
  active: Set<string>;
  roadmap: Roadmap;
  top: RoadmapItem[];
  startNow: RoadmapItem | null;
  history: HistoryLine[];
  currentLine: HistoryLine;
  previousOutcomes: { window: string; agent: OutcomeStats } | null;
  weakening: string | null;
  sealStatus: string;
  staleCopy: string | null;
  storedAt: string;
  partial: { partial: boolean; unassessedShare: number };
  // Why the audit has no real check results to give a level from, or null when it has some.
  noResults?: string | null;
}

const STATUS_TEXT: Record<RoadmapItem["status"], string> = { done: "done", in_progress: "in progress", next: "next", start_now: "can start now", waiting: "waiting", later: "later" };

function goalLabel(rubric: Rubric, goal: ActivityId): string {
  return rubric.activities.find((a) => a.id === goal)!.label.replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase());
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function condLabel(rubric: Rubric, c: CondId): string {
  return rubric.conditions[c].label;
}

// The rubric's labels name every command kind; say only what these components' contracts run.
function condPhrase(input: RenderInput, c: CondId, comps: string[]): string | null {
  const has = (kind: string) => input.audit.contract.some((k) => k.kind === kind && comps.includes(k.component));
  if (c === "clean.build" && !has("build")) return null;
  if (c === "commands") {
    const kinds = ["build", "lint", "typecheck", "test"].filter(has);
    if (kinds.length > 0 && kinds.length < 4) return `${list(kinds.map((k) => (k === "typecheck" ? "type-check" : k)))} commands pass`;
  }
  return condLabel(input.rubric, c);
}

function statusText(item: RoadmapItem, roadmap: Roadmap): string {
  if (item.status === "done") return item.closedAt ? `done ${fmtShortDate(item.closedAt)}` : "done";
  if (item.status === "waiting") {
    const orders = item.dependsOn.map((d) => roadmap.items.find((i) => i.id === d)?.order).filter((x): x is number => typeof x === "number");
    return orders.length ? `waiting on step ${list(orders.map(String))}` : "waiting";
  }
  return STATUS_TEXT[item.status];
}

function researchFor(rubric: Rubric, item: RoadmapItem): string | null {
  const cond = item.fixes[0]?.condition;
  if (!cond) return null;
  const checkId = rubric.templates[item.template]?.researchCheck ?? rubric.conditions[cond].check;
  const check = rubric.checks.find((c) => c.id === checkId);
  const src = check?.sources[0];
  return src ? `${src.claim} ${src.caveat} ${src.url}` : null;
}

function metricLabel(metric: string, scope = "repo"): string {
  const [m, pattern] = metric.split(":");
  const prs = scope === "repo" ? "agent PRs" : `agent PRs touching ${scope}`;
  if (m === "first_time_ci_pass") return `Share of ${prs} that pass CI the first time`;
  if (m === "changes_requested") return `Share of ${prs} where a reviewer requested changes`;
  if (m === "prs_adding_path") return `${prs.charAt(0).toUpperCase() + prs.slice(1)} that add a stray ${pattern}`;
  return `Merged ${prs}`;
}

function watchLine(item: RoadmapItem, rubric: Rubric, outcomes: OutcomesSnapshot | null): string {
  const w = item.expected.watch;
  const label = metricLabel(w.metric, w.scope);
  const [metric, pattern] = w.metric.split(":");
  const now = outcomes ? watchFor(metric, w.scope, outcomes, rubric, pattern) : null;
  const baseline = `${w.baseline}${w.window ? `, ${w.window}` : ""}`;
  if (!now || (now.window === w.window && now.baseline === w.baseline)) return `${label}. Now: ${baseline}.`;
  return `${label}. Baseline: ${baseline}. Now: ${now.baseline}, ${now.window}.`;
}

function action(item: RoadmapItem, rank: number, rubric: Rubric, roadmap: Roadmap, startNow: boolean, outcomes: OutcomesSnapshot | null): ReportAction {
  return {
    rank,
    itemId: item.id,
    title: item.title,
    startNow,
    why: item.why,
    movesTheNeedle:
      item.kind === "fix"
        ? `${item.impact > 0 ? `Takes ${item.unlocks}, covering ${pct(item.impact, 1)}% of recent changes` : `Changes no level on its own: ${item.unlocks}`}. ${item.expected.outcome}`
        : `Unlocks ${item.unlocks}. ${item.expected.outcome}`,
    watch: watchLine(item, rubric, outcomes),
    research: researchFor(rubric, item),
    effortAndOwner: `${item.size}. ${item.ownerRole}.`,
    decision: item.decision,
    doneWhen: item.doneWhen,
    dependsOn: item.dependsOn.map((d) => roadmap.items.find((i) => i.id === d)?.title ?? d),
    impact: item.impact,
    effort: item.effort,
  };
}

function compLevel(input: RenderInput, id: string, act: ActivityId): LevelResult | undefined {
  return input.levels.get(id)?.get(act);
}

// With nothing assessed, every level rule is vacuously met and every count is 0 of 0.
function noneAssessed(input: RenderInput): boolean {
  return !input.components.some((c) => c.assessed);
}

// No real results, no level: the report says why and plans nothing.
function notAssessed(input: RenderInput): boolean {
  return noneAssessed(input) || Boolean(input.noResults);
}

function nextConds(input: RenderInput): CondId[] {
  const L = input.goalLevel.level;
  return L === 0 ? input.rubric.level1 : L === 1 ? input.rubric.activities.find((a) => a.id === input.goal)!.level2 : [];
}

function capComps(input: RenderInput): string[] {
  return input.goalLevel.setBy.length ? input.goalLevel.setBy : [...input.active];
}

function outcomeOf(input: RenderInput): ReportJson["maturity"]["outcome"] {
  if (notAssessed(input)) return "not_assessed";
  const blocked = capComps(input).some((id) => nextConds(input).some((c) => input.states.get(id)?.[c].state === "blocked"));
  return blocked ? "blocked" : "proven";
}

// Each condition that holds the level where it is, by name, so nobody has to infer what stopped it.
function capReasons(input: RenderInput): ReportJson["maturity"]["capReasons"] {
  if (notAssessed(input)) return [];
  const { rubric, goalLevel } = input;
  if (goalLevel.level >= 2) return goalLevel.level < 4 ? goalLevel.outcomeReasons.map((r) => ({ component: "*", condition: "outcomes", label: "agent PRs meet the team's targets", state: "not_met" as const, reason: r })) : [];
  const out: ReportJson["maturity"]["capReasons"] = [];
  for (const id of capComps(input)) {
    for (const c of nextConds(input)) {
      const s = input.states.get(id)?.[c];
      if (!s || s.state === "met") continue;
      const component = rubric.conditions[c].scope === "repo" ? "*" : id;
      if (out.some((x) => x.component === component && x.condition === c)) continue;
      out.push({ component, condition: c, label: condLabel(rubric, c), state: s.state, reason: s.reason });
    }
  }
  return out;
}

function confidenceOf(input: RenderInput, outcome: ReportJson["maturity"]["outcome"]): ReportJson["maturity"]["confidence"] {
  const { audit } = input;
  const low: string[] = [];
  const medium: string[] = [];
  if (outcome === "not_assessed") low.push(noneAssessed(input) ? "no component could be assessed" : input.noResults!);
  if (outcome === "blocked") low.push(`a check that decides Level ${input.goalLevel.level + 1} was blocked on this machine`);
  if (outcome !== "not_assessed" && audit.tier === "read-only") low.push("the read-only tier runs no repo code");
  if (outcome === "proven" && audit.tier !== "read-only" && !audit.environment.containerRuntime) low.push("setup ran in a fresh copy on the host, not in a clean container");
  if (input.partial.partial) medium.push(`${pct(input.partial.unassessedShare, 1)}% of recent changes aren't assessed`);
  const sampled = input.components.filter((c) => c.notAssessedReason?.startsWith("outside the "));
  if (sampled.length) medium.push(`${sampled.length} supported ${sampled.length === 1 ? "component was" : "components were"} left out to keep the audit short`);
  if (outcome === "proven" && input.goalLevel.couldBe !== null) medium.push("a check that decides the next level couldn't run");
  const level = low.length ? "low" : medium.length ? "medium" : "high";
  return { level, reasons: [...low, ...medium].length ? [...low, ...medium] : ["every check that decides the level ran"] };
}

function blockedCauses(input: RenderInput): string[] {
  return [...new Set(input.audit.evidence.map(blockedBy).filter((b): b is string => Boolean(b) && b !== "the install was blocked on this machine").map((b) => b.replace(/, though the repo's declared image .*$/, "")))];
}

function whyNoneAssessed(input: RenderInput): string[] {
  const skipped = input.components.filter((c) => !c.assessed).sort((a, b) => b.changeShare - a.changeShare);
  if (skipped.length === 0) return ["the audit found no package it supports"];
  const detailed = list(skipped.map((c) => `${c.id} (${pct(c.changeShare, 1)}% of changes) because ${c.notAssessedReason ?? "it isn't supported"}`));
  return [detailed, `${skipped.length} ${skipped.length === 1 ? "component uses a toolchain" : "components use toolchains"} this rubric doesn't support`];
}

function headlineFor(input: RenderInput, ready: string[], setByShare: number): string {
  const { goalLevel, rubric, goal } = input;
  const top = input.top;
  const label = goalLabel(rubric, goal);
  const active = [...input.active];
  if (noneAssessed(input)) {
    const fit = (...c: string[]) => c.find((x) => wordCount(x) <= rubric.part1.maxHeadlineWords) ?? c[c.length - 1];
    return fit(...whyNoneAssessed(input).map((why) => `No component could be assessed for ${label}, so this audit can't give a level yet: it skipped ${why}.`), `No component could be assessed for ${label}, so this audit can't give a level yet.`);
  }
  const fitHeadline = (...c: string[]) => c.find((x) => wordCount(x) <= rubric.part1.maxHeadlineWords) ?? c[c.length - 1];
  if (input.noResults) {
    if (input.audit.tier === "read-only") return `This read-only audit ran no repo code, so it gives no level for ${label} yet. A local-exec audit can give one.`;
    const causes = blockedCauses(input);
    const rerun = "A rerun where Docker or Podman is available, such as CI, can give one.";
    return fitHeadline(
      ...(causes.length ? [`Nothing could be checked for ${label} on this machine, so this audit gives no level: ${list(causes)}. ${rerun}`] : []),
      `Nothing could be checked for ${label} on this machine, so this audit gives no level. ${rerun}`,
    );
  }
  if (unproven(input)) {
    const where = active.length <= 3 ? list(active) : `all ${active.length} active components`;
    const readOnly = input.audit.tier === "read-only";
    const causes = blockedCauses(input);
    const why = readOnly ? "the read-only tier runs no repo code" : !input.audit.environment.containerRuntime ? list(["this machine has no container runtime", ...causes]) : causes.length ? list(causes) : "a check that decides it couldn't run here";
    const rerun = readOnly ? "A local-exec audit" : "A rerun where Docker or Podman is available, such as CI,";
    return fitHeadline(`Level ${goalLevel.level + 1} couldn't be proved for ${where} because ${why}. ${rerun} can prove it.`, `Level ${goalLevel.level + 1} couldn't be proved for ${where} on this machine. ${rerun} can prove it.`);
  }
  if (top.length === 0 || top.every((t) => t.kind !== "fix")) {
    if (goalLevel.level >= 3) return `Agent PRs meet your Level 3 targets for ${label}. Keep the weekly recheck running and widen the work agents take.`;
    const one = active.length === 1;
    const where = active.length <= 3 ? list(active) : `all ${active.length} active components`;
    const faults = rubric.activities.find((a) => a.id === goal)?.level2.includes("faults") ? `, and ${one ? "its" : "their"} tests caught the planted bugs` : "";
    return `Nothing blocks ${label} in ${where}: from a clean checkout ${one ? "it installs, builds and passes its" : "they install, build and pass their"} tests${faults}. Start delegating ${label} to agents.`;
  }
  if (goalLevel.setBy.length === 0) {
    const repoConds = (["toolchain", "lockfile", "instructions", "safety"] as CondId[]).filter((c) => [...input.states.values()][0]?.[c].state === "not_met");
    const what = repoConds.length ? list(repoConds.map((c) => condLabel(rubric, c).replace(/^a /, "").replace(/versions are pinned/, "versions aren't pinned").replace(/reproduces the lockfile/, "doesn't reproduce the lockfile"))) : "a repo-wide check fails";
    const who = active.length === 1 ? `${active[0]} builds and passes its tests` : active.length <= 3 ? `${list(active)} build and pass their tests` : "Every component builds and passes its tests";
    return goalLevel.level === 0 ? `Agents can't pass the tests from a clean checkout, so ${label} can't start yet.` : `${who}, but ${label} aren't reproducible yet: ${what}.`;
  }
  const names = list(goalLevel.setBy);
  const share = active.length > 1 ? `, and ${pct(setByShare, 1)}% of recent changes land there` : "";
  const readyLine = ready.length ? ` ${list(ready)} ${ready.length > 1 ? "are" : "is"} already ready for ${label}.` : "";
  const many = goalLevel.setBy.length > 1;
  const their = many ? "their" : "its";
  const fit = (...candidates: string[]) => candidates.find((c) => wordCount(c) <= rubric.part1.maxHeadlineWords) ?? candidates[candidates.length - 1];
  if (goalLevel.level === 0) {
    const blockers = new Set(top.filter((t) => t.kind === "fix" && t.fixes.some((f) => goalLevel.setBy.includes(f.component) || f.component === "*")).map((t) => t.template));
    if (blockers.has("clean.install")) {
      const why = because(input, "clean.install", their);
      return fit(`${names} ${many ? "don't" : "doesn't"} install from a clean checkout${why}, so agents can't build or test ${many ? "them" : "it"} yet.${readyLine}`, `${names} ${many ? "don't" : "doesn't"} install from a clean checkout, so agents can't build or test ${many ? "them" : "it"} yet.${readyLine}`);
    }
    if (blockers.has("clean.test:missing")) return `${names} ${many ? "have" : "has"} no tests, so agents can't check their own changes${share}.${readyLine}`;
    if (blockers.has("clean.build")) return fit(`${names} ${many ? "don't" : "doesn't"} build from a clean checkout${because(input, "clean.build", their)}${share}.${readyLine}`, `${names} ${many ? "don't" : "doesn't"} build from a clean checkout${share}.${readyLine}`);
    return fit(`Agents can't pass the tests in ${names} from a clean checkout${because(input, "clean.test", their)}${share}.${readyLine}`, `Agents can't pass the tests in ${names} from a clean checkout${share}.${readyLine}`);
  }
  const failingKinds = [...new Set(input.audit.contract.filter((c) => goalLevel.setBy.includes(c.component) && ["build", "lint", "typecheck", "test"].includes(c.kind) && [...input.audit.evidence].reverse().find((e) => e.contractId === c.id)?.result === "fail").map((c) => (c.kind === "typecheck" ? "type-check" : c.kind)))];
  const why: Partial<Record<CondId, string>> = {
    commands: failingKinds.length ? `${their} ${list(failingKinds)} ${failingKinds.length > 1 ? "commands fail" : "command fails"}` : `${their} checks don't all pass`,
    faults: `${their} tests can't yet catch wrong ${label}`,
    instructions: `${their} agent instructions don't match the repo`,
    safety: "normal work needs production access",
  };
  const level2 = rubric.activities.find((a) => a.id === goal)?.level2 ?? [];
  const failing = level2.filter((c) => why[c] && goalLevel.setBy.some((id) => input.states.get(id)?.[c].state !== "met")).map((c) => why[c]!);
  return `Agents can build and test ${names}, but ${failing.length ? list(failing) : `${their} checks can't yet catch wrong ${label}`}${share}.${readyLine}`;
}

// Below Level 2 with no fix to offer means a deciding check couldn't run, not that nothing blocks.
function unproven(input: RenderInput): boolean {
  return input.goalLevel.level < 2 && input.top.every((t) => t.kind !== "fix");
}

function because(input: RenderInput, cond: CondId, their: string): string {
  const fails = input.audit.evidence.filter((e) => e.condition === cond && e.result === "fail" && e.diagnosis);
  const d = (fails.filter((e) => input.goalLevel.setBy.includes(e.component ?? "")).at(-1) ?? fails.at(-1))?.diagnosis;
  if (!d) return "";
  if (d.cause === "service") return ` because ${their} tests need ${d.service ?? "a service"} running, which the setup doesn't start`;
  if (d.cause === "registry") return " because private registry credentials weren't provided";
  if (d.cause === "credential") return ` because it ${d.detail}`;
  if (d.cause === "unknown") return "";
  return ` because ${d.detail}`;
}

function gapText(item: RoadmapItem): string {
  return item.title.replace(/`/g, "");
}

function blocksText(item: RoadmapItem): string {
  if (item.kind !== "fix") return item.template === "targets" ? "Needs a decision" : "Can start now";
  const m = item.unlocks.match(/^(.+?) to Level (\d)/);
  if (m) return `Blocks Level ${m[2]} for ${m[1].split(",")[0]}`;
  return "Blocks the next level";
}

function stats3(input: RenderInput): ReportJson["executive"]["numbers"] {
  const { rubric, goal, audit } = input;
  const label = goalLabel(rubric, goal);
  const act: ActivityId = goal === "repo_wide" ? "bug_fixes" : goal;
  const activeIds = [...input.active];
  // Repo-wide changes are judged for the whole repo, so no component is ready while the repo isn't.
  const ready = goal === "repo_wide" ? (input.goalLevel.level >= 2 ? activeIds.length : 0) : activeIds.filter((id) => (compLevel(input, id, act)?.level ?? 0) >= 2).length;
  const nextLevel = Math.min(4, input.goalLevel.level + 1);
  const below = input.components.filter((c) => c.assessed && input.active.has(c.id) && (goal === "repo_wide" ? input.goalLevel.level : compLevel(input, c.id, goal)?.level ?? 0) < nextLevel).reduce((s, c) => s + c.changeShare, 0);
  const prev = [...input.history].reverse().find((h) => h.kind === "audit" && h.goal === goal);
  const days = audit.profile?.historyDays ?? 90;
  let readyComparison = `Level 2 needs ${activeIds.length} of ${activeIds.length}`;
  let belowComparison = `Level ${nextLevel} needs 0%, counting the last ${days} days`;
  if (prev) {
    const prevBelow = prev.active.filter((id) => (goal === "repo_wide" ? prev.repoLevels[goal] ?? 0 : prev.levels[id]?.[goal] ?? 0) < nextLevel).reduce((s, id) => s + (prev.shares[id] ?? 0), 0);
    readyComparison = `Last audit: ${prev.active.filter((id) => (prev.levels[id]?.[act] ?? 0) >= 2).length} of ${prev.active.length}`;
    belowComparison = `Last audit: ${pct(prevBelow, 1)}%, counting the last ${days} days`;
  }
  const o = audit.outcomes;
  const ciValue = o ? describeRate(rate(o.agent.firstTimeCiPass, o.agent.firstTimeCiKnown, rubric, windowLabel(o))) : "not measured";
  const ciComparison = o ? `${describeRate(rate(o.control.firstTimeCiPass, o.control.firstTimeCiKnown, rubric, windowLabel(o)))}, ${windowLabel(o)}` : "";
  const ci = { label: "Agent PRs that pass CI the first time", value: ciValue, comparison: o ? `Other PRs: ${ciComparison}` : "The audit needs read access to pull requests to compare agent PRs with other PRs" };
  if (noneAssessed(input)) {
    const found = input.components.length;
    return [
      { label: `Components ready for ${label}`, value: "none assessed", comparison: `${found} ${found === 1 ? "component" : "components"} found, none of them assessable by this rubric` },
      ci,
      { label: "Recent changes this audit couldn't assess", value: `${pct(input.partial.unassessedShare, 1)}%`, comparison: `counting the last ${days} days; a level needs at least one assessed component` },
    ];
  }
  if (notAssessed(input)) {
    const assessed = input.components.filter((c) => c.assessed);
    const share = assessed.reduce((s, c) => s + c.changeShare, 0);
    return [
      { label: `Components ready for ${label}`, value: "none checked", comparison: `${assessed.length} of ${input.components.length} ${input.components.length === 1 ? "component" : "components"} could be assessed, but no check could run` },
      ci,
      { label: "Recent changes this audit couldn't check", value: `${pct(share + input.partial.unassessedShare, 1)}%`, comparison: `counting the last ${days} days; a level needs at least one real check result` },
    ];
  }
  return [
    { label: `Components ready for ${label}`, value: `${ready} of ${activeIds.length}`, comparison: readyComparison },
    ci,
    { label: `Recent changes in components below Level ${nextLevel}`, value: `${pct(below, 1)}%`, comparison: belowComparison },
  ];
}

function nextLine(input: RenderInput): string {
  const { rubric, goal, goalLevel } = input;
  const L = goalLevel.level;
  if (L >= 4) return "This is the top of the scale. Keep the weekly recheck running.";
  const next = rubric.scale[L + 1];
  if (noneAssessed(input)) return `Next: Level ${L + 1}, ${next.plain}, once a component can be assessed. No condition has been checked yet.`;
  if (notAssessed(input)) return `Next: Level ${L + 1}, ${next.plain}, once a check can run. No condition has been checked yet.`;
  if (L >= 2) return `Next: Level ${L + 1}, ${next.plain}. It needs outcome targets your team sets and agent PRs that meet them${goalLevel.outcomeReasons.length ? `: ${goalLevel.outcomeReasons[0]}` : ""}.`;
  const conds = L === 0 ? rubric.level1 : rubric.activities.find((a) => a.id === goal)!.level2;
  const met: string[] = [];
  const unmet: string[] = [];
  const blocked: string[] = [];
  for (const c of conds) {
    const failing = [...input.active].filter((id) => input.states.get(id)?.[c].state !== "met");
    const phrase = condPhrase(input, c, failing.length ? failing : [...input.active]);
    if (phrase === null) continue;
    if (failing.length === 0) {
      met.push(phrase);
      continue;
    }
    const stuck = failing.filter((id) => input.states.get(id)?.[c].state === "blocked");
    const notYet = failing.filter((id) => !stuck.includes(id));
    const name = (ids: string[]) => (rubric.conditions[c].scope === "repo" ? phrase : `${list(ids)} ${phrase}`);
    if (notYet.length) unmet.push(name(notYet));
    if (stuck.length) blocked.push(name(stuck));
  }
  return `Next: Level ${L + 1}, ${next.plain}. ${met.length ? `Met: ${list(met)}. ` : ""}${unmet.length ? `Not yet: ${list(unmet)}.` : ""}${unmet.length && blocked.length ? " " : ""}${blocked.length ? `Blocked on this machine: ${list(blocked)}.` : ""}`.trim();
}

function coverageLine(input: RenderInput): string {
  const { components, audit } = input;
  const assessed = components.filter((c) => c.assessed);
  const skipped = components.filter((c) => !c.assessed);
  const parts = [`The level covers ${assessed.length} ${assessed.length === 1 ? "component" : "components"}`];
  if (skipped.length) parts.push(`and ignores ${list(skipped.map((c) => `${c.id} (${pct(c.changeShare, 1)}% of changes, ${c.notAssessedReason})`))}`);
  let line = parts.join(" ") + ".";
  const low = assessed.filter((c) => !input.active.has(c.id));
  if (low.length) line += ` ${list(low.map((c) => c.id))} ${low.length > 1 ? "get" : "gets"} under 10% of changes, so ${low.length > 1 ? "they don't" : "it doesn't"} set the repo level.`;
  if (input.partial.partial) line += ` Partial coverage: ${pct(input.partial.unassessedShare, 1)}% of changes aren't assessed.`;
  if (audit.tier !== "read-only" && !audit.environment.containerRuntime && audit.evidence.some((e) => e.where === "fresh_copy")) {
    const declared = audit.profile?.environmentJson?.build?.dockerfile;
    const blockedEv = audit.evidence.filter((e) => blockedBy(e) && e.diagnosis?.cause === "missing_tool");
    const missing = [...new Set(blockedEv.map((e) => e.diagnosis!.detail))];
    const inImage = [...new Set(blockedEv.filter((e) => /declared image/.test(e.blocked ?? "")).map((e) => e.diagnosis!.detail.replace(/ is not installed$/, "")))];
    line += ` Level 1 isn't provable on this machine: it has no container runtime, so setup ran in a fresh copy on the host${declared ? ` and the repo's declared environment image (.cursor/${declared}) couldn't be built` : ""}.`;
    if (missing.length) line += ` On this machine ${list(missing)}, an environment limit rather than a repo defect${inImage.length ? `; the declared image installs ${list(inImage)}` : ""}.`;
    if (audit.evidence.some((e) => /uses sudo/.test(e.blocked ?? ""))) line += " Setup commands that use sudo weren't run on this machine.";
  }
  const f = audit.outcomes?.filter;
  line += f ? ` Agent PRs are matched by ${describeFilter(f)}.` : " Agent PRs weren't measured.";
  return line;
}

function describeFilter(f: OutcomesSnapshot["filter"]): string {
  const parts: string[] = [];
  if (f.branchPrefixes.length) parts.push(`head branch starting with ${f.branchPrefixes.join(" or ")}`);
  if (f.labels.length) parts.push(`label ${f.labels.join(" or ")}`);
  if (f.authors.length) parts.push(`author ${f.authors.join(" or ")}`);
  if (f.coAuthorTrailers.length) parts.push(`co-author ${f.coAuthorTrailers.join(" or ")}`);
  return parts.join(", or ") || "no filter";
}

function checkResult(input: RenderInput, checkId: string): { result: string; ok: boolean | null } {
  const { audit, rubric } = input;
  const assessed = input.components.filter((c) => c.assessed);
  const byComp = (conds: CondId[]) => {
    const passed: string[] = [];
    const failed: string[] = [];
    const unproven: string[] = [];
    const blocked: string[] = [];
    for (const c of assessed) {
      const s = input.states.get(c.id)!;
      if (conds.some((k) => s[k].state === "not_met")) failed.push(c.id);
      else if (conds.some((k) => s[k].state === "blocked")) blocked.push(c.id);
      else if (conds.some((k) => s[k].state === "unknown")) unproven.push(c.id);
      else passed.push(c.id);
    }
    const parts: string[] = [];
    if (failed.length) parts.push(`failed: ${list(failed)}`);
    if (passed.length) parts.push(`passed: ${list(passed)}`);
    if (blocked.length) parts.push(`blocked on this machine: ${list(blocked)}`);
    if (unproven.length) parts.push(`not proven: ${list(unproven)}`);
    return { result: parts.join("; "), ok: failed.length ? false : unproven.length || blocked.length ? null : true };
  };
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (checkId === "scope.profile") return { result: `${plural(input.components.length, "component")} found, ${assessed.length} assessed`, ok: null };
  if (checkId === "scope.agent_assets") {
    const authors = new Set(audit.assets.flatMap((a) => a.authors.map((x) => x.name)));
    return { result: `${plural(audit.assets.length, "asset")}, ${plural(authors.size, "author")}`, ok: null };
  }
  if (checkId === "bootstrap.cold_replay") {
    const r = byComp(rubric.level1);
    const repoState = [...input.states.values()][0];
    const extra: string[] = [];
    if (repoState?.toolchain.state === "not_met") extra.push(`toolchain: ${repoState.toolchain.reason}`);
    if (repoState?.lockfile.state === "not_met") extra.push(`lockfile: ${repoState.lockfile.reason}`);
    return { result: [r.result, ...extra].filter(Boolean).join("; "), ok: extra.length ? false : r.ok };
  }
  if (checkId === "verify.canonical_interface") return byComp(["commands"]);
  if (checkId === "verify.behavioral_oracle") {
    const parts = assessed.map((c) => {
      const ev = [...audit.evidence].reverse().find((e) => e.condition === "faults" && e.component === c.id);
      return `${c.id}: ${ev ? ev.summary.replace(/ \(.*$/, "").replace(/; uncaught.*$/, "") : "not run"}`;
    });
    const r = byComp(["faults"]);
    return { result: parts.join("; "), ok: r.ok };
  }
  if (checkId === "context.instructions_verified") {
    const k = checkCounts(audit, checkId);
    const total = k.passed + k.failed + k.notRun;
    return { result: `${k.passed} of ${total} instruction items check out${k.failed ? `, ${k.failed} wrong` : ""}${k.notRun ? `, ${k.notRun} not run` : ""}`, ok: k.failed ? false : audit.instructions.some((i) => i.result === "not_run" && i.category === "replay") ? null : true };
  }
  if (checkId === "safety.execution_boundary") {
    const blocking = audit.safety.filter((s) => s.blocking);
    const listed = audit.safety.filter((s) => !s.blocking);
    return { result: `${blocking.length ? `failed: ${list(blocking.map((b) => b.detail))}` : "passed"}${listed.length ? `; ${listed.length} scripts listed for review` : ""}`, ok: blocking.length === 0 };
  }
  return { result: "", ok: null };
}

export function buildReport(input: RenderInput): ReportJson {
  const { audit, rubric, goal, roadmap, top, startNow } = input;
  const label = goalLabel(rubric, goal);
  const L = input.goalLevel.level;
  const ready = [...input.active].filter((id) => goal !== "repo_wide" && (compLevel(input, id, goal)?.level ?? 0) >= 2 && !input.goalLevel.setBy.includes(id));
  const setByShare = input.components.filter((c) => input.goalLevel.setBy.includes(c.id)).reduce((s, c) => s + c.changeShare, 0);
  const none = notAssessed(input);
  const outcome = outcomeOf(input);
  const noBlocker = !none && !unproven(input) && top.every((t) => t.kind !== "fix");
  const narr = audit.narration ?? {};
  const gaps = top.map((t, i) => ({ rank: i + 1, text: (narr.gaps?.[t.id] ?? gapText(t)).trim().replace(/\.+$/, ""), blocks: blocksText(t), itemId: t.id }));
  const first = top[0];
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const skippedIds = input.components.filter((c) => !c.assessed).map((c) => c.id);
  const defaultAsk = noneAssessed(input)
    ? `Decision needed: which component this audit should cover${skippedIds.length ? `, since it can't assess ${list(skippedIds)}` : ", since it found none it supports"}.`
    : none
    ? audit.tier === "read-only"
      ? "Decision needed: whether to allow a local-exec audit, which runs the repo's commands in a container."
      : "Decision needed: where to rerun this audit so its checks can run, for example a CI job with Docker or Podman."
    : unproven(input)
    ? `Decision needed: where to rerun this audit so it can prove Level ${L + 1}, for example a CI job.`
    : first?.decision
      ? `Decision needed: ${lower(first.decision)}.`
      : noBlocker
        ? `Decision needed: which ${label} go to agents first.`
        : `Approve the agent's fix for "${gapText(first)}".`;
  let ask = (narr.ask ?? defaultAsk).trim();
  if (!/[.!?]$/.test(ask)) ask += ".";
  if (!roadmap.owner && !/\bowner\b/i.test(ask)) ask += " Also name an owner for agent readiness.";
  const actions: ReportAction[] = top.map((t, i) => action(t, i + 1, rubric, roadmap, false, audit.outcomes));
  if (startNow) actions.push(action(startNow, actions.length + 1, rubric, roadmap, true, audit.outcomes));
  const points = actions.map((a, i) => ({ label: `${a.rank}. ${a.title}`, x: Math.min(0.95, rubric.effortX[a.effort] + i * 0.04), y: Math.max(0, Math.min(1, a.impact)), itemId: a.itemId }));
  const o = audit.outcomes;
  const w = o ? windowLabel(o) : "";
  const series = o
    ? [
        { label: "Agent PRs", s: o.agent, w },
        { label: "Other PRs", s: o.control, w },
        ...(input.previousOutcomes ? [{ label: `Agent PRs, ${input.previousOutcomes.window}`, s: input.previousOutcomes.agent, w: input.previousOutcomes.window }] : []),
      ].map((x) => ({
        label: x.label,
        opened: x.s.opened,
        merged: rate(x.s.merged, x.s.opened, rubric, x.w),
        firstTimeCi: rate(x.s.firstTimeCiPass, x.s.firstTimeCiKnown, rubric, x.w),
        changesRequested: rate(x.s.changesRequested, x.s.opened, rubric, x.w),
        medianDaysToMerge: x.s.medianDaysToMerge,
      }))
    : [];
  const prevAudits = input.history.filter((h) => h.kind === "audit");
  const allLines = [...input.history, input.currentLine];
  const progress =
    prevAudits.length > 0
      ? {
          history: allLines.map((h) => ({ date: h.date, kind: h.kind, result: h.result, note: h.note ?? null, levels: Object.fromEntries(Object.entries(h.levels).map(([k, v]) => [k, (v[goal === "repo_wide" ? "bug_fixes" : goal] ?? 0) as Level])), repoLevel: (h.repoLevels[goal] ?? 0) as Level, rubric: h.rubric })),
          closed: roadmap.items
            .filter((i) => i.status === "done" && i.closedAt && i.kind === "fix")
            .map((i) => ({
              title: `${i.order}. ${i.title}`,
              closed: i.closedAt as string,
              expected: `${i.expected.outcome} Watch: ${metricLabel(i.expected.watch.metric, i.expected.watch.scope)}, ${i.expected.watch.baseline}.`,
              observed: i.observed ? `${i.observed.value}${i.observed.sharedWith.length ? ` (shared with ${list(i.observed.sharedWith.map((s) => `step ${roadmap.items.find((x) => x.id === s)?.order ?? s}`))})` : ""}` : "not measurable yet: needs a full outcome window after the fix",
            })),
          weakening: input.weakening,
          rubricChanges: allLines.slice(1).filter((h, i) => h.rubric !== allLines[i].rubric).map((h, i) => ({ date: h.date, from: allLines[i].rubric, to: h.rubric })),
        }
      : null;
  const activities = rubric.activities.map((a) => ({ id: a.id, label: a.label, bar: `Level 2 needs: ${list(a.level2.map((c) => condLabel(rubric, c)))}` }));
  const report: ReportJson = {
    schema: "agent-readiness/report@1",
    repo: audit.repo.name,
    audit: {
      id: audit.id,
      date: audit.createdAt.slice(0, 10),
      commit: audit.repo.commit.slice(0, 7),
      dirtyTree: audit.repo.dirtyTree,
      rubric: audit.rubric,
      tier: audit.tier,
      scriptsDigest: audit.skill.scriptsDigest,
      seedPinned: audit.seed.pinned,
      sealStatus: input.sealStatus,
      staleCopy: input.staleCopy,
      previous: prevAudits.length ? prevAudits[prevAudits.length - 1].id : null,
      storedAt: input.storedAt,
    },
    goal,
    goalLabel: label,
    scale: rubric.scale,
    maturity: {
      level: L,
      couldBe: input.goalLevel.couldBe,
      couldBeReason: input.goalLevel.couldBe !== null ? "a check that would decide it couldn't run here" : null,
      setBy: input.goalLevel.setBy,
      partialCoverage: input.partial.partial,
      assessedComponents: input.components.filter((c) => c.assessed).length,
      outcome,
      confidence: confidenceOf(input, outcome),
      capReasons: capReasons(input),
      next: L < 4 ? { level: (L + 1) as Level, name: rubric.scale[L + 1].name, met: [], unmet: [] } : null,
    },
    executive: {
      heading: noneAssessed(input)
        ? `Not assessed for ${label}: no component could be assessed`
        : none
          ? `Not assessed for ${label}: ${audit.tier === "read-only" ? "the read-only tier runs no repo code" : "no check could run on this machine"}`
          : `Level ${L} of 4, ${rubric.scale[L].plain}, for ${label}${outcome === "blocked" ? `; Level ${L + 1} is blocked on this machine` : ""}`,
      headline: narr.headline ?? headlineFor(input, ready, setByShare),
      numbers: stats3(input),
      nextLine: nextLine(input),
      gaps,
      ask,
      coverage: coverageLine(input),
      noBlocker,
    },
    actions,
    matrix: { quadrants: rubric.matrixQuadrants, points },
    roadmap: {
      owner: roadmap.owner,
      doneCount: roadmap.items.filter((i) => i.status === "done").length,
      total: roadmap.items.length,
      items: roadmap.items.map((i) => ({ id: i.id, order: i.order, title: i.title, status: i.status, statusText: statusText(i, roadmap), unlocks: i.unlocks, decision: i.decision })),
    },
    progress,
    details: {
      scope: scopeOf(input),
      steps: actions.map((a) => ({ itemId: a.itemId, title: a.title, steps: roadmap.items.find((i) => i.id === a.itemId)!.steps })),
      checks: rubric.checks.map((c) => {
        const r = checkResult(input, c.id);
        if (c.id === "verify.canonical_interface") {
          const ids = new Set([...input.states.values()].flatMap((s) => s.commands.evidence));
          const evs = audit.evidence.filter((e) => ids.has(e.id));
          const counts = { passed: evs.filter((e) => e.result === "pass").length, failed: evs.filter((e) => e.result === "fail").length, notRun: evs.filter((e) => e.result === "not_run").length };
          return { id: c.id, name: c.title, why: c.why, sources: c.sources, result: r.result, ok: r.ok, counts, evidence: evs.map((e) => e.id) };
        }
        return { id: c.id, name: c.title, why: c.why, sources: c.sources, result: r.result, ok: r.ok, counts: checkCounts(audit, c.id), evidence: audit.evidence.filter((e) => e.checkId === c.id).map((e) => e.id) };
      }),
      notAssessed: rubric.notAssessed,
      levels: {
        activities,
        components: input.components
          .filter((c) => c.assessed)
          .map((c) => ({
            id: c.id,
            changeShare: c.changeShare,
            active: input.active.has(c.id),
            levels: Object.fromEntries(rubric.activities.filter((a) => a.scope === "component").map((a) => [a.id, compLevel(input, c.id, a.id)?.level ?? 0])),
            couldBe: Object.fromEntries(rubric.activities.filter((a) => a.scope === "component" && compLevel(input, c.id, a.id)?.couldBe !== null).map((a) => [a.id, compLevel(input, c.id, a.id)!.couldBe as Level])),
          })),
        repoLevels: Object.fromEntries([...input.repoLevels.entries()].map(([k, v]) => [k, v.level])),
        repoLevelRule: "the lowest level among components that get at least 10% of changes over 90 days; a component joins or leaves that set only after two audits on the same side of the line",
        unassessed: input.components.filter((c) => !c.assessed).map((c) => ({ id: c.id, changeShare: c.changeShare, reason: c.notAssessedReason ?? "not assessed" })),
      },
      outcomes: o
        ? {
            window: w,
            filter: describeFilter(o.filter),
            source: o.source === "gh" ? "GitHub through gh" : "a recorded PR file",
            series,
            byComponent: input.components
              .filter((c) => c.assessed)
              .map((c) => {
                const s = o.byComponent[c.id];
                return { component: c.id, prs: s?.opened ?? 0, firstTimeCi: rate(s?.firstTimeCiPass ?? 0, s?.firstTimeCiKnown ?? 0, rubric, w), changesRequested: rate(s?.changesRequested ?? 0, s?.opened ?? 0, rubric, w) };
              }),
            multiComponentNote: o.multiComponentPrs ? `${o.multiComponentPrs} agent ${o.multiComponentPrs === 1 ? "PR" : "PRs"} touched more than one component, so the component rows can add up to more than the total.` : "No agent PR touched more than one component.",
            matchedPrs: o.matchedAgentPrs,
            caveat: input.previousOutcomes ? "A trend, not attribution. Model updates or a different mix of tasks could account for part of the change." : "A baseline, not proof that readiness explains these numbers. Model updates and the mix of tasks move them too.",
          }
        : null,
      assets: audit.assets.map((a: Asset) => ({ kind: a.kind, path: a.path, authors: a.authors.map((x) => x.name), lastChanged: a.lastChanged, status: a.status, ok: a.ok })),
      missingAssets: missingList(audit.assets),
      evidence: audit.evidence.map((e) => ({ id: e.id, check: e.checkId, component: e.component && e.component !== "*" ? e.component : null, ran: e.command ?? e.summary, where: rubric.strengthLabels[e.strength], result: blockedBy(e) ? "blocked" : e.result, summary: blockedBy(e) ? `${e.summary}; blocked: ${blockedBy(e)}` : e.summary })),
      record: [
        { label: "Audit", value: audit.id },
        { label: "Commit", value: `${audit.repo.commit.slice(0, 7)}${audit.repo.dirtyTree ? " (uncommitted changes were not audited)" : " (clean tree)"}` },
        { label: "Rubric", value: audit.rubric },
        { label: "Permission tier", value: audit.tier },
        { label: "Seal", value: input.sealStatus },
        { label: "Skill digest", value: audit.skill.scriptsDigest.slice(0, 12) },
        { label: "Planted-fault seed", value: audit.seed.pinned ? "pinned (eval run; not a production result)" : "fresh for this audit" },
        { label: "Replay environment", value: audit.environment.containerRuntime ? `${audit.environment.containerRuntime} container, ${audit.environment.image}` : "fresh copy on the host (no container runtime)" },
        { label: "Stored in", value: input.storedAt },
      ],
    },
  };
  return report;
}

function scopeOf(input: RenderInput): ReportJson["details"]["scope"] {
  const comps = input.components;
  const row = (c: Component) => ({ id: c.id, path: c.path, toolchain: c.toolchain ?? toolchainOf(c), manifest: c.manifest, lockfile: c.lockfile ?? null, changeShare: c.changeShare });
  const sampled = comps.some((c) => c.notAssessedReason?.startsWith("outside the "));
  return {
    type: sampled ? "sampled_monorepo" : input.audit.profile?.repoType === "monorepo" ? "monorepo" : "single",
    included: comps.filter((c) => c.assessed).map(row),
    excluded: [
      ...comps.filter((c) => !c.assessed).map((c) => ({ ...row(c), reason: c.notAssessedReason ?? "not assessed" })),
      ...(input.audit.profile?.satellites ?? []).map((s) => ({ id: s.path.split("/").pop()!, path: s.path, toolchain: s.toolchain, manifest: s.manifest, lockfile: null, changeShare: 0, reason: `not a component: ${s.reason}` })),
    ],
  };
}

function toolchainOf(c: Component): string {
  return c.language === "py" ? "Python" : c.language === "ts" ? "TypeScript" : c.language === "js" ? "Node" : "unknown";
}

function missingList(assets: Asset[]): string[] {
  const missing: string[] = [];
  if (!assets.some((a) => a.kind === "agents_md")) missing.push("an AGENTS.md");
  if (!assets.some((a) => a.kind === "environment")) missing.push("an environment setup");
  if (!assets.some((a) => a.kind === "skill")) missing.push("skills");
  if (!assets.some((a) => a.kind === "hooks")) missing.push("hooks");
  return missing;
}

export function validatePart1(report: ReportJson, rubric: Rubric, narratedAllowedNumbers: Set<string> | null): string[] {
  const errors: string[] = [];
  const ex = report.executive;
  if (wordCount(ex.headline) > rubric.part1.maxHeadlineWords) errors.push(`headline has ${wordCount(ex.headline)} words; the limit is ${rubric.part1.maxHeadlineWords}`);
  if (ex.gaps.length > rubric.part1.maxGaps) errors.push(`part 1 has ${ex.gaps.length} gaps; the limit is ${rubric.part1.maxGaps}`);
  for (const g of ex.gaps) if (wordCount(g.text) > rubric.part1.maxGapWords) errors.push(`gap "${g.text}" has more than ${rubric.part1.maxGapWords} words`);
  const fields: [string, string][] = [
    ["heading", ex.heading],
    ["headline", ex.headline],
    ["nextLine", ex.nextLine],
    ["ask", ex.ask],
    ["coverage", ex.coverage],
    ...ex.gaps.map((g) => ["gap", g.text] as [string, string]),
    ...ex.numbers.flatMap((n) => [["number label", n.label], ["number", n.value], ["comparison", n.comparison]] as [string, string][]),
  ];
  for (const [name, text] of fields) {
    if (text.includes("`")) errors.push(`${name} uses code formatting`);
    if (/\bev-\d+/.test(text)) errors.push(`${name} cites an evidence id`);
    if (/\b(bootstrap|verify|context|safety|scope)\.[a-z_]+/.test(text)) errors.push(`${name} names a check id`);
    for (const term of rubric.part1.bannedTerms) if (text.toLowerCase().includes(term.toLowerCase())) errors.push(`${name} uses the banned term "${term}"`);
    let masked = text;
    for (const lvl of [...rubric.part1.levelNames].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`\\b${lvl}\\b`, "gi");
      for (const m of [...masked.matchAll(re)]) {
        const before = masked.slice(0, m.index);
        if (!/Level [0-4](?: of 4)?, $/i.test(before)) errors.push(`${name} uses the level name "${lvl}" without its level number`);
      }
      masked = masked.replace(re, (s) => "#".repeat(s.length));
    }
  }
  if (narratedAllowedNumbers) {
    const narrated = [ex.headline, ex.ask, ...ex.gaps.map((g) => g.text)];
    for (const t of narrated) for (const m of t.matchAll(/\d+(?:\.\d+)?%?/g)) if (!narratedAllowedNumbers.has(m[0])) errors.push(`"${m[0]}" in the narrated text isn't a number the audit computed`);
  }
  return errors;
}

export function danglingEvidence(report: ReportJson, audit: Audit): string[] {
  const known = new Set(audit.evidence.map((e) => e.id));
  const cited = new Set([...JSON.stringify(report).matchAll(/\bev-\d{3,}\b/g)].map((m) => m[0]));
  return [...cited].filter((id) => !known.has(id)).sort();
}

export function allowedNumbers(report: ReportJson): Set<string> {
  const set = new Set<string>();
  const page1 = report.executive.numbers.map((n) => `${n.value} ${n.comparison}`).join(" ");
  for (const m of page1.matchAll(/\d+(?:\.\d+)?%?/g)) set.add(m[0]);
  for (const c of report.details.levels.components) set.add(`${Math.round(c.changeShare * 100)}%`);
  for (const a of report.actions) if (a.impact > 0) set.add(`${Math.round(a.impact * 100)}%`);
  for (let i = 0; i <= 4; i++) set.add(String(i));
  return set;
}

function levelWord(rubric: Rubric, l: number): string {
  return `${l} ${rubric.scale[l].name}`;
}

export function scaleLine(r: ReportJson): string {
  const here = r.maturity.assessedComponents === 0 || r.maturity.outcome === "not_assessed" ? null : r.maturity.level;
  return r.scale.map((s) => (s.level === here ? `[Level ${s.level} ${s.name}]` : `Level ${s.level} ${s.name}`)).join(" > ");
}

export function renderMarkdown(r: ReportJson, rubric: Rubric): string {
  const out: string[] = [];
  const ex = r.executive;
  out.push(`# Agent readiness: ${r.repo}`, "");
  out.push(`> ${r.audit.seedPinned ? "Eval run with a pinned seed; not a production result. " : ""}${r.audit.sealStatus}.${r.audit.staleCopy ? ` ${r.audit.staleCopy}` : ""}`, "");
  const conf = r.maturity.confidence;
  out.push(`## 1. Where you stand: ${ex.heading}`, "", `Audited ${fmtDate(r.audit.date)} at ${r.audit.commit}. Confidence: ${conf.level}, because ${list(conf.reasons)}.`, "", `**${ex.headline}**`, "");
  for (const n of ex.numbers) out.push(`- **${n.label}:** ${n.value}. ${n.comparison}.`);
  out.push("");
  out.push(scaleLine(r), "", ex.nextLine, "");
  if (ex.gaps.length) {
    for (const g of ex.gaps) out.push(`${g.rank}. **${g.text}.** ${g.blocks}.`);
    out.push("");
  }
  out.push(`> **Recommendation:** ${ex.ask}`, "", ex.coverage, "");
  out.push("## 2. Next actions and how they move the needle", "");
  if (r.matrix.points.length) {
    out.push(`Effort against impact (impact is the share of recent changes an action unblocks): ${r.matrix.points.map((p) => `${p.label} (effort ${p.x <= 0.35 ? "small" : p.x <= 0.7 ? "medium" : "large"}, ${Math.round(p.y * 100)}%)`).join("; ")}.`, "");
  }
  for (const a of r.actions) {
    out.push(`### ${a.rank}. ${a.title}${a.startNow ? " (can start now)" : ""}`, "");
    out.push(`- **Why it matters:** ${a.why}`, `- **How it moves the needle:** ${a.movesTheNeedle}`, `- **What to watch:** ${a.watch}`);
    if (a.research) out.push(`- **Research:** ${a.research}`);
    out.push(`- **Effort and owner:** ${a.effortAndOwner}`);
    if (a.decision) out.push(`- **Decision needed:** ${a.decision}.`);
    if (a.dependsOn.length) out.push(`- **Depends on:** ${list(a.dependsOn)}`);
    out.push(`- **Done when:** ${a.doneWhen}`, "");
  }
  const noResults = r.maturity.outcome === "not_assessed";
  if (r.actions.length === 0) out.push(r.maturity.assessedComponents === 0 ? "No actions can be planned yet: no component could be assessed, so nothing was checked. Part 1 says why." : noResults ? "No actions can be planned yet: this audit has no real check results to plan from. Part 1 says why." : "No actions are open.", "");
  out.push("## 3. Where you are on the roadmap", "");
  if (noResults) out.push("This audit added no steps, because it has no real check results to plan from. The roadmap is as the last audit left it.", "");
  out.push(`${r.roadmap.doneCount} of ${r.roadmap.total} steps done. Kept in \`.agent-readiness/roadmap.json\`.${r.roadmap.owner ? ` Owner: ${r.roadmap.owner}.` : ""}`, "");
  for (const i of r.roadmap.items) out.push(`- [${i.status === "done" ? "x" : " "}] ${i.order}. ${i.title}: unlocks ${i.unlocks} (${i.statusText})`);
  out.push("");
  if (r.progress) {
    out.push("### Levels over time", "", "| Date | Record | Repo | " + Object.keys(r.progress.history[r.progress.history.length - 1].levels).join(" | ") + " |", "|---|---|---|" + Object.keys(r.progress.history[r.progress.history.length - 1].levels).map(() => "---|").join(""));
    for (const h of r.progress.history) out.push(`| ${fmtShortDate(h.date)} | ${h.kind}${h.result === "failed" ? " failed" : ""}${h.note ? `, ${h.note}` : ""} | ${h.repoLevel} | ${Object.keys(r.progress.history[r.progress.history.length - 1].levels).map((k) => (k in h.levels ? String(h.levels[k]) : "-")).join(" | ")} |`);
    out.push("", "A failed recheck lowers a level and a later passing recheck restores it. Only an audit can raise a level above the last audit.", "");
    if (r.progress.rubricChanges.length) out.push(`Rubric changes: ${r.progress.rubricChanges.map((c) => `${fmtShortDate(c.date)} ${c.from} to ${c.to}`).join("; ")}. A level change at a rubric change can come from the rubric, not the repo.`, "");
    if (r.progress.closed.length) {
      out.push("### What each closed step was expected to move, and what moved after it", "", "| Step | Closed | Expected | Observed after |", "|---|---|---|---|");
      for (const c of r.progress.closed) out.push(`| ${c.title} | ${fmtShortDate(c.closed)} | ${c.expected} | ${c.observed} |`);
      out.push("", "Movement after a step closed, not proof that the step caused it. Steps closed in the same window share one value.", "");
    }
    if (r.progress.weakening) out.push(r.progress.weakening, "");
  }
  out.push("## 4. Details: exact steps and everything we checked", "");
  const sc = r.details.scope;
  out.push("### Components found", "", `Repo shape: ${sc.type === "sampled_monorepo" ? "monorepo, sampled (only the most active supported components are assessed)" : sc.type}.`, "", "| Component | Path | Toolchain | Manifest | Lockfile | Share of changes | Assessed |", "|---|---|---|---|---|---|---|");
  for (const c of sc.included) out.push(`| \`${c.id}\` | \`${c.path}\` | ${c.toolchain} | ${c.manifest ? `\`${c.manifest}\`` : "none"} | ${c.lockfile ? `\`${c.lockfile}\`` : "none"} | ${Math.round(c.changeShare * 100)}% | yes |`);
  for (const c of sc.excluded) out.push(`| \`${c.id}\` | \`${c.path}\` | ${c.toolchain} | ${c.manifest ? `\`${c.manifest}\`` : "none"} | ${c.lockfile ? `\`${c.lockfile}\`` : "none"} | ${c.reason.startsWith("not a component") ? "n/a" : `${Math.round(c.changeShare * 100)}%`} | no: ${c.reason} |`);
  out.push("");
  for (const s of r.details.steps) {
    out.push(`### Steps for ${s.title}`, "");
    s.steps.forEach((st, i) => out.push(`${i + 1}. **${st.title}.** ${st.detail}`));
    out.push("");
  }
  out.push("### Everything we checked, and why", "", "| Check | Why it matters | Result | Evidence |", "|---|---|---|---|");
  for (const c of r.details.checks) {
    const src = c.sources.map((s) => ` ${s.claim} ${s.caveat} ([source](${s.url}))`).join("");
    out.push(`| ${c.name} (\`${c.id}\`) | ${c.why}${src} | ${c.ok === false ? "**" + c.result + "**" : c.result} | ${c.evidence.slice(0, 6).map((e) => `\`${e}\``).join(", ")}${c.evidence.length > 6 ? ` and ${c.evidence.length - 6} more` : ""} |`);
  }
  out.push("", `Not assessed by this rubric version, which is different from unknown: ${list(r.details.notAssessed.map((n) => n.charAt(0).toLowerCase() + n.slice(1)))}.`, "");
  out.push("### Levels by component and activity", "", "| Component | Share of changes | " + r.details.levels.activities.filter((a) => a.id !== "repo_wide").map((a) => a.label).join(" | ") + " |", "|---|---|" + r.details.levels.activities.filter((a) => a.id !== "repo_wide").map(() => "---|").join(""));
  for (const c of r.details.levels.components) {
    out.push(`| \`${c.id}\`${c.active ? "" : " (under 10%)"} | ${Math.round(c.changeShare * 100)}% | ${r.details.levels.activities.filter((a) => a.id !== "repo_wide").map((a) => levelWord(rubric, c.levels[a.id] ?? 0) + (c.couldBe[a.id] !== undefined ? ` (could be ${c.couldBe[a.id]})` : "")).join(" | ")} |`);
  }
  if (r.details.levels.components.length === 0) out.push("", "No component could be assessed, so there are no levels to show.", "");
  else out.push("", `Repo levels: ${r.details.levels.activities.map((a) => `${a.label} ${r.details.levels.repoLevels[a.id] ?? 0}`).join(", ")}. The repo level is ${r.details.levels.repoLevelRule}.`, "");
  if (r.maturity.capReasons.length) {
    out.push(`What holds the ${r.goalLabel.toLowerCase()} level at Level ${r.maturity.level}:`, "");
    for (const c of r.maturity.capReasons) out.push(`- ${c.component === "*" ? "Repo" : `\`${c.component}\``}: ${c.label}, ${c.state === "blocked" ? "blocked on this machine" : c.state === "unknown" ? "not proven" : "not met"} (${c.reason}).`);
    out.push("");
  }
  for (const a of r.details.levels.activities) out.push(`- **${a.label}:** ${a.bar}.`);
  out.push("");
  const oc = r.details.outcomes;
  out.push("### Agent PR outcomes", "");
  if (oc) {
    out.push(`${oc.window}. Agent PRs are matched by ${oc.filter}. Source: ${oc.source}.`, "", "| Measure | " + oc.series.map((s) => s.label).join(" | ") + " |", "|---|" + oc.series.map(() => "---|").join(""));
    out.push(`| Opened | ${oc.series.map((s) => s.opened).join(" | ")} |`);
    out.push(`| Merged | ${oc.series.map((s) => describeRate(s.merged)).join(" | ")} |`);
    out.push(`| Passed CI the first time | ${oc.series.map((s) => describeRate(s.firstTimeCi)).join(" | ")} |`);
    out.push(`| Reviewer requested changes | ${oc.series.map((s) => describeRate(s.changesRequested)).join(" | ")} |`);
    out.push(`| Median days to merge | ${oc.series.map((s) => (s.medianDaysToMerge === null ? "n/a" : String(s.medianDaysToMerge))).join(" | ")} |`, "");
    out.push("| Component | Agent PRs | Passed CI the first time | Changes requested |", "|---|---|---|---|");
    for (const c of oc.byComponent) out.push(`| \`${c.component}\` | ${c.prs} | ${describeRate(c.firstTimeCi)} | ${describeRate(c.changesRequested)} |`);
    out.push("", `${oc.multiComponentNote} ${oc.caveat}`, "", `Matched PRs: ${oc.matchedPrs.map((n) => `#${n}`).join(", ") || "none"}.`, "");
  } else out.push("Not measured: outcomes need the external-systems tier and `readiness outcomes`.", "");
  out.push("### Agent assets already in the repo", "");
  if (r.details.assets.length) {
    out.push("| Asset | Path | Authors | Last changed | Status |", "|---|---|---|---|---|");
    for (const a of r.details.assets) out.push(`| ${a.kind} | \`${a.path}\` | ${a.authors.join(", ") || "unknown"} | ${a.lastChanged ? fmtShortDate(a.lastChanged) : "n/a"} | ${a.status} |`);
    out.push("");
  }
  if (r.details.missingAssets.length) out.push(`Missing: ${list(r.details.missingAssets)}.`, "");
  out.push("### Evidence log", "", "<details><summary>All evidence</summary>", "", "| ID | Check | Component | What ran | Where | Result |", "|---|---|---|---|---|---|");
  for (const e of r.details.evidence) out.push(`| \`${e.id}\` | \`${e.check}\` | ${e.component ?? "repo"} | ${e.ran.replace(/\|/g, "\\|").slice(0, 140)} | ${e.where} | ${e.result}: ${e.summary.replace(/\|/g, "\\|").slice(0, 160)} |`);
  out.push("", "</details>", "", "Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container, confirmed by outcomes. A check passes only at its required strength.", "");
  out.push("### Audit record", "");
  for (const x of r.details.record) out.push(`- **${x.label}:** ${x.value}`);
  out.push("");
  return out.join("\n");
}

import type { LevelResult } from "./levels.ts";
import { describeRate, rate, windowLabel } from "./outcomes.ts";
import { watchFor } from "./roadmap.ts";
import type { Rubric } from "./rubric.ts";
import type { CompStates } from "./score.ts";
import { checkCounts } from "./score.ts";
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
}

const STATUS_TEXT: Record<RoadmapItem["status"], string> = { done: "done", in_progress: "in progress", next: "next", start_now: "can start now", waiting: "waiting", later: "later" };

function goalLabel(rubric: Rubric, goal: ActivityId): string {
  return rubric.activities.find((a) => a.id === goal)!.label.toLowerCase();
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function condLabel(rubric: Rubric, c: CondId): string {
  return rubric.conditions[c].label;
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

function headlineFor(input: RenderInput, ready: string[], setByShare: number): string {
  const { goalLevel, rubric, goal } = input;
  const top = input.top;
  const label = goalLabel(rubric, goal);
  if (top.length === 0 || top.every((t) => t.kind !== "fix")) {
    if (goalLevel.level >= 3) return `Agent PRs meet your Level 3 targets for ${label}. Keep the weekly recheck running and widen the work agents take.`;
    return `Nothing in the repo blocks agents from ${label}. Start delegating: give agents a few real ${label} this week.`;
  }
  if (goalLevel.setBy.length === 0) {
    const repoConds = (["toolchain", "lockfile", "instructions", "safety"] as CondId[]).filter((c) => [...input.states.values()][0]?.[c].state === "not_met");
    const what = repoConds.length ? list(repoConds.map((c) => condLabel(rubric, c).replace(/^a /, "").replace(/versions are pinned/, "versions aren't pinned").replace(/reproduces the lockfile/, "doesn't reproduce the lockfile"))) : "a repo-wide check fails";
    return goalLevel.level === 0 ? `Agents can't pass the tests from a clean checkout, so ${label} can't start yet.` : `Every component builds and passes its tests, but ${label} aren't reproducible yet: ${what}.`;
  }
  const names = list(goalLevel.setBy);
  const share = `${pct(setByShare, 1)}% of recent changes land there`;
  const readyLine = ready.length ? ` ${list(ready)} ${ready.length > 1 ? "are" : "is"} already ready for ${label}.` : "";
  if (goalLevel.level === 0) {
    const blockers = new Set(top.filter((t) => t.kind === "fix" && t.fixes.some((f) => goalLevel.setBy.includes(f.component) || f.component === "*")).map((t) => t.template));
    const many = goalLevel.setBy.length > 1;
    if (blockers.has("clean.install")) return `The repo doesn't install from a clean checkout, so agents can't build or test anything yet.${readyLine}`;
    if (blockers.has("clean.test:missing")) return `${names} ${many ? "have" : "has"} no tests, so agents can't check their own changes, and ${share}.${readyLine}`;
    if (blockers.has("clean.build")) return `${names} ${many ? "don't" : "doesn't"} build from a clean checkout, and ${share}.${readyLine}`;
    return `Agents can't pass the tests in ${names} from a clean checkout, and ${share}.${readyLine}`;
  }
  return `Agents can build and test ${names}, but its checks can't yet catch wrong ${label}, and ${share}.${readyLine}`;
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
  const activeIds = [...input.active];
  const ready = activeIds.filter((id) => (compLevel(input, id, goal === "repo_wide" ? "bug_fixes" : goal)?.level ?? 0) >= 2).length;
  const nextLevel = Math.min(4, input.goalLevel.level + 1);
  const below = input.components.filter((c) => c.assessed && input.active.has(c.id) && (goal === "repo_wide" ? input.goalLevel.level : compLevel(input, c.id, goal)?.level ?? 0) < nextLevel).reduce((s, c) => s + c.changeShare, 0);
  const o = audit.outcomes;
  const ciValue = o ? describeRate(rate(o.agent.firstTimeCiPass, o.agent.firstTimeCiKnown, rubric, windowLabel(o))) : "not measured";
  const ciComparison = o ? `${describeRate(rate(o.control.firstTimeCiPass, o.control.firstTimeCiKnown, rubric, windowLabel(o)))}, ${windowLabel(o)}` : "";
  return [
    { label: `Active components ready for ${label}`, value: `${ready} of ${activeIds.length}`, comparison: "Active means at least 10% of recent changes" },
    { label: "Agent PRs that pass CI the first time", value: ciValue, comparison: o ? `Other PRs: ${ciComparison}` : "Outcomes need the external-systems tier" },
    { label: `Recent changes in components below Level ${nextLevel}`, value: `${pct(below, 1)}%`, comparison: `Changes in the last ${audit.profile?.historyDays ?? 90} days` },
  ];
}

function nextLine(input: RenderInput): string {
  const { rubric, goal, goalLevel } = input;
  const L = goalLevel.level;
  if (L >= 4) return "This is the top of the scale. Keep the weekly recheck running.";
  const next = rubric.scale[L + 1];
  if (L >= 2) return `Next: Level ${L + 1}, ${next.plain}. It needs outcome targets your team sets and agent PRs that meet them${goalLevel.outcomeReasons.length ? `: ${goalLevel.outcomeReasons[0]}` : ""}.`;
  const conds = L === 0 ? rubric.level1 : rubric.activities.find((a) => a.id === goal)!.level2;
  const met: string[] = [];
  const unmet: string[] = [];
  for (const c of conds) {
    const failing = [...input.active].filter((id) => input.states.get(id)?.[c].state !== "met");
    if (failing.length === 0) met.push(condLabel(rubric, c));
    else unmet.push(`${list(failing)} ${condLabel(rubric, c)}`);
  }
  return `Next: Level ${L + 1}, ${next.plain}. ${met.length ? `Met: ${list(met)}. ` : ""}Not yet: ${list(unmet)}.`;
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
    for (const c of assessed) {
      const s = input.states.get(c.id)!;
      if (conds.some((k) => s[k].state === "not_met")) failed.push(c.id);
      else if (conds.some((k) => s[k].state === "unknown")) unproven.push(c.id);
      else passed.push(c.id);
    }
    const parts: string[] = [];
    if (failed.length) parts.push(`failed: ${list(failed)}`);
    if (passed.length) parts.push(`passed: ${list(passed)}`);
    if (unproven.length) parts.push(`not proven: ${list(unproven)}`);
    return { result: parts.join("; "), ok: failed.length ? false : unproven.length ? null : true };
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
    return { result: `${k.passed} passed, ${k.failed} failed, ${k.notRun} not run`, ok: k.failed ? false : audit.instructions.some((i) => i.result === "not_run" && i.category === "replay") ? null : true };
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
  const noBlocker = top.every((t) => t.kind !== "fix");
  const narr = audit.narration ?? {};
  const gaps = top.map((t, i) => ({ rank: i + 1, text: (narr.gaps?.[t.id] ?? gapText(t)).trim().replace(/\.+$/, ""), blocks: blocksText(t), itemId: t.id }));
  const first = top[0];
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  let ask = first?.decision ? `Decision needed: ${lower(first.decision)}.` : noBlocker ? `Decision needed: which ${label} go to agents first.` : `Approve the agent's fix for "${gapText(first)}".`;
  if (!roadmap.owner) ask += " Also name an owner for agent readiness.";
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
      next: L < 4 ? { level: (L + 1) as Level, name: rubric.scale[L + 1].name, met: [], unmet: [] } : null,
    },
    executive: {
      heading: `Level ${L} of 4, ${rubric.scale[L].plain}, for ${label}`,
      headline: narr.headline ?? headlineFor(input, ready, setByShare),
      numbers: stats3(input),
      nextLine: nextLine(input),
      gaps,
      ask: narr.ask ?? ask,
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
      steps: actions.map((a) => ({ itemId: a.itemId, title: a.title, steps: roadmap.items.find((i) => i.id === a.itemId)!.steps })),
      checks: rubric.checks.map((c) => {
        const r = checkResult(input, c.id);
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
      evidence: audit.evidence.map((e) => ({ id: e.id, check: e.checkId, component: e.component && e.component !== "*" ? e.component : null, ran: e.command ?? e.summary, where: rubric.strengthLabels[e.strength], result: e.result, summary: e.summary })),
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

export function renderMarkdown(r: ReportJson, rubric: Rubric): string {
  const out: string[] = [];
  const ex = r.executive;
  out.push(`# Agent readiness: ${r.repo}`, "");
  out.push(`> ${r.audit.seedPinned ? "Eval run with a pinned seed; not a production result. " : ""}${r.audit.sealStatus}.${r.audit.staleCopy ? ` ${r.audit.staleCopy}` : ""}`, "");
  out.push(`## 1. Where you stand: ${ex.heading}`, "", `Audited ${fmtDate(r.audit.date)} at ${r.audit.commit}`, "", `**${ex.headline}**`, "");
  for (const n of ex.numbers) out.push(`- **${n.label}:** ${n.value}. ${n.comparison}.`);
  out.push("");
  const marker = r.scale.map((s) => (s.level === r.maturity.level ? `[Level ${s.level} ${s.name}]` : `Level ${s.level} ${s.name}`)).join(" > ");
  out.push(marker, "", ex.nextLine, "");
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
  if (r.actions.length === 0) out.push("No actions are open.", "");
  out.push("## 3. Where you are on the roadmap", "", `${r.roadmap.doneCount} of ${r.roadmap.total} steps done. Kept in \`.agent-readiness/roadmap.json\`.${r.roadmap.owner ? ` Owner: ${r.roadmap.owner}.` : ""}`, "");
  for (const i of r.roadmap.items) out.push(`- [${i.status === "done" ? "x" : " "}] ${i.order}. ${i.title}: unlocks ${i.unlocks} (${i.statusText})`);
  out.push("");
  if (r.progress) {
    out.push("### Levels over time", "", "| Date | Record | Repo | " + Object.keys(r.progress.history[r.progress.history.length - 1].levels).join(" | ") + " |", "|---|---|---|" + Object.keys(r.progress.history[r.progress.history.length - 1].levels).map(() => "---|").join(""));
    for (const h of r.progress.history) out.push(`| ${fmtShortDate(h.date)} | ${h.kind}${h.result === "failed" ? " failed" : ""}${h.note ? `, ${h.note}` : ""} | ${h.repoLevel} | ${Object.keys(r.progress.history[r.progress.history.length - 1].levels).map((k) => (k in h.levels ? String(h.levels[k]) : "-")).join(" | ")} |`);
    out.push("", "A failed recheck lowers a level and a later passing recheck restores it. Only an audit can raise a level above the last audit.", "");
    if (r.progress.rubricChanges.length) out.push(`Rubric changes: ${r.progress.rubricChanges.map((c) => `${fmtShortDate(c.date)} ${c.from} to ${c.to}`).join("; ")}. A level change at a rubric change can come from the rubric, not the repo.`, "");
    if (r.progress.closed.length) {
      out.push("### What the closed steps delivered", "", "| Step | Closed | Expected | Observed |", "|---|---|---|---|");
      for (const c of r.progress.closed) out.push(`| ${c.title} | ${fmtShortDate(c.closed)} | ${c.expected} | ${c.observed} |`);
      out.push("");
    }
    if (r.progress.weakening) out.push(r.progress.weakening, "");
  }
  out.push("## 4. Details: exact steps and everything we checked", "");
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
  out.push("", `Repo levels: ${r.details.levels.activities.map((a) => `${a.label} ${r.details.levels.repoLevels[a.id] ?? 0}`).join(", ")}. The repo level is ${r.details.levels.repoLevelRule}.`, "");
  for (const a of r.details.levels.activities) out.push(`- **${a.label}:** ${a.bar}.`);
  for (const u of r.details.levels.unassessed) out.push(`- \`${u.id}\` (${Math.round(u.changeShare * 100)}% of changes) is not assessed: ${u.reason}.`);
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

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { activeComponents, capAt, componentLevel, outcomeLevel, partialCoverage, recheckStates, repoLevel, repoWideLevel, statesOf, targetsMet } from "../skill/agent-readiness/scripts/lib/levels.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { HistoryLine } from "../skill/agent-readiness/scripts/lib/types.ts";
import { instruction, makeAudit, outcomes, stats } from "./helpers.ts";

const rubric = loadRubric("2026-10-alpha");

function levelsOf(spec: Parameters<typeof makeAudit>[0], comp: string) {
  const audit = makeAudit(spec);
  const s = statesOf(componentStates(audit, rubric, comp));
  return { first_pr: componentLevel(rubric, s, "first_pr"), bug_fixes: componentLevel(rubric, s, "bug_fixes"), features: componentLevel(rubric, s, "features") };
}

function line(id: string, shares: Record<string, number>, active: string[]): HistoryLine {
  return { id, kind: "audit", date: "2026-10-01", commit: "x", rubric: "2026-10-alpha", scriptsDigest: "x", result: "sealed", goal: "bug_fixes", levels: {}, repoLevels: {}, shares, active, seedPinned: false };
}

describe("level rules", () => {
  test("a clean-container pass of install, build and tests gives Level 1", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, faults: "fail" }] }, "a");
    assert.equal(l.bug_fixes.level, 1);
  });

  test("a pass on the host only is not proven, so the level is 0 with a could-be note", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, where: "fresh_copy", faults: "pass" }] }, "a");
    assert.equal(l.bug_fixes.level, 0);
    assert.equal(l.bug_fixes.couldBe, 1);
  });

  test("tests that run but fail give Level 0", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, test: "fail", faults: "not_run" }] }, "a");
    assert.equal(l.first_pr.level, 0);
    assert.equal(l.bug_fixes.level, 0);
    assert.equal(l.bug_fixes.couldBe, null);
  });

  test("a component with no test command can't reach Level 1", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, test: "missing" }] }, "a");
    assert.equal(l.bug_fixes.level, 0);
  });

  test("0 of N planted faults caught is never Level 2 for an activity that needs them", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, faults: "fail" }] }, "a");
    assert.equal(l.bug_fixes.level, 1);
    assert.equal(l.features.level, 1);
    assert.equal(l.first_pr.level, 2);
    const audit = makeAudit({ components: [{ id: "a", share: 1, faults: "fail" }] });
    const maps = new Map([["a", statesOf(componentStates(audit, rubric, "a"))]]);
    assert.equal(repoWideLevel(rubric, maps).level, 1);
  });

  test("faults that couldn't be planted read as could-be, not as passed", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, faults: "not_run" }] }, "a");
    assert.equal(l.bug_fixes.level, 1);
    assert.equal(l.bug_fixes.couldBe, 2);
  });

  test("features also need accurate instructions; bug fixes don't", () => {
    const l = levelsOf({ components: [{ id: "a", share: 1, faults: "pass" }], instructions: [instruction("fail", "pnpm test", "uses pnpm, but the repo uses npm")] }, "a");
    assert.equal(l.bug_fixes.level, 2);
    assert.equal(l.features.level, 1);
    assert.equal(l.first_pr.level, 1);
  });

  test("repo-wide changes need pinned toolchains and a reproducible lockfile", () => {
    const audit = makeAudit({ components: [{ id: "a", share: 1, faults: "pass" }], toolchainPinned: false, lockfile: "pass" });
    const maps = new Map([["a", statesOf(componentStates(audit, rubric, "a"))]]);
    assert.equal(repoWideLevel(rubric, maps).level, 1);
    const fixed = makeAudit({ components: [{ id: "a", share: 1, faults: "pass" }], toolchainPinned: true, lockfile: "pass" });
    assert.equal(repoWideLevel(rubric, new Map([["a", statesOf(componentStates(fixed, rubric, "a"))]])).level, 2);
  });

  test("the repo level is the lowest level among active components", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 0.56, test: "fail" }, { id: "shared", share: 0.38, faults: "pass" }, { id: "docs", share: 0.06, test: "fail" }] });
    const active = activeComponents(rubric, audit.profile!.components, []);
    assert.deepEqual([...active].sort(), ["api", "shared"]);
    const levels = new Map(["api", "shared", "docs"].map((id) => [id, componentLevel(rubric, statesOf(componentStates(audit, rubric, id)), "bug_fixes")]));
    const r = repoLevel(levels, active);
    assert.equal(r.level, 0);
    assert.deepEqual(r.setBy, ["api"]);
    const withoutApi = repoLevel(levels, new Set(["shared"]));
    assert.equal(withoutApi.level, 2, "a component under 10% doesn't set the level");
  });

  test("the 10% rule changes membership only after two consecutive audits", () => {
    const comps = makeAudit({ components: [{ id: "a", share: 0.95 }, { id: "b", share: 0.05 }] }).profile!.components;
    const first = [line("aud-1", { a: 0.8, b: 0.2 }, ["a", "b"])];
    assert.deepEqual([...activeComponents(rubric, comps, first)].sort(), ["a", "b"], "b stays active after one audit below the line");
    const second = [...first, line("aud-2", { a: 0.95, b: 0.05 }, ["a", "b"])];
    assert.deepEqual([...activeComponents(rubric, comps, second)].sort(), ["a"], "b leaves after two audits below the line");
    const rising = makeAudit({ components: [{ id: "a", share: 0.85 }, { id: "b", share: 0.15 }] }).profile!.components;
    assert.deepEqual([...activeComponents(rubric, rising, [line("aud-3", { a: 0.95, b: 0.05 }, ["a"])])], ["a"], "b doesn't join after one audit above the line");
    assert.deepEqual([...activeComponents(rubric, rising, [line("aud-3", { a: 0.95, b: 0.05 }, ["a"]), line("aud-4", { a: 0.88, b: 0.12 }, ["a"])])].sort(), ["a", "b"]);
  });

  test("more than 20% of changes outside assessed components reads as partial coverage", () => {
    const comps = makeAudit({ components: [{ id: "a", share: 0.7 }, { id: "infra", share: 0.3, assessed: false }] }).profile!.components;
    assert.equal(partialCoverage(rubric, comps).partial, true);
    const small = makeAudit({ components: [{ id: "a", share: 0.9 }, { id: "infra", share: 0.1, assessed: false }] }).profile!.components;
    assert.equal(partialCoverage(rubric, small).partial, false);
  });
});

describe("outcome levels", () => {
  const targets = { mergeRate: 0.7, firstPass: 0.6, maxChangesRequested: 0.3, minAgentPrs: 20 };

  test("Level 3 needs recorded targets", () => {
    const o = outcomes("2026-10-01", "2026-10-30", stats(25, 22, 20, 3), stats(40, 35, 30, 5));
    assert.equal(outcomeLevel(rubric, { level2: true, targets: null, outcomes: o, previous: [], goal: "bug_fixes" }).level, null);
    assert.equal(outcomeLevel(rubric, { level2: true, targets, outcomes: o, previous: [], goal: "bug_fixes" }).level, 3);
    assert.equal(outcomeLevel(rubric, { level2: false, targets, outcomes: o, previous: [], goal: "bug_fixes" }).level, null);
  });

  test("the sample floor holds: fewer than 20 agent PRs can't reach Level 3", () => {
    const o = outcomes("2026-10-01", "2026-10-30", stats(12, 12, 12, 0), stats(40, 35, 30, 5));
    const r = targetsMet(rubric, targets, o);
    assert.equal(r.met, false);
    assert.match(r.reasons[0], /only 12 agent PRs/);
  });

  test("a team can't lower the floor below 10", () => {
    const o = outcomes("2026-10-01", "2026-10-30", stats(8, 8, 8, 0), stats(40, 35, 30, 5));
    assert.equal(targetsMet(rubric, { ...targets, minAgentPrs: 5 }, o).met, false);
  });

  test("Level 3 always needs a control group", () => {
    const o = outcomes("2026-10-01", "2026-10-30", stats(25, 22, 20, 3), stats(0, 0, 0, 0));
    assert.equal(targetsMet(rubric, targets, o).met, false);
  });

  test("Level 4 needs agent PR volume to double without change requests rising", () => {
    const prev: HistoryLine = { ...line("aud-1", {}, []), repoLevels: { bug_fixes: 3 }, outcomes: { window: "w", agent: stats(20, 18, 16, 2), control: stats(40, 35, 30, 5), byComponent: {} } };
    const doubled = outcomes("2026-10-01", "2026-10-30", stats(42, 38, 34, 4), stats(40, 35, 30, 5));
    assert.equal(outcomeLevel(rubric, { level2: true, targets, outcomes: doubled, previous: [prev], goal: "bug_fixes" }).level, 4);
    const moreReviews = outcomes("2026-10-01", "2026-10-30", stats(42, 38, 34, 10), stats(40, 35, 30, 5));
    assert.equal(outcomeLevel(rubric, { level2: true, targets, outcomes: moreReviews, previous: [prev], goal: "bug_fixes" }).level, 3);
  });
});

describe("recheck rule", () => {
  const base = statesOf(componentStates(makeAudit({ components: [{ id: "a", share: 1, lint: "pass", faults: "pass" }] }), rubric, "a"));

  test("a lint failure in a recheck gives Level 1", () => {
    assert.equal(componentLevel(rubric, recheckStates(base, new Set(["lint"])), "bug_fixes").level, 1);
  });

  test("a failing test in a recheck gives Level 0", () => {
    assert.equal(componentLevel(rubric, recheckStates(base, new Set(["test"])), "bug_fixes").level, 0);
  });

  test("a passing recheck restores the last audit's level and never raises it", () => {
    assert.equal(componentLevel(rubric, recheckStates(base, new Set()), "bug_fixes").level, 2);
    assert.equal(capAt(2, 1), 1);
    assert.equal(capAt(0, 1), 0);
  });
});

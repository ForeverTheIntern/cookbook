import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { computeOutcomes, describeRate, rate } from "../skill/agent-readiness/scripts/lib/outcomes.ts";
import { allowedNumbers, danglingEvidence, renderMarkdown, validatePart1 } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { validateAgainst } from "../skill/agent-readiness/scripts/lib/schema.ts";
import type { HistoryLine, PrRecord, ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import type { AuditSpec } from "./helpers.ts";
import { makeAudit, outcomes, reportFor, stats } from "./helpers.ts";

const rubric = loadRubric("2026-10-alpha");

const mixed: AuditSpec = {
  components: [
    { id: "api", share: 0.56, test: "fail", diagnosis: { cause: "service", detail: "connection refused on port 5432", service: "Postgres" }, faults: "not_run" },
    { id: "worker", share: 0.27, faults: "fail" },
    { id: "shared", share: 0.15, faults: "pass" },
    { id: "infra", share: 0.02, assessed: false },
  ],
  outcomes: outcomes("2026-09-27", "2026-10-27", stats(9, 7, 3, 4), stats(41, 35, 29, 7), { api: stats(5, 4, 1, 2), worker: stats(3, 2, 1, 2), shared: stats(2, 2, 2, 0) }),
};

describe("report.json", () => {
  test("validates against its schema and passes the part 1 rules by default", () => {
    const r = reportFor(makeAudit(mixed));
    assert.deepEqual(validateAgainst("report", r), []);
    assert.deepEqual(validatePart1(r, rubric, null), []);
    assert.equal(r.executive.heading, "Level 0 of 4, not bootable, for bug fixes");
    assert.match(r.executive.headline, /api/);
    assert.match(r.executive.headline, /shared is already ready/);
    assert.equal(r.executive.numbers.length, 3);
    assert.ok(r.executive.gaps.length <= 3);
  });

  test("names components from the data, never hardcoded", () => {
    const renamed = makeAudit({ ...mixed, components: mixed.components.map((c) => ({ ...c, id: `pkg-${c.id}` })), outcomes: null });
    const r = reportFor(renamed);
    const md = renderMarkdown(r, rubric);
    assert.ok(!/\b(api|worker|shared)\b/.test(md.replace(/pkg-(api|worker|shared)/g, "")), "only the renamed components appear");
  });

  test("every rate carries its n and window, and below 5 shows counts only", () => {
    const r = reportFor(makeAudit(mixed));
    const series = r.details.outcomes!.series;
    for (const s of series) for (const k of ["merged", "firstTimeCi", "changesRequested"] as const) {
      assert.equal(typeof s[k].n, "number");
      assert.ok(s[k].window.length > 0);
    }
    const shared = r.details.outcomes!.byComponent.find((c) => c.component === "shared")!;
    assert.equal(shared.firstTimeCi.rate, null);
    assert.equal(describeRate(rate(2, 2, rubric, "w")), "2 of 2 (too few for a rate)");
  });

  test("the control group is present in every snapshot", () => {
    const r = reportFor(makeAudit(mixed));
    assert.deepEqual(r.details.outcomes!.series.map((s) => s.label).slice(0, 2), ["Agent PRs", "Other PRs"]);
    const broken = JSON.parse(JSON.stringify(r)) as ReportJson;
    broken.details.outcomes!.series = broken.details.outcomes!.series.slice(0, 1);
    assert.ok(validateAgainst("report", broken).some((e) => e.includes("details.outcomes")));
    const prs: PrRecord[] = [{ number: 1, headRefName: "cursor/x", author: "a", labels: [], createdAt: new Date().toISOString(), mergedAt: null, state: "OPEN", files: [], firstCheck: "success", changesRequested: false }];
    const o = computeOutcomes(prs, [], rubric, { branchPrefixes: ["cursor/"], labels: [], authors: [], coAuthorTrailers: [] }, 30, "file");
    assert.ok("control" in o);
  });

  test("the trend caveat sits next to the outcome numbers", () => {
    const r = reportFor(makeAudit(mixed));
    assert.match(r.details.outcomes!.caveat, /not proof|not attribution/);
    const md = renderMarkdown(r, rubric);
    const table = md.indexOf("| Passed CI the first time");
    const caveat = md.indexOf("A baseline, not proof");
    assert.ok(caveat > table && caveat - table < 1200, "caveat follows the table it qualifies");
  });

  test("planted-fault locations never reach the report", () => {
    const audit = makeAudit(mixed);
    audit.mutants.push({ id: "mut-worker-1", component: "worker", file: "worker/src/retry.js", line: 42, operator: "boundary_flip", before: "  if (attempt >= 5) {", after: "  if (attempt > 5) { // UNIQUE-MUTANT-MARKER", result: "survived", exitCodes: [0] });
    const r = reportFor(audit);
    const md = renderMarkdown(r, rubric);
    for (const text of [JSON.stringify(r), md]) {
      assert.ok(!text.includes("UNIQUE-MUTANT-MARKER"));
      assert.ok(!text.includes("attempt > 5"));
      assert.ok(!/retry\.js:42/.test(text));
    }
  });

  test("the markdown has the four parts in order", () => {
    const md = renderMarkdown(reportFor(makeAudit(mixed)), rubric);
    const idx = ["## 1. Where you stand", "## 2. Next actions", "## 3. Where you are on the roadmap", "## 4. Details"].map((h) => md.indexOf(h));
    assert.ok(idx.every((i, n) => i >= 0 && (n === 0 || i > idx[n - 1])), String(idx));
  });
});

describe("part 1 rules", () => {
  const base = () => reportFor(makeAudit(mixed));

  test("a headline over 40 words is rejected", () => {
    const r = base();
    r.executive.headline = Array.from({ length: 41 }, () => "word").join(" ");
    assert.ok(validatePart1(r, rubric, null).some((e) => e.includes("41 words")));
  });

  test("more than three gaps is rejected", () => {
    const r = base();
    r.executive.gaps = [1, 2, 3, 4].map((n) => ({ rank: Math.min(n, 3), text: `gap ${n}`, blocks: "Blocks", itemId: `i${n}` }));
    assert.ok(validatePart1(r, rubric, null).some((e) => e.includes("4 gaps")));
  });

  test("banned jargon, code formatting, check IDs and evidence IDs are rejected", () => {
    for (const [field, text, expect] of [
      ["headline", "The oracle is weak in worker.", "banned term"],
      ["headline", "Run `npm test` first.", "code formatting"],
      ["ask", "See ev-004 for details.", "evidence id"],
      ["coverage", "verify.behavioral_oracle failed.", "check id"],
      ["headline", "The replay failed in api.", "banned term"],
    ] as const) {
      const r = base();
      (r.executive as Record<string, unknown>)[field] = text;
      assert.ok(validatePart1(r, rubric, null).some((e) => e.includes(expect)), `${text} -> ${expect}`);
    }
  });

  test("a level name needs its number and plain meaning", () => {
    const r = base();
    r.executive.headline = "The repo is Bootable but api is not.";
    assert.ok(validatePart1(r, rubric, null).some((e) => e.includes("Bootable")));
    r.executive.headline = "The repo is at Level 1, bootable, for bug fixes.";
    assert.deepEqual(validatePart1(r, rubric, null), []);
  });

  test("narrated text may contain only numbers the audit computed", () => {
    const r = base();
    r.executive.headline = "Failures dropped from 5 to 1 after the fix.";
    assert.ok(validatePart1(r, rubric, allowedNumbers(r)).some((e) => e.includes('"5" in the narrated text')));
    r.executive.headline = "Agents can't pass api's tests from a clean checkout, and 56% of recent changes land there.";
    assert.deepEqual(validatePart1(r, rubric, allowedNumbers(r)), []);
  });

  test("every number compares with what the next level needs, or with the last audit", () => {
    const audit = makeAudit(mixed);
    const [ready, , below] = reportFor(audit).executive.numbers;
    assert.equal(ready.comparison, "Level 2 needs 3 of 3");
    assert.equal(below.comparison, "Level 1 needs 0%, counting the last 90 days");
    const unmeasured = reportFor(makeAudit({ ...mixed, outcomes: null })).executive.numbers[1];
    assert.equal(unmeasured.value, "not measured");
    assert.doesNotMatch(unmeasured.comparison, /tier/);
    const prev: HistoryLine = { id: "aud-prev", kind: "audit", date: "2026-10-01", commit: "abc", rubric: audit.rubric, scriptsDigest: "x", result: "sealed", goal: "bug_fixes", levels: { api: { bug_fixes: 0 }, worker: { bug_fixes: 0 }, shared: { bug_fixes: 0 } }, repoLevels: { bug_fixes: 0 }, shares: { api: 0.56, worker: 0.27, shared: 0.15 }, active: ["api", "worker", "shared"], seedPinned: false };
    const later = reportFor(audit, [prev]).executive.numbers;
    assert.equal(later[0].comparison, "Last audit: 0 of 3");
    assert.equal(later[2].comparison, "Last audit: 98%, counting the last 90 days");
  });

  test("a narrated ask still asks for an owner when none is recorded, once", () => {
    const audit = makeAudit(mixed);
    audit.narration = { ask: "Approve adding a Postgres service to the agent setup for api." };
    assert.equal(reportFor(audit).executive.ask, "Approve adding a Postgres service to the agent setup for api. Also name an owner for agent readiness.");
    audit.narration = { ask: "Approve the Postgres setup for api and name an owner for agent readiness." };
    assert.equal(reportFor(audit).executive.ask, "Approve the Postgres setup for api and name an owner for agent readiness.");
  });

  test("activity labels keep their acronyms", () => {
    assert.equal(reportFor(makeAudit({ ...mixed, goal: "first_pr" })).executive.heading, "Level 0 of 4, not bootable, for first PR");
  });

  test("a narrated gap that ends in a period renders with one period", () => {
    const audit = makeAudit(mixed);
    const id = reportFor(audit).executive.gaps[0].itemId;
    audit.narration = { gaps: { [id]: "Agents can't reach the api database from a clean checkout." } };
    const r = reportFor(audit);
    assert.equal(r.executive.gaps[0].text, "Agents can't reach the api database from a clean checkout");
    assert.ok(!renderMarkdown(r, rubric).includes(".."));
  });

  test("a dangling evidence ID is rejected", () => {
    const audit = makeAudit(mixed);
    const r = reportFor(audit);
    assert.deepEqual(danglingEvidence(r, audit), []);
    r.details.checks[2].evidence.push("ev-999");
    assert.deepEqual(danglingEvidence(r, audit), ["ev-999"]);
  });
});

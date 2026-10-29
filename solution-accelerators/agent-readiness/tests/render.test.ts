import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { computeOutcomes, describeRate, rate } from "../skill/agent-readiness/scripts/lib/outcomes.ts";
import { allowedNumbers, danglingEvidence, renderMarkdown, scaleLine, validatePart1 } from "../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { consistencyErrors, sealStatusFor } from "../skill/agent-readiness/scripts/lib/seal.ts";
import { skillDigest } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { validateAgainst } from "../skill/agent-readiness/scripts/lib/schema.ts";
import type { HistoryLine, PrRecord, ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import type { AuditSpec } from "./helpers.ts";
import { instruction, makeAudit, outcomes, reportFor, stats } from "./helpers.ts";

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
    assert.equal(r.executive.heading, "Level 0 of 4, not bootable");
    assert.match(r.executive.headline, /api/);
    assert.match(r.executive.headline, /shared is already at Level 2/);
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
    const prev: HistoryLine = { id: "aud-prev", kind: "audit", date: "2026-10-01", commit: "abc", rubric: audit.rubric, scriptsDigest: "x", result: "sealed", levels: { api: 0, worker: 0, shared: 0 }, repoLevel: 0, scenarioLevels: {}, shares: { api: 0.56, worker: 0.27, shared: 0.15 }, active: ["api", "worker", "shared"], seedPinned: false };
    const later = reportFor(audit, [prev]).executive.numbers;
    assert.equal(later[0].comparison, "Last audit: 0 of 3");
    assert.equal(later[2].comparison, "Last audit: 98%, counting the last 90 days");
  });

  test("default headlines name the component and what works, and skip the share when there is one component", () => {
    const ready = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] })).executive;
    assert.equal(ready.noBlocker, true);
    assert.equal(ready.headline, "Nothing blocks agents in app: from a clean checkout it installs, builds and passes its tests, and its tests caught the planted bugs. Start delegating work to agents.");
    assert.equal(reportFor(makeAudit({ components: [{ id: "app", share: 1, test: "fail", faults: "not_run" }] })).executive.headline, "Agents can't pass the tests in app from a clean checkout.");
    assert.equal(reportFor(makeAudit(mixed)).executive.headline, "Agents can't pass the tests in api from a clean checkout because its tests need Postgres running, which the setup doesn't start, and 56% of recent changes land there. shared is already at Level 2.");
    const registry = makeAudit({ install: "fail", components: [{ id: "app", share: 1, test: "not_run", faults: "not_run" }] });
    for (const e of registry.evidence) if (e.condition === "clean.install") e.diagnosis = { cause: "registry", detail: "registry credentials not provided" };
    assert.equal(reportFor(registry).executive.headline, "app doesn't install from a clean checkout because private registry credentials weren't provided, so agents can't build or test it yet.");
    const drift = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }], instructions: [instruction("fail", "npm run typecheck", 'no "typecheck" script')] })).executive.headline;
    assert.equal(drift, "Agents can build and test app, but its agent instructions don't match the repo.");
  });

  test("a narrated ask still asks for an owner when none is recorded, once", () => {
    const audit = makeAudit(mixed);
    audit.narration = { ask: "Approve adding a Postgres service to the agent setup for api." };
    assert.equal(reportFor(audit).executive.ask, "Approve adding a Postgres service to the agent setup for api. Also name an owner for agent readiness.");
    audit.narration = { ask: "Approve the Postgres setup for api and name an owner for agent readiness." };
    assert.equal(reportFor(audit).executive.ask, "Approve the Postgres setup for api and name an owner for agent readiness.");
  });

  test("part 1 and the checks claim only what the audit ran", () => {
    const r = reportFor(makeAudit({ ...mixed, components: mixed.components.map((c) => (c.id === "infra" ? c : { ...c, lint: "pass" as const })) }));
    assert.doesNotMatch(r.executive.nextLine, /builds in a clean container|type-check/);
    const commands = r.details.checks.find((c) => c.id === "verify.canonical_interface")!;
    assert.equal(commands.ok, false);
    assert.ok(commands.counts.failed >= 1, JSON.stringify(commands.counts));
    assert.ok(commands.evidence.length >= commands.counts.passed + commands.counts.failed);
    assert.match(r.details.checks.find((c) => c.id === "context.instructions_verified")!.result, /instruction items check out/);
    assert.match(sealStatusFor(skillDigest()), /bundled with this copy; the published release isn't checked here/);
  });

  test("an unproven level isn't reported as nothing blocking, and repo-wide conditions name no component", () => {
    const audit = makeAudit({ components: [{ id: "app", share: 1, where: "fresh_copy", faults: "pass" }] });
    audit.environment.containerRuntime = null;
    const r = reportFor(audit);
    const ex = r.executive;
    assert.equal(r.maturity.outcome, "blocked");
    assert.equal(ex.heading, "Level 1 unproven on this machine: every Level 1 check that ran passed", "an app that boots is never called not bootable");
    assert.equal(r.maturity.unproven, true);
    assert.equal(r.components.included[0].unproven, true);
    assert.doesNotMatch(scaleLine(r), /\[/, "the scale marks no level it couldn't prove");
    assert.match(ex.nextLine, /Blocked on this machine: app /);
    assert.doesNotMatch(ex.nextLine, /Not yet: app/);
    assert.equal(r.maturity.confidence.level, "low");
    assert.ok(r.maturity.capReasons.some((c) => c.component === "app" && c.condition === "clean.test" && c.state === "blocked"), JSON.stringify(r.maturity.capReasons));
    const md = renderMarkdown(r, rubric);
    assert.match(md, /What keeps Level 1 unproven on this machine:\n\n- `app`: [^\n]+, blocked on this machine \(passed on the host, but Level 1 needs a clean container/);
    assert.match(md, /\| `app` \|[^\n]*\| Level 1 unproven on this machine \(could be 1\) \|/);
    assert.match(md, /Repo level: Level 1 unproven on this machine \(could be 1\)\./);
    assert.doesNotMatch(md, /Not bootable \(could be/);
    assert.match(md, /No actions are open: nothing in the repo blocks Level 1\./);
    const failing = reportFor(makeAudit({ components: [{ id: "app", share: 1, where: "fresh_copy", test: "fail", faults: "not_run" }] }));
    assert.equal(failing.maturity.unproven, false, "a failing test is a real Level 0");
    assert.equal(ex.noBlocker, false);
    assert.equal(ex.headline, "Level 1 couldn't be proved for app because this machine has no container runtime. A rerun where Docker or Podman is available, such as CI, can prove it.");
    assert.match(ex.ask, /^Decision needed: where to rerun this audit/);
    const stale = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }], instructions: [instruction("fail", "pnpm test", "uses pnpm, but the repo uses npm")] })).executive.nextLine;
    assert.match(stale, /Not yet: agent instructions are accurate\./, "a repo-wide condition names no component");
  });

  test("with no assessable component, part 1 says so instead of Met, 0 of 0 or no open actions", () => {
    const r = reportFor(makeAudit({ components: [{ id: "services", share: 1, assessed: false }] }));
    const ex = r.executive;
    assert.equal(r.maturity.assessedComponents, 0);
    assert.equal(ex.heading, "Not assessed: no component could be assessed");
    assert.equal(ex.headline, "No component could be assessed, so this audit can't give a level yet: it skipped services (100% of changes) because Terraform isn't supported by this rubric.");
    assert.equal(ex.nextLine, "Next: Level 1, bootable, once a component can be assessed. No condition has been checked yet.");
    assert.deepEqual(ex.numbers.map((n) => n.value), ["none assessed", "not measured", "100%"]);
    assert.doesNotMatch(JSON.stringify(ex), /Met:|0 of 0/);
    assert.match(ex.ask, /^Decision needed: which component this audit should cover, since it can't assess services\./);
    assert.doesNotMatch(scaleLine(r), /\[/);
    const md = renderMarkdown(r, rubric);
    assert.match(md, /No actions can be planned yet: no component could be assessed/);
    assert.doesNotMatch(md, /No actions are open/);
    assert.deepEqual(validatePart1(r, rubric, null), []);
    assert.deepEqual([r.maturity.outcome, r.maturity.confidence.level], ["not_assessed", "low"]);
    assert.deepEqual(validateAgainst("report", r), []);
  });

  test("no real results, no level: when the only checks were blocked on this machine, the report says so and plans nothing", () => {
    const audit = makeAudit({ components: [{ id: "buyer-web", share: 0.6, test: "not_run" }, { id: "commerce-core", share: 0.4, assessed: false }] });
    audit.environment.containerRuntime = null;
    const install = audit.evidence.find((e) => e.kind === "install")!;
    Object.assign(install, { where: "fresh_copy", strength: "executed", result: "fail", summary: "install failed: dotnet is not installed", diagnosis: { cause: "missing_tool", detail: "dotnet is not installed" }, blocked: "dotnet is not installed on this machine" });
    const r = reportFor(audit);
    const ex = r.executive;
    assert.equal(r.maturity.outcome, "not_assessed");
    assert.equal(ex.heading, "Not assessed: no check could run on this machine");
    assert.equal(ex.headline, "Nothing could be checked on this machine, so this audit gives no level: dotnet is not installed on this machine. A rerun where Docker or Podman is available, such as CI, can give one.");
    assert.equal(ex.nextLine, "Next: Level 1, bootable, once a check can run. No condition has been checked yet.");
    assert.deepEqual(ex.numbers.map((n) => n.value), ["none checked", "not measured", "100%"]);
    assert.deepEqual([r.actions.length, ex.gaps.length, r.matrix.points.length, ex.noBlocker], [0, 0, 0, false]);
    assert.match(ex.ask, /^Decision needed: where to rerun this audit so its checks can run/);
    assert.match(ex.coverage, /On this machine dotnet is not installed, an environment limit rather than a repo defect/);
    assert.equal(r.maturity.confidence.level, "low");
    assert.doesNotMatch(scaleLine(r), /\[/);
    assert.equal(r.details.evidence.find((e) => e.id === install.id)!.result, "blocked");
    const md = renderMarkdown(r, rubric);
    assert.match(md, /No actions can be planned yet: this audit has no real check results to plan from/);
    assert.match(md, /This audit added no steps/);
    assert.ok(r.components.included.every((c) => c.level === null && c.capReasons.length === 0), "no component level when part 1 has none");
    assert.match(md, /\| `buyer-web` \| `buyer-web` \|[^\n]*\| not assessed \|/);
    assert.match(md, /Repo level: not assessed\./);
    assert.doesNotMatch(md, /\| 0 Not bootable/);
    assert.deepEqual(r.roadmap.items.map((i) => i.id), ["owner", "targets"], "the owner step stays, so the ask to name one has a step behind it");
    assert.match(ex.ask, /Also name an owner for agent readiness\.$/);
    assert.match(md, /Recent changes this audit couldn't check:\*\* 100%\. Counting the last 90 days/);
    assert.doesNotMatch(md, /blocked: blocked:/);
    assert.deepEqual(validatePart1(r, rubric, null), []);
    assert.deepEqual(validateAgainst("report", r), []);
  });

  test("confidence is separate from the level and never raises it", () => {
    const healthy = reportFor(makeAudit({ components: [{ id: "app", share: 1, faults: "pass" }] }));
    assert.deepEqual([healthy.maturity.level, healthy.maturity.outcome, healthy.maturity.confidence.level], [2, "proven", "high"]);
    assert.deepEqual(healthy.maturity.capReasons.map((c) => c.condition), ["outcomes"].slice(0, healthy.maturity.capReasons.length));
    const partial = reportFor(makeAudit({ components: [{ id: "app", share: 0.7, faults: "pass" }, { id: "infra", share: 0.3, assessed: false }] }));
    assert.equal(partial.maturity.level, healthy.maturity.level);
    assert.equal(partial.maturity.confidence.level, "medium");
    assert.match(partial.maturity.confidence.reasons.join(" "), /30% of recent changes aren't assessed/);
    assert.match(renderMarkdown(partial, rubric), /Confidence: medium \(30% of recent changes aren't assessed\)\./);
  });

  test("part 4 lists the components found, the ones left out and why, and satellites that aren't components", () => {
    const audit = makeAudit({ components: [{ id: "web", share: 0.8, faults: "pass" }, { id: "core", share: 0.2, assessed: false }] });
    audit.profile!.components.find((c) => c.id === "core")!.notAssessedReason = ".NET isn't supported by this rubric";
    audit.profile!.satellites = [{ path: "examples/starter", manifest: "examples/starter/package.json", toolchain: "Node", reason: "it sits under examples/, which usually holds tests, samples or tooling rather than the product" }];
    const r = reportFor(audit);
    assert.deepEqual(r.components.included.map((c) => c.id), ["web"]);
    assert.deepEqual(r.components.excluded.map((c) => [c.id, c.reason]), [["core", ".NET isn't supported by this rubric"], ["starter", "not a component: it sits under examples/, which usually holds tests, samples or tooling rather than the product"]]);
    const md = renderMarkdown(r, rubric);
    assert.match(md, /### Levels by component/);
    assert.match(md, /\| `web` \| `web` \| [^\n]* \| 80% \| 2 Verifiable \|/);
    assert.match(md, /\| `core` \| `core` \| .* \| 20% \| not assessed: \.NET isn't supported by this rubric \|/);
    assert.match(md, /\| `starter` \| `examples\/starter` \| Node \| .* \| n\/a \| not assessed: not a component/);
    assert.match(md, /Repo level: 2 Verifiable\. The repo level is the lowest level among active components/);
    audit.safety = [{ id: "saf-001", kind: "elevated", file: ".cursor/environment.json", detail: "start runs sudo", blocking: false }];
    assert.match(reportFor(audit).details.checks.find((c) => c.id === "safety.execution_boundary")!.result, /^passed; 1 item listed for review$/);
  });

  test("the seal's consistency pass names any component, evidence or narration key the scan doesn't know", () => {
    const audit = makeAudit({ components: [{ id: "web", share: 0.8, faults: "pass" }, { id: "core", share: 0.2, assessed: false }] });
    audit.contract = audit.contract.filter((c) => c.component !== "core");
    const r = reportFor(audit);
    const roadmap = { schema: "agent-readiness/roadmap@1" as const, owner: null, targets: null, items: [], updatedBy: audit.id, updatedAt: "2026-10-27T15:00:00.000Z" };
    assert.deepEqual(consistencyErrors(audit, r, roadmap), []);
    audit.contract.push({ id: "cmd-core-test", kind: "test", component: "core", cwd: "core", command: "dotnet test", source: "agent", reason: "", timeoutSec: 60 });
    audit.contract.push({ id: "cmd-ghost-test", kind: "test", component: "ghost", cwd: "ghost", command: "npm test", source: "agent", reason: "", timeoutSec: 60 });
    audit.evidence.push({ ...audit.evidence[0], id: "ev-900", component: "ghost" });
    audit.narration = { gaps: { "faults:ghost": "Ghost tests miss bugs" }, titles: { "clean.test:ghost": "Fix ghost" } };
    const errors = consistencyErrors(audit, r, roadmap);
    assert.equal(errors.length, 5, errors.join("\n"));
    assert.match(errors[0], /cmd-core-test names core, which isn't assessed/);
    assert.match(errors[1], /cmd-ghost-test names ghost, which the scan didn't find/);
    assert.match(errors[2], /evidence ev-900 names ghost/);
    assert.match(errors[3], /rewrites gap faults:ghost, which isn't in part 1/);
    assert.match(errors[4], /retitles clean\.test:ghost, which isn't a roadmap item/);
  });

  test("scenario labels keep their acronyms, and the heading carries no activity", () => {
    const r = reportFor(makeAudit({ ...mixed, scenarios: [{ id: "first_pr", components: ["*"] }] }));
    assert.equal(r.executive.heading, "Level 0 of 4, not bootable");
    assert.equal(r.components.included[0].scenarios[0].label, "First PR");
    assert.match(renderMarkdown(r, rubric), /\| `api` › First PR \|/);
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

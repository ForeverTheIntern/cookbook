import assert from "node:assert/strict";
import { test } from "node:test";
import { tick } from "../bot/lib/pipeline/dispatch.ts";
import { fromGitHub } from "../bot/lib/pipeline/ingress.ts";
import { MAX_FAILURES } from "../bot/lib/pipeline/reconcile.ts";
import {
  agentFor, gateIn, withoutStep, comment, deliver, finishStep, hooks, makeCtx, results, runtimeOf, send, slackPostCount, startRun, testConfig, tickAndDrain, toSpecGate, World,
} from "./fakes.ts";

test("happy path: label to merge, with questions, both gates and a review send-back", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { issue, run } = await startRun(world, ctx);
  const stage = async () => (await ctx.store.getRun(run))!.stage;

  assert.equal(await stage(), "triage");
  assert.equal(world.branches.get(`factory/${run}`), "base0");
  assert.match(agentFor(world, run).launch.prompt, /# Triage/);

  await finishStep(world, ctx, run, results.triage(run));
  assert.equal(await stage(), "spec");

  await finishStep(world, ctx, run, results.spec(run, 1));
  let r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "awaiting_clarification");
  assert.equal(world.pulls.get(r.pr!)!.draft, true, "the draft PR opens when PM first writes the spec");
  assert.match(world.issues.get(issue)!.comments.at(-1)!.body, /Who uses it\?/);

  await comment(world, ctx, issue, "bob", "Admins and auditors.");
  assert.equal(await stage(), "spec");
  assert.match(agentFor(world, run).launch.prompt, /@bob: Admins and auditors\./);

  await finishStep(world, ctx, run, results.spec(run, 2));
  assert.equal(await stage(), "awaiting_spec_approval");
  assert.match(world.issues.get(issue)!.comments.at(-1)!.body, /Spec gate/);

  await comment(world, ctx, issue, "alice", "approve");
  assert.equal(await stage(), "plan");

  await finishStep(world, ctx, run, results.plan(run));
  r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "awaiting_plan_approval");

  world.label(r.pr!, "alice", "factory:plan-approved");
  await deliver(ctx, "pull_request", hooks.prLabeled(world, r.pr!, "factory:plan-approved"));
  assert.equal(await stage(), "implement");

  await finishStep(world, ctx, run, results.implement(run));
  await finishStep(world, ctx, run, results.verdict(run, "review", "changes"));
  assert.equal(await stage(), "implement");
  assert.match(agentFor(world, run).launch.prompt, /Handle the empty case/);

  await finishStep(world, ctx, run, results.implement(run, 2));
  await finishStep(world, ctx, run, results.verdict(run, "review", "pass"));
  await finishStep(world, ctx, run, results.verdict(run, "verify", "pass"));
  r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "awaiting_merge");
  assert.equal(world.pulls.get(r.pr!)!.draft, false);
  assert.equal(world.pulls.get(r.pr!)!.reviews.length, 3);

  world.merge(r.pr!, "alice");
  await deliver(ctx, "pull_request", hooks.prClosed(world, r.pr!));
  r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "done");
  assert.equal((await ctx.store.transitions(run)).at(-1)!.actor, "alice");
  assert.equal(world.issues.get(issue)!.closedAs, "completed", "the factory closes the issue; GitHub does not when base is not the default branch");

  assert.deepEqual(
    (await ctx.store.transitions(run)).map((t) => t.stage),
    ["intake", "triage", "spec", "awaiting_clarification", "spec", "awaiting_spec_approval", "plan", "awaiting_plan_approval",
      "implement", "review", "implement", "review", "verify", "awaiting_merge", "done"],
  );
  assert.equal((await ctx.store.roleRuns(run)).length, 9, "one agent per role visit");
  assert.equal(world.slackPosts.filter((p) => p.threadTs === null).length, 1, "one Slack thread per run");
  assert.equal(world.slackPosts.length, (await slackPostCount(ctx, run)) + 1);
});

test("replay: duplicate and late deliveries change nothing", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const a = await toSpecGate(world, ctx, "First");
  const b = await startRun(world, ctx, "Second");
  const snapshot = () => ({ comments: world.issues.get(a.issue)!.comments.length, slack: world.slackPosts.length, agents: world.agents.size });

  const late = snapshot();
  const label = hooks.labeled(world, a.issue, "factory:run");
  assert.equal((await deliver(ctx, "issues", { ...label, issue: { ...label.issue, updated_at: "2026-10-21T10:00:00Z" } }))?.kind, "intake");
  assert.deepEqual(snapshot(), late, "a late intake label for a running run starts nothing");
  assert.equal((await ctx.store.getRun(a.run))!.stage, "awaiting_spec_approval");

  const approve = world.say(a.issue, "alice", "approve");
  const delivery = hooks.comment(a.issue, approve);
  assert.notEqual(await deliver(ctx, "issue_comment", delivery), null);
  assert.equal((await ctx.store.getRun(a.run))!.stage, "plan");
  const once = snapshot();
  assert.notEqual(await deliver(ctx, "issue_comment", delivery), null);
  assert.deepEqual(snapshot(), once, "the same delivery twice has its effects once");
  assert.equal((await ctx.store.getRun(a.run))!.stage, "plan");

  const before = snapshot();
  for (let i = 0; i < 5; i += 1) {
    for (const run of [a.run, b.run]) await send(ctx, { kind: "reconcile", runId: run, why: `replay ${i}` });
  }
  await tick(runtimeOf(ctx));
  assert.deepEqual(snapshot(), before);
  assert.equal((await ctx.store.getRun(b.run))!.stage, "triage");
});

test("gate authority: non-approvers are ignored, stale votes do not count, changes go back", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const stage = async () => (await ctx.store.getRun(run))!.stage;
  const early = world.openIssue("Early");
  const { issue, run } = await startRun(world, ctx, "Gated");
  assert.equal(early, 1);
  await finishStep(world, ctx, run, results.triage(run));
  world.say(issue, "alice", "approve");
  await finishStep(world, ctx, run, results.spec(run, 2));
  assert.equal(await stage(), "awaiting_spec_approval", "an approval before the gate opened is stale");

  await comment(world, ctx, issue, "mallory", "approve");
  assert.equal(await stage(), "awaiting_spec_approval");
  assert.match(world.issues.get(issue)!.comments.at(-1)!.body, /@mallory is not an approver/);

  const promoted = makeCtx(world, testConfig((doc) => { gateIn(doc, "spec").approvers = ["alice", "mallory"]; }), ctx.store);
  await tickAndDrain(promoted, world);
  assert.equal(await stage(), "awaiting_spec_approval", "a refused vote stays refused after its author becomes an approver");

  await comment(world, ctx, (await ctx.store.getRun(run))!.pr!, "alice", "changes: say which formats", true);
  assert.equal(await stage(), "spec");
  assert.match(agentFor(world, run).launch.prompt, /say which formats/);

  await finishStep(world, ctx, run, results.spec(run, 2));
  assert.equal(await stage(), "awaiting_spec_approval");
  await tickAndDrain(ctx, world);
  assert.equal(await stage(), "awaiting_spec_approval", "the first approve and the changes are now stale");

  world.push(`factory/${run}`, { "specs/f-gh-2.md": "edited by hand" });
  await comment(world, ctx, issue, "alice", "approve");
  assert.equal(await stage(), "awaiting_spec_approval", "the branch moved, so the gate reset first");
  assert.ok(world.issues.get(issue)!.comments.some((c) => /Earlier approvals are stale/.test(c.body)));

  await comment(world, ctx, issue, "alice", "approve");
  assert.equal(await stage(), "plan");
});

test("failure: an errored agent holds the run, retry by an approver resumes it", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { issue, run } = await startRun(world, ctx);
  world.finish(agentFor(world, run).id, {}, "ERROR");
  await tickAndDrain(ctx, world);
  let r = (await ctx.store.getRun(run))!;
  assert.match(r.hold!, /triage ended with ERROR/);
  assert.match(world.issues.get(issue)!.comments.at(-1)!.body, /comments `retry`/);

  await comment(world, ctx, issue, "mallory", "retry");
  assert.notEqual((await ctx.store.getRun(run))!.hold, null);
  await comment(world, ctx, issue, "alice", "retry");
  r = (await ctx.store.getRun(run))!;
  assert.equal(r.hold, null);
  assert.equal(r.stage, "triage");
  await finishStep(world, ctx, run, results.triage(run));
  assert.equal((await ctx.store.getRun(run))!.stage, "spec");
});

test("failure: wrong files, no push, a broken result and the deadline all hold", async () => {
  const world = new World();
  const ctx = makeCtx(world, testConfig((d) => (d.limits = { runsPerRepo: 10, runsTotal: 10 })));
  const cases: [Record<string, string> | "deadline", RegExp][] = [
    [{ "src/app.ts": "x", ...results.triage("f-gh-1") }, /changed src\/app\.ts/],
    [{}, /pushed nothing/],
    [{ ".factory/f-gh-3/triage.json": "{" }, /triage\.json/],
    ["deadline", /did not finish within 20 minutes/],
  ];
  for (const [files, reason] of cases) {
    const { run } = await startRun(world, ctx);
    if (files === "deadline") {
      world.advance(21);
      await tickAndDrain(ctx, world);
    } else {
      await finishStep(world, ctx, run, files);
    }
    assert.match((await ctx.store.getRun(run))!.hold ?? "", reason);
  }
});

test("restart: a runtime on the same store resumes from GitHub", async () => {
  const world = new World();
  const first = makeCtx(world);
  const { issue, run } = await toSpecGate(world, first);
  world.say(issue, "alice", "approve");

  const second = makeCtx(world, first.config, first.store);
  assert.notEqual(await tick(runtimeOf(second)), null);
  assert.equal((await second.store.getRun(run))!.stage, "plan");
  assert.equal(world.running().length, 1);
});

test("a reconcile that keeps failing holds its run on the third failure in a row", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { run } = await startRun(world, ctx);
  const broken = { ...ctx, ports: { ...ctx.ports, agents: { ...ctx.ports.agents, status: async () => { throw new Error("API down"); } } } };
  for (let i = 1; i < MAX_FAILURES; i += 1) {
    await send(broken, { kind: "reconcile", runId: run, why: "poke" });
    assert.equal((await ctx.store.getRun(run))!.hold, null, `failure ${i} of ${MAX_FAILURES} does not hold yet`);
    assert.equal((await ctx.store.doc(run))!.failures, i);
  }
  await send(broken, { kind: "reconcile", runId: run, why: "poke" });
  assert.match((await ctx.store.getRun(run))!.hold!, /could not reconcile it 3 times in a row: API down/);
});

test("ticks alone hold a run whose agent status keeps failing", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { run } = await startRun(world, ctx);
  const broken = { ...ctx, ports: { ...ctx.ports, agents: { ...ctx.ports.agents, status: async () => { throw new Error("API down"); } } } };
  for (let i = 0; i < MAX_FAILURES; i += 1) {
    world.advance(1);
    await tick(runtimeOf(broken));
  }
  assert.match((await ctx.store.getRun(run))!.hold!, /could not reconcile it 3 times in a row: API down/);
});

test("a successful reconcile resets the failure count", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { run } = await startRun(world, ctx);
  const broken = { ...ctx, ports: { ...ctx.ports, agents: { ...ctx.ports.agents, status: async () => { throw new Error("API down"); } } } };
  for (let i = 1; i < MAX_FAILURES; i += 1) await send(broken, { kind: "reconcile", runId: run, why: "poke" });
  await send(ctx, { kind: "reconcile", runId: run, why: "poke" });
  assert.equal((await ctx.store.doc(run))!.failures, 0);
  await send(broken, { kind: "reconcile", runId: run, why: "poke" });
  assert.equal((await ctx.store.getRun(run))!.hold, null, "the count started again");
});

test("duplicate: triage closes the issue and the run", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { issue, run } = await startRun(world, ctx);
  await finishStep(world, ctx, run, results.triage(run, [{ url: "https://github.com/acme/app/issues/9", reason: "Same export." }]));
  assert.equal((await ctx.store.getRun(run))!.stage, "closed");
  assert.equal(world.issues.get(issue)!.closedAs, "not_planned");
  assert.match(world.issues.get(issue)!.comments.at(-1)!.body, /duplicate of:[\s\S]*issues\/9/);
});

test("merge: the run closes its issue once, and leaves one GitHub already closed alone", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const closes: number[] = [];
  const github = ctx.ports.github;
  const counted = { ...ctx, ports: { ...ctx.ports, github: { ...github, closeIssue: async (n: number, reason: "completed" | "not_planned") => { closes.push(n); await github.closeIssue(n, reason); } } } };
  const a = await toSpecGate(world, counted, "Merged into a non-default base");
  const b = await toSpecGate(world, counted, "Merged into the default branch");
  for (const { run } of [a, b]) world.merge((await ctx.store.getRun(run))!.pr!, "alice");
  Object.assign(world.issues.get(b.issue)!, { state: "closed", closedAs: "completed" });
  await tickAndDrain(counted, world);
  for (const { run } of [a, b]) await deliver(counted, "pull_request", hooks.prClosed(world, (await ctx.store.getRun(run))!.pr!));
  assert.deepEqual([(await ctx.store.getRun(a.run))!.stage, (await ctx.store.getRun(b.run))!.stage], ["done", "done"]);
  assert.equal(world.issues.get(a.issue)!.closedAs, "completed");
  assert.deepEqual(closes, [a.issue]);
  assert.match(world.issues.get(a.issue)!.comments.at(-1)!.body, /Merged in #\d+\. Run closed\./);
});

test("closing the issue on GitHub closes the run", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { issue, run } = await toSpecGate(world, ctx);
  world.issues.get(issue)!.state = "closed";
  await tickAndDrain(ctx, world);
  assert.equal((await ctx.store.getRun(run))!.stage, "closed");
});

test("slack: a top-level mention opens one issue and its thread is the run thread", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const mention = { kind: "slack_intake" as const, repo: ctx.config.repo, channel: "C0FACTORY", ts: "100.1", text: "<@U1> please open an issue: please add dark mode", user: "U2" };
  await send(ctx, mention);
  const once = { issues: world.issues.size, slack: world.slackPosts.length };
  await send(ctx, mention);
  assert.deepEqual({ issues: world.issues.size, slack: world.slackPosts.length }, once, "the same mention twice opens one issue and posts once");
  assert.equal(world.issues.get(1)!.title, "Add dark mode");
  const r = (await ctx.store.getRun("f-gh-1"))!;
  assert.equal(r.requestTs, "100.1");
  assert.equal(r.requester, "U2");
  assert.equal(r.stage, "triage");
  const status = world.slackPosts.filter((p) => p.threadTs === null);
  assert.equal(status.length, 1, "one top-level status message");
  assert.equal(r.statusTs, status[0].ts);
  assert.equal(r.slackTs, r.statusTs, "the status message's thread is the run thread");
  const underRequest = world.slackPosts.filter((p) => p.threadTs === "100.1");
  assert.equal(underRequest.length, 1, "Foreman replies once under the request");
  assert.match(underRequest[0].text, /Opened <.*#1 Add dark mode>.*its status thread/);
  assert.ok(underRequest[0].text.includes(`p${r.statusTs!.replace(".", "")}`), "and links the status thread");
  assert.ok(world.slackPosts.filter((p) => p.threadTs !== null && p !== underRequest[0]).every((p) => p.threadTs === r.statusTs), "every follow-up goes to the status thread");
  assert.equal((await ctx.store.runByThread("C0FACTORY", "100.1"))!.id, r.id, "both threads find the run");
  assert.equal((await ctx.store.runByThread("C0FACTORY", r.statusTs!))!.id, r.id);
});

test("slack: an answer relayed by Foreman reaches PM through the issue", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { issue, run } = await startRun(world, ctx);
  await finishStep(world, ctx, run, results.triage(run));
  await finishStep(world, ctx, run, results.spec(run, 0));
  assert.equal((await ctx.store.getRun(run))!.stage, "awaiting_clarification");
  world.advance(1);
  await send(ctx, { kind: "answer", runId: run, text: "Only admins." });
  await send(ctx, { kind: "answer", runId: run, text: "Only admins." });
  const relayed = world.issues.get(issue)!.comments.filter((c) => /Answer relayed from Slack/.test(c.body));
  assert.equal(relayed.length, 1, "the same answer twice is relayed once");
  assert.match(relayed[0].body, /Answer relayed from Slack[\s\S]*Only admins\./);
  assert.equal((await ctx.store.getRun(run))!.stage, "spec");
  assert.match((await ctx.store.transitions(run)).at(-1)!.reason, /^answered in Slack, relayed by @/);
  assert.match(agentFor(world, run).launch.prompt, /Only admins\./);
});

test("gates can be turned off and review removed from steps:", async () => {
  const world = new World();
  const ctx = makeCtx(world, testConfig((doc) => {
    gateIn(doc, "spec").enabled = false;
    gateIn(doc, "plan").enabled = false;
    withoutStep(doc, "review");
    delete doc.slack;
  }));
  const { run } = await startRun(world, ctx);
  await finishStep(world, ctx, run, results.triage(run));
  await finishStep(world, ctx, run, results.spec(run, 2));
  assert.equal((await ctx.store.getRun(run))!.stage, "plan");
  await finishStep(world, ctx, run, results.plan(run));
  await finishStep(world, ctx, run, results.implement(run));
  assert.equal((await ctx.store.getRun(run))!.stage, "verify");
});

test("ingress ignores a labeled delivery with no label", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const issue = world.openIssue("x");
  const hook = hooks.labeled(world, issue, "factory:run") as any;
  delete hook.label;
  assert.equal(await fromGitHub(ctx.store, [ctx.config], "issues", hook), null);
});

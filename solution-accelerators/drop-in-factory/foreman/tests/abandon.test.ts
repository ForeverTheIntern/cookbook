import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch, slackMention } from "../bot/lib/pipeline/dispatch.ts";
import { slackCommandOf } from "../bot/lib/pipeline/gates.ts";
import type { Ctx } from "../bot/lib/pipeline/reconcile.ts";
import { agentFor, deliver, finishStep, hooks, makeCtx, results, runtimeOf, startRun, testConfig, tickAndDrain, World } from "./fakes.ts";

const CHANNEL = "C0FACTORY";

/** A run asked for in Slack by U2, at the spec gate with a draft PR open. */
const REQUEST = "<@U1> please add CSV export to the invoices page";

async function slackRun(world: World, ctx: Ctx, ts = "100.1", text = REQUEST) {
  await dispatch(runtimeOf(ctx), { kind: "slack_intake", repo: ctx.config.repo, channel: CHANNEL, ts, text, user: "U2" });
  const run = (await ctx.store.runByThread(CHANNEL, ts))!;
  await finishStep(world, ctx, run.id, results.triage(run.id));
  await finishStep(world, ctx, run.id, results.spec(run.id, 2));
  return (await ctx.store.getRun(run.id))!;
}

const say = (ctx: Ctx, world: World, runId: string, threadTs: string, user: string, text: string) => {
  world.advance(1);
  return slackMention(runtimeOf(ctx), { runId, channel: CHANNEL, threadTs, ts: `${world.clock / 1000}`, user, text });
};

function assertAbandoned(world: World, run: { issue: number; pr: number | null }, reason: RegExp) {
  const issue = world.issues.get(run.issue)!;
  assert.equal(issue.state, "closed");
  assert.equal(issue.closedAs, "not_planned");
  assert.ok(issue.applied.includes("abandoned"));
  assert.equal(world.pulls.get(run.pr!)!.state, "closed");
  assert.equal(world.pulls.get(run.pr!)!.merged, false);
  const abandoning = issue.comments.find((c) => c.body.includes("**Abandoning**"))!;
  assert.match(abandoning.body, reason);
  const pm = issue.comments.find((c) => c.body.includes(":postmortem -->"))!;
  assert.match(pm.body, reason);
  assert.ok(world.slackPosts.some((p) => /post-mortem/i.test(p.text) || /post-mortem/i.test(JSON.stringify(p.blocks ?? []))));
}

test("abandon with a reason from the status thread: record, PR closed, issue not planned, post-mortem", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRun(world, ctx);

  assert.equal(await say(ctx, world, run.id, run.slackTs!, "U2", "abandon: the customer cancelled"), true);
  const after = (await ctx.store.getRun(run.id))!;
  assert.equal(after.stage, "abandoned");
  assert.equal(after.abandon!.postmortem, true);
  assertAbandoned(world, after, /the customer cancelled/);
});

test("abandon without a reason asks for one; the next reply is the reason", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRun(world, ctx);

  await say(ctx, world, run.id, run.slackTs!, "U2", "close");
  let r = (await ctx.store.getRun(run.id))!;
  assert.equal(r.stage, "awaiting_spec_approval");
  const asked = world.slackPosts.find((p) => p.text.includes("Give a one-line reason first"))!;
  assert.match(asked.text, /<@U2>/);
  assert.match(asked.text, /@foreman abandon: no longer needed/);

  await say(ctx, world, run.id, run.slackTs!, "U2", "dark mode moved to the design system team");
  r = (await ctx.store.getRun(run.id))!;
  assert.equal(r.stage, "abandoned");
  assertAbandoned(world, r, /design system team/);
});

test("a stranger cannot abandon, from either thread", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRun(world, ctx);

  await say(ctx, world, run.id, "100.1", "U9", "abandon: not needed");
  assert.equal((await ctx.store.getRun(run.id))!.stage, "awaiting_spec_approval");
  assert.match(world.slackPosts.at(-1)!.text, /^Only <@U2> \(who asked\) can approve, ask for changes or abandon this run\./);
  assert.equal(world.issues.get(run.issue)!.state, "open");
});

test("the wastebasket reaction on the status message asks for a reason, then abandons; running agents stop", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  await dispatch(runtimeOf(ctx), { kind: "slack_intake", repo: ctx.config.repo, channel: CHANNEL, ts: "100.1", text: "<@U1> add dark mode", user: "U2" });
  const run = (await ctx.store.runByThread(CHANNEL, "100.1"))!;
  await finishStep(world, ctx, run.id, results.triage(run.id));
  const pmAgent = agentFor(world, run.id);
  const statusTs = (await ctx.store.getRun(run.id))!.statusTs!;

  world.react(CHANNEL, statusTs, "wastebasket", "U9");
  world.react(CHANNEL, statusTs, "wastebasket", "U2");
  await tickAndDrain(ctx, world);
  assert.equal((await ctx.store.getRun(run.id))!.stage, "spec");
  assert.ok(world.slackPosts.some((p) => p.text.startsWith("<@U9>, your :wastebasket: doesn't count")));
  assert.ok(world.slackPosts.some((p) => p.text.includes("Give a one-line reason first")));

  const r0 = (await ctx.store.getRun(run.id))!;
  await say(ctx, world, run.id, r0.slackTs!, "U2", "abandon: duplicate of the theming epic");
  const r = (await ctx.store.getRun(run.id))!;
  assert.equal(r.stage, "abandoned");
  assert.equal(world.agents.get(pmAgent.id)!.status, "EXPIRED", "the running PM agent was stopped");
  assert.equal(world.running().length, 0);
  const issue = world.issues.get(run.issue)!;
  assert.equal(issue.closedAs, "not_planned");
  assert.ok(issue.comments.some((c) => c.body.includes(":postmortem -->") && /duplicate of the theming epic/.test(c.body)));
});

test("a run closed by hand on GitHub asks why in Slack and writes the post-mortem from the answer", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRun(world, ctx);

  world.closeByHand(run.issue, "alice");
  await deliver(ctx, "issues", { action: "closed", issue: { number: run.issue }, repository: { full_name: world.repo } });
  let r = (await ctx.store.getRun(run.id))!;
  assert.equal(r.stage, "closed");
  assert.equal(r.abandon!.postmortem, false);
  assert.ok(world.slackPosts.some((p) => p.text.includes("Why was it stopped?") && p.text.includes("<@U2>")));

  await say(ctx, world, run.id, r.slackTs!, "U2", "we bought a vendor tool instead");
  r = (await ctx.store.getRun(run.id))!;
  assert.equal(r.abandon!.postmortem, true);
  const pm = world.issues.get(run.issue)!.comments.find((c) => c.body.includes(":postmortem -->"))!;
  assert.match(pm.body, /we bought a vendor tool instead/);
  assert.match(pm.body, /@alice, on GitHub/);
});

test("closed by hand with no Slack thread writes the post-mortem at once", async () => {
  const world = new World();
  const ctx = makeCtx(world, undefined);
  (ctx as { ports: any }).ports = { ...ctx.ports, slack: null };
  const { issue, run } = await startRun(world, ctx);
  world.closeByHand(issue, "alice");
  await deliver(ctx, "issues", { action: "closed", issue: { number: issue }, repository: { full_name: world.repo } });
  const r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "closed");
  assert.equal(r.abandon!.postmortem, true);
  assert.ok(world.issues.get(issue)!.comments.some((c) => c.body.includes(":postmortem -->") && /no reason was given/.test(c.body)));
});

test("asking again for an abandoned request links the abandoned run and its reason", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRun(world, ctx);
  await say(ctx, world, run.id, run.slackTs!, "U2", "abandon: the customer cancelled");
  const issues = world.issues.size;

  world.advance(60);
  await dispatch(runtimeOf(ctx), { kind: "slack_intake", repo: ctx.config.repo, channel: CHANNEL, ts: "200.1", text: REQUEST, user: "U3" });
  assert.equal(world.issues.size, issues, "no new issue");
  const reply = world.slackPosts.filter((p) => p.threadTs === "200.1").at(-1)!;
  assert.match(reply.text, new RegExp(`asked before as run \\*${run.id}\\*`));
  assert.match(reply.text, /abandoned on \d{4}-\d\d-\d\d: the customer cancelled/);
});

test("triage sees abandoned work as related history", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRun(world, ctx);
  await say(ctx, world, run.id, run.slackTs!, "U2", "abandon: the customer cancelled");

  const next = await startRun(world, ctx, "Export invoices as CSV");
  assert.match(agentFor(world, next.run).launch.prompt, new RegExp(`issue #${run.issue} \\(closed, abandoned\\)`));
});

test("slack commands: abandon and close, with or without a reason", () => {
  assert.deepEqual(slackCommandOf("abandon: no longer needed"), { kind: "abandon", reason: "no longer needed" });
  assert.deepEqual(slackCommandOf("Close - dup of #12"), { kind: "abandon", reason: "dup of #12" });
  assert.deepEqual(slackCommandOf("abandon"), { kind: "abandon", reason: null });
  assert.equal(slackCommandOf("closer look please"), null);
  assert.equal(slackCommandOf("approve")?.kind, "approve");
});

test("ended runs stay ended: abandon after merge is refused", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRun(world, ctx);
  world.merge(run.pr!, "alice");
  await deliver(ctx, "pull_request", hooks.prClosed(world, run.pr!));
  assert.equal((await ctx.store.getRun(run.id))!.stage, "done");
  await say(ctx, world, run.id, run.slackTs!, "U2", "abandon: too late");
  assert.match(world.slackPosts.at(-1)!.text, /already ended \(done\)/);
});

test("post-mortem: a Slack request whose body repeats its title is asked once, and the stage count matches the path", async () => {
  const { postMortem } = await import("../bot/lib/pipeline/postmortem.ts");
  const stages = ["intake", "triage", "spec", "awaiting_clarification", "abandoned"] as const;
  const doc = {
    run: { id: "f-gh-115", handled: [] } as any,
    transitions: stages.map((stage, i) => ({ seq: i + 1, runId: "f-gh-115", stage, at: "", reason: "" })) as any,
    roles: [],
  };
  const { issue } = postMortem(testConfig(), doc, { title: "Add docs/roadmap.md with three placeholder milestones", body: "add docs/roadmap.md with three placeholder milestones\n\n_Requested in Slack._" }, "testing");
  assert.match(issue, /\*\*Asked:\*\* Add docs\/roadmap\.md with three placeholder milestones\n/);
  assert.match(issue, /after 4 stage changes \(intake → triage → spec → awaiting_clarification → abandoned\)/);
});

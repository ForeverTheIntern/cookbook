import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch, slackMention } from "../bot/lib/pipeline/dispatch.ts";
import { FACTORY_MARK } from "../bot/lib/pipeline/gates.ts";
import { agentFor, finishStep, makeCtx, results, runtimeOf, testConfig, tickAndDrain, World } from "./fakes.ts";
import type { Ctx } from "../bot/lib/pipeline/reconcile.ts";

const CHANNEL = "C0FACTORY";
const REQUEST_TS = "100.1";

/** A run asked for in Slack by U2, driven to the spec gate. */
async function slackRunAtGate(world: World, ctx: Ctx) {
  await dispatch(runtimeOf(ctx), { kind: "slack_intake", repo: ctx.config.repo, channel: CHANNEL, ts: REQUEST_TS, text: "<@U1> please add dark mode", user: "U2" });
  const run = (await ctx.store.runByThread(CHANNEL, REQUEST_TS))!;
  await finishStep(world, ctx, run.id, results.triage(run.id));
  await finishStep(world, ctx, run.id, results.spec(run.id, 2));
  const atGate = (await ctx.store.getRun(run.id))!;
  assert.equal(atGate.stage, "awaiting_spec_approval");
  return atGate;
}

const mention = (ctx: Ctx, runId: string, threadTs: string, user: string, text: string) =>
  slackMention(runtimeOf(ctx), { runId, channel: CHANNEL, threadTs, ts: `${Date.now()}.${Math.random()}`, user, text });

test("follow-ups go to the status thread; the request thread gets one reply linking it", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRunAtGate(world, ctx);

  const top = world.slackPosts.filter((p) => p.threadTs === null);
  assert.equal(top.length, 1, "one status message in the channel");
  assert.equal(top[0].ts, run.slackTs);
  assert.ok(Array.isArray(top[0].blocks) && top[0].blocks.length > 0, "the status message is Block Kit");

  const inRequest = world.slackPosts.filter((p) => p.threadTs === REQUEST_TS);
  assert.equal(inRequest.length, 1);
  assert.match(inRequest[0].text, /status thread/);
  assert.ok(inRequest[0].text.includes(run.slackTs!.replace(".", "")), "the reply links the status thread");

  const followUps = world.slackPosts.filter((p) => p.threadTs !== null && p.threadTs !== REQUEST_TS);
  assert.ok(followUps.length >= 3);
  assert.ok(followUps.every((p) => p.threadTs === run.slackTs), "every follow-up is in the status thread");
});

test("asks mention the requester and end with a reply hint, in Slack and on the issue", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRunAtGate(world, ctx);

  const askPost = world.slackPosts.find((p) => p.ts === run.askTs)!;
  assert.match(askPost.text, /<@U2>/);
  assert.match(askPost.text, /@foreman approve/);
  assert.match(askPost.text, /:white_check_mark:/);
  assert.ok(Array.isArray(askPost.blocks));

  const gateComment = world.issues.get(run.issue)!.comments.find((c) => c.body.includes(`${FACTORY_MARK}:gate:`))!;
  assert.match(gateComment.body, /_To respond, comment `approve` or `changes: <what to change>`/);

  const launches = world.slackPosts.filter((p) => /agent started/.test(p.text));
  assert.ok(launches.length >= 2);
  assert.ok(launches.every((p) => /cursor\.com\/agents\//.test(JSON.stringify(p.blocks))), "agent notices link the Cursor session");
});

test("an approval in the request thread counts, and the reply points to the status thread", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRunAtGate(world, ctx);

  assert.equal(await mention(ctx, run.id, REQUEST_TS, "U2", "approve"), true);
  const after = (await ctx.store.getRun(run.id))!;
  assert.equal(after.stage, "plan");
  const reply = world.slackPosts.filter((p) => p.threadTs === REQUEST_TS).at(-1)!;
  assert.match(reply.text, /^Done\. Updates for run/);
  assert.ok(world.issues.get(run.issue)!.comments.some((c) => /Approved by @person-U2 via Slack reply/.test(c.body)));
});

test("an approval in the status thread from someone else is refused with who may approve", async () => {
  const world = new World();
  const ctx = makeCtx(world, testConfig((doc) => (doc.slack.approvers = ["U7"])));
  const run = await slackRunAtGate(world, ctx);

  assert.equal(await mention(ctx, run.id, run.slackTs!, "U9", "approve"), true);
  assert.equal((await ctx.store.getRun(run.id))!.stage, "awaiting_spec_approval");
  const reply = world.slackPosts.at(-1)!;
  assert.equal(reply.threadTs, run.slackTs);
  assert.match(reply.text, /Only <@U2> \(who asked\), <@U7> can approve/);

  assert.equal(await mention(ctx, run.id, run.slackTs!, "U7", "changes: cover high contrast too"), true);
  const back = (await ctx.store.getRun(run.id))!;
  assert.equal(back.stage, "spec");
  assert.match(agentFor(world, run.id).launch.prompt, /cover high contrast too/);
});

test("plain chat in a run thread is not a command", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRunAtGate(world, ctx);
  assert.equal(await mention(ctx, run.id, run.slackTs!, "U2", "what is the spec about?"), false);
  assert.equal((await ctx.store.getRun(run.id))!.stage, "awaiting_spec_approval");
});

test("reactions: a stranger is told once who can approve; the requester's reaction approves", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRunAtGate(world, ctx);

  world.react(CHANNEL, run.askTs!, "white_check_mark", "U9");
  await tickAndDrain(ctx, world);
  await tickAndDrain(ctx, world);
  assert.equal((await ctx.store.getRun(run.id))!.stage, "awaiting_spec_approval");
  const notices = world.slackPosts.filter((p) => p.text.includes("<@U9>, your :white_check_mark: doesn't count"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /only <@U2> \(who asked\)/);

  world.react(CHANNEL, run.askTs!, "white_check_mark", "U2");
  await tickAndDrain(ctx, world);
  assert.equal((await ctx.store.getRun(run.id))!.stage, "plan");
  assert.ok(world.issues.get(run.issue)!.comments.some((c) => /Approved by @person-U2 via Slack reaction/.test(c.body) && /reaction :white_check_mark:/.test(c.body)));
});

test("reactions: the reject reaction asks for changes; reactions on other messages do not count", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRunAtGate(world, ctx);

  world.react(CHANNEL, run.slackTs!, "white_check_mark", "U2");
  await tickAndDrain(ctx, world);
  assert.equal((await ctx.store.getRun(run.id))!.stage, "awaiting_spec_approval", "an approve reaction counts only on the ask");

  world.react(CHANNEL, run.askTs!, "x", "U2");
  await tickAndDrain(ctx, world);
  assert.equal((await ctx.store.getRun(run.id))!.stage, "spec");
});

test("the issue has one status comment, edited in place as the run moves", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackRunAtGate(world, ctx);

  const status = world.issues.get(run.issue)!.comments.filter((c) => c.body.includes(`${FACTORY_MARK}:status -->`));
  assert.equal(status.length, 1);
  const current = world.edited.get(status[0].id) ?? status[0].body;
  assert.match(current, /\*\*awaiting_spec_approval\*\*/);
  assert.match(current, /Slack status thread: /);
  assert.ok(world.edited.size > 0, "the comment was edited, not reposted");
});

/**
 * Every message Foreman posts, as a transcript per scenario, compared with
 * foreman/tests/snapshots/messages/<scenario>.md. The wording lives in
 * foreman/bot/templates/; a change to a template shows here as a diff to
 * review. After a deliberate rewording, rewrite the snapshots with
 * `UPDATE_SNAPSHOTS=1 npm test` and commit them with the template.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatch, slackMention } from "../bot/lib/pipeline/dispatch.ts";
import type { Ctx } from "../bot/lib/pipeline/reconcile.ts";
import { comment, deliver, finishStep, hooks, makeCtx, results, runtimeOf, startRun, testConfig, tickAndDrain, World } from "./fakes.ts";

const SNAPSHOTS = fileURLToPath(new URL("./snapshots/messages/", import.meta.url));
const CHANNEL = "C0FACTORY";

/** Everything the world saw Foreman post, in a stable, readable order. */
function transcript(world: World): string {
  const out: string[] = [];
  const fence = (text: string) => ["````", text, "````"];
  out.push("# Slack posts", "");
  for (const p of world.slackPosts) {
    out.push(`## ${p.ts} in ${p.channel}${p.threadTs === null ? "" : ` thread ${p.threadTs}`}`, "", ...fence(p.text));
    if (p.blocks !== undefined) out.push("", ...fence(JSON.stringify(p.blocks, null, 1)));
    out.push("");
  }
  out.push("# Slack edits", "");
  for (const e of world.slackEdits) {
    out.push(`## edit of ${e.ts}`, "", ...fence(e.text));
    if (e.blocks !== undefined) out.push("", ...fence(JSON.stringify(e.blocks, null, 1)));
    out.push("");
  }
  out.push("# Slack uploads", "");
  for (const u of world.slackUploads) out.push(`## ${u.name} (${u.bytes} bytes) in thread ${u.threadTs}`, "", ...fence(u.text), "");
  out.push("# GitHub", "");
  for (const [n, issue] of world.issues) {
    out.push(`## issue #${n} ${issue.title} (${issue.state}${issue.closedAs === null ? "" : `, ${issue.closedAs}`}${issue.applied.length === 0 ? "" : `, labels ${issue.applied.join(", ")}`})`, "");
    for (const c of issue.comments.filter((c) => c.login === "factory-bot" || c.login === "operator")) {
      out.push(`### ${c.login} comment ${c.id}`, "", ...fence(world.edited.get(c.id) ?? c.body), "");
    }
  }
  for (const [n, pull] of world.pulls) {
    out.push(`## pull #${n} (${pull.state}${pull.draft ? ", draft" : ""})`, "");
    for (const c of pull.comments.filter((c) => c.login === "factory-bot")) out.push(`### comment ${c.id}`, "", ...fence(c.body), "");
    pull.reviews.forEach((r, i) => out.push(`### review ${i + 1}`, "", ...fence(r), ""));
  }
  // The factory id is random per store; everything else is deterministic.
  return `${out.join("\n").trimEnd()}\n`.replace(/(id=|Foreman `|factory )[0-9a-f]{8}\b/g, "$1<factory-id>");
}

function matchesSnapshot(name: string, world: World): void {
  const path = join(SNAPSHOTS, `${name}.md`);
  const actual = transcript(world);
  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(path)) {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `messages changed in ${name}; review the diff, then UPDATE_SNAPSHOTS=1 npm test if it was meant`);
}

const say = (ctx: Ctx, world: World, runId: string, threadTs: string, user: string, text: string) => {
  world.advance(1);
  return slackMention(runtimeOf(ctx), { runId, channel: CHANNEL, threadTs, ts: `${world.clock / 1000}`, user, text });
};

async function slackIntake(world: World, ctx: Ctx, ts: string, text: string, user = "U2") {
  await dispatch(runtimeOf(ctx), { kind: "slack_intake", repo: ctx.config.repo, channel: CHANNEL, ts, text, user });
  return (await ctx.store.runByThread(CHANNEL, ts))!;
}

test("messages: a Slack request through questions, both gates, a send-back, verify with video, findings, and merge", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackIntake(world, ctx, "100.1", "<@U1> please add CSV export to the invoices page");
  await finishStep(world, ctx, run.id, results.triage(run.id));
  await finishStep(world, ctx, run.id, results.spec(run.id, 1));
  await dispatch(runtimeOf(ctx), { kind: "answer", runId: run.id, text: "Only admins." });
  await finishStep(world, ctx, run.id, results.spec(run.id, 2));
  let r = (await ctx.store.getRun(run.id))!;
  await say(ctx, world, run.id, r.slackTs!, "U9", "approve");
  await say(ctx, world, run.id, r.slackTs!, "U2", "approve");
  await finishStep(world, ctx, run.id, results.plan(run.id));
  r = (await ctx.store.getRun(run.id))!;
  world.react(CHANNEL, r.askTs!, "white_check_mark", "U2");
  await tickAndDrain(ctx, world);
  await finishStep(world, ctx, run.id, results.implement(run.id));
  await finishStep(world, ctx, run.id, results.verdict(run.id, "review", "changes"));
  await finishStep(world, ctx, run.id, results.implement(run.id, 2));
  await finishStep(world, ctx, run.id, results.verdict(run.id, "review", "pass"));
  r = (await ctx.store.getRun(run.id))!;
  world.agents.get([...world.agents.values()].find((a) => a.status === "RUNNING")!.id)!.video = { name: "walkthrough.mp4", data: new Uint8Array(1024) };
  await finishStep(world, ctx, run.id, { [`.factory/${run.id}/verify.json`]: JSON.stringify({ verdict: "pass", summary: "All criteria met.", findings: [], video: "https://cursor.com/agents/bc-x/artifacts?path=walkthrough.mp4" }) });
  r = (await ctx.store.getRun(run.id))!;
  world.thread(r.pr!, "cursor[bot]", "Possible null dereference when the list is empty.");
  await tickAndDrain(ctx, world);
  await finishStep(world, ctx, run.id, results.implement(run.id, 3));
  await finishStep(world, ctx, run.id, results.verdict(run.id, "review", "pass"));
  await finishStep(world, ctx, run.id, results.verdict(run.id, "verify", "pass"));
  world.check(r.pr!, "ci", "in_progress");
  await tickAndDrain(ctx, world);
  world.check(r.pr!, "ci", "completed", "success");
  await tickAndDrain(ctx, world);
  world.merge(r.pr!, "alice");
  await deliver(ctx, "pull_request", hooks.prClosed(world, r.pr!));
  assert.equal((await ctx.store.getRun(run.id))!.stage, "done");
  matchesSnapshot("slack-request-to-merge", world);
});

test("messages: GitHub gates, a non-approver, a moved branch, changes, a hold and a retry", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { issue, run } = await startRun(world, ctx);
  await finishStep(world, ctx, run, results.triage(run));
  await finishStep(world, ctx, run, results.spec(run, 2));
  await comment(world, ctx, issue, "mallory", "approve");
  world.push(`factory/${run}`, { "specs/x.md": "edit" });
  await tickAndDrain(ctx, world);
  await comment(world, ctx, issue, "alice", "changes: name the export button");
  await finishStep(world, ctx, run, results.spec(run, 2));
  await comment(world, ctx, issue, "alice", "approve");
  world.finish(world.running()[0].id, {}, "ERROR");
  await tickAndDrain(ctx, world);
  await comment(world, ctx, issue, "alice", "retry");
  await finishStep(world, ctx, run, { "README.md": "oops", [`.factory/${run}/plan.json`]: '{"summary":"x"}' });
  assert.notEqual((await ctx.store.getRun(run))!.hold, null);
  matchesSnapshot("github-gates-and-holds", world);
});

test("messages: triage closes a duplicate, and a repeat Slack request links it", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const first = await slackIntake(world, ctx, "200.1", "<@U1> add dark mode to the settings page");
  await dispatch(runtimeOf(ctx), { kind: "slack_intake", repo: ctx.config.repo, channel: CHANNEL, ts: "201.1", text: "<@U1> dark mode on the settings page please", user: "U3" });
  assert.equal((await ctx.store.openRuns()).length, 1, "the repeat links the open run");
  const other = await slackIntake(world, ctx, "202.1", "<@U1> night theme for the whole invoices app");
  await finishStep(world, ctx, other.id, results.triage(other.id, [{ url: `https://github.com/acme/app/issues/${first.issue}`, reason: "Same request." }]));
  await dispatch(runtimeOf(ctx), { kind: "slack_intake", repo: ctx.config.repo, channel: CHANNEL, ts: "203.1", text: "<@U1> a night theme for the whole invoices app", user: "U3" });
  matchesSnapshot("duplicates-and-repeats", world);
});

test("messages: abandon from Slack, with a stranger first and the reason asked for", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackIntake(world, ctx, "300.1", "<@U1> please add dark mode to the settings page");
  await finishStep(world, ctx, run.id, results.triage(run.id));
  await finishStep(world, ctx, run.id, results.spec(run.id, 2));
  const r = (await ctx.store.getRun(run.id))!;
  world.react(CHANNEL, r.slackTs!, "wastebasket", "U9");
  await tickAndDrain(ctx, world);
  await say(ctx, world, run.id, r.slackTs!, "U2", "abandon");
  await say(ctx, world, run.id, r.slackTs!, "U2", "the design team owns this now");
  await say(ctx, world, run.id, r.slackTs!, "U2", "approve");
  await dispatch(runtimeOf(ctx), { kind: "slack_intake", repo: ctx.config.repo, channel: CHANNEL, ts: "301.1", text: "<@U1> dark mode for the settings page", user: "U3" });
  assert.equal((await ctx.store.getRun(run.id))!.stage, "abandoned");
  matchesSnapshot("abandon-from-slack", world);
});

test("messages: a pull request closed by hand asks why, and the answer writes the post-mortem", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const run = await slackIntake(world, ctx, "400.1", "<@U1> add an audit log");
  await finishStep(world, ctx, run.id, results.triage(run.id));
  await finishStep(world, ctx, run.id, results.spec(run.id, 2));
  const r = (await ctx.store.getRun(run.id))!;
  world.pulls.get(r.pr!)!.state = "closed";
  await tickAndDrain(ctx, world);
  await say(ctx, world, run.id, r.slackTs!, "U2", "we bought a vendor tool instead");
  matchesSnapshot("closed-by-hand", world);
});

test("messages: the findings cap, a conflict, and the queue", async () => {
  const world = new World();
  const ctx = makeCtx(world, testConfig((doc) => {
    doc.limits = { runsPerRepo: 1, runsTotal: 1 };
    for (const e of doc.steps) if (typeof e === "object") e.enabled = false;
  }));
  const { run } = await startRun(world, ctx);
  await startRun(world, ctx, "Add PDF export");
  await finishStep(world, ctx, run, results.triage(run));
  await finishStep(world, ctx, run, results.spec(run, 2));
  await finishStep(world, ctx, run, results.plan(run));
  for (let n = 1; n <= 4; n += 1) {
    await finishStep(world, ctx, run, results.implement(run, n));
    await finishStep(world, ctx, run, results.verdict(run, "review", "pass"));
    await finishStep(world, ctx, run, results.verdict(run, "verify", "pass"));
    const pr = (await ctx.store.getRun(run))!.pr!;
    if (n === 4) break;
    world.check(pr, "lint", "completed", "failure");
    await tickAndDrain(ctx, world);
    world.check(pr, "lint", "completed", "success");
  }
  const pr = (await ctx.store.getRun(run))!.pr!;
  world.pulls.get(pr)!.mergeableState = "dirty";
  await tickAndDrain(ctx, world);
  world.reviewBy(pr, "carol", "CHANGES_REQUESTED", "Please add a test for the empty case.");
  await tickAndDrain(ctx, world);
  matchesSnapshot("findings-conflict-queue", world);
});

test("messages: a step held for its deadline", async () => {
  const world = new World();
  const ctx = makeCtx(world, testConfig((doc) => {
    for (const e of doc.steps) if (typeof e === "object") e.enabled = false;
  }));
  const { run } = await startRun(world, ctx);
  world.advance(25);
  await tickAndDrain(ctx, world);
  matchesSnapshot("deadline-hold", world);
});

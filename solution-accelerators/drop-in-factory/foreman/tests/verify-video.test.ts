import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_UPLOAD_BYTES, pickVideo } from "../bot/lib/steps/cloud-agent.ts";
import { CATALOG } from "../bot/lib/steps/catalog.ts";
import { parseResult, walkthroughVideo, type VerdictResult } from "../bot/lib/steps/results.ts";
import { agentFor, finishStep, gateIn, withoutStep, makeCtx, results, startRun, testConfig, tickAndDrain, World } from "./fakes.ts";

const VIDEO = "https://cursor.com/agents/bc-9/artifacts?path=%2Fopt%2Fcursor%2Fartifacts%2Fwalkthrough.mp4";

/** A run at verify with review and both gates off, so the test reaches verify in four steps. */
async function atVerify() {
  const world = new World();
  const ctx = makeCtx(world, testConfig((doc) => {
    gateIn(doc, "spec").enabled = false;
    gateIn(doc, "plan").enabled = false;
    withoutStep(doc, "review");
  }));
  const { run } = await startRun(world, ctx);
  await finishStep(world, ctx, run, results.triage(run));
  await finishStep(world, ctx, run, results.spec(run, 2));
  await finishStep(world, ctx, run, results.plan(run));
  await finishStep(world, ctx, run, results.implement(run));
  const r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "verify");
  return { world, ctx, run, pr: r.pr! };
}

const verifyResult = (run: string, verdict: "pass" | "changes", video?: unknown) => {
  const files = results.verdict(run, "verify", verdict);
  const path = `.factory/${run}/verify.json`;
  if (video !== undefined) files[path] = JSON.stringify({ ...JSON.parse(files[path]), video });
  return files;
};

const threadPosts = (world: World) => world.slackPosts.filter((p) => p.threadTs !== null).map((p) => p.text);
const verifyPosts = (world: World) => threadPosts(world).filter((t) => t.startsWith("Verify "));

test("verify pass: the review and the Slack thread carry the video from verify.json and the PR link", async () => {
  const { world, ctx, run, pr } = await atVerify();
  await finishStep(world, ctx, run, verifyResult(run, "pass", VIDEO));
  assert.equal((await ctx.store.getRun(run))!.stage, "awaiting_merge");
  assert.match(world.pulls.get(pr)!.reviews.at(-1)!, new RegExp(`Walkthrough video: ${VIDEO.replace(/[?.]/g, "\\$&")}`));
  const post = world.slackPosts.find((p) => p.text.startsWith("Verify "))!;
  assert.match(post.text, new RegExp(`^Verify passed on #${pr}\nWalkthrough video: <${VIDEO.replace(/[?.]/g, "\\$&")}\|watch>`));
  assert.ok(post.text.includes(`<https://github.com/acme/app/pull/${pr}|PR #${pr}>`));
  assert.equal(post.threadTs, (await ctx.store.getRun(run))!.statusTs, "in the status thread");
  assert.equal((post.blocks![0] as any).type, "section", "as Block Kit");
});

test("verify fail: the Slack thread says fail and the run goes back to Implement", async () => {
  const { world, ctx, run, pr } = await atVerify();
  await finishStep(world, ctx, run, verifyResult(run, "changes", VIDEO));
  assert.equal((await ctx.store.getRun(run))!.stage, "implement");
  const post = verifyPosts(world)[0];
  assert.match(post, new RegExp(`^Verify failed on #${pr}, sent back to Implement\nWalkthrough video: <`));
});

test("verify: with no video in verify.json, Foreman takes the one embedded in the PR description", async () => {
  const { world, ctx, run, pr } = await atVerify();
  world.pulls.get(pr)!.body = `Closes #1\n\n## Walkthrough\n\n<video src="${VIDEO}"></video>\n`;
  await finishStep(world, ctx, run, verifyResult(run, "pass"));
  assert.ok(threadPosts(world).some((t) => t.includes(`<${VIDEO}|watch>`)));
});

test("verify: with no video anywhere, the Slack post says so and links the verify agent", async () => {
  const { world, ctx, run } = await atVerify();
  const agent = agentFor(world, run);
  await finishStep(world, ctx, run, verifyResult(run, "pass", null));
  const post = verifyPosts(world)[0];
  assert.ok(post.includes(`No walkthrough video was recorded (<${agent.url}|verify agent>).`), post);
  assert.doesNotMatch(world.pulls.get((await ctx.store.getRun(run))!.pr!)!.reviews.at(-1)!, /Walkthrough video/);
});

test("verify: a replayed tick posts the Slack verdict once", async () => {
  const { world, ctx, run } = await atVerify();
  await finishStep(world, ctx, run, verifyResult(run, "pass", VIDEO));
  await tickAndDrain(ctx, world);
  await tickAndDrain(ctx, world);
  assert.equal(verifyPosts(world).length, 1);
});

test("verify: the walkthrough mp4 is uploaded into the status thread, with pass and the PR link", async () => {
  const { world, ctx, run, pr } = await atVerify();
  const agent = agentFor(world, run);
  agent.video = { name: "walkthrough.mp4", data: new Uint8Array(2048) };
  await finishStep(world, ctx, run, verifyResult(run, "pass", VIDEO));
  assert.equal(world.slackUploads.length, 1);
  const up = world.slackUploads[0];
  assert.deepEqual({ name: up.name, bytes: up.bytes, threadTs: up.threadTs }, { name: "walkthrough.mp4", bytes: 2048, threadTs: (await ctx.store.getRun(run))!.statusTs });
  assert.match(up.text, new RegExp(`^Verify passed on #${pr}`));
  assert.ok(up.text.includes(`PR #${pr}`));
  assert.equal(verifyPosts(world).length, 0, "the upload carries the verdict; no second post");
  await tickAndDrain(ctx, world);
  assert.equal(world.slackUploads.length, 1, "uploaded once");
});

test("verify: a failed upload falls back to the video link", async () => {
  const { world, ctx, run } = await atVerify();
  agentFor(world, run).video = { name: "walkthrough.mp4", data: new Uint8Array(10) };
  world.uploadError = "files.completeUploadExternal: not_in_channel";
  await finishStep(world, ctx, run, verifyResult(run, "pass", VIDEO));
  assert.equal(world.slackUploads.length, 0);
  assert.ok(verifyPosts(world)[0].includes(`<${VIDEO}|watch>`));
});

test("pickVideo takes the mp4 the hint names, else the newest mp4", () => {
  const items = [
    { path: "artifacts/old.mp4", sizeBytes: 10, updatedAt: "2026-10-21T10:00:00Z" },
    { path: "artifacts/new.mp4", sizeBytes: 10, updatedAt: "2026-10-21T11:00:00Z" },
    { path: "artifacts/shot.png", sizeBytes: 10, updatedAt: "2026-10-21T12:00:00Z" },
  ];
  assert.equal(pickVideo(items, null)?.path, "artifacts/new.mp4");
  assert.ok(MAX_UPLOAD_BYTES >= 100 * 1024 * 1024, "videoArtifact returns null above Slack's upload limit, so Foreman links instead");
  assert.equal(pickVideo(items, "https://cursor.com/agents/bc-1/artifacts?path=%2Fopt%2Fcursor%2Fartifacts%2Fold.mp4")?.path, "artifacts/old.mp4");
  assert.equal(pickVideo(items.slice(2), null), null);
});

test("parseResult drops a video that is not an https URL instead of holding the run", () => {
  for (const video of ["file:///opt/cursor/artifacts/a.mp4", "/opt/cursor/artifacts/a.mp4", 7, ""]) {
    const r = parseResult(CATALOG.get("verify")!, JSON.stringify({ verdict: "pass", summary: "ok", findings: [], video })) as VerdictResult;
    assert.equal(r.video, null);
  }
});

test("walkthroughVideo prefers verify.json, then a <video> tag, then a markdown video link", () => {
  const base: VerdictResult = { verdict: "pass", summary: "", findings: [] };
  assert.equal(walkthroughVideo({ ...base, video: VIDEO }, '<video src="https://x.test/other.mp4">'), VIDEO);
  assert.equal(walkthroughVideo(base, "<video controls src='https://x.test/a.mp4'></video>"), "https://x.test/a.mp4");
  assert.equal(walkthroughVideo(base, "[demo](https://x.test/b.webm)"), "https://x.test/b.webm");
  assert.equal(walkthroughVideo(base, '<video src="/opt/cursor/artifacts/a.mp4"></video>'), null);
  assert.equal(walkthroughVideo(base, ""), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { fromGitHub } from "../bot/lib/pipeline/ingress.ts";
import { MAX_SEND_BACKS, prFindings, type Ctx } from "../bot/lib/pipeline/reconcile.ts";
import { agentFor, comment, deliver, finishStep, hooks, makeCtx, results, tickAndDrain, toSpecGate, World } from "./fakes.ts";

/** A run past verify, waiting at awaiting_merge with its PR ready. */
async function toMerge(world: World, ctx: Ctx) {
  const { issue, run } = await toSpecGate(world, ctx);
  await comment(world, ctx, issue, "alice", "approve");
  await finishStep(world, ctx, run, results.plan(run));
  const pr = (await ctx.store.getRun(run))!.pr!;
  world.label(pr, "alice", "factory:plan-approved");
  await deliver(ctx, "pull_request", hooks.prLabeled(world, pr, "factory:plan-approved"));
  await passImplementReviewVerify(world, ctx, run, 1);
  assert.equal((await ctx.store.getRun(run))!.stage, "awaiting_merge");
  return { issue, run, pr };
}

async function passImplementReviewVerify(world: World, ctx: Ctx, run: string, n: number) {
  await finishStep(world, ctx, run, results.implement(run, n));
  await finishStep(world, ctx, run, results.verdict(run, "review", "pass"));
  await finishStep(world, ctx, run, results.verdict(run, "verify", "pass"));
}

const readyPosts = (world: World, pr: number) => world.slackPosts.filter((p) => p.text === `Ready to merge: <https://github.com/acme/app/pull/${pr}|#${pr}>`);

test("a Bugbot thread goes back to Implement once, then the PR is ready again", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { run, pr } = await toMerge(world, ctx);
  assert.equal(readyPosts(world, pr).length, 1);

  world.thread(pr, "cursor[bot]", "Possible null dereference when the list is empty.");
  await tickAndDrain(ctx, world);
  let r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "implement");
  assert.equal(r.sendBacks, 1);
  assert.match(agentFor(world, run).launch.prompt, /@cursor\[bot\] on `src\/feature1\.ts:3`: Possible null dereference/);
  assert.ok(world.slackPosts.some((p) => p.text.startsWith(`Sending #${pr} back to Implement`)));

  await passImplementReviewVerify(world, ctx, run, 2);
  r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "awaiting_merge", "the handled thread does not send it back again");
  assert.equal(readyPosts(world, pr).length, 2, "ready again at the new head");
});

test("bots outside review.bots and human review threads do not send work back; a human change request does", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { run, pr } = await toMerge(world, ctx);

  world.thread(pr, "dependabot[bot]", "Bump lodash.");
  world.thread(pr, "carol", "Nit: rename this.", false);
  await tickAndDrain(ctx, world);
  assert.equal((await ctx.store.getRun(run))!.stage, "awaiting_merge");

  world.reviewBy(pr, "carol", "CHANGES_REQUESTED", "Please add a test for the empty case.");
  await tickAndDrain(ctx, world);
  assert.equal((await ctx.store.getRun(run))!.stage, "implement");
  assert.match(agentFor(world, run).launch.prompt, /@carol requested changes: Please add a test for the empty case\./);
});

test("Ready to merge waits for green checks; a failed check goes back to Implement", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { issue, run } = await toSpecGate(world, ctx);
  await comment(world, ctx, issue, "alice", "approve");
  await finishStep(world, ctx, run, results.plan(run));
  const pr = (await ctx.store.getRun(run))!.pr!;
  world.label(pr, "alice", "factory:plan-approved");
  await deliver(ctx, "pull_request", hooks.prLabeled(world, pr, "factory:plan-approved"));
  world.check(pr, "ci", "in_progress");
  await passImplementReviewVerify(world, ctx, run, 1);

  let r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "awaiting_merge");
  assert.equal(r.blocked, "checks");
  assert.equal(readyPosts(world, pr).length, 0);
  assert.equal(world.pulls.get(pr)!.draft, true, "still a draft while checks run");

  world.check(pr, "ci", "completed", "success");
  await tickAndDrain(ctx, world);
  assert.equal(readyPosts(world, pr).length, 1);
  assert.equal(world.pulls.get(pr)!.draft, false);

  world.check(pr, "lint", "completed", "failure");
  await tickAndDrain(ctx, world);
  r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "implement");
  assert.match(agentFor(world, run).launch.prompt, /check `lint` failure: lint failed/);
});

test("a push after verify reruns review and verify", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { run, pr } = await toMerge(world, ctx);

  world.push(world.pulls.get(pr)!.branch, { "src/hotfix.ts": "export {}" });
  await deliver(ctx, "pull_request", { action: "synchronize", pull_request: { number: pr, head: { ref: world.pulls.get(pr)!.branch } }, repository: { full_name: world.repo } });
  assert.equal((await ctx.store.getRun(run))!.stage, "review");
  await finishStep(world, ctx, run, results.verdict(run, "review", "pass"));
  await finishStep(world, ctx, run, results.verdict(run, "verify", "pass"));
  assert.equal((await ctx.store.getRun(run))!.stage, "awaiting_merge");
});

test("past the send-back cap, Foreman asks instead of sending work back", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { run, pr } = await toMerge(world, ctx);
  await ctx.store.saveRun({ ...(await ctx.store.getRun(run))!, sendBacks: MAX_SEND_BACKS });

  world.thread(pr, "cursor[bot]", "Security: the token is logged.");
  await tickAndDrain(ctx, world);
  const r = (await ctx.store.getRun(run))!;
  assert.equal(r.stage, "awaiting_merge");
  assert.equal(r.blocked, "findings");
  const asks = world.slackPosts.filter((p) => p.text.includes(`Implement has had ${MAX_SEND_BACKS} rounds already`));
  assert.equal(asks.length, 1);
  assert.match(asks[0].text, /Security: the token is logged/);
  await tickAndDrain(ctx, world);
  assert.equal(world.slackPosts.filter((p) => p.text.includes(`Implement has had ${MAX_SEND_BACKS} rounds already`)).length, 1, "asked once");
});

test("review.bots in factory.yaml chooses which bots count", () => {
  const feedback = {
    reviews: [{ id: 1, login: "acme-sec[bot]", bot: true, state: "CHANGES_REQUESTED" as const, body: "Secret in code.", submittedAt: "", commit: "h", url: "" }],
    threads: [{ id: "T1", resolved: false, outdated: false, login: "cursor[bot]", bot: true, path: "a.ts", line: 1, body: "Bug.", url: "", createdAt: "" },
      { id: "T2", resolved: true, outdated: false, login: "cursor[bot]", bot: true, path: "a.ts", line: 2, body: "Fixed.", url: "", createdAt: "" }],
    checks: [{ name: "ci", status: "queued", conclusion: null, url: "", summary: "" }],
  };
  assert.deepEqual(prFindings(feedback, ["cursor"], [], "h").findings.map((f) => f.id), ["thread:T1"]);
  assert.deepEqual(prFindings(feedback, ["acme-sec"], [], "h").findings.map((f) => f.id), ["review:1"]);
  assert.deepEqual(prFindings(feedback, ["cursor", "acme-sec"], ["thread:T1"], "h").findings.map((f) => f.id), ["review:1"]);
  assert.deepEqual(prFindings(feedback, [], [], "h").pending, ["ci"]);
});

test("ingress turns PR reviews, review comments and completed checks into reconciles", async () => {
  const world = new World();
  const ctx = makeCtx(world);
  const { run, pr } = await toMerge(world, ctx);
  const head = { number: pr, head: { ref: world.pulls.get(pr)!.branch } };
  const repository = { full_name: world.repo };
  const configs = [ctx.config];
  const of = (name: string, payload: unknown) => fromGitHub(ctx.store, configs, name, payload);

  assert.equal((await of("pull_request_review", { action: "submitted", review: { body: "LGTM" }, pull_request: head, repository }))?.kind, "reconcile");
  assert.equal((await of("pull_request_review_comment", { action: "created", comment: { body: "Bug here" }, pull_request: head, repository }))?.kind, "reconcile");
  assert.equal((await of("check_run", { action: "completed", check_run: { name: "ci", pull_requests: [head] }, repository }))?.kind, "reconcile");
  assert.equal((await of("check_suite", { action: "completed", check_suite: { app: { slug: "actions" }, pull_requests: [head] }, repository }))?.kind, "reconcile");
  assert.equal(await of("pull_request_review", { action: "submitted", review: { body: "<!-- factory:review -->" }, pull_request: head, repository }), null, "Foreman's own reviews are ignored");
  assert.equal(await of("check_run", { action: "created", check_run: { name: "ci", pull_requests: [head] }, repository }), null);
  assert.equal((await of("pull_request_review", { action: "submitted", review: { body: "x" }, pull_request: head, repository }) as any).runId, run);
});

test("prFeedback: a token GitHub refuses check runs to falls back to the commit's combined check state", async () => {
  const { prFeedback } = await import("../bot/lib/github/rest.ts");
  const real = globalThis.fetch;
  let rollup = "FAILURE";
  let checkRuns = 403;
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/graphql")) {
      return String(init.body).includes("statusCheckRollup")
        ? reply(200, { data: { repository: { object: { statusCheckRollup: { state: rollup } } } } })
        : reply(200, { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    if (url.includes("/check-runs")) return checkRuns === 403 ? reply(403, { message: "Resource not accessible by personal access token" }) : reply(200, { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] });
    if (url.endsWith("/status")) return reply(200, { statuses: [] });
    return reply(200, []);
  }) as typeof fetch;
  try {
    const gh = { token: "t", repo: "acme/app" };
    assert.deepEqual((await prFeedback(gh, 7, "abc")).checks.map((c) => [c.name, c.status, c.conclusion, c.url]), [["all checks", "completed", "failure", "https://github.com/acme/app/pull/7/checks"]]);
    rollup = "PENDING";
    assert.deepEqual((await prFeedback(gh, 7, "abc")).checks.map((c) => [c.status, c.conclusion]), [["in_progress", null]]);
    checkRuns = 200;
    assert.deepEqual((await prFeedback(gh, 7, "abc")).checks.map((c) => c.name), ["test"]);
  } finally {
    globalThis.fetch = real;
  }
});

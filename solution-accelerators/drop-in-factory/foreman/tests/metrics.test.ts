import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { computeMetrics } from "../bot/lib/metrics/compute.ts";
import { adminUsage, checkAdminKey, COST_SCHEDULE, costReadDue, refreshCosts } from "../bot/lib/metrics/facts.ts";
import { metricInput, otlpPayload } from "../bot/lib/metrics/otel.ts";
import type { Ctx } from "../bot/lib/pipeline/reconcile.ts";
import { statusLine } from "../bot/lib/slack/status.ts";
import { migrateSqlite } from "../bot/lib/store/migrate.ts";
import { roleLabels, runCost } from "../bot/lib/store/runs.ts";
import { comment, finishStep, makeCtx, memoryStore, results, startRun, toSpecGate, World } from "./fakes.ts";

/** One run merged after a spec-gate wait, one closed as a duplicate. */
async function history() {
  const world = new World();
  const ctx = makeCtx(world);
  const { issue, run } = await toSpecGate(world, ctx);
  world.advance(30);
  await comment(world, ctx, issue, "alice", "approve");
  await finishStep(world, ctx, run, results.plan(run));
  await comment(world, ctx, issue, "alice", "approve");
  await finishStep(world, ctx, run, results.implement(run));
  await finishStep(world, ctx, run, results.verdict(run, "review", "pass"));
  await finishStep(world, ctx, run, results.verdict(run, "verify", "pass"));
  world.merge((await ctx.store.getRun(run))!.pr!, "alice");
  await comment(world, ctx, issue, "bob", "thanks");
  const dup = await startRun(world, ctx, "Same thing");
  await finishStep(world, ctx, dup.run, results.triage(dup.run, [{ url: "https://github.com/acme/app/issues/1", reason: "same" }]));
  return { world, ctx, run, dup: dup.run };
}

test("KPIs come from the store and a missing value says why", async () => {
  const { world, ctx } = await history();
  const m = new Map(computeMetrics(await metricInput([ctx]), [ctx.config], world.now(), false).map((x) => [x.name, x]));
  assert.equal(m.get("tasks_merged")!.value, 1);
  assert.equal(m.get("tasks_closed")!.value, 1);
  assert.equal(m.get("merged_rate")!.value, 50);
  assert.equal(m.get("gate_wait_minutes")!.value, 16, "median of a 31-minute spec wait and a 1-minute plan wait");
  assert.equal(m.get("human_touches_per_task")!.value, 1.5);
  assert.equal(m.get("agent_runs_per_task")!.value, 3.5);
  assert.equal(m.get("cost_cents_per_task")!.value, null);
  assert.match(m.get("cost_cents_per_task")!.reason, /CURSOR_ADMIN_API_KEY/);
  assert.equal(m.get("lead_time_hours")!.value, null);
  assert.match(m.get("lead_time_hours")!.reason, /merges to main/);
});

test("the OTLP push carries every metric, as a value or a not-emitted reason", async () => {
  const { ctx } = await history();
  const payload = otlpPayload(ctx, await metricInput([ctx])) as any;
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics as any[];
  const names = metrics.map((x) => x.name);
  assert.ok(names.includes("factory.kpi.tasks_merged"));
  assert.ok(!names.includes("factory.kpi.cost_cents_per_task"));
  const notEmitted = metrics.find((x) => x.name === "factory.metric.not_emitted").gauge.dataPoints;
  assert.ok(notEmitted.some((p: any) => p.attributes.some((a: any) => a.value.stringValue === "factory.kpi.cost_cents_per_task")));
  const entered = metrics.find((x) => x.name === "factory.stage.entered").sum;
  assert.equal(entered.isMonotonic, true);
  assert.ok(metrics.every((x) => (x.gauge ?? x.sum).dataPoints.length > 0));
});

/** Admin API usage events, as `filtered-usage-events` returns them. */
const usageEvents = [
  { cloudAgentId: "bc-a", tokenUsage: { totalCents: 60 }, chargedCents: 64 },
  { cloudAgentId: "bc-b", tokenUsage: { totalCents: 89 }, chargedCents: 94 },
  { cloudAgentId: "bc-a", tokenUsage: { totalCents: 40 }, chargedCents: 43 },
];

/** Serves `usageEvents` filtered on the request's cloudAgentId and dates, one event per page. */
function mockUsage(t: any, events = usageEvents) {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const matching = events.filter((e: any) =>
      (body.cloudAgentId === undefined || e.cloudAgentId === body.cloudAgentId) && (e.timestamp ?? 0) >= body.startDate && (e.timestamp ?? 0) <= body.endDate);
    return Response.json({ usageEvents: matching.slice(body.page - 1, body.page), pagination: { hasNextPage: body.page < matching.length } });
  });
  return requests;
}

test("invoice cents are the chargedCents of the agent's own usage events, across pages", async (t) => {
  const requests = mockUsage(t);
  const read = await adminUsage("admin-key")!.centsForAgent("bc-a", "2026-01-01T03:00:00Z");
  assert.deepEqual(read, { cents: 107, events: 2 }, "chargedCents 64 + 43, not tokenUsage.totalCents 100");
  assert.deepEqual(requests.map((r) => [r.cloudAgentId, r.page]), [["bc-a", 1], ["bc-a", 2]]);
});

test("an event that comes back on two pages is counted once", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: any) => {
    const { page } = JSON.parse(init.body);
    const events = page === 1 ? [{ usageEventId: "e1", chargedCents: 5 }, { usageEventId: "e2", chargedCents: 7 }] : [{ usageEventId: "e2", chargedCents: 7 }, { usageEventId: "e3", chargedCents: 1 }];
    return Response.json({ usageEvents: events.map((e) => ({ ...e, cloudAgentId: "bc-a" })), pagination: { hasNextPage: page === 1 } });
  });
  assert.deepEqual(await adminUsage("a")!.centsForAgent("bc-a", "2026-01-01T01:00:00Z"), { cents: 13, events: 3 });
});

/** An open run with no role yet, so role runs can be recorded on it. */
async function bareRun(ctx: Ctx, issue: number): Promise<string> {
  const run = await ctx.store.createRun({ repo: ctx.config.repo, key: ctx.config.key, issue, title: `Run ${issue}`, slackChannel: null }, ctx.now());
  return run!.id;
}

/** A finished role and a ctx whose cost reads hit `events`, which a test can grow between reads. */
async function settlingRole(t: any) {
  const world = new World();
  const events: any[] = [];
  const requests = mockUsage(t, events);
  const ctx = makeCtx(world);
  const runId = await bareRun(ctx, 1);
  await ctx.store.insertRoleRun({ agentId: "bc-a", runId, role: "implement", visit: 1, status: "CREATING", baseSha: "abc", startedAt: world.now(), deadline: "2099-01-01T00:00:00Z", url: "https://cursor.com/agents" });
  world.advance(5);
  await ctx.store.updateRoleRun(runId, "bc-a", "FINISHED", world.now());
  const role = async () => (await ctx.store.roleRuns(runId))[0];
  const read = async (minutes: number) => {
    world.advance(minutes);
    await refreshCosts(ctx, adminUsage("admin-key")!);
    return role();
  };
  const due = async () => {
    const at = costReadDue(await role());
    return at !== null && at <= Date.parse(world.now());
  };
  return { world, ctx, events, requests, read, role, due };
}

test("cost: read a minute after finish, settling while it grows, final after 30 unchanged minutes", async (t) => {
  const { ctx, world, events, requests, read, due } = await settlingRole(t);
  events.push({ usageEventId: "e1", cloudAgentId: "bc-a", chargedCents: 40 });

  await refreshCosts(ctx, adminUsage("admin-key")!);
  assert.equal(requests.length, 0, "nothing is read in the first minute");
  assert.equal(await due(), false);
  world.advance(1);
  assert.equal(await due(), true);

  let rr = await read(0);
  assert.deepEqual([rr.costCents, rr.costState], [40, "settling"]);

  rr = await read(1);
  assert.equal(requests.length, 1, "the next read waits at least 2 minutes");
  events.push({ usageEventId: "e2", cloudAgentId: "bc-a", chargedCents: 25 });
  rr = await read(1);
  assert.deepEqual([rr.costCents, rr.costState], [65, "settling"], "the new figure replaces the old one: 40 + 25, never 40 + 65");

  for (let i = 0; i < 40 && rr.costState !== "final"; i += 1) rr = await read(1);
  assert.deepEqual([rr.costCents, rr.costState], [65, "final"]);
  assert.ok(Date.parse(world.now()) - Date.parse(rr.costChangedAt!) >= COST_SCHEDULE.stableMs);
  assert.ok(Date.parse(world.now()) - Date.parse(rr.costChangedAt!) < COST_SCHEDULE.stableMs + COST_SCHEDULE.maxIntervalMs);

  const reads = requests.length;
  await read(600);
  assert.equal(requests.length, reads, "a final figure is not read again");
  assert.equal(await due(), false);
});

test("cost: reads back off with the role's age, and stop at the 2-hour cap", async (t) => {
  const { world, events, requests, read, role } = await settlingRole(t);
  const finished = Date.parse(world.now());
  const at: number[] = [];
  let rr = await role();
  for (let minute = 0; minute < 200; minute += 1) {
    events.push({ usageEventId: `e${minute}`, cloudAgentId: "bc-a", chargedCents: 1 });
    const before = requests.length;
    rr = await read(1);
    if (requests.length > before) at.push((Date.parse(world.now()) - finished) / 60_000);
    if (rr.costState === "final") break;
  }
  const gaps = at.slice(1).map((m, i) => m - at[i]);
  assert.equal(at[0], 1);
  assert.ok(gaps.every((g, i) => g >= 2 && g <= 15 && g >= (gaps[i - 1] ?? 0)), `gaps grow from 2 to at most 15 minutes: ${gaps}`);
  assert.equal(rr.costState, "final", "always changing, so the cap makes it final");
  assert.ok(at.at(-1)! >= 120 && at.at(-1)! < 120 + 15);
  assert.equal(rr.costCents, at.at(-1)! - 0, "every event read once, no more");
});

test("cost: no usage events is no figure until the cap, then a final zero", async (t) => {
  const { read } = await settlingRole(t);
  let rr = await read(1);
  assert.deepEqual([rr.costCents, rr.costState], [null, null], "no events is not shown as $0.00 settling");
  for (let i = 0; i < 200 && rr.costState !== "final"; i += 1) rr = await read(1);
  assert.deepEqual([rr.costCents, rr.costState], [0, "final"]);
});

test("two overlapping roles are each charged only their own events", async (t) => {
  const world = new World();
  const started = Date.parse(world.now());
  // The Admin API can stamp an agent's first event a few seconds before the factory records its start.
  const requests = mockUsage(t, usageEvents.map((e, i) => ({ ...e, timestamp: started - 4_000 + i * 120_000 })));
  const ctx = makeCtx(world);
  const [one, two] = [await bareRun(ctx, 1), await bareRun(ctx, 2)];
  const role = { visit: 1, status: "CREATING", baseSha: "abc", deadline: "2099-01-01T00:00:00Z", url: "https://cursor.com/agents" };
  await ctx.store.insertRoleRun({ ...role, agentId: "bc-a", runId: one, role: "implement", startedAt: world.now() });
  world.advance(2);
  await ctx.store.insertRoleRun({ ...role, agentId: "bc-b", runId: two, role: "triage", startedAt: world.now() });
  world.advance(3);
  await ctx.store.updateRoleRun(one, "bc-a", "FINISHED", world.now());
  await ctx.store.updateRoleRun(two, "bc-b", "FINISHED", world.now());

  world.advance(1);
  await refreshCosts(ctx, adminUsage("admin-key")!);
  const cost = new Map([...(await ctx.store.roleRuns(one)), ...(await ctx.store.roleRuns(two))].map((r) => [r.agentId, r.costCents]));
  assert.deepEqual([cost.get("bc-a"), cost.get("bc-b")], [107, 94]);
  assert.equal(cost.get("bc-a")! + cost.get("bc-b")!, 201, "the team was charged 201 in total, and nothing is counted twice");
  assert.ok(requests.every((r) => r.cloudAgentId === "bc-a" || r.cloudAgentId === "bc-b"));
});

test("cost: a SQLite store from before settling imports its two-hour figures as final", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "factory-")), "factory.sqlite");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT, issue INTEGER NOT NULL, title TEXT NOT NULL, stage TEXT NOT NULL, stage_since TEXT NOT NULL, visit INTEGER NOT NULL, pm_round INTEGER NOT NULL, send_backs INTEGER NOT NULL, created_at TEXT NOT NULL)");
  old.exec("CREATE TABLE transitions (seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, stage TEXT NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT)");
  old.exec("CREATE TABLE role_runs (agent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, visit INTEGER NOT NULL, status TEXT NOT NULL, base_sha TEXT NOT NULL, started_at TEXT NOT NULL, deadline TEXT NOT NULL, finished_at TEXT, url TEXT NOT NULL, cost_cents REAL)");
  old.exec("INSERT INTO runs VALUES ('f-gh-1', 'acme/app', 1, 'Old', 'architecture', '2026-01-01T00:15:00Z', 12, 0, 0, '2026-01-01T00:00:00Z')");
  old.exec("INSERT INTO transitions VALUES (10, 'f-gh-1', 'intake', '2026-01-01T00:00:00Z', 'intake', NULL), (11, 'f-gh-1', 'pm', '2026-01-01T00:01:00Z', 'x', NULL), (12, 'f-gh-1', 'architecture', '2026-01-01T00:15:00Z', 'x', NULL)");
  old.exec("INSERT INTO role_runs VALUES ('bc-a', 'f-gh-1', 'pm', 11, 'FINISHED', 'abc', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '2026-01-01T00:10:00Z', 'u', 12.5), ('bc-b', 'f-gh-1', 'qa', 12, 'FINISHED', 'abc', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '2026-01-01T00:20:00Z', 'u', NULL)");
  old.close();
  const store = memoryStore(new World());
  assert.equal(await migrateSqlite(store, path, "acme/app", () => {}), 1);
  assert.ok(existsSync(`${path}.migrated`));
  const rows = await store.roleRuns("f-gh-1");
  assert.deepEqual(rows.map((r) => [r.agentId, r.visit]), [["bc-a", 2], ["bc-b", 3]], "role visits follow the renumbered transitions");
  assert.deepEqual(rows.map((r) => [r.agentId, r.costCents, r.costState]), [["bc-a", 12.5, "final"], ["bc-b", null, null]]);
});

test("fractional chargedCents are kept, so per-role rounding never adds up", async (t) => {
  mockUsage(t, [{ cloudAgentId: "bc-a", tokenUsage: { totalCents: 10 }, chargedCents: 10.927 }, { cloudAgentId: "bc-a", tokenUsage: { totalCents: 1 }, chargedCents: 1.4 }] as any);
  assert.equal((await adminUsage("a")!.centsForAgent("bc-a", "2026-01-01T01:00:00Z")).cents, 10.927 + 1.4);
});

test("a usage event that can't be tied to the agent is an error, not a guess", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ usageEvents: [{ tokenUsage: { totalCents: 5 }, chargedCents: 5 }], pagination: { hasNextPage: false } }));
  await assert.rejects(adminUsage("a")!.centsForAgent("bc-a", "2026-01-01T01:00:00Z"), /no cloud agent when asked for bc-a/);
});

test("a usage event without chargedCents is an error, not zero", async (t) => {
  mockUsage(t, [{ cloudAgentId: "bc-a", tokenUsage: { totalCents: 5 } } as any]);
  await assert.rejects(adminUsage("a")!.centsForAgent("bc-a", "2026-01-01T01:00:00Z"), /no chargedCents/);
});

test("stored invoice cents reach the run's status line labeled settling or final, and the metric only when final", async () => {
  const { world, ctx, run, dup } = await history();
  const mine = await ctx.store.roleRuns(run);
  const set = async (state: "settling" | "final") => {
    for (const id of [run, dup]) {
      for (const r of await ctx.store.roleRuns(id)) {
        await ctx.store.setRoleCost(id, r.agentId, { cents: id === run ? 201 : 0, state, checkedAt: world.now(), changedAt: world.now() });
      }
    }
  };
  const total = `\\$${(mine.length * 2.01).toFixed(2).replace(".", "\\.")}`;
  const line = async () => statusLine(ctx, (await ctx.store.getRun(run))!);
  const metric = async () => new Map(computeMetrics(await metricInput([ctx]), [ctx.config], world.now(), true).map((x) => [x.name, x])).get("cost_cents_per_task")!;

  await set("settling");
  assert.deepEqual(runCost(await ctx.store.roleRuns(run)), { cents: mine.length * 201, state: "settling", read: mine.length, agents: mine.length });
  assert.match(await line(), new RegExp(`${total} settling$`));
  assert.equal((await metric()).value, null, "a settling figure never reaches the metric");
  assert.match((await metric()).reason, /still settling/);

  await set("final");
  assert.match(await line(), new RegExp(`${total} final$`));
  assert.equal((await metric()).value, mine.length * 201 / 2);
});

/** The Admin API's /teams/members and the Cloud Agents API's /v0/me. */
function mockTeam(t: any, members: { status: number; body?: unknown }, email = "factory@example.com") {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url.endsWith("/teams/members") ? Response.json(members.body ?? {}, { status: members.status }) : Response.json({ apiKeyName: "factory", userEmail: email }));
}

test("doctor: an admin key whose team includes the launching account passes", async (t) => {
  mockTeam(t, { status: 200, body: { teamMembers: [{ email: "Factory@example.com", role: "member" }, { email: "admin@example.com", role: "owner" }] } });
  assert.match(await checkAdminKey("admin", "user"), /its team \(2 members\) includes factory@example\.com/);
});

test("doctor: a bad admin key and an admin key for another team fail with what to fix", async (t) => {
  mockTeam(t, { status: 401 });
  await assert.rejects(checkAdminKey("admin", "user"), /CURSOR_ADMIN_API_KEY was rejected \(401\)/);
  t.mock.restoreAll();
  mockTeam(t, { status: 200, body: { teamMembers: [{ email: "someone@example.com" }, { email: "factory@example.com", isRemoved: true }] } });
  await assert.rejects(checkAdminKey("admin", "user"), /team of CURSOR_ADMIN_API_KEY \(1 members\) does not include factory@example\.com/);
});

test("a step that ran more than once gets a round number on each of its rows", () => {
  const roles = ["triage", "spec", "spec", "plan", "implement", "review", "implement", "review", "verify"].map((role) => ({ role }));
  assert.deepEqual(roleLabels(roles), [
    "triage", "spec (round 1)", "spec (round 2)", "plan",
    "implement (round 1)", "review (round 1)", "implement (round 2)", "review (round 2)", "verify",
  ]);
});

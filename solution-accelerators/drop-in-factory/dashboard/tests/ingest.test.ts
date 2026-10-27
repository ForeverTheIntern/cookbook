import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrateLocal, pgliteDb, type Db } from "../src/lib/db.ts";
import { storeHeartbeat, storeRun } from "../src/lib/ingest.ts";
import { kpis } from "../src/lib/kpi.ts";
import { heartbeats, listRuns, runDoc } from "../src/lib/read.ts";
import { sign, Verifier } from "../src/lib/signature.ts";
import { viewerOf } from "../src/lib/viewer.ts";
import { invalid, type RunMessage, type WireDoc } from "../src/lib/wire.ts";

async function freshDb(): Promise<Db> {
  const pglite = new PGlite();
  await migrateLocal(pglite, new URL("../migrations", import.meta.url).pathname);
  return pgliteDb(pglite);
}

function doc(rev: number, stage = "triage", closedAt: string | null = null): WireDoc {
  return {
    run: { id: "f-app-7", repo: "acme/app", issue: 7, title: "Add CSV export", stage, stageSince: "2026-10-21T10:05:00Z", sendBacks: 0, pr: null, hold: null, blocked: null, createdAt: "2026-10-21T10:00:00Z", closedAt, rev },
    transitions: [
      { seq: 1, stage: "intake", at: "2026-10-21T10:00:00Z", reason: "labeled", actor: "alice" },
      { seq: 2, stage, at: "2026-10-21T10:05:00Z", reason: "next", actor: null },
    ],
    roles: [{ agentId: `bc-${rev}`, role: "triage", visit: 2, status: "RUNNING", startedAt: "2026-10-21T10:05:00Z", finishedAt: null, url: "https://cursor.com/agents/bc", costCents: null, costState: null, costCheckedAt: null }],
  };
}

const msg = (d: WireDoc): RunMessage => ({ schema: 1, factoryId: "fac-1", kind: "run", doc: d });

test("a run is kept only when its rev is newer; children are replaced with it", async () => {
  const db = await freshDb();
  assert.deepEqual(await storeRun(db, msg(doc(2))), { stored: true });
  assert.deepEqual(await storeRun(db, msg(doc(2, "pm"))), { stored: false }, "same rev is a duplicate");
  assert.deepEqual(await storeRun(db, msg(doc(1, "intake"))), { stored: false }, "older rev arrives late");
  assert.equal((await runDoc(db, "f-app-7"))!.doc.run.stage, "triage");
  assert.deepEqual(await storeRun(db, msg(doc(5, "done", "2026-10-21T12:00:00Z"))), { stored: true });
  const stored = (await runDoc(db, "f-app-7"))!;
  assert.equal(stored.doc.run.stage, "done");
  assert.deepEqual(await db.sql("select agent_id from role_runs"), [{ agent_id: "bc-5" }]);
  assert.equal((await db.sql("select count(*)::int as n from transitions"))[0].n, 2);
});

test("a heartbeat records the factory and names what the portal is missing or holds stale", async () => {
  const db = await freshDb();
  await storeRun(db, msg(doc(3)));
  const beat = { schema: 1, factoryId: "fac-1", kind: "heartbeat" as const, at: "2026-10-21T10:06:00Z", version: "0.3.0", repos: ["acme/app", "acme/web"], openCount: 2 };
  const { need } = await storeHeartbeat(db, { ...beat, runs: [{ id: "f-app-7", rev: 3 }, { id: "f-web-1", rev: 1 }] });
  assert.deepEqual(need, ["f-web-1"]);
  assert.deepEqual((await storeHeartbeat(db, { ...beat, runs: [{ id: "f-app-7", rev: 4 }] })).need, ["f-app-7"]);
  const [hb] = await heartbeats(db);
  assert.deepEqual([hb.factoryId, hb.version, hb.repos, hb.openCount], ["fac-1", "0.3.0", ["acme/app", "acme/web"], 2]);
});

test("a wiped portal refills from one heartbeat", async () => {
  const db = await freshDb();
  const runs = [{ id: "f-app-7", rev: 9 }];
  const beat = { schema: 1, factoryId: "fac-1", kind: "heartbeat" as const, at: "2026-10-21T10:06:00Z", version: "1", repos: ["acme/app"], openCount: 1, runs };
  const { need } = await storeHeartbeat(db, beat);
  for (const id of need) await storeRun(db, msg(doc(9)));
  assert.deepEqual((await storeHeartbeat(db, beat)).need, []);
  assert.equal((await listRuns(db, null)).length, 1);
});

test("signatures: fresh and matching passes once; stale, wrong and replayed are refused", () => {
  const v = new Verifier();
  const now = Date.parse("2026-10-21T10:00:00Z");
  const ts = Math.floor(now / 1000);
  const body = '{"kind":"probe"}';
  const good = { secret: "k", timestamp: String(ts), signature: sign("k", ts, body), body, now };
  assert.equal(v.verify({ ...good, secret: "" }), "unset");
  assert.equal(v.verify({ ...good, signature: null }), "missing");
  assert.equal(v.verify({ ...good, body: '{"kind":"run"}' }), "mismatch");
  assert.equal(v.verify({ ...good, secret: "other" }), "mismatch");
  assert.equal(v.verify({ ...good, now: now + 301_000 }), "stale");
  assert.equal(v.verify(good), "ok");
  assert.equal(v.verify(good), "replay");
  const later = ts + 10;
  assert.equal(v.verify({ ...good, timestamp: String(later), signature: sign("k", later, body), now: now + 10_000 }), "ok");
});

test("auth modes: none by default, a shared login, or the SSO proxy's header", () => {
  const h = (init: Record<string, string> = {}) => new Headers(init);
  assert.deepEqual(viewerOf(h(), {}), { ok: true, name: null, mode: "none" });
  const basic = { SA_PORTAL_AUTH: "basic", SA_PORTAL_BASIC_AUTH: "ops:pw" };
  assert.equal(viewerOf(h(), basic).ok, false);
  assert.equal(viewerOf(h({ authorization: `Basic ${btoa("ops:nope")}` }), basic).ok, false);
  assert.deepEqual(viewerOf(h({ authorization: `Basic ${btoa("ops:pw")}` }), basic), { ok: true, name: "ops", mode: "basic" });
  assert.equal((viewerOf(h(), { SA_PORTAL_AUTH: "basic" }) as { status: number }).status, 500, "basic without a login is a config error");
  const proxy = { SA_PORTAL_AUTH: "proxy", SA_PORTAL_AUTH_HEADER: "x-auth-request-email" };
  assert.equal(viewerOf(h(), proxy).ok, false);
  assert.deepEqual(viewerOf(h({ "x-auth-request-email": "dev@example.com" }), proxy), { ok: true, name: "dev@example.com", mode: "proxy" });
  assert.equal((viewerOf(h(), { SA_PORTAL_AUTH: "cursor" }) as { status: number }).status, 500);
});

test("malformed messages are refused with the reason", () => {
  assert.equal(invalid(msg(doc(1))), null);
  assert.equal(invalid({ schema: 1, factoryId: "f", kind: "probe" }), null);
  assert.match(invalid({ schema: 2, factoryId: "f", kind: "probe" })!, /schema/);
  assert.match(invalid({ schema: 1, factoryId: "f", kind: "run", doc: { run: {}, transitions: [], roles: [] } })!, /run needs/);
  assert.match(invalid({ schema: 1, factoryId: "f", kind: "heartbeat", at: "x" })!, /heartbeat needs/);
  assert.match(invalid({ schema: 1, factoryId: "f", kind: "nuke" })!, /kind/);
});

test("KPIs say when there is nothing to count instead of showing zero", () => {
  const now = Date.parse("2026-10-22T00:00:00Z");
  const empty = kpis([], now, 14);
  assert.equal(empty.find((t) => t.label === "Median issue to merge")!.value, null);
  const merged = { ...doc(5, "done", "2026-10-21T12:00:00Z") };
  const tiles = kpis([merged], now, 14);
  assert.equal(tiles.find((t) => t.label === "Tasks merged")!.value, "1");
  assert.equal(tiles.find((t) => t.label === "Median issue to merge")!.value, "2h 0m");
  assert.equal(tiles.find((t) => t.label === "Human decisions per task")!.value, "1.0");
});

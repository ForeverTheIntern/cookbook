import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryKv } from "../bot/lib/store/kv.ts";
import { LEASE_MS, Store } from "../bot/lib/store/store.ts";

const start = Date.parse("2026-10-25T00:00:00Z");
const issue = { repo: "o/r", key: "r", title: "t", slackChannel: "C1", requestTs: "1.0" };

function runtimes(n: number, settleMs = 5) {
  const kv = new MemoryKv();
  const clock = { now: start };
  const stores = Array.from({ length: n }, () => new Store(kv, { clock: () => clock.now, settleMs, separateRuntime: true }));
  return { kv, clock, stores };
}

test("a lock can be taken again after it is released", async () => {
  const { clock, stores: [store] } = runtimes(1);
  assert.equal(await store.withLock("tick", async () => "first"), "first");
  assert.equal(await store.withLock("tick", async () => "second"), "second");
  clock.now += 60_000;
  assert.equal(await store.withLock("tick", async () => "third"), "third");
});

test("another runtime's lease refuses the lock until it expires, then the lock is taken over", async () => {
  const { clock, stores: [a, b] } = runtimes(2);
  let refused: string | null = "not run";
  assert.equal(
    await a.withLock("tick", async () => {
      refused = await b.withLock("tick", async () => "both");
      clock.now += LEASE_MS + 1;
      return "mine";
    }),
    "mine",
  );
  assert.equal(refused, null);
  await a.kv.put("lease/tick", { owner: "crashed", token: "x", exp: clock.now + LEASE_MS });
  assert.equal(await b.withLock("tick", async () => "refused"), null);
  clock.now += LEASE_MS + 1;
  assert.equal(await b.withLock("tick", async () => "taken over"), "taken over");
});

test("a lease that was overtaken is left to its new holder on release", async () => {
  const { kv, clock, stores: [store] } = runtimes(1);
  await store.withLock("f-x-1", async () => {
    await kv.put("lease/f-x-1", { owner: "other", token: "other", exp: clock.now + LEASE_MS });
  });
  assert.equal((await kv.get("lease/f-x-1") as { token: string }).token, "other");
  assert.equal(await store.withLock("f-x-1", async () => "refused"), null);
});

test("two runtimes that claim a free lease at the same moment: only one reads its token back", async () => {
  const { stores } = runtimes(4);
  let inside = 0;
  const results = await Promise.all(stores.map((s) => s.withLock("tick", async () => (inside += 1))));
  assert.equal(results.filter((r) => r !== null).length, 1);
  assert.equal(inside, 1);
});

test("a once-key is claimed once, by one of several racing runtimes, and swept after the keep window", async () => {
  const { kv, clock, stores } = runtimes(3);
  const wins = await Promise.all(stores.map((s) => s.createOnce("slack/C1/1.0", "hi")));
  assert.equal(wins.filter(Boolean).length, 1);
  assert.equal(await stores[0].createOnce("slack/C1/1.0", "hi"), false);
  assert.equal(await stores[0].sweep(14 * 86_400_000), 0);
  clock.now += 16 * 86_400_000;
  assert.equal(await stores[0].sweep(14 * 86_400_000), 1);
  assert.equal(await kv.get("once/slack/C1/1.0"), undefined);
  assert.equal(await stores[0].createOnce("slack/C1/1.0", "hi"), true);
});

test("open and closed runs are listed from index keys, without host.files", async () => {
  const { stores: [store] } = runtimes(1, 0);
  const now = new Date(start).toISOString();
  const a = (await store.createRun({ ...issue, issue: 1 }, now))!;
  await store.createRun({ ...issue, issue: 2, requestTs: "2.0" }, now);
  assert.deepEqual((await store.openRuns()).map((r) => r.id).sort(), ["f-r-1", "f-r-2"]);
  await store.moveTo(a, "closed", "test", null, now);
  assert.deepEqual(await store.openIds(), ["f-r-2"]);
  assert.deepEqual(await store.closedIds(["2026-10"]), ["f-r-1"]);
  assert.deepEqual((await store.recentDocs("2026-10-01T00:00:00Z")).map((d) => d.run.id).sort(), ["f-r-1", "f-r-2"]);
});

test("an open run that a racing writer dropped from the open list comes back on its next save", async () => {
  const { kv, stores: [store] } = runtimes(1, 0);
  const run = (await store.createRun({ ...issue, issue: 3 }, new Date(start).toISOString()))!;
  await kv.put("idx/open", []);
  assert.deepEqual(await store.openIds(), []);
  await store.saveRun(run);
  assert.deepEqual(await store.openIds(), ["f-r-3"]);
});

test("two runtimes creating runs at once both land in the open list", async () => {
  const { stores } = runtimes(2, 0);
  const now = new Date(start).toISOString();
  await Promise.all(stores.map((s, i) => s.createRun({ ...issue, issue: 10 + i, requestTs: `${i}.0` }, now)));
  assert.deepEqual((await stores[0].openIds()).sort(), ["f-r-10", "f-r-11"]);
});

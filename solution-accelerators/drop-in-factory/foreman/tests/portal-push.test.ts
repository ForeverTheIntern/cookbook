import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { heartbeat, portalFor, portalSetting, pushRun, resetPortalLogs, signature, type Portal } from "../bot/lib/dashboard-push.ts";
import { MemoryKv } from "../bot/lib/store/kv.ts";
import { Store } from "../bot/lib/store/store.ts";

const NOW = "2026-10-21T10:00:00.000Z";
const ON = { enabled: true, url: null };
const OFF = { enabled: false, url: null };
const SECRET = "s3cret";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let sent: Sent[] = [];
let answer: (body: any) => Response = () => Response.json({ ok: true });
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  answer = () => Response.json({ ok: true });
  resetPortalLogs();
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return answer(JSON.parse(String(init.body)));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function storeWithRun(): Promise<{ store: Store; id: string; kv: MemoryKv }> {
  const kv = new MemoryKv();
  const store = new Store(kv, { settleMs: 0 });
  const run = await store.createRun({ repo: "acme/app", key: "app", issue: 7, title: "Add CSV export", slackChannel: null }, NOW);
  return { store, id: run!.id, kv };
}

test("dashboard off: no portal, no warning, no push, no heartbeat, no store writes", async () => {
  const lines: string[] = [];
  const env = { SA_PORTAL_URL: "http://127.0.0.1:8787", SA_PORTAL_INGEST_SECRET: SECRET };
  assert.deepEqual(portalSetting(OFF, env), { state: "off" });
  const portal = portalFor(OFF, (l) => lines.push(l), env);
  assert.equal(portal, null);
  const { store, id, kv } = await storeWithRun();
  const before = JSON.stringify([...kv.data]);
  const ops = kv.ops;
  assert.equal(await pushRun(store, portal, id, (l) => lines.push(l)), false);
  assert.equal(await heartbeat(store, portal, { version: "1", repos: ["acme/app"], now: NOW }, (l) => lines.push(l)), null);
  assert.deepEqual(sent, []);
  assert.deepEqual(lines, []);
  assert.equal(JSON.stringify([...kv.data]), before);
  assert.equal(kv.ops, ops, "not even a read");
});

test("dashboard on without a URL or secret: one warning per process, then nothing", async () => {
  const lines: string[] = [];
  for (let i = 0; i < 3; i += 1) assert.equal(portalFor(ON, (l) => lines.push(l), {}), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /dashboard\.url or SA_PORTAL_URL and SA_PORTAL_INGEST_SECRET are not set/);
  assert.match(lines[0], /dashboard\.enabled: false/);
  assert.deepEqual(portalSetting(ON, { SA_PORTAL_URL: "http://x" }), { state: "unconfigured", missing: ["SA_PORTAL_INGEST_SECRET"] });
  assert.deepEqual(portalSetting({ enabled: true, url: "https://from-yaml" }, { SA_PORTAL_URL: "http://env", SA_PORTAL_INGEST_SECRET: SECRET }), {
    state: "on",
    portal: { url: "https://from-yaml", secret: SECRET },
  });
  assert.deepEqual(sent, []);
});

test("every push is HMAC-signed over the timestamp and the exact body", async () => {
  const { store, id } = await storeWithRun();
  const portal: Portal = { url: "http://portal", secret: SECRET };
  assert.equal(await pushRun(store, portal, id, () => {}), true);
  const [req] = sent;
  assert.equal(req.url, "http://portal/api/ingest");
  const ts = req.headers["x-factory-timestamp"];
  assert.match(ts, /^\d+$/);
  assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 5);
  const expected = `v1=${createHmac("sha256", SECRET).update(`${ts}.${req.body}`).digest("hex")}`;
  assert.equal(req.headers["x-factory-signature"], expected);
  assert.equal(signature(SECRET, Number(ts), req.body), expected);
  assert.equal(req.headers.authorization, undefined, "the secret itself never goes on the wire");
  const body = JSON.parse(req.body);
  assert.equal(body.kind, "run");
  assert.equal(body.doc.run.id, id);
  assert.equal(body.doc.posts, undefined, "dedupe keys stay in Foreman");
});

test("the heartbeat sends the runs the portal says it needs", async () => {
  const { store, id } = await storeWithRun();
  answer = (body) => Response.json(body.kind === "heartbeat" ? { ok: true, need: [id] } : { ok: true, stored: true });
  const resent = await heartbeat(store, { url: "http://portal", secret: SECRET }, { version: "1", repos: ["acme/app"], now: NOW }, () => {});
  assert.equal(resent, 1);
  assert.deepEqual(sent.map((s) => JSON.parse(s.body).kind), ["heartbeat", "run"]);
  assert.deepEqual(JSON.parse(sent[0].body).runs, [{ id, rev: (await store.getRun(id))!.rev }]);
});

test("failures never throw, and are logged at most once per few minutes", async () => {
  const { store, id } = await storeWithRun();
  const portal: Portal = { url: "http://down", secret: SECRET };
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const lines: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await pushRun(store, portal, id, (l) => lines.push(l)), false);
    assert.equal(await heartbeat(store, portal, { version: "1", repos: [], now: NOW }, (l) => lines.push(l)), null);
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ECONNREFUSED/);
  answer = () => new Response("nope", { status: 401 });
  globalThis.fetch = (async () => answer({})) as typeof fetch;
  assert.equal(await pushRun(store, portal, id, (l) => lines.push(l)), false);
  assert.equal(lines.length, 1, "a different error inside the window is still held back");
});

test("two identical pushes in the same second still sign differently", async () => {
  const { store, id } = await storeWithRun();
  const portal: Portal = { url: "http://portal", secret: SECRET };
  await pushRun(store, portal, id, () => {});
  await pushRun(store, portal, id, () => {});
  assert.notEqual(sent[0].headers["x-factory-signature"], sent[1].headers["x-factory-signature"]);
});

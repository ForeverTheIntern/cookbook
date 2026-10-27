/**
 * Foreman's side of the dashboard: push each run document to the portal app
 * after a reconcile changes it, and send a heartbeat every tick. The portal
 * keeps a run only when the pushed `rev` is newer than its own, so retries,
 * duplicates and overlapping runtimes are harmless. The heartbeat lists every
 * open run (and runs closed in the last day) with its rev; the portal answers
 * with the ids it is missing or holds stale, and Foreman sends those at once.
 * A new or wiped portal fills itself within one tick.
 *
 * The dashboard is optional. `dashboard.enabled: false` in factory.yaml, or a
 * missing URL or secret, means nothing is sent and nothing is retried. Every
 * push is HMAC-signed with a timestamp (dashboard/src/lib/signature.ts checks it).
 * A failed push never throws: it is logged at most once per FAILURE_LOG_MS,
 * and the next heartbeat resyncs it. The wire format is in docs/portal-api.md.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { Dashboard } from "./config/factory.ts";
import type { RunDoc } from "./store/runs.ts";
import type { Store } from "./store/store.ts";

export const PORTAL_SCHEMA = 1;
const TIMEOUT_MS = 5_000;
const CLOSED_WINDOW_MS = 24 * 3_600_000;
export const FAILURE_LOG_MS = 5 * 60_000;

export interface Portal {
  url: string;
  secret: string;
}

export type PortalSetting = { state: "off" } | { state: "unconfigured"; missing: string[] } | { state: "on"; portal: Portal };

/** factory.yaml's dashboard block over SA_PORTAL_URL and SA_PORTAL_INGEST_SECRET, read when called (hosted secrets arrive per request). */
export function portalSetting(dashboard: Dashboard, env: NodeJS.ProcessEnv = process.env): PortalSetting {
  if (!dashboard.enabled) return { state: "off" };
  const url = (dashboard.url ?? env.SA_PORTAL_URL ?? "").trim();
  const secret = (env.SA_PORTAL_INGEST_SECRET ?? "").trim();
  const missing = [...(url === "" ? ["dashboard.url or SA_PORTAL_URL"] : []), ...(secret === "" ? ["SA_PORTAL_INGEST_SECRET"] : [])];
  if (missing.length > 0) return { state: "unconfigured", missing };
  return { state: "on", portal: { url: url.replace(/\/$/, ""), secret } };
}

let warned = false;

/** The portal to push to, or null. A dashboard that is on but unconfigured is warned about once per process. */
export function portalFor(dashboard: Dashboard, log: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Portal | null {
  const setting = portalSetting(dashboard, env);
  if (setting.state === "on") return setting.portal;
  if (setting.state === "unconfigured" && !warned) {
    warned = true;
    log(`dashboard is enabled but ${setting.missing.join(" and ")} ${setting.missing.length === 1 ? "is" : "are"} not set, so nothing is pushed. Set ${setting.missing.length === 1 ? "it" : "them"}, or set dashboard.enabled: false in factory.yaml.`);
  }
  return null;
}

/** Test hook: forget the once-per-process warning and the failure log clock. */
export function resetPortalLogs(): void {
  warned = false;
  failures.clear();
}

const failures = new Map<string, { loggedAt: number; quiet: number }>();

/** Logs a failure unless one for this portal was logged in the last FAILURE_LOG_MS; says how many were held back. */
function logFailure(portal: Portal, message: string, log: (line: string) => void, now = Date.now()): void {
  const seen = failures.get(portal.url);
  if (seen !== undefined && now - seen.loggedAt < FAILURE_LOG_MS) {
    seen.quiet += 1;
    return;
  }
  const quiet = seen?.quiet ?? 0;
  failures.set(portal.url, { loggedAt: now, quiet: 0 });
  log(`${message}${quiet > 0 ? ` (${quiet} more failure${quiet === 1 ? "" : "s"} since the last report)` : ""}. Runs are not affected; the dashboard catches up once it accepts pushes again.`);
}

/** The document as the portal stores it: the run, its transitions and agents. Post dedupe keys stay in Foreman. */
export function wireDoc(doc: RunDoc) {
  return { run: doc.run, transitions: doc.transitions, roles: doc.roles };
}

export interface IngestResponse {
  ok: boolean;
  /** Run ids the portal is missing or holds at an older rev. */
  need?: string[];
}

/** `X-Factory-Signature` for `body` sent at `timestamp` (Unix seconds). */
export function signature(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** The nonce makes two identical messages in one second sign differently, so the portal's replay check refuses only true replays. */
async function post(portal: Portal, payload: object): Promise<IngestResponse> {
  const body = JSON.stringify({ ...payload, nonce: randomUUID() });
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(`${portal.url}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-factory-timestamp": String(timestamp),
      "x-factory-signature": signature(portal.secret, timestamp, body),
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`portal ingest returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as IngestResponse;
}

/** For `npm run doctor`: is the portal up, and does it accept this secret? Stores nothing. Throws with the reason. */
export async function probe(portal: Portal): Promise<void> {
  const health = await fetch(`${portal.url}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((error: Error) => {
    throw new Error(`${portal.url} is not reachable: ${error.message}`);
  });
  if (!health.ok) throw new Error(`${portal.url}/api/health returned ${health.status}; is this the factory portal?`);
  await post(portal, { schema: PORTAL_SCHEMA, factoryId: "doctor", kind: "probe" });
}

/** Push one run. Never throws. */
export async function pushRun(store: Store, portal: Portal | null, runId: string, log: (line: string) => void): Promise<boolean> {
  if (portal === null) return false;
  try {
    const doc = await store.doc(runId);
    if (doc === null) return false;
    await post(portal, { schema: PORTAL_SCHEMA, factoryId: await store.factoryId(), kind: "run", doc: wireDoc(doc) });
    return true;
  } catch (error) {
    logFailure(portal, `dashboard push of ${runId} to ${portal.url} failed: ${(error as Error).message}`, log);
    return false;
  }
}

/**
 * The heartbeat, then whatever the portal says it needs. Returns how many
 * runs were resent, or null when there is no portal or it could not be
 * reached. Never throws.
 */
export async function heartbeat(
  store: Store,
  portal: Portal | null,
  info: { version: string; repos: string[]; now: string },
  log: (line: string) => void,
): Promise<number | null> {
  if (portal === null) return null;
  try {
    const since = new Date(Date.parse(info.now) - CLOSED_WINDOW_MS).toISOString();
    const docs = await store.recentDocs(since);
    const factoryId = await store.factoryId();
    const open = docs.filter((d) => d.run.closedAt === null);
    const answer = await post(portal, {
      schema: PORTAL_SCHEMA,
      factoryId,
      kind: "heartbeat",
      at: info.now,
      version: info.version,
      repos: info.repos,
      openCount: open.length,
      runs: docs.map((d) => ({ id: d.run.id, rev: d.run.rev })),
    });
    const need = answer.need ?? [];
    for (const id of need) {
      const doc = docs.find((d) => d.run.id === id) ?? (await store.doc(id));
      if (doc !== null) await post(portal, { schema: PORTAL_SCHEMA, factoryId, kind: "run", doc: wireDoc(doc) });
    }
    if (need.length > 0) log(`dashboard resync: sent ${need.length} run${need.length === 1 ? "" : "s"} it was missing or held at an older revision`);
    return need.length;
  } catch (error) {
    logFailure(portal, `dashboard heartbeat to ${portal.url} failed: ${(error as Error).message}`, log);
    return null;
  }
}

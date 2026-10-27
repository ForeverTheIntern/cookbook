import type { Db } from "./db.ts";
import type { WireDoc } from "./wire.ts";

export const KPI_DAYS = 14;
export const DORA_WEEKS = 4;
const LIST_LIMIT = 200;

export interface Heartbeat {
  factoryId: string;
  at: string;
  version: string;
  repos: string[];
  openCount: number;
  receivedAt: string;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function heartbeats(db: Db): Promise<Heartbeat[]> {
  const rows = await db.sql<{ factory_id: string; at: unknown; version: string; repos: string[] | string; open_count: number; received_at: unknown }>(
    "select factory_id, at, version, repos, open_count, received_at from heartbeats order by factory_id",
  );
  return rows.map((r) => ({
    factoryId: r.factory_id,
    at: iso(r.at),
    version: r.version,
    repos: typeof r.repos === "string" ? JSON.parse(r.repos) : r.repos,
    openCount: r.open_count,
    receivedAt: iso(r.received_at),
  }));
}

const parse = (doc: unknown): WireDoc => (typeof doc === "string" ? JSON.parse(doc) : (doc as WireDoc));

/** Open runs, then runs closed in the window, newest first; `repo` narrows to one owner/name. */
export async function listRuns(db: Db, repo: string | null): Promise<WireDoc[]> {
  const days = Math.max(KPI_DAYS, DORA_WEEKS * 7);
  const rows = await db.sql<{ doc: unknown }>(
    `select doc from runs where ($1::text is null or repo = $1) and (closed_at is null or closed_at > now() - make_interval(days => $2::int))
     order by closed_at is not null, created_at desc limit $3`,
    [repo, days, LIST_LIMIT],
  );
  return rows.map((r) => parse(r.doc));
}

export async function runDoc(db: Db, id: string): Promise<{ doc: WireDoc; factoryId: string; receivedAt: string } | null> {
  const [row] = await db.sql<{ doc: unknown; factory_id: string; received_at: unknown }>("select doc, factory_id, received_at from runs where id = $1", [id]);
  return row === undefined ? null : { doc: parse(row.doc), factoryId: row.factory_id, receivedAt: iso(row.received_at) };
}

export async function knownRepos(db: Db): Promise<string[]> {
  const fromRuns = await db.sql<{ repo: string }>("select distinct repo from runs");
  const beats = await heartbeats(db);
  return [...new Set([...beats.flatMap((b) => b.repos), ...fromRuns.map((r) => r.repo)])].sort();
}

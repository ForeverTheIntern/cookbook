/**
 * The write side of the read model. A run is stored only when its rev is
 * newer than the stored one, so retries, duplicates, out-of-order deliveries
 * and two overlapping Foreman runtimes all converge on the newest document.
 * A heartbeat answers with the ids the portal is missing or holds stale.
 */

import type { Db } from "./db.ts";
import type { HeartbeatMessage, RunMessage } from "./wire.ts";

export async function storeRun(db: Db, message: RunMessage): Promise<{ stored: boolean }> {
  const { run, transitions, roles } = message.doc;
  return db.transaction(async (sql) => {
    const kept = await sql(
      `insert into runs (id, factory_id, repo, issue, title, stage, hold, pr, rev, created_at, stage_since, closed_at, doc, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       on conflict (id) do update set factory_id = excluded.factory_id, repo = excluded.repo, issue = excluded.issue, title = excluded.title,
         stage = excluded.stage, hold = excluded.hold, pr = excluded.pr, rev = excluded.rev, created_at = excluded.created_at,
         stage_since = excluded.stage_since, closed_at = excluded.closed_at, doc = excluded.doc, received_at = now()
       where runs.rev < excluded.rev
       returning id`,
      [run.id, message.factoryId, run.repo, run.issue, run.title, run.stage, run.hold ?? null, run.pr ?? null, run.rev, run.createdAt, run.stageSince, run.closedAt, JSON.stringify(message.doc)],
    );
    if (kept.length === 0) return { stored: false };
    await sql("delete from transitions where run_id = $1", [run.id]);
    await sql("delete from role_runs where run_id = $1", [run.id]);
    for (const t of transitions) {
      await sql("insert into transitions (run_id, seq, stage, at, reason, actor) values ($1, $2, $3, $4, $5, $6)", [run.id, t.seq, t.stage, t.at, t.reason, t.actor ?? null]);
    }
    for (const r of roles) {
      await sql(
        `insert into role_runs (agent_id, run_id, role, visit, status, started_at, finished_at, cost_cents, cost_state, url)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (agent_id) do update set run_id = excluded.run_id, role = excluded.role, visit = excluded.visit, status = excluded.status,
           started_at = excluded.started_at, finished_at = excluded.finished_at, cost_cents = excluded.cost_cents, cost_state = excluded.cost_state, url = excluded.url`,
        [r.agentId, run.id, r.role, r.visit, r.status, r.startedAt, r.finishedAt ?? null, r.costCents ?? null, r.costState ?? null, r.url],
      );
    }
    return { stored: true };
  });
}

export async function storeHeartbeat(db: Db, message: HeartbeatMessage): Promise<{ need: string[] }> {
  await db.sql(
    `insert into heartbeats (factory_id, at, version, repos, open_count, received_at) values ($1, $2, $3, $4, $5, now())
     on conflict (factory_id) do update set at = excluded.at, version = excluded.version, repos = excluded.repos, open_count = excluded.open_count, received_at = now()`,
    [message.factoryId, message.at, message.version, JSON.stringify(message.repos), message.openCount],
  );
  if (message.runs.length === 0) return { need: [] };
  const stored = await db.sql<{ id: string; rev: number }>("select id, rev from runs where id = any($1::text[])", [message.runs.map((r) => r.id)]);
  const revs = new Map(stored.map((r) => [r.id, r.rev]));
  return { need: message.runs.filter((r) => (revs.get(r.id) ?? -1) < r.rev).map((r) => r.id) };
}

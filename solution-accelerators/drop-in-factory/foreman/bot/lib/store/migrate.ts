/**
 * The one-time import of a store from before host.kv: the SQLite file at
 * `.factory/factory.sqlite`. Runs, their transitions, role runs and post
 * dedupe keys become run documents; the factory id carries over, so issue
 * claims stay this factory's. The file is renamed to
 * `factory.sqlite.migrated` afterwards, so the import runs once. Pending
 * events are not carried over: the first tick reconciles every open run.
 */

import { existsSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RUN_DEFAULTS, type RoleRun, type Run, type RunDoc, type Transition } from "./runs.ts";
import type { Store } from "./store.ts";

export async function migrateSqlite(store: Store, path: string, defaultRepo: string, log: (line: string) => void): Promise<number> {
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  let closed = false;
  try {
    const all = (sql: string, ...args: any[]) => db.prepare(sql).all(...args) as any[];
    const has = (table: string) => all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table).length > 0;
    const factoryId = has("meta") ? (all("SELECT value FROM meta WHERE key = 'factory_id'")[0]?.value as string | undefined) : undefined;
    if (factoryId !== undefined && (await store.meta("factory")) === undefined) {
      await store.putMeta("factory", { id: factoryId, schema: 1, migratedFrom: path, migratedAt: new Date().toISOString() });
    }
    let n = 0;
    for (const r of all("SELECT * FROM runs ORDER BY created_at")) {
      if ((await store.doc(r.id)) !== null) continue;
      const rows = all("SELECT seq, stage, at, reason, actor FROM transitions WHERE run_id = ? ORDER BY seq", r.id);
      const visitOf = new Map<number, number>(rows.map((t, i) => [t.seq as number, i + 1]));
      const transitions: Transition[] = rows.map((t, i) => ({ seq: i + 1, runId: r.id, stage: t.stage, at: t.at, reason: t.reason, actor: t.actor ?? null }));
      const roles: RoleRun[] = all("SELECT * FROM role_runs WHERE run_id = ? ORDER BY started_at", r.id).map((x) => ({
        agentId: x.agent_id, runId: r.id, role: x.role, visit: visitOf.get(x.visit) ?? x.visit, status: x.status, baseSha: x.base_sha,
        startedAt: x.started_at, deadline: x.deadline, finishedAt: x.finished_at ?? null, url: x.url, costCents: x.cost_cents ?? null,
        costState: x.cost_state ?? (x.cost_cents == null ? null : "final"), costCheckedAt: x.cost_checked_at ?? null, costChangedAt: x.cost_changed_at ?? null,
      }));
      const posts = has("posts") ? all("SELECT target, key FROM posts WHERE run_id = ?", r.id).map((p) => `${p.target}:${p.key}`) : [];
      const run: Run = {
        ...RUN_DEFAULTS,
        id: r.id, repo: r.repo || defaultRepo, issue: r.issue, title: r.title, stage: r.stage, stageSince: r.stage_since,
        visit: visitOf.get(r.visit) ?? transitions.length, pmRound: r.pm_round, sendBacks: r.send_backs, feedback: r.feedback ?? null,
        gateSha: r.gate_sha ?? null, pr: r.pr ?? null, hold: r.hold ?? null, holdSince: r.hold_since ?? null,
        slackChannel: r.slack_channel ?? null, slackTs: r.slack_ts ?? null, statusTs: r.status_ts ?? null, statusText: r.status_text ?? null,
        statusAt: r.status_at ?? null, blocked: r.blocked ?? null, createdAt: r.created_at, closedAt: r.closed_at ?? null, rev: (r.version ?? 0) + 1,
      };
      const doc: RunDoc = { schema: 1, run, transitions, roles, posts, failures: 0 };
      await store.importDoc(doc);
      n += 1;
    }
    db.close();
    closed = true;
    renameSync(path, `${path}.migrated`);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) renameSync(path + suffix, `${path}.migrated${suffix}`);
    log(`imported ${n} run${n === 1 ? "" : "s"} from ${path} into host.kv; the file is now ${path}.migrated`);
    return n;
  } finally {
    if (!closed) db.close();
  }
}

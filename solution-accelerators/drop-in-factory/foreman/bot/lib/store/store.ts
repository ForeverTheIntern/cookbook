/**
 * The factory's state, on the Agent SDK's durable `host.kv`, so it survives
 * the platform replacing the process and works the same locally and on
 * Cursor hosting.
 *
 *   run/<id>                  the run document (RunDoc)
 *   idx/open                  ids of the open runs: the tick's list
 *   idx/closed/<yyyy-mm>      ids of the runs closed that month: history
 *   idx/thread/<channel>/<ts> run id of a Slack thread or message: request, status, open ask
 *   idx/pr/<repo>/<n>         run id of a pull request
 *   idx/once/<yyyy-mm-dd>     once-keys claimed that day, for the sweep
 *   lease/<name>              a lease, { owner, token, exp }; exp 0 once released
 *   once/<key>                a side effect already started
 *   meta/<name>               factory id, status-line budget, facts
 *
 * host.kv in @grok/agent-sdk 0.3.0 has no list and no compare-and-set. The
 * indexes are read-modify-write lists that every save of a run repairs, and
 * leases and once-keys are claimed by writing a token, waiting, and reading it
 * back. Two runtimes that overlap closely can both win: see "Known issues" in
 * ARCHITECTURE.md.
 */

import { randomUUID } from "node:crypto";
import { LEGACY_STAGES, type Stage } from "../pipeline/route.ts";
import type { Kv } from "./kv.ts";
import { ENDED, isOpen, RUN_DEFAULTS, runIdFor, type CostState, type RoleRun, type Run, type RunDoc, type Transition } from "./runs.ts";

/** A lock's lease. A reconcile that outlives it can be overtaken, so reconcile does little per step. */
export const LEASE_MS = 2 * 60_000;
/** How long a claim waits before reading its token back, so a writer that overlapped it has landed. */
export const SETTLE_MS = 150;

/** Lock queues for this process, shared by every Store over the same services (hosted code builds one per request). */
const localQueues = new Map<string, Promise<unknown>>();
const processOwner = randomUUID().slice(0, 8);

/** Why the last lease this process asked for was refused, for the tick's log. */
export let leaseRefusal: string | null = null;

export interface StoreOptions {
  clock?: () => number;
  settleMs?: number;
  /** Act as a runtime of its own, with its own owner and lock queues (tests of two runtimes in one process). */
  separateRuntime?: boolean;
}

interface Lease {
  owner: string;
  token: string;
  exp: number;
}

export class Store {
  readonly owner: string;
  private readonly local: Map<string, Promise<unknown>>;

  readonly kv: Kv;
  private readonly clock: () => number;
  private readonly settleMs: number;

  constructor(kv: Kv, options: StoreOptions = {}) {
    this.kv = kv;
    this.clock = options.clock ?? Date.now;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.owner = options.separateRuntime ? randomUUID().slice(0, 8) : processOwner;
    this.local = options.separateRuntime ? new Map() : localQueues;
  }

  // ---- meta ----

  async meta<T>(name: string): Promise<T | undefined> {
    return (await this.kv.get(`meta/${name}`)) as T | undefined;
  }

  async putMeta(name: string, value: unknown): Promise<void> {
    await this.kv.put(`meta/${name}`, value);
  }

  /** This factory's id, made on first use. Its claim on an issue tells another Foreman to keep off. */
  async factoryId(): Promise<string> {
    const meta = await this.meta<{ id: string }>("factory");
    if (meta !== undefined) return meta.id;
    if (await this.createOnce("factory-id", "")) {
      const id = randomUUID().slice(0, 8);
      await this.putMeta("factory", { id, schema: 1 });
      return id;
    }
    for (let i = 0; i < 20; i += 1) {
      const again = await this.meta<{ id: string }>("factory");
      if (again !== undefined) return again.id;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the factory id is being created by another runtime; try again");
  }

  // ---- run documents ----

  /**
   * A run document, with run fields added since it was written filled in from
   * RUN_DEFAULTS, and stage and step names earlier versions stored read as
   * today's (LEGACY_STAGES).
   */
  async doc(id: string): Promise<RunDoc | null> {
    const doc = (await this.kv.get(`run/${id}`)) as RunDoc | undefined;
    if (doc === undefined) return null;
    const name = (s: string) => LEGACY_STAGES[s] ?? s;
    return {
      ...doc,
      run: { ...RUN_DEFAULTS, ...doc.run, stage: name(doc.run.stage) },
      transitions: doc.transitions.map((t) => ({ ...t, stage: name(t.stage) })),
      roles: doc.roles.map((r) => ({ ...r, role: name(r.role) })),
    };
  }

  async getRun(id: string): Promise<Run | null> {
    return (await this.doc(id))?.run ?? null;
  }

  async openIds(): Promise<string[]> {
    return this.list("idx/open");
  }

  /** Every open run, oldest first. */
  async openRuns(): Promise<Run[]> {
    const docs = await Promise.all((await this.openIds()).map((id) => this.doc(id)));
    return docs.filter((d): d is RunDoc => d !== null && isOpen(d.run)).map((d) => d.run).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async openDocs(): Promise<RunDoc[]> {
    const docs = await Promise.all((await this.openIds()).map((id) => this.doc(id)));
    return docs.filter((d): d is RunDoc => d !== null && isOpen(d.run));
  }

  /** Runs closed in the given months (`yyyy-mm`), newest month last. */
  async closedIds(months: string[]): Promise<string[]> {
    return (await Promise.all(months.map((m) => this.list(`idx/closed/${m}`)))).flat();
  }

  /** Open runs plus those closed since `since`, newest first. */
  async recentDocs(since: string): Promise<RunDoc[]> {
    const months = monthsSince(since, new Date(this.clock()).toISOString());
    const ids = [...new Set([...(await this.openIds()), ...(await this.closedIds(months))])];
    const docs = (await Promise.all(ids.map((id) => this.doc(id)))).filter((d): d is RunDoc => d !== null);
    return docs.filter((d) => isOpen(d.run) || (d.run.closedAt ?? "") >= since).sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  }

  async runByThread(channel: string, ts: string): Promise<Run | null> {
    const id = (await this.kv.get(`idx/thread/${channel}/${ts}`)) as string | undefined;
    return id === undefined ? null : this.getRun(id);
  }

  async runByPr(repo: string, pr: number): Promise<Run | null> {
    const id = (await this.kv.get(`idx/pr/${repo}/${pr}`)) as string | undefined;
    return id === undefined ? null : this.getRun(id);
  }

  /** Create the run at intake, under its lock. Returns null when a run for this issue already exists. */
  async createRun(
    input: { repo: string; key: string; issue: number; title: string; slackChannel: string | null; requestTs?: string | null; requester?: string | null },
    now: string,
  ): Promise<Run | null> {
    const id = runIdFor(input.key, input.issue);
    if ((await this.doc(id)) !== null) return null;
    const run: Run = {
      ...RUN_DEFAULTS,
      id, repo: input.repo, issue: input.issue, title: input.title, stage: "intake", stageSince: now, visit: 1, pmRound: 0, sendBacks: 0,
      feedback: null, gateSha: null, pr: null, hold: null, holdSince: null, slackChannel: input.slackChannel, slackTs: null,
      statusTs: null, statusText: null, statusAt: null, blocked: null, createdAt: now, closedAt: null, rev: 1,
      requestTs: input.requestTs ?? null, requester: input.requester ?? null,
    };
    const doc: RunDoc = { schema: 1, run, transitions: [{ seq: 1, runId: id, stage: "intake", at: now, reason: "intake", actor: null }], roles: [], posts: [], failures: 0 };
    await this.kv.put(`run/${id}`, doc);
    await this.addTo("idx/open", id);
    if (run.requestTs !== null) await this.kv.put(`idx/thread/${input.slackChannel}/${run.requestTs}`, id);
    return run;
  }

  /** Write the run back. Fails when another write landed since it was read. */
  async saveRun(run: Run): Promise<Run> {
    const doc = await this.mustDoc(run.id);
    if (doc.run.rev !== run.rev) throw new Error(`run ${run.id} changed underneath this write (rev ${run.rev}, stored ${doc.run.rev})`);
    const saved = { ...run, rev: run.rev + 1 };
    await this.putDoc({ ...doc, run: saved }, doc.run);
    return saved;
  }

  /** Enter a stage (or re-enter it, as a new visit) and record why. */
  async moveTo(run: Run, stage: Stage, reason: string, actor: string | null, now: string): Promise<Run> {
    const doc = await this.mustDoc(run.id);
    if (doc.run.rev !== run.rev) throw new Error(`run ${run.id} changed underneath this write (rev ${run.rev}, stored ${doc.run.rev})`);
    const seq = doc.transitions.length + 1;
    const closed = ENDED.has(stage);
    const moved: Run = { ...run, stage, stageSince: now, visit: seq, gateSha: null, hold: null, holdSince: null, closedAt: closed ? now : null, rev: run.rev + 1 };
    await this.putDoc({ ...doc, run: moved, transitions: [...doc.transitions, { seq, runId: run.id, stage, at: now, reason, actor }] }, doc.run);
    return moved;
  }

  async transitions(runId: string): Promise<Transition[]> {
    return (await this.doc(runId))?.transitions ?? [];
  }

  async roleRuns(runId: string): Promise<RoleRun[]> {
    return [...((await this.doc(runId))?.roles ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async roleRunFor(runId: string, visit: number): Promise<RoleRun | null> {
    return (await this.doc(runId))?.roles.find((r) => r.visit === visit) ?? null;
  }

  async insertRoleRun(r: Omit<RoleRun, "finishedAt" | "costCents" | "costState" | "costCheckedAt" | "costChangedAt">): Promise<void> {
    const doc = await this.mustDoc(r.runId);
    if (doc.roles.some((x) => x.visit === r.visit)) throw new Error(`run ${r.runId} already has a role run for visit ${r.visit}`);
    const row: RoleRun = { ...r, finishedAt: null, costCents: null, costState: null, costCheckedAt: null, costChangedAt: null };
    await this.putDoc({ ...doc, roles: [...doc.roles, row] }, doc.run);
  }

  async updateRoleRun(runId: string, agentId: string, status: string, finishedAt: string | null): Promise<void> {
    await this.editRole(runId, agentId, (r) => ({ ...r, status, finishedAt: r.finishedAt ?? finishedAt }));
  }

  /** Replaces, never adds to, the stored figure, so a repeated read cannot count an event twice. */
  async setRoleCost(runId: string, agentId: string, cost: { cents: number | null; state: CostState | null; checkedAt: string; changedAt: string | null }): Promise<void> {
    await this.editRole(runId, agentId, (r) => ({ ...r, costCents: cost.cents, costState: cost.state, costCheckedAt: cost.checkedAt, costChangedAt: cost.changedAt }));
  }

  /** Count a failed reconcile; returns how many in a row. Zero resets. */
  async setFailures(runId: string, failures: number): Promise<number> {
    const doc = await this.doc(runId);
    if (doc === null || doc.failures === failures) return failures;
    await this.kv.put(`run/${runId}`, { ...doc, failures });
    return failures;
  }

  /** Run `post` once per (run, target, key). A replayed trigger finds the key and posts nothing. */
  async postOnce(runId: string, target: "github" | "slack", key: string, post: () => Promise<unknown>): Promise<boolean> {
    if (await this.posted(runId, target, key)) return false;
    await post();
    const doc = await this.mustDoc(runId);
    await this.kv.put(`run/${runId}`, { ...doc, posts: [...doc.posts, `${target}:${key}`] });
    return true;
  }

  async posted(runId: string, target: "github" | "slack", key: string): Promise<boolean> {
    return (await this.doc(runId))?.posts.includes(`${target}:${key}`) ?? false;
  }

  /** Import a whole document as is: the SQLite migration. */
  async importDoc(doc: RunDoc): Promise<void> {
    await this.putDoc(doc, null);
  }

  private async editRole(runId: string, agentId: string, edit: (r: RoleRun) => RoleRun): Promise<void> {
    const doc = await this.mustDoc(runId);
    await this.kv.put(`run/${runId}`, { ...doc, roles: doc.roles.map((r) => (r.agentId === agentId ? edit(r) : r)) });
  }

  private async mustDoc(id: string): Promise<RunDoc> {
    const doc = await this.doc(id);
    if (doc === null) throw new Error(`run ${id} is not in the store`);
    return doc;
  }

  /**
   * Write the document and keep the indexes in step. The open list is checked
   * on every save, not only when the stage changes, so an id that a racing
   * writer dropped from it comes back the next time its run is saved.
   */
  private async putDoc(doc: RunDoc, before: Run | null): Promise<void> {
    const run = doc.run;
    await this.kv.put(`run/${run.id}`, doc);
    if (run.pr !== null && run.pr !== before?.pr) await this.kv.put(`idx/pr/${run.repo}/${run.pr}`, run.id);
    for (const field of ["slackTs", "statusTs", "requestTs", "askTs"] as const) {
      const ts = run[field];
      if (ts !== null && ts !== before?.[field]) await this.kv.put(`idx/thread/${run.slackChannel}/${ts}`, run.id);
    }
    if (isOpen(run)) {
      await this.addTo("idx/open", run.id);
    } else {
      if (before === null || isOpen(before)) await this.addTo(`idx/closed/${run.closedAt!.slice(0, 7)}`, run.id);
      await this.removeFrom("idx/open", run.id);
    }
  }

  // ---- index lists ----

  private async list(key: string): Promise<string[]> {
    const value = await this.kv.get(key);
    return Array.isArray(value) ? (value as string[]) : [];
  }

  /** Add `id` and read the list back, adding again if a racing writer's list replaced ours. */
  private async addTo(key: string, id: string): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      const ids = await this.list(key);
      if (ids.includes(id)) return;
      await this.kv.put(key, [...ids, id]);
    }
  }

  private async removeFrom(key: string, id: string): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      const ids = await this.list(key);
      if (!ids.includes(id)) return;
      await this.kv.put(key, ids.filter((x) => x !== id));
    }
  }

  // ---- locks and once-only side effects ----

  /**
   * Run `fn` holding the named lease, or return null without running it when
   * another runtime holds an unexpired one. Inside one process, callers wait
   * their turn instead. Across runtimes the lease is best effort: two that
   * claim it within about SETTLE_MS of each other can both read their own
   * token back.
   */
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const prior = this.local.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prior.then(() => mine);
    this.local.set(name, chained);
    await prior;
    try {
      const key = `lease/${name}`;
      const token = await this.takeLease(key);
      if (token === null) return null;
      try {
        return await fn();
      } finally {
        await this.dropLease(key, token).catch(() => {});
      }
    } finally {
      release();
      if (this.local.get(name) === chained) this.local.delete(name);
    }
  }

  // A lease is released by expiring it, never by deleting the key, so a
  // release can't race a new holder's claim into a missing key.
  private async takeLease(key: string): Promise<string | null> {
    const held = (await this.kv.get(key)) as Lease | undefined;
    if (held !== undefined && held.exp > this.clock()) {
      leaseRefusal = `${key} is held by ${held.owner} until ${new Date(held.exp).toISOString()}`;
      return null;
    }
    const token = randomUUID();
    if (await this.claim(key, { owner: this.owner, token, exp: this.clock() + LEASE_MS })) return token;
    leaseRefusal = `another runtime took ${key} first`;
    return null;
  }

  private async dropLease(key: string, token: string): Promise<void> {
    const held = (await this.kv.get(key)) as Lease | undefined;
    if (held?.token !== token) return;
    await this.kv.put(key, { owner: this.owner, token, exp: 0 });
  }

  /** Write a value carrying a fresh token, wait for overlapping writers to land, and report whether ours survived. */
  private async claim<V extends { token: string }>(key: string, value: V): Promise<boolean> {
    await this.kv.put(key, value);
    if (this.settleMs > 0) await new Promise((r) => setTimeout(r, this.settleMs));
    return ((await this.kv.get(key)) as { token?: string } | undefined)?.token === value.token;
  }

  /** True the first time `key` is claimed; false ever after, and usually for the loser of a race. */
  async createOnce(key: string, body: string): Promise<boolean> {
    const k = `once/${key}`;
    if ((await this.kv.get(k)) !== undefined) return false;
    const at = new Date(this.clock()).toISOString();
    if (!(await this.claim(k, { at, body, token: randomUUID() }))) return false;
    await this.addTo(`idx/once/${at.slice(0, 10)}`, key);
    return true;
  }

  /** Delete once-keys from days that ended more than `ms` ago, looking back 30 days further for missed sweeps. */
  async sweep(ms: number): Promise<number> {
    let removed = 0;
    const cutoff = this.clock() - ms;
    for (let day = startOfDay(cutoff - 30 * DAY_MS); day + DAY_MS <= cutoff; day += DAY_MS) {
      const bucket = `idx/once/${new Date(day).toISOString().slice(0, 10)}`;
      const keys = await this.list(bucket);
      if (keys.length === 0) continue;
      for (const key of keys) await this.kv.delete(`once/${key}`);
      await this.kv.delete(bucket);
      removed += keys.length;
    }
    return removed;
  }
}

const DAY_MS = 86_400_000;
const startOfDay = (ms: number) => ms - (ms % DAY_MS);

function monthsSince(since: string, now: string): string[] {
  const out: string[] = [];
  const d = new Date(`${since.slice(0, 7)}-01T00:00:00Z`);
  while (d.toISOString().slice(0, 7) <= now.slice(0, 7)) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

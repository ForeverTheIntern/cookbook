/**
 * Refresh the DORA facts from GitHub, and invoice cents for finished roles
 * when a Team Admin API key is set. The tick runs both. Facts are a cache of
 * GitHub, kept per repository in the store as `meta/facts/<key>`.
 */

import { api, type GitHub } from "../github/rest.ts";
import { deployments } from "../github/gh.ts";
import type { Ctx } from "../pipeline/reconcile.ts";
import type { RoleRun } from "../store/runs.ts";
import type { Store } from "../store/store.ts";

export interface Deploy {
  repo: string;
  id: string;
  sha: string;
  at: string;
  firstCommitAt: string | null;
  failed: boolean;
}

export interface Incident {
  repo: string;
  number: number;
  openedAt: string;
  closedAt: string | null;
}

export interface Facts {
  at: string;
  deploys: Deploy[];
  incidents: Incident[];
}

export const factsKey = (repoKey: string) => `facts/${repoKey}`;

/** The cached facts of several repositories, merged. */
export async function readFacts(store: Store, repoKeys: string[]): Promise<{ deploys: Deploy[]; incidents: Incident[] }> {
  const all = await Promise.all(repoKeys.map((k) => store.meta<Facts>(factsKey(k))));
  return { deploys: all.flatMap((f) => f?.deploys ?? []), incidents: all.flatMap((f) => f?.incidents ?? []) };
}

export interface FactsSource {
  github: GitHub;
  /** Team Admin usage, or null when CURSOR_ADMIN_API_KEY is not set. */
  usage: { centsForAgent(agentId: string, nowIso: string): Promise<{ cents: number; events: number }> } | null;
}

interface MergedPull {
  number: number;
  title: string;
  labels: string[];
  mergedAt: string;
  mergeSha: string;
  firstCommitAt: string | null;
}

export async function refreshFacts(ctx: Ctx): Promise<void> {
  if (ctx.facts === null) return;
  const { github, usage } = ctx.facts;
  const since = new Date(Date.parse(ctx.now()) - ctx.config.dora.weeks * 7 * 86_400_000).toISOString();

  const merged = await mergedPulls(github, ctx.config.base, since);
  const bySha = new Map(merged.map((p) => [p.mergeSha, p]));
  const deploys =
    ctx.config.dora.deploySource === "merges"
      ? merged.map((p) => ({ id: `merge:${p.number}`, sha: p.mergeSha, at: p.mergedAt, pull: p }))
      : (await deployments(github, ctx.config.dora.environment, since)).map((d) => ({ id: d.id, sha: d.sha, at: d.at, pull: bySha.get(d.sha) ?? null }));
  deploys.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const reverted = new Set(merged.filter((p) => p.title.startsWith('Revert "')).map((p) => p.title.slice(8, -1)));
  const isHotfix = (p: MergedPull | null) => p !== null && p.labels.some((l) => ctx.config.dora.hotfixLabels.includes(l));

  const incidents = await api(
    github, "GET",
    `/repos/${github.repo}/issues?state=all&labels=${encodeURIComponent(ctx.config.dora.incidentLabel)}&since=${since}&per_page=100`,
  );

  const repo = ctx.config.repo;
  const facts: Facts = {
    at: ctx.now(),
    deploys: deploys.map((d, i) => ({
      repo, id: d.id, sha: d.sha, at: d.at, firstCommitAt: d.pull?.firstCommitAt ?? null,
      failed: (d.pull !== null && reverted.has(d.pull.title)) || isHotfix(deploys[i + 1]?.pull ?? null),
    })),
    incidents: incidents.filter((i: any) => !i.pull_request).map((i: any) => ({ repo, number: i.number, openedAt: i.created_at, closedAt: i.closed_at })),
  };
  await ctx.store.putMeta(factsKey(ctx.config.key), facts);
}

/**
 * When a finished role's cost is read. Usage events usually show up on
 * filtered-usage-events within seconds of an agent finishing, so the first
 * read is a minute after the finish. Later reads
 * back off with the role's age (a quarter of it, between 2 and 15 minutes).
 * The figure is final once it has not changed for `stableMs`, or at `capMs`
 * after the finish, whichever comes first. Nothing is projected: until a read
 * returns events there is no figure, and a settling figure is what the API
 * returned so far.
 */
export const COST_SCHEDULE = {
  firstReadMs: 60_000,
  minIntervalMs: 2 * 60_000,
  maxIntervalMs: 15 * 60_000,
  stableMs: 30 * 60_000,
  capMs: 2 * 60 * 60_000,
};

/** The time a role's next cost read is due, or null when it needs none. */
export function costReadDue(rr: RoleRun): number | null {
  if (rr.finishedAt === null || rr.costState === "final") return null;
  const finished = Date.parse(rr.finishedAt);
  if (rr.costCheckedAt === null) return finished + COST_SCHEDULE.firstReadMs;
  const checked = Date.parse(rr.costCheckedAt);
  const interval = Math.min(COST_SCHEDULE.maxIntervalMs, Math.max(COST_SCHEDULE.minIntervalMs, (checked - finished) / 4));
  return checked + interval;
}

/** Read every finished role whose cost read is due: those of open runs and runs closed in the last 3 hours. */
export async function refreshCosts(ctx: Ctx, usage: NonNullable<FactsSource["usage"]>): Promise<void> {
  const nowIso = ctx.now();
  const now = Date.parse(nowIso);
  const since = new Date(now - COST_SCHEDULE.capMs - 3_600_000).toISOString();
  const roles = (await ctx.store.recentDocs(since)).flatMap((d) => d.roles);
  for (const rr of roles) {
    const due = costReadDue(rr);
    if (due === null || due > now) continue;
    const read = await usage.centsForAgent(rr.agentId, nowIso);
    const cents = read.events === 0 ? null : read.cents;
    const changed = cents !== null && (rr.costCents === null || Math.abs(cents - rr.costCents) > 1e-9);
    const changedAt = changed ? nowIso : rr.costChangedAt;
    const capped = now - Date.parse(rr.finishedAt!) >= COST_SCHEDULE.capMs;
    const stable = changedAt !== null && now - Date.parse(changedAt) >= COST_SCHEDULE.stableMs;
    const state = capped || stable ? "final" : cents === null ? null : "settling";
    await ctx.store.withLock(rr.runId, () => ctx.store.setRoleCost(rr.runId, rr.agentId, { cents: cents ?? (state === "final" ? 0 : null), state, checkedAt: nowIso, changedAt }));
  }
}

async function mergedPulls(github: GitHub, base: string, since: string): Promise<MergedPull[]> {
  const rows = await api(github, "GET", `/repos/${github.repo}/pulls?state=closed&base=${base}&sort=updated&direction=desc&per_page=100`);
  const out: MergedPull[] = [];
  for (const pr of rows) {
    if (pr.merged_at === null || pr.merged_at < since) continue;
    const commits = await api(github, "GET", `/repos/${github.repo}/pulls/${pr.number}/commits?per_page=1`);
    out.push({
      number: pr.number,
      title: pr.title,
      labels: pr.labels.map((l: { name: string }) => l.name),
      mergedAt: pr.merged_at,
      mergeSha: pr.merge_commit_sha,
      firstCommitAt: commits[0]?.commit.author.date ?? null,
    });
  }
  return out;
}

/**
 * The doctor's check of CURSOR_ADMIN_API_KEY: the Admin API accepts it, and
 * its team includes the account behind CURSOR_API_KEY. Usage events are per
 * team, so an admin key from another team reads no cost for the factory's
 * agents. Returns what it confirmed; throws what to fix.
 */
export async function checkAdminKey(adminApiKey: string, cursorApiKey: string): Promise<string> {
  const basic = (key: string) => `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
  const members = await fetch("https://api.cursor.com/teams/members", { headers: { authorization: basic(adminApiKey) } });
  if (members.status === 401 || members.status === 403) {
    throw new Error(`CURSOR_ADMIN_API_KEY was rejected (${members.status}); a team admin creates one under the team's Admin API keys (a user API key does not work here)`);
  }
  if (!members.ok) throw new Error(`GET /teams/members returned ${members.status}`);
  const me = await fetch("https://api.cursor.com/v0/me", { headers: { authorization: basic(cursorApiKey) } });
  if (!me.ok) throw new Error(`CURSOR_API_KEY was rejected (${me.status}), so the admin key's team cannot be compared with it`);
  const { userEmail } = (await me.json()) as { userEmail: string };
  const { teamMembers } = (await members.json()) as { teamMembers: { email: string; isRemoved?: boolean }[] };
  const active = teamMembers.filter((m) => m.isRemoved !== true);
  if (!active.some((m) => m.email.toLowerCase() === userEmail.toLowerCase())) {
    throw new Error(`the team of CURSOR_ADMIN_API_KEY (${active.length} members) does not include ${userEmail}, the account behind CURSOR_API_KEY, so it would read no cost for the factory's agents; use an admin key from that account's team`);
  }
  return `key accepted, and its team (${active.length} members) includes ${userEmail}, the account behind CURSOR_API_KEY`;
}

/**
 * Invoice cents from the Admin API for one cloud agent: the sum of
 * `chargedCents` (what the team is billed, including the Cursor token fee,
 * not `tokenUsage.totalCents`) over the usage events filtered on its id.
 * Filtering on the agent, not the account, keeps overlapping roles apart.
 * The agent id is the whole filter: an agent's first usage event can be
 * timestamped before its own createdAt, so any window anchored to the role's
 * start drops it.
 */
export function adminUsage(adminApiKey: string): FactsSource["usage"] {
  const authorization = `Basic ${Buffer.from(`${adminApiKey}:`).toString("base64")}`;
  return {
    async centsForAgent(agentId, nowIso) {
      let cents = 0;
      let events = 0;
      // A page boundary can shift while new events arrive, so one event may come back on two pages.
      const seen = new Set<string>();
      for (let page = 1; ; page += 1) {
        const response = await fetch("https://api.cursor.com/teams/filtered-usage-events", {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ startDate: 0, endDate: Date.parse(nowIso), cloudAgentId: agentId, page, pageSize: 1000 }),
        });
        if (!response.ok) throw new Error(`Admin API usage events returned ${response.status}`);
        const body = await response.json();
        for (const e of body.usageEvents ?? []) {
          if (e.cloudAgentId !== agentId) throw new Error(`Admin API returned a usage event for ${e.cloudAgentId ?? "no cloud agent"} when asked for ${agentId}`);
          if (typeof e.chargedCents !== "number") throw new Error(`Admin API usage event for ${agentId} has no chargedCents`);
          if (typeof e.usageEventId === "string") {
            if (seen.has(e.usageEventId)) continue;
            seen.add(e.usageEventId);
          }
          cents += e.chargedCents;
          events += 1;
        }
        if (!body.pagination?.hasNextPage) return { cents, events };
      }
    },
  };
}

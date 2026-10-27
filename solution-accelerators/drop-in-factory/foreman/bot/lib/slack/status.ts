/**
 * Each run's one-line status in the factory channel: the bot's own top-level
 * message, edited with chat.update as the run moves, so the channel reads as
 * a list of every run's latest state. The per-stage detail stays in the
 * thread. The worker is the only caller.
 *
 * Edits are coalesced: the line is recomputed from the store, sent only when
 * its text changed, at most once per run every RUN_SPACING_MS and at most
 * one edit per GLOBAL_SPACING_MS across runs. A burst of events becomes one
 * edit carrying the latest text, well inside chat.update's Tier 3 limit.
 */

import type { Ctx } from "../pipeline/reconcile.ts";
import { CLARIFICATION, gateAt, specAsker, stageLine } from "../pipeline/route.ts";
import { admission, runCost, type Run, type RunDoc } from "../store/runs.ts";
import { DEFAULT_REACTIONS } from "../config/factory.ts";
import { plural, t } from "../templates.ts";
import { slackHint, statusBlocks } from "./blocks.ts";
import { SlackError, type Blocks } from "./post.ts";

export const RUN_SPACING_MS = 10_000;
export const GLOBAL_SPACING_MS = 1_000;

/** What a run waiting on a person shows: answers to the spec step's questions, or a gate's approval. */
function waiting(config: Ctx["config"], stage: string): [string, string] | null {
  if (stage === CLARIFICATION) return [t("status.questions"), t("status.questions.detail", { asker: specAsker(config) })];
  const gate = gateAt(config, stage);
  return gate === null ? null : [t("status.gate", { gate: gate.name }), t("status.gate.detail", { gate: gate.name })];
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const link = (url: string, text: string) => `<${url}|${text.replace(/[<>|]/g, "")}>`;

/** The status line for a run, from the store alone. */
export async function statusLine(ctx: Pick<Ctx, "store" | "config">, run: Run): Promise<string> {
  const doc = await ctx.store.doc(run.id);
  const open = run.stage === "intake" ? await ctx.store.openRuns() : [];
  return statusText(ctx.config, run, doc, open);
}

/** The status line from a run document; `open` is every open run, needed only while the run waits at intake. */
export function statusText(config: Ctx["config"], run: Run, doc: RunDoc | null, open: Run[]): string {
  const issue = `https://github.com/${run.repo}/issues/${run.issue}`;
  return [t("status.title", { issue: link(issue, t("status.link.issue", { key: config.key, issue: run.issue })), title: short(run.title, 60) }), ...stateParts(config, run, doc, open), ...extraLinks(run, doc)].join(" · ");
}

/** The pull request, each running agent session and the cost. */
function extraLinks(run: Run, doc: RunDoc | null): string[] {
  const parts: string[] = [];
  if (run.pr !== null) parts.push(link(`https://github.com/${run.repo}/pull/${run.pr}`, t("status.link.pull", { pr: run.pr })));
  for (const a of runningAgents(doc)) parts.push(link(a.url, t("status.link.agent", { role: a.role })));
  const cost = runCost(doc?.roles ?? []);
  if (cost.cents !== null) parts.push(t("status.cost", { cost: (cost.cents / 100).toFixed(2), state: cost.state }));
  return parts;
}

/** The Cursor agent sessions still running for a run. */
export const runningAgents = (doc: Pick<RunDoc, "roles"> | null) => (doc?.roles ?? []).filter((r) => r.finishedAt === null);

/** The status message as Block Kit: header, stage line, links and the reply hint. Its text is statusText. */
export function statusMessage(config: Ctx["config"], run: Run, doc: RunDoc | null, open: Run[]): { text: string; blocks: Blocks } {
  const issue = `https://github.com/${run.repo}/issues/${run.issue}`;
  const [state, ...detail] = stateParts(config, run, doc, open);
  return {
    text: statusText(config, run, doc, open),
    blocks: statusBlocks({
      header: t("status.header", { title: run.title, repo: run.repo }),
      stage: [state, ...detail].join(" · "),
      links: [link(issue, t("status.link.issue", { key: config.key, issue: run.issue })), t("status.run", { run: run.id }), ...extraLinks(run, doc)],
      hint: slackHint("status", config.slack?.reactions ?? DEFAULT_REACTIONS),
    }),
  };
}

function stateParts(config: Ctx["config"], run: Run, doc: RunDoc | null, open: Run[]): string[] {
  if (run.stage === "done") return [t("status.done"), t("status.done.detail", { pr: run.pr ?? "" })];
  if (run.stage === "closed" || run.stage === "abandoned") {
    const last = doc?.transitions.at(-1);
    return [t(run.stage === "closed" ? "status.closed" : "status.abandoned"), short(last?.reason ?? t("status.ended.detail"), 80)];
  }
  if (run.hold !== null) return [t("status.failed", { stage: run.stage }), short(run.hold, 90), t("status.failed.hint")];
  if (run.stage === "intake") {
    const { start, ahead } = admission(open, run, config.limits);
    return start ? [t("status.starting")] : [t("status.queued"), ahead === 0 ? t("status.queued.next") : plural("status.queued.ahead", ahead)];
  }
  if (run.stage === "awaiting_merge") {
    if (run.blocked === "conflict") return [t("status.merge.ready"), t("status.merge.conflict", { base: config.base })];
    if (run.blocked === "checks") return [t("status.merge.checks"), t("status.merge.checks.detail")];
    if (run.blocked === "findings") return [t("status.merge.findings"), t("status.merge.findings.detail")];
    return [t("status.merge.ready"), t("status.merge.waiting")];
  }
  const wait = waiting(config, run.stage);
  if (wait !== null) return wait;
  return [t("status.running", { stage: run.stage }), stageLine(config, run.stage)];
}

/** Rate state shared by every run's edits, kept in the store so it holds across runtimes. */
export interface StatusBudget {
  lastEditAt: number;
  pausedUntil: number;
}

const BUDGET = "slack-budget";

/**
 * Send at most one status edit: the run whose line is out of date and was
 * edited longest ago, if the per-run and global spacing allow. Returns the
 * run id it edited, or null. Pass `only` to consider one run. A missing
 * parent message (deleted, or never reachable) gets a fresh status line; a
 * Slack rate limit pauses edits for its Retry-After. Never throws for a
 * Slack error, so a status line cannot hold a run. Each edit happens under
 * the run's lock, so it cannot interleave with a reconcile's save.
 */
export async function flushStatus(ctxs: Ctx[], only?: string): Promise<string | null> {
  const first = ctxs[0];
  const store = first.store;
  const now = Date.parse(first.now());
  const budget = (await store.meta<StatusBudget>(BUDGET)) ?? { lastEditAt: 0, pausedUntil: 0 };
  if (now < budget.pausedUntil || now - budget.lastEditAt < GLOBAL_SPACING_MS) return null;
  const docs = only === undefined ? await statusDocs(first) : [await store.doc(only)].filter((d): d is RunDoc => d !== null);
  const open = (await store.openDocs()).map((d) => d.run);
  const stale: { ctx: Ctx; run: Run; text: string; blocks: Blocks }[] = [];
  for (const doc of docs) {
    const run = doc.run;
    const ctx = ctxs.find((c) => c.config.repo === run.repo);
    if (ctx === undefined || ctx.ports.slack === null || run.statusTs === null) continue;
    if (run.statusAt !== null && now - Date.parse(run.statusAt) < RUN_SPACING_MS) continue;
    const message = statusMessage(ctx.config, run, doc, open);
    if (message.text !== run.statusText) stale.push({ ctx, run, ...message });
  }
  if (stale.length === 0) return null;
  stale.sort((a, b) => Date.parse(a.run.statusAt ?? "1970-01-01") - Date.parse(b.run.statusAt ?? "1970-01-01"));
  const { ctx, run: picked, text, blocks } = stale[0];
  await store.putMeta(BUDGET, { ...budget, lastEditAt: now });
  await store.withLock(picked.id, async () => {
    const run = (await store.getRun(picked.id))!;
    try {
      await ctx.ports.slack!.update(run.slackChannel!, run.statusTs!, text, blocks);
      await store.saveRun({ ...run, statusText: text, statusAt: ctx.now() });
    } catch (error) {
      if (error instanceof SlackError && error.code === "ratelimited") {
        await store.putMeta(BUDGET, { lastEditAt: now, pausedUntil: now + error.retryAfterS * 1000 });
        ctx.log(`Slack rate limit on status edits; pausing them for ${error.retryAfterS} s`);
      } else if (error instanceof SlackError && (error.code === "message_not_found" || error.code === "cant_update_message")) {
        const ts = await ctx.ports.slack!.post(run.slackChannel!, text, null, blocks);
        const moved = run.slackTs === run.statusTs ? { slackTs: ts } : {};
        await store.saveRun({ ...run, ...moved, statusTs: ts, statusText: text, statusAt: ctx.now() });
        ctx.log(`${run.id}: its status line was gone (${error.code}); posted a new one${moved.slackTs === undefined ? "" : ", and the run thread moved to it"}`);
      } else {
        await store.saveRun({ ...run, statusAt: ctx.now() });
        ctx.log(`${run.id}: status line edit failed: ${(error as Error).message}`);
      }
    }
  });
  return picked.id;
}

/** Open runs, plus runs closed in the last 3 hours: their cost turns final up to 2 hours after the last agent finished. */
async function statusDocs(ctx: Ctx): Promise<RunDoc[]> {
  const since = new Date(Date.parse(ctx.now()) - 3 * 3_600_000).toISOString();
  return (await ctx.store.recentDocs(since)).filter((d) => d.run.statusTs !== null);
}

/**
 * The first status message for a run, posted top-level in its channel. Its
 * thread is the run's status thread, where every follow-up goes. The caller
 * holds the run's lock.
 */
export async function postStatus(ctx: Ctx, run: Run, channel: string): Promise<Run> {
  const doc = await ctx.store.doc(run.id);
  const open = run.stage === "intake" ? await ctx.store.openRuns() : [];
  const { text, blocks } = statusMessage(ctx.config, run, doc, open);
  const ts = await ctx.ports.slack!.post(channel, text, null, blocks);
  return ctx.store.saveRun({ ...run, slackChannel: channel, slackTs: ts, statusTs: ts, statusText: text, statusAt: ctx.now() });
}

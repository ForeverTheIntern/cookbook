/**
 * Every trigger ends in reconcile(runId): a GitHub delivery, a Slack message,
 * or the tick. There is no queue and no long-lived loop, so this runs the
 * same in a local `agent-sdk serve` and in a hosted runtime that the platform may
 * replace at any time. Each reconcile holds its run's lock, and each side
 * effect has a dedupe key, so a repeated or overlapping trigger converges.
 *
 * The tick (bot/schedules/tick.ts, every minute) reconciles every run waiting
 * on something outside the factory (a gate, answers, merge, admission, a
 * `retry`), and every run whose step agent has ended or is overdue. It also
 * refreshes facts and costs, edits status lines, sends the portal heartbeat,
 * and exports OTel when configured.
 * One dispatcher serves every repository in factory.yaml: each run reconciles in its repository's Ctx.
 */

import { createHash } from "node:crypto";
import { TERMINAL } from "../steps/cloud-agent.ts";
import { refreshCosts, refreshFacts, factsKey, type Facts } from "../metrics/facts.ts";
import { exportMetrics } from "../metrics/otel.ts";
import { heartbeat, pushRun, type Portal } from "../dashboard-push.ts";
import { sameRequest } from "../slack/request.ts";
import { flushStatus, postStatus } from "../slack/status.ts";
import { duplicateOf, runIdFor, threadUrl, type Run } from "../store/runs.ts";
import { leaseRefusal, type Store } from "../store/store.ts";
import { FACTORY_MARK } from "./gates.ts";
import type { Trigger } from "./ingress.ts";
import { ABANDONED_WINDOW_MS, duplicateLink, reconcile, reconcileLocked, slackCommand, steer, type Ctx } from "./reconcile.ts";
import type { SlackCommand } from "./gates.ts";
import { stepAt } from "./route.ts";
import { t } from "../templates.ts";

export const TICK_MS = 60_000;
const FACTS_EVERY_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60 * 60_000;
const ONCE_KEEP_MS = 14 * 86_400_000;
/** Status edits one tick sends at most, each a second apart (slack/status.ts spaces them). */
const STATUS_EDITS_PER_TICK = 20;

export interface Runtime {
  /** One Ctx per repository, all on one store. */
  ctxs: Ctx[];
  portal: Portal | null;
  /** OTLP/HTTP endpoint, or "" for no export. */
  otlpEndpoint: string;
  version: string;
}

const storeOf = (rt: Runtime): Store => rt.ctxs[0].store;
const log = (rt: Runtime, line: string) => rt.ctxs[0].log(line);

function ctxForRepo(rt: Runtime, repo: string): Ctx {
  const ctx = rt.ctxs.find((c) => c.config.repo === repo);
  if (ctx === undefined) throw new Error(`${repo} is not in factory.yaml repos`);
  return ctx;
}

async function ctxForRun(rt: Runtime, runId: string): Promise<Ctx | null> {
  const run = await storeOf(rt).getRun(runId);
  return run === null ? null : ctxForRepo(rt, run.repo);
}

/** Handle one trigger, then refresh what the runs it touched show: their status lines and the portal. */
export async function dispatch(rt: Runtime, trigger: Trigger): Promise<void> {
  const woken = new Set<string>();
  const wake = (id: string) => woken.add(id);
  let touched: string | null = null;
  switch (trigger.kind) {
    case "intake":
      touched = await intake({ ...ctxForRepo(rt, trigger.repo), wake }, trigger);
      break;
    case "reconcile": {
      const ctx = await ctxForRun(rt, trigger.runId);
      if (ctx === null) return;
      await reconcile({ ...ctx, wake }, trigger.runId);
      touched = trigger.runId;
      break;
    }
    case "slack_intake":
      touched = await slackIntake({ ...ctxForRepo(rt, trigger.repo), wake }, trigger);
      break;
    case "answer": {
      const ctx = await ctxForRun(rt, trigger.runId);
      if (ctx === null) return;
      await answer({ ...ctx, wake }, trigger.runId, trigger.text);
      touched = trigger.runId;
      break;
    }
  }
  if (touched !== null) await afterChange(rt, touched);
  for (const id of woken) {
    if (id === touched) continue;
    const ctx = await ctxForRun(rt, id);
    if (ctx === null) continue;
    await reconcile(ctx, id);
    await afterChange(rt, id);
  }
}

async function afterChange(rt: Runtime, runId: string): Promise<void> {
  await flushStatus(rt.ctxs, runId).catch((error) => log(rt, `status line flush failed: ${(error as Error).message}`));
  await pushRun(storeOf(rt), rt.portal, runId, (line) => log(rt, line));
}

/** The hidden marker that says which factory runs an issue. */
const claimMark = (id: string, runId: string) => `${FACTORY_MARK}:claim id=${id} run=${runId} -->`;
const CLAIM = /<!-- factory:claim id=([\w-]+) run=([\w-]+) -->/;

/** The factory id of the earliest claim on an issue's comments, or null. */
export function claimOwner(comments: { id: number; body: string }[]): string | null {
  const claims = comments.filter((c) => CLAIM.test(c.body)).sort((a, b) => a.id - b.id);
  return claims.length === 0 ? null : CLAIM.exec(claims[0].body)![1];
}

/**
 * The intake label. One Foreman per factory: an issue that is already closed
 * (a replayed delivery) or that another factory has claimed gets no run.
 * Otherwise the run starts and claims the issue. If two factories claim it at
 * once, the earliest claim comment wins and the other closes its run quietly.
 * Returns the run id, or null when no run started.
 */
async function intake(ctx: Ctx, p: { issue: number; title: string }): Promise<string | null> {
  const runId = runIdFor(ctx.config.key, p.issue);
  const started = await ctx.store.withLock(runId, async () => {
    if ((await ctx.store.getRun(runId)) !== null) {
      await reconcileLocked(ctx, runId);
      return true;
    }
    const issue = await ctx.ports.github.issue(p.issue);
    if (issue.state !== "open") {
      ctx.log(`skipped intake for ${ctx.config.repo}#${p.issue}: the issue is ${issue.state}`);
      return false;
    }
    const me = await ctx.store.factoryId();
    const owner = claimOwner(await ctx.ports.github.comments(p.issue));
    if (owner !== null && owner !== me) {
      ctx.log(`skipped intake for ${ctx.config.repo}#${p.issue}: another Foreman (factory ${owner}) runs it`);
      return false;
    }
    const run = (await ctx.store.createRun({ repo: ctx.config.repo, key: ctx.config.key, issue: p.issue, title: p.title, slackChannel: null }, ctx.now()))!;
    if (owner === null) {
      await ctx.store.postOnce(run.id, "github", "claim", () =>
        ctx.ports.github.comment(p.issue, `${claimMark(me, run.id)}\n${t("runs.claim", { run: run.id, factory: me })}`),
      );
      const winner = claimOwner(await ctx.ports.github.comments(p.issue));
      if (winner !== me) {
        await ctx.store.moveTo(run, "closed", t("runs.claimed-elsewhere", { factory: winner ?? "", issue: p.issue }), null, ctx.now());
        ctx.log(`${run.id}: closed: another Foreman (factory ${winner}) claimed #${p.issue} first`);
        return true;
      }
    }
    await reconcileLocked(ctx, run.id);
    return true;
  });
  return started ? runId : null;
}

/**
 * A top-level @mention opens one issue. Foreman posts the run's status
 * message in the channel, whose thread gets every follow-up, and replies
 * once under the request with links to the issue and that status thread.
 * Returns the run id.
 */
async function slackIntake(ctx: Ctx, m: { channel: string; ts: string; text: string; user: string }): Promise<string | null> {
  const existing = await ctx.store.runByThread(m.channel, m.ts);
  if (existing !== null) {
    await reconcile(ctx, existing.id);
    return existing.id;
  }
  if (!(await ctx.store.createOnce(`slack/${m.channel}/${m.ts}`, m.text))) return null;
  const text = m.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const firstLine = text
    .split("\n")[0]
    .replace(/^please\s+/i, "")
    .replace(/^(open an issue( on \S+)?|can you|could you)[:,]?\s*/i, "")
    .replace(/^please\s+/i, "");
  const capitalized = firstLine.charAt(0).toUpperCase() + firstLine.slice(1);
  const title = capitalized.length > 80 ? `${capitalized.slice(0, 77)}...` : capitalized;
  const repeat = await repeatOf(ctx, firstLine);
  if (repeat !== null) {
    await ctx.ports.slack?.post(m.channel, repeat.reply, m.ts);
    return repeat.runId;
  }
  const issue = await ctx.ports.github.createIssue(title || t("github.request.untitled"), t("github.request.body", { request: text, footer: t("github.request.footer") }), [ctx.config.intakeLabel]);
  const runId = runIdFor(ctx.config.key, issue.number);
  await ctx.store.withLock(runId, async () => {
    let run = (await ctx.store.getRun(runId))
      ?? (await ctx.store.createRun({ repo: ctx.config.repo, key: ctx.config.key, issue: issue.number, title, slackChannel: m.channel, requestTs: m.ts, requester: m.user || null }, ctx.now()))!;
    const me = await ctx.store.factoryId();
    await ctx.store.postOnce(run.id, "github", "claim", () =>
      ctx.ports.github.comment(issue.number, `${claimMark(me, run.id)}\n${t("runs.claim", { run: run.id, factory: me })}`),
    );
    if (run.statusTs === null) run = await postStatus(ctx, run, m.channel);
    const status = threadUrl(m.channel, run.slackTs!);
    await ctx.store.postOnce(run.id, "slack", "intake", () =>
      ctx.ports.slack!.post(m.channel, t("slack.intake.opened", { url: issue.url, key: ctx.config.key, issue: issue.number, title, run: run.id, status }), m.ts),
    );
    await reconcileLocked(ctx, run.id);
  });
  return runId;
}

/** How far back a run closed as a duplicate still absorbs a repeat of its request. */
export const REPEAT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * An earlier run for the same request: an open one, one triage closed as a
 * duplicate within REPEAT_WINDOW_MS, or one abandoned within
 * ABANDONED_WINDOW_MS. The reply links its thread and, for a duplicate, the
 * issue it was folded into, or for an abandoned run, its issue and why it
 * was abandoned. Nothing is reopened.
 */
async function repeatOf(ctx: Ctx, request: string): Promise<{ runId: string; reply: string } | null> {
  const thread = (run: Run) => (run.slackChannel !== null && run.slackTs !== null ? threadUrl(run.slackChannel, run.slackTs) : "");
  const issueLink = (run: Run) => t("slack.repeat.issue", { url: `https://github.com/${run.repo}/issues/${run.issue}`, key: ctx.config.key, issue: run.issue, title: run.title });
  const open = (await ctx.store.openRuns()).find((r) => r.repo === ctx.config.repo && sameRequest(r.title, request));
  if (open !== undefined) {
    return { runId: open.id, reply: t("slack.repeat.open", { run: open.id, issue: issueLink(open), stage: open.stage, thread: thread(open) }) };
  }
  const nowMs = Date.parse(ctx.now());
  const recent = await ctx.store.recentDocs(new Date(nowMs - ABANDONED_WINDOW_MS).toISOString());
  const sinceDuplicate = new Date(nowMs - REPEAT_WINDOW_MS).toISOString();
  const closed = recent.find((d) => d.run.repo === ctx.config.repo && (d.run.closedAt ?? "") >= sinceDuplicate && duplicateOf(d) !== null && sameRequest(d.run.title, request));
  if (closed !== undefined) {
    const run = closed.run;
    const links = await Promise.all(duplicateOf(closed)!.map((url) => duplicateLink(ctx, url)));
    return {
      runId: run.id,
      reply: t("slack.repeat.duplicate", { run: run.id, links: links.join(" and "), thread: thread(run) }),
    };
  }
  const abandoned = recent.find((d) => d.run.repo === ctx.config.repo && d.run.stage === "abandoned" && sameRequest(d.run.title, request));
  if (abandoned === undefined) return null;
  const run = abandoned.run;
  return {
    runId: run.id,
    reply: t("slack.repeat.abandoned", {
      run: run.id, issue: issueLink(run), name: run.abandon?.name ?? t("slack.repeat.someone"), date: run.closedAt!.slice(0, 10),
      reason: run.abandon?.reason ?? t("slack.repeat.no-reason"), thread: thread(run),
    }),
  };
}

/**
 * A mention in one of a run's threads (its status thread or the request
 * thread). A command (approve, changes, abandon, or a reason Foreman asked
 * for) is handled here, under the run's lock, and Foreman's reply goes in
 * the same thread; a reply in the request thread also links the status
 * thread. Returns false when the message is not a command, so Foreman chats.
 */
export async function slackMention(rt: Runtime, m: { runId: string; channel: string; threadTs: string; ts: string; user: string; text: string }): Promise<boolean> {
  const ctx = await ctxForRun(rt, m.runId);
  if (ctx === null) return false;
  const result = await ctx.store.withLock(m.runId, async () => ({ reply: await slackCommand(ctx, m.runId, m) }));
  if (result === null) {
    await ctx.ports.slack?.post(m.channel, t("slack.steer.busy"), m.threadTs);
    return true;
  }
  if (result.reply === null) return false;
  const run = (await ctx.store.getRun(m.runId))!;
  const elsewhere = run.slackTs !== null && m.threadTs !== run.slackTs;
  const pointer = elsewhere ? t("slack.steer.pointer", { run: run.id, url: threadUrl(m.channel, run.slackTs!) }) : "";
  const text = [result.reply === "" && elsewhere ? t("slack.steer.done") : result.reply, pointer].filter((t) => t !== "").join(" ");
  if (text !== "") await ctx.ports.slack?.post(m.channel, text, m.threadTs);
  await afterChange(rt, m.runId);
  return true;
}

/**
 * A gate or abandon tool call that a person approved in Slack. `user` is the
 * Slack user who clicked Approve, never the model's say-so; the pipeline
 * checks them against the requester and slack.approvers like a reply.
 * Returns what to tell the person.
 */
export async function steerRun(rt: Runtime, m: { runId: string; user: string; ts: string; command: Exclude<SlackCommand, null> }): Promise<string> {
  const ctx = await ctxForRun(rt, m.runId);
  if (ctx === null) return t("slack.steer.no-run", { run: m.runId });
  const result = await ctx.store.withLock(m.runId, async () => ({ reply: await steer(ctx, m.runId, { ...m, text: "" }) }));
  if (result === null) return t("slack.steer.busy");
  await afterChange(rt, m.runId);
  return result.reply === null || result.reply === "" ? t("slack.steer.done.tool") : result.reply;
}

/** A requester's answer to the spec step's questions, relayed from a run thread to the issue once. */
async function answer(ctx: Ctx, runId: string, text: string): Promise<void> {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const run = await ctx.store.getRun(runId);
  if (run === null) return;
  if (await ctx.store.createOnce(`answer/${runId}/${digest}`, "")) {
    await ctx.ports.github.relay(run.issue, `${FACTORY_MARK}:answer -->\n${t("github.answer", { text })}`);
  }
  await reconcile(ctx, runId);
}

/** The tick. One at a time across runtimes; an overlapping tick returns at once. */
export async function tick(rt: Runtime): Promise<{ reconciled: string[] } | null> {
  const result = await storeOf(rt).withLock("tick", () => tickLocked(rt));
  if (result === null) log(rt, `tick: skipped: ${leaseRefusal}`);
  return result;
}

async function tickLocked(rt: Runtime): Promise<{ reconciled: string[] }> {
  const store = storeOf(rt);
  const ctx0 = rt.ctxs[0];
  const now = Date.parse(ctx0.now());
  const reconciled: string[] = [];
  const say = (line: string) => log(rt, line);

  for (const run of await store.openRuns()) {
    const ctx = rt.ctxs.find((c) => c.config.repo === run.repo);
    if (ctx === undefined) continue;
    try {
      // A run with a Slack status message reconciles every tick, so reactions whose event was missed still count.
      const watchesReactions = run.statusTs !== null && ctx.ports.slack !== null;
      if (run.hold === null && stepAt(ctx.config, run.stage) !== null && !watchesReactions) {
        const rr = await store.roleRunFor(run.id, run.visit);
        if (rr !== null) {
          // A failed status read falls through to reconcile, which counts it toward holding the run.
          const agent = await ctx.ports.agents.status(rr.agentId).catch(() => null);
          if (agent !== null && !TERMINAL.has(agent.status) && now <= Date.parse(rr.deadline)) continue;
        }
      }
      await reconcile(ctx, run.id);
      reconciled.push(run.id);
      await pushRun(store, rt.portal, run.id, say);
    } catch (error) {
      say(`tick: ${run.id} failed: ${(error as Error).message}`);
    }
  }

  for (const ctx of rt.ctxs) {
    const facts = await store.meta<Facts>(factsKey(ctx.config.key));
    if (ctx.facts !== null && (facts === undefined || now - Date.parse(facts.at) >= FACTS_EVERY_MS)) {
      await refreshFacts(ctx).catch((error) => say(`facts refresh for ${ctx.config.repo} failed: ${(error as Error).message}`));
    }
  }
  if (ctx0.facts?.usage) await refreshCosts(ctx0, ctx0.facts.usage).catch((error) => say(`cost read failed: ${(error as Error).message}`));

  for (let i = 0; i < STATUS_EDITS_PER_TICK; i += 1) {
    const edited = await flushStatus(rt.ctxs).catch((error) => {
      say(`status line flush failed: ${(error as Error).message}`);
      return null;
    });
    if (edited === null) break;
    await new Promise((r) => setTimeout(r, 1_050));
  }

  await heartbeat(store, rt.portal, { version: rt.version, repos: rt.ctxs.map((c) => c.config.repo), now: ctx0.now() }, say);
  if (rt.otlpEndpoint !== "") await exportMetrics(rt.ctxs, rt.otlpEndpoint).catch((error) => say(`metrics export failed: ${(error as Error).message}`));

  const swept = (await store.meta<{ at: number }>("swept"))?.at ?? 0;
  if (now - swept >= SWEEP_EVERY_MS) {
    await store.putMeta("swept", { at: now });
    await store.sweep(ONCE_KEEP_MS).catch((error) => say(`sweep failed: ${(error as Error).message}`));
  }
  return { reconciled };
}

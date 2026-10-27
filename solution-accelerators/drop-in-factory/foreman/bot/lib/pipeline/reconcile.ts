/**
 * Reconcile one run against GitHub, Slack and its step's cloud agent. An
 * event only names the run; this re-reads the authoritative state and moves
 * the run as far as it can. Posts go through postOnce and launches through
 * the one agent row per visit, so a late, duplicate or replayed event
 * converges on the same result.
 *
 * Slack follow-ups (questions, approvals, results, notices) go to the run's
 * status thread: the thread under Foreman's status message. Questions and
 * approvals mention the requester, and every ask ends with a reply hint.
 */

import type { FactoryConfig, Gate } from "../config/factory.ts";
import { DEFAULT_REACTIONS } from "../config/factory.ts";
import type { Comment, PrFeedback } from "../github/rest.ts";
import type { FactsSource } from "../metrics/facts.ts";
import type { StepDef } from "../steps/define.ts";
import { stepPrompt, type RunContext } from "../steps/prompt.ts";
import { TERMINAL } from "../steps/cloud-agent.ts";
import {
  disallowedFile, documentPath, parseResult, resultPath, specScore, walkthroughVideo,
  type SpecResult, type SummaryResult, type TriageResult, type VerdictResult,
} from "../steps/results.ts";
import { admission, branchFor, DUPLICATE_OF, ENDED, runIdFor, threadUrl, type Abandon, type Run, type SlackVote } from "../store/runs.ts";
import type { Store } from "../store/store.ts";
import { askBlocks, askText, issueHint, noticeBlocks, resultBlocks, resultText, slackHint, type AskKind } from "../slack/blocks.ts";
import type { Blocks } from "../slack/post.ts";
import { postStatus, runningAgents } from "../slack/status.ts";
import { commandOf, decide, FACTORY_MARK, slackCommandOf, votes, type SlackCommand } from "./gates.ts";
import type { Ports } from "./ports.ts";
import { postMortem } from "./postmortem.ts";
import { mdLink, plural, t } from "../templates.ts";
import {
  afterGate, afterStep, changeStepFor, changeStepName, CLARIFICATION, displayName, firstStage, gateAt, gatedStep,
  INTAKE, MERGE, recheckStage, specStep, stageLine, stepAt, stepsBefore, type Stage,
} from "./route.ts";

export interface Ctx {
  store: Store;
  config: FactoryConfig;
  ports: Ports;
  /** DORA facts and invoice cents. Tests pass null and skip the refresh. */
  facts: FactsSource | null;
  factoryDir: string;
  now(): string;
  log(line: string): void;
  /** Called with a run that should reconcile soon, such as a queued run when a slot frees. */
  wake?(runId: string): void;
}

/** A run stops being sent back to its change step after this many verdict or pull request rounds. */
export const MAX_SEND_BACKS = 3;

/** The label an abandoned run's issue gets. */
export const ABANDONED_LABEL = "abandoned";

/** Stale votes already logged, so the tick does not repeat them every minute. */
const loggedStale = new Set<string>();

/** Reconcile failures in a row before the run is held. */
export const MAX_FAILURES = 3;

/**
 * Reconcile one run under its lock. Returns false when another runtime holds
 * the lock; that runtime, or the next tick, catches up. A reconcile that
 * throws is counted on the run, and the third in a row holds it.
 */
export async function reconcile(ctx: Ctx, runId: string): Promise<boolean> {
  const ran = await ctx.store.withLock(runId, async () => {
    await reconcileLocked(ctx, runId);
    return true;
  }).catch(async (error: Error) => {
    const doc = await ctx.store.doc(runId);
    if (doc === null) throw error;
    const failures = await ctx.store.setFailures(runId, doc.failures + 1);
    ctx.log(`${runId}: reconcile failed (${failures} of ${MAX_FAILURES}): ${error.message}`);
    if (failures >= MAX_FAILURES) {
      await ctx.store.withLock(runId, () => holdRun(ctx, runId, t("runs.held.reconcile-failed", { n: MAX_FAILURES, error: error.message })));
    }
    return true;
  });
  return ran !== null;
}

/** The body of reconcile, for a caller that already holds the run's lock. */
export async function reconcileLocked(ctx: Ctx, runId: string): Promise<void> {
  let run = await ctx.store.getRun(runId);
  if (run === null || ENDED.has(run.stage)) return;
  run = await readReactions(ctx, await ensureSlackThread(ctx, run));
  for (let step = 0; step < 12; step += 1) {
    if (ENDED.has(run.stage)) break;
    const before = run.visit;
    run = await advance(ctx, run);
    if (run.visit === before) break;
  }
  await syncIssueStatus(ctx, run.id);
  if ((await ctx.store.doc(runId))!.failures > 0) await ctx.store.setFailures(runId, 0);
}

async function advance(ctx: Ctx, run: Run): Promise<Run> {
  run = await ensureSlackThread(ctx, run);
  if (run.abandon?.via === "slack" && run.abandon.reason !== null) return abandonRun(ctx, run);
  const ended = await endedOnGitHub(ctx, run);
  if (ended !== null) return ended;
  if (run.hold !== null) return retryIfAsked(ctx, run);

  const step = stepAt(ctx.config, run.stage);
  if (step !== null) return stepStage(ctx, run, step);
  const gate = gateAt(ctx.config, run.stage);
  if (gate !== null) return gateStage(ctx, run, gate);
  switch (run.stage) {
    case INTAKE:
      return startRun(ctx, run);
    case CLARIFICATION:
      return clarification(ctx, run);
    case MERGE:
      return mergeStage(ctx, run);
    default:
      return hold(ctx, run, t("runs.held.unknown-stage", { stage: run.stage }));
  }
}

// ---- moving, holding and telling people ----

async function move(ctx: Ctx, run: Run, stage: Stage, reason: string, actor: string | null = null): Promise<Run> {
  const moved = await ctx.store.moveTo({ ...run, askTs: null }, stage, reason, actor, ctx.now());
  ctx.log(`${run.id}: ${run.stage} -> ${stage} (${reason})`);
  await tellSlack(ctx, moved, `transition:${moved.visit}`, t("runs.transition", { stage, line: stageLine(ctx.config, stage), reason }));
  if (ENDED.has(stage)) await wakeQueued(ctx);
  return moved;
}

/** A run that ends frees a slot: every run waiting at intake checks again now, not at the next tick. */
async function wakeQueued(ctx: Ctx): Promise<void> {
  if (ctx.wake === undefined) return;
  for (const r of (await ctx.store.openRuns()).filter((o) => o.stage === "intake")) ctx.wake(r.id);
}

async function hold(ctx: Ctx, run: Run, reason: string): Promise<Run> {
  const held = await ctx.store.saveRun({ ...run, hold: reason, holdSince: ctx.now() });
  ctx.log(`${run.id}: held at ${run.stage}: ${reason}`);
  await tell(ctx, held, `hold:${run.visit}`, t("runs.hold.issue", { stage: run.stage, reason }), t("runs.hold.slack", { stage: run.stage, reason }));
  return held;
}

/** Hold an open run from outside reconcile, under its lock. */
export async function holdRun(ctx: Ctx, runId: string, reason: string): Promise<void> {
  const run = await ctx.store.getRun(runId);
  if (run === null || run.hold !== null || ENDED.has(run.stage)) return;
  await hold(ctx, run, reason);
}

async function tell(ctx: Ctx, run: Run, key: string, issueBody: string, slackText: string, blocks?: Blocks): Promise<void> {
  await ctx.store.postOnce(run.id, "github", key, () => ctx.ports.github.comment(run.issue, `${FACTORY_MARK}:${key} -->\n${issueBody}`));
  await tellSlack(ctx, run, key, slackText, blocks);
}

/** Post in the run's status thread once per key. Returns the message ts, or null when it was posted before or there is no Slack. */
async function tellSlack(ctx: Ctx, run: Run, key: string, text: string, blocks: Blocks = noticeBlocks(text)): Promise<string | null> {
  const slack = ctx.ports.slack;
  if (slack === null || run.slackChannel === null || run.slackTs === null) return null;
  let ts: string | null = null;
  await ctx.store.postOnce(run.id, "slack", key, async () => {
    ts = await slack.post(run.slackChannel!, text, run.slackTs, blocks);
  });
  return ts;
}

const reactionsOf = (ctx: Ctx) => ctx.config.slack?.reactions ?? DEFAULT_REACTIONS;

/** Who an ask mentions: the requester, or else the listed Slack approvers. */
function mentionFor(ctx: Ctx, run: Run): string | null {
  if (run.requester !== null && run.requester !== "") return t("slack.mention", { user: run.requester });
  const approvers = ctx.config.slack?.approvers ?? [];
  return approvers.length === 0 ? null : approvers.map((a) => t("slack.mention", { user: a })).join(" ");
}

/** Whether a Slack user may approve, ask for changes or abandon this run: the person who asked, or a listed approver. */
export function maySteer(config: FactoryConfig, run: Pick<Run, "requester">, user: string): boolean {
  return user !== "" && (user === run.requester || (config.slack?.approvers ?? []).includes(user));
}

/** Who may steer a run, for the reply to someone who may not. */
export function whoMaySteer(config: FactoryConfig, run: Pick<Run, "requester">): string {
  const people = [...(run.requester ? [t("slack.who.requester", { user: run.requester })] : []), ...(config.slack?.approvers ?? []).map((a) => t("slack.mention", { user: a }))];
  return people.length === 0 ? t("slack.who.none") : people.join(", ");
}

interface Ask {
  kind: AskKind;
  key: string;
  title: string;
  body: string;
  links?: string[];
  /** The issue comment, without its hint. */
  issueBody: string;
  gate?: { approveLabel: string; changesLabel: string };
}

/**
 * A question, approval or reason request: on the issue with its comment
 * syntax, and in the status thread mentioning the requester with the Slack
 * reply hint. Approvals and reason requests remember the Slack message, so
 * reactions on it count.
 */
async function ask(ctx: Ctx, run: Run, a: Ask): Promise<Run> {
  await ctx.store.postOnce(run.id, "github", a.key, () =>
    ctx.ports.github.comment(run.issue, `${FACTORY_MARK}:${a.key} -->\n${a.issueBody}\n\n${issueHint(a.kind, a.gate)}`));
  const view = { kind: a.kind, title: a.title, body: a.body, mention: mentionFor(ctx, run), links: a.links ?? [], hint: slackHint(a.kind, reactionsOf(ctx)) };
  const ts = await tellSlack(ctx, run, a.key, askText(view), askBlocks(view));
  if (ts !== null && a.kind !== "question") return ctx.store.saveRun({ ...run, askTs: ts });
  return run;
}

/**
 * Every run gets a status message: the bot's top-level message in the
 * channel, kept current by the worker (slack/status.ts). Its thread is the
 * status thread. A run started from Slack also has the person's request
 * thread, which Foreman answers in but does not post follow-ups to.
 */
async function ensureSlackThread(ctx: Ctx, run: Run): Promise<Run> {
  const slack = ctx.ports.slack;
  if (slack === null || ctx.config.slack === null || run.statusTs !== null) return run;
  return postStatus(ctx, run, run.slackChannel ?? ctx.config.slack.channel);
}

const issueUrl = (ctx: Ctx, run: Run) => `https://github.com/${ctx.config.repo}/issues/${run.issue}`;
const pullUrl = (ctx: Ctx, n: number) => `https://github.com/${ctx.config.repo}/pull/${n}`;
const blobUrl = (ctx: Ctx, sha: string, path: string) => `https://github.com/${ctx.config.repo}/blob/${sha}/${path}`;
const issueLink = (ctx: Ctx, run: Run) => t("slack.link.issue", { url: issueUrl(ctx, run), issue: run.issue });
const pullLink = (url: string, pr: number) => t("slack.link.pull", { url, pr });

/** Slack links for a run: its issue, pull request and running agent sessions. */
async function runLinks(ctx: Ctx, run: Run): Promise<string[]> {
  const links = [issueLink(ctx, run)];
  if (run.pr !== null) links.push(pullLink(pullUrl(ctx, run.pr), run.pr));
  for (const a of runningAgents(await ctx.store.doc(run.id))) links.push(t("slack.link.agent", { url: a.url, role: a.role }));
  return links;
}

/**
 * Foreman's one status comment on the issue, edited in place: the stage, the
 * pull request and each running Cursor agent session.
 */
async function syncIssueStatus(ctx: Ctx, runId: string): Promise<void> {
  const doc = (await ctx.store.doc(runId))!;
  const run = doc.run;
  const agents = runningAgents(doc).map((a) => mdLink(t("runs.issue-status.agent", { role: a.role }), a.url));
  const text = `${FACTORY_MARK}:status -->\n${t("runs.issue-status", {
    run: run.id, stage: run.stage, line: stageLine(ctx.config, run.stage), hold: run.hold ?? "", pr: run.pr ?? "", agents: agents.join(", "),
    thread: run.slackChannel !== null && run.slackTs !== null ? threadUrl(run.slackChannel, run.slackTs) : "",
  })}`;
  if (text === run.statusCommentText) return;
  if (run.statusComment === null) {
    const id = await ctx.ports.github.comment(run.issue, text);
    await ctx.store.saveRun({ ...run, statusComment: id, statusCommentText: text });
  } else {
    await ctx.ports.github.editComment(run.statusComment, text);
    await ctx.store.saveRun({ ...run, statusCommentText: text });
  }
}

// ---- Slack reactions ----

/**
 * Votes and abandons given as reactions. Reaction events only trigger a
 * reconcile; this reads the reactions on the open ask and on the status
 * message (`reactions.get`), so a missed event changes nothing. Code, not a
 * model, decides whether a reaction counts: only the requester's and listed
 * approvers' do. Anyone else is told, once, who can.
 */
async function readReactions(ctx: Ctx, run: Run): Promise<Run> {
  const slack = ctx.ports.slack;
  const channel = run.slackChannel;
  if (slack === null || ctx.config.slack === null || channel === null) return run;
  const { approve, reject, abandon } = reactionsOf(ctx);
  const atGate = gateAt(ctx.config, run.stage) !== null;
  const targets = [...new Set([run.statusTs, run.askTs].filter((t): t is string => t !== null))];
  for (const ts of targets) {
    for (const r of await slack.reactions(channel, ts)) {
      const counts = r.name === abandon || (atGate && ts === run.askTs && (r.name === approve || r.name === reject));
      if (!counts) continue;
      for (const user of r.users) {
        if (!maySteer(ctx.config, run, user)) {
          await tellSlack(ctx, run, `stranger:${ts}:${user}:${r.name}`, t("slack.stranger", { user, reaction: r.name, who: whoMaySteer(ctx.config, run) }));
          continue;
        }
        if (r.name === abandon) {
          if (run.abandon === null) run = await askAbandonReason(ctx, run, user, await slack.person(user));
          continue;
        }
        if (run.slackVotes.some((v) => v.ts === ts && v.user === user && v.reaction === r.name)) continue;
        const vote: SlackVote = { user, name: await slack.person(user), ts, at: ctx.now(), kind: r.name === approve ? "approve" : "changes", text: r.name === approve ? "" : t("gates.slack.reaction-changes", { reaction: r.name }), reaction: r.name };
        run = await ctx.store.saveRun({ ...run, slackVotes: [...run.slackVotes, vote] });
      }
    }
  }
  return run;
}

/** Record an abandon with no reason yet and ask for one. */
async function askAbandonReason(ctx: Ctx, run: Run, user: string, name: string): Promise<Run> {
  run = await ctx.store.saveRun({ ...run, abandon: { by: user, name, reason: null, at: ctx.now(), via: "slack", postmortem: false } });
  return ask(ctx, run, {
    kind: "reason", key: `abandon-reason:${user}`, title: t("abandon.reason.title", { run: run.id }), body: "",
    issueBody: t("abandon.reason.issue", { name }),
  });
}

// ---- Slack replies ----

/**
 * A mention in one of the run's threads that carries a command: `approve`,
 * `changes: <what>`, `abandon`/`close` with a reason, or the reason itself
 * when Foreman asked for one. Checks the person against the requester and
 * slack.approvers, records the vote or abandon, and reconciles. Returns
 * Foreman's reply for the thread, "" when the reconcile posts what there is
 * to say, or null when the message is not a command (chat with Foreman).
 * The caller holds the run's lock.
 */
export async function slackCommand(ctx: Ctx, runId: string, m: { user: string; text: string; ts: string; threadTs: string }): Promise<string | null> {
  return steer(ctx, runId, { user: m.user, ts: m.ts, command: slackCommandOf(m.text), text: m.text });
}

/**
 * A steering command from Slack, already parsed: a reply's, or a gate or
 * abandon tool call's, with the Slack user who approved the call. `text` is
 * the whole message, read as the abandon reason Foreman asked for. The
 * caller holds the run's lock.
 */
export async function steer(ctx: Ctx, runId: string, m: { user: string; ts: string; command: SlackCommand; text: string }): Promise<string | null> {
  let run = await ctx.store.getRun(runId);
  if (run === null) return null;
  const command = m.command;
  const reasonWanted = run.abandon !== null && run.abandon.reason === null;
  if (command === null && !reasonWanted) return null;
  if (command?.kind === "retry") return null;
  if (!maySteer(ctx.config, run, m.user)) {
    return t("slack.steer.not-allowed", { who: whoMaySteer(ctx.config, run) });
  }
  const name = await ctx.ports.slack!.person(m.user);

  if (reasonWanted && (command === null || command.kind === "abandon")) {
    const reason = command === null ? m.text.trim() : command.reason;
    if (reason === null) return t("slack.steer.reason-needed");
    run = await ctx.store.saveRun({ ...run, abandon: { ...run.abandon!, reason, ...(run.abandon!.via === "slack" ? { by: m.user, name } : {}) } });
    if (ENDED.has(run.stage)) {
      await writePostMortem(ctx, run);
      return "";
    }
    await reconcileLocked(ctx, run.id);
    return "";
  }
  if (command === null) return null;
  if (ENDED.has(run.stage)) return t("slack.steer.ended", { run: run.id, stage: run.stage });

  if (command.kind === "abandon") {
    if (command.reason === null) {
      await askAbandonReason(ctx, run, m.user, name);
      return "";
    }
    run = await ctx.store.saveRun({ ...run, abandon: { by: m.user, name, reason: command.reason, at: ctx.now(), via: "slack", postmortem: false } });
    await reconcileLocked(ctx, run.id);
    return "";
  }
  if (gateAt(ctx.config, run.stage) === null) return t("slack.steer.no-gate", { run: run.id, stage: run.stage });
  const vote: SlackVote = { user: m.user, name, ts: m.ts, at: ctx.now(), kind: command.kind, text: command.kind === "changes" ? command.text : "", reaction: null };
  await ctx.store.saveRun({ ...run, slackVotes: [...run.slackVotes, vote] });
  await reconcileLocked(ctx, run.id);
  return "";
}

// ---- terminal states read from GitHub ----

async function endedOnGitHub(ctx: Ctx, run: Run): Promise<Run | null> {
  if (run.pr !== null) {
    const pr = await ctx.ports.github.pull(run.pr);
    if (pr.merged) {
      await tell(ctx, run, "done", t("runs.merged.issue", { pr: pr.number }), t("runs.merged.slack", { url: pr.url, pr: pr.number }),
        resultBlocks({ ok: true, title: t("runs.merged.title", { pr: pr.number }), body: t("runs.merged.body", { by: pr.mergedBy ?? "" }), links: [pullLink(pr.url, pr.number)] }));
      // GitHub closes a linked issue only on a merge into the default branch, and `base` may be another branch.
      if ((await ctx.ports.github.issue(run.issue)).state === "open") await ctx.ports.github.closeIssue(run.issue, "completed");
      return move(ctx, run, "done", t("runs.merged.reason", { by: pr.mergedBy ?? "" }), pr.mergedBy);
    }
    if (pr.state === "closed") return closedByHand(ctx, run, t("abandon.closed.pull", { pr: pr.number }), null);
  }
  const issue = await ctx.ports.github.issue(run.issue);
  if (issue.state === "closed") return closedByHand(ctx, run, t("abandon.closed.issue", { issue: run.issue, by: issue.closedBy ?? "" }), issue.closedBy);
  return null;
}

/**
 * A run whose pull request or issue someone closed on GitHub ends there.
 * Foreman asks in the status thread why, and writes the post-mortem once it
 * hears; with no Slack it writes it at once.
 */
async function closedByHand(ctx: Ctx, run: Run, what: string, by: string | null): Promise<Run> {
  const closed = await move(ctx, run, "closed", what, by);
  const pending: Abandon = { by: by ?? "", name: by === null ? t("abandon.closed.someone") : `@${by}`, reason: null, at: ctx.now(), via: "github", postmortem: false };
  const withAbandon = await ctx.store.saveRun({ ...closed, abandon: pending });
  if (ctx.ports.slack === null || withAbandon.slackTs === null) {
    return writePostMortem(ctx, await ctx.store.saveRun({ ...withAbandon, abandon: { ...pending, reason: t("abandon.closed.no-reason", { what }) } }));
  }
  return ask(ctx, withAbandon, {
    kind: "reason", key: "closed-reason", title: t("abandon.closed.ask.title", { what }), body: t("abandon.closed.ask.body"),
    issueBody: t("abandon.closed.ask.issue", { what }),
  });
}

async function retryIfAsked(ctx: Ctx, run: Run): Promise<Run> {
  const approvers = [...new Set(Object.values(ctx.config.gates).flatMap((g) => g.approvers))];
  for (const c of await ctx.ports.github.comments(run.issue)) {
    if (Date.parse(c.createdAt) < Date.parse(run.holdSince!) || commandOf(c.body)?.kind !== "retry") continue;
    if (await ctx.ports.github.isApprover(c.login, approvers)) return move(ctx, run, run.stage, t("runs.retry", { login: c.login }), c.login);
  }
  return run;
}

// ---- abandon ----

/**
 * Abandon a run the requester or an approver stopped from Slack: the record
 * on the issue, agents stopped, pull request closed unmerged, the label, the
 * issue closed as not planned, then the post-mortem.
 */
async function abandonRun(ctx: Ctx, run: Run): Promise<Run> {
  const a = run.abandon!;
  const gh = ctx.ports.github;
  await tell(ctx, run, "abandoning", t("abandon.abandoning.issue", { run: run.id, name: a.name, reason: a.reason! }), t("abandon.abandoning.slack", { run: run.id, reason: a.reason! }));
  for (const rr of (await ctx.store.doc(run.id))!.roles.filter((r) => r.finishedAt === null)) {
    await ctx.ports.agents.stop(rr.agentId).catch((error: Error) => ctx.log(`${run.id}: could not stop ${rr.agentId}: ${error.message}`));
    await ctx.store.updateRoleRun(run.id, rr.agentId, "STOPPED", ctx.now());
  }
  const pr = run.pr === null ? await gh.pullForBranch(branchFor(run.id)) : await gh.pull(run.pr);
  if (pr !== null && pr.state === "open") await gh.closePull(pr.number);
  await gh.addLabel(run.issue, ABANDONED_LABEL);
  if ((await gh.issue(run.issue)).state === "open") await gh.closeIssue(run.issue, "not_planned");
  const moved = await move(ctx, run, "abandoned", t("abandon.abandoned", { name: a.name, reason: a.reason! }));
  return writePostMortem(ctx, moved);
}

/** The post-mortem on the issue and its summary in the status thread, once. */
async function writePostMortem(ctx: Ctx, run: Run): Promise<Run> {
  const a = run.abandon!;
  if (a.postmortem || a.reason === null) return run;
  const doc = (await ctx.store.doc(run.id))!;
  const issue = await ctx.ports.github.issue(run.issue);
  const why = t(a.via === "slack" ? "abandon.why.slack" : "abandon.why.github", { reason: a.reason, name: a.name });
  const pm = postMortem(ctx.config, doc, issue, why);
  await tell(ctx, run, "postmortem", pm.issue, pm.slack, noticeBlocks(pm.slack, [t("abandon.postmortem.link", { url: issueUrl(ctx, run), issue: run.issue })]));
  return ctx.store.saveRun({ ...doc.run, abandon: { ...a, postmortem: true } });
}

// ---- stages ----

async function startRun(ctx: Ctx, run: Run): Promise<Run> {
  const { start, ahead } = admission(await ctx.store.openRuns(), run, ctx.config.limits);
  if (!start) {
    const { runsPerRepo, runsTotal } = ctx.config.limits;
    const limits = { perRepo: runsPerRepo, total: runsTotal };
    const text = ahead === 0 ? t("runs.queued.next", limits) : plural("runs.queued.ahead", ahead, limits);
    await tell(ctx, run, "queued", text, text);
    return run;
  }
  const branch = branchFor(run.id);
  if ((await ctx.ports.github.branchSha(branch)) === null) {
    await ctx.ports.github.createBranch(branch, await ctx.ports.github.baseSha());
  }
  return move(ctx, run, firstStage(ctx.config), t("runs.started", { branch }));
}

async function stepStage(ctx: Ctx, run: Run, step: StepDef): Promise<Run> {
  const branch = branchFor(run.id);
  const name = step.id;
  const { model, deadlineMinutes } = step.settings;
  const rr = await ctx.store.roleRunFor(run.id, run.visit);
  if (rr === null) {
    const baseSha = (await ctx.ports.github.branchSha(branch))!;
    const prompt = stepPrompt(step, await contextFor(ctx, run, step, baseSha));
    const agent = await ctx.ports.agents.launch({ repo: ctx.config.repo, branch, model, prompt });
    const deadline = new Date(Date.parse(ctx.now()) + deadlineMinutes * 60_000).toISOString();
    await ctx.store.insertRoleRun({ agentId: agent.id, runId: run.id, role: name, visit: run.visit, status: agent.status, baseSha, startedAt: ctx.now(), deadline, url: agent.url });
    ctx.log(`${run.id}: launched ${name} ${agent.id}`);
    const text = t("steps.launch", { step: name, url: agent.url });
    await tellSlack(ctx, run, `launch:${run.visit}`, text, noticeBlocks(t("steps.launch.title", { step: name }), [t("steps.launch.link", { url: agent.url }), ...(await runLinks(ctx, run)).filter((l) => !l.includes(agent.url))]));
    return run;
  }

  const agent = await ctx.ports.agents.status(rr.agentId);
  if (!TERMINAL.has(agent.status)) {
    if (Date.parse(ctx.now()) <= Date.parse(rr.deadline)) return run;
    await ctx.ports.agents.stop(rr.agentId);
    await ctx.store.updateRoleRun(run.id, rr.agentId, "EXPIRED", ctx.now());
    return hold(ctx, run, t("steps.held.deadline", { step: name, minutes: deadlineMinutes, url: rr.url }));
  }
  if (rr.finishedAt === null) await ctx.store.updateRoleRun(run.id, rr.agentId, agent.status, ctx.now());
  if (agent.status !== "FINISHED") return hold(ctx, run, t("steps.held.ended", { step: name, status: agent.status, url: rr.url }));
  if (agent.branch !== branch) return hold(ctx, run, t("steps.held.branch", { step: name, branch: agent.branch, expected: branch, url: rr.url }));

  const head = (await ctx.ports.github.branchSha(branch))!;
  if (head === rr.baseSha) return hold(ctx, run, t("steps.held.nothing", { step: name, branch, url: rr.url }));
  const bad = disallowedFile(step, run.id, await ctx.ports.github.changedFiles(rr.baseSha, head));
  if (bad !== null) return hold(ctx, run, t("steps.held.disallowed", { step: name, file: bad, url: rr.url }));
  let result;
  try {
    result = parseResult(step, await ctx.ports.github.readFile(resultPath(run.id, name), head));
  } catch (error) {
    return hold(ctx, run, t("steps.held.result", { error: (error as Error).message, path: resultPath(run.id, name), url: rr.url }));
  }

  if (step.settings.kind !== "triage" && run.pr === null) run = await openPull(ctx, run);
  switch (step.settings.kind) {
    case "triage":
      return afterTriage(ctx, run, step, result as TriageResult);
    case "spec":
      return afterSpec(ctx, run, step, result as SpecResult, head);
    case "document":
      return enterNext(ctx, run, afterStep(ctx.config, name), t("steps.document.written", { path: documentPath(step, run.id) ?? "" }), head);
    case "change":
      return move(ctx, { ...run, feedback: null }, afterStep(ctx.config, name), (result as SummaryResult).summary);
    case "verdict":
      return afterVerdict(ctx, run, step, result as VerdictResult, rr.agentId);
  }
}

/** The run's draft pull request, opened after the first step that changes the branch. */
async function openPull(ctx: Ctx, run: Run): Promise<Run> {
  const branch = branchFor(run.id);
  const spec = specStep(ctx.config);
  const doc = spec === null ? "" : (documentPath(spec, run.id) ?? "");
  const pr = (await ctx.ports.github.pullForBranch(branch))
    ?? (await ctx.ports.github.openDraft(branch, t("steps.pull.title", { title: run.title, run: run.id }), t("steps.pull.body", { issue: run.issue, run: run.id, spec: doc })));
  return ctx.store.saveRun({ ...run, pr: pr.number });
}

async function afterTriage(ctx: Ctx, run: Run, step: StepDef, result: TriageResult): Promise<Run> {
  if (result.duplicates.length === 0) {
    return move(ctx, run, afterStep(ctx.config, step.id), t("steps.triage.clear", { related: result.related.length }));
  }
  const list = result.duplicates.map((d) => t("steps.triage.duplicate.item", { link: d.url, reason: d.reason })).join("\n");
  const links = await Promise.all(result.duplicates.map(async (d) => t("steps.triage.duplicate.item", { link: await duplicateLink(ctx, d.url), reason: d.reason })));
  await tell(ctx, run, "duplicate", t("steps.triage.duplicate.issue", { list }), t("steps.triage.duplicate.slack", { list: links.join("\n") }));
  const pr = await ctx.ports.github.pullForBranch(branchFor(run.id));
  if (pr !== null && pr.state === "open") await ctx.ports.github.closePull(pr.number);
  await ctx.ports.github.closeIssue(run.issue, "not_planned");
  return move(ctx, run, "closed", `${DUPLICATE_OF}${result.duplicates.map((d) => d.url).join(", ")}`);
}

/** A Slack link to an issue, followed by its run's thread when this factory has a run for that issue. */
export async function duplicateLink(ctx: Ctx, url: string): Promise<string> {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/.exec(url);
  if (m === null) return url;
  const repo = m[1];
  const issue = Number(m[2]);
  const same = repo === ctx.config.repo;
  const run = same
    ? await ctx.store.getRun(runIdFor(ctx.config.key, issue))
    : ((await ctx.store.openRuns()).find((r) => r.repo === repo && r.issue === issue) ?? null);
  const name = same ? t("steps.duplicate.name.here", { key: ctx.config.key, issue }) : t("steps.duplicate.name.other", { repo, issue });
  const thread = run !== null && run.slackChannel !== null && run.slackTs !== null ? threadUrl(run.slackChannel, run.slackTs) : "";
  return t("steps.duplicate.link", { url, name, run: run?.id ?? "", thread });
}

async function afterSpec(ctx: Ctx, run: Run, step: StepDef, result: SpecResult, head: string): Promise<Run> {
  if (step.settings.kind !== "spec") throw new Error(`${step.id} is not a spec step`);
  const score = specScore(result);
  const { threshold, maxRounds } = step.settings;
  if (score < threshold && result.questions.length > 0 && run.pmRound < maxRounds) {
    run = await ctx.store.saveRun({ ...run, pmRound: run.pmRound + 1 });
    const assumed = new Map(result.assumptions.map((a) => [a.id, a.text]));
    const list = result.questions.map((q, i) => t("steps.spec.question", { n: i + 1, text: q.text, assumption: assumed.get(q.id) ?? "" })).join("\n");
    const intro = t("steps.spec.intro", { asker: step.id === "spec" ? t("steps.spec.asker") : displayName(step.id), score, round: run.pmRound, max: maxRounds });
    run = await ask(ctx, run, {
      kind: "question", key: `questions:${run.pmRound}`, title: intro, body: list, links: [issueLink(ctx, run)],
      issueBody: t("steps.spec.issue", { intro, list }),
    });
    return move(ctx, run, CLARIFICATION, t("steps.spec.low", { score, threshold }));
  }
  return enterNext(ctx, run, afterStep(ctx.config, step.id), t("steps.spec.ok", { score }), head);
}

async function afterVerdict(ctx: Ctx, run: Run, step: StepDef, result: VerdictResult, agentId: string): Promise<Run> {
  const name = step.id;
  const video = step.settings.kind === "verdict" && step.settings.video === true;
  const findings = result.findings.map((f) => t("steps.verdict.finding", { path: f.path, line: f.line > 0 ? f.line : "", severity: f.severity, body: f.body })).join("\n");
  const pr = video ? await ctx.ports.github.pull(run.pr!) : null;
  const url = pr === null ? null : walkthroughVideo(result, pr.body);
  const body = `${FACTORY_MARK}:${name}:${run.visit} -->\n${t("steps.verdict.review", { step: name, verdict: result.verdict, summary: result.summary, findings, video: url ?? "" })}`;
  await ctx.store.postOnce(run.id, "github", `${name}:${run.visit}`, () => ctx.ports.github.review(run.pr!, body));
  if (pr !== null) await tellVerify(ctx, run, step, result.verdict, pr.url, url, agentId);
  if (result.verdict === "pass") {
    const next = afterStep(ctx.config, name);
    if (next === MERGE) run = await ctx.store.saveRun({ ...run, verifiedSha: (pr ?? await ctx.ports.github.pull(run.pr!)).headSha });
    return enterNext(ctx, run, next, t("steps.verdict.passed", { step: name }), null);
  }
  const change = changeStepFor(ctx.config, name);
  if (run.sendBacks >= MAX_SEND_BACKS) return hold(ctx, run, t("steps.held.send-backs", { step: name, max: MAX_SEND_BACKS, Change: displayName(change.id) }));
  const sent = await ctx.store.saveRun({ ...run, sendBacks: run.sendBacks + 1, feedback: t("steps.verdict.feedback", { step: name, summary: result.summary, findings }) });
  return move(ctx, sent, change.id, t("steps.verdict.changes", { step: name }));
}

/**
 * A video step's result in the status thread: pass or fail and the pull request,
 * with the walkthrough mp4 uploaded so Slack plays it inline. A pull request
 * link alone unfurls into nothing, because the PR needs a sign-in. When the
 * agent saved no mp4, it is too big, or the upload fails, the post carries
 * the video link instead, or says there is none.
 */
async function tellVerify(ctx: Ctx, run: Run, step: StepDef, verdict: VerdictResult["verdict"], prUrl: string, video: string | null, agentId: string): Promise<void> {
  const slack = ctx.ports.slack;
  if (slack === null || run.slackChannel === null || run.slackTs === null) return;
  const agent = (await ctx.store.roleRunFor(run.id, run.visit))?.url ?? null;
  const ok = verdict === "pass";
  const values = { Step: displayName(step.id), step: step.id, pr: run.pr!, agent: agent ?? "" };
  const title = ok ? t("steps.video.passed", values) : t("steps.video.failed", { ...values, Change: changeStepName(ctx.config, step.id) });
  const links = [pullLink(prUrl, run.pr!), ...(agent === null ? [] : [t("steps.video.agent", { url: agent, step: step.id })])];
  await ctx.store.postOnce(run.id, "slack", `${step.id}:${run.visit}`, async () => {
    const file = await ctx.ports.agents.video(agentId, video).catch((error: Error) => {
      ctx.log(`${run.id}: could not fetch the walkthrough video: ${error.message}`);
      return null;
    });
    if (file !== null) {
      const view = { ok, title, body: t("steps.video.below"), links };
      try {
        await slack.upload(run.slackChannel!, run.slackTs!, file, resultText(view), resultBlocks(view));
        return;
      } catch (error) {
        ctx.log(`${run.id}: walkthrough upload failed, posting the link instead: ${(error as Error).message}`);
      }
    }
    const body = video !== null ? t("steps.video.link", { url: video }) : t("steps.video.none", values);
    const view = { ok, title, body, links };
    await slack.post(run.slackChannel!, resultText(view), run.slackTs, resultBlocks(view));
  });
}

/** Move on after a step; a gate posts its ask when entered. `head` is the branch head the gate's document link points at. */
async function enterNext(ctx: Ctx, run: Run, next: Stage, reason: string, head: string | null, actor: string | null = null): Promise<Run> {
  run = await move(ctx, { ...run, feedback: null }, next, reason, actor);
  const gate = gateAt(ctx.config, next);
  if (gate !== null) return openGate(ctx, run, gate, head ?? (await ctx.ports.github.branchSha(branchFor(run.id)))!, `gate:${run.visit}`);
  return run;
}

async function openGate(ctx: Ctx, run: Run, gate: Gate, head: string, key: string): Promise<Run> {
  const step = gatedStep(ctx.config, gate.name);
  const doc = documentPath(step, run.id);
  const Gate = displayName(gate.name);
  const sha = head.slice(0, 7);
  const ready = doc === null
    ? { slack: t("gates.ready.work.slack", { Step: displayName(step.id), sha }), issue: t("gates.ready.work.issue", { Step: displayName(step.id), sha }) }
    : { slack: t("gates.ready.document.slack", { url: blobUrl(ctx, head, doc), path: doc, sha }), issue: t("gates.ready.document.issue", { doc: mdLink(doc, blobUrl(ctx, head, doc)), sha }) };
  run = await ask(ctx, run, {
    kind: "approval", key, gate,
    title: t("gates.ask.title", { Gate }),
    body: ready.slack,
    links: await runLinks(ctx, run),
    issueBody: t("gates.ask.issue", { Gate, ready: ready.issue, approvers: gate.approvers.join(", "), pr: run.pr ?? "" }),
  });
  return ctx.store.saveRun({ ...run, gateSha: head });
}

async function clarification(ctx: Ctx, run: Run): Promise<Run> {
  const spec = specStep(ctx.config);
  if (spec === null) return hold(ctx, run, t("steps.held.no-spec"));
  const answers = answerComments(await ctx.ports.github.comments(run.issue), run.stageSince);
  if (answers.length === 0) return run;
  const first = answers[0];
  const why = t(first.body.includes(`${FACTORY_MARK}:answer`) ? "steps.spec.answered.slack" : "steps.spec.answered.github", { login: first.login });
  return move(ctx, run, spec.id, why, first.login);
}

async function gateStage(ctx: Ctx, run: Run, gate: Gate): Promise<Run> {
  const name = gate.name;
  const head = (await ctx.ports.github.branchSha(branchFor(run.id)))!;
  if (run.gateSha === null) return openGate(ctx, run, gate, head, `gate:${run.visit}`);
  if (head !== run.gateSha) {
    run = await ctx.store.saveRun({ ...run, gateSha: head, stageSince: ctx.now() });
    const text = t("gates.moved", { gate: name, sha: head.slice(0, 7) });
    await tell(ctx, run, `gate-moved:${head}`, text, text);
    return openGate(ctx, run, gate, head, `gate:${run.visit}:${head}`);
  }

  const gh = ctx.ports.github;
  const comments = [...(await gh.comments(run.issue)), ...(run.pr === null ? [] : await gh.comments(run.pr))];
  const labels = [...(await gh.labelEvents(run.issue)), ...(run.pr === null ? [] : await gh.labelEvents(run.pr))];
  // A vote already refused stays refused, even if its author is added to the approvers later.
  const ignored = new Set(((await ctx.store.doc(run.id))?.posts ?? []).filter((p) => p.startsWith("github:ignored:")).map((p) => p.slice("github:ignored:".length)));
  const fresh = votes(gate, comments, labels).filter((v) => !ignored.has(v.id));
  const read = await decide(fresh, run.stageSince, (login) => gh.isApprover(login, gate.approvers));
  for (const v of read.stale) {
    const key = `${run.id}:${run.stageSince}:${v.id}`;
    if (loggedStale.has(key)) continue;
    loggedStale.add(key);
    ctx.log(`${run.id}: ignored stale ${v.kind} by ${v.by} at ${v.at} (gate opened ${run.stageSince})`);
  }
  for (const v of read.ignored) {
    const text = t("gates.ignored", { login: v.by, gate: name, kind: v.kind });
    await tell(ctx, run, `ignored:${v.id}`, text, text);
  }
  const slackVote = run.slackVotes.find((v) => Date.parse(v.at) >= Date.parse(run.stageSince)) ?? null;
  const d = read.decision;
  if (slackVote !== null && (d.kind === "none" || Date.parse(slackVote.at) < Date.parse(d.at))) return slackDecision(ctx, run, gate, slackVote);
  if (d.kind === "none") return run;
  const next = afterGate(ctx.config, name);
  if (d.kind === "approve") return enterNext(ctx, run, next.approve, t("gates.approved", { gate: name, by: d.by }), null, d.by);
  return move(ctx, { ...run, feedback: t("gates.changes.feedback", { gate: name, by: d.by, text: d.text }) }, next.changes, t("gates.changes.reason", { by: d.by }), d.by);
}

/** A gate decided in Slack: recorded on the issue with the Slack user, message and reaction, then the run moves. */
async function slackDecision(ctx: Ctx, run: Run, gate: Gate, v: SlackVote): Promise<Run> {
  const name = gate.name;
  const how = t(v.reaction === null ? "gates.slack.via-reply" : "gates.slack.via-reaction");
  const verb = t(v.kind === "approve" ? "gates.slack.verb.approve" : "gates.slack.verb.changes");
  const values = { verb, name: v.name, how, gate: name, text: v.text, user: v.user, ts: v.ts, reaction: v.reaction ?? "" };
  await tell(ctx, run, `slack-vote:${v.ts}:${v.user}:${v.reaction ?? "reply"}`, t("gates.slack.record", values), t("gates.slack.notice", values));
  const next = afterGate(ctx.config, name);
  if (v.kind === "approve") return enterNext(ctx, run, next.approve, t("gates.slack.approved", values), null);
  return move(ctx, { ...run, feedback: t("gates.slack.changes.feedback", values) }, next.changes, t("gates.slack.changes.reason", values));
}

// ---- watching the pull request until it merges ----

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

/** A finding on the pull request that sends work back: an allowlisted bot's open thread, a human's change request, or a failed check. */
export interface Finding {
  id: string;
  what: string;
}

/** New findings, oldest first. Factory reviews and anything already handled are left out. */
export function prFindings(feedback: PrFeedback, bots: string[], handled: string[], headSha: string): { findings: Finding[]; pending: string[] } {
  const isBot = (login: string) => bots.includes(login.replace(/\[bot\]$/, "").toLowerCase());
  const findings: Finding[] = [];
  for (const th of feedback.threads) {
    if (th.resolved || th.outdated || !th.bot || !isBot(th.login)) continue;
    findings.push({ id: `thread:${th.id}`, what: t("merge.finding.thread", { login: th.login, path: th.path, line: th.line ?? "", body: th.body.trim() }) });
  }
  for (const r of feedback.reviews) {
    if (r.state !== "CHANGES_REQUESTED" || r.body.includes(FACTORY_MARK) || (r.bot && !isBot(r.login))) continue;
    findings.push({ id: `review:${r.id}`, what: t("merge.finding.review", { login: r.login, body: r.body.trim() }) });
  }
  for (const c of feedback.checks) {
    if (c.status === "completed" && c.conclusion !== null && FAILED.has(c.conclusion)) findings.push({ id: `check:${c.name}@${headSha}`, what: t("merge.finding.check", { name: c.name, conclusion: c.conclusion, summary: c.summary, url: c.url }) });
  }
  const pending = feedback.checks.filter((c) => c.status !== "completed").map((c) => c.name);
  return { findings: findings.filter((f) => !handled.includes(f.id)), pending };
}

/**
 * After the last verdict passes, Foreman watches the pull request until it
 * is merged or closed. A push reruns the verdict steps after the last change
 * step, so the evidence matches the code. New findings from allowlisted bots
 * (review.bots), human change requests and failed checks go back to the
 * change step under the send-back cap;
 * past the cap Foreman asks the requester. "Ready to merge" waits for green
 * checks.
 */
async function mergeStage(ctx: Ctx, run: Run): Promise<Run> {
  const gh = ctx.ports.github;
  const pr = await gh.pull(run.pr!);
  if (run.verifiedSha === null) run = await ctx.store.saveRun({ ...run, verifiedSha: pr.headSha });
  if (pr.headSha !== run.verifiedSha) {
    return move(ctx, { ...run, verifiedSha: null, blocked: null }, recheckStage(ctx.config), t("merge.new-commit", { sha: pr.headSha.slice(0, 7), pr: pr.number }));
  }

  const change = changeStepFor(ctx.config, MERGE);
  const Change = displayName(change.id);
  const values = { pr: pr.number, Change, max: MAX_SEND_BACKS };
  const { findings, pending } = prFindings(await gh.feedback(pr.number, pr.headSha), ctx.config.review.bots, run.handled, pr.headSha);
  if (findings.length > 0) {
    const list = findings.map((f) => t("merge.finding.item", { what: f.what })).join("\n");
    if (run.sendBacks >= MAX_SEND_BACKS) {
      const key = `findings-cap:${findings.map((f) => f.id).join(",")}`;
      if (run.blocked !== "findings") run = await ctx.store.saveRun({ ...run, blocked: "findings" });
      return ask(ctx, run, {
        kind: "findings", key, title: t("merge.cap.title", values), body: list,
        links: [pullLink(pr.url, pr.number)],
        issueBody: t("merge.cap.issue", { ...values, list }),
      });
    }
    const sent = await ctx.store.saveRun({
      ...run, blocked: null, handled: [...run.handled, ...findings.map((f) => f.id)], sendBacks: run.sendBacks + 1, verifiedSha: null,
      feedback: t("merge.findings.feedback", { ...values, list }),
    });
    await tell(ctx, sent, `findings:${findings.map((f) => f.id).join(",")}`, t("merge.findings.issue", { ...values, list }), t("merge.findings.slack", { ...values, list }));
    return move(ctx, sent, change.id, plural("merge.findings.reason", findings.length, values));
  }
  if (pending.length > 0) {
    return run.blocked === "checks" ? run : ctx.store.saveRun({ ...run, blocked: "checks" });
  }

  if (pr.draft) await gh.markReady(pr);
  await tell(ctx, run, `ready:${pr.headSha}`, t("merge.ready.issue", values), t("merge.ready.slack", { ...values, url: pr.url }),
    resultBlocks({ ok: true, title: t("merge.ready.title", values), body: t("merge.ready.body"), links: [pullLink(pr.url, pr.number)] }));
  // Another run, or anyone, may have merged a change to the same files since this branch was cut.
  if (pr.mergeableState === "dirty") {
    const branch = branchFor(run.id);
    const text = t("merge.conflict", { pr: pr.number, base: ctx.config.base, branch });
    await tell(ctx, run, `conflict:${pr.headSha}`, text, text);
    if (run.blocked !== "conflict") return await ctx.store.saveRun({ ...run, blocked: "conflict" });
  } else if (run.blocked !== null && pr.mergeableState !== "unknown") {
    return await ctx.store.saveRun({ ...run, blocked: null });
  }
  return run;
}

// ---- step context ----

/** Human comments after `since` that are not gate commands, plus answers Foreman relayed from Slack. */
export function answerComments(comments: Comment[], since: string): Comment[] {
  return comments.filter((c) => {
    if (Date.parse(c.createdAt) < Date.parse(since)) return false;
    if (c.body.includes(`${FACTORY_MARK}:answer`)) return true;
    return !c.bot && !c.body.includes(FACTORY_MARK) && commandOf(c.body) === null;
  });
}

/**
 * The Run section's extra parts for a step, by its kind: triage gets recent
 * work, the spec step the triage findings and answers so far, and every
 * later step the documents earlier steps wrote on the branch.
 */
async function contextFor(ctx: Ctx, run: Run, step: StepDef, head: string): Promise<RunContext> {
  const gh = ctx.ports.github;
  const issue = await gh.issue(run.issue);
  const sections: [string, string][] = [];
  const onBranch = (path: string) => `\`${path}\` on this branch`;
  const before = stepsBefore(ctx.config, step.id);
  const docs = before.flatMap((s) => {
    const path = documentPath(s, run.id);
    return path === null ? [] : [path];
  });
  switch (step.settings.kind) {
    case "triage": {
      const work = (await gh.recentWork()).filter((w) => w.number !== run.issue);
      sections.push(["Recent issues and pull requests", work.map((w) => `- ${w.kind} #${w.number} (${w.state}${w.labels.includes(ABANDONED_LABEL) ? ", abandoned" : ""}) ${w.title} ${w.url}`).join("\n") || "(none)"]);
      const abandoned = (await ctx.store.recentDocs(new Date(Date.parse(ctx.now()) - ABANDONED_WINDOW_MS).toISOString()))
        .filter((d) => d.run.stage === "abandoned" && d.run.repo === run.repo && d.run.id !== run.id);
      if (abandoned.length > 0) {
        sections.push(["Abandoned requests (related history, not open work)", abandoned.map((d) => `- issue #${d.run.issue} ${d.run.title}: abandoned because ${d.run.abandon?.reason ?? "no reason recorded"}`).join("\n")]);
      }
      break;
    }
    case "spec": {
      const triage = before.find((s) => s.settings.kind === "triage");
      if (triage !== undefined) sections.push(["Triage findings", (await gh.readFile(resultPath(run.id, triage.id), head)) ?? "(none)"]);
      const answers = answerComments(await gh.comments(run.issue), run.createdAt);
      sections.push(["Answers so far", answers.map((a) => `- @${a.login}: ${a.body.replace(/<!--[\s\S]*?-->/g, "").trim()}`).join("\n") || "(none)"]);
      if (run.pmRound > 0) sections.push(["Questions already asked", `See ${onBranch(resultPath(run.id, step.id))}. Do not ask them again.`]);
      break;
    }
    case "verdict":
      sections.push(["What to check", `Pull request #${run.pr} (this branch against ${ctx.config.base})${docs.length === 0 ? "" : `, against ${docs.map(onBranch).join(" and ")}`}.`]);
      break;
    default:
      if (docs.length > 0) sections.push([docsHeading(ctx, before), docs.map(onBranch).join(" and ")]);
  }
  if (run.feedback !== null) sections.push(["Address this", run.feedback]);
  return { runId: run.id, repo: ctx.config.repo, branch: branchFor(run.id), issue: { number: run.issue, title: issue.title, body: issue.body, url: issue.url }, sections };
}

/** "Approved spec and plan": the documents earlier steps wrote, named by their steps, approved when a gate followed them. */
function docsHeading(ctx: Ctx, before: StepDef[]): string {
  const writers = before.filter((s) => documentPath(s, "x") !== null);
  const gated = writers.every((s) => ctx.config.steps.some((e, i) => e.step?.id === s.id && ctx.config.steps[i + 1]?.gate?.enabled === true));
  const names = writers.map((s) => s.id);
  const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${gated ? "Approved" : "Written"} ${list}`;
}

/** How far back triage and repeat requests look for abandoned runs. */
export const ABANDONED_WINDOW_MS = 30 * 86_400_000;

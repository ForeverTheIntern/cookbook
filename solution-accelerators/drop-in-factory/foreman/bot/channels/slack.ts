import { slackChannel } from "@cursor/bdk/channels/slack";
import { slackBotToken } from "../lib/config/env.ts";
import { dispatch, slackMention } from "../lib/pipeline/dispatch.ts";
import { channelPeople, mentionAllowlist } from "../lib/slack/post.ts";
import { example, pickRepo, threadContext } from "../lib/slack/request.ts";
import { factory, runtime, storeOf, type Host } from "../lib/runtime.ts";
import { t } from "../lib/templates.ts";

/**
 * Slack does three things: a top-level @mention in a factory channel opens a
 * GitHub issue in that channel's repository. In a shared channel the message
 * names the repository, or its words match one repository's description, or
 * the model picks (and asks only when it could be either). Foreman says it is
 * working on it, then posts the issue link, or the open run that already
 * covers the request, in that thread, with a link to the run's status thread:
 * the thread under Foreman's status message, where every follow-up goes.
 *
 * A mention in either thread that carries a command (`approve`, `changes:`,
 * `abandon` or `close`, or the reason Foreman asked for) goes to the
 * pipeline, which checks the person is the requester or a listed approver
 * (slack.approvers) before it counts. Anything else is chat with Foreman.
 * A reaction only triggers a reconcile, which reads the reactions itself.
 *
 * A person who posts through an app (a test harness, a workflow) gets a
 * bot_id on the message, and BDK drops such mentions before onAppMention
 * unless the author is allowlisted. So the people in the factory channel at
 * start are allowlisted by user id, plus slack.testerBot if set.
 */

const { repos } = factory();
const channels = [...new Set(repos.flatMap((r) => (r.slack === null ? [] : [r.slack.channel])))];
const testerBot = repos.find((r) => r.slack?.testerBot)?.slack?.testerBot ?? null;
const people: string[] = [];
if (slackBotToken() !== "") {
  for (const channel of channels) {
    people.push(...await channelPeople({ token: slackBotToken() }, channel).catch((error: Error) => {
      console.log(`[factory] Slack: could not list the people in ${channel}, so only mentions from the Slack app itself are answered there: ${error.message}`);
      return [];
    }));
  }
}
const botMentions = mentionAllowlist(testerBot, [...new Set(people)]);
if (channels.length > 0) {
  console.log(slackBotToken() === ""
    ? `[factory] Slack: answering people's mentions in ${channels.join(", ")}; no bot token at start (Cursor hosting binds it per task), so mentions posted through an app are not admitted`
    : `[factory] Slack: answering mentions from ${new Set(people).size} people in ${channels.join(", ")}, including ones posted through an app`);
}

export default slackChannel({
  envPrefix: "FOREMAN",
  suggestedPrompts: [{ title: t("slack.suggested.title"), message: t("slack.suggested.message") }],
  ...(botMentions === undefined ? {} : { engagement: { botMentions } }),
  onAppMention: async (ctx, message) => {
    const host = ctx.host as unknown as Host;
    const text = (message.body || message.text).replace(/<@[A-Z0-9]+>/g, "").trim();
    const topLevel = message.threadTs === "" || message.threadTs === message.ts;
    if (topLevel && channels.includes(message.channelId)) {
      await ctx.thread.post(t("slack.intake.working"));
      const pick = pickRepo(repos, message.channelId, message.body || message.text);
      if ("choices" in pick) {
        const here = pick.choices.map((r) => t("context.pick-repo.item", { key: r.key, repo: r.repo, description: r.description ?? "" }));
        return {
          auth: null,
          context: [
            t("context.pick-repo", { repos: here.join("\n") }),
            t("context.pick-repo.ask", { channel: message.channelId, ts: message.ts, example: example(pick.choices[0].key, pick.text) }),
          ],
        };
      }
      const trigger = { kind: "slack_intake" as const, repo: pick.repo.repo, channel: message.channelId, ts: message.ts, text: pick.text, user: message.author?.userId ?? "" };
      await runtime(host).then((rt) => dispatch(rt, trigger)).catch(async (error: Error) => {
        console.log(`[factory] Slack intake failed: ${error.message}`);
        await ctx.thread.post(t("slack.intake.failed", { repo: pick.repo.repo, error: error.message }));
      });
      return null;
    }
    const run = topLevel ? null : await storeOf(host).runByThread(message.channelId, message.threadTs);
    if (run === null) return { auth: null };
    const rt = await runtime(host);
    const mention = { runId: run.id, channel: message.channelId, threadTs: message.threadTs, ts: message.ts, user: message.author?.userId ?? "", text };
    if (await slackMention(rt, mention)) return null;
    return { auth: null, context: threadContext(run, message.threadTs) };
  },
  onReactionAdded: async (ctx, message) => {
    const host = ctx.host as unknown as Host;
    const run = await storeOf(host).runByThread(message.channelId, message.threadTs);
    if (run === null) return null;
    await runtime(host)
      .then((rt) => dispatch(rt, { kind: "reconcile", runId: run.id, why: `:${message.reaction?.name ?? "?"}: from ${message.author?.userId ?? "someone"}` }))
      .catch((error: Error) => console.log(`[factory] reaction reconcile failed: ${error.message}`));
    return null;
  },
});

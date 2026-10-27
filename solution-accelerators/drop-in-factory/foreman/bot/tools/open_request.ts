import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { dispatch } from "../lib/pipeline/dispatch.ts";
import { requestText } from "../lib/slack/request.ts";
import { factory, runtime, storeOf, type Host } from "../lib/runtime.ts";

export default defineTool({
  description:
    "Open a Slack request as a factory run once you know its repository: the factory creates the GitHub issue with the intake label and posts its link in the request's thread, or links the open run that already covers it. Only for a top-level request in a shared factory channel, with the channel and ts from this thread's context.",
  effect: "write",
  inputSchema: z.object({
    repo: z.string().describe("The repository key or owner/name, from the list in this thread's context."),
    channel: z.string().describe("The Slack channel id of the request, from context."),
    ts: z.string().describe("The ts of the top-level request message, from context."),
    request: z.string().min(1).describe("What the person asked for, in their words, without the repository name."),
  }),
  async execute({ repo, channel, ts, request }, ctx) {
    const host = ctx.host as unknown as Host;
    const config = factory().repos.find((r) => (r.key === repo || r.repo === repo) && r.slack?.channel === channel);
    if (config === undefined) return { opened: false, reason: `${repo} is not a repository of channel ${channel}` };
    await dispatch(await runtime(host), { kind: "slack_intake", repo: config.repo, channel, ts, text: requestText(request), user: "" });
    const run = await storeOf(host).runByThread(channel, ts);
    return run === null
      ? { opened: false, reason: "the factory posted in the thread instead; read it before replying" }
      : { opened: true, runId: run.id, issue: `https://github.com/${run.repo}/issues/${run.issue}` };
  },
});

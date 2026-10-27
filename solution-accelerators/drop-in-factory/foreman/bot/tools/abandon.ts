import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { steerRun } from "../lib/pipeline/dispatch.ts";
import { runtime, type Host } from "../lib/runtime.ts";

/**
 * Abandon a run for a person who asked in words the reply parser did not
 * read as `abandon:`. The call waits for a person to click Approve in Slack,
 * and the pipeline counts it only when that person is the requester or a
 * listed approver. Abandoning closes the pull request unmerged, closes the
 * issue as not planned and writes the post-mortem.
 */
export default defineTool({
  description:
    "Abandon a run a person asked to stop in this run's thread, with their one-line reason. Slack asks the person to confirm the call; it counts only if the person who confirms is the requester or a listed approver. The pull request is closed unmerged and the issue closed as not planned.",
  effect: "write",
  needsApproval: true,
  inputSchema: z.object({
    runId: z.string().describe("The run id from this thread's context, like f-agents-12."),
    reason: z.string().min(1).describe("Why, in one line, in the person's words."),
  }),
  async execute({ runId, reason }, ctx) {
    const user = ctx.approvedBy?.attributes?.user_id ?? "";
    if (user === "") return { recorded: false, reason: "no Slack user confirmed this call, so it does not count" };
    const reply = await steerRun(await runtime(ctx.host as unknown as Host), { runId, user, ts: ctx.toolCallId ?? `tool:${Date.now()}`, command: { kind: "abandon", reason: reason.trim() } });
    return { recorded: true, reply };
  },
});

import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { steerRun } from "../lib/pipeline/dispatch.ts";
import { runtime, type Host } from "../lib/runtime.ts";

/**
 * Approve or send back a run at a gate, for a person who asked in words the
 * reply parser did not read as `approve` or `changes:`. The call waits for a
 * person to click Approve in Slack, and the pipeline counts it only when that
 * person is the requester or a listed approver, as for a reply or reaction.
 */
export default defineTool({
  description:
    "Record a gate decision a person asked for in this run's thread: approve, or changes with what to change. Only for a run at a gate (awaiting_<gate>_approval in `runs`). Slack asks the person to confirm the call; it counts only if the person who confirms is the requester or a listed approver.",
  effect: "write",
  needsApproval: true,
  inputSchema: z.object({
    runId: z.string().describe("The run id from this thread's context, like f-agents-12."),
    decision: z.enum(["approve", "changes"]),
    changes: z.string().optional().describe("For changes: what to change, in the person's words."),
  }),
  async execute({ runId, decision, changes }, ctx) {
    const user = ctx.approvedBy?.attributes?.user_id ?? "";
    if (user === "") return { recorded: false, reason: "no Slack user confirmed this call, so it does not count" };
    if (decision === "changes" && (changes ?? "").trim() === "") return { recorded: false, reason: "changes needs what to change" };
    const command = decision === "approve" ? { kind: "approve" as const } : { kind: "changes" as const, text: changes!.trim() };
    const reply = await steerRun(await runtime(ctx.host as unknown as Host), { runId, user, ts: ctx.toolCallId ?? `tool:${Date.now()}`, command });
    return { recorded: true, reply };
  },
});

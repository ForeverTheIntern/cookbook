import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { dispatch } from "../lib/pipeline/dispatch.ts";
import { runtime, storeOf, type Host } from "../lib/runtime.ts";

export default defineTool({
  description:
    "Pass the requester's answers to the spec step's questions on to the run. The factory posts them on the run's GitHub issue and reruns the spec step. Only for a run waiting at awaiting_clarification. Pass the person's words as they wrote them.",
  effect: "write",
  inputSchema: z.object({
    runId: z.string().describe("The run id from this thread's context, like f-agents-12."),
    text: z.string().min(1).describe("The answers, word for word."),
  }),
  async execute({ runId, text }, ctx) {
    const host = ctx.host as unknown as Host;
    const run = await storeOf(host).getRun(runId);
    if (run === null) return { queued: false, reason: `no run ${runId}` };
    if (run.stage !== "awaiting_clarification") {
      return { queued: false, reason: `run ${runId} is at ${run.stage}, not waiting for answers` };
    }
    await dispatch(await runtime(host), { kind: "answer", runId, text });
    return { queued: true, reason: "posted to the issue for the spec step (once; a repeat of the same words is not posted again)" };
  },
});

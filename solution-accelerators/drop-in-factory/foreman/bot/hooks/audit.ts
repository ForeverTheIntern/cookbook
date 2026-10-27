import { defineHook } from "@cursor/bdk/hooks";

// Observe-only: one log line per Foreman chat turn. Hooks never move a run;
// the pipeline's KPI and DORA metrics are pushed by lib/metrics after each
// pipeline event and tick, which are not chat turns.
export default defineHook({
  events: {
    "turn.completed"(event, ctx) {
      const u = event.data.usage;
      const tokens = u === undefined ? "" : `: ${u.inputTokens} in, ${u.outputTokens} out, ${u.cacheReadTokens} cached`;
      console.log(`[foreman] chat turn done on ${ctx.session.channelId} (session ${ctx.session.id})${tokens}`);
    },
    "turn.failed"(event, ctx) {
      console.log(`[foreman] chat turn failed on ${ctx.session.channelId} (session ${ctx.session.id}): ${event.data.message}`);
    },
  },
});

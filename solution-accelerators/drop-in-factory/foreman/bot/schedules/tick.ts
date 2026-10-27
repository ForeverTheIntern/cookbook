import { defineSchedule } from "@grok/agent-sdk/schedules";
import { tick } from "../lib/pipeline/dispatch.ts";
import { runtime, type Host } from "../lib/runtime.ts";

/**
 * The factory's clock, every minute, locally (`agent-sdk serve`) and on Cursor
 * hosting alike. It reconciles every run waiting on GitHub or an agent,
 * refreshes facts and costs, edits status lines, and sends the portal its
 * heartbeat (lib/pipeline/dispatch.ts). An overlapping tick returns at once.
 */
export default defineSchedule({
  cron: "* * * * *",
  async run({ host, waitUntil }) {
    const work = runtime(host as unknown as Host)
      .then(tick)
      .catch((error: Error) => console.log(`[factory] tick failed: ${error.message}`));
    waitUntil(work);
    await work;
  },
});

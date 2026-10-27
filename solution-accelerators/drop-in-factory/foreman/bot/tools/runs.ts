import { defineTool } from "@grok/agent-sdk/tools";
import { z } from "zod";
import { roleLabels, runCost } from "../lib/store/runs.ts";
import { storeOf, type Host } from "../lib/runtime.ts";

const dollars = (cents: number | null) => (cents === null ? null : `$${(cents / 100).toFixed(2)}`);

export default defineTool({
  description:
    "Read factory runs from the store. With runId, one run: stage, hold reason, pull request, stage history, and its cloud agents with each one's invoice cost in cents. Each costCents is the chargedCents (cost is the same figure as dollars to the cent) the Admin API has returned so far, never an estimate: costState 'settling' means it may still grow, 'final' means it stopped changing for 30 minutes or 2 hours passed since the agent finished. A costCents of null means no usage has been read for that agent yet (the first read is about a minute after it finishes, and only when CURSOR_ADMIN_API_KEY is set). The run's cost is the sum of the figures read so far, with costState 'final' only when every agent's figure is final; say 'so far' when it is settling. Without runId, every open run in every repository. Read-only.",
  inputSchema: z.object({ runId: z.string().optional().describe("A run id like f-agents-12. Omit to list open runs.") }),
  async execute({ runId }, ctx) {
    const store = storeOf(ctx.host as unknown as Host);
    if (runId === undefined) {
      return {
        runs: (await store.openRuns()).map((r) => ({ id: r.id, repo: r.repo, title: r.title, stage: r.stage, since: r.stageSince, hold: r.hold, issue: `https://github.com/${r.repo}/issues/${r.issue}` })),
      };
    }
    const doc = await store.doc(runId);
    if (doc === null) return { error: `no run ${runId}` };
    const run = doc.run;
    const agents = [...doc.roles].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const total = runCost(agents);
    const labels = roleLabels(agents);
    return {
      id: run.id,
      repo: run.repo,
      title: run.title,
      stage: run.stage,
      since: run.stageSince,
      hold: run.hold,
      issue: `https://github.com/${run.repo}/issues/${run.issue}`,
      pullRequest: run.pr === null ? null : `https://github.com/${run.repo}/pull/${run.pr}`,
      history: doc.transitions.map((t) => ({ stage: t.stage, at: t.at, reason: t.reason })),
      agents: agents.map((r, i) => ({ role: labels[i], status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, costCents: r.costCents, cost: dollars(r.costCents), costState: r.costState, url: r.url })),
      cost: { ...total, dollars: dollars(total.cents) },
    };
  },
});

# Cost

What a run costs, with sample figures read from the Cursor Admin API for runs of the default pipeline. Your figures depend on your models, repositories and requests. The folder creates no billable cloud resources of its own: no region applies, and Foreman, the optional dashboard and the optional collector run on a host you already have, or Foreman runs on Cursor hosting. What you pay for is the Cursor cloud agents each run launches, billed to your Cursor team.

## What you pay for

| Resource | Pricing basis | Sample cost |
| --- | --- | --- |
| One small run, no questions, no send-backs (six agents: triage, PM, architecture, implement, review, verify) | Sum of `chargedCents` for each agent's usage events | $0.78 (one run: $0.11, $0.13, $0.15, $0.14, $0.13, $0.13) |
| Average over five sample runs, including PM questions, a send-back and a retried triage | Same | $1.04 per run (range $0.78 to $1.56) |
| A duplicate closed after triage | Same | $0.09 |
| Foreman's Slack chat (one model turn per question) | Cursor usage of the account behind `CURSOR_API_KEY` | A few cents per question |
| Host for Foreman, the dashboard and the collector | Your own machine or VM | $0 extra on an existing host |

`chargedCents` is what the team is billed, including the Cursor token fee, so it is higher than `tokenUsage.totalCents`. The dashboard shows the same figures per agent on each run page, and the average over every finished run in the "Invoice cost per task" tile. That tile counts closed runs too, so for the six runs above it read 88.5¢: the five merged runs and the $0.09 duplicate. How soon the figures appear is below.

## When the figures appear

Usage events for an agent usually appear on `POST /teams/filtered-usage-events`, filtered on the agent's `cloudAgentId`, within seconds of the agent finishing, but more can arrive later, so an early figure can still grow.

So the worker doesn't wait. It reads each finished agent's cost a minute after the finish, then again with a growing gap (a quarter of the agent's age, from 2 to 15 minutes), and stops reading once the figure is final:

| Label | Meaning |
| --- | --- |
| `settling` | The sum of `chargedCents` over every event the API has returned for that agent so far. It may still grow. |
| `final` | Unchanged for 30 minutes, or 2 hours have passed since the agent finished. Not read again. |
| (no figure) | The API has returned no events for that agent yet. An agent with no events at the 2-hour cap is final at $0.00. |

Each read replaces the stored figure with the full sum, and events are de-duplicated by `usageEventId` within a read, so repeated reads can't count an event twice. A run's total is the sum of its agents' figures, labeled final only when every one is final, and "so far, settling" otherwise. The "Invoice cost per task" tile uses only final figures. Nothing is estimated or projected: without the key, or before the first events, there is no figure.

## Levers

- **Models.** `model` in each step's `foreman/bot/subagents/<step>/agent.ts` sets its model. A smaller model costs less per agent and may need more send-backs.
- **Questions.** Each PM round of questions is one more spec agent. A clearer issue, or a lower `threshold` in `foreman/bot/subagents/spec/agent.ts`, means fewer rounds.
- **Send-backs.** Each Review or Verify send-back adds one Implement and one Review agent, up to three times.
- **Review.** `stages.review.enabled: false` removes one agent per run, and the second opinion with it.
- **Deadlines.** `deadlineMinutes` in each step's `agent.ts` caps how long a stuck agent can run before it is stopped.

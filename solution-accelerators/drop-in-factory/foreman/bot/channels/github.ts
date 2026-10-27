import { githubChannel } from "@grok/agent-sdk/channels/github";
import { dispatch } from "../lib/pipeline/dispatch.ts";
import { fromGitHub } from "../lib/pipeline/ingress.ts";
import { factory, runtime, storeOf, type Host } from "../lib/runtime.ts";

/**
 * GitHub deliveries arrive through Cursor (`--cursor-events`, one `--repo`
 * per repository in factory.yaml: `npm run -s repos` prints them). Each one
 * that matters to a run becomes one trigger, handled as a host task: issues,
 * comments, pull requests (closed, new commits), reviews, review comments and
 * finished checks. The tick reads the same state, so a delivery that never
 * arrives only delays a run by a minute.
 */

async function deliver(host: Host, name: string, payload: unknown) {
  const trigger = await fromGitHub(storeOf(host), factory().repos, name, payload);
  if (trigger === null) return null;
  console.log(`[factory] ${trigger.kind}${"runId" in trigger ? ` ${trigger.runId}` : ""}${"why" in trigger ? ` (${trigger.why})` : ""}${trigger.kind === "intake" ? ` ${trigger.repo}#${trigger.issue}` : ""}`);
  return { task: async () => dispatch(await runtime(host), trigger) };
}

export default githubChannel({
  botName: "foreman",
  cursorAccount: true,
  onIssue: (ctx) => deliver(ctx.host as unknown as Host, ctx.eventName, ctx.payload),
  onComment: (ctx) => deliver(ctx.host as unknown as Host, ctx.eventName, ctx.payload),
  onPullRequest: (ctx) => deliver(ctx.host as unknown as Host, ctx.eventName, ctx.payload),
  onCheckRun: (ctx) => deliver(ctx.host as unknown as Host, ctx.eventName, ctx.payload),
  onCheckSuite: (ctx) => deliver(ctx.host as unknown as Host, ctx.eventName, ctx.payload),
  onEvent: (ctx, event) => deliver(ctx.host as unknown as Host, event.eventName, event.payload),
  webhookEvents: ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment", "check_run", "check_suite"],
});

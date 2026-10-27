import { defineAgent } from "@grok/agent-sdk";
import { cloudStep } from "../../lib/steps/define.ts";

// What this step does and the model it runs on. The prompt is instructions.md
// next to this file; factory.yaml's steps: list decides when it runs.
export const step = cloudStep({
  kind: "verdict",
  model: "cursor-grok-4.5-high",
  deadlineMinutes: 30,
  runsAs: "cloud-agent",
  status: "Review is reviewing the pull request",
});

export default defineAgent({
  description: "Review: reviews the change against the spec, the plan and the repository's conventions, and passes it or sends it back.",
  model: step.model,
});

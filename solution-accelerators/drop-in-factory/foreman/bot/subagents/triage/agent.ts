import { defineAgent } from "@grok/agent-sdk";
import { cloudStep } from "../../lib/steps/define.ts";

// What this step does and the model it runs on. The prompt is instructions.md
// next to this file; factory.yaml's steps: list decides when it runs.
export const step = cloudStep({
  kind: "triage",
  model: "cursor-grok-4.5-high",
  deadlineMinutes: 20,
  runsAs: "cloud-agent",
  status: "Triage is checking for duplicates and related work",
});

export default defineAgent({
  description: "Triage: checks a new request against recent issues and pull requests for duplicates and related work.",
  model: step.model,
});

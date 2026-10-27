import { defineAgent } from "@cursor/bdk";
import { cloudStep } from "../../lib/steps/define.ts";

// What this step does and the model it runs on. The prompt is instructions.md
// next to this file; factory.yaml's steps: list decides when it runs.
export const step = cloudStep({
  kind: "document",
  document: "design/<run-id>.md",
  model: "cursor-grok-4.5-high",
  deadlineMinutes: 30,
  runsAs: "cloud-agent",
  status: "Plan is writing the dev plan",
});

export default defineAgent({
  description: "Plan: turns the approved spec into the design and implementation plan at design/<run-id>.md.",
  model: step.model,
});

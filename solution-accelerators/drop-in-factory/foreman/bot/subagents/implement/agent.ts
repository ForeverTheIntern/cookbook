import { defineAgent } from "@cursor/bdk";
import { cloudStep } from "../../lib/steps/define.ts";

// What this step does and the model it runs on. The prompt is instructions.md
// next to this file; factory.yaml's steps: list decides when it runs.
export const step = cloudStep({
  kind: "change",
  model: "cursor-grok-4.5-high",
  deadlineMinutes: 60,
  runsAs: "cloud-agent",
  status: "Implement is writing the code",
});

export default defineAgent({
  description: "Implement: turns the approved spec and plan into working code and tests on the run branch.",
  model: step.model,
});

import { defineAgent } from "@grok/agent-sdk";
import { cloudStep } from "../../lib/steps/define.ts";

// What this step does and the model it runs on. The prompt is instructions.md
// next to this file; factory.yaml's steps: list decides when it runs.
export const step = cloudStep({
  kind: "verdict",
  video: true,
  model: "cursor-grok-4.5-high",
  deadlineMinutes: 30,
  runsAs: "cloud-agent",
  status: "Verify is checking tests and acceptance",
  skills: ["walkthrough-video"],
});

export default defineAgent({
  description: "Verify: runs the tests, checks each acceptance criterion, records a walkthrough video, and passes the change or sends it back.",
  model: step.model,
});

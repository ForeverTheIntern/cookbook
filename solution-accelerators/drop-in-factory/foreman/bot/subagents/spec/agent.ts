import { defineAgent } from "@grok/agent-sdk";
import { cloudStep } from "../../lib/steps/define.ts";

// What this step does and the model it runs on. The prompt is instructions.md
// next to this file; factory.yaml's steps: list decides when it runs.
export const step = cloudStep({
  kind: "spec",
  document: "specs/<run-id>.md",
  // The PM's grades give a score from 0 to 100. At or above threshold the spec
  // goes to the next step or gate; below it, the PM asks its questions, for at
  // most maxRounds rounds.
  threshold: 70,
  maxRounds: 2,
  model: "cursor-grok-4.5-high",
  deadlineMinutes: 20,
  runsAs: "cloud-agent",
  status: "PM is writing the spec",
});

export default defineAgent({
  description: "Spec (the PM): grades the request, asks the requester what is missing, and writes the spec at specs/<run-id>.md.",
  model: step.model,
});

/**
 * The settings a step declares next to its prompt, in
 * `foreman/bot/subagents/<step>/agent.ts`:
 *
 *   export default defineAgent({ description, model });   // what BDK sees
 *   export const step = cloudStep({ kind, model, ... });  // how Foreman runs it
 *
 * `kind` says what the step's result means to the pipeline. The order of the
 * steps and the gates between them are the `steps:` list in factory.yaml.
 */

export type StepKind = "triage" | "spec" | "document" | "change" | "verdict";
export const STEP_KINDS: StepKind[] = ["triage", "spec", "document", "change", "verdict"];

interface Common {
  /** A Cloud Agents model id (GET https://api.cursor.com/v0/models). */
  model: string;
  /** A step still running after this long is stopped and the run is held. */
  deadlineMinutes: number;
  /** How Foreman runs the step. Each step is a Cursor cloud agent on the run branch. */
  runsAs: "cloud-agent";
  /** The Slack status line while the step runs. */
  status: string;
  /** Skills from foreman/bot/skills/ appended to the prompt, by folder name. */
  skills?: string[];
}

export type StepSettings =
  /** Finds duplicates and related work. A duplicate closes the run. */
  | (Common & { kind: "triage" })
  /** Writes the spec, asks the requester questions until it is clear enough, and opens the draft pull request. */
  | (Common & { kind: "spec"; document: string; threshold: number; maxRounds: number })
  /** Writes one document on the run branch, such as the plan. */
  | (Common & { kind: "document"; document: string })
  /** Changes the code. Verdicts and pull request findings send work back here. */
  | (Common & { kind: "change" })
  /** Passes the change or sends it back to the change step. With video, records a walkthrough that Foreman uploads to Slack. */
  | (Common & { kind: "verdict"; video?: boolean });

/** Typed identity for a step's settings, so agent.ts gets completion and checks. */
export function cloudStep<T extends StepSettings>(settings: T): T {
  return settings;
}

/** One step folder, loaded. */
export interface StepDef {
  /** The folder name: the stage name, result file name and steps: entry. */
  id: string;
  /** From the folder's defineAgent. */
  description: string;
  settings: StepSettings;
  /** The folder's instructions.md. */
  instructionsPath: string;
}

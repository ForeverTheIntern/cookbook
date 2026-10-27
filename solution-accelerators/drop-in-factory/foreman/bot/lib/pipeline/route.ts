/**
 * The route a run takes, read from factory.yaml's steps: list. This is the
 * only code that knows the order: a step's stage is its folder name, a gate's
 * is awaiting_<gate>_approval, and the fixed stages are below.
 *
 *   intake -> each step and enabled gate in steps: order -> awaiting_merge -> done
 *
 * A gate's "changes" goes back to the step right before it. A verdict step's
 * "changes", and findings on the pull request, go back to the last change
 * step before it. The spec step's questions wait at awaiting_clarification.
 */

import type { Entry, FactoryConfig, Gate } from "../config/factory.ts";
import type { StepDef } from "../steps/define.ts";
import { t } from "../templates.ts";

export type Stage = string;

export const INTAKE = "intake";
export const CLARIFICATION = "awaiting_clarification";
export const MERGE = "awaiting_merge";
export const ENDED_STAGES = ["done", "closed", "abandoned"] as const;

export const gateStage = (gate: string) => `awaiting_${gate}_approval`;

type Route = Pick<FactoryConfig, "steps">;

const stepIndex = (config: Route, id: string) => config.steps.findIndex((e) => e.step?.id === id);

/** The step a stage runs, or null when the stage is not a step. */
export function stepAt(config: Route, stage: Stage): StepDef | null {
  return config.steps.find((e) => e.step?.id === stage)?.step ?? null;
}

/** The gate a stage waits on, or null. */
export function gateAt(config: Route, stage: Stage): Gate | null {
  return config.steps.find((e) => e.gate !== undefined && gateStage(e.gate.name) === stage)?.gate ?? null;
}

/** The stage of the first entry after `index` that runs: a step, or an enabled gate. */
function from(config: Route, index: number): Stage {
  for (const e of config.steps.slice(index + 1)) {
    if (e.step !== undefined) return e.step.id;
    if (e.gate.enabled) return gateStage(e.gate.name);
  }
  return MERGE;
}

/** The first stage after intake. */
export const firstStage = (config: Route): Stage => from(config, -1);

/** Where a step's success leads: the next step, or the gate after it. */
export const afterStep = (config: Route, id: string): Stage => from(config, stepIndex(config, id));

/** Where a gate's approve and changes lead. */
export function afterGate(config: Route, gate: string): { approve: Stage; changes: Stage } {
  const i = config.steps.findIndex((e) => e.gate?.name === gate);
  return { approve: from(config, i), changes: config.steps[i - 1].step!.id };
}

/** The step a gate approves: the one right before it. */
export function gatedStep(config: Route, gate: string): StepDef {
  return config.steps[config.steps.findIndex((e) => e.gate?.name === gate) - 1].step!;
}

/** The change step a verdict (or the merge stage) sends work back to: the last change step before `stage`. */
export function changeStepFor(config: Route, stage: Stage): StepDef {
  const end = stage === MERGE ? config.steps.length : stepIndex(config, stage);
  return config.steps.slice(0, end).filter((e) => e.step?.settings.kind === "change").at(-1)!.step!;
}

/** Where a new commit after the last verdict reruns the checks: the first verdict step after the last change step. */
export function recheckStage(config: Route): Stage {
  const change = changeStepFor(config, MERGE);
  const after = config.steps.slice(stepIndex(config, change.id) + 1).find((e) => e.step?.settings.kind === "verdict");
  return after?.step!.id ?? MERGE;
}

/** The spec step, when steps: has one. */
export const specStep = (config: Route): StepDef | null => config.steps.find((e) => e.step?.settings.kind === "spec")?.step ?? null;

/** The steps before `id`, in order. */
export const stepsBefore = (config: Route, id: string): StepDef[] =>
  config.steps.slice(0, Math.max(0, stepIndex(config, id))).flatMap((e: Entry) => (e.step === undefined ? [] : [e.step]));

/** Every stage a run of this config can be at, in route order. */
export function allStages(config: Route): Stage[] {
  const middle = config.steps.flatMap((e) => (e.step !== undefined ? [e.step.id, ...(e.step.settings.kind === "spec" ? [CLARIFICATION] : [])] : [gateStage(e.gate.name)]));
  return [INTAKE, ...middle, MERGE, ...ENDED_STAGES];
}

/** Stages whose move into a change step is a send-back: verdict steps and the merge stage. */
export function sendsBack(config: Route): Set<Stage> {
  return new Set([...config.steps.flatMap((e) => (e.step?.settings.kind === "verdict" ? [e.step.id] : [])), MERGE]);
}

/** A step's or gate's display name: its id with a capital, like Implement or Spec. */
export const displayName = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** The step a send-back goes to, by its display name, for "sent back to Implement". */
export const changeStepName = (config: Route, stage: Stage = MERGE) => displayName(changeStepFor(config, stage).id);

/** Who asks the spec step's questions: "PM" for a step named spec, else the step's own name. */
export const specAsker = (config: Route): string => {
  const spec = specStep(config);
  return spec === null || spec.id === "spec" ? t("steps.spec.asker") : displayName(spec.id);
};

const FIXED = new Set<string>([INTAKE, CLARIFICATION, MERGE, ...ENDED_STAGES]);

/** The short status line for a stage: a step's own status, a gate's, or a fixed stage's. */
export function stageLine(config: Route, stage: Stage): string {
  const step = stepAt(config, stage);
  if (step !== null) return step.settings.status;
  const gate = gateAt(config, stage);
  if (gate !== null) return t("stages.gate", { Gate: displayName(gate.name) });
  if (!FIXED.has(stage)) return t("stages.unknown", { stage });
  return t(`stages.${stage}`, { asker: specAsker(config) });
}

/** Stage names earlier versions stored, read as today's step names. */
export const LEGACY_STAGES: Record<string, string> = { pm: "spec", architecture: "plan" };

/**
 * What each step leaves in `.factory/<run>/<step>.json`, and which files it
 * may change on the run branch, by the step's kind. A result that fails these
 * checks holds the run.
 */

import type { StepDef, StepKind } from "./define.ts";

export interface TriageResult {
  duplicates: { url: string; reason: string }[];
  related: { url: string; reason: string }[];
  summary: string;
}

export interface SpecResult {
  grades: { id: string; weight: number; grade: 0 | 1 | 2; evidence: string }[];
  questions: { id: string; text: string }[];
  assumptions: { id: string; text: string }[];
}

export interface Finding {
  path: string;
  line: number;
  severity: "blocker" | "major" | "minor" | "note";
  body: string;
}

export interface VerdictResult {
  verdict: "pass" | "changes";
  summary: string;
  findings: Finding[];
  /** A step with video: the public URL of the walkthrough video it embedded in the pull request. */
  video?: string | null;
}

export interface SummaryResult {
  summary: string;
}

export interface ResultOf {
  triage: TriageResult;
  spec: SpecResult;
  document: SummaryResult;
  change: SummaryResult;
  verdict: VerdictResult;
}

export type StepResult = ResultOf[StepKind];

export const resultPath = (runId: string, stepId: string) => `.factory/${runId}/${stepId}.json`;

/** The document a spec or document step writes, with <run-id> filled; null for other kinds. */
export function documentPath(step: StepDef, runId: string): string | null {
  const s = step.settings;
  return s.kind === "spec" || s.kind === "document" ? s.document.replaceAll("<run-id>", runId) : null;
}

/** A changed file the step is not allowed to touch, or null when all are allowed. */
export function disallowedFile(step: StepDef, runId: string, files: string[]): string | null {
  const own = resultPath(runId, step.id);
  const doc = documentPath(step, runId);
  for (const file of files) {
    if (file === own || file === doc) continue;
    if (step.settings.kind === "change" && !file.startsWith(".factory/")) continue;
    return file;
  }
  return null;
}

/** Parse and check a step's result. Throws with a sentence a person can act on. */
export function parseResult(step: StepDef, text: string | null): StepResult {
  const name = step.id;
  if (text === null) throw new Error(`${name} did not write its result file`);
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${name} wrote a result file that is not valid JSON`);
  }
  const fail = (what: string): never => {
    throw new Error(`${name} result ${what}`);
  };
  if (typeof value !== "object" || value === null) fail("is not an object");
  switch (step.settings.kind) {
    case "triage":
      if (!Array.isArray(value.duplicates) || !Array.isArray(value.related)) fail("needs duplicates and related lists");
      if (typeof value.summary !== "string") fail("needs a summary");
      return value as TriageResult;
    case "spec":
      if (!Array.isArray(value.grades) || value.grades.length === 0) fail("needs grades");
      for (const g of value.grades) {
        if (![0, 1, 2].includes(g.grade) || typeof g.weight !== "number" || g.weight <= 0) fail(`has a bad grade row for ${g.id}`);
      }
      if (!Array.isArray(value.questions) || !Array.isArray(value.assumptions)) fail("needs questions and assumptions lists");
      return value as SpecResult;
    case "verdict":
      if (value.verdict !== "pass" && value.verdict !== "changes") fail("verdict must be pass or changes");
      if (!Array.isArray(value.findings)) fail("needs a findings list");
      if (value.verdict === "changes" && value.findings.length === 0) fail("says changes but lists no findings");
      if (typeof value.summary !== "string") fail("needs a summary");
      if (!isHttpsUrl(value.video)) value.video = null;
      return value as VerdictResult;
    case "document":
    case "change":
      if (typeof value.summary !== "string") fail("needs a summary");
      return value as SummaryResult;
  }
}

/** Score 0-100: sum(weight * grade) / sum(weight * 2). */
export function specScore(result: SpecResult): number {
  const got = result.grades.reduce((sum, g) => sum + g.weight * g.grade, 0);
  const max = result.grades.reduce((sum, g) => sum + g.weight * 2, 0);
  return Math.round((100 * got) / max);
}

const isHttpsUrl = (value: unknown): value is string => typeof value === "string" && /^https:\/\/\S+$/.test(value);

/**
 * A video step's walkthrough: the URL it wrote in its result, or else the
 * first video embedded in the pull request description, where a cloud
 * agent's pull-request tool leaves an uploaded `<video src>`.
 */
export function walkthroughVideo(result: VerdictResult, prBody: string): string | null {
  if (isHttpsUrl(result.video)) return result.video;
  const tag = /<video\b[^>]*\bsrc=["'](https:\/\/[^"']+)["']/i.exec(prBody);
  if (tag !== null) return tag[1];
  const link = /\((https:\/\/[^)\s]+\.(?:mp4|webm|mov)(?:\?[^)\s]*)?)\)/i.exec(prBody);
  return link === null ? null : link[1];
}

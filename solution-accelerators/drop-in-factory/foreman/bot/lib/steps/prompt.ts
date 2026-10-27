/**
 * A step's prompt: its instructions.md, then subagents/common.md, then each
 * skill it lists (skills/<name>/SKILL.md, without its frontmatter), then a
 * "Run" section the worker builds from the store and GitHub.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StepDef } from "./define.ts";
import { resultPath } from "./results.ts";

export interface RunContext {
  runId: string;
  repo: string;
  branch: string;
  issue: { number: number; title: string; body: string; url: string };
  /** Extra headed sections for this step, in order: heading, then markdown. */
  sections: [string, string][];
}

export function stepPrompt(step: StepDef, run: RunContext): string {
  const subagents = dirname(dirname(step.instructionsPath));
  const fill = (text: string) => text.replaceAll("<run-id>", run.runId).replaceAll("<step>", step.id).trim();
  const own = fill(readFileSync(step.instructionsPath, "utf8"));
  const common = fill(readFileSync(join(subagents, "common.md"), "utf8"));
  const skills = (step.settings.skills ?? []).map((name) => fill(skillBody(join(dirname(subagents), "skills", name, "SKILL.md"), name)));
  const lines = [
    own,
    "",
    common,
    ...skills.flatMap((s) => ["", s]),
    "",
    "## Run",
    "",
    `- Run id: ${run.runId}`,
    `- Repository: ${run.repo}`,
    `- Branch: ${run.branch}`,
    `- Result file: ${resultPath(run.runId, step.id)}`,
    `- Issue: #${run.issue.number} ${run.issue.url}`,
    "",
    `### Request: ${run.issue.title}`,
    "",
    run.issue.body.trim() === "" ? "(no description)" : run.issue.body.trim(),
  ];
  for (const [heading, body] of run.sections) lines.push("", `### ${heading}`, "", body.trim());
  return `${lines.join("\n")}\n`;
}

/** A SKILL.md without its YAML frontmatter, as a "## Skill" section. */
function skillBody(path: string, name: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`the skill ${name} has no foreman/bot/skills/${name}/SKILL.md`);
  }
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  return body.replace(/^# (.+)$/m, "## Skill: $1");
}

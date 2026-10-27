/**
 * Every step folder under foreman/bot/subagents/, loaded once. A folder is a
 * step when it has agent.ts and instructions.md; factory.yaml's steps: list
 * picks which run and in what order. Adding a step is a new folder plus a
 * line in steps:, with no code change.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError } from "../config/factory.ts";
import { STEP_KINDS, type StepDef, type StepSettings } from "./define.ts";

export const SUBAGENTS_DIR = fileURLToPath(new URL("../../subagents/", import.meta.url));

export type StepCatalog = ReadonlyMap<string, StepDef>;

export async function loadCatalog(dir: string = SUBAGENTS_DIR): Promise<StepCatalog> {
  const catalog = new Map<string, StepDef>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const where = `foreman/bot/subagents/${entry.name}`;
    const agentPath = join(dir, entry.name, "agent.ts");
    const instructionsPath = join(dir, entry.name, "instructions.md");
    if (!existsSync(agentPath)) throw new ConfigError(`${where} has no agent.ts. Each step folder holds agent.ts and instructions.md.`);
    if (!existsSync(instructionsPath)) throw new ConfigError(`${where} has no instructions.md. Each step folder holds agent.ts and instructions.md.`);
    if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) throw new ConfigError(`${where}: a step folder's name must be lowercase letters, digits and dashes.`);
    const mod = (await import(pathToFileURL(agentPath).href)) as { default?: { description?: unknown }; step?: unknown };
    const description = mod.default?.description;
    if (typeof description !== "string" || description.trim() === "") throw new ConfigError(`${where}/agent.ts: export default defineAgent({ description: "..." }).`);
    const settings = checkSettings(mod.step, `${where}/agent.ts`);
    for (const skill of settings.skills ?? []) {
      if (!existsSync(join(dir, "..", "skills", skill, "SKILL.md"))) throw new ConfigError(`${where}/agent.ts lists the skill ${skill}, but foreman/bot/skills/${skill}/SKILL.md does not exist.`);
    }
    catalog.set(entry.name, { id: entry.name, description, settings, instructionsPath });
  }
  return catalog;
}

function checkSettings(value: unknown, where: string): StepSettings {
  if (typeof value !== "object" || value === null) throw new ConfigError(`${where}: export const step = cloudStep({ kind, model, deadlineMinutes, runsAs, status }).`);
  const s = value as Record<string, unknown>;
  const fail = (what: string): never => {
    throw new ConfigError(`${where}: step.${what}`);
  };
  if (!STEP_KINDS.includes(s.kind as never)) fail(`kind must be ${STEP_KINDS.join(", ")}. It is ${String(s.kind)}.`);
  if (typeof s.model !== "string" || s.model.trim() === "") fail("model must be a Cloud Agents model id.");
  if (!isCount(s.deadlineMinutes)) fail("deadlineMinutes must be a whole number of at least 1.");
  if (s.runsAs !== "cloud-agent") fail(`runsAs must be "cloud-agent".`);
  if (typeof s.status !== "string" || s.status.trim() === "") fail("status must be a non-empty line.");
  if (s.skills !== undefined && (!Array.isArray(s.skills) || s.skills.some((k) => typeof k !== "string"))) fail("skills must be a list of folder names under foreman/bot/skills/.");
  if (s.kind === "spec" || s.kind === "document") {
    if (typeof s.document !== "string" || !s.document.includes("<run-id>")) fail("document must be a path on the run branch containing <run-id>, like specs/<run-id>.md.");
  }
  if (s.kind === "spec") {
    if (typeof s.threshold !== "number" || s.threshold < 0 || s.threshold > 100) fail("threshold must be a score from 0 to 100.");
    if (!isCount(s.maxRounds)) fail("maxRounds must be a whole number of at least 1.");
  }
  if (s.kind === "verdict" && s.video !== undefined && typeof s.video !== "boolean") fail("video must be true or false.");
  return value as StepSettings;
}

const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1;

/** The shipped steps. Loaded at import, so factory.yaml can be checked synchronously. */
export const CATALOG: StepCatalog = await loadCatalog();

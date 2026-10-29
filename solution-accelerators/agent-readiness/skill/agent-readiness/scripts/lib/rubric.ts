import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ActivityId, CondId, Effort, Level, Strength } from "./types.ts";
import { SKILL_ROOT, readJson, readText, sha256 } from "./util.ts";

export interface RubricCheck {
  id: string;
  title: string;
  scope: "repo" | "component";
  informational?: boolean;
  minStrengthForPass?: Strength;
  why: string;
  sources: { claim: string; caveat: string; url: string }[];
}

export interface RubricTemplate {
  title: string;
  kind?: "fix" | "decision" | "rollout";
  effort: Effort;
  size: string;
  ownerRole: string;
  decision?: string;
  why: string;
  doneWhen: string;
  steps: { title: string; detail: string }[];
  researchCheck?: string;
}

export interface Rubric {
  version: string;
  scale: { level: Level; name: string; plain: string; meaning: string; measuredBy: "audit" | "outcomes" }[];
  strengths: Strength[];
  strengthLabels: Record<Strength, string>;
  checks: RubricCheck[];
  conditions: Record<CondId, { check: string; scope: "repo" | "component"; label: string }>;
  level1: CondId[];
  activities: { id: ActivityId; label: string; scope: "repo" | "component"; level2: CondId[] }[];
  level3: { minAgentPRs: number; absoluteMinAgentPRs: number; windowDays: number };
  level4: { consecutiveWindows: number; volumeMultiplier: number };
  components: { maxAssessed: number; historyDays: number; botAuthorPatterns: string[]; generatedPatterns: string[]; lockfiles: string[] };
  repoLevel: { activeShare: number; hysteresisAudits: number; partialCoverageShare: number };
  mutation: { perComponent: number; minForPass: number; languages: string[]; operators: string[]; runTimeoutSec: number; flakeRuns: number; targeting: string };
  budgets: { commandTimeoutSec: number; componentMinutes: number; totalMinutes: number };
  outcomes: {
    windowDays: number;
    minRateN: number;
    defaultFilter: { branchPrefixes: string[]; labels: string[]; authors: string[]; coAuthorTrailers: string[] };
    metrics: string[];
    activityLabels: Record<string, string[]>;
  };
  part1: { maxHeadlineWords: number; maxGaps: number; maxGapWords: number; bannedTerms: string[]; levelNames: string[] };
  effortX: Record<Effort, number>;
  matrixQuadrants: string[];
  templates: Record<string, RubricTemplate>;
  notAssessed: string[];
}

export function rubricDir(): string {
  return join(SKILL_ROOT, "rubric");
}

export function latestRubricVersion(): string {
  const versions = readdirSync(rubricDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  if (versions.length === 0) throw new Error("No rubric files found");
  return versions[versions.length - 1];
}

const cache = new Map<string, Rubric>();

export function loadRubric(version?: string): Rubric {
  const v = version ?? latestRubricVersion();
  const hit = cache.get(v);
  if (hit) return hit;
  const rubric = readJson<Rubric>(join(rubricDir(), `${v}.json`));
  cache.set(v, rubric);
  return rubric;
}

export function rubricDigest(version: string): string {
  return sha256(readText(join(rubricDir(), `${version}.json`)));
}

export function strengthRank(rubric: Rubric, s: Strength): number {
  return rubric.strengths.indexOf(s);
}

export function activity(rubric: Rubric, id: ActivityId) {
  const a = rubric.activities.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown activity ${id}`);
  return a;
}

export function check(rubric: Rubric, id: string): RubricCheck {
  const c = rubric.checks.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown check ${id}`);
  return c;
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaleLine } from "../../skill/agent-readiness/scripts/lib/render.ts";
import { loadRubric } from "../../skill/agent-readiness/scripts/lib/rubric.ts";
import type { ReportJson } from "../../skill/agent-readiness/scripts/lib/types.ts";
import { askModel } from "./sdk.ts";

export type JudgeKind = "headline" | "page";

export interface JudgeResult {
  score: number | null;
  reasons: string[];
}

const REPLY = 'Reply with only JSON: {"score": <0 to 1>, "reasons": ["..."]}.';

export function headlinePrompt(r: ReportJson): string {
  const rubric = loadRubric(r.audit.rubric);
  const comps = r.components.included;
  const ready = comps.filter((c) => (c.level ?? 0) >= 2).map((c) => c.id);
  return [
    `You grade the headline of a repository readiness report. ${REPLY}`,
    "The reader is an engineering director: tests, builds, CI, pull requests, lockfiles, containers and package names are plain words to them.",
    `Rules: one message in at most ${rubric.part1.maxHeadlineWords} words; it names the component that sets the level, and says what already works (elsewhere in the repo when another component is ready); no jargon, meaning this audit's internal terms (${rubric.part1.bannedTerms.join(", ")}), check or evidence IDs, or a level name without its plain meaning; it never pairs a level change with an outcome change in the same sentence.`,
    "",
    `Heading: ${r.executive.heading}`,
    `Facts: component levels: ${comps.map((c) => `${c.id} ${c.level === null ? "not assessed" : `Level ${c.level}`}`).join(", ") || "none assessed"}. The lowest active component sets the repo level: ${r.maturity.setBy.join(", ") || "none"}. Ready for agents (Level 2 or above): ${ready.join(", ") || "none"}.`,
    `Headline: ${r.executive.headline}`,
  ].join("\n");
}

export function pagePrompt(r: ReportJson): string {
  const ex = r.executive;
  return [
    `You grade the first page of a repository readiness report against executive-slide rules. ${REPLY}`,
    "Rules: one clear message; names the component that sets the level and what already works elsewhere; plain words with no jargon; every number has a comparison; at most three gaps, each about what holds a component's level; one concrete ask, which is a single decision plus naming an owner when none is recorded; nothing a busy director would have to reread.",
    "",
    `Heading: ${ex.heading}`,
    `Headline: ${ex.headline}`,
    ...ex.numbers.map((n) => `Number: ${n.label}: ${n.value}. ${n.comparison}.`),
    `Scale: ${scaleLine(r)}`,
    `Next level: ${ex.nextLine}`,
    ...ex.gaps.map((g) => `Gap ${g.rank}: ${g.text}. ${g.blocks}.`),
    `Ask: ${ex.ask}`,
    `Coverage: ${ex.coverage}`,
  ].join("\n");
}

export const PROMPTS: Record<JudgeKind, (r: ReportJson) => string> = { headline: headlinePrompt, page: pagePrompt };

export async function judge(kind: JudgeKind, r: ReportJson | null, model: string, apiKey: string | undefined): Promise<JudgeResult> {
  if (!r || !apiKey) return { score: null, reasons: [apiKey ? "no report" : "no CURSOR_API_KEY, judge skipped"] };
  const text = await askModel(PROMPTS[kind](r), model, apiKey, mkdtempSync(join(tmpdir(), "judge-")));
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { score: null, reasons: ["judge reply wasn't JSON"] };
  try {
    const parsed = JSON.parse(m[0]) as { score: number; reasons?: string[] };
    return { score: Math.max(0, Math.min(1, Number(parsed.score))), reasons: parsed.reasons ?? [] };
  } catch {
    return { score: null, reasons: ["judge reply wasn't JSON"] };
  }
}

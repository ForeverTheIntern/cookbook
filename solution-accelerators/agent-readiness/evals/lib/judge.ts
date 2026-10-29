import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportJson } from "../../skill/agent-readiness/scripts/lib/types.ts";
import { askModel } from "./sdk.ts";

export function judgePrompt(r: ReportJson): string {
  const ex = r.executive;
  return [
    "You grade the first page of a repository readiness report against executive-slide rules. Reply with only JSON: {\"score\": <0 to 1>, \"reasons\": [\"...\"]}.",
    "Rules: one clear message; names the component that sets the level and what already works elsewhere; plain words with no jargon; every number has a comparison; at most three gaps, all about the activity judged; one concrete ask; nothing a busy director would have to reread.",
    "",
    `Heading: ${ex.heading}`,
    `Headline: ${ex.headline}`,
    ...ex.numbers.map((n) => `Number: ${n.label}: ${n.value}. ${n.comparison}.`),
    `Next level: ${ex.nextLine}`,
    ...ex.gaps.map((g) => `Gap ${g.rank}: ${g.text}. ${g.blocks}.`),
    `Ask: ${ex.ask}`,
    `Coverage: ${ex.coverage}`,
  ].join("\n");
}

export async function judge(r: ReportJson | null, model: string, apiKey: string | undefined): Promise<{ score: number | null; reasons: string[] }> {
  if (!r || !apiKey) return { score: null, reasons: [apiKey ? "no report" : "no CURSOR_API_KEY, judge skipped"] };
  const text = await askModel(judgePrompt(r), model, apiKey, mkdtempSync(join(tmpdir(), "judge-")));
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { score: null, reasons: ["judge reply wasn't JSON"] };
  try {
    const parsed = JSON.parse(m[0]) as { score: number; reasons?: string[] };
    return { score: Math.max(0, Math.min(1, Number(parsed.score))), reasons: parsed.reasons ?? [] };
  } catch {
    return { score: null, reasons: ["judge reply wasn't JSON"] };
  }
}

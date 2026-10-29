import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCELERATOR } from "../../tools/fixture.ts";

export const PERMISSIVE = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0"];
export const TOOLCHAINS = ["js-ts", "python", "go", "dotnet"] as const;

export interface Golden {
  id: string;
  repo: string;
  sha: string;
  license: string;
  toolchains: (typeof TOOLCHAINS)[number][];
  shape: "single" | "monorepo";
  reason: string;
  expect: {
    // Components the audit must assess, and ones it must list as not assessed with their toolchain.
    included: string[];
    excluded: { id: string; toolchain: string }[];
  };
}

export interface GoldenSet {
  schema: "agent-readiness/goldens@1";
  // Highest first. Every component in a tier must sit strictly above every component in the
  // next tier; within a tier no order is asserted. Entries are "<golden id>:<component id>".
  rank: string[][];
  goldens: Golden[];
}

export function loadGoldens(): GoldenSet {
  return JSON.parse(readFileSync(join(ACCELERATOR, "evals", "goldens", "goldens.json"), "utf8")) as GoldenSet;
}

export function goldenProblems(set: GoldenSet): string[] {
  const out: string[] = [];
  if (set.goldens.length < 4 || set.goldens.length > 6) out.push(`${set.goldens.length} goldens; the set needs 4 to 6`);
  for (const g of set.goldens) {
    if (!/^[0-9a-f]{40}$/.test(g.sha)) out.push(`${g.id}: the commit must be a full 40-character SHA`);
    if (!PERMISSIVE.includes(g.license)) out.push(`${g.id}: ${g.license} isn't a permissive license`);
    if (!g.reason.trim()) out.push(`${g.id}: no reason given`);
    if (g.expect.included.length + g.expect.excluded.length === 0) out.push(`${g.id}: expects no components`);
  }
  for (const t of TOOLCHAINS) if (!set.goldens.some((g) => g.toolchains.includes(t))) out.push(`no golden covers ${t}`);
  if (!set.goldens.some((g) => g.shape === "monorepo" && g.expect.included.length + g.expect.excluded.length > 1)) out.push("no golden is a monorepo with nested apps");
  const known = new Set(set.goldens.flatMap((g) => g.expect.included.map((c) => `${g.id}:${c}`)));
  for (const e of set.rank.flat()) if (!known.has(e)) out.push(`rank names ${e}, which no golden expects to assess`);
  if (set.rank.length < 3) out.push("the ranking needs at least three tiers to span low to high");
  return out;
}

// Levels are null when the audit gave none; a missing or null level breaks every assertion it's in.
export function rankViolations(set: GoldenSet, levels: Record<string, number | null | undefined>): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < set.rank.length; i++) {
    for (const hi of set.rank[i]) {
      for (const lo of set.rank[i + 1]) {
        const a = levels[hi];
        const b = levels[lo];
        if (a === null || a === undefined || b === null || b === undefined) out.push(`${hi} (${a ?? "no level"}) vs ${lo} (${b ?? "no level"}): both need a level`);
        else if (!(a > b)) out.push(`${hi} is Level ${a}, which should be above ${lo} at Level ${b}`);
      }
    }
  }
  return out;
}

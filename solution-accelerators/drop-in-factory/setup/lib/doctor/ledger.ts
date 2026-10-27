/**
 * Verdicts for one factory, keyed by pull request and head SHA. Appending a
 * row for a new SHA voids older rows for that pull request. The file is
 * JSONL in `setup/verdicts/`, committed; a markdown twin is rewritten beside it for
 * reading. The head SHA is the newest commit outside `setup/verdicts/` (source.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export const VERDICTS = ["live-verified", "docs-run-verified", "unit-test-verified", "type-check-only", "blocked", "failed"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface VerdictRow {
  pr: string;
  sha: string;
  verdict: Verdict;
  at: string;
  note: string;
  /** The hosted release the verdict covers, as `release <id>`, or "" when nothing hosted was checked. */
  deployed?: string;
  teamId?: string;
  /** Who recorded it: agent and model. */
  verifier?: string;
  /** Artifact paths and logs. */
  evidence?: string;
  void: boolean;
  /** The head SHA that voided this row, when `void` is true. */
  voidedBy: string | null;
}

export function isVerdict(value: string): value is Verdict {
  return (VERDICTS as readonly string[]).includes(value);
}

/** A new SHA voids every open row for that pull request. The same SHA does not. */
export function appendRow(rows: VerdictRow[], next: Omit<VerdictRow, "void" | "voidedBy">): VerdictRow[] {
  const voided = rows.map((row) =>
    row.pr === next.pr && row.sha !== next.sha && !row.void ? { ...row, void: true, voidedBy: next.sha } : row,
  );
  voided.push({ ...next, void: false, voidedBy: null });
  return voided;
}

/** The latest open row for this pull request, and only when its SHA is the one asked about. */
export function currentRow(rows: VerdictRow[], pr: string, sha: string): VerdictRow | null {
  const open = [...rows].reverse().find((row) => row.pr === pr && !row.void);
  if (open === undefined || open.sha !== sha) return null;
  return open;
}

export function readLedger(path: string): VerdictRow[] {
  try {
    const text = readFileSync(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as VerdictRow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function writeLedger(path: string, rows: VerdictRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length === 0 ? "" : "\n"));
  writeFileSync(markdownPath(path), renderMarkdown(rows));
}

export function markdownPath(path: string): string {
  return join(dirname(path), basename(path, extname(path)) + ".md");
}

export function renderMarkdown(rows: VerdictRow[]): string {
  const cell = (text: string | undefined) => (text ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
  const lines = [
    "# Verdict ledger",
    "",
    "One row per verdict, keyed by PR and head SHA. A new head SHA voids every earlier row for that PR. Written by `npm run verdict`; do not edit by hand.",
    "",
    "| Date | PR | Head SHA | Deployed | Team ID | Verdict | Verifier | Evidence | Notes | Void |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const voided = row.void ? `voided by ${row.voidedBy ?? ""}` : "";
    lines.push(`| ${row.at} | ${row.pr} | ${row.sha} | ${cell(row.deployed)} | ${cell(row.teamId)} | ${row.verdict} | ${cell(row.verifier)} | ${cell(row.evidence)} | ${cell(row.note)} | ${voided} |`);
  }
  if (rows.length === 0) lines.push("| | | | | | | | | | |");
  lines.push("");
  return lines.join("\n");
}

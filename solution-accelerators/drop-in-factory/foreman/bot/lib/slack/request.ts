/**
 * What a top-level Slack mention asks for, and which repository it is for.
 * Pure: no Slack or GitHub calls, so tests feed it real event text.
 */

import type { FactoryConfig } from "../config/factory.ts";
import { t } from "../templates.ts";

/**
 * The request as a person meant it: mention tokens, Slack escapes and code
 * or quote formatting removed. People paste examples from Foreman's own
 * hints, so `` `agents: add a game` `` reads the same as `agents: add a game`.
 */
export function requestText(raw: string): string {
  let text = raw
    .replace(/<[@!][^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();
  for (;;) {
    const fence = /^```\s*([\s\S]*?)\s*```$/.exec(text) ?? /^([`*_~"'])\s*([\s\S]*?)\s*\1$/.exec(text);
    if (fence === null) break;
    text = (fence[2] ?? fence[1]).trim();
  }
  return text.replace(/^>\s*/, "").replace(/^`([^`\n]+)`/, "$1").trim();
}

export type Pick =
  | { repo: FactoryConfig; text: string; by: "channel" | "prefix" | "keyword" }
  | { choices: FactoryConfig[]; text: string };

/**
 * The repository a top-level mention is for. A channel one repository uses
 * needs nothing more. In a shared channel, a leading key (`garden: ...`) or
 * `in <key>` names it; otherwise the request's words are matched against each
 * repository's key, name and description, and a single best match wins.
 * Anything else is ambiguous: the caller asks the model or the person.
 */
export function pickRepo(repos: FactoryConfig[], channel: string, raw: string): Pick {
  const text = requestText(raw);
  const here = repos.filter((r) => r.slack?.channel === channel);
  if (here.length === 1) return { repo: here[0], text, by: "channel" };
  for (const r of here) {
    const names = `(?:${escape(r.key)}|${escape(r.repo)}|${escape(r.repo.split("/")[1])})`;
    const prefix = new RegExp(`^(?:in\\s+)?[\`*_~]?${names}[\`*_~]?\\s*(?:[:,\\-–—]\\s*|\\s+)`, "i");
    if (prefix.test(text)) return { repo: r, text: text.replace(prefix, "").trim(), by: "prefix" };
  }
  for (const r of here) {
    if (new RegExp(`\\b(?:in|on|to|for)\\s+(?:the\\s+)?(?:${escape(r.key)}|${escape(r.repo)})\\b`, "i").test(text)) return { repo: r, text, by: "prefix" };
  }
  const asked = words(text);
  const scored = here
    .map((r) => {
      const vocab = words(`${r.key} ${r.repo.replace("/", " ")} ${r.description ?? ""}`);
      return { r, score: [...asked].filter((w) => vocab.has(w)).length };
    })
    .sort((a, b) => b.score - a.score);
  if (scored.length > 0 && scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
    return { repo: scored[0].r, text, by: "keyword" };
  }
  return { choices: here, text };
}

/** A short example a person can copy: the key, then their request cut at a word. */
export function example(key: string, text: string): string {
  const max = 60;
  const short = text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}...`;
  return `${key}: ${short || t("context.example.blank")}`;
}

/** True when two requests ask for the same thing, judged by their content words. */
export function sameRequest(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  const small = Math.min(x.size, y.size);
  if (small < 3) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / small >= 0.7;
}

const STOP = new Set(
  "the and for with that this from into onto about please can could would you need want make new add our let lets have has should will just like some able allow allows allowing feature features thing things way also use using get".split(" "),
);

/** Lowercase content words with common endings dropped, so "watering" matches "water" and "games" matches "game". */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * What Foreman's model is told about a run thread before it chats there. In
 * the request thread it also ends its answer with a link to the status
 * thread, where the run's questions, approvals and results are.
 */
export function threadContext(run: { id: string; repo: string; issue: number; slackChannel: string | null; slackTs: string | null }, threadTs: string): string[] {
  const lines = [t("context.thread", { run: run.id, issue: run.issue, repo: run.repo })];
  if (run.slackChannel !== null && run.slackTs !== null && threadTs !== run.slackTs) {
    const status = `https://slack.com/archives/${run.slackChannel}/p${run.slackTs.replace(".", "")}`;
    lines.push(t("context.request-thread", { run: run.id, url: status }));
  }
  return lines;
}

/**
 * Every Foreman message in Slack as Block Kit, in four layouts: the run's
 * status message, an ask (a question, an approval or a reason), a result and
 * a notice. Each also has plain text, which Slack shows in notifications and
 * where blocks cannot render. The words are in bot/templates/; this file
 * only lays them out.
 */

import { t } from "../templates.ts";
import type { Blocks } from "./post.ts";

/** Slack's limits: header text 150 characters, section text 3000. */
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mrkdwn = (text: string) => ({ type: "mrkdwn", text: cut(text, 3000) });
const context = (text: string) => ({ type: "context", elements: [mrkdwn(text)] });
const section = (text: string) => ({ type: "section", text: mrkdwn(text) });

export interface Reactions {
  approve: string;
  reject: string;
  abandon: string;
}

export type AskKind = "approval" | "question" | "reason" | "findings";

/** The one-line reply hint that ends every ask in Slack. */
export function slackHint(kind: AskKind | "status", reactions: Reactions): string {
  switch (kind) {
    case "approval":
      return t("hints.slack.approval", { approve: reactions.approve, reject: reactions.reject });
    case "question":
      return t("hints.slack.question");
    case "reason":
      return t("hints.slack.reason");
    case "findings":
      return t("hints.slack.findings");
    case "status":
      return t("hints.slack.status", { abandon: reactions.abandon });
  }
}

/** The one-line reply hint that ends every ask on the GitHub issue. */
export function issueHint(kind: AskKind, gate?: { approveLabel: string; changesLabel: string }): string {
  switch (kind) {
    case "approval":
      return t("hints.issue.approval", { approveLabel: gate?.approveLabel ?? "approve", changesLabel: gate?.changesLabel ?? "changes" });
    case "question":
      return t("hints.issue.question");
    case "reason":
      return t("hints.issue.reason");
    case "findings":
      return t("hints.issue.findings");
  }
}

export interface StatusView {
  /** Run title and repository. */
  header: string;
  /** Emoji, stage and what it waits on. */
  stage: string;
  /** Issue, pull request, agent session and cost, as Slack links. */
  links: string[];
  hint: string;
}

export function statusBlocks(v: StatusView): Blocks {
  return [
    { type: "header", text: { type: "plain_text", text: cut(v.header, 150), emoji: true } },
    section(v.stage),
    context(v.links.join("  ·  ")),
    context(t("slack.hint-line", { hint: v.hint })),
  ];
}

export interface AskView {
  kind: AskKind;
  title: string;
  body: string;
  /** `<@U…>` of whoever is asked, or null. */
  mention: string | null;
  links: string[];
  hint: string;
}

export function askBlocks(v: AskView): Blocks {
  const blocks: Blocks = [section(`${t(`slack.icon.${v.kind}`)} ${v.mention === null ? "" : `${v.mention} `}*${v.title}*`)];
  if (v.body !== "") blocks.push(section(v.body));
  if (v.links.length > 0) blocks.push(context(v.links.join("  ·  ")));
  blocks.push({ type: "divider" }, context(t("slack.hint-line", { hint: v.hint })));
  return blocks;
}

export const askText = (v: AskView) => `${v.mention === null ? "" : `${v.mention} `}${v.title}${v.body === "" ? "" : `\n${v.body}`}\n${v.hint}`;

export interface ResultView {
  ok: boolean;
  title: string;
  body: string;
  links: string[];
}

export function resultBlocks(v: ResultView): Blocks {
  const blocks: Blocks = [section(`${t(v.ok ? "slack.icon.passed" : "slack.icon.failed")} *${v.title}*${v.body === "" ? "" : `\n${v.body}`}`)];
  if (v.links.length > 0) blocks.push(context(v.links.join("  ·  ")));
  return blocks;
}

export const resultText = (v: ResultView) => `${v.title}${v.body === "" ? "" : `\n${v.body}`}${v.links.length === 0 ? "" : `\n${v.links.join(" · ")}`}`;

export function noticeBlocks(text: string, links: string[] = []): Blocks {
  const blocks: Blocks = [section(text)];
  if (links.length > 0) blocks.push(context(links.join("  ·  ")));
  return blocks;
}

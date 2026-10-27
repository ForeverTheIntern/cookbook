/**
 * Read a gate decision from GitHub. Sources: `approve` and `changes: <what>`
 * comments on the run's issue and pull request, and the gate's labels on
 * either (actor and time from the issue timeline). Only decisions made after
 * the gate opened count, and only an approver's.
 */

import type { Gate } from "../config/factory.ts";
import type { Comment } from "../github/rest.ts";
import type { LabelEvent } from "../github/gh.ts";

export const FACTORY_MARK = "<!-- factory";

export type Command = { kind: "approve" } | { kind: "changes"; text: string } | { kind: "retry" } | null;

/** The command a comment body carries. Factory posts carry none. */
export function commandOf(body: string): Command {
  if (body.includes(FACTORY_MARK)) return null;
  const text = body.trim();
  if (/^approve\b/i.test(text)) return { kind: "approve" };
  const changes = /^changes:\s*([\s\S]+)/i.exec(text);
  if (changes !== null) return { kind: "changes", text: changes[1].trim() };
  if (/^retry\b/i.test(text)) return { kind: "retry" };
  return null;
}

export type SlackCommand = Exclude<Command, null> | { kind: "abandon"; reason: string | null } | null;

/** The command a Slack reply carries, with the @mention removed: a gate command, or `abandon`/`close` with an optional reason. */
export function slackCommandOf(text: string): SlackCommand {
  const abandon = /^(?:abandon|close)\b[\s:,.-]*([\s\S]*)$/i.exec(text.trim());
  if (abandon !== null) return { kind: "abandon", reason: abandon[1].trim() === "" ? null : abandon[1].trim() };
  return commandOf(text);
}

export interface Vote {
  id: string;
  by: string;
  at: string;
  kind: "approve" | "changes";
  text: string;
}

export type Decision = { kind: "none" } | Vote;

export interface GateRead {
  decision: Decision;
  /** Votes after the gate opened from someone who is not an approver. */
  ignored: Vote[];
  /** Votes from before the gate opened. Logged, never acted on. */
  stale: Vote[];
}

export function votes(gate: Gate, comments: Comment[], labels: LabelEvent[]): Vote[] {
  const out: Vote[] = [];
  for (const c of comments) {
    const command = commandOf(c.body);
    if (command === null || command.kind === "retry") continue;
    out.push({ id: `comment:${c.id}`, by: c.login, at: c.createdAt, kind: command.kind, text: command.kind === "changes" ? command.text : "" });
  }
  for (const l of labels) {
    if (l.label === gate.approveLabel) out.push({ id: `label:${l.id}`, by: l.login, at: l.at, kind: "approve", text: "" });
    if (l.label === gate.changesLabel) {
      out.push({ id: `label:${l.id}`, by: l.login, at: l.at, kind: "changes", text: `changes requested with the ${l.label} label` });
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The first approver vote strictly after `since` decides; one in the same second as a gate (re)opening is stale. */
export async function decide(
  all: Vote[],
  since: string,
  isApprover: (login: string) => Promise<boolean>,
): Promise<GateRead> {
  const ignored: Vote[] = [];
  const opened = Date.parse(since);
  const stale = all.filter((v) => Date.parse(v.at) <= opened);
  for (const vote of all.filter((v) => Date.parse(v.at) > opened)) {
    if (await isApprover(vote.by)) return { decision: vote, ignored, stale };
    ignored.push(vote);
  }
  return { decision: { kind: "none" }, ignored, stale };
}

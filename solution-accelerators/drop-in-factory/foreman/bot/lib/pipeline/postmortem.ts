/**
 * The post-mortem of a run that stopped without merging: what was asked, how
 * far it got, how often work was sent back and why, and why it stopped. From
 * the run document alone, so the issue and Slack get the same facts.
 */

import type { FactoryConfig } from "../config/factory.ts";
import { roleLabels, runCost, type RunDoc } from "../store/runs.ts";
import { mdLink, plural, t } from "../templates.ts";
import { displayName, sendsBack } from "./route.ts";

export interface PostMortem {
  /** Markdown for the issue. */
  issue: string;
  /** Slack mrkdwn for the status thread. */
  slack: string;
}

export function postMortem(config: Pick<FactoryConfig, "steps">, doc: Pick<RunDoc, "run" | "transitions" | "roles">, asked: { title: string; body: string }, why: string): PostMortem {
  const run = doc.run;
  const from = sendsBack(config);
  const changeSteps = new Set(config.steps.flatMap((e) => (e.step?.settings.kind === "change" ? [e.step.id] : [])));
  const moves = doc.transitions.filter((m) => m.stage !== "intake");
  const ended = moves.at(-1);
  const reached = [...moves].reverse().find((m) => m !== ended)?.stage ?? "intake";
  const path = dedupeRuns(doc.transitions.map((m) => m.stage));
  const sentBack = doc.transitions.filter((m, i) => changeSteps.has(m.stage) && i > 0 && from.has(doc.transitions[i - 1].stage));
  const to = [...changeSteps].map(displayName).join(" or ");
  const footer = t("github.request.footer");
  const request = asked.body.split(footer).join("").trim().split("\n")[0] ?? "";
  const labels = roleLabels(doc.roles);
  const agents = doc.roles.map((r, i) => mdLink(labels[i], r.url));
  const spent = runCost(doc.roles);
  const cost = spent.cents === null ? "" : (spent.cents / 100).toFixed(2);
  const findings = run.handled.length;
  const common = { reached, why, cost, costState: spent.state };

  const issue = t("postmortem.issue", {
    ...common,
    run: run.id,
    asked: asked.title,
    request: request === "" || sameText(request, asked.title) ? "" : request,
    changes: path.length - 1,
    path: path.join(" → "),
    to,
    sendBacks: sentBack.length,
    reasons: sentBack.map((m) => m.reason).join("; "),
    findings,
    agents: agents.join(", "),
  });
  const slack = t("postmortem.slack", {
    ...common,
    sendBacks: plural("postmortem.slack.send-backs", sentBack.length),
    findings: plural("postmortem.slack.findings", findings),
    agents: plural("postmortem.slack.agents", agents.length),
  });
  return { issue, slack };
}

/** A Slack request's body repeats its title, give or take case and a trailing period. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/[.!]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Stages in order, with a stage repeated back to back shown once. */
function dedupeRuns(stages: string[]): string[] {
  return stages.filter((s, i) => i === 0 || s !== stages[i - 1]);
}

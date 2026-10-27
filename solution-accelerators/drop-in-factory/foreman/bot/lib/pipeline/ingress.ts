/**
 * Ingress turns one input into at most one trigger. A trigger only names the
 * work: dispatch.ts reconciles the run, which re-reads GitHub, so a replayed
 * or late delivery converges on the same result.
 */

import type { FactoryConfig } from "../config/factory.ts";
import { runIdFor } from "../store/runs.ts";
import type { Store } from "../store/store.ts";
import { FACTORY_MARK } from "./gates.ts";

export type Trigger =
  | { kind: "intake"; repo: string; issue: number; title: string }
  | { kind: "reconcile"; runId: string; why: string }
  | { kind: "slack_intake"; repo: string; channel: string; ts: string; text: string; user: string }
  | { kind: "answer"; runId: string; text: string };

/** The run a pull request belongs to: its head branch is factory/<run-id>. */
async function runOfPull(store: Store, repo: string, pr: { number: number; head?: { ref?: string } }): Promise<string | null> {
  const ref = pr.head?.ref ?? "";
  if (ref.startsWith("factory/")) return ref.slice("factory/".length);
  return (await store.runByPr(repo, pr.number))?.id ?? null;
}

/** A GitHub webhook. Returns its trigger, or null when it is not for a repository the factory serves or doesn't matter. */
export async function fromGitHub(store: Store, repos: FactoryConfig[], name: string, payload: any): Promise<Trigger | null> {
  const config = repos.find((r) => r.repo === payload.repository?.full_name);
  if (config === undefined) return null;
  const runOf = (issue: number) => runIdFor(config.key, issue);
  const gateLabels = Object.values(config.gates).flatMap((g) => [g.approveLabel, g.changesLabel]);

  if (name === "issues" && payload.action === "labeled") {
    const label = payload.label?.name;
    if (label !== config.intakeLabel && !gateLabels.includes(label)) return null;
    const issue = payload.issue.number;
    if (label === config.intakeLabel) return { kind: "intake", repo: config.repo, issue, title: payload.issue.title };
    return { kind: "reconcile", runId: runOf(issue), why: `label ${label} on #${issue}` };
  }
  if (name === "pull_request" && payload.action === "labeled") {
    if (!gateLabels.includes(payload.label?.name)) return null;
    const run = await runOfPull(store, config.repo, payload.pull_request);
    if (run === null) return null;
    return { kind: "reconcile", runId: run, why: `label ${payload.label.name} on #${payload.pull_request.number}` };
  }
  if (name === "pull_request" && (payload.action === "closed" || payload.action === "synchronize")) {
    const run = await runOfPull(store, config.repo, payload.pull_request);
    if (run === null) return null;
    return { kind: "reconcile", runId: run, why: `#${payload.pull_request.number} ${payload.action === "closed" ? "closed" : "got a new commit"}` };
  }
  if (name === "issues" && payload.action === "closed") {
    return { kind: "reconcile", runId: runOf(payload.issue.number), why: `#${payload.issue.number} closed` };
  }
  if ((name === "pull_request_review" && payload.action === "submitted") || (name === "pull_request_review_comment" && payload.action === "created")) {
    if (String(payload.review?.body ?? payload.comment?.body ?? "").includes(FACTORY_MARK)) return null;
    const run = await runOfPull(store, config.repo, payload.pull_request);
    if (run === null) return null;
    return { kind: "reconcile", runId: run, why: `${name === "pull_request_review" ? "review" : "review comment"} on #${payload.pull_request.number}` };
  }
  if ((name === "check_run" || name === "check_suite") && payload.action === "completed") {
    const pulls: { number: number; head?: { ref?: string } }[] = payload[name]?.pull_requests ?? [];
    for (const pr of pulls) {
      const run = await runOfPull(store, config.repo, pr);
      if (run !== null) return { kind: "reconcile", runId: run, why: `${name} ${payload[name]?.name ?? payload[name]?.app?.slug ?? ""} completed on #${pr.number}`.replace(/\s+/g, " ") };
    }
    return null;
  }
  if (name === "issue_comment" && payload.action === "created") {
    if (String(payload.comment.body).includes(FACTORY_MARK)) return null;
    const run = payload.issue.pull_request ? await runOfPull(store, config.repo, { number: payload.issue.number }) : runOf(payload.issue.number);
    if (run === null) return null;
    return { kind: "reconcile", runId: run, why: `comment ${payload.comment.id}` };
  }
  return null;
}

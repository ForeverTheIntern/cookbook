/**
 * The run document's shapes, and the pure functions over them. The store
 * (store.ts) keeps one document per run.
 */

import { ENDED_STAGES, type Stage } from "../pipeline/route.ts";

export interface Run {
  id: string;
  /** owner/name. */
  repo: string;
  issue: number;
  title: string;
  stage: Stage;
  stageSince: string;
  /** The transition that opened the current stage. One step launch per visit. */
  visit: number;
  pmRound: number;
  sendBacks: number;
  /** What the next step launch must address: gate changes or verdict findings. */
  feedback: string | null;
  /** Branch head when the current gate opened. */
  gateSha: string | null;
  pr: number | null;
  hold: string | null;
  holdSince: string | null;
  slackChannel: string | null;
  slackTs: string | null;
  /** The bot's top-level status line for this run, and what it last said. */
  statusTs: string | null;
  statusText: string | null;
  statusAt: string | null;
  /**
   * What the run waits on besides its stage: "conflict" when its pull request conflicts with base,
   * "checks" while CI runs, "findings" when review findings reached the send-back cap.
   */
  blocked: string | null;
  createdAt: string;
  closedAt: string | null;
  /** The Slack user who asked, for a run started from Slack. */
  requester: string | null;
  /** The person's request message, whose thread Foreman answers in but does not post follow-ups to. */
  requestTs: string | null;
  /** The open question or approval ask in the status thread, whose reactions count as votes. */
  askTs: string | null;
  /** Foreman's sticky status comment on the issue, edited in place, and what it last said. */
  statusComment: number | null;
  statusCommentText: string | null;
  /** The pull request head that verify passed. A different head while waiting to merge reruns review and verify. */
  verifiedSha: string | null;
  /** Pull request findings (review threads, reviews, failed checks) already sent back to Implement. */
  handled: string[];
  /** Gate votes given in Slack, already checked against the requester and slack.approvers. */
  slackVotes: SlackVote[];
  /** An abandon asked for in Slack, or a close on GitHub waiting on its reason. */
  abandon: Abandon | null;
  /** Bumped on every save. A save from a stale read fails; the portal keeps only the newest. */
  rev: number;
}

export interface SlackVote {
  /** Slack user id. */
  user: string;
  name: string;
  /** The message that carried the vote: the reply, or the ask that was reacted to. */
  ts: string;
  at: string;
  kind: "approve" | "changes";
  text: string;
  /** The emoji name, for a reaction vote. */
  reaction: string | null;
}

export interface Abandon {
  /** Slack user id, or the GitHub login that closed the issue or pull request. */
  by: string;
  name: string;
  /** null until the person gives one. */
  reason: string | null;
  at: string;
  via: "slack" | "github";
  /** Set once the post-mortem is on the issue. */
  postmortem: boolean;
}

/** Values for run fields added after a run document was first written. */
export const RUN_DEFAULTS = {
  requester: null, requestTs: null, askTs: null, statusComment: null, statusCommentText: null, verifiedSha: null, handled: [], slackVotes: [], abandon: null,
} satisfies Partial<Run>;

export interface RoleRun {
  agentId: string;
  runId: string;
  /** The step id (its folder name). The field keeps its first name, so stored documents and the dashboard still read it. */
  role: string;
  visit: number;
  status: string;
  baseSha: string;
  startedAt: string;
  deadline: string;
  finishedAt: string | null;
  url: string;
  /** The chargedCents the Admin API has returned for this agent so far; null until it returns any. */
  costCents: number | null;
  /** settling: may still grow. final: unchanged for the stable window, or past the cap. */
  costState: CostState | null;
  costCheckedAt: string | null;
  costChangedAt: string | null;
}

export type CostState = "settling" | "final";

export interface Transition {
  /** 1, 2, ... within the run. */
  seq: number;
  runId: string;
  stage: Stage;
  at: string;
  reason: string;
  /** The GitHub login whose decision caused this move, or null for the factory. */
  actor: string | null;
}

/** Everything the factory keeps about one run, stored as one value. */
export interface RunDoc {
  schema: 1;
  run: Run;
  transitions: Transition[];
  roles: RoleRun[];
  /** Dedupe keys of the comments and Slack posts already made, as `<target>:<key>`. */
  posts: string[];
  /** Reconciles in a row that threw. The third holds the run. */
  failures: number;
}

/** f-<repository key>-<issue>. The single-repo shape's key is `gh`, so its ids stay f-gh-N. */
export const runIdFor = (key: string, issue: number) => `f-${key}-${issue}`;
export const branchFor = (runId: string) => `factory/${runId}`;
export const ENDED: ReadonlySet<Stage> = new Set(ENDED_STAGES);
export const isOpen = (run: Pick<Run, "stage">) => !ENDED.has(run.stage);

/** A Slack thread's web link. Slack redirects it to the workspace. */
export const threadUrl = (channel: string, ts: string) => `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;

/** The issue URLs triage closed this run as a duplicate of, or null when it was not closed that way. */
export function duplicateOf(doc: Pick<RunDoc, "run" | "transitions">): string[] | null {
  const last = doc.transitions.at(-1);
  if (doc.run.stage !== "closed" || last === undefined || last.stage !== "closed" || !last.reason.startsWith(DUPLICATE_OF)) return null;
  return last.reason.slice(DUPLICATE_OF.length).split(", ").filter((url) => url !== "");
}

/** The reason triage records when it closes a run as a duplicate; `duplicateOf` reads it back. */
export const DUPLICATE_OF = "duplicate of ";

/**
 * Whether a run waiting at intake may start, and how many waiting runs are
 * ahead of it, given every open run oldest first. A run is active from the
 * moment it has a branch until it is done or closed, gates and holds
 * included, because its branch can still conflict with another. Waiting runs
 * start oldest first, each only while its repository and the whole factory
 * are under their limits.
 */
export function admission(open: Run[], run: Run, limits: { runsPerRepo: number; runsTotal: number }): { start: boolean; ahead: number } {
  const perRepo = new Map<string, number>();
  let total = 0;
  for (const r of open.filter((o) => o.stage !== "intake")) {
    perRepo.set(r.repo, (perRepo.get(r.repo) ?? 0) + 1);
    total += 1;
  }
  let ahead = 0;
  for (const r of open.filter((o) => o.stage === "intake")) {
    const fits = (perRepo.get(r.repo) ?? 0) < limits.runsPerRepo && total < limits.runsTotal;
    if (r.id === run.id) return { start: fits, ahead };
    if (r.repo === run.repo || total >= limits.runsTotal) ahead += 1;
    if (fits) {
      perRepo.set(r.repo, (perRepo.get(r.repo) ?? 0) + 1);
      total += 1;
    }
  }
  return { start: false, ahead };
}

/**
 * Display names for a run's agents, in the order given (oldest first). A role
 * that ran more than once (a spec question round, a send-back) gets a round
 * number, so two `spec` rows read `spec (round 1)` and `spec (round 2)`.
 */
export function roleLabels(agents: Pick<RoleRun, "role">[]): string[] {
  const total = new Map<string, number>();
  for (const a of agents) total.set(a.role, (total.get(a.role) ?? 0) + 1);
  const seen = new Map<string, number>();
  return agents.map((a) => {
    const n = (seen.get(a.role) ?? 0) + 1;
    seen.set(a.role, n);
    return total.get(a.role)! > 1 ? `${a.role} (round ${n})` : a.role;
  });
}

/**
 * A run's invoice total: the sum of the figures the Admin API has returned,
 * one per agent. It is final only when every agent has finished and its
 * figure is final; otherwise it is settling, and `read` of `agents` says how
 * many agents it covers. Null cents means no agent has a figure yet.
 */
export function runCost(agents: RoleRun[]): { cents: number | null; state: CostState; read: number; agents: number } {
  const read = agents.filter((a) => a.costCents !== null);
  const final = agents.length > 0 && agents.every((a) => a.finishedAt !== null && a.costState === "final");
  return { cents: read.length === 0 ? null : read.reduce((sum, a) => sum + a.costCents!, 0), state: final ? "final" : "settling", read: read.length, agents: agents.length };
}

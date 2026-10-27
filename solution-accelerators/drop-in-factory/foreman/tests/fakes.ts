/**
 * In-memory GitHub, Cloud Agents and Slack behind the Ports interface, plus a
 * Ctx over an in-memory Store. A test plays the people and the agents.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseFactory, type Factory, type FactoryConfig } from "../bot/lib/config/factory.ts";
import { CATALOG, type StepCatalog } from "../bot/lib/steps/catalog.ts";
import type { LabelEvent } from "../bot/lib/github/gh.ts";
import type { CloseReason, Comment, PrFeedback, Pull } from "../bot/lib/github/rest.ts";
import { dispatch, tick, type Runtime } from "../bot/lib/pipeline/dispatch.ts";
import { fromGitHub, type Trigger } from "../bot/lib/pipeline/ingress.ts";
import type { Ports } from "../bot/lib/pipeline/ports.ts";
import type { Ctx } from "../bot/lib/pipeline/reconcile.ts";
import type { AgentState, Launch } from "../bot/lib/steps/cloud-agent.ts";
import { MemoryKv } from "../bot/lib/store/kv.ts";
import { Store } from "../bot/lib/store/store.ts";

export const FACTORY_DIR = fileURLToPath(new URL("../..", import.meta.url));
export const REPO = "acme/app";

/** factory.yaml with REPO as its one repository, alice as approver and a Slack channel; `edit` changes the doc first. */
export function testFactory(edit: (doc: any) => void = () => {}, catalog: StepCatalog = CATALOG): Factory {
  const doc = parse(readFileSync(join(FACTORY_DIR, "factory.yaml"), "utf8"));
  // A copy's factory.yaml from before steps: fails here with the loader's message naming the moved key.
  if (!Array.isArray(doc?.steps)) parseFactory(doc, catalog);
  delete doc.repos;
  doc.repo = REPO;
  doc.base = "main";
  for (const entry of doc.steps) if (typeof entry === "object") entry.approvers = ["alice"];
  doc.slack = { channel: "C0FACTORY" };
  edit(doc);
  return parseFactory(doc, catalog);
}

/** The `- gate: <name>` entry of a factory.yaml doc's steps: list, to edit in a test. */
export function gateIn(doc: any, name: string): any {
  const entry = doc.steps.find((e: any) => typeof e === "object" && e.gate === name);
  assert.ok(entry !== undefined, `factory.yaml has no gate ${name}`);
  return entry;
}

/** Drop a step or gate from a factory.yaml doc's steps: list. */
export function withoutStep(doc: any, name: string): void {
  doc.steps = doc.steps.filter((e: any) => e !== name && !(typeof e === "object" && e.gate === name));
}

export function testConfig(edit: (doc: any) => void = () => {}, catalog: StepCatalog = CATALOG): FactoryConfig {
  return testFactory(edit, catalog).repos[0];
}

interface Commit {
  parent: string | null;
  files: Record<string, string>;
}

export class World {
  readonly repo: string;
  constructor(repo = REPO) {
    this.repo = repo;
  }
  clock = Date.parse("2026-10-21T10:00:00Z");
  commits = new Map<string, Commit>([["base0", { parent: null, files: {} }]]);
  branches = new Map<string, string>([["main", "base0"]]);
  issues = new Map<number, { title: string; body: string; state: string; closedAs: CloseReason | null; closedBy: string | null; comments: Comment[]; labels: LabelEvent[]; applied: string[] }>();
  pulls = new Map<number, Pull & { branch: string; comments: Comment[]; labels: LabelEvent[]; reviews: string[]; feedback: PrFeedback }>();
  agents = new Map<string, AgentState & { launch: Launch; video?: { name: string; data: Uint8Array } }>();
  slackPosts: { channel: string; text: string; threadTs: string | null; ts: string; blocks?: unknown[] }[] = [];
  slackEdits: { channel: string; ts: string; text: string; blocks?: unknown[] }[] = [];
  slackUploads: { channel: string; threadTs: string; name: string; bytes: number; text: string }[] = [];
  /** Reactions on a message, by `${channel}/${ts}`: emoji name to user ids. */
  slackReactions = new Map<string, Map<string, string[]>>();
  /** A Slack upload fails with this error when set. */
  uploadError: string | null = null;
  /** Comments edited in place, by id. */
  edited = new Map<number, string>();
  nextNumber = 1;
  nextId = 1;

  now(): string {
    return new Date(this.clock).toISOString();
  }
  advance(minutes: number): void {
    this.clock += minutes * 60_000;
  }

  openIssue(title: string, body = "Please build it."): number {
    const n = this.nextNumber++;
    this.issues.set(n, { title, body, state: "open", closedAs: null, closedBy: null, comments: [], labels: [], applied: [] });
    return n;
  }

  /** Someone closes an issue by hand on GitHub. */
  closeByHand(number: number, login: string): void {
    this.advance(1);
    Object.assign(this.issues.get(number)!, { state: "closed", closedAs: "completed", closedBy: login });
  }

  /** Someone reacts to a Slack message. */
  react(channel: string, ts: string, name: string, user: string): void {
    const key = `${channel}/${ts}`;
    const on = this.slackReactions.get(key) ?? new Map<string, string[]>();
    on.set(name, [...(on.get(name) ?? []), user]);
    this.slackReactions.set(key, on);
  }

  /** A reviewer or bot leaves an unresolved review thread on a pull request. */
  thread(pr: number, login: string, body: string, bot = true, path = "src/feature1.ts"): string {
    this.advance(1);
    const id = `T${this.nextId++}`;
    this.pulls.get(pr)!.feedback.threads.push({ id, resolved: false, outdated: false, login, bot, path, line: 3, body, url: `https://github.com/${this.repo}/pull/${pr}#${id}`, createdAt: this.now() });
    return id;
  }

  /** A review on a pull request. */
  reviewBy(pr: number, login: string, state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED", body: string, bot = false): void {
    this.advance(1);
    const p = this.pulls.get(pr)!;
    p.feedback.reviews.push({ id: this.nextId++, login, bot, state, body, submittedAt: this.now(), commit: p.headSha, url: "" });
  }

  /** Set a check on a pull request's head. */
  check(pr: number, name: string, status: "queued" | "in_progress" | "completed", conclusion: string | null = null): void {
    const checks = this.pulls.get(pr)!.feedback.checks.filter((c) => c.name !== name);
    this.pulls.get(pr)!.feedback.checks = [...checks, { name, status, conclusion, url: `https://ci.example/${name}`, summary: conclusion === "failure" ? `${name} failed` : "" }];
  }

  /** A person comments on an issue or pull request. */
  say(number: number, login: string, body: string): Comment {
    this.advance(1);
    const c = { id: this.nextId++, login, bot: false, body, createdAt: this.now(), url: `https://github.com/${this.repo}/issues/${number}#c` };
    (this.issues.get(number) ?? this.pulls.get(number))!.comments.push(c);
    return c;
  }

  label(number: number, login: string, label: string): void {
    this.advance(1);
    (this.issues.get(number) ?? this.pulls.get(number))!.labels.push({ id: this.nextId++, label, login, at: this.now() });
  }

  /** The agent pushes `files` to its branch and ends with `status`. */
  finish(agentId: string, files: Record<string, string>, status: AgentState["status"] = "FINISHED"): void {
    const agent = this.agents.get(agentId)!;
    if (Object.keys(files).length > 0) {
      const sha = `c${this.nextId++}`;
      this.commits.set(sha, { parent: this.branches.get(agent.launch.branch)!, files });
      this.branches.set(agent.launch.branch, sha);
    }
    agent.status = status;
  }

  push(branch: string, files: Record<string, string>): void {
    const sha = `c${this.nextId++}`;
    this.commits.set(sha, { parent: this.branches.get(branch)!, files });
    this.branches.set(branch, sha);
    for (const p of this.pulls.values()) if (p.branch === branch) p.headSha = sha;
  }

  merge(pr: number, by: string): void {
    const p = this.pulls.get(pr)!;
    Object.assign(p, { state: "closed", merged: true, mergedAt: this.now(), mergedBy: by });
  }

  running(): (AgentState & { launch: Launch; video?: { name: string; data: Uint8Array } })[] {
    return [...this.agents.values()].filter((a) => a.status === "RUNNING");
  }

  private fileAt(sha: string, path: string): string | null {
    for (let s: string | null = sha; s !== null; s = this.commits.get(s)!.parent) {
      const f = this.commits.get(s)!.files[path];
      if (f !== undefined) return f;
    }
    return null;
  }

  ports(): Ports {
    const w = this;
    return {
      github: {
        baseSha: async () => w.branches.get("main")!,
        branchSha: async (b) => w.branches.get(b) ?? null,
        createBranch: async (b, sha) => void w.branches.set(b, sha),
        deleteBranch: async (b) => void w.branches.delete(b),
        readFile: async (path, ref) => w.fileAt(ref, path),
        changedFiles: async (base, head) => {
          const files = new Set<string>();
          for (let s: string | null = head; s !== null && s !== base; s = w.commits.get(s)!.parent) {
            for (const f of Object.keys(w.commits.get(s)!.files)) files.add(f);
          }
          return [...files];
        },
        issue: async (n) => {
          const i = w.issues.get(n)!;
          return { title: i.title, body: i.body, url: `https://github.com/${w.repo}/issues/${n}`, state: i.state, labels: [...i.applied], closedBy: i.closedBy };
        },
        createIssue: async (title, body) => {
          const n = w.openIssue(title, body);
          return { number: n, url: `https://github.com/${w.repo}/issues/${n}` };
        },
        closeIssue: async (n, reason) => void Object.assign(w.issues.get(n)!, { state: "closed", closedAs: reason, closedBy: "factory-bot" }),
        addLabel: async (n, label) => void (w.issues.get(n) ?? { applied: [] as string[] }).applied.push(label),
        comments: async (n) => [...(w.issues.get(n) ?? w.pulls.get(n))!.comments].map((c) => ({ ...c, body: w.edited.get(c.id) ?? c.body })),
        comment: async (n, body) => {
          const id = w.nextId++;
          (w.issues.get(n) ?? w.pulls.get(n))!.comments.push({ id, login: "factory-bot", bot: true, body, createdAt: w.now(), url: "" });
          return id;
        },
        editComment: async (id, body) => void w.edited.set(id, body),
        relay: async (n, body) => {
          (w.issues.get(n) ?? w.pulls.get(n))!.comments.push({ id: w.nextId++, login: "operator", bot: false, body, createdAt: w.now(), url: "" });
        },
        labelEvents: async (n) => [...(w.issues.get(n) ?? w.pulls.get(n))!.labels],
        pull: async (n) => {
          const p = w.pulls.get(n)!;
          return { ...p, headSha: w.branches.get(p.branch) ?? p.headSha };
        },
        pullForBranch: async (b) => [...w.pulls.values()].find((p) => p.branch === b) ?? null,
        openDraft: async (branch) => {
          const n = w.nextNumber++;
          const pull = { number: n, url: `https://github.com/${w.repo}/pull/${n}`, body: "", draft: true, state: "open" as const, merged: false, mergedAt: null, mergedBy: null, headSha: w.branches.get(branch)!, mergeableState: "clean", branch, nodeId: `PR${n}`, comments: [], labels: [], reviews: [], feedback: { reviews: [], threads: [], checks: [] } };
          w.pulls.set(n, pull);
          return pull;
        },
        markReady: async (p) => void (w.pulls.get(p.number)!.draft = false),
        closePull: async (n) => void (w.pulls.get(n)!.state = "closed"),
        review: async (n, body) => void w.pulls.get(n)!.reviews.push(body),
        feedback: async (n) => structuredClone(w.pulls.get(n)!.feedback),
        isApprover: async (login, approvers) => approvers.includes(login),
        recentWork: async () => [...w.issues.entries()].map(([n, i]) => ({ number: n, title: i.title, url: `https://github.com/${w.repo}/issues/${n}`, state: i.state, kind: "issue", labels: [...i.applied] })),
      },
      agents: {
        launch: async (launch) => {
          const id = `bc-${w.nextId++}`;
          const state = { id, status: "RUNNING" as const, branch: launch.branch, summary: "", url: `https://cursor.com/agents/${id}`, launch };
          w.agents.set(id, state);
          return { ...state };
        },
        status: async (id) => ({ ...w.agents.get(id)! }),
        stop: async (id) => void (w.agents.get(id)!.status = "EXPIRED"),
        video: async (id) => w.agents.get(id)?.video ?? null,
      },
      slack: {
        post: async (channel, text, threadTs, blocks) => {
          const ts = `${w.slackPosts.length + 1}.0001`;
          w.slackPosts.push({ channel, text, threadTs, ts, blocks });
          return ts;
        },
        update: async (channel, ts, text, blocks) => void w.slackEdits.push({ channel, ts, text, blocks }),
        reactions: async (channel, ts) => [...(w.slackReactions.get(`${channel}/${ts}`) ?? new Map()).entries()].map(([name, users]) => ({ name, users })),
        upload: async (channel, threadTs, file, text) => {
          if (w.uploadError !== null) throw new Error(w.uploadError);
          w.slackUploads.push({ channel, threadTs, name: file.name, bytes: file.data.byteLength, text });
        },
        person: async (user) => `person-${user}`,
      },
    };
  }
}

/** An in-memory store on the world's clock. */
export function memoryStore(world: World): Store {
  return new Store(new MemoryKv(), { clock: () => world.clock, settleMs: 0 });
}

export function makeCtx(world: World, config = testConfig(), store: Store = memoryStore(world)): Ctx {
  return { store, config, ports: world.ports(), facts: null, factoryDir: FACTORY_DIR, now: () => world.now(), log: () => {} };
}

export function runtimeOf(...ctxs: Ctx[]): Runtime {
  return { ctxs, portal: null, otlpEndpoint: "", version: "test" };
}

const rtOf = (target: Ctx | Runtime): Runtime => ("ctxs" in target ? target : runtimeOf(target));

/** Handle one trigger, as the webhook or Slack handler would. */
export async function send(target: Ctx | Runtime, trigger: Trigger): Promise<void> {
  await dispatch(rtOf(target), trigger);
}

/** A GitHub delivery: ingress, then dispatch of its trigger. Returns the trigger, or null when ingress ignored it. */
export async function deliver(target: Ctx | Runtime, name: string, payload: unknown): Promise<Trigger | null> {
  const rt = rtOf(target);
  const trigger = await fromGitHub(rt.ctxs[0].store, rt.ctxs.map((c) => c.config), name, payload);
  if (trigger !== null) await dispatch(rt, trigger);
  return trigger;
}

/** A minute passes and the tick runs. A tick that makes a status edit waits about a second (slack/status.ts spacing). */
export async function tickAndDrain(ctx: Ctx, world: World): Promise<void> {
  world.advance(1);
  assert.notEqual(await tick(runtimeOf(ctx)), null, "another tick held the lock");
}

export const hooks = {
  labeled: (world: World, number: number, label: string) => ({
    action: "labeled",
    label: { name: label },
    issue: { number, title: world.issues.get(number)?.title ?? "", updated_at: world.now() },
    repository: { full_name: world.repo },
  }),
  prLabeled: (world: World, number: number, label: string) => ({
    action: "labeled",
    label: { name: label },
    pull_request: { number, updated_at: world.now(), head: { ref: world.pulls.get(number)!.branch } },
    repository: { full_name: world.repo },
  }),
  comment: (number: number, c: Comment, onPull = false, repo = REPO) => ({
    action: "created",
    comment: { id: c.id, body: c.body },
    issue: { number, ...(onPull ? { pull_request: {} } : {}) },
    repository: { full_name: repo },
  }),
  prClosed: (world: World, number: number) => ({
    action: "closed",
    pull_request: { number, head: { ref: world.pulls.get(number)!.branch } },
    repository: { full_name: world.repo },
  }),
};

/** Results a well-behaved step would write. */
export const results = {
  triage: (run: string, duplicates: { url: string; reason: string }[] = []) => ({
    [`.factory/${run}/triage.json`]: JSON.stringify({ duplicates, related: [], summary: "Nothing similar." }),
  }),
  spec: (run: string, grade: 0 | 1 | 2) => ({
    [`specs/${run}.md`]: `# Spec ${grade}`,
    [`.factory/${run}/spec.json`]: JSON.stringify({
      grades: [{ id: "problem", weight: 3, grade: 2, evidence: "" }, { id: "users", weight: 2, grade, evidence: "" }, { id: "scope", weight: 3, grade, evidence: "" }],
      questions: grade === 2 ? [] : [{ id: "users", text: "Who uses it?" }],
      assumptions: grade === 2 ? [] : [{ id: "users", text: "Admins." }],
    }),
  }),
  plan: (run: string) => ({ [`design/${run}.md`]: "# Plan", [`.factory/${run}/plan.json`]: '{"summary":"Plan."}' }),
  implement: (run: string, n = 1) => ({ [`src/feature${n}.ts`]: "export {}", [`.factory/${run}/implement.json`]: '{"summary":"Built it."}' }),
  verdict: (run: string, step: "review" | "verify", verdict: "pass" | "changes") => ({
    [`.factory/${run}/${step}.json`]: JSON.stringify({
      verdict,
      summary: `${step} ${verdict}`,
      findings: verdict === "pass" ? [] : [{ path: "src/feature1.ts", line: 1, severity: "major", body: "Handle the empty case." }],
    }),
  }),
};

/** Label an issue and deliver the webhook, so the run is at triage with an agent running. */
export async function startRun(world: World, ctx: Ctx, title = "Add CSV export"): Promise<{ issue: number; run: string }> {
  const issue = world.openIssue(title);
  world.label(issue, "alice", "factory:run");
  await deliver(ctx, "issues", hooks.labeled(world, issue, "factory:run"));
  return { issue, run: `f-${ctx.config.key}-${issue}` };
}

/** The one running agent for a run. */
export function agentFor(world: World, run: string) {
  const running = world.running().filter((a) => a.launch.branch === `factory/${run}`);
  assert.equal(running.length, 1, `expected one running agent for ${run}, found ${running.length}`);
  return running[0];
}

export async function finishStep(world: World, ctx: Ctx, run: string, files: Record<string, string>): Promise<void> {
  world.finish(agentFor(world, run).id, files);
  await tickAndDrain(ctx, world);
}

export async function comment(world: World, ctx: Ctx, number: number, login: string, body: string, onPull = false): Promise<void> {
  const c = world.say(number, login, body);
  await deliver(ctx, "issue_comment", hooks.comment(number, c, onPull, world.repo));
}

/** Drive a fresh run up to the spec gate. */
export async function toSpecGate(world: World, ctx: Ctx, title?: string) {
  const r = await startRun(world, ctx, title);
  await finishStep(world, ctx, r.run, results.triage(r.run));
  await finishStep(world, ctx, r.run, results.spec(r.run, 2));
  assert.equal((await ctx.store.getRun(r.run))!.stage, "awaiting_spec_approval");
  return r;
}

/** Slack posts the factory deduped through postOnce for a run. */
export async function slackPostCount(ctx: Ctx, runId: string): Promise<number> {
  return (await ctx.store.doc(runId))!.posts.filter((p) => p.startsWith("slack:")).length;
}

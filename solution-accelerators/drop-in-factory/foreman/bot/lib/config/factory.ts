/**
 * Validate factory.yaml. This is the one definition of its shape: every key is
 * required unless marked optional, and an unknown key is an error. It imports
 * no packages: a hosted deployment installs only agents/foreman's, so the YAML
 * parser lives with each caller (load.ts for the scripts).
 */

import type { StepDef } from "../steps/define.ts";

export interface Gate {
  /** The gate's name in steps: (`gate: spec`). Its stage is awaiting_<name>_approval. */
  name: string;
  enabled: boolean;
  approvers: string[];
  approveLabel: string;
  changesLabel: string;
}

/**
 * One repository's resolved config: its own entry from `repos:` merged over
 * the shared keys. The pipeline reads only this.
 */
export interface FactoryConfig {
  repo: string;
  /** Short name in run ids (f-<key>-<issue>). `gh` for the single-repo shape. */
  key: string;
  /** What the repository holds, in a sentence. Picks the repository for a Slack request that doesn't name one. */
  description: string | null;
  base: string;
  intakeLabel: string;
  /** The pipeline, in order: each step folder that runs, and the gates between them. */
  steps: Entry[];
  /** The gates in steps, by name. */
  gates: Record<string, Gate>;
  slack: SlackConfig | null;
  /** Shared by every repository: who Foreman's own GitHub posts come from. */
  github: { identity: GitHubIdentity };
  /** Shared: the bot logins whose pull request findings send work back. */
  review: { bots: string[] };
  dora: {
    deploySource: "deployments" | "merges";
    environment: string;
    hotfixLabels: string[];
    incidentLabel: string;
    weeks: number;
  };
  /** Shared by every repository: how many runs may be past intake at once. */
  limits: Limits;
}

export type Entry = { step: StepDef; gate?: never } | { gate: Gate; step?: never };

export type GitHubIdentity = "app" | "bot-user" | "personal";
export const GITHUB_IDENTITIES: GitHubIdentity[] = ["app", "bot-user", "personal"];

export interface SlackConfig {
  channel: string;
  testerBot: string | null;
  /** Slack user ids who may approve, send back or abandon from Slack, besides the person who made the request. */
  approvers: string[];
  /** Emoji names, without colons. */
  reactions: { approve: string; reject: string; abandon: string };
}

export const DEFAULT_REACTIONS: SlackConfig["reactions"] = { approve: "white_check_mark", reject: "x", abandon: "wastebasket" };
export const DEFAULT_REVIEW_BOTS = ["cursor"];

export interface Limits {
  runsPerRepo: number;
  runsTotal: number;
}

/** The optional dashboard app Foreman pushes runs to. The ingest secret is SA_PORTAL_INGEST_SECRET, never here. */
export interface Dashboard {
  enabled: boolean;
  /** Where the portal listens; null means SA_PORTAL_URL. */
  url: string | null;
}

/** Everything factory.yaml describes: one resolved config per repository. */
export interface Factory {
  repos: FactoryConfig[];
  limits: Limits;
  dashboard: Dashboard;
}

export const DEFAULT_LIMITS: Limits = { runsPerRepo: 3, runsTotal: 6 };
export const DEFAULT_DASHBOARD: Dashboard = { enabled: true, url: null };

export class ConfigError extends Error {}

/** The repository a webhook, a run or a command names, by owner/name or key. */
export function repoConfig(factory: Factory, repoOrKey: string): FactoryConfig | null {
  return factory.repos.find((r) => r.repo === repoOrKey || r.key === repoOrKey) ?? null;
}

const SHARED = ["intakeLabel", "steps", "dora"];

/** Keys earlier versions had, and where they went. */
const MOVED: Record<string, string> = {
  agents: "Each step's model and deadline are in foreman/bot/subagents/<step>/agent.ts now.",
  pm: "The spec step's threshold and maxRounds are in foreman/bot/subagents/spec/agent.ts now.",
  gates: "Gates are entries in steps: now, like `- gate: spec` with approvers.",
  stages: "Turn a step off by removing it from steps: now.",
};
const REPO_KEYS = ["repo", "base"];
const REPO_OPTIONAL = ["key", "description", "intakeLabel", "gates", "slack"];

/** factory.yaml checked against the step folders in `catalog` (CATALOG in steps/catalog.ts). */
export function parseFactory(doc: unknown, catalog: ReadonlyMap<string, StepDef>): Factory {
  if (typeof doc === "object" && doc !== null) {
    for (const key of Object.keys(MOVED)) if (key in doc) throw new ConfigError(`factory.yaml.${key} is no longer a factory.yaml key. ${MOVED[key]} See docs/customize.md.`);
  }
  const top = object(doc, "factory.yaml", SHARED, ["repo", "base", "repos", "slack", "limits", "dashboard", "github", "review"]);
  const single = top.repo !== undefined || top.base !== undefined;
  if (single && top.repos !== undefined) throw new ConfigError("factory.yaml has both repo and repos. Use repos: for several repositories, or repo: and base: for one.");
  if (!single && top.repos === undefined) throw new ConfigError("factory.yaml.repos is missing (or repo: and base: for a single repository).");

  let limits = DEFAULT_LIMITS;
  if (top.limits !== undefined) {
    const l = object(top.limits, "limits", ["runsPerRepo", "runsTotal"]);
    limits = { runsPerRepo: count(l.runsPerRepo, "limits.runsPerRepo"), runsTotal: count(l.runsTotal, "limits.runsTotal") };
  }
  let dashboard = DEFAULT_DASHBOARD;
  if (top.dashboard !== undefined) {
    const d = object(top.dashboard, "dashboard", ["enabled"], ["url"]);
    const url = d.url === undefined ? null : text(d.url, "dashboard.url");
    if (url !== null && !/^https?:\/\/[^\s/]+/.test(url)) throw new ConfigError(`dashboard.url must be an http(s) URL. It is ${url}.`);
    dashboard = { enabled: flag(d.enabled, "dashboard.enabled"), url };
  }
  let github: FactoryConfig["github"] = { identity: "personal" };
  if (top.github !== undefined) {
    const g = object(top.github, "github", ["identity"]);
    const identity = text(g.identity, "github.identity");
    if (!GITHUB_IDENTITIES.includes(identity as GitHubIdentity)) throw new ConfigError(`github.identity must be ${GITHUB_IDENTITIES.join(", ")}. It is ${identity}.`);
    github = { identity: identity as GitHubIdentity };
  }
  let review: FactoryConfig["review"] = { bots: DEFAULT_REVIEW_BOTS };
  if (top.review !== undefined) {
    const r = object(top.review, "review", ["bots"]);
    if (!Array.isArray(r.bots)) throw new ConfigError("review.bots must be a list (it may be empty).");
    review = { bots: r.bots.map((b, i) => text(b, `review.bots[${i}]`).replace(/\[bot\]$/, "").toLowerCase()) };
  }
  const shared = sharedConfig(top, catalog);
  const defaultSlack = top.slack === undefined ? null : slackBlock(top.slack, "slack", true);

  const entries: { where: string; doc: Record<string, unknown> }[] = single
    ? [{ where: "factory.yaml", doc: { repo: top.repo, base: top.base, key: "gh" } }]
    : list(top.repos, "repos").map((doc, i) => ({ where: `repos[${i}]`, doc: object(doc, `repos[${i}]`, REPO_KEYS, REPO_OPTIONAL) }));

  const repos = entries.map(({ where, doc: e }) => {
    const repo = text(e.repo, `${where}.repo`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ConfigError(`${where}.repo must be owner/name. It is ${repo}.`);
    const key = e.key === undefined ? repo.split("/")[1].toLowerCase().replace(/[^a-z0-9-]/g, "-") : text(e.key, `${where}.key`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new ConfigError(`${where}.key must be lowercase letters, digits and dashes. It is ${key}.`);
    const slack = e.slack === undefined ? defaultSlack : slackBlock(e.slack, `${where}.slack`, false, defaultSlack);
    const config: FactoryConfig = {
      ...shared,
      repo,
      key,
      description: e.description === undefined ? null : text(e.description, `${where}.description`),
      base: text(e.base, `${where}.base`),
      intakeLabel: e.intakeLabel === undefined ? shared.intakeLabel : text(e.intakeLabel, `${where}.intakeLabel`),
      ...(e.gates === undefined ? {} : gateOverrides(e.gates, `${where}.gates`, shared.steps)),
      slack,
      github,
      review,
      limits,
    };
    return config;
  });
  for (const field of ["repo", "key"] as const) {
    const seen = new Set<string>();
    for (const r of repos) {
      if (seen.has(r[field])) throw new ConfigError(`repos has ${r[field]} twice; each ${field} must be unique.`);
      seen.add(r[field]);
    }
  }
  return { repos, limits, dashboard };
}

function sharedConfig(root: Record<string, unknown>, catalog: ReadonlyMap<string, StepDef>): Omit<FactoryConfig, "repo" | "key" | "description" | "base" | "slack" | "limits" | "github" | "review"> {
  const steps = stepsList(root.steps, catalog);
  const dora = object(root.dora, "dora", ["deploySource", "environment", "hotfixLabels", "incidentLabel", "weeks"]);
  const deploySource = text(dora.deploySource, "dora.deploySource");
  if (deploySource !== "deployments" && deploySource !== "merges") {
    throw new ConfigError(`dora.deploySource must be deployments or merges. It is ${deploySource}.`);
  }

  return {
    intakeLabel: text(root.intakeLabel, "intakeLabel"),
    steps,
    gates: gatesOf(steps),
    dora: {
      deploySource,
      environment: text(dora.environment, "dora.environment"),
      hotfixLabels: texts(dora.hotfixLabels, "dora.hotfixLabels"),
      incidentLabel: text(dora.incidentLabel, "dora.incidentLabel"),
      weeks: count(dora.weeks, "dora.weeks"),
    },
  };
}

/** Stage names a step folder can't take. */
const RESERVED = new Set(["intake", "awaiting_clarification", "awaiting_merge", "done", "closed", "abandoned"]);

/**
 * The steps: list. Each item is a step folder's name, or a gate after a step:
 * `{ gate: <name>, approvers, approveLabel?, changesLabel?, enabled? }`.
 */
function stepsList(value: unknown, catalog: ReadonlyMap<string, StepDef>): Entry[] {
  const items = list(value, "steps");
  const entries: Entry[] = [];
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const where = `steps[${i}]`;
    if (typeof item === "string") {
      const step = catalog.get(item);
      if (step === undefined) throw new ConfigError(`${where} is ${item}, but there is no step folder foreman/bot/subagents/${item}/. The folders are: ${[...catalog.keys()].join(", ")}.`);
      if (RESERVED.has(item) || item.startsWith("awaiting_")) throw new ConfigError(`${where}: ${item} is a stage name Foreman uses itself; rename the folder.`);
      if (seen.has(item)) throw new ConfigError(`${where}: ${item} is in steps twice.`);
      seen.add(item);
      entries.push({ step });
      return;
    }
    const g = object(item, where, ["gate", "approvers"], ["approveLabel", "changesLabel", "enabled"]);
    const name = text(g.gate, `${where}.gate`);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new ConfigError(`${where}.gate must be lowercase letters, digits and dashes. It is ${name}.`);
    if (seen.has(`gate:${name}`)) throw new ConfigError(`${where}: the gate ${name} is in steps twice.`);
    if (entries.length === 0 || entries.at(-1)!.gate !== undefined) throw new ConfigError(`${where}: a gate goes right after the step whose work it approves.`);
    seen.add(`gate:${name}`);
    entries.push({
      gate: {
        name,
        enabled: g.enabled === undefined ? true : flag(g.enabled, `${where}.enabled`),
        approvers: texts(g.approvers, `${where}.approvers`),
        approveLabel: g.approveLabel === undefined ? `factory:${name}-approved` : text(g.approveLabel, `${where}.approveLabel`),
        changesLabel: g.changesLabel === undefined ? `factory:${name}-changes` : text(g.changesLabel, `${where}.changesLabel`),
      },
    });
  });
  const kinds = entries.flatMap((e) => (e.step === undefined ? [] : [e.step.settings.kind]));
  for (const once of ["triage", "spec"] as const) {
    if (kinds.filter((k) => k === once).length > 1) throw new ConfigError(`steps has two ${once} steps; it may have one.`);
  }
  const firstChange = kinds.indexOf("change");
  if (firstChange === -1) throw new ConfigError("steps needs a change step (implement), where the code is written.");
  const early = entries.filter((e) => e.step !== undefined).find((e, i) => e.step!.settings.kind === "verdict" && i < firstChange);
  if (early !== undefined) throw new ConfigError(`steps: ${early.step!.id} checks a change, so it goes after a change step such as implement.`);
  return entries;
}

function gatesOf(steps: Entry[]): Record<string, Gate> {
  return Object.fromEntries(steps.flatMap((e) => (e.gate === undefined ? [] : [[e.gate.name, e.gate]])));
}

/** The top-level slack block, or a repository's, which may set only its own channel. */
function slackBlock(value: unknown, where: string, top: boolean, inherit: FactoryConfig["slack"] = null): FactoryConfig["slack"] {
  const block = object(value, where, ["channel"], top ? ["testerBot", "approvers", "reactions"] : []);
  const channel = text(block.channel, `${where}.channel`);
  if (!/^[CG][A-Z0-9]+$/.test(channel)) throw new ConfigError(`${where}.channel must be a channel id (C...). It is ${channel}.`);
  let testerBot: string | null = inherit?.testerBot ?? null;
  if (block.testerBot !== undefined) {
    testerBot = text(block.testerBot, `${where}.testerBot`);
    if (!/^B[A-Z0-9]+$/.test(testerBot)) throw new ConfigError(`${where}.testerBot must be one bot id (B...). It is ${testerBot}.`);
  }
  let approvers = inherit?.approvers ?? [];
  if (block.approvers !== undefined) {
    if (!Array.isArray(block.approvers)) throw new ConfigError(`${where}.approvers must be a list of Slack user ids (U...).`);
    approvers = block.approvers.map((a, i) => text(a, `${where}.approvers[${i}]`));
    const bad = approvers.find((a) => !/^[UW][A-Z0-9]+$/.test(a));
    if (bad !== undefined) throw new ConfigError(`${where}.approvers must be Slack user ids (U...). ${bad} is not one.`);
  }
  let reactions = inherit?.reactions ?? DEFAULT_REACTIONS;
  if (block.reactions !== undefined) {
    const r = object(block.reactions, `${where}.reactions`, [], ["approve", "reject", "abandon"]);
    const emoji = (name: "approve" | "reject" | "abandon") => (r[name] === undefined ? DEFAULT_REACTIONS[name] : text(r[name], `${where}.reactions.${name}`).replace(/^:|:$/g, ""));
    reactions = { approve: emoji("approve"), reject: emoji("reject"), abandon: emoji("abandon") };
  }
  return { channel, testerBot, approvers, reactions };
}

/** A repository's gates: any field it sets replaces the shared one. */
function gateOverrides(value: unknown, where: string, shared: Entry[]): Pick<FactoryConfig, "steps" | "gates"> {
  const names = shared.flatMap((e) => (e.gate === undefined ? [] : [e.gate.name]));
  const doc = object(value, where, [], names);
  const steps = shared.map((e): Entry => {
    if (e.gate === undefined || doc[e.gate.name] === undefined) return e;
    const name = e.gate.name;
    const base = e.gate;
    const g = object(doc[name], `${where}.${name}`, [], ["enabled", "approvers", "approveLabel", "changesLabel"]);
    return {
      gate: {
        name,
        enabled: g.enabled === undefined ? base.enabled : flag(g.enabled, `${where}.${name}.enabled`),
        approvers: g.approvers === undefined ? base.approvers : texts(g.approvers, `${where}.${name}.approvers`),
        approveLabel: g.approveLabel === undefined ? base.approveLabel : text(g.approveLabel, `${where}.${name}.approveLabel`),
        changesLabel: g.changesLabel === undefined ? base.changesLabel : text(g.changesLabel, `${where}.${name}.changesLabel`),
      },
    };
  });
  return { steps, gates: gatesOf(steps) };
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new ConfigError(`${where} must be a non-empty list.`);
  return value;
}

function object(value: unknown, where: string, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(`${where} must be a mapping.`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key) && !optional.includes(key)) throw new ConfigError(`${where}.${key} is not a factory.yaml key.`);
  }
  for (const key of keys) {
    if (record[key] === undefined) throw new ConfigError(`${where}.${key} is missing.`);
  }
  return record;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`${where} must be a non-empty string.`);
  return value;
}

function texts(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ConfigError(`${where} must be a non-empty list.`);
  return value.map((item, i) => text(item, `${where}[${i}]`));
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ConfigError(`${where} must be a whole number of at least 1.`);
  return value;
}

function flag(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${where} must be true or false.`);
  return value;
}

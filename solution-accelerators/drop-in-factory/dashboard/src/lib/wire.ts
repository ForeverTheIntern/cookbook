/**
 * What Foreman pushes to POST /api/ingest (docs/portal-api.md). The portal
 * reads these fields and stores the whole document as sent, so fields Foreman
 * adds later are kept without a portal change.
 */

export const PORTAL_SCHEMA = 1;

export interface WireRun {
  id: string;
  repo: string;
  issue: number;
  title: string;
  stage: string;
  stageSince: string;
  sendBacks: number;
  pr: number | null;
  hold: string | null;
  blocked: string | null;
  createdAt: string;
  closedAt: string | null;
  rev: number;
}

export interface WireTransition {
  seq: number;
  stage: string;
  at: string;
  reason: string;
  actor: string | null;
}

export interface WireRole {
  agentId: string;
  role: string;
  visit: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  url: string;
  costCents: number | null;
  costState: "settling" | "final" | null;
  costCheckedAt: string | null;
}

export interface WireDoc {
  run: WireRun;
  transitions: WireTransition[];
  roles: WireRole[];
}

export interface RunMessage {
  schema: number;
  factoryId: string;
  kind: "run";
  doc: WireDoc;
}

export interface HeartbeatMessage {
  schema: number;
  factoryId: string;
  kind: "heartbeat";
  at: string;
  version: string;
  repos: string[];
  openCount: number;
  runs: { id: string; rev: number }[];
}

/** `npm run doctor` sends this to check the URL and secret. Nothing is stored. */
export interface ProbeMessage {
  schema: number;
  factoryId: string;
  kind: "probe";
}

export type IngestMessage = RunMessage | HeartbeatMessage | ProbeMessage;

const isString = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isTime = (v: unknown) => isString(v) && !Number.isNaN(Date.parse(v));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The reason a message is refused, or null when it is well formed. */
export function invalid(body: unknown): string | null {
  if (!isObject(body)) return "body must be a JSON object";
  if (body.schema !== PORTAL_SCHEMA) return `schema must be ${PORTAL_SCHEMA}; got ${JSON.stringify(body.schema)}`;
  if (!isString(body.factoryId) || body.factoryId === "") return "factoryId is required";
  if (body.kind === "run") {
    const doc = body.doc;
    if (!isObject(doc) || !isObject(doc.run) || !Array.isArray(doc.transitions) || !Array.isArray(doc.roles)) return "doc needs run, transitions and roles";
    const run = doc.run;
    if (!isString(run.id) || !isString(run.repo) || !isInt(run.issue) || !isString(run.title) || !isString(run.stage)) return "run needs id, repo, issue, title and stage";
    if (!isInt(run.rev) || !isTime(run.createdAt) || !isTime(run.stageSince)) return "run needs rev, createdAt and stageSince";
    if (run.closedAt !== null && !isTime(run.closedAt)) return "run.closedAt must be a time or null";
    for (const t of doc.transitions) if (!isObject(t) || !isInt(t.seq) || !isString(t.stage) || !isTime(t.at) || !isString(t.reason)) return "each transition needs seq, stage, at and reason";
    for (const r of doc.roles) if (!isObject(r) || !isString(r.agentId) || !isString(r.role) || !isTime(r.startedAt) || !isString(r.url)) return "each role needs agentId, role, startedAt and url";
    return null;
  }
  if (body.kind === "heartbeat") {
    if (!isTime(body.at) || !isString(body.version) || !isInt(body.openCount)) return "heartbeat needs at, version and openCount";
    if (!Array.isArray(body.repos) || !body.repos.every(isString)) return "heartbeat.repos must be a list of owner/name";
    if (!Array.isArray(body.runs) || !body.runs.every((r) => isObject(r) && isString(r.id) && isInt(r.rev))) return "heartbeat.runs must be a list of { id, rev }";
    return null;
  }
  if (body.kind === "probe") return null;
  return `kind must be "run", "heartbeat" or "probe"; got ${JSON.stringify(body.kind)}`;
}

/**
 * The one launcher for every role. A role is a Cursor cloud agent started on
 * the run branch with the role prompt plus the run context. The Cloud Agents
 * API key is an argument; this file does not read the environment.
 *
 * Completion is not pushed to us: the worker's tick calls `agentStatus` for
 * each running role and queues `role:<agent id>:<status>` when it is terminal.
 */

const API = "https://api.cursor.com/v0";

export type AgentStatus = "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "EXPIRED";

export const TERMINAL: ReadonlySet<AgentStatus> = new Set(["FINISHED", "ERROR", "EXPIRED"]);

export interface Launch {
  repo: string;
  branch: string;
  model: string;
  prompt: string;
}

export interface AgentState {
  id: string;
  status: AgentStatus;
  branch: string;
  summary: string;
  url: string;
}

export async function launchAgent(apiKey: string, launch: Launch): Promise<AgentState> {
  const body = {
    prompt: { text: launch.prompt },
    model: launch.model,
    source: { repository: `https://github.com/${launch.repo}`, ref: launch.branch },
    target: { branchName: launch.branch, autoCreatePr: false },
  };
  return agentState(await call(apiKey, "POST", "/agents", body));
}

export async function agentStatus(apiKey: string, id: string): Promise<AgentState> {
  return agentState(await call(apiKey, "GET", `/agents/${id}`));
}

export async function stopAgent(apiKey: string, id: string): Promise<void> {
  await call(apiKey, "POST", `/agents/${id}/stop`);
}

async function call(apiKey: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Cloud Agents ${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  return text === "" ? {} : JSON.parse(text);
}

function agentState(value: unknown): AgentState {
  const row = value as {
    id?: string;
    status?: AgentStatus;
    summary?: string;
    target?: { branchName?: string; url?: string };
  };
  if (typeof row.id !== "string" || typeof row.status !== "string") {
    throw new Error(`Cloud Agents returned no id and status: ${JSON.stringify(value).slice(0, 200)}`);
  }
  return {
    id: row.id,
    status: row.status,
    branch: row.target?.branchName ?? "",
    summary: row.summary ?? "",
    url: row.target?.url ?? `https://cursor.com/agents/${row.id}`,
  };
}

/** Slack's limit for a file Foreman uploads; a bigger video is linked instead. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * An mp4 the agent saved as an artifact, as bytes: the one whose name is in
 * `hint` (the video link), else the newest mp4. Null when there is none or it
 * is over MAX_UPLOAD_BYTES. The download is a presigned URL the v1 API returns.
 */
export async function videoArtifact(apiKey: string, id: string, hint: string | null): Promise<{ name: string; data: Uint8Array } | null> {
  const auth = { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` };
  const listed = await fetch(`https://api.cursor.com/v1/agents/${id}/artifacts`, { headers: auth });
  if (!listed.ok) throw new Error(`Cloud Agents GET /v1/agents/${id}/artifacts returned ${listed.status}`);
  const items = ((await listed.json()) as { items?: { path: string; sizeBytes: number; updatedAt: string }[] }).items ?? [];
  const pick = pickVideo(items, hint);
  if (pick === null || pick.sizeBytes > MAX_UPLOAD_BYTES) return null;
  const link = await fetch(`https://api.cursor.com/v1/agents/${id}/artifacts/download?path=${encodeURIComponent(pick.path)}`, { headers: auth });
  if (!link.ok) throw new Error(`Cloud Agents artifact download for ${pick.path} returned ${link.status}`);
  const file = await fetch(((await link.json()) as { url: string }).url);
  if (!file.ok) throw new Error(`the artifact store returned ${file.status} for ${pick.path}`);
  return { name: pick.path.split("/").at(-1)!, data: new Uint8Array(await file.arrayBuffer()) };
}

/** The mp4 named in `hint`, else the newest mp4. */
export function pickVideo<T extends { path: string; updatedAt: string }>(items: T[], hint: string | null): T | null {
  const videos = items.filter((i) => /\.mp4$/i.test(i.path));
  const decoded = hint === null ? "" : decodeURIComponent(hint);
  const named = videos.find((v) => decoded.includes(v.path.split("/").at(-1)!));
  return named ?? [...videos].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

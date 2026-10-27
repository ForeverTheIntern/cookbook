/**
 * Slack Web API for the worker's posts, reactions and uploads, and for
 * Foreman's mention allowlist. The token is an argument. `text` is the
 * notification and screen-reader fallback; `blocks` (slack/blocks.ts) is what
 * people see. Nothing here carries hidden markers, because posts are deduped
 * in the store's posts table.
 */

/** Block Kit blocks, as Slack's JSON. */
export type Blocks = Record<string, unknown>[];

export interface Slack {
  token: string;
}

/** A Slack Web API error, with its code (`message_not_found`, `ratelimited`, ...) and Retry-After for a rate limit. */
export class SlackError extends Error {
  readonly method: string;
  readonly code: string;
  readonly retryAfterS: number;
  constructor(method: string, code: string, retryAfterS = 0) {
    super(`Slack ${method} failed: ${code}`);
    this.method = method;
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

async function call(slack: Slack, method: string, body: Record<string, string>): Promise<any> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${slack.token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return check(method, response);
}

async function check(method: string, response: Response): Promise<any> {
  if (response.status === 429) throw new SlackError(method, "ratelimited", Number(response.headers.get("retry-after") ?? "30"));
  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) throw new SlackError(method, result.error ?? `HTTP ${response.status}`);
  return result;
}

async function json(slack: Slack, method: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${slack.token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return check(method, response);
}

export async function postMessage(slack: Slack, channel: string, text: string, threadTs: string | null, blocks?: Blocks): Promise<string> {
  const body = await json(slack, "chat.postMessage", { channel, text, blocks, thread_ts: threadTs ?? undefined, unfurl_links: false, unfurl_media: false });
  return body.ts as string;
}

/** Replace a message the bot posted. */
export async function updateMessage(slack: Slack, channel: string, ts: string, text: string, blocks?: Blocks): Promise<void> {
  await json(slack, "chat.update", { channel, ts, text, blocks: blocks ?? [] });
}

/** The reactions on one message: emoji name and the user ids who added it. */
export async function reactionsOn(slack: Slack, channel: string, ts: string): Promise<{ name: string; users: string[] }[]> {
  const body = await call(slack, "reactions.get", { channel, timestamp: ts, full: "true" });
  return (body.message?.reactions ?? []).map((r: { name: string; users?: string[] }) => ({ name: r.name, users: r.users ?? [] }));
}

/** A person's display name, for records on GitHub. Falls back to the user id. */
export async function personName(slack: Slack, user: string): Promise<string> {
  const { user: info } = await call(slack, "users.info", { user });
  return info?.profile?.display_name || info?.real_name || info?.name || user;
}

/**
 * Upload a file into a thread so Slack shows it inline (its player, for a
 * video): reserve an upload URL, send the bytes, then complete it into the
 * thread with the message's text and blocks. Needs files:write.
 */
export async function uploadFile(slack: Slack, channel: string, threadTs: string, file: { name: string; data: Uint8Array }, text: string, blocks?: Blocks): Promise<void> {
  const reserved = await call(slack, "files.getUploadURLExternal", { filename: file.name, length: String(file.data.byteLength) });
  const sent = await fetch(reserved.upload_url, { method: "POST", body: new Blob([file.data as Uint8Array<ArrayBuffer>]) });
  if (!sent.ok) throw new SlackError("files upload", `HTTP ${sent.status}`);
  await call(slack, "files.completeUploadExternal", {
    files: JSON.stringify([{ id: reserved.file_id, title: file.name }]),
    channel_id: channel,
    thread_ts: threadTs,
    ...(blocks === undefined ? { initial_comment: text } : { blocks: JSON.stringify(blocks) }),
  });
}

/**
 * The people (not bots, not deactivated) in a channel, as user ids. Foreman
 * admits app-attributed mentions from these ids: Slack stamps a `bot_id` on
 * anything a person posts through an app's user token (a test harness, a
 * workflow, another client), and BDK drops bot-stamped mentions unless their
 * author is on `engagement.botMentions.allowFrom`.
 */
export async function channelPeople(slack: Slack, channel: string): Promise<string[]> {
  const members: string[] = [];
  let cursor = "";
  do {
    const page = await call(slack, "conversations.members", { channel, limit: "200", ...(cursor === "" ? {} : { cursor }) });
    members.push(...page.members);
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor !== "");
  const people: string[] = [];
  for (const user of members) {
    const { user: info } = await call(slack, "users.info", { user });
    if (!info.is_bot && !info.deleted && info.id !== "USLACKBOT") people.push(info.id);
  }
  return people;
}

/** `engagement.botMentions` for Foreman, or undefined when nobody needs admitting. */
export function mentionAllowlist(testerBot: string | null, people: string[]): { allowFrom: string[]; maxPerThreadPerHour: number; maxPerThreadTotal: number } | undefined {
  const allowFrom = [...(testerBot === null ? [] : [testerBot]), ...people];
  return allowFrom.length === 0 ? undefined : { allowFrom, maxPerThreadPerHour: 30, maxPerThreadTotal: 200 };
}

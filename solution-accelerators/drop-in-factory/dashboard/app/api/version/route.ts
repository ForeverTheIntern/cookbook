import { db } from "../../../src/lib/db.ts";

export const dynamic = "force-dynamic";

/**
 * The read model's ETag. Pages poll this every few seconds and refresh when it
 * moves: on any stored run, and on each heartbeat (so "last heard from" stays
 * current).
 */
export async function GET(request: Request) {
  const [row] = await (await db()).sql<{ runs: string | null; n: number; beat: string | null }>(
    `select (select max(received_at)::text from runs) as runs, (select count(*)::int from runs) as n, (select max(received_at)::text from heartbeats) as beat`,
  );
  const etag = `"${Buffer.from(`${row.runs}|${row.n}|${row.beat}`).toString("base64url")}"`;
  const headers = { etag, "cache-control": "no-store" };
  const sent = request.headers.get("if-none-match") ?? "";
  if (sent.split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers });
  return new Response(null, { status: 200, headers });
}

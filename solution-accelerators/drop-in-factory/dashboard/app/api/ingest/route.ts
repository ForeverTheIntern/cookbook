import { db } from "../../../src/lib/db.ts";
import { storeHeartbeat, storeRun } from "../../../src/lib/ingest.ts";
import { Verifier, type Verdict } from "../../../src/lib/signature.ts";
import { invalid, type IngestMessage } from "../../../src/lib/wire.ts";

export const dynamic = "force-dynamic";
const MAX_BYTES = 2_000_000;

const cache = globalThis as unknown as { factoryPortalVerifier?: Verifier };
const verifier = (cache.factoryPortalVerifier ??= new Verifier());

const REFUSED: Record<Exclude<Verdict, "ok">, [number, string]> = {
  unset: [503, "SA_PORTAL_INGEST_SECRET is not set on the portal"],
  missing: [401, "missing X-Factory-Timestamp or X-Factory-Signature"],
  stale: [401, "timestamp is more than 5 minutes from the portal's clock"],
  mismatch: [401, "signature does not match: the secrets on Foreman and the portal differ"],
  replay: [409, "this signed request was already received"],
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ ok: false, error: `body over ${MAX_BYTES} bytes` }, 413);
  const verdict = verifier.verify({
    secret: process.env.SA_PORTAL_INGEST_SECRET,
    timestamp: request.headers.get("x-factory-timestamp"),
    signature: request.headers.get("x-factory-signature"),
    body: text,
  });
  if (verdict !== "ok") {
    const [status, error] = REFUSED[verdict];
    return json({ ok: false, error }, status);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: "body is not JSON" }, 400);
  }
  const problem = invalid(body);
  if (problem !== null) return json({ ok: false, error: problem }, 400);
  const message = body as IngestMessage;
  if (message.kind === "probe") return json({ ok: true });
  const database = await db();
  if (message.kind === "run") return json({ ok: true, ...(await storeRun(database, message)) });
  return json({ ok: true, ...(await storeHeartbeat(database, message)) });
}

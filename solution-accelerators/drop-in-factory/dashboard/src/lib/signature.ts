/**
 * Foreman signs every push: `X-Factory-Timestamp` is Unix seconds, and
 * `X-Factory-Signature` is `v1=` + hex HMAC-SHA256 of `<timestamp>.<raw body>`
 * keyed with SA_PORTAL_INGEST_SECRET. A signature older or newer than
 * five minutes is refused, and one already seen inside that window is
 * refused as a replay. Pushes are idempotent anyway (rev guard), so a replay
 * across portal restarts, which this process cache cannot see, changes nothing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCE_S = 300;

export function sign(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export type Verdict = "ok" | "unset" | "missing" | "stale" | "mismatch" | "replay";

export class Verifier {
  #seen = new Map<string, number>();

  verify(input: { secret: string | undefined; timestamp: string | null; signature: string | null; body: string; now?: number }): Verdict {
    const secret = (input.secret ?? "").trim();
    if (secret === "") return "unset";
    if (input.timestamp === null || input.signature === null || !/^\d+$/.test(input.timestamp)) return "missing";
    const now = Math.floor((input.now ?? Date.now()) / 1000);
    const ts = Number(input.timestamp);
    if (Math.abs(now - ts) > TOLERANCE_S) return "stale";
    const expected = Buffer.from(sign(secret, ts, input.body));
    const given = Buffer.from(input.signature.trim());
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "mismatch";
    for (const [sig, at] of this.#seen) if (at < now - TOLERANCE_S) this.#seen.delete(sig);
    if (this.#seen.has(input.signature)) return "replay";
    this.#seen.set(input.signature, ts);
    return "ok";
  }
}

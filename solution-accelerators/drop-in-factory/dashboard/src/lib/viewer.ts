/**
 * Who may open the dashboard. SA_PORTAL_AUTH picks one of three:
 *
 * - none (default): no sign-in. Only for a portal bound to 127.0.0.1, which
 *   is what `npm run dev` does.
 * - basic: one shared login, SA_PORTAL_BASIC_AUTH="user:password". Serve
 *   it over HTTPS.
 * - proxy: the customer's SSO proxy (oauth2-proxy, Cloudflare Access, IAP)
 *   signs viewers in and passes who they are in SA_PORTAL_AUTH_HEADER.
 *   Only safe when the proxy is the sole route to the portal.
 *
 * POST /api/ingest is outside all three: it checks Foreman's HMAC signature.
 */

export type AuthMode = "none" | "basic" | "proxy";

export type Viewer = { ok: true; name: string | null; mode: AuthMode } | { ok: false; status: 401 | 500; reason: string; mode: AuthMode };

type Env = Record<string, string | undefined>;

export function authMode(env: Env = process.env): AuthMode | Error {
  const mode = (env.SA_PORTAL_AUTH ?? "").trim() || "none";
  if (mode === "none" || mode === "basic" || mode === "proxy") return mode;
  return new Error(`SA_PORTAL_AUTH must be none, basic or proxy; got "${mode}"`);
}

export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function viewerOf(headers: Headers, env: Env = process.env): Viewer {
  const mode = authMode(env);
  if (mode instanceof Error) return { ok: false, status: 500, reason: mode.message, mode: "none" };
  if (mode === "none") return { ok: true, name: null, mode };
  if (mode === "basic") {
    const expected = (env.SA_PORTAL_BASIC_AUTH ?? "").trim();
    if (!expected.includes(":")) return { ok: false, status: 500, reason: 'SA_PORTAL_BASIC_AUTH must be "user:password"', mode };
    const given = headers.get("authorization") ?? "";
    let decoded = "";
    try {
      decoded = given.startsWith("Basic ") ? atob(given.slice(6)) : "";
    } catch {
      decoded = "";
    }
    return sameText(decoded, expected) ? { ok: true, name: expected.split(":")[0], mode } : { ok: false, status: 401, reason: "sign in", mode };
  }
  const header = (env.SA_PORTAL_AUTH_HEADER ?? "").trim();
  if (header === "") return { ok: false, status: 500, reason: "SA_PORTAL_AUTH_HEADER must name the header your SSO proxy sets", mode };
  const who = headers.get(header)?.trim() ?? "";
  return who === "" ? { ok: false, status: 401, reason: `no ${header} header: open the dashboard through your sign-in proxy`, mode } : { ok: true, name: who, mode };
}

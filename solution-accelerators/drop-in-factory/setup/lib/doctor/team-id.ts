/**
 * The numeric team id behind a Cursor API key, for `npm run doctor` only.
 *
 * No documented Cursor API returns it: api.cursor.com/v0/me has the email and
 * key name, and `agent-sdk whoami --json` has the team name but not the id.
 * This module calls the account endpoints the agent-sdk CLI itself uses to
 * resolve a team (api2.cursor.sh: auth/exchange_user_api_key, then
 * DashboardService/GetMe). They are undocumented and may change without
 * notice, so the doctor calls them only when SA_EXPECTED_TEAM_ID is set, and
 * a failure here fails that one check. Nothing else in the factory calls them.
 */

export interface TeamId {
  id: string | null;
  error: string | null;
}

export async function teamIdOf(apiKey: string): Promise<TeamId> {
  try {
    const exchange = await fetch("https://api2.cursor.sh/auth/exchange_user_api_key", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    if (!exchange.ok) return { id: null, error: `team id lookup: account exchange returned ${exchange.status}` };
    const { accessToken } = (await exchange.json()) as { accessToken?: string };
    if (typeof accessToken !== "string" || accessToken === "") return { id: null, error: "team id lookup: account exchange returned no session" };
    const me = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    if (!me.ok) return { id: null, error: `team id lookup returned ${me.status}` };
    const body = (await me.json()) as { teamId?: number | string | null };
    return { id: body.teamId === undefined || body.teamId === null ? null : String(body.teamId), error: null };
  } catch (error) {
    return { id: null, error: `team id lookup: ${(error as Error).message}` };
  }
}

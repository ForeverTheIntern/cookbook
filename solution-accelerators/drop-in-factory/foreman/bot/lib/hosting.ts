import { factory } from "./runtime.ts";

/** The dashboard's host for hosting.egressDomains: dashboard.url's host when the dashboard is on and has one. */
export function dashboardHost(): string[] {
  const { dashboard } = factory().factory;
  if (!dashboard.enabled || dashboard.url === null) return [];
  const url = new URL(dashboard.url);
  return [url.port === "" || url.port === "443" ? url.hostname : url.host];
}

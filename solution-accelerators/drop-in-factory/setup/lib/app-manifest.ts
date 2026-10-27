/**
 * GitHub's App-manifest flow, for `npm run github-app`: a form posts the
 * manifest to GitHub, the person clicks "Create GitHub App", GitHub
 * redirects back with a code, and the code buys the app's id and private key.
 */

import { APP_PERMISSIONS } from "../../foreman/bot/lib/github/app.ts";

/** The manifest for Foreman's GitHub App: no webhook (events come through Cursor), only the permissions APP_PERMISSIONS lists. */
export function appManifest(input: { name: string; owner: string; redirectUrl: string }): Record<string, unknown> {
  return {
    name: input.name,
    url: `https://github.com/${input.owner}`,
    description: "Drop-in Software Factory: Foreman's own comments, reviews and labels.",
    hook_attributes: { url: "https://example.com/factory-webhooks-unused", active: false },
    redirect_url: input.redirectUrl,
    public: false,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
}

/** Where the manifest form posts: an organization's app settings, or the signed-in user's. */
export function newAppUrl(owner: string, isOrg: boolean, state: string): string {
  const base = isOrg ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new` : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}

/** The page that posts the manifest. */
export function manifestPage(action: string, manifest: Record<string, unknown>): string {
  const escaped = JSON.stringify(manifest).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><title>Create Foreman's GitHub App</title>
<body style="font-family: system-ui; max-width: 40rem; margin: 3rem auto">
<h1>Create Foreman's GitHub App</h1>
<p>This sends GitHub the app's settings: no webhook, and contents, issues and pull requests write with checks read. On the next page, check the name and click <b>Create GitHub App</b>.</p>
<form action="${action}" method="post"><input type="hidden" name="manifest" value="${escaped}"><button type="submit" style="font-size: 1.1rem; padding: .5rem 1rem">Continue to GitHub</button></form>
</body>`;
}

/** The code from what the person pasted: GitHub's whole redirect address, or just the code. */
export function manifestCode(pasted: string): string {
  const trimmed = pasted.trim();
  if (!/^https?:\/\//.test(trimmed)) return trimmed;
  const code = new URL(trimmed).searchParams.get("code");
  if (code === null || code === "") throw new Error("That address has no code= in it; paste the whole address GitHub sent the browser to");
  return code;
}

/** `text` (a .env file) with each key set to its value: an existing line is replaced, a missing one appended. */
export function setEnvValues(text: string, values: Record<string, string>): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (at === -1) lines.push(`${key}=${value}`);
    else lines[at] = `${key}=${value}`;
  }
  return `${lines.join("\n")}\n`;
}

/** A PEM as one `.env` line: line breaks become the two characters `\n`, which foreman/bot/lib/github/app.ts turns back. */
export function pemOneLine(pem: string): string {
  return pem.trim().replace(/\r?\n/g, "\\n");
}

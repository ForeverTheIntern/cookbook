/**
 * `npm run github-app`: create Foreman's GitHub App from a manifest, for
 * `github.identity: app`. Opens a local page that sends GitHub the app's
 * settings; after "Create GitHub App" GitHub redirects back here, and this
 * writes SA_GH_APP_ID and SA_GH_APP_PRIVATE_KEY into .env, then sends the
 * browser on to install the app on your repositories.
 *
 *   npm run github-app                       # owner from factory.yaml
 *   npm run github-app -- --owner your-org --name "Acme Factory" --port 8791
 *
 * When the browser can't reach this machine (a cloud agent, a remote shell):
 *
 *   npm run github-app -- --page github-app.html   # the person opens this file anywhere
 *   npm run github-app -- --code '<the address GitHub redirected to>'
 */

import "../foreman/bot/lib/config/dotenv.ts";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { pathsEnv, workerEnv } from "../foreman/bot/lib/config/env.ts";
import { loadFactory } from "../foreman/bot/lib/config/load.ts";
import { appManifest, manifestCode, manifestPage, newAppUrl, pemOneLine, setEnvValues } from "./lib/app-manifest.ts";

const factoryDir = fileURLToPath(new URL("..", import.meta.url));
const { values: args } = parseArgs({
  options: { owner: { type: "string" }, name: { type: "string" }, port: { type: "string", default: "8791" }, page: { type: "string" }, code: { type: "string" } },
});
const { repos } = loadFactory(resolve(factoryDir, pathsEnv().factoryConfig));
const owner = args.owner ?? repos[0].repo.split("/")[0];
const name = args.name ?? `${owner} factory`;
const port = Number(args.port);
const redirectUrl = `http://127.0.0.1:${port}/callback`;
const state = randomBytes(16).toString("hex");

/** Trades the one-time code (valid for an hour) for the app's id and key, writes them to .env, and returns the install page. */
async function convert(code: string): Promise<string> {
  const conversion = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "drop-in-factory" },
  });
  if (!conversion.ok) throw new Error(`GitHub refused the app code (${conversion.status}): ${(await conversion.text()).slice(0, 300)}`);
  const app = (await conversion.json()) as { id: number; slug: string; pem: string; html_url: string };
  const envFile = resolve(factoryDir, ".env");
  writeFileSync(envFile, setEnvValues(existsSync(envFile) ? readFileSync(envFile, "utf8") : "", { SA_GH_APP_ID: String(app.id), SA_GH_APP_PRIVATE_KEY: pemOneLine(app.pem) }), { mode: 0o600 });
  const install = `${app.html_url}/installations/new`;
  console.log(`Created ${app.slug} (app id ${app.id}); its posts will show as ${app.slug}[bot].`);
  console.log(`Wrote SA_GH_APP_ID and SA_GH_APP_PRIVATE_KEY to .env.`);
  console.log(`Next: install it on ${repos.map((r) => r.repo).join(", ")} at ${install},`);
  console.log(`then set github.identity: app in factory.yaml and run npm run doctor.`);
  return install;
}

if (args.code !== undefined) {
  await convert(manifestCode(args.code));
  process.exit(0);
}

const token = workerEnv().githubToken;
const who = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, {
  headers: { accept: "application/vnd.github+json", "user-agent": "drop-in-factory", ...(token === "" ? {} : { authorization: `Bearer ${token}` }) },
});
if (!who.ok) throw new Error(`GitHub has no user or organization ${owner} (${who.status}); pass --owner`);
const isOrg = ((await who.json()) as { type?: string }).type === "Organization";
const signedIn = isOrg ? `an owner of ${owner}` : owner;

if (args.page !== undefined) {
  writeFileSync(args.page, manifestPage(newAppUrl(owner, isOrg, state), appManifest({ name, owner, redirectUrl })));
  console.log(`Wrote ${args.page}. Open it in a browser signed in to GitHub as ${signedIn}, click Continue to GitHub, then Create GitHub App.`);
  console.log(`The browser then fails to load ${redirectUrl}; that's expected. Copy that whole address and run, within an hour:`);
  console.log(`  npm run github-app -- --code '<the address>'`);
  process.exit(0);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUrl);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(manifestPage(newAppUrl(owner, isOrg, state), appManifest({ name, owner, redirectUrl })));
    return;
  }
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get("state") !== state || url.searchParams.get("code") === null) {
    res.writeHead(400, { "content-type": "text/plain" }).end("This callback is not from the page this script opened. Start again.");
    return;
  }
  try {
    res.writeHead(302, { location: await convert(url.searchParams.get("code") ?? "") }).end();
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" }).end(String(err));
    console.error(String(err));
    process.exitCode = 1;
  }
  server.close();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Open http://127.0.0.1:${port}/ in a browser signed in to GitHub as ${signedIn}, and click Continue to GitHub.`);
});

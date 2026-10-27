import assert from "node:assert/strict";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { ConfigError } from "../../foreman/bot/lib/config/factory.ts";
import { identityLine, reviewBotsLine, slackScopesLine } from "../lib/doctor/report.ts";
import { appJwt, installationToken, missingPermissions } from "../../foreman/bot/lib/github/app.ts";
import { testConfig } from "../../foreman/tests/fakes.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test("the app JWT is RS256, issued a minute back, valid nine minutes, and verifies with the app's key", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const jwt = appJwt({ appId: "12345", privateKey: pem.replace(/\n/g, "\\n") }, now);
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, "12345");
  assert.equal(claims.iat, now / 1000 - 60);
  assert.equal(claims.exp - claims.iat, 600);
  const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(createPublicKey(privateKey), Buffer.from(signature, "base64url"));
  assert.equal(ok, true);
});

test("installation tokens are cached per owner and renewed five minutes before they expire", async () => {
  const calls: string[] = [];
  const real = globalThis.fetch;
  let minted = 0;
  globalThis.fetch = (async (url: string, init: { method: string }) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 7, permissions: {} }));
    minted += 1;
    return new Response(JSON.stringify({ token: `ghs_${minted}`, expires_at: "2026-10-25T13:00:00Z" }));
  }) as typeof fetch;
  try {
    const app = { appId: "999", privateKey: pem };
    const t0 = Date.parse("2026-10-25T12:00:00Z");
    assert.equal(await installationToken(app, "acme/app", t0), "ghs_1");
    assert.equal(await installationToken(app, "acme/other", t0 + 30 * 60_000), "ghs_1", "same owner, same token");
    assert.equal(await installationToken(app, "acme/app", t0 + 56 * 60_000), "ghs_2", "renewed with under five minutes left");
    assert.deepEqual(calls, ["GET /repos/acme/app/installation", "POST /app/installations/7/access_tokens", "GET /repos/acme/app/installation", "POST /app/installations/7/access_tokens"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("missing app permissions are named", () => {
  assert.deepEqual(missingPermissions({ contents: "write", issues: "write", pull_requests: "write", checks: "read", metadata: "read" }), []);
  assert.deepEqual(missingPermissions({ contents: "read", issues: "write", pull_requests: "write", metadata: "read" }), ["contents:write", "checks:read"]);
});

test("factory.yaml: github.identity defaults to personal and accepts app and bot-user; review.bots defaults to cursor", () => {
  assert.equal(testConfig().github.identity, "personal");
  assert.equal(testConfig((d) => (d.github = { identity: "app" })).github.identity, "app");
  assert.equal(testConfig((d) => (d.github = { identity: "bot-user" })).github.identity, "bot-user");
  assert.throws(() => testConfig((d) => (d.github = { identity: "robot" })), ConfigError);
  assert.deepEqual(testConfig((d) => delete d.review).review.bots, ["cursor"]);
  assert.deepEqual(testConfig((d) => (d.review = { bots: ["Cursor[bot]", "acme-security"] })).review.bots, ["cursor", "acme-security"]);
  assert.deepEqual(testConfig((d) => (d.review = { bots: [] })).review.bots, []);
});

test("doctor: the identity line names missing secrets, missing permissions and who Foreman posts as", () => {
  const facts = { login: "acme-factory[bot]", canWrite: true, missing: [] as string[], error: null };
  assert.match(identityLine("app", "acme/app", [], facts).text, /SA_GH_APP_ID and SA_GH_APP_PRIVATE_KEY must be set/);
  assert.equal(identityLine("app", "acme/app", ["SA_GH_APP_ID", "SA_GH_APP_PRIVATE_KEY"], { ...facts, missing: ["checks:read"] }).status, "fail");
  const ok = identityLine("app", "acme/app", ["SA_GH_APP_ID", "SA_GH_APP_PRIVATE_KEY"], facts);
  assert.equal(ok.status, "ok");
  assert.match(ok.text, /post as acme-factory\[bot\] through the factory GitHub App/);
  assert.match(identityLine("bot-user", "acme/app", [], facts).text, /SA_GH_BOT_TOKEN must be set/);
  assert.equal(identityLine("bot-user", "acme/app", ["SA_GH_BOT_TOKEN"], { ...facts, canWrite: false }).status, "fail");
  assert.match(identityLine("personal", "acme/app", [], { ...facts, login: "octocat" }).text, /post as octocat through the operator's own token/);
});

test("doctor: review bots and Slack scopes", () => {
  assert.equal(reviewBotsLine(["cursor"], ["cursor"]).status, "ok");
  assert.match(reviewBotsLine(["cursor", "nobody"], ["cursor"]).text, /no GitHub bot account nobody\[bot\]/);
  assert.equal(reviewBotsLine([], []).status, "info");
  assert.equal(slackScopesLine(["chat:write", "files:write", "reactions:read", "users:read", "channels:history"]).status, "ok");
  assert.match(slackScopesLine(["chat:write", "users:read"]).text, /lacks files:write, reactions:read/);
});

test("github-app: the manifest asks for no webhook and only Foreman's permissions; .env lines are set in place", async () => {
  const { appManifest, manifestCode, manifestPage, newAppUrl, pemOneLine, setEnvValues } = await import("../lib/app-manifest.ts");
  assert.equal(manifestCode("http://127.0.0.1:8791/callback?code=abc123&state=s1"), "abc123");
  assert.equal(manifestCode("  abc123\n"), "abc123");
  assert.throws(() => manifestCode("http://127.0.0.1:8791/callback?state=s1"), /no code=/);
  const m = appManifest({ name: "Acme factory", owner: "acme", redirectUrl: "http://127.0.0.1:8791/callback" }) as any;
  assert.equal(m.hook_attributes.active, false);
  assert.deepEqual(m.default_permissions, { contents: "write", issues: "write", pull_requests: "write", checks: "read", metadata: "read" });
  assert.equal(m.public, false);
  assert.equal(newAppUrl("acme", true, "s1"), "https://github.com/organizations/acme/settings/apps/new?state=s1");
  assert.equal(newAppUrl("octocat", false, "s1"), "https://github.com/settings/apps/new?state=s1");
  assert.match(manifestPage("https://github.com/x", m), /name="manifest" value="\{&quot;name&quot;:&quot;Acme factory&quot;/);
  const key = "RSA " + "PRIVATE KEY";
  const pem = `-----BEGIN ${key}-----\nabc\ndef\n-----END ${key}-----\n`;
  assert.equal(pemOneLine(pem), `-----BEGIN ${key}-----\\nabc\\ndef\\n-----END ${key}-----`);
  assert.equal(setEnvValues("GH_TOKEN=x\nSA_GH_APP_ID=\n", { SA_GH_APP_ID: "7", SA_GH_APP_PRIVATE_KEY: "k" }), "GH_TOKEN=x\nSA_GH_APP_ID=7\nSA_GH_APP_PRIVATE_KEY=k\n");
});

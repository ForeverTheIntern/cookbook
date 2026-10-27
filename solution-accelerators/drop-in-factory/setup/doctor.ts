/**
 * `npm run doctor`: check everything Foreman needs before the first run, with
 * the same environment Foreman will have, for every repository in
 * factory.yaml. Creates the factory's labels on a repository when they are
 * missing; changes nothing else.
 *
 *   npm run doctor                 # local
 *   npm run doctor -- --hosted     # also the hosted release and its secrets (or SA_VERIFY_HOSTED=1)
 *   npm run doctor -- --pids .factory/verify/pids.json   # ports may be held by these (or SA_VERIFY_PID_FILE)
 */

import "../foreman/bot/lib/config/dotenv.ts";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pathsEnv, shellEnv, verifyEnv, workerEnvChecked } from "../foreman/bot/lib/config/env.ts";
import { deployment, lastDeploy, readDeploys } from "./lib/doctor/deployed.ts";
import { accountOf, githubLogin, modelIds, storedCliEmail, visibleRepositories, whoami, type Account } from "./lib/doctor/identity.ts";
import { listeners, processRows } from "./lib/doctor/ports.ts";
import {
  cliLine,
  deploySourceLine,
  expandPids,
  githubAppLine,
  hostedSecretsLine,
  identityLine,
  IDENTITY_SECRETS,
  keyOwnerLine,
  nodeLine,
  portsLine,
  reviewBotsLine,
  sameTeamLine,
  slackScopesLine,
  teamLine,
  type Line,
} from "./lib/doctor/report.ts";
import { appIdentity, installationFor, installationToken, missingPermissions } from "../foreman/bot/lib/github/app.ts";
import { ABANDONED_LABEL } from "../foreman/bot/lib/pipeline/reconcile.ts";
import { portalSetting, probe } from "../foreman/bot/lib/dashboard-push.ts";
import { loadFactory } from "../foreman/bot/lib/config/load.ts";
import { api, branchSha, type GitHub } from "../foreman/bot/lib/github/rest.ts";
import { sourceDigest } from "./lib/doctor/source.ts";
import { checkAdminKey } from "../foreman/bot/lib/metrics/facts.ts";
import { channelPeople } from "../foreman/bot/lib/slack/post.ts";

const factoryDir = fileURLToPath(new URL("..", import.meta.url));
let failed = 0;

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    console.log(`ok    ${name}: ${await run()}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}: ${(error as Error).message}`);
  }
}

report("node", nodeLine(process.version));
const { env, missing } = workerEnvChecked();
for (const name of missing) {
  failed += 1;
  console.log(`FAIL  environment: ${name} is not set. Put it in .env (see .env.example), then run the doctor again`);
}
const verify = settled("doctor settings", verifyEnv);
const factory = settled(pathsEnv().factoryConfig, () => loadFactory(resolve(factoryDir, pathsEnv().factoryConfig)));
const { repos } = factory;
const config = repos[0];
console.log(`ok    environment and ${pathsEnv().factoryConfig} (${repos.length} ${repos.length === 1 ? "repository" : "repositories"}: ${repos.map((r) => r.repo).join(", ")})`);

await check("event repositories", async () => {
  const owners = [...new Set(repos.map((r) => r.repo.split("/")[0].toLowerCase()))];
  if (owners.length > 1) throw new Error(`Cursor events reach one Foreman from one GitHub owner, and factory.yaml names ${owners.join(", ")}. Run one Foreman per owner`);
  if (repos.length > 20) throw new Error(`Cursor events cover at most 20 repositories per Foreman, and factory.yaml has ${repos.length}`);
  return `${repos.length} under ${owners[0]}, within the 20-repository limit`;
});

for (const repo of repos) {
  const gh: GitHub = { token: env.githubToken, repo: repo.repo };
  await check(`${repo.key}: GitHub repository`, async () => {
    if (env.githubToken === "") throw new Error("skipped, because SA_GH_TOKEN (or GH_TOKEN) is not set");
    const found = await api(gh, "GET", `/repos/${repo.repo}`);
    if (found === null) throw new Error(`GH_TOKEN cannot see ${repo.repo}`);
    if (!found.permissions?.push) throw new Error(`GH_TOKEN cannot push to ${repo.repo}; it needs contents, issues and pull requests write`);
    if ((await branchSha(gh, repo.base)) === null) throw new Error(`base branch ${repo.base} does not exist`);
    return `${repo.repo} at ${repo.base}`;
  });

  await check(`${repo.key}: labels`, async () => {
    if (env.githubToken === "") throw new Error("skipped, because SA_GH_TOKEN (or GH_TOKEN) is not set");
    const wanted = [repo.intakeLabel, ...Object.values(repo.gates).flatMap((g) => [g.approveLabel, g.changesLabel]), ABANDONED_LABEL];
    const created: string[] = [];
    for (const name of wanted) {
      if ((await api(gh, "GET", `/repos/${repo.repo}/labels/${encodeURIComponent(name)}`)) !== null) continue;
      await api(gh, "POST", `/repos/${repo.repo}/labels`, { name, color: "f54e00" });
      created.push(name);
    }
    const present = `${wanted.length} of ${wanted.length} present`;
    return created.length === 0 ? `${present} (already on the repository)` : `${present} (created ${created.join(", ")})`;
  });

  report(`${repo.key}: factory identity`, await identityReport(repo.repo, repo.github.identity));

  await check(`${repo.key}: gh CLI`, async () => {
    if (env.githubToken === "") throw new Error("skipped, because SA_GH_TOKEN (or GH_TOKEN) is not set");
    const { stdout } = await promisify(execFile)("gh", ["api", `repos/${repo.repo}`, "--jq", ".full_name"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: env.githubToken },
    });
    return `reads ${stdout.trim()} (used for the issue timeline and Deployments)`;
  });
}

let launch: Account | null = null;
let launchError: string | null = null;
if (env.cursorApiKey === "") launchError = "skipped, because SA_CURSOR_API_KEY (or CURSOR_API_KEY) is not set";
else {
  try {
    launch = await accountOf(env.cursorApiKey, shellEnv(), verify.expectedTeamId !== "");
  } catch (error) {
    launchError = (error as Error).message;
  }
}

await check("Cloud Agents API", async () => {
  if (launch === null) throw new Error((launchError ?? "key was rejected").replace(/^key was rejected/, "CURSOR_API_KEY was rejected"));
  const models = await modelIds(env.cursorApiKey);
  const wanted = new Map(repos.flatMap((r) => r.steps.flatMap((e) => (e.step === undefined ? [] : [[e.step.settings.model, e.step.id] as const]))));
  const missing = [...wanted].filter(([m]) => !models.includes(m));
  if (missing.length > 0) throw new Error(`model ${missing.map(([m, step]) => `${m} (foreman/bot/subagents/${step}/agent.ts)`).join(", ")} is not available; pick from ${models.join(", ")}`);
  return `key accepted for ${launch.email ?? launch.apiKeyName} (${verify.launchKeys.map((key) => key.name).join(", ")}), every configured model is available`;
});

await check("GitHub App", async () => {
  if (launch === null) throw new Error((launchError ?? "key was rejected").replace(/^key was rejected/, "CURSOR_API_KEY was rejected"));
  const line = githubAppLine(repos.map((repo) => repo.repo), await visibleRepositories(env.cursorApiKey));
  if (line.status === "fail") throw new Error(line.text);
  return line.text;
});

report("ports", await portReport());

await check("CLI auth", async () => {
  if (launch?.email == null) throw new Error(launchError ?? "the launch key has no email to compare with the CLI");
  const session = await whoami(shellEnv());
  const line = cliLine({
    whoamiEmail: session.email,
    whoamiTeam: session.teamName,
    source: session.source,
    whoamiError: session.error,
    keyEmail: launch.email,
    storedEmail: storedCliEmail(verify.cliConfigPath),
    authTokenSet: verify.authTokenSet,
  });
  if (line.status === "fail") throw new Error(line.text);
  return line.text;
});

report("team", teamLine({
  id: launch?.teamId ?? null,
  name: launch?.teamName ?? null,
  error: launch?.teamError ?? launchError,
  expectedId: verify.expectedTeamId,
  expectedName: verify.expectedTeamName,
}));

for (const key of verify.launchKeys) {
  await check(`key ${key.name}`, async () => {
    const account = key.value === env.cursorApiKey && launch !== null ? launch : await accountOf(key.value, shellEnv(), verify.expectedTeamId !== "");
    const line = keyOwnerLine(account);
    if (launch?.email != null && account.email != null && account.email.toLowerCase() !== launch.email.toLowerCase()) {
      throw new Error(`${line.text}, which is not ${launch.email}, the key Foreman launches with`);
    }
    return line.text;
  });
}

for (const key of verify.githubKeys) {
  await check(`key ${key.name}`, async () => `belongs to ${await githubLogin(key.value)}`);
}

if (verify.serviceAccount.length === 0) console.log("note  CURSOR_SERVICE_ACCOUNT_KEY is not set, so a hosted deploy uses the CLI credential");
for (const key of verify.serviceAccount) {
  await check(`key ${key.name}`, async () => {
    const account = await accountOf(key.value, shellEnv(), verify.expectedTeamId !== "");
    const line = sameTeamLine(launch, { name: key.name, ...account });
    if (line.status === "fail") throw new Error(line.text);
    return line.text;
  });
}

await hostedReports();

const bots = [...new Set(repos.flatMap((r) => r.review.bots))];
await check("review bots", async () => {
  const found: string[] = [];
  for (const bot of bots) {
    if ((await api({ token: env.githubToken, repo: config.repo }, "GET", `/users/${encodeURIComponent(`${bot}[bot]`)}`)) !== null) found.push(bot);
  }
  const line = reviewBotsLine(bots, found);
  if (line.status === "fail") throw new Error(line.text);
  return line.text;
});

const channels = [...new Set(repos.flatMap((r) => (r.slack === null ? [] : [r.slack.channel])))];
for (const channel of channels) {
  const users = repos.filter((r) => r.slack?.channel === channel).map((r) => r.key);
  await check(`Slack ${channel} (${users.join(", ")})`, async () => {
    if (env.slackBotToken === "") throw new Error("factory.yaml has a slack block, so FOREMAN_SLACK_BOT_TOKEN must be set");
    const call = async (method: string, body: Record<string, string>) => {
      const response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.slackBotToken}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });
      const result = (await response.json()) as any;
      if (!result.ok) throw new Error(`${method}: ${result.error}`);
      return { ...result, scopes: (response.headers.get("x-oauth-scopes") ?? "").split(",").map((x: string) => x.trim()) };
    };
    const auth = await call("auth.test", {});
    const scopes = slackScopesLine(auth.scopes);
    if (scopes.status === "fail") throw new Error(scopes.text);
    const info = await call("conversations.info", { channel });
    if (!info.channel.is_member) throw new Error(`${auth.user} is not in #${info.channel.name}; invite it`);
    const people = await channelPeople({ token: env.slackBotToken }, channel);
    const shared = users.length > 1 ? `; shared by ${users.join(", ")}, so a request names one or Foreman picks it from their descriptions` : "";
    return `${auth.user} is in #${info.channel.name}, and answers @mentions from its ${people.length} people${shared}; ${scopes.text}`;
  });
}

await check("OTel collector", async () => {
  if (env.otlpEndpoint.trim() === "") {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT is empty, and the factory's metrics need a collector. Start one with docker compose -f setup/compose.yaml up -d and set OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 in .env");
  }
  let metricsUrl: URL;
  try {
    metricsUrl = new URL(`${env.otlpEndpoint.trim().replace(/\/$/, "")}/v1/metrics`);
  } catch {
    throw new Error(`OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL such as http://localhost:4318. It is ${env.otlpEndpoint}`);
  }
  const response = await fetch(metricsUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceMetrics: [] }),
  });
  if (!response.ok) throw new Error(`${env.otlpEndpoint} returned ${response.status}`);
  return `accepts OTLP at ${env.otlpEndpoint}`;
});

const dashboard = portalSetting(factory.dashboard);
if (dashboard.state === "off") console.log("info  dashboard: off (dashboard.enabled: false in factory.yaml); nothing is pushed");
else if (dashboard.state === "unconfigured") {
  failed += 1;
  console.log(`FAIL  dashboard: on, but ${dashboard.missing.join(" and ")} not set. Set them, or set dashboard.enabled: false in factory.yaml`);
} else {
  const { portal } = dashboard;
  const hostedLoopback = (verify.hosted || process.argv.includes("--hosted")) && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(portal.url).hostname);
  const reachable = hostedLoopback ? await probe(portal).then(() => true, () => false) : true;
  if (!reachable) {
    console.log(`info  dashboard: ${portal.url} isn't running here, and the hosted Foreman couldn't reach it anyway, so it pushes nothing (docs/reference.md, "The dashboard when hosted")`);
  } else {
    await check("dashboard", async () => {
      await probe(portal);
      return `${portal.url} is up and accepts the signed pushes`;
    });
  }
}

if (env.adminApiKey === "") console.log("note  CURSOR_ADMIN_API_KEY is not set, so invoice cost is not emitted (compute minutes still are)");
else await check("Admin API", () => checkAdminKey(env.adminApiKey, env.cursorApiKey));
process.exit(failed === 0 ? 0 : 1);

function report(name: string, line: Line): void {
  if (line.status === "info") {
    console.log(`info  ${name}: ${line.text}`);
    return;
  }
  if (line.status === "fail") {
    failed += 1;
    console.log(`FAIL  ${name}: ${line.text}`);
    return;
  }
  console.log(`ok    ${name}: ${line.text}`);
}

async function portReport(): Promise<Line> {
  try {
    const found = await listeners(verify.ports);
    let allowed: number[] | null = null;
    const pidsAt = process.argv.indexOf("--pids");
    const pidFile = pidsAt === -1 ? verify.pidFile : (process.argv[pidsAt + 1] ?? "");
    if (pidFile !== "") {
      const roots = pidRoots(pidFile);
      allowed = expandPids(roots, await processRows());
    }
    return portsLine(found, verify.portalPort, allowed);
  } catch (error) {
    return { status: "fail", text: (error as Error).message };
  }
}

function pidRoots(path: string): number[] {
  const body = JSON.parse(readFileSync(path, "utf8")) as { processes?: { pid: number }[] };
  return (body.processes ?? []).map((row) => row.pid).filter((pid) => Number.isInteger(pid));
}

/** A setting the rest of the doctor needs. When it cannot be read, say so and stop: nothing else can run. */
function settled<T>(name: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    console.log(`FAIL  ${name}: ${(error as Error).message}`);
    process.exit(1);
  }
}

/** Whether Foreman can post as `github.identity`: its secrets are set, it resolves to a login, and it can write to the repository. */
async function identityReport(repo: string, identity: "app" | "bot-user" | "personal"): Promise<Line> {
  const set = [env.appId === "" ? [] : ["SA_GH_APP_ID"], env.appPrivateKey === "" ? [] : ["SA_GH_APP_PRIVATE_KEY"], env.botToken === "" ? [] : ["SA_GH_BOT_TOKEN"]].flat();
  const facts = { login: null as string | null, canWrite: false, missing: [] as string[], error: null as string | null };
  try {
    if (IDENTITY_SECRETS[identity].every((name) => set.includes(name))) {
      let token = env.githubToken;
      if (identity === "app") {
        const app = { appId: env.appId, privateKey: env.appPrivateKey };
        facts.login = (await appIdentity(app)).login;
        facts.missing = missingPermissions((await installationFor(app, repo)).permissions);
        token = await installationToken(app, repo);
      } else {
        if (identity === "bot-user") token = env.botToken;
        facts.login = await githubLogin(token);
      }
      const found = await api({ token, repo }, "GET", `/repos/${repo}`);
      facts.canWrite = identity === "app" ? found !== null : found?.permissions?.push === true;
    }
  } catch (error) {
    facts.error = (error as Error).message;
  }
  return identityLine(identity, repo, set, facts);
}

async function hostedReports(): Promise<void> {
  const slug = verify.deploymentSlug;
  const off = { enabled: false, slug, error: null };
  if (!verify.hosted && !process.argv.includes("--hosted")) {
    report("hosted release", deploySourceLine({ ...off, record: null, liveReleaseId: null, headDigest: "" }));
    report("hosted secrets", hostedSecretsLine({ ...off, secretNames: null, required: [] }));
    return;
  }
  const identitySecrets = [...new Set(repos.flatMap((r) => IDENTITY_SECRETS[r.github.identity]))];
  const required = ["SA_GH_TOKEN", "SA_CURSOR_API_KEY", ...identitySecrets, ...(repos.some((r) => r.slack !== null) ? ["FOREMAN_SLACK_BOT_TOKEN"] : [])];
  try {
    const live = await deployment(slug, resolve(factoryDir, "foreman"), shellEnv());
    const record = lastDeploy(readDeploys(resolve(factoryDir, verify.deploysPath)), slug);
    const headDigest = await sourceDigest(factoryDir);
    report("hosted release", deploySourceLine({ enabled: true, slug, record, liveReleaseId: live.releaseId, headDigest, error: live.error }));
    report("hosted secrets", hostedSecretsLine({ enabled: true, slug, secretNames: live.error === null ? live.secretNames : null, required, error: live.error }));
  } catch (error) {
    report("hosted release", { status: "fail", text: (error as Error).message });
  }
}

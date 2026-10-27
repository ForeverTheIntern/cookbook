/**
 * Shared by Foreman's channels, tools and tick: the factory folder, its
 * config, and a Runtime over the durable host.kv the handler was given.
 * Nothing here reads a secret at module load: a hosted deployment receives
 * its secrets per request.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { pathsEnv, workerEnv } from "./config/env.ts";
import { parseFactory, type Factory, type FactoryConfig } from "./config/factory.ts";
import { installationToken } from "./github/app.ts";
import { adminUsage } from "./metrics/facts.ts";
import type { Runtime } from "./pipeline/dispatch.ts";
import { livePorts } from "./pipeline/ports.ts";
import type { Ctx } from "./pipeline/reconcile.ts";
import { portalFor } from "./dashboard-push.ts";
import type { Kv } from "./store/kv.ts";
import { migrateSqlite } from "./store/migrate.ts";
import { Store } from "./store/store.ts";
import { CATALOG } from "./steps/catalog.ts";

export const FACTORY_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const VERSION = (JSON.parse(readFileSync(resolve(FACTORY_DIR, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";

let loaded: Factory | null = null;

/** factory.yaml, loaded once per process. */
export function factory(): { factory: Factory; repos: FactoryConfig[] } {
  if (loaded === null) loaded = parseFactory(parse(readFileSync(resolve(FACTORY_DIR, pathsEnv().factoryConfig), "utf8")), CATALOG);
  return { factory: loaded, repos: loaded.repos };
}

/** The config of the repository a run belongs to. */
export function repoOf(repo: string): FactoryConfig {
  return factory().repos.find((r) => r.repo === repo) ?? factory().repos[0];
}

export interface Host {
  kv: Kv;
}

export const storeOf = (host: Host) => new Store(host.kv);

let migrated: Promise<unknown> | null = null;
const log = (line: string) => console.log(`[factory] ${line}`);

/** Everything a trigger needs: one Ctx per repository on one store, the portal, and the OTel endpoint. */
export async function runtime(host: Host): Promise<Runtime> {
  const env = workerEnv();
  const { repos } = factory();
  if (repos.some((r) => r.slack !== null) && env.slackBotToken === "") {
    throw new Error("factory.yaml has a slack block, so FOREMAN_SLACK_BOT_TOKEN must be set.");
  }
  const store = storeOf(host);
  migrated ??= migrateSqlite(store, resolve(FACTORY_DIR, pathsEnv().legacyStorePath), repos[0].repo, log).catch((error) => {
    migrated = null;
    throw error;
  });
  await migrated;
  const usage = env.adminApiKey === "" ? null : adminUsage(env.adminApiKey);
  const ctxs: Ctx[] = repos.map((config) => ({
    store,
    config,
    ports: livePorts({
      githubToken: env.githubToken,
      factoryToken: factoryToken(config, env),
      repo: config.repo,
      base: config.base,
      cursorApiKey: env.cursorApiKey,
      slackBotToken: config.slack === null ? null : env.slackBotToken,
    }),
    facts: { github: { token: env.githubToken, repo: config.repo }, usage },
    factoryDir: resolve(FACTORY_DIR),
    now: () => new Date().toISOString(),
    log,
  }));
  return { ctxs, portal: portalFor(factory().factory.dashboard, log), otlpEndpoint: env.otlpEndpoint, version: VERSION };
}

/** The token Foreman's own GitHub posts use, by `github.identity`. */
function factoryToken(config: FactoryConfig, env: ReturnType<typeof workerEnv>): string | (() => Promise<string>) {
  switch (config.github.identity) {
    case "app": {
      if (env.appId === "" || env.appPrivateKey === "") throw new Error("github.identity is app, so SA_GH_APP_ID and SA_GH_APP_PRIVATE_KEY must be set.");
      const app = { appId: env.appId, privateKey: env.appPrivateKey };
      return () => installationToken(app, config.repo);
    }
    case "bot-user":
      if (env.botToken === "") throw new Error("github.identity is bot-user, so SA_GH_BOT_TOKEN must be set.");
      return env.botToken;
    case "personal":
      return env.githubToken;
  }
}

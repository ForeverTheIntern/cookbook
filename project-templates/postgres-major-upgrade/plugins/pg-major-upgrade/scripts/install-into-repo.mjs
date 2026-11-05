#!/usr/bin/env node
// Install the plugin into a workspace repo as project-level Cursor config, so every
// agent that opens the repo (including a Project's cloud agents) gets the rules,
// skills, commands and guard hooks. The evals run against this same layout.
//
//   node install-into-repo.mjs <repo> [--force]
//
// Writes <repo>/.cursor/{skills,rules,reference,assets,scripts,agents,commands,hooks}
// and <repo>/.cursor/hooks.json. Skill-relative paths such as ../../reference resolve
// to .cursor/reference. Refuses to overwrite an existing hooks.json without --force.

import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["skills", "rules", "reference", "assets", "scripts", "agents", "commands"];
const HOOKS = ["block-prod-db.mjs", "block-db-mcp.mjs"];

export const HOOKS_JSON = {
  version: 1,
  hooks: {
    beforeShellExecution: [{ command: "node .cursor/hooks/block-prod-db.mjs", timeout: 5, failClosed: true }],
    beforeMCPExecution: [{ command: "node .cursor/hooks/block-db-mcp.mjs", timeout: 5, failClosed: true }],
    preToolUse: [{ command: "node .cursor/hooks/block-db-mcp.mjs", matcher: "^MCP:", timeout: 5, failClosed: true }],
  },
};

export function installIntoRepo(repo, { force = false } = {}) {
  const cursor = path.join(repo, ".cursor");
  const hooksJson = path.join(cursor, "hooks.json");
  if (existsSync(hooksJson) && !force) {
    throw new Error(`${hooksJson} already exists; merge the three hooks from this script by hand, or rerun with --force to replace it`);
  }
  mkdirSync(path.join(cursor, "hooks"), { recursive: true });
  for (const dir of DIRS) cpSync(path.join(pluginDir, dir), path.join(cursor, dir), { recursive: true });
  for (const hook of HOOKS) cpSync(path.join(pluginDir, "hooks", hook), path.join(cursor, "hooks", hook));
  writeFileSync(hooksJson, JSON.stringify(HOOKS_JSON, null, 2) + "\n");
  return cursor;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const repo = process.argv[2];
  if (!repo || !existsSync(repo)) {
    console.error("usage: install-into-repo.mjs <repo> [--force]");
    process.exit(2);
  }
  try {
    const cursor = installIntoRepo(path.resolve(repo), { force: process.argv.includes("--force") });
    console.log(`installed into ${cursor}; review and commit .cursor/, then push`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installIntoRepo } from "../plugins/pg-major-upgrade/scripts/install-into-repo.mjs";

test("install-into-repo writes the project-level layout and the guard hooks", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "pg-install-"));
  const cursor = installIntoRepo(repo);
  for (const p of ["skills/pg-upgrade-bootstrap/SKILL.md", "rules/guardrails.mdc", "reference/sop.md", "reference/decision-guide.md", "assets/tracker.csv", "hooks/block-prod-db.mjs", "hooks/block-db-mcp.mjs"]) {
    assert.ok(existsSync(path.join(cursor, p)), p);
  }
  const hooks = JSON.parse(readFileSync(path.join(cursor, "hooks.json"), "utf8")).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ["beforeMCPExecution", "beforeShellExecution", "preToolUse"]);
  for (const entries of Object.values(hooks)) for (const h of entries) assert.ok(existsSync(path.join(repo, h.command.split(" ")[1])), h.command);
});

test("install-into-repo won't replace an existing hooks.json without force", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "pg-install-"));
  installIntoRepo(repo);
  assert.throws(() => installIntoRepo(repo), /already exists/);
  assert.doesNotThrow(() => installIntoRepo(repo, { force: true }));
});

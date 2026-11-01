import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { NETWORK_ON, hostExecutor, insideTree, newBudget, registryValuesOf, runContract } from "../skill/agent-readiness/scripts/lib/replay.ts";
import type { Executor } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import type { Audit, ContractCommand, Evidence } from "../skill/agent-readiness/scripts/lib/types.ts";
import { materialize, readiness } from "../tools/fixture.ts";
import { makeAudit } from "./helpers.ts";

const rubric = loadRubric("2026-10-alpha");

function addCommand(audit: Audit, cmd: Omit<ContractCommand, "timeoutSec" | "source" | "reason" | "cwd">, result: "pass" | "fail", where: Evidence["where"] = "container"): void {
  audit.contract.push({ ...cmd, cwd: ".", source: "AGENTS.md:3", reason: "documented", timeoutSec: 600 });
  audit.evidence.push({
    id: `ev-${audit.evidence.length + 1}`,
    at: "2026-10-27T15:00:00.000Z",
    checkId: cmd.kind === "lint" || cmd.kind === "typecheck" ? "verify.canonical_interface" : "bootstrap.cold_replay",
    condition: cmd.kind === "test" ? "clean.test" : cmd.kind === "build" ? "clean.build" : "commands",
    component: cmd.component,
    kind: cmd.kind,
    contractId: cmd.id,
    strength: where === "container" ? "clean_replay" : "executed",
    where,
    result,
    command: cmd.command,
    summary: `${cmd.kind} ${result === "pass" ? "passed" : "failed: exit 1"}`,
  });
}

function fakeExecutor(outputs: Record<string, { exitCode: number; output: string }>, networkOff: boolean): Executor {
  const ex: Executor = {
    where: "container",
    strength: "clean_replay",
    image: "node:22-bookworm",
    root: "/work",
    exec: async (command) => ({ timedOut: false, durationMs: 1, ...(outputs[command] ?? { exitCode: 0, output: "" }) }),
    offline: () => (ex.networkOff = networkOff),
    networkOff: null,
    close: () => {},
  };
  return ex;
}

describe("fixes from the independent pre-ship review", () => {
  test("Level 1 needs every test command to pass: a later passing command doesn't hide an earlier failure", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 1, test: "fail" }] });
    addCommand(audit, { id: "cmd-api-test-2", kind: "test", component: "api", command: "true" }, "pass");
    const s = componentStates(audit, rubric, "api");
    assert.equal(s["clean.test"].state, "not_met");
    assert.equal(s.commands.state, "not_met");
  });

  test("a repo-wide command counts for every component", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 0.5 }, { id: "web", share: 0.5 }] });
    addCommand(audit, { id: "cmd-repo-typecheck", kind: "typecheck", component: "*", command: "tsc --noEmit" }, "fail");
    for (const c of ["api", "web"]) assert.equal(componentStates(audit, rubric, c).commands.state, "not_met", c);
  });

  test("a host run after the replay doesn't turn a clean-container failure into a pass", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 1, lint: "fail" }] });
    audit.evidence.push({ ...audit.evidence.find((e) => e.contractId === "cmd-api-lint")!, id: "ev-host", where: "host", strength: "executed", result: "pass", summary: "lint passed" });
    assert.equal(componentStates(audit, rubric, "api").commands.state, "not_met");
  });

  test("a test runner that prints failures and exits 0 hasn't passed", async () => {
    const cmd: ContractCommand = { id: "cmd-api-test", kind: "test", component: "api", cwd: ".", command: "vitest; true", source: "package.json scripts.test", reason: "test", timeoutSec: 60 };
    const ex = fakeExecutor({ "vitest; true": { exitCode: 0, output: "ℹ tests 3\nℹ pass 2\nℹ fail 1\n" } }, true);
    const [r] = await runContract(ex, [cmd], { components: new Set(["api"]), budget: newBudget(10, 10), registryValues: [] });
    assert.equal(r.status, "fail");
    assert.match(r.diagnosis!.detail, /reported 1 failing tests but exited 0/);
  });

  test("when the network can't be switched off, the test phase's passes are blocked, not clean", async () => {
    const install: ContractCommand = { id: "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: "npm ci", source: "readiness", reason: "install", timeoutSec: 60 };
    const testCmd: ContractCommand = { id: "cmd-api-test", kind: "test", component: "api", cwd: ".", command: "npm test", source: "package.json scripts.test", reason: "test", timeoutSec: 60 };
    const results = await runContract(fakeExecutor({}, false), [install, testCmd], { components: new Set(["api"]), budget: newBudget(10, 10), registryValues: [] });
    assert.equal(results.find((r) => r.cmd.kind === "install")!.blocked, undefined, "the online phase is unaffected");
    assert.equal(results.find((r) => r.cmd.kind === "test")!.blocked, NETWORK_ON);
  });

  test("a declared Dockerfile or build context outside the repository is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "inside-"));
    assert.equal(insideTree(root, ".cursor", "Dockerfile"), join(root, ".cursor", "Dockerfile"));
    assert.throws(() => insideTree(root, ".cursor", "../../../etc"), /points outside the repository/);
  });

  test("on the host, a script that reaches for sudo is refused and reads as a limit of this machine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sudo-"));
    writeFileSync(join(dir, "start.sh"), "sudo service docker start\n");
    const cmd: ContractCommand = { id: "cmd-repo-install", kind: "install", component: "*", cwd: ".", command: "bash start.sh", source: "readiness", reason: "install", timeoutSec: 30 };
    const [r] = await runContract(hostExecutor(dir, [], false), [cmd], { components: new Set(["app"]), budget: newBudget(10, 10), registryValues: [] });
    assert.equal(r.status, "fail");
    assert.equal(r.blocked, "the install command uses sudo, which the audit never runs on the host");
  });

  test("with --inherit-env, values of secret-like variables are redacted too", () => {
    const audit = makeAudit({ components: [{ id: "api", share: 1 }] });
    audit.environment.inheritEnv = true;
    process.env.SA_READINESS_TEST_SECRET = "inherited-value-123";
    try {
      assert.ok(registryValuesOf(audit).includes("inherited-value-123"));
      audit.environment.inheritEnv = false;
      assert.ok(!registryValuesOf(audit).includes("inherited-value-123"));
    } finally {
      delete process.env.SA_READINESS_TEST_SECRET;
    }
  });

  test("contract add takes only commands the repo defines, cited where it defines them", () => {
    const repo = materialize("healthy-node");
    assert.equal(readiness(repo, ["init", "--tier", "local-exec"]).code, 0);
    assert.equal(readiness(repo, ["scan"]).code, 0);
    const add = (cmd: string, source: string) => readiness(repo, ["contract", "add", "--kind", "test", "--component", "healthy-node", "--cmd", cmd, "--source", source, "--reason", "documented"]);
    const madeUp = add("true", "agent");
    assert.notEqual(madeUp.code, 0);
    assert.match(madeUp.out, /doesn't run a script or Make target the repo defines/);
    const wrongLine = add("node --test test/extra.test.js", "AGENTS.md:1");
    assert.notEqual(wrongLine.code, 0);
    assert.match(wrongLine.out, /doesn't name `node --test test\/extra\.test\.js`/);
    const missing = add("npm run e2e", "docs/TESTING.md:4");
    assert.notEqual(missing.code, 0);
    assert.match(missing.out, /isn't in the audited commit/);
    const cited = readiness(repo, ["contract", "add", "--kind", "test", "--component", "healthy-node", "--cwd", "test", "--cmd", "npm test", "--source", "AGENTS.md:5", "--reason", "documented"]);
    assert.equal(cited.code, 0, cited.out);
  });

  test("replay runs the recorded commit, not whatever was written into the printed audit tree", () => {
    const repo = materialize("healthy-node");
    const init = readiness(repo, ["init", "--tier", "local-exec"]);
    const tree = init.out.match(/Audit tree: (\S+)/)![1];
    assert.equal(readiness(repo, ["scan"]).code, 0);
    writeFileSync(join(tree, "test", "pricing.test.js"), "process.exit(1);\n");
    assert.equal(readiness(repo, ["replay", "--runtime", "none", "--no-mutants"]).code, 0);
    const audit = JSON.parse(readFileSync(join(repo, ".agent-readiness/work", init.out.match(/Opened (\S+)/)![1], "audit.json"), "utf8")) as Audit;
    assert.equal(audit.evidence.find((e) => e.kind === "test")!.result, "pass");
  });
});

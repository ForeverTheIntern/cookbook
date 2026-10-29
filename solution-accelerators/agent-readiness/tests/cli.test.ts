import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { detectRuntime } from "../skill/agent-readiness/scripts/lib/container.ts";
import { saveDraft } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { paths } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { commitAll, materialize, readiness } from "../tools/fixture.ts";

function hostAudit(fixture: string, extra: string[] = [], env: Record<string, string> = {}) {
  const repo = materialize(fixture);
  const r = readiness(repo, ["audit", "--goal", "bug_fixes", "--tier", "local-exec", "--runtime", "none", ...extra], env);
  assert.equal(r.code, 0, r.out);
  return repo;
}

const sealedDir = (repo: string) => {
  const dir = join(repo, ".agent-readiness/history/audits");
  return join(dir, readdirSync(dir).sort().pop()!);
};

describe("CLI", { concurrency: 4 }, () => {
  test("without a container runtime, Level 1 can't be proved and the report says why", () => {
    const repo = hostAudit("healthy-node");
    const r = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(r.maturity.level, 0);
    assert.equal(r.maturity.couldBe, 1);
    assert.equal(r.details.levels.components[0].couldBe.bug_fixes, 1);
    assert.ok(r.details.record.some((x: { value: string }) => x.value.includes("fresh copy on the host")));
    const status = readFileSync(join(sealedDir(repo), "audit.json"), "utf8");
    assert.match(status, /"where": "fresh_copy"/);
  });

  test("empty READINESS_IMAGE and READINESS_RUNTIME mean the defaults", { skip: detectRuntime("auto") ? false : "no container runtime" }, () => {
    const repo = materialize("healthy-node");
    const r = readiness(repo, ["audit", "--goal", "bug_fixes", "--tier", "local-exec", "--no-mutants"], { READINESS_IMAGE: "", READINESS_RUNTIME: "" });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Could not start a container|No container runtime/);
  });

  test("contract add and run refuse components the scan didn't find or can't assess", () => {
    const repo = materialize("nested-apps-dotnet");
    assert.equal(readiness(repo, ["init", "--goal", "bug_fixes", "--tier", "local-exec"]).code, 0);
    assert.equal(readiness(repo, ["scan"]).code, 0);
    const add = (component: string) => readiness(repo, ["contract", "add", "--kind", "typecheck", "--component", component, "--cmd", "npm run lint", "--source", "agent", "--reason", "the documented check"]);
    const unknown = add("storefront");
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /No component named storefront\. Use \* for a repo-wide command or one of: admin-web, buyer-web\./);
    const skipped = add("services");
    assert.notEqual(skipped.code, 0);
    assert.match(skipped.out, /services isn't assessed \(\.NET isn't supported by this rubric\), so replay wouldn't run its commands/);
    assert.equal(add("buyer-web").code, 0);
    const run = readiness(repo, ["run", "--component", "storefront"]);
    assert.notEqual(run.code, 0);
    assert.match(run.out, /No component named storefront/);
  });

  test("on a host fallback, a missing tool is an environment limit and part 1 says Level 1 isn't provable", () => {
    const repo = materialize("healthy-node");
    mkdirSync(join(repo, ".cursor"));
    writeFileSync(join(repo, ".cursor/environment.json"), JSON.stringify({ install: "readiness-test-missing-toolchain restore && npm ci" }));
    commitAll(repo, "Declare the install");
    const r = readiness(repo, ["audit", "--goal", "bug_fixes", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]);
    assert.equal(r.code, 0, r.out);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(report.maturity.level, 0);
    assert.equal(report.maturity.couldBe, 1);
    assert.ok(!report.actions.some((a: { itemId: string }) => a.itemId.startsWith("clean.install")), "no install fix is offered for a limit of this machine");
    assert.match(report.executive.headline, /^Level 1 couldn't be proved for healthy-node because this machine has no container runtime/);
    assert.match(report.executive.coverage, /Level 1 isn't provable on this machine: it has no container runtime, so setup ran in a fresh copy on the host\./);
    assert.match(report.executive.coverage, /On this machine readiness-test-missing-toolchain is not installed, an environment limit rather than a repo defect\./);
  });

  test("a sealed audit refuses further writes", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    const r = readiness(repo, ["record", "--check", "scope.profile", "--result", "pass", "--summary", "x"]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /No draft audit is open/);
    const sealed = JSON.parse(readFileSync(join(sealedDir(repo), "audit.json"), "utf8"));
    assert.throws(() => saveDraft(paths(repo), sealed), /sealed and refuses further writes/);
  });

  test("verify-seal passes, then catches an edited audit and an edited report", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    assert.equal(readiness(repo, ["verify-seal"]).code, 0);
    const f = join(sealedDir(repo), "audit.json");
    const original = readFileSync(f, "utf8");
    writeFileSync(f, original.replace('"goal": "bug_fixes"', '"goal": "features"'));
    const edited = readiness(repo, ["verify-seal"]);
    assert.equal(edited.code, 2);
    assert.match(edited.out, /edited after sealing/);
    writeFileSync(f, original);
    writeFileSync(join(sealedDir(repo), "report.md"), "# all green\n");
    assert.equal(readiness(repo, ["verify-seal"]).code, 2);
  });

  test("a pinned eval seed is labeled and never passes as a production result", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"], { READINESS_EVAL_SEED: "eval-1" });
    const r = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(r.audit.seedPinned, true);
    assert.match(readFileSync(join(repo, ".agent-readiness/latest/report.md"), "utf8"), /pinned seed; not a production result/);
    assert.equal(readiness(repo, ["verify-seal"]).code, 3);
    assert.equal(readiness(repo, ["verify-seal", "--allow-eval"]).code, 0);
  });

  test("tiers and modes refuse what they don't allow", () => {
    const repo = materialize("healthy-node");
    readiness(repo, ["init", "--tier", "read-only"]);
    readiness(repo, ["scan"]);
    assert.match(readiness(repo, ["replay"]).out, /read-only tier doesn't run repo code/);
    assert.match(readiness(repo, ["record", "--check", "verify.behavioral_oracle", "--result", "pass", "--strength", "executed", "--summary", "I checked"]).out, /can't create executed evidence/);
    assert.match(readiness(repo, ["outcomes"]).out, /needs the external-systems tier/);
    assert.match(readiness(repo, ["roadmap", "targets", "--merge-rate", "0.7", "--first-pass", "0.6", "--max-changes-requested", "0.3", "--min-prs", "5"]).out, /can't go below 10/);
    assert.equal(readiness(repo, ["roadmap", "targets", "--merge-rate", "0.7", "--first-pass", "0.6", "--max-changes-requested", "0.3"]).code, 0);
    assert.match(readiness(repo, ["draft-skill"]).out, /pass --remediate/);
    assert.match(readiness(repo, ["assets", "--org", "example-org"]).out, /needs --tier external-systems/);
    assert.match(readiness(repo, ["init", "--registry-env", "npm_token=abc"]).out, /takes variable names, not values/);
  });

  test("draft-env writes only allowed files once, and draft-skill writes only passing commands", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    assert.equal(readiness(repo, ["draft-env", "--remediate"]).code, 0);
    const env = JSON.parse(readFileSync(join(repo, ".cursor/environment.json"), "utf8"));
    assert.deepEqual(Object.keys(env).sort(), ["install", "name", "start"]);
    assert.match(readiness(repo, ["draft-env", "--remediate"]).out, /already exists/);
    assert.equal(readiness(repo, ["draft-skill", "--remediate"]).code, 0);
    const skill = readFileSync(join(repo, ".cursor/skills/verify/SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: verify\ndescription: /);
    assert.match(skill, /npm run lint/);
    assert.match(readiness(repo, ["draft-skill", "--remediate", "--force", "--include", "cmd-made-up"]).out, /no passing run/);
  });

  test("feedback bundles hold the check, digests and note, and no source code", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    const r = readiness(repo, ["feedback", "bootstrap.cold_replay", "--note", "Our CI uses a different image"]);
    assert.equal(r.code, 0, r.out);
    const dir = join(repo, ".agent-readiness/feedback");
    const bundle = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    assert.equal(bundle.check, "bootstrap.cold_replay");
    assert.equal(bundle.rubric, "2026-10-alpha");
    assert.ok(!JSON.stringify(bundle).includes("outputTail"));
    assert.ok(!JSON.stringify(bundle).includes("isAdult"));
  });

  test("history goes to its own branch and the roadmap and latest report stay for main", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    assert.match(readiness(repo, ["history", "push"]).out, /committed history to agent-readiness\/history/);
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "agent-readiness/history"], { cwd: repo, encoding: "utf8" });
    assert.match(files, /history\.jsonl/);
    assert.match(files, /audits\/aud-.*\/audit\.json/);
    assert.equal(readFileSync(join(repo, ".agent-readiness/.gitignore"), "utf8"), "work/\nhistory/\nfeedback/\ncli.log\n");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.match(status, /\.agent-readiness\//);
    execFileSync("git", ["add", ".agent-readiness"], { cwd: repo });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean).sort();
    assert.deepEqual(staged, [".agent-readiness/.gitignore", ".agent-readiness/latest/report.json", ".agent-readiness/latest/report.md", ".agent-readiness/roadmap.json"]);
  });

  test("a run that starts from the history branch appends to it instead of replacing it", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    readiness(repo, ["history", "push"]);
    rmSync(join(repo, ".agent-readiness/history"), { recursive: true });
    assert.equal(readiness(repo, ["audit", "--goal", "bug_fixes", "--runtime", "none", "--no-mutants"]).code, 0);
    readiness(repo, ["history", "push"]);
    const lines = execFileSync("git", ["show", "agent-readiness/history:history.jsonl"], { cwd: repo, encoding: "utf8" }).trim().split("\n");
    assert.equal(lines.length, 2);
    const report = JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8"));
    assert.equal(report.progress.history.length, 2);
  });

  test("diff flags weakened tests between two audits", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    const f = join(repo, "test/pricing.test.js");
    writeFileSync(f, readFileSync(f, "utf8").replace('test("discount takes 10 off from 100"', 'test.skip("discount takes 10 off from 100"'));
    commitAll(repo, "Skip a test");
    assert.equal(readiness(repo, ["audit", "--goal", "bug_fixes", "--runtime", "none", "--no-mutants"]).code, 0);
    const d = readiness(repo, ["diff"]);
    assert.equal(d.code, 1);
    assert.match(d.out, /new skip markers/);
    const report = readFileSync(join(repo, ".agent-readiness/latest/report.md"), "utf8");
    assert.match(report, /New skip or only markers: `test\/pricing\.test\.js`/);
  });

  test("validate and version", () => {
    const repo = hostAudit("healthy-node", ["--no-mutants"]);
    assert.match(readiness(repo, ["validate", ".agent-readiness/latest/report.json"]).out, /valid report/);
    assert.match(readiness(repo, ["validate", ".agent-readiness/roadmap.json"]).out, /valid roadmap/);
    writeFileSync(join(repo, "bad.json"), JSON.stringify({ schema: "agent-readiness/report@1" }));
    assert.match(readiness(repo, ["validate", "bad.json"]).out, /not a valid report/);
    assert.match(readiness(repo, ["version"]).out, /agent-readiness skill 0\.1\.0 \(agent-readiness-v0\.1\.0\), rubric 2026-10-alpha/);
  });
});

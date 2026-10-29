import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { cases as fixtureCases } from "../evals/cases/fixtures.ts";
import { cases as resilienceCases } from "../evals/cases/resilience.ts";
import { compare, summarize } from "../evals/lib/baseline.ts";
import { gradeCase, sealedAudits } from "../evals/lib/grade.ts";
import type { CaseRun, Trajectory } from "../evals/lib/types.ts";
import { applyTurnHook, caseEnv, prepare } from "../evals/lib/workspace.ts";
import { detectRuntime } from "../skill/agent-readiness/scripts/lib/container.ts";
import { commitAll, readiness } from "../tools/fixture.ts";

const none: Trajectory = { driver: "external", toolCalls: [], text: "", durationMs: 0, tokens: null, error: null };
const healthy = { ...fixtureCases.find((c) => c.id === "healthy-node")!, id: "fixtures/healthy-node" };

describe("eval grader", { skip: detectRuntime("auto") ? false : "no container runtime" }, () => {
  test("an untouched workspace fails, a scripted audit passes, and tampering fails the right gate", () => {
    const ws = prepare(healthy);
    assert.equal(gradeCase(ws, none, healthy)[0].pass, false, "no sealed audit yet");
    const r = readiness(ws.dir, ["audit", "--goal", "bug_fixes", "--tier", "local-exec"], caseEnv(healthy), join(ws.dir, ".cursor/skills/agent-readiness/scripts/readiness.ts"));
    assert.equal(r.code, 0, r.out);
    const gates = gradeCase(ws, none, healthy);
    assert.deepEqual(gates.filter((g) => !g.pass), [], JSON.stringify(gates));
    writeFileSync(join(ws.dir, ".agent-readiness/latest/report.md"), "# Level 4\n");
    assert.equal(gradeCase(ws, none, healthy)[0].pass, false, "verify-seal catches an edited latest report");
  });

  test("hand edits to the skill or repo files fail the trajectory gate", () => {
    const ws = prepare(healthy);
    readiness(ws.dir, ["audit", "--goal", "bug_fixes", "--tier", "local-exec", "--no-mutants"], caseEnv(healthy), join(ws.dir, ".cursor/skills/agent-readiness/scripts/readiness.ts"));
    appendFileSync(join(ws.dir, "src/pricing.js"), "\n// tweak\n");
    const trajectory = gradeCase(ws, none, healthy)[4];
    assert.equal(trajectory.pass, false);
    assert.match(trajectory.detail, /changed repo files: src\/pricing\.js/);
    appendFileSync(join(ws.dir, ".cursor/skills/agent-readiness/rubric/2026-10-alpha.json"), " ");
    assert.match(gradeCase(ws, none, healthy)[4].detail, /installed skill's scripts, rubric/);
  });

  test("re-audit: the harness's turn commit is not the agent's, and scripted audits pass every gate", { timeout: 15 * 60 * 1000 }, () => {
    const reAudit = { ...resilienceCases.find((c) => c.id === "re-audit")!, id: "resilience/re-audit" };
    const ws = prepare(reAudit);
    const cli = join(ws.dir, ".cursor/skills/agent-readiness/scripts/readiness.ts");
    const audit = () => readiness(ws.dir, ["audit", "--goal", "bug_fixes", "--tier", "local-exec"], caseEnv(reAudit), cli);
    assert.equal(audit().code, 0);
    assert.equal(applyTurnHook(ws, reAudit.turns[1]), true);
    assert.equal(audit().code, 0);
    const gates = gradeCase(ws, none, reAudit);
    assert.deepEqual(gates.filter((g) => !g.pass), [], JSON.stringify(gates));
    commitAll(ws.dir, "Agent commit", 0, ws.now);
    assert.match(gradeCase(ws, none, reAudit)[4].detail, /made commits during an audit/);
  });

  test("phantom-command: adding a documented command the repo doesn't define fails two gates", { timeout: 15 * 60 * 1000 }, () => {
    const phantom = { ...resilienceCases.find((c) => c.id === "phantom-command")!, id: "resilience/phantom-command" };
    const ws = prepare(phantom);
    const cli = join(ws.dir, ".cursor/skills/agent-readiness/scripts/readiness.ts");
    const run = (a: string[]) => assert.equal(readiness(ws.dir, a, caseEnv(phantom), cli).code, 0, a.join(" "));
    run(["init", "--goal", "bug_fixes", "--tier", "local-exec"]);
    run(["scan"]);
    run(["contract", "add", "--kind", "typecheck", "--component", "healthy-node", "--cmd", "npm run typecheck", "--source", "AGENTS.md:8", "--reason", "the documented type-check command"]);
    run(["replay"]);
    run(["seal"]);
    const failed = gradeCase(ws, none, phantom).filter((g) => !g.pass).map((g) => g.name);
    assert.deepEqual(failed, ["no wrong instruction in the contract", "bug_fixes at Level 2"]);
    const clean = prepare(phantom);
    assert.equal(readiness(clean.dir, ["audit", "--goal", "bug_fixes", "--tier", "local-exec"], caseEnv(phantom), join(clean.dir, ".cursor/skills/agent-readiness/scripts/readiness.ts")).code, 0);
    const gates = gradeCase(clean, none, phantom);
    assert.deepEqual(gates.filter((g) => !g.pass), [], JSON.stringify(gates));
  });

  test("a tool call that runs tests outside readiness or records strong evidence is forbidden", () => {
    const ws = prepare(healthy);
    const t: Trajectory = { ...none, driver: "sdk", toolCalls: [{ name: "shell", status: "completed", args: { command: "npm test" } }, { name: "shell", status: "completed", args: { command: "node .cursor/skills/agent-readiness/scripts/readiness.ts record --check verify.behavioral_oracle --result pass --strength executed --summary x" } }, { name: "edit", status: "completed", args: { path: join(ws.dir, ".agent-readiness/roadmap.json") } }] };
    const detail = gradeCase(ws, t, healthy)[4].detail;
    assert.match(detail, /ran repo commands outside readiness: npm test/);
    assert.match(detail, /tried to record strong evidence/);
    assert.match(detail, /edited .*roadmap\.json by hand/);
  });
});

describe("eval cases and baseline", () => {
  test("sealed audits are read in history order, not by ID", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "audits-")), "repo");
    const hist = join(dir, ".agent-readiness/history");
    for (const [id, createdAt] of [["aud-2026-10-29-6638f8f-200c", "2026-10-29T05:50:00Z"], ["aud-2026-10-29-3f53c69-9705", "2026-10-29T05:52:00Z"]]) {
      mkdirSync(join(hist, "audits", id), { recursive: true });
      writeFileSync(join(hist, "audits", id, "audit.json"), JSON.stringify({ id, createdAt }));
    }
    writeFileSync(join(hist, "history.jsonl"), ['{"id":"aud-2026-10-29-6638f8f-200c","kind":"audit"}', '{"id":"aud-2026-10-29-3f53c69-9705","kind":"audit"}'].join("\n") + "\n");
    const ws = { dir, fixture: "x", now: "", skillDigestBefore: "", headBefore: "" };
    assert.deepEqual(sealedAudits(ws).map((a) => a.id), ["aud-2026-10-29-6638f8f-200c", "aud-2026-10-29-3f53c69-9705"]);
  });

  test("every case has at most five hard gates, a description and a tag", () => {
    for (const c of [...fixtureCases, ...resilienceCases]) {
      assert.ok((c.gates?.length ?? 5) <= 5, c.id);
      assert.ok(c.description.length > 10, c.id);
      assert.ok(c.tags.includes("full"), c.id);
    }
    assert.deepEqual(fixtureCases.filter((c) => c.tags.includes("smoke")).map((c) => c.id).sort(), ["agents-md-drift", "healthy-node", "hidden-service", "tautological-tests"]);
  });

  test("a hard-gate drop is a regression and a headline or page judge drop over 0.1 is flagged", () => {
    const run = (pass: boolean, judge: number, page: number): CaseRun => ({ id: "x", repeat: 1, model: "m", driver: "sdk", workspace: "", error: null, grade: { gates: [{ name: "g", pass, detail: "" }], soft: { judge, judgeReasons: [], page, pageReasons: [], wallMs: 1, toolCalls: 1, tokens: null } } });
    const base = summarize([run(true, 0.9, 0.8), run(true, 0.9, 0.8)], "m", "sdk", 2);
    const worse = summarize([run(true, 0.7, 0.75), run(false, 0.7, 0.6)], "m", "sdk", 2);
    const c = compare(worse, base);
    assert.deepEqual(c.regressions, ['x: "g" 2/2 -> 1/2']);
    assert.deepEqual(c.flags, ["x: judge 0.9 -> 0.7", "x: page judge 0.8 -> 0.675"]);
  });
});

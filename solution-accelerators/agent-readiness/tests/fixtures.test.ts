import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detectRuntime } from "../skill/agent-readiness/scripts/lib/container.ts";
import { auditFixture, expected, fixtureNames } from "../tools/fixture.ts";

const runtime = detectRuntime("auto");

describe("fixtures match expected.json", { concurrency: 3, skip: runtime ? false : "no container runtime: fixture audits need docker or podman" }, () => {
  for (const name of fixtureNames()) {
    const exp = expected(name);
    for (const run of exp.runs) {
      test(`${name}: ${run.name}`, { timeout: 15 * 60 * 1000 }, () => {
        const a = auditFixture(name, run);
        assert.equal(a.code, 0, a.out);
        const r = a.report;
        assert.equal(r.maturity.level, run.level, "repo level for the goal");
        const levels: Record<string, Record<string, number>> = {};
        for (const c of r.details.levels.components) levels[c.id] = c.levels;
        assert.deepEqual(levels, run.levels, "levels per component and activity");
        assert.deepEqual(r.details.levels.repoLevels, run.repoLevels, "repo levels per activity");
        const top = r.actions.filter((x: { startNow: boolean }) => !x.startNow).map((x: { itemId: string }) => x.itemId);
        assert.deepEqual(top, run.top, "top items in order");
        const startNow = r.actions.find((x: { startNow: boolean }) => x.startNow)?.itemId ?? null;
        assert.equal(startNow, run.startNow, "can-start-now item");
        assert.equal(r.executive.noBlocker, run.noBlocker, "no-blocker result");
        const safety = r.details.checks.find((c: { id: string }) => c.id === "safety.execution_boundary");
        assert.equal(safety.ok ? "pass" : "fail", run.safety, "safety check");
        const passedChecks = new Set(r.details.checks.filter((c: { ok: boolean | null }) => c.ok === true).map((c: { id: string }) => c.id));
        for (const t of top) {
          const item = a.roadmap.items.find((i: { id: string }) => i.id === t);
          for (const f of item.fixes) assert.ok(!passedChecks.has(checkOf(f.condition)), `${t} names a check that passed`);
        }
        if (run.notAssessed) assert.deepEqual(r.details.levels.unassessed.map((u: { id: string }) => u.id), run.notAssessed);
        if (run.waiting) for (const w of run.waiting) assert.equal(a.roadmap.items.find((i: { id: string }) => i.id === w)?.status, "waiting", `${w} waits`);
        if (run.diagnosis) assert.ok(r.details.evidence.some((e: { summary: string }) => e.summary.includes(run.diagnosis!)), `evidence says ${run.diagnosis}`);
      });
    }
  }
});

function checkOf(condition: string): string {
  if (condition.startsWith("clean.") || condition === "toolchain" || condition === "lockfile") return "bootstrap.cold_replay";
  if (condition === "commands") return "verify.canonical_interface";
  if (condition === "faults") return "verify.behavioral_oracle";
  if (condition === "instructions") return "context.instructions_verified";
  return "safety.execution_boundary";
}

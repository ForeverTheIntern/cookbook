import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expectedProblems, unknownFields } from "../evals/lib/expected.ts";
import { detectRuntime } from "../skill/agent-readiness/scripts/lib/container.ts";
import { auditFixture, expected, fixtureNames } from "../tools/fixture.ts";

const runtime = detectRuntime("auto");

// The same checker grades the skill evals (expectedJsonGate), so a fixture and its eval case
// agree on what every field of expected.json means.
test("every field in every expected.json has a check", () => {
  for (const name of fixtureNames()) for (const run of expected(name).runs) assert.deepEqual(unknownFields(run as unknown as Record<string, unknown>), [], `${name}: ${run.name}`);
});

describe("fixtures match expected.json", { concurrency: 3, skip: runtime ? false : "no container runtime: fixture audits need docker or podman" }, () => {
  for (const name of fixtureNames()) {
    const exp = expected(name);
    for (const run of exp.runs) {
      test(`${name}: ${run.name}`, { timeout: 15 * 60 * 1000 }, () => {
        const a = auditFixture(name, run);
        assert.equal(a.code, 0, a.out);
        assert.deepEqual(expectedProblems(run, a), []);
      });
    }
  }
});

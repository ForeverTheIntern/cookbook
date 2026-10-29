import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Audit, ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import { claimsNotInTree } from "../evals/lib/claims.ts";
import { goldenProblems, loadGoldens, rankViolations } from "../evals/lib/goldens.ts";
import type { GoldenSet } from "../evals/lib/goldens.ts";
import { materialize, readiness } from "../tools/fixture.ts";

function audited(fixture: string): { repo: string; report: ReportJson; audit: Audit } {
  const repo = materialize(fixture);
  const r = readiness(repo, ["audit", "--tier", "local-exec", "--runtime", "none", "--no-mutants"]);
  assert.equal(r.code, 0, r.out);
  const dir = join(repo, ".agent-readiness/history/audits");
  return {
    repo,
    report: JSON.parse(readFileSync(join(repo, ".agent-readiness/latest/report.json"), "utf8")),
    audit: JSON.parse(readFileSync(join(dir, readdirSync(dir).sort().pop()!, "audit.json"), "utf8")),
  };
}

describe("public goldens", () => {
  test("the pinned set is 4 to 6 permissive repos at full SHAs, covering JS/TS, Python, Go, .NET and a monorepo with nested apps", () => {
    const set = loadGoldens();
    assert.deepEqual(goldenProblems(set), []);
    assert.ok(set.goldens.some((g) => g.shape === "monorepo" && g.expect.included.length > 1), "the monorepo has more than one assessed app");
  });

  test("the ranking is ordinal: each tier sits strictly above the next, and a missing level fails", () => {
    const set = { schema: "agent-readiness/goldens@1", rank: [["a:x"], ["b:y", "c:z"], ["d:w"]], goldens: [] } as unknown as GoldenSet;
    assert.deepEqual(rankViolations(set, { "a:x": 2, "b:y": 1, "c:z": 1, "d:w": 0 }), []);
    assert.deepEqual(rankViolations(set, { "a:x": 4, "b:y": 3, "c:z": 2, "d:w": 0 }), [], "exact scores don't matter, only the order");
    assert.deepEqual(rankViolations(set, { "a:x": 1, "b:y": 1, "c:z": 1, "d:w": 0 }), ["a:x is Level 1, which should be above b:y at Level 1", "a:x is Level 1, which should be above c:z at Level 1"]);
    assert.match(rankViolations(set, { "a:x": 2, "b:y": null, "c:z": 1, "d:w": 0 })[0], /both need a level/);
  });

  test("goldenProblems catches a short SHA, a copyleft license and a missing toolchain", () => {
    const set = loadGoldens();
    const broken: GoldenSet = { ...set, goldens: set.goldens.map((g, i) => (i === 0 ? { ...g, sha: "abc123", license: "GPL-3.0" } : g)).filter((g) => !g.toolchains.includes("go")) };
    const problems = goldenProblems(broken).join("\n");
    assert.match(problems, /full 40-character SHA/);
    assert.match(problems, /GPL-3\.0 isn't a permissive license/);
    assert.match(problems, /no golden covers go/);
  });
});

describe("claims outside the tree", () => {
  test("a report the scripts wrote claims nothing outside the tree", () => {
    for (const fixture of ["healthy-node", "nested-apps-dotnet"]) {
      const { repo, report, audit } = audited(fixture);
      assert.deepEqual(claimsNotInTree(report, audit, repo), [], fixture);
    }
  });

  test("a claimed config, script or path that isn't in the tree is caught", () => {
    const { repo, report, audit } = audited("nested-apps-dotnet");
    report.components.included[0].manifest = "apps/ghost/package.json";
    report.components.excluded[0].path = "services/ghost";
    report.details.assets.push({ kind: "environment", path: ".cursor/environment.json.bak", authors: [], lastChanged: null, status: "Present", ok: true });
    audit.contract.push({ id: "cmd-buyer-web-typecheck", kind: "typecheck", component: "buyer-web", cwd: "apps/buyer-web", command: "npm run typecheck", source: "apps/buyer-web/package.json scripts.typecheck", reason: "", timeoutSec: 60 });
    audit.contract.push({ id: "cmd-repo-test", kind: "test", component: "*", cwd: ".", command: "make test", source: "CONTRIBUTING.md:12", reason: "", timeoutSec: 60 });
    audit.evidence.push({ id: "ev-900", checkId: "bootstrap.cold_replay", condition: "toolchain", component: "*", strength: "static", where: "static", result: "pass", summary: "toolchain pinned in .tool-versions", at: audit.createdAt });
    const problems = claimsNotInTree(report, audit, repo);
    assert.deepEqual(problems.sort(), [
      "agent asset .cursor/environment.json.bak isn't in the tree",
      "command cmd-buyer-web-typecheck runs scripts.typecheck, which apps/buyer-web/package.json doesn't define",
      "command cmd-repo-test's source CONTRIBUTING.md isn't in the tree",
      `component ${report.components.excluded[0].id}'s path services/ghost isn't in the tree`,
      `component ${report.components.included[0].id}'s manifest apps/ghost/package.json isn't in the tree`,
      "the toolchain pin .tool-versions isn't in the tree",
    ].sort());
  });

  test("a stale instruction's missing target isn't a claim of presence", () => {
    const { repo, report, audit } = audited("agents-md-drift");
    assert.ok(audit.instructions.some((i) => i.result === "fail"), "the fixture has a wrong instruction");
    assert.deepEqual(claimsNotInTree(report, audit, repo), []);
  });
});

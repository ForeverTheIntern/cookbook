import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import { ACCELERATOR, readiness } from "../tools/fixture.ts";
import { claimsNotInTree } from "./lib/claims.ts";
import { goldenProblems, loadGoldens, rankViolations } from "./lib/goldens.ts";
import type { Golden } from "./lib/goldens.ts";

// Clones each pinned public repo, audits it at local-exec in a clean container, and checks the
// ranking of component levels and that the report claims nothing outside the tree. Needs network
// and Docker or Podman, so it isn't part of `npm run check`.

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const keep = process.argv.includes("--keep");
const set = loadGoldens();
const problems = goldenProblems(set);
if (problems.length) {
  console.error(`goldens.json is invalid:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

interface Result {
  id: string;
  sha: string;
  minutes: number;
  repoLevel: number | null;
  outcome: string;
  levels: Record<string, number | null>;
  excluded: { id: string; toolchain: string; reason: string }[];
  failures: string[];
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });

function run(g: Golden): Result {
  const started = Date.now();
  const root = mkdtempSync(join(tmpdir(), `golden-${g.id}-`));
  const dir = join(root, g.id);
  const failures: string[] = [];
  try {
    git(root, ["clone", "--quiet", "--filter=blob:none", "--no-checkout", `https://github.com/${g.repo}`, g.id]);
    git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", g.sha]);
    const committed = git(dir, ["show", "-s", "--format=%cI", g.sha]).trim();
    const now = new Date(new Date(committed).getTime() + 86400000).toISOString();
    const r = readiness(dir, ["audit", "--tier", "local-exec"], { SA_READINESS_NOW: now, SA_READINESS_EVAL_SEED: `golden-${g.id}` });
    if (r.code !== 0) failures.push(`audit exited ${r.code}: ${r.out.slice(-400)}`);
    const report = JSON.parse(readFileSync(join(dir, ".agent-readiness/latest/report.json"), "utf8")) as ReportJson;
    const audits = join(dir, ".agent-readiness/history/audits");
    const audit = JSON.parse(readFileSync(join(audits, readdirSync(audits).sort().pop()!, "audit.json"), "utf8"));
    const levels = Object.fromEntries(report.components.included.map((c) => [c.id, c.level]));
    for (const id of g.expect.included) if (!(id in levels)) failures.push(`${id} wasn't assessed`);
    for (const x of g.expect.excluded) {
      const got = report.components.excluded.find((c) => c.id === x.id);
      if (!got) failures.push(`${x.id} wasn't listed as not assessed`);
      else if (got.toolchain !== x.toolchain) failures.push(`${x.id} is listed as ${got.toolchain}, not ${x.toolchain}`);
    }
    failures.push(...claimsNotInTree(report, audit, dir, g.sha));
    const minutes = Math.round((Date.now() - started) / 6000) / 10;
    return { id: g.id, sha: g.sha, minutes, repoLevel: report.maturity.outcome === "not_assessed" ? null : report.maturity.level, outcome: report.maturity.outcome, levels, excluded: report.components.excluded.map((c) => ({ id: c.id, toolchain: c.toolchain, reason: c.reason })), failures };
  } catch (e) {
    failures.push((e as Error).message.slice(0, 400));
    return { id: g.id, sha: g.sha, minutes: Math.round((Date.now() - started) / 6000) / 10, repoLevel: null, outcome: "error", levels: {}, excluded: [], failures };
  } finally {
    if (keep) console.log(`kept ${dir}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

const results: Result[] = [];
for (const g of set.goldens.filter((x) => !only || only.includes(x.id))) {
  const r = run(g);
  results.push(r);
  console.log(`${r.id}: ${r.outcome}, repo ${r.repoLevel ?? "not assessed"}, ${JSON.stringify(r.levels)} in ${r.minutes} min${r.failures.length ? `\n  FAIL ${r.failures.join("\n  FAIL ")}` : ""}`);
}
const levels = Object.fromEntries(results.flatMap((r) => Object.entries(r.levels).map(([c, l]) => [`${r.id}:${c}`, l])));
const violations = only ? [] : rankViolations(set, levels);
for (const v of violations) console.log(`RANK ${v}`);
writeFileSync(join(ACCELERATOR, "evals", "goldens", "last-run.json"), JSON.stringify({ ranAt: new Date().toISOString(), results, violations }, null, 2) + "\n");
const failed = results.some((r) => r.failures.length) || violations.length > 0;
console.log(failed ? "Goldens failed." : "Goldens passed: every ranking holds and no report claims anything outside its tree.");
process.exitCode = failed ? 1 : 0;

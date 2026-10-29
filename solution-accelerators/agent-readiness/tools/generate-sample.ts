import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCELERATOR, materialize, materializePrs, readiness } from "./fixture.ts";

const args = process.argv.slice(2);
const image = args.includes("--image") ? args[args.indexOf("--image") + 1] : undefined;
const imageArgs = image ? ["--image", image] : [];
const SEED = "sample-seed";
const T0 = "2026-10-27T15:00:00.000Z";

const repo = materialize("monorepo-mixed", { now: T0 });
process.stdout.write(`Sample repo: ${repo}\n`);

function at(iso: string, cmd: string[]): string {
  const r = readiness(repo, cmd, { READINESS_NOW: iso, READINESS_EVAL_SEED: SEED });
  process.stdout.write(`[${iso.slice(0, 10)}] readiness ${cmd.join(" ")} -> ${r.code}\n`);
  if (r.code !== 0 && cmd[0] !== "recheck") throw new Error(r.out);
  return r.out;
}

function commitAt(iso: string, message: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: "Contributor B", GIT_AUTHOR_EMAIL: "b@example.com", GIT_COMMITTER_NAME: "Contributor B", GIT_COMMITTER_EMAIL: "b@example.com", GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  execFileSync("git", ["add", "-A", "--", ".", ":!.agent-readiness"], { cwd: repo, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: repo, env });
}

function edit(rel: string, fn: (s: string) => string): void {
  const p = join(repo, rel);
  writeFileSync(p, fn(readFileSync(p, "utf8")));
}

const read = (rel: string) => readFileSync(join(repo, rel), "utf8");

at(T0, ["audit", "--goal", "bug_fixes", "--tier", "local-exec", "--outcomes-input", materializePrs("monorepo-mixed", T0), ...imageArgs]);
const first = { json: read(".agent-readiness/latest/report.json"), md: read(".agent-readiness/latest/report.md") };

at("2026-10-28T15:00:00.000Z", ["roadmap", "owner", "Platform team"]);
at("2026-10-29T15:00:00.000Z", ["draft-env", "--remediate"]);
commitAt("2026-10-29T16:00:00.000Z", "Add the agent environment setup for Postgres");
edit("AGENTS.md", (s) => s.replace("- Run `pnpm test` before you push.\n", "- Run `npm test` before you push.\n").replace("- The service map is in `docs/architecture.md`.\n", ""));
edit(".cursor/skills/release-notes/SKILL.md", (s) => s.replace("Run `npm run changelog` to collect merged changes.", "List merged changes since the last tag with git log."));
commitAt("2026-10-29T17:00:00.000Z", "Fix stale agent instructions");

at("2026-10-30T15:00:00.000Z", ["audit", "--goal", "bug_fixes", "--tier", "local-exec", ...imageArgs]);
at("2026-10-30T16:00:00.000Z", ["draft-skill", "--remediate"]);
commitAt("2026-10-30T17:00:00.000Z", "Add the verify skill drafted by the readiness audit");

at("2026-11-06T13:00:00.000Z", ["recheck", ...imageArgs]);
edit("packages/shared/src/money.js", (s) => s.replace("export function isFree(cents) {\n", "export function isFree(cents) {\n  console.log(cents);\n"));
commitAt("2026-11-12T10:00:00.000Z", "Log free-order checks");
at("2026-11-13T13:00:00.000Z", ["recheck", ...imageArgs]);
edit("packages/shared/src/money.js", (s) => s.replace("  console.log(cents);\n", ""));
commitAt("2026-11-14T10:00:00.000Z", "Remove debug logging");
at("2026-11-20T13:00:00.000Z", ["recheck", ...imageArgs]);

const T2 = "2026-11-30T15:00:00.000Z";
at(T2, ["audit", "--goal", "bug_fixes", "--tier", "local-exec", "--outcomes-input", materializePrs("monorepo-mixed", T2, "prs-later.template.json"), ...imageArgs]);
const latest = { json: read(".agent-readiness/latest/report.json"), md: read(".agent-readiness/latest/report.md") };

const out = join(ACCELERATOR, "examples");
writeFileSync(join(out, "sample-report-first.md"), first.md);
writeFileSync(join(out, "sample-report-first.json"), first.json);
writeFileSync(join(out, "sample-report.md"), latest.md);
writeFileSync(join(out, "sample-report.json"), latest.json);
writeFileSync(join(out, "sample-snapshots.json"), JSON.stringify({ generatedFrom: "fixtures/monorepo-mixed via npm run sample", snapshots: [JSON.parse(first.json), JSON.parse(latest.json)] }, null, 2) + "\n");
process.stdout.write(`Wrote examples/sample-report.md, sample-report.json, sample-report-first.md, sample-report-first.json and sample-snapshots.json\n`);

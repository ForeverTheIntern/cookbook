import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCELERATOR, materialize, materializePrs, readiness } from "./fixture.ts";

const args = process.argv.slice(2);
const image = args.includes("--image") ? args[args.indexOf("--image") + 1] : undefined;
const T0 = "2026-10-27T15:00:00.000Z";

const repo = materialize("monorepo-mixed", { now: T0 });
process.stdout.write(`Sample repo: ${repo}\n`);

const cmd = ["audit", "--tier", "local-exec", "--scenario", "bug_fixes", "--outcomes-input", materializePrs("monorepo-mixed", T0), ...(image ? ["--image", image] : [])];
const r = readiness(repo, cmd, { SA_READINESS_NOW: T0, SA_READINESS_EVAL_SEED: "sample-seed" });
process.stdout.write(`readiness ${cmd.join(" ")} -> ${r.code}\n`);
if (r.code !== 0) throw new Error(r.out);

const out = join(ACCELERATOR, "examples");
for (const f of ["report.md", "report.json"]) writeFileSync(join(out, `sample-${f}`), readFileSync(join(repo, ".agent-readiness/latest", f), "utf8"));
process.stdout.write("Wrote examples/sample-report.md and sample-report.json\n");

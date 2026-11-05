#!/usr/bin/env node
// Validate a tracker against the schema rules.
//
//   node tracker-check.mjs [tracker.csv] [--json]
//
// Exits 1 when any rule is broken (errors), 0 when only warnings or nothing remain.

import { readFileSync } from "node:fs";
import { parseCsv, validate } from "./tracker-lib.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) ?? "tracker.csv";
const issues = validate(parseCsv(readFileSync(file, "utf8")));
const errors = issues.filter((i) => i.severity === "error");

if (args.includes("--json")) {
  console.log(JSON.stringify({ file, errors: errors.length, issues }, null, 2));
} else {
  for (const i of issues) console.log(`${i.severity.padEnd(7)} line ${i.line}${i.id ? ` ${i.id}` : ""}: ${i.message}`);
  console.log(`${file}: ${errors.length} errors, ${issues.length - errors.length} warnings`);
}
process.exit(errors.length ? 1 : 0);

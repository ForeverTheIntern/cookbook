#!/usr/bin/env node
// Pull the findings JSON object out of a reviewer's raw output and write it to a file.
//
//   node extract-findings.mjs <raw.txt> <out.json>
//
// Reviewers sometimes wrap the object in prose or emit invalid escapes such as \. inside
// strings; both are tolerated. Exits 1 if no valid findings object can be recovered.

import { readFileSync, writeFileSync } from "node:fs";

const [rawPath, outPath] = process.argv.slice(2);
const raw = readFileSync(rawPath, "utf8");
const start = raw.indexOf("{");
const end = raw.lastIndexOf("}");
if (start === -1 || end === -1) {
  console.error(`no JSON object in reviewer output:\n${raw.slice(-2000)}`);
  process.exit(1);
}
const text = raw.slice(start, end + 1);

function parse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Keep valid escapes, double any stray backslash, and escape raw control characters.
function repair(s) {
  return s
    .replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, valid) => (valid ? m : "\\\\"))
    .replace(/[\u0000-\u001f]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? c : ""));
}

const data = parse(text) ?? parse(repair(text)) ?? parse(repair(text).replace(/\n/g, "\\n"));
if (!data) {
  console.error("reviewer output isn't valid JSON, even after repair");
  process.exit(1);
}
for (const key of ["reviewer", "rubric", "summary", "overall", "findings"]) {
  if (!(key in data)) {
    console.error(`reviewer output is missing "${key}"`);
    process.exit(1);
  }
}
writeFileSync(outPath, JSON.stringify(data, null, 2));

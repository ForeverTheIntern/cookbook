#!/usr/bin/env node
// Static checks for the template. Run from anywhere:
//
//   node tests/check-template.mjs            all checks
//   node tests/check-template.mjs --update   also rewrite the dashboard snapshot
//
// Checks: [S-nn] citations resolve, sources are public, no customer identifiers or
// private links, frontmatter on skills/rules/commands/agents, relative links resolve,
// trackers pass tracker-check, the dashboard renders to its snapshot, and every eval
// case points at real fixtures and known gate types.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, validate } from "../plugins/pg-major-upgrade/scripts/tracker-lib.mjs";
import { renderDashboard } from "../plugins/pg-major-upgrade/scripts/render-dashboard.mjs";
import { gateTypes } from "../evals/graders.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins", "pg-major-upgrade");
const failures = [];
const fail = (check, msg) => failures.push(`${check}: ${msg}`);

const SKIP_DIRS = new Set([".tmp", "node_modules", "runs", "out", ".git"]);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(root);
const rel = (p) => path.relative(root, p);
const text = (p) => readFileSync(p, "utf8");
const textFiles = files.filter((f) => /\.(md|mdc|json|mjs|sh|sql|csv|tsx|txt|yaml)$/.test(f));

// 1. Citations resolve
const sources = JSON.parse(text(path.join(plugin, "reference", "sources.json"))).sources;
const sourceIds = new Set(sources.map((s) => s.id));
for (const f of files.filter((f) => /\.(md|mdc)$/.test(f))) {
  for (const m of text(f).matchAll(/\bS-\d{2}\b/g)) {
    if (!sourceIds.has(m[0])) fail("citations", `${rel(f)} cites unknown ${m[0]}`);
  }
}
for (const s of sources) {
  if (!s.quotes?.length) fail("sources", `${s.id} has no quotes`);
  if (!/^https:\/\//.test(s.url)) fail("sources", `${s.id} url isn't https`);
}

// 2. Public only: no private hosts or customer identifiers anywhere in the template
const PRIVATE_HOSTS = /(granola\.ai|gong\.io|\.slack\.com|slack\.com\/archives|notion\.so\/(?!acme)|docs\.google\.com\/(spreadsheets|document)|salesforce\.com|lightning\.force\.com|linear\.app\/(?!.*example))/i;
// SHA-256 prefixes of lowercased customer and people identifiers, so this public file
// doesn't name who it protects. Add one with:
//   node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1].toLowerCase()).digest("hex").slice(0,16))' <term>
// Extra plain terms can go in .tmp/denylist.txt (gitignored), one per line.
const DENY_HASHES = new Set(["0736098c0f6bc4b0", "098e2cd9d0e144ee", "3c705aec6a9955ef", "3d84c7b6d35e37c6", "630dc133336bc266", "78447b28dc50442d", "87da3b6aefc0bd62", "941943a02b7d0c7a", "9a9842d1ddc92dee", "9eb5f31f7974f59e", "a3da73976501812c", "aecef8011e1d69de", "af5f4c60baa1380d", "b002e14eb0889a3b", "b337951cb83ffa44", "bda3d3bce3447c7a", "d47c0e192f6df032", "edd7aab84c4709a0"]);
const localDeny = existsSync(path.join(root, ".tmp", "denylist.txt"))
  ? readFileSync(path.join(root, ".tmp", "denylist.txt"), "utf8").split(/\r?\n/).map((t) => t.trim().toLowerCase()).filter(Boolean)
  : [];
const hashTerm = (t) => createHash("sha256").update(t.toLowerCase()).digest("hex").slice(0, 16);
function deniedTerm(body) {
  for (const w of body.toLowerCase().match(/[a-z0-9_-]+/g) ?? []) {
    if (DENY_HASHES.has(hashTerm(w)) || localDeny.includes(w)) return w;
    for (const part of w.split(/[_-]/)) if (part !== w && (DENY_HASHES.has(hashTerm(part)) || localDeny.includes(part))) return part;
  }
  return null;
}
for (const f of textFiles) {
  if (f === fileURLToPath(import.meta.url)) continue;
  const body = text(f);
  const host = body.match(PRIVATE_HOSTS);
  if (host) fail("public-only", `${rel(f)} links a private host (${host[0]})`);
  const localPath = body.match(/\/(Users|home)\/(?!<)[A-Za-z0-9._-]+\//);
  if (localPath) fail("public-only", `${rel(f)} contains a local home path (${localPath[0]}); evals/run-evals.mjs redacts these`);
  const name = deniedTerm(body);
  if (name) fail("public-only", `${rel(f)} contains a denylisted customer or person identifier (${name})`);
}

// 3. Frontmatter
function frontmatter(body) {
  const m = body.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  return Object.fromEntries(m[1].split("\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
}
const need = [
  [/skills\/[^/]+\/SKILL\.md$/, ["name", "description"]],
  [/rules\/[^/]+\.mdc$/, ["description"]],
  [/commands\/[^/]+\.md$/, ["name", "description"]],
  [/agents\/[^/]+\.md$/, ["name", "description"]],
];
for (const f of files.filter((f) => f.startsWith(plugin))) {
  for (const [re, keys] of need) {
    if (!re.test(rel(f))) continue;
    const fm = frontmatter(text(f));
    if (!fm) { fail("frontmatter", `${rel(f)} has no frontmatter`); continue; }
    for (const k of keys) if (!fm[k]) fail("frontmatter", `${rel(f)} missing ${k}`);
    if (re.source.startsWith("skills") && fm.name && fm.name !== path.basename(path.dirname(f))) {
      fail("frontmatter", `${rel(f)} name ${fm.name} doesn't match its folder`);
    }
  }
}

// 4. Relative links in markdown resolve
for (const f of files.filter((f) => f.endsWith(".md"))) {
  for (const m of text(f).matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1].split("#")[0];
    if (!target || /^(https?:|mailto:|file:)/.test(target)) continue;
    if (!existsSync(path.resolve(path.dirname(f), target))) fail("links", `${rel(f)} -> ${m[1]} doesn't exist`);
  }
}

// 5. Trackers
for (const t of ["plugins/pg-major-upgrade/assets/tracker.csv", "evals/fixtures/acme/tracker.csv"]) {
  const errors = validate(parseCsv(text(path.join(root, t)))).filter((i) => i.severity === "error");
  for (const e of errors) fail("tracker", `${t} line ${e.line} ${e.id}: ${e.message}`);
}
const broken = validate(parseCsv(text(path.join(root, "evals/fixtures/acme/tracker-waived-no-approver.csv"))));
if (!broken.some((i) => i.id === "G0.7" && /Approver/.test(i.message))) fail("tracker", "waived-no-approver fixture should fail on G0.7");

// 6. Dashboard snapshot
const { canvas } = renderDashboard({
  trackerText: text(path.join(root, "evals/fixtures/acme/tracker.csv")),
  project: JSON.parse(text(path.join(root, "evals/fixtures/acme/project.json"))),
  today: "2026-11-04",
  generatedFrom: "tracker.csv (synthetic example)",
});
const snapshotPath = path.join(root, "tests", "dashboard.snapshot.canvas.tsx");
if (process.argv.includes("--update") || !existsSync(snapshotPath)) writeFileSync(snapshotPath, canvas);
else if (text(snapshotPath) !== canvas) fail("dashboard", "render differs from tests/dashboard.snapshot.canvas.tsx (rerun with --update if intended)");

// 7. Eval cases
const casesDir = path.join(root, "evals", "cases");
for (const f of walk(casesDir).filter((f) => f.endsWith(".json"))) {
  const c = JSON.parse(text(f));
  for (const k of ["id", "skill", "prompt", "gates"]) if (!c[k]) fail("evals", `${rel(f)} missing ${k}`);
  for (const [, src] of Object.entries(c.workspace ?? {})) {
    if (typeof src === "string" && src.startsWith("@") && !existsSync(path.join(root, "evals", src.slice(1)))) {
      fail("evals", `${rel(f)} fixture ${src} doesn't exist`);
    }
  }
  for (const g of c.gates ?? []) if (!gateTypes.includes(g.type)) fail("evals", `${rel(f)} unknown gate ${g.type}`);
}

if (failures.length) {
  console.error(`check-template: ${failures.length} problems`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log(`check-template: all checks passed (${files.length} files, ${sources.length} sources)`);

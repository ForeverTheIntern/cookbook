#!/usr/bin/env node
// Re-verify reference/sources.json against the live pages.
//
//   node scripts/check-sources.mjs            report only
//   node scripts/check-sources.mjs --write    also update dates and regenerate reference/sources.md
//   node scripts/check-sources.mjs --only S-01,S-14

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = path.join(root, "reference", "sources.json");
const mdPath = path.join(root, "reference", "sources.md");

const args = process.argv.slice(2);
const write = args.includes("--write");
const onlyArg = args.find((a) => a.startsWith("--only"));
const only = onlyArg ? (onlyArg.split("=")[1] ?? args[args.indexOf(onlyArg) + 1] ?? "").split(",") : null;

const today = new Date().toISOString().slice(0, 10);

function toText(body) {
  return body
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&rsquo;|&lsquo;/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalize(s) {
  return s.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").toLowerCase();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (source-check)" },
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) return { status: res.status, text: "" };
      const body = await res.text();
      const isHtml = (res.headers.get("content-type") ?? "").includes("html");
      return { status: res.status, text: normalize(isHtml ? toText(body) : body) };
    } catch (error) {
      if (attempt === 3) return { status: 0, text: "", error: String(error) };
      await sleep(2_000 * attempt);
    }
  }
}

// Large parallel bursts get throttled pages from some doc hosts, so check a few at a time
// and give a source with missing quotes one more fetch before reporting it.
async function check(source) {
  let result;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { status, text, error } = await fetchText(source.url);
    const missing = status === 200 ? source.quotes.filter((q) => !text.includes(normalize(q))) : source.quotes;
    result = { status, error, missing };
    if (status === 200 && missing.length === 0) break;
    await sleep(3_000);
  }
  return result;
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length > 0) await fn(queue.shift());
  });
  await Promise.all(workers);
}

const doc = JSON.parse(await readFile(jsonPath, "utf8"));
const targets = doc.sources.filter((s) => !only || only.includes(s.id));
let failures = 0;

await mapLimit(targets, 4, async (source) => {
    const { status, error, missing } = await check(source);
    source.lastChecked = today;
    source.status = status === 200 && missing.length === 0 ? "verified" : status === 200 ? "changed" : "unreachable";
    if (source.status === "verified") source.verified = today;
    source.missing = missing;
    if (source.status !== "verified") failures++;
    const note = source.status === "verified" ? "" : ` (${error ?? `HTTP ${status}`}; missing: ${missing.join(" | ")})`;
    console.log(`${source.status.padEnd(11)} ${source.id} ${source.title}${note}`);
});

if (write) {
  for (const s of doc.sources) delete s.missing;
  await writeFile(jsonPath, JSON.stringify(doc, null, 2) + "\n");
  await writeFile(mdPath, renderMarkdown(doc));
  console.log(`\nWrote ${path.relative(root, jsonPath)} and ${path.relative(root, mdPath)}`);
}

console.log(`\n${targets.length - failures} of ${targets.length} sources verified.`);
process.exit(failures > 0 ? 1 : 0);

function renderMarkdown({ sources }) {
  const rows = sources.map((s) => {
    const status = s.status === "verified" ? `Verified ${s.verified}` : `${s.status ?? "unchecked"} ${s.lastChecked ?? ""}`.trim();
    return `| ${s.id} | [${s.title}](${s.url}) | ${s.supports} | ${status} |`;
  });
  return `# Sources

Every factual claim in this template cites one of these public sources as \`[S-nn]\`. Each source lists exact quotes in [sources.json](sources.json). \`node scripts/check-sources.mjs --write\` re-fetches every page, confirms each quote still appears, and regenerates this file. A source whose quotes have moved is marked \`changed\`, and one that can't be fetched is marked \`unreachable\`. Treat claims that cite it as Unverified until someone rechecks.

Labels used in the docs:

- **Verified**: the cited page says it, and the quote check passed on the date shown.
- **Inferred**: reasoned from verified sources. The SOP says what it rests on.
- **Unverified**: no public source we could reach answers it. The SOP says how the rehearsal or the provider settles it.

Generated file. Edit \`sources.json\` instead.

| ID | Source | Supports | Status |
|---|---|---|---|
${rows.join("\n")}
`;
}

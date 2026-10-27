import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseFactory } from "../bot/lib/config/factory.ts";
import { CATALOG } from "../bot/lib/steps/catalog.ts";

const FACTORY_DIR = fileURLToPath(new URL("../..", import.meta.url));
const DOCS = [
  "README.md",
  "PREREQUISITES.md",
  ...readdirSync(join(FACTORY_DIR, "docs")).filter((f) => f.endsWith(".md")).map((f) => join("docs", f)),
];

interface Snippet {
  where: string;
  yaml: string;
}

function snippets(): Snippet[] {
  const found: Snippet[] = [];
  for (const doc of DOCS) {
    const lines = readFileSync(join(FACTORY_DIR, doc), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^```ya?ml\s*$/.test(lines[i])) continue;
      const end = lines.findIndex((line, j) => j > i && line.startsWith("```"));
      found.push({ where: `${relative(FACTORY_DIR, join(FACTORY_DIR, doc))}:${i + 1}`, yaml: lines.slice(i + 1, end).join("\n") });
      i = end;
    }
  }
  return found;
}

/**
 * The docs show the keys to change and say to keep the rest as shipped, so a
 * snippet is checked the way a reader applies it: its top-level keys replace
 * the shipped ones, and a repos: list replaces repo: and base:.
 */
function applied(snippet: Record<string, unknown>): Record<string, unknown> {
  const doc = { ...parse(readFileSync(join(FACTORY_DIR, "factory.yaml"), "utf8")), ...snippet };
  if ("repos" in snippet) {
    delete doc.repo;
    delete doc.base;
  }
  return doc;
}

test("the docs show factory.yaml snippets", () => {
  assert.ok(snippets().length >= 8, `found ${snippets().length} yaml blocks`);
});

for (const { where, yaml } of snippets()) {
  test(`${where}: the factory.yaml snippet loads`, () => {
    const snippet = parse(yaml);
    assert.equal(typeof snippet, "object", `${where} is not a YAML mapping`);
    try {
      parseFactory(applied(snippet), CATALOG);
    } catch (error) {
      assert.fail(`${where}: ${(error as Error).message}`);
    }
  });
}

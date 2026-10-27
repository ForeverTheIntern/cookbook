/**
 * The message templates in foreman/bot/templates/: the loader's syntax, and
 * that the code and the files agree, so a renamed or deleted template fails
 * here instead of in Slack.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadTemplates, render, TEMPLATES_DIR } from "../bot/lib/templates.ts";

const BOT = fileURLToPath(new URL("../bot/", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "templates" ? [] : sources(path);
    return name.endsWith(".ts") ? [readFileSync(path, "utf8")] : [];
  });
}

test("templates: headings, values, sections and errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "templates-"));
  writeFileSync(join(dir, "README.md"), "## ignored\nnot a topic\n");
  writeFileSync(join(dir, "demo.md"), "# Demo\n\nPreamble.\n\n## hello\nHi {{name}}{{#pr}}, see #{{pr}}{{/pr}}{{^pr}}, no PR yet{{/pr}}.\n\n## two.lines\nOne\n\nTwo\n\n");
  const tpl = loadTemplates(dir);
  assert.deepEqual([...tpl.keys()], ["demo.hello", "demo.two.lines"]);
  assert.equal(render(tpl, "demo.hello", { name: "Ada", pr: 7 }), "Hi Ada, see #7.");
  assert.equal(render(tpl, "demo.hello", { name: "Ada", pr: "" }), "Hi Ada, no PR yet.");
  assert.equal(render(tpl, "demo.two.lines"), "One\n\nTwo");
  assert.throws(() => render(tpl, "demo.hello", { name: "Ada" }), /needs \{\{pr\}\}/);
  assert.throws(() => render(tpl, "demo.missing"), /no message template demo\.missing/);
  writeFileSync(join(dir, "twice.md"), "## a\nx\n## a\ny\n");
  assert.throws(() => loadTemplates(dir), /defined twice/);
});

test("templates: every template is used, and every key the code names exists", () => {
  const code = sources(BOT).join("\n");
  const keys = [...loadTemplates(TEMPLATES_DIR).keys()];
  // Keys built at run time: `slack.icon.${kind}`, `stages.${stage}`, `status.${stage}`, and plural("x", n) for x.one and x.many.
  const prefixes = [...code.matchAll(/`([a-z-]+(?:\.[a-z-]+)*\.)\$\{/g)].map((m) => m[1]);
  const plurals = new Set([...code.matchAll(/plural\("([\w.-]+)"/g)].map((m) => m[1]));
  const unused = keys.filter((k) => {
    if (code.includes(`"${k}"`)) return false;
    if (plurals.has(k.replace(/\.(one|many)$/, ""))) return false;
    return !prefixes.some((p) => k.startsWith(p) && !k.slice(p.length).includes("."));
  });
  assert.deepEqual(unused, [], "templates no code uses");

  const named = [...code.matchAll(/\bt\("([\w.-]+)"/g), ...code.matchAll(/\? "([a-z]+\.[\w.-]+)" : "([a-z]+\.[\w.-]+)"/g)].flatMap((m) => m.slice(1));
  const missing = [...new Set(named)].filter((k) => !keys.includes(k));
  assert.deepEqual(missing, [], "keys with no template");
  for (const p of plurals) assert.ok(keys.includes(`${p}.one`) && keys.includes(`${p}.many`), `${p} needs .one and .many`);
});

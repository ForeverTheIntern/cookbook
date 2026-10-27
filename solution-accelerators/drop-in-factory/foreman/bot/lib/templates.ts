/**
 * The wording of every message Foreman posts in Slack, on issues and on pull
 * requests, read from bot/templates/. Each file is a topic; each `## name`
 * heading starts one template, which runs to the next heading. A template's
 * key is `<file>.<name>`, like `runs.hold`. `{{name}}` is filled from the
 * values the code passes. Code decides which template and what values;
 * everything a person reads is in the files.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

export type Values = Record<string, string | number>;

/** Every template in a directory of topic files, by key. README.md is not a topic. */
export function loadTemplates(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const topic = file.slice(0, -3);
    let name: string | null = null;
    let lines: string[] = [];
    const flush = () => {
      if (name === null) return;
      const key = `${topic}.${name}`;
      if (out.has(key)) throw new Error(`${file}: template ${name} is defined twice`);
      out.set(key, lines.join("\n").replace(/^\n+|\n+$/g, ""));
    };
    for (const line of readFileSync(`${dir}/${file}`, "utf8").replace(/\r\n/g, "\n").split("\n")) {
      const heading = /^## (\S+)\s*$/.exec(line);
      if (heading !== null) {
        flush();
        name = heading[1];
        lines = [];
      } else if (name !== null) {
        lines.push(line);
      }
    }
    flush();
  }
  return out;
}

const TEMPLATES = loadTemplates(TEMPLATES_DIR);

/** A GitHub Markdown link, passed to a template as one value. */
export function mdLink(text: string, url: string): string {
  return `[${text}](${url})`;
}

/**
 * Fill a template. `{{#name}}...{{/name}}` shows its text only when name is
 * not "", and `{{^name}}...{{/name}}` only when it is. A missing template or
 * value throws, so a typo fails in tests, not in Slack.
 */
export function render(templates: Map<string, string>, key: string, values: Values = {}): string {
  const text = templates.get(key);
  if (text === undefined) throw new Error(`no message template ${key} in bot/templates/`);
  const value = (name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`message template ${key} needs {{${name}}}`);
    return String(v);
  };
  return text
    .replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, kind: string, name: string, inner: string) => ((value(name) !== "") === (kind === "#") ? inner : ""))
    .replace(/\{\{(\w+)\}\}/g, (_, name: string) => value(name));
}

/** A message from bot/templates/. */
export const t = (key: string, values: Values = {}): string => render(TEMPLATES, key, values);

/** One template of a count: `<key>.one` for 1, else `<key>.many`, each with {{n}}. */
export const plural = (key: string, n: number, values: Values = {}): string => t(`${key}.${n === 1 ? "one" : "many"}`, { ...values, n });

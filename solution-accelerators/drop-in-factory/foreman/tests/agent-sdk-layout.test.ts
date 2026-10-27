import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const FOREMAN = fileURLToPath(new URL("../", import.meta.url));

/**
 * Warnings the Agent SDK raises on this project that are known and harmless. Anything
 * else (a step folder the Agent SDK can't read, a tool or skill it can't load) fails.
 */
const KNOWN = [
  // Every GitHub handler returns a host task, never a chat session, so a fresh session per delivery is what it wants.
  /omitted continuation stamped github\.none\/v2/,
  // Message wording, read by lib/templates.ts. The Agent SDK has no slot for it and loads nothing from it.
  /Unrecognized directory "templates" under bot\//,
];

test("the Agent SDK discovers the bot: each step folder as a subagent, and the skills, tools, channels, schedule and hook", async () => {
  process.env.FOREMAN_SLACK_BOT_TOKEN = "";
  const { loadProject, ProjectLoadError } = await import(new URL("../node_modules/@grok/agent-sdk/dist/index.js", import.meta.url).href);
  let project;
  try {
    project = await loadProject(FOREMAN, { strict: true });
  } catch (error) {
    if (!(error instanceof ProjectLoadError)) throw error;
    const unknown = (error as { diagnostics: { message: string; path?: string }[] }).diagnostics.filter((d) => !KNOWN.some((k) => k.test(d.message)));
    assert.deepEqual(unknown.map((d) => `${d.path}: ${d.message}`), []);
    project = await loadProject(FOREMAN);
  }
  const info = project.info;
  assert.deepEqual(info.subagents.map((s: { name: string }) => s.name).sort(), ["implement", "plan", "review", "spec", "triage", "verify"]);
  assert.ok(info.subagents.every((s: { description?: string; model?: unknown }) => (s.description ?? "").length > 0 && s.model !== undefined));
  assert.deepEqual(info.skills.map((s: { name: string }) => s.name), ["walkthrough-video"]);
  assert.deepEqual(info.tools.map((t: { name: string }) => t.name).sort(), ["abandon", "answer", "gate", "open_request", "runs"]);
  assert.deepEqual(info.channels.map((c: { id?: string; name?: string }) => c.id ?? c.name).sort(), ["github", "http", "slack"]);
  assert.deepEqual(info.schedules.map((s: { name: string }) => s.name), ["tick"]);
  assert.deepEqual(info.hooks, ["audit"]);
});

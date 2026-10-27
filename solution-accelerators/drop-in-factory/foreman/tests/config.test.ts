import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ConfigError, parseFactory } from "../bot/lib/config/factory.ts";
import { loadFactory } from "../bot/lib/config/load.ts";
import { CATALOG } from "../bot/lib/steps/catalog.ts";

const parseConfig = (doc: unknown) => parseFactory(doc, CATALOG).repos[0];
const FACTORY_DIR = fileURLToPath(new URL("../..", import.meta.url));

const shipped = () => parse(readFileSync(join(FACTORY_DIR, "factory.yaml"), "utf8"));
const isTemplate = /^repo: example-org\/example-repo$/m.test(readFileSync(join(FACTORY_DIR, "factory.yaml"), "utf8"));

test("factory.yaml is valid", () => {
  assert.ok(loadFactory(join(FACTORY_DIR, "factory.yaml")).repos.length > 0);
});

test("the template's factory.yaml ships placeholders", { skip: !isTemplate && "factory.yaml holds this copy's own settings" }, () => {
  const config = loadFactory(join(FACTORY_DIR, "factory.yaml")).repos[0];
  assert.equal(config.base, "main");
  assert.equal(config.steps.find((e) => e.step?.id === "implement")?.step?.settings.deadlineMinutes, 60);
  assert.equal(config.slack?.channel, "C0123456789");
  assert.equal(config.slack?.testerBot, null);
});

test("an unknown key names itself", () => {
  const doc = shipped();
  doc.steps[2].aprovers = ["x"];
  assert.throws(() => parseConfig(doc), (e: Error) => e instanceof ConfigError && /steps\[2\]\.aprovers/.test(e.message));
});

test("a missing key names itself; there are no defaults", () => {
  const doc = shipped();
  delete doc.dora.weeks;
  assert.throws(() => parseConfig(doc), /dora\.weeks/);
});

test("slack is optional, but its ids are checked", () => {
  const doc = shipped();
  delete doc.slack;
  assert.equal(parseConfig(doc).slack, null);
  doc.slack = { channel: "general", testerBot: "B0123456789" };
  assert.throws(() => parseConfig(doc), /slack\.channel/);
  doc.slack.channel = "C0123456789";
  assert.equal(parseConfig(doc).slack?.testerBot, "B0123456789");
});

test("a gate needs at least one approver", () => {
  const doc = shipped();
  doc.steps[4].approvers = [];
  assert.throws(() => parseConfig(doc), /steps\[4\]\.approvers/);
});

test("dashboard is on by default, and can be turned off or given a URL", () => {
  const doc = shipped();
  delete doc.dashboard;
  assert.deepEqual(parseFactory(doc, CATALOG).dashboard, { enabled: true, url: null });
  doc.dashboard = { enabled: false };
  assert.deepEqual(parseFactory(doc, CATALOG).dashboard, { enabled: false, url: null });
  doc.dashboard = { enabled: true, url: "https://factory.example.com" };
  assert.equal(parseFactory(doc, CATALOG).dashboard.url, "https://factory.example.com");
  doc.dashboard = { enabled: true, url: "factory.example.com" };
  assert.throws(() => parseFactory(doc, CATALOG), /dashboard\.url/);
  doc.dashboard = { url: "https://factory.example.com" };
  assert.throws(() => parseFactory(doc, CATALOG), /dashboard\.enabled is missing/);
  doc.dashboard = { enabled: true, secret: "x" };
  assert.throws(() => parseFactory(doc, CATALOG), /dashboard\.secret is not a factory\.yaml key/);
});

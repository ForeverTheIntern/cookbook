/**
 * The contract every implementation of `Ports` meets. The pipeline relies on
 * exactly these behaviors; a new implementation (another code host, agent
 * runner or chat) joins `implementations` and must pass unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TERMINAL } from "../bot/lib/steps/cloud-agent.ts";
import { livePorts, type Ports } from "../bot/lib/pipeline/ports.ts";
import { World } from "./fakes.ts";

const implementations: { name: string; make: () => Ports }[] = [{ name: "in-memory", make: () => new World().ports() }];

const methods = (ports: Ports) => ({
  github: Object.keys(ports.github).sort(),
  agents: Object.keys(ports.agents).sort(),
  slack: ports.slack === null ? null : Object.keys(ports.slack).sort(),
});

test("livePorts exposes every Ports call the contract covers", () => {
  const live = livePorts({ githubToken: "unused", factoryToken: "unused", repo: "acme/app", base: "main", cursorApiKey: "unused", slackBotToken: "unused" });
  for (const impl of implementations) assert.deepEqual(methods(live), methods(impl.make()), impl.name);
  assert.equal(livePorts({ githubToken: "unused", factoryToken: "unused", repo: "acme/app", base: "main", cursorApiKey: "unused", slackBotToken: null }).slack, null);
});

for (const impl of implementations) {
  test(`${impl.name}: branches`, async () => {
    const { github } = impl.make();
    const base = await github.baseSha();
    assert.ok(base.length > 0);
    assert.equal(await github.branchSha("factory/conformance-missing"), null);
    await github.createBranch("factory/conformance", base);
    assert.equal(await github.branchSha("factory/conformance"), base);
    assert.equal(await github.readFile("no/such/file.md", base), null);
    assert.deepEqual(await github.changedFiles(base, base), []);
    await github.deleteBranch("factory/conformance");
    assert.equal(await github.branchSha("factory/conformance"), null);
  });

  test(`${impl.name}: issues and comments`, async () => {
    const { github } = impl.make();
    const created = await github.createIssue("Conformance", "Body.", []);
    const issue = await github.issue(created.number);
    assert.deepEqual({ title: issue.title, body: issue.body, state: issue.state }, { title: "Conformance", body: "Body.", state: "open" });
    assert.equal(issue.url, created.url);
    await github.comment(created.number, "First note.");
    assert.equal((await github.comments(created.number)).at(-1)?.body, "First note.");
    await github.closeIssue(created.number, "completed");
    assert.equal((await github.issue(created.number)).state, "closed");
  });

  test(`${impl.name}: pull requests`, async () => {
    const { github } = impl.make();
    await github.createBranch("factory/conformance-pr", await github.baseSha());
    const opened = await github.openDraft("factory/conformance-pr", "Conformance", "Body.");
    assert.deepEqual({ draft: opened.draft, state: opened.state, merged: opened.merged }, { draft: true, state: "open", merged: false });
    assert.equal((await github.pullForBranch("factory/conformance-pr"))?.number, opened.number);
    assert.equal(await github.pullForBranch("factory/conformance-none"), null);
    await github.markReady(opened);
    assert.equal((await github.pull(opened.number)).draft, false);
    await github.closePull(opened.number);
    assert.equal((await github.pull(opened.number)).state, "closed");
  });

  test(`${impl.name}: cloud agents`, async () => {
    const { agents } = impl.make();
    const launched = await agents.launch({ repo: "acme/app", branch: "factory/conformance", model: "m", prompt: "p" });
    assert.ok(launched.id.length > 0);
    assert.equal(launched.branch, "factory/conformance");
    assert.equal((await agents.status(launched.id)).id, launched.id);
    await agents.stop(launched.id);
    assert.ok(TERMINAL.has((await agents.status(launched.id)).status));
  });

  test(`${impl.name}: slack`, async () => {
    const { slack } = impl.make();
    assert.notEqual(slack, null);
    const ts = await slack!.post("C0123456789", "Run started.", null);
    assert.ok(ts.length > 0);
    assert.ok((await slack!.post("C0123456789", "Next stage.", ts)).length > 0);
  });
}

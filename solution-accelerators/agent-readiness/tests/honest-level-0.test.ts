import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startArgs } from "../skill/agent-readiness/scripts/lib/container.ts";
import { diagnose } from "../skill/agent-readiness/scripts/lib/diagnose.ts";
import { buildProfile, discoverLayout } from "../skill/agent-readiness/scripts/lib/profile.ts";
import { environmentLimit } from "../skill/agent-readiness/scripts/lib/replay.ts";
import { loadRubric } from "../skill/agent-readiness/scripts/lib/rubric.ts";
import { notShipped, safetyScan } from "../skill/agent-readiness/scripts/lib/static.ts";
import type { ContractCommand, Diagnosis } from "../skill/agent-readiness/scripts/lib/types.ts";
import { makeAudit, reportFor } from "./helpers.ts";

const rubric = loadRubric("2026-11-alpha");
const fakeAws = () => "AKIA" + "QRSTUVWXYZ234567";

function tree(files: Record<string, string>, name = "repo"): string {
  const dir = join(mkdtempSync(join(tmpdir(), "readiness-ws2-")), name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const layout = (dir: string, files: Record<string, string>, repoName?: string) => discoverLayout(dir, Object.keys(files), repoName);
const cmd = (kind: ContractCommand["kind"], cwd = "packages/app"): ContractCommand => ({ id: `cmd-x-${kind}`, kind, component: "app", cwd, command: "npm run x", source: "readiness", reason: "x", timeoutSec: 60 });
const container = { where: "container" as const, image: "python:3.12-slim", imageSource: "audit" as const };

describe("secrets in tests, docs and generated code", () => {
  test("are listed for review; the same key in a shipped file blocks", () => {
    const key = `AWS_ACCESS_KEY_ID=${fakeAws()}\n`;
    const files = { "package.json": "{}", "test/support/keys.js": key, "src/app.test.ts": key, "docs/setup.md": key, "README.md": key, "src/__generated__/client.ts": key, ".env.example": key, "config/dev.env": key };
    const dir = tree(files);
    const found = safetyScan(dir, buildProfile(dir, dir, rubric)).filter((f) => f.kind === "secret");
    assert.deepEqual(found.filter((f) => f.blocking).map((f) => f.file), ["config/dev.env"]);
    assert.equal(found.filter((f) => !f.blocking).length, 6);
    for (const f of found) assert.ok(!f.detail.includes(fakeAws()), "the value never reaches the finding");
  });

  test("path rules", () => {
    for (const f of ["tests/conftest.py", "spec/requests/api_spec.rb", "pkg/foo_test.go", "test_app.py", "e2e/login.ts", "www/docs/guide.mdx", "examples/basic/main.py", "dist/bundle.js", "coverage/lcov.info"]) assert.ok(notShipped(f), f);
    for (const f of ["src/config.ts", "config/dev.env", ".env", "app/settings.py", "deploy/values.yaml"]) assert.equal(notShipped(f), null, f);
  });
});

describe("failures from the audit's own environment are blocked, not the repo's", () => {
  const d = (cause: Diagnosis["cause"], detail: string): Diagnosis => ({ cause, detail });

  test("a tool missing from an image the audit picked, not from the repo's declared image", () => {
    assert.equal(environmentLimit(container, cmd("install", "."), d("missing_tool", "poetry is not installed"), []), "poetry is not installed in the audit's image (python:3.12-slim)");
    assert.equal(environmentLimit({ ...container, imageSource: "override" }, cmd("test"), d("missing_tool", "bun is not installed"), []), "bun is not installed in the audit's image (python:3.12-slim)");
    assert.equal(environmentLimit({ ...container, imageSource: "repo" }, cmd("test"), d("missing_tool", "bun is not installed"), []), undefined);
    assert.equal(environmentLimit({ where: "fresh_copy", image: null, imageSource: null }, cmd("test"), d("missing_tool", "dotnet is not installed"), []), "dotnet is not installed on this machine");
  });

  test("network, TLS and proxy errors while the network is on; a test that reaches out with it off is the repo's", () => {
    const tls = diagnose("npm error code UNABLE_TO_GET_ISSUER_CERT_LOCALLY\nnpm error unable to get local issuer certificate", false, "install");
    assert.deepEqual(tls, { cause: "network", detail: "a TLS or certificate error on the network" });
    assert.equal(environmentLimit(container, cmd("install"), tls, []), "the install hit a TLS or certificate error on the network");
    assert.equal(environmentLimit(container, cmd("build"), diagnose("TypeError: fetch failed\n  [cause]: ECONNRESET", false, "build"), []), "the build hit a network connection failed");
    assert.equal(environmentLimit(container, cmd("test"), diagnose("getaddrinfo ENOTFOUND api.example.com", false, "test"), []), undefined);
    assert.equal(diagnose("pip._vendor.urllib3.exceptions.ProxyError: Cannot connect to proxy.", false, "install").detail, "a proxy error on the network");
    assert.equal(diagnose("WARNING: Retrying ... SSLError(SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed'))", false, "install").detail, "a TLS or certificate error on the network");
    assert.equal(diagnose("connect ECONNREFUSED 127.0.0.1:5432", false, "test").cause, "service", "a local service is still a service");
  });

  test("a sibling workspace package the audit didn't build first", () => {
    const pkgs = [{ name: "@fx/core", path: "packages/core" }, { name: "@fx/app", path: "packages/app" }];
    const missing = diagnose("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/node_modules/@fx/core/dist/index.js' imported from /work/packages/app/scripts/build.mjs\n    at finalizeResolution (node:internal)\n  code: 'ERR_MODULE_NOT_FOUND'", false, "build");
    assert.deepEqual(missing, { cause: "missing_module", detail: "module /work/node_modules/@fx/core/dist/index.js is missing" }, "one line, not the stack trace");
    assert.equal(environmentLimit(container, cmd("build"), missing, pkgs), "@fx/core is a sibling package the audit didn't build first, which isn't supported yet");
    assert.match(environmentLimit(container, cmd("test"), d("missing_module", "module @fx/core is missing"), pkgs) ?? "", /^@fx\/core is a sibling/);
    assert.equal(environmentLimit(container, cmd("test"), d("missing_module", "module left-pad is missing"), pkgs), undefined, "a missing third-party module is the repo's");
  });

  test("python3-venv missing from the Node image is a missing tool", () => {
    assert.deepEqual(diagnose("The virtual environment was not created successfully because ensurepip is not available.", false, "install"), { cause: "missing_tool", detail: "python3-venv is not installed" });
  });

  test("the container gets the host's proxy settings and CA files", () => {
    const args = startArgs("c", "node:22", "/h", ["NPM_TOKEN"], { HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "localhost", NODE_EXTRA_CA_CERTS: "/etc/corp/ca.pem", SSL_CERT_FILE: "relative.pem", HTTP_PROXY: "" }, (p) => p === "/etc/corp/ca.pem");
    const pairs = args.map((a, i) => `${a} ${args[i + 1]}`);
    assert.ok(pairs.includes("-e HTTPS_PROXY") && pairs.includes("-e NO_PROXY") && pairs.includes("-e NPM_TOKEN"));
    assert.ok(pairs.includes("-e NODE_EXTRA_CA_CERTS") && pairs.includes("-v /etc/corp/ca.pem:/etc/corp/ca.pem:ro"));
    assert.ok(!args.includes("HTTP_PROXY") && !args.includes("SSL_CERT_FILE"), "unset or relative values aren't passed");
  });
});

describe("stacks the audit doesn't support yet", () => {
  test("Poetry, Bun, Yarn 2 and uv workspaces are recognised and assessed; Yarn 2 with no pin isn't", () => {
    const cases: [Record<string, string>, string, boolean][] = [
      [{ "pyproject.toml": "[tool.poetry]\nname = \"cleo\"\n", "poetry.lock": "", "cleo/__init__.py": "" }, "poetry", true],
      [{ "pyproject.toml": "[tool.poetry]\nname = \"cleo\"\n", "cleo/__init__.py": "" }, "poetry", true],
      [{ "package.json": "{\"name\":\"elysia\",\"scripts\":{\"test\":\"bun test\"}}", "bun.lock": "{}" }, "bun", true],
      [{ "package.json": "{\"name\":\"medusa\",\"packageManager\":\"yarn@4.1.0\",\"scripts\":{\"test\":\"jest\"}}", "yarn.lock": "__metadata:\n  version: 8\n" }, "yarn-berry", true],
      [{ "package.json": "{\"name\":\"medusa\",\"scripts\":{\"test\":\"jest\"}}", "yarn.lock": "__metadata:\n  version: 8\n" }, "yarn-berry-unpinned", false],
      [{ "pyproject.toml": "[project]\nname = \"app\"\n\n[tool.uv.workspace]\nmembers = [\"backend\"]\n", "uv.lock": "", "app.py": "" }, "uv-workspace", true],
    ];
    for (const [files, stack, assessed] of cases) {
      const dir = tree(files);
      const [c] = buildProfile(dir, dir, rubric).components;
      assert.deepEqual([c.stack, c.assessed], [stack, assessed], JSON.stringify(files));
      if (!assessed) assert.match(c.notAssessedReason ?? "", / isn't supported yet: /);
    }
    const yarn1 = tree({ "package.json": "{\"name\":\"a\",\"packageManager\":\"yarn@1.22.22\",\"scripts\":{\"test\":\"node --test\"}}", "yarn.lock": "# yarn lockfile v1\n" });
    assert.equal(buildProfile(yarn1, yarn1, rubric).components[0].assessed, true, "Yarn 1 is still supported");
  });

  test("a Python app next to a root package.json is its own component and takes its files", () => {
    const files = { "package.json": "{\"name\":\"saleor\",\"scripts\":{\"release\":\"release-it\"}}", "package-lock.json": "{}", "pyproject.toml": "[project]\nname = \"saleor\"\n", "saleor/core.py": "", "tests/test_core.py": "" };
    const comps = layout(tree(files), files).components;
    assert.deepEqual(comps.map((c) => [c.id, c.path, c.assessed, c.notAssessedReason]), [
      ["saleor", ".", false, "it has no tests of its own, and the Python app next to it isn't supported yet"],
      ["saleor-python", ".", false, "a Python app next to a root package.json isn't supported yet: the audit runs one image per repo, and it picks Node's"],
    ]);
    const withTests = { ...files, "package.json": "{\"name\":\"web\",\"scripts\":{\"test\":\"node --test\"}}" };
    assert.equal(layout(tree(withTests), withTests).components[0].notAssessedReason, undefined, "a root package with its own tests is still assessed");
    const php = { "package.json": "{\"scripts\":{\"build\":\"vite build\"}}", "composer.json": "{\"name\":\"laravel/laravel\"}", "app/Models/User.php": "", "tests/Feature/ExampleTest.php": "", "config/app.php": "" };
    const lv = layout(tree(php), php);
    assert.deepEqual(lv.components.map((c) => [c.id, c.toolchain ?? c.language]), [["root", "js"], ["laravel", "PHP"]]);
    assert.deepEqual(lv.satellites, [], "the PHP app's own tests/ and config/ aren't satellites or components");
  });

  test("Swift, Dart and Terraform root modules are found; packaging and examples folders are satellites", () => {
    const swift = { "Package.swift": "let package = Package(\n    name: \"ArgumentParser\",\n)", "Sources/ArgumentParser/Parser.swift": "" };
    assert.deepEqual(layout(tree(swift), swift).components.map((c) => [c.id, c.toolchain]), [["ArgumentParser", "Swift"]]);
    const dart = { "pubspec.yaml": "name: ws\nworkspace:\n  - pkgs/http\n", "pkgs/http/pubspec.yaml": "name: http\n", "pkgs/http/lib/http.dart": "", "pkgs/http/example/android/app/build.gradle": "", "pkgs/web_socket/pubspec.yaml": "name: web_socket\n" };
    assert.deepEqual(layout(tree(dart), dart).components.map((c) => [c.id, c.toolchain]), [["http", "Dart"], ["web_socket", "Dart"]]);
    const tf = { "main.tf": "", "variables.tf": "", "modules/endpoints/main.tf": "", "examples/complete/main.tf": "", "wrappers/main.tf": "" };
    const t = layout(tree(tf, "terraform-aws-vpc"), tf, "terraform-aws-vpc");
    assert.deepEqual(t.components.map((c) => [c.id, c.path, c.manifest]), [["terraform-aws-vpc", ".", "main.tf"]]);
    assert.deepEqual(t.satellites.map((s) => [s.path, s.toolchain]), [["examples", "Terraform"]]);
    const nested = { "package.json": "{\"name\":\"app\",\"scripts\":{\"test\":\"node --test\"}}", "package-lock.json": "{}", "deploy/terraform/prod/main.tf": "", "deploy/terraform/prod/vars.tf": "" };
    assert.deepEqual(layout(tree(nested), nested).components.map((c) => [c.id, c.path]), [["app", "."], ["prod", "deploy/terraform/prod"]], "a nested Terraform root module is found by its folder");
    const rust = { "Cargo.toml": "[package]\nname = \"ripgrep\"\n", "src/main.rs": "", "HomebrewFormula/rg.rb": "", "pkg/brew/rg.rb": "", "tests/regression.rs": "" };
    const r = layout(tree(rust), rust);
    assert.deepEqual(r.components.map((c) => c.id), ["ripgrep"]);
    assert.deepEqual(r.satellites.map((s) => [s.path, s.toolchain]), [["HomebrewFormula", "Ruby"], ["pkg", "Ruby"]]);
  });

  test(".NET is named after the solution that matches the repo, or the repo, never the first solution", () => {
    const files = { "ShareX.ImageEditor.sln": "", "ShareX.sln": "", "ShareX/Program.cs": "" };
    assert.deepEqual(layout(tree(files, "ShareX"), files, "ShareX").components.map((c) => [c.id, c.manifest]), [["ShareX", "ShareX.sln"]]);
    const other = { "Tools.sln": "", "Editor.sln": "", "src/A.cs": "" };
    assert.deepEqual(layout(tree(other, "desktop-suite"), other, "desktop-suite").components.map((c) => c.id), ["desktop-suite"]);
    const single = { "Serilog.sln": "", "src/Log.cs": "" };
    assert.deepEqual(layout(tree(single, "serilog"), single, "serilog").components.map((c) => c.id), ["Serilog"], "a sole solution keeps its own name");
  });
});

describe("part 1 says what isn't assessed, in grammatical sentences", () => {
  test("the not-assessed headline reads as a sentence", () => {
    const audit = makeAudit({ components: [{ id: "parser", share: 1, assessed: false, test: "missing" }] });
    audit.profile!.components[0].notAssessedReason = "Swift isn't supported yet";
    const r = reportFor(audit);
    assert.equal(r.executive.headline, "No component could be assessed, so this audit can't give a level yet: it skipped parser (100% of changes) because Swift isn't supported yet.");
    assert.deepEqual(r.executive.unassessed, { share: 1, text: "100% of recent changes aren't assessed: parser (100%), because Swift isn't supported yet", supportDoc: "references/supported.md" });
    const none = makeAudit({ components: [] });
    assert.doesNotMatch(reportFor(none).executive.headline, /it skipped the audit/);
  });

  test("an unassessed share appears in part 1 even when the assessed part is at Level 2", () => {
    const audit = makeAudit({ components: [{ id: "web", share: 0.6, faults: "pass", lint: "pass" }, { id: "inventory", share: 0.4, assessed: false, test: "missing" }], lockfile: "pass" });
    audit.profile!.components[1].notAssessedReason = "Go isn't supported yet";
    const r = reportFor(audit);
    assert.equal(r.maturity.level, 2);
    assert.equal(r.maturity.confidence.level, "medium");
    assert.equal(r.executive.unassessed?.text, "40% of recent changes aren't assessed: inventory (40%), because Go isn't supported yet");
  });
});

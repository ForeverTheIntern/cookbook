import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendRow, currentRow, readLedger, writeLedger } from "../lib/doctor/ledger.ts";
import {
  cliConfigEmail,
  cliLine,
  deploySourceLine,
  expandPids,
  githubAppLine,
  hostedSecretsLine,
  keyOwnerLine,
  NODE_MINIMUM,
  nodeLine,
  parseLsof,
  parseNetstat,
  parseProcNet,
  portsLine,
  repoFromRemote,
  sameTeamLine,
  teamLine,
} from "../lib/doctor/report.ts";
import { claimants, claimedRun, issueBody } from "../lib/verify-run.ts";
import { deploymentFrom, jsonFrom, lastDeploy, type DeployRecord } from "../lib/doctor/deployed.ts";
import { deployRepoUrl, digestOf } from "../lib/doctor/source.ts";

test("a leftover on 8790 fails, and the portal port may be taken", () => {
  const line = portsLine(
    [
      { port: 8787, pid: 10, command: "next-server", cwd: "/factory/portal" },
      { port: 8790, pid: 11, command: "next-server", cwd: "/tmp/old" },
    ],
    8787,
    null,
  );
  assert.equal(line.status, "fail");
  assert.match(line.text, /8790 pid 11/);
});

test("a verification run requires the portal pid to be one it started", () => {
  const allowed = expandPids([4], [{ pid: 4, ppid: 1 }, { pid: 9, ppid: 4 }]);
  assert.deepEqual(allowed.sort((a, b) => a - b), [4, 9]);
  const ours = portsLine([{ port: 8787, pid: 9, command: "next-server", cwd: "/portal" }, { port: 8790, pid: null, command: "", cwd: "" }], 8787, allowed);
  assert.equal(ours.status, "ok");
  const stranger = portsLine([{ port: 8787, pid: 99, command: "next-server", cwd: "/other" }, { port: 8790, pid: null, command: "", cwd: "" }], 8787, allowed);
  assert.equal(stranger.status, "fail");
});

test("lsof field output parses one listener", () => {
  assert.deepEqual(parseLsof("p42\ncnode\nn127.0.0.1:8787\n"), [{ pid: 42, command: "node" }]);
  assert.deepEqual(parseLsof(""), []);
});

test("Windows netstat output parses listeners by a remote port of 0, in any display language", () => {
  const output = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       4120",
    "  TCP    127.0.0.1:8787         127.0.0.1:53011        ESTABLISHED     4120",
    "  TCP    0.0.0.0:8790           0.0.0.0:0              ABHÖREN         5236",
    "  TCP    [::1]:4318             [::]:0                 LISTENING       812",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       0",
  ].join("\r\n");
  assert.deepEqual(parseNetstat(output), [{ port: 8787, pid: 4120 }, { port: 8790, pid: 5236 }, { port: 4318, pid: 812 }]);
  assert.deepEqual(parseNetstat(""), []);
});

test("the Linux socket table yields a listen port and inode", () => {
  const text = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:2253 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11988 1 00000000 100 0 0 10 0",
    "   1: 0100007F:0BB8 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 16524 1 00000000 100 0 0 10 0",
  ].join("\n");
  assert.deepEqual(parseProcNet(text), [{ port: 8787, inode: "11988" }]);
  assert.deepEqual(parseProcNet(""), []);
});

test("CLI auth fails when the stored login is a different account", () => {
  const bad = cliLine({
    whoamiEmail: "factory@example.com",
    whoamiTeam: "Example",
    source: "env",
    whoamiError: null,
    keyEmail: "factory@example.com",
    storedEmail: "other@example.com",
    authTokenSet: false,
  });
  assert.equal(bad.status, "fail");
  assert.match(bad.text, /stored CLI login/);
  const good = cliLine({ ...blankCli(), whoamiEmail: "factory@example.com", keyEmail: "Factory@example.com", source: "env", authTokenSet: true });
  assert.equal(good.status, "ok");
  assert.match(good.text, /CURSOR_AUTH_TOKEN is also set/);
});

test("cli-config email is read and tokens are not", () => {
  assert.equal(cliConfigEmail({ authInfo: { email: "factory@example.com", accessToken: "secret" } }), "factory@example.com");
  assert.equal(cliConfigEmail({}), null);
});

test("team id and name are checked only against the expected values that are set", () => {
  assert.equal(teamLine({ id: "42", name: "Example", error: null, expectedId: "", expectedName: "" }).status, "ok");
  assert.equal(teamLine({ id: "42", name: "Example", error: null, expectedId: "7", expectedName: "" }).status, "fail");
  assert.equal(teamLine({ id: "42", name: "Example", error: null, expectedId: "42", expectedName: "example" }).status, "ok");
  assert.match(teamLine({ id: null, name: null, error: "GetMe returned 500", expectedId: "", expectedName: "" }).text, /500/);
});

test("a service-account key on another team fails", () => {
  const line = sameTeamLine(42..toString(), { name: "CURSOR_SERVICE_ACCOUNT_KEY", email: null, apiKeyName: "bot", teamId: "7", teamName: "Other" });
  assert.equal(line.status, "fail");
  assert.match(line.text, /not the launch key's team/);
  assert.equal(keyOwnerLine({ email: "factory@example.com", apiKeyName: "factory", teamId: "42", teamName: "Example" }).text.includes("factory@example.com"), true);
});

test("the GitHub App line names every configured repository the installation misses", () => {
  const line = githubAppLine(["example/api", "example/web"], [{ owner: "Example", name: "api" }]);
  assert.equal(line.status, "fail");
  assert.match(line.text, /example\/web/);
  assert.equal(githubAppLine(["example/api"], [{ owner: "example", name: "api" }]).status, "ok");
});

const record: DeployRecord = {
  at: "2026-10-25T00:00:00Z", slug: "foreman", releaseId: "rel-1", teamId: "42",
  repo: "https://github.com/example/app", ref: "main", sha: "a".repeat(40), path: "factory/foreman", digest: "d1",
};

test("the hosted release check stays off unless the flag is on, and passes only for the recorded release and the same files", () => {
  const base = { enabled: true, slug: "foreman", record, liveReleaseId: "rel-1", headDigest: "d1", error: null };
  assert.equal(deploySourceLine({ ...base, enabled: false }).status, "info");
  assert.equal(deploySourceLine(base).status, "ok");
  assert.match(deploySourceLine({ ...base, liveReleaseId: "rel-2" }).text, /runs release rel-2, but the last recorded deploy is release rel-1/);
  assert.match(deploySourceLine({ ...base, headDigest: "d2" }).text, /files differ from this folder at HEAD/);
  assert.match(deploySourceLine({ ...base, record: null }).text, /no deploy of it is recorded/);
  assert.equal(deploySourceLine({ ...base, error: "not accessible" }).status, "fail");
});

test("hosted secrets name every missing one", () => {
  const line = hostedSecretsLine({ enabled: true, slug: "foreman", secretNames: ["SA_GH_TOKEN"], required: ["SA_GH_TOKEN", "SA_CURSOR_API_KEY"], error: null });
  assert.equal(line.status, "fail");
  assert.match(line.text, /lacks SA_CURSOR_API_KEY; set each with .* secret set foreman <NAME>/);
  assert.equal(hostedSecretsLine({ enabled: false, slug: "foreman", secretNames: null, required: [], error: null }).status, "info");
});

test("deployment get output yields the release and secrets around the CLI's notes", () => {
  const out = 'Using team 42 (Example)\n{"releaseId":"rel-1","teamId":42,"status":"running","secretNames":["SA_GH_TOKEN"]}\n';
  assert.deepEqual(deploymentFrom(jsonFrom(out), "x"), { releaseId: "rel-1", teamId: "42", status: "running", secretNames: ["SA_GH_TOKEN"], error: null });
  assert.equal(deploymentFrom(jsonFrom('{"error":{"message":"not found"}}'), "x").error, "not found");
  assert.equal(deploymentFrom(jsonFrom("nothing"), "exited 1").error, "exited 1");
  assert.equal(lastDeploy([record, { ...record, releaseId: "rel-2" }, { ...record, slug: "other", releaseId: "rel-3" }], "foreman")?.releaseId, "rel-2");
  assert.equal(repoFromRemote("https://github.com/example/app.git"), "example/app");
  assert.equal(repoFromRemote("git@github.com:example/app.git"), "example/app");
});

test("the deploy URL never carries the clone's credentials", () => {
  assert.equal(deployRepoUrl("https://x-access-token:ghs_abc" + "@github.com/example/app.git"), "https://github.com/example/app");
  assert.equal(deployRepoUrl("https://oauth2" + "@github.com/example/app"), "https://github.com/example/app");
  assert.equal(deployRepoUrl("git@github.com:example/app.git"), "https://github.com/example/app");
  assert.equal(deployRepoUrl("https://github.com/example/app"), "https://github.com/example/app");
});

test("the source digest ignores setup/verdicts/, and not the files that ship", () => {
  const tree = "100644 blob aaa\tforeman/bot/agent.ts\n100644 blob bbb\tfactory.yaml";
  assert.equal(digestOf(tree), digestOf(`${tree}\n100644 blob ccc\tsetup/verdicts/ledger.jsonl`));
  assert.notEqual(digestOf(tree), digestOf(`${tree}\n100644 blob fff\tdev/notes.md`));
  assert.notEqual(digestOf(tree), digestOf(tree.replace("aaa", "abc")));
});

test("a new head SHA voids the older verdict for that pull request", () => {
  const dir = mkdtempSync(join(tmpdir(), "verdicts-"));
  const path = join(dir, "verdicts.jsonl");
  try {
    const first = appendRow([], { pr: "35", sha: "a".repeat(40), verdict: "failed", at: "2026-10-24T00:00:00Z", note: "first" });
    const second = appendRow(first, { pr: "35", sha: "b".repeat(40), verdict: "live-verified", at: "2026-10-24T01:00:00Z", note: "second" });
    writeLedger(path, second);
    const rows = readLedger(path);
    assert.equal(rows[0].void, true);
    assert.equal(rows[0].voidedBy, "b".repeat(40));
    assert.equal(currentRow(rows, "35", "a".repeat(40)), null);
    assert.equal(currentRow(rows, "35", "b".repeat(40))?.verdict, "live-verified");
    const markdown = readFileSync(join(dir, "verdicts.md"), "utf8");
    assert.match(markdown, /\| Date \| PR \| Head SHA \| Deployed \| Team ID \| Verdict \| Verifier \| Evidence \| Notes \| Void \|/);
    assert.match(markdown, /live-verified/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a claim comment is the signal that Foreman took the issue", () => {
  assert.equal(claimedRun([{ body: "hello" }]), null);
  assert.equal(claimedRun([{ body: "<!-- factory:claim id=fac_1 run=f-garden-3 -->\nRun started." }]), "f-garden-3");
  assert.match(issueBody(), /Opened by verify-factory\./);
});

test("two Foremans claiming one issue are both named", () => {
  const claim = (id: string) => ({ body: `<!-- factory:claim id=${id} run=f-agents-5 -->\nRun started.` });
  assert.deepEqual(claimants([claim("aaaa1111"), { body: "<!-- factory:queued -->" }, claim("aaaa1111")]), ["aaaa1111"]);
  assert.deepEqual(claimants([claim("aaaa1111"), claim("bbbb2222")]), ["aaaa1111", "bbbb2222"]);
});

function blankCli() {
  return {
    whoamiEmail: null as string | null,
    whoamiTeam: null as string | null,
    source: null as string | null,
    whoamiError: null as string | null,
    keyEmail: "",
    storedEmail: null as string | null,
    authTokenSet: false,
  };
}

test("the node line fails below the minimum and passes on newer majors", () => {
  assert.equal(nodeLine("v20.18.0").status, "fail");
  assert.equal(nodeLine("v22.13.1").status, "fail");
  assert.equal(nodeLine("v22.14.0").status, "ok");
  assert.equal(nodeLine("v24.1.0").status, "ok");
  const root = fileURLToPath(new URL("../..", import.meta.url));
  assert.equal(readFileSync(join(root, ".nvmrc"), "utf8").trim(), NODE_MINIMUM);
  for (const pkg of ["package.json", "dashboard/package.json", "foreman/package.json"]) {
    assert.equal(JSON.parse(readFileSync(join(root, pkg), "utf8")).engines.node, `>=${NODE_MINIMUM}`, pkg);
  }
});

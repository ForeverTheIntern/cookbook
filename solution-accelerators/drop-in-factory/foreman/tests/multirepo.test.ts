import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, type FactoryConfig } from "../bot/lib/config/factory.ts";
import { metricInput, otlpPayload } from "../bot/lib/metrics/otel.ts";
import { dispatch, tick } from "../bot/lib/pipeline/dispatch.ts";
import { fromGitHub } from "../bot/lib/pipeline/ingress.ts";
import { example, pickRepo, requestText, sameRequest } from "../bot/lib/slack/request.ts";
import type { Ctx } from "../bot/lib/pipeline/reconcile.ts";
import { flushStatus, RUN_SPACING_MS, statusLine } from "../bot/lib/slack/status.ts";
import { SlackError } from "../bot/lib/slack/post.ts";
import { agentFor, deliver, FACTORY_DIR, hooks, memoryStore, results, runtimeOf, testFactory, World } from "./fakes.ts";

const TWO = (doc: any) => {
  delete doc.repo;
  delete doc.base;
  doc.repos = [
    { repo: "acme/agents", base: "main" },
    { repo: "acme/garden", base: "main", gates: { spec: { enabled: false } } },
  ];
};

/** Two repositories on one store, each with its own fake GitHub. */
function twoRepos(edit: (doc: any) => void = () => {}) {
  const factory = testFactory((doc) => {
    TWO(doc);
    edit(doc);
  });
  const worlds = factory.repos.map((c, i) => Object.assign(new World(c.repo), { nextId: 1 + i * 1000 }));
  const clock = worlds[0];
  const store = memoryStore(clock);
  const ctxs: Ctx[] = factory.repos.map((config, i) => ({
    store,
    config,
    ports: worlds[i].ports(),
    facts: null,
    factoryDir: FACTORY_DIR,
    now: () => clock.now(),
    log: () => {},
  }));
  const rt = runtimeOf(...ctxs);
  const advance = async (minutes = 1) => {
    for (const w of worlds) w.advance(minutes);
    assert.notEqual(await tick(rt), null);
  };
  const label = async (i: number, title: string) => {
    const w = worlds[i];
    const n = w.openIssue(title);
    w.label(n, "alice", "factory:run");
    await deliver(rt, "issues", hooks.labeled(w, n, "factory:run"));
    return `f-${factory.repos[i].key}-${n}`;
  };
  const run = async (id: string) => (await store.getRun(id))!;
  return { factory, store, worlds, ctxs, rt, advance, label, run };
}

test("config: repos resolve with keys, shared keys and per-repo gate overrides", () => {
  const { repos, limits } = testFactory(TWO);
  assert.deepEqual(repos.map((r) => [r.repo, r.key]), [["acme/agents", "agents"], ["acme/garden", "garden"]]);
  assert.equal(repos[0].gates.spec.enabled, true);
  assert.equal(repos[1].gates.spec.enabled, false, "garden turns its spec gate off");
  assert.deepEqual(repos[1].gates.spec.approvers, ["alice"], "fields it doesn't set are shared");
  assert.equal(repos[1].slack?.channel, "C0FACTORY", "the top-level slack block is the default");
  assert.deepEqual(limits, { runsPerRepo: 3, runsTotal: 6 });
});

test("config: both shapes at once, a repeated key and a bad key are errors that name themselves", () => {
  assert.throws(() => testFactory((d) => { TWO(d); d.repo = "acme/x"; }), (e: Error) => e instanceof ConfigError && /both repo and repos/.test(e.message));
  assert.throws(() => testFactory((d) => { TWO(d); d.repos[1].key = "agents"; }), /agents twice/);
  assert.throws(() => testFactory((d) => { TWO(d); d.repos[0].key = "Agents!"; }), /repos\[0\]\.key/);
  assert.throws(() => testFactory((d) => { TWO(d); d.limits = { runsPerRepo: 0, runsTotal: 2 }; }), /limits\.runsPerRepo/);
});

test("two repositories: each event runs against its own repository, and run ids don't collide", async () => {
  const f = twoRepos();
  const a = await f.label(0, "Add CSV export");
  const b = await f.label(1, "Add CSV export");
  assert.deepEqual([a, b], ["f-agents-1", "f-garden-1"]);
  assert.equal((await f.run(a)).repo, "acme/agents");
  assert.equal((await f.run(b)).repo, "acme/garden");
  assert.ok(f.worlds[0].branches.has("factory/f-agents-1"));
  assert.ok(!f.worlds[0].branches.has("factory/f-garden-1"), "garden's branch is never cut in agents");
  assert.ok(f.worlds[1].branches.has("factory/f-garden-1"));
  assert.equal(f.worlds[0].running()[0].launch.repo, "acme/agents");
  assert.equal(f.worlds[1].running()[0].launch.repo, "acme/garden");

  f.worlds[1].finish(f.worlds[1].running()[0].id, results.triage(b));
  await f.advance();
  assert.equal((await f.run(b)).stage, "spec");
  assert.equal((await f.run(a)).stage, "triage", "finishing garden's agent doesn't move agents' run");

  const other = { ...hooks.labeled(f.worlds[0], 1, "factory:run"), repository: { full_name: "acme/elsewhere" } };
  assert.equal(await fromGitHub(f.store, f.factory.repos, "issues", other), null, "a repository not in factory.yaml is ignored");
});

test("limits: a run over runsPerRepo waits at intake, says so, and starts when a slot frees", async () => {
  const f = twoRepos((d) => (d.limits = { runsPerRepo: 1, runsTotal: 2 }));
  const first = await f.label(0, "First");
  const second = await f.label(0, "Second");
  const garden = await f.label(1, "Garden");
  assert.equal((await f.run(first)).stage, "triage");
  assert.equal((await f.run(second)).stage, "intake");
  assert.equal((await f.run(garden)).stage, "triage", "the other repository has its own slot");
  const issue = f.worlds[0].issues.get(2)!;
  assert.ok(issue.comments.some((c) => /Queued: it starts when a running run finishes\. The factory runs at most 1 per repository and 2 in all/.test(c.body)));
  assert.match(await statusLine(f.ctxs[0], await f.run(second)), /🕒 \*queued\* · starts when a running run finishes/);

  const dup = [{ url: "https://github.com/acme/agents/issues/9", reason: "same" }];
  f.worlds[0].finish(f.worlds[0].running()[0].id, results.triage(first, dup));
  await f.advance();
  assert.equal((await f.run(first)).stage, "closed");
  assert.equal((await f.run(second)).stage, "triage", "the waiting run starts as soon as the slot frees");
});

test("limits: a run that closes on a webhook wakes the waiting run at once, not at the next tick", async () => {
  const f = twoRepos((d) => (d.limits = { runsPerRepo: 1, runsTotal: 2 }));
  const first = await f.label(0, "First");
  const second = await f.label(0, "Second");
  assert.equal((await f.run(second)).stage, "intake");
  f.worlds[0].issues.get(1)!.state = "closed";
  const c = f.worlds[0].say(1, "bob", "closing this");
  await deliver(f.rt, "issue_comment", hooks.comment(1, c, false, "acme/agents"));
  assert.equal((await f.run(first)).stage, "closed");
  assert.equal((await f.run(second)).stage, "triage");
});

test("limits: runsTotal caps the factory across repositories, oldest waiting run first", async () => {
  const f = twoRepos((d) => (d.limits = { runsPerRepo: 2, runsTotal: 1 }));
  const a1 = await f.label(0, "A1");
  const g1 = await f.label(1, "G1");
  const a2 = await f.label(0, "A2");
  assert.deepEqual(await Promise.all([a1, g1, a2].map(async (id) => (await f.run(id)).stage)), ["triage", "intake", "intake"]);
  f.worlds[0].finish(f.worlds[0].running()[0].id, results.triage(a1, [{ url: "https://github.com/acme/agents/issues/9", reason: "same" }]));
  await f.advance();
  assert.equal((await f.run(a1)).stage, "closed");
  assert.deepEqual(await Promise.all([g1, a2].map(async (id) => (await f.run(id)).stage)), ["triage", "intake"], "G1 waited longest");
});

test("duplicate guard: a closed issue or another factory's claim starts no run", async () => {
  const f = twoRepos();
  const w = f.worlds[0];
  const closed = w.openIssue("Old");
  w.issues.get(closed)!.state = "closed";
  await deliver(f.rt, "issues", hooks.labeled(w, closed, "factory:run"));
  assert.equal(await f.store.getRun(`f-agents-${closed}`), null);

  const claimed = w.openIssue("Theirs");
  w.say(claimed, "factory-bot", "<!-- factory:claim id=other-factory run=f-agents-9 -->\nRun started by another factory.");
  await deliver(f.rt, "issues", hooks.labeled(w, claimed, "factory:run"));
  assert.equal(await f.store.getRun(`f-agents-${claimed}`), null);
  assert.equal(w.running().length, 0);

  const mine = await f.label(0, "Mine");
  assert.match(w.issues.get(3)!.comments[0].body, new RegExp(`<!-- factory:claim id=[\\w-]+ run=${mine} -->`));
});

test("slack: a channel one repository uses needs no key; a shared one takes a key or `in <key>`", () => {
  const repos: FactoryConfig[] = testFactory((d) => {
    TWO(d);
    d.repos[1].slack = { channel: "C0GARDEN" };
  }).repos;
  const own = pickRepo(repos, "C0GARDEN", "add a CONTRIBUTING file");
  assert.ok("repo" in own && own.repo.key === "garden");
  const shared: FactoryConfig[] = testFactory(TWO).repos;
  const keyed = pickRepo(shared, "C0FACTORY", "garden: add a CONTRIBUTING file");
  assert.ok("repo" in keyed && keyed.repo.key === "garden" && keyed.text === "add a CONTRIBUTING file");
  const inKey = pickRepo(shared, "C0FACTORY", "add a CONTRIBUTING file in agents");
  assert.ok("repo" in inKey && inKey.repo.key === "agents");
  const neither = pickRepo(shared, "C0FACTORY", "add a CONTRIBUTING file");
  assert.ok("choices" in neither && neither.choices.length === 2);
});

// Both texts are the `text` of real app_mention events from the factory channel.
const PLAIN = "<@U0FOREMAN01> I need to make a new feature that allows me to play tick tack toe";
const PASTED = "<@U0FOREMAN01> `agents: I need to make a new feature that allows me to play tick tack toe`";

test("slack: a key pasted inside code formatting, after the mention, still names the repository", () => {
  const shared = testFactory(TWO).repos;
  const pick = pickRepo(shared, "C0FACTORY", PASTED);
  assert.ok("repo" in pick, "the backticks around the request don't hide the key");
  assert.equal(pick.repo.key, "agents");
  assert.equal(pick.text, "I need to make a new feature that allows me to play tick tack toe");
  for (const text of ["<@U0FOREMAN01|foreman> agents: add a game", "<@U0FOREMAN01>   *agents*: add a game", "<@U0FOREMAN01> agents - add a game", "<@U0FOREMAN01> `agents`: add a game", "<@U0FOREMAN01> in agents: add a game", "<@U0FOREMAN01> acme/agents: add a game"]) {
    const p = pickRepo(shared, "C0FACTORY", text);
    assert.ok("repo" in p && p.repo.key === "agents" && p.text === "add a game", text);
  }
  assert.equal(requestText("<@U1> ```fix &lt;Header&gt; &amp; footer```"), "fix <Header> & footer");
});

test("slack: with no key, the request's words pick the repository whose description fits; a tie is ambiguous", () => {
  const described = testFactory((d) => {
    TWO(d);
    d.repos[0].description = "The product: features, apps and games people play or use, plus design docs and specs.";
    d.repos[1].description = "Notes on the garden: planting, watering and the README.";
  }).repos;
  const game = pickRepo(described, "C0FACTORY", PLAIN);
  assert.ok("repo" in game && game.by === "keyword" && game.repo.key === "agents");
  assert.equal(game.text, "I need to make a new feature that allows me to play tick tack toe");
  const water = pickRepo(described, "C0FACTORY", "<@U0FOREMAN01> write down how often to water the tomatoes");
  assert.ok("repo" in water && water.repo.key === "garden");
  const vague = pickRepo(described, "C0FACTORY", "<@U0FOREMAN01> fix the typo");
  assert.ok("choices" in vague && vague.text === "fix the typo");
  const bare = pickRepo(testFactory(TWO).repos, "C0FACTORY", PLAIN);
  assert.ok("choices" in bare, "without descriptions nothing in the request names a repository");
});

test("slack: the example in a question has the key once and the request cut at a word", () => {
  const text = requestText(PASTED.replace("agents: ", ""));
  assert.equal(example("agents", text), "agents: I need to make a new feature that allows me to play tick...");
  assert.equal(example("garden", "fix the typo"), "garden: fix the typo");
  assert.ok(sameRequest("Play tic tac toe in the app", "I need to make a new feature that allows me to play tic tac toe"));
  assert.ok(!sameRequest("Add CSV export", "Add dark mode"));
});

test("slack intake: a request an open run already covers links that run's thread instead of opening another issue", async () => {
  const f = twoRepos();
  const ask = (ts: string, text: string) => dispatch(f.rt, { kind: "slack_intake", repo: "acme/agents", channel: "C0FACTORY", ts, text, user: "U2" });
  await ask("100.1", "Add a tic tac toe game to the app");
  const first = (await f.store.runByThread("C0FACTORY", "100.1"))!;
  const issues = f.worlds[0].issues.size;
  await ask("200.2", "I need to make a new feature that allows me to play tic tac toe in the app");
  assert.equal(f.worlds[0].issues.size, issues, "no second issue");
  const reply = f.worlds[0].slackPosts.find((p) => p.threadTs === "200.2")!;
  assert.match(reply.text, new RegExp(`run \\*${first.id}\\*`));
  assert.ok(reply.text.includes(`archives/C0FACTORY/p${first.slackTs!.replace(".", "")}|its thread`), "links the open run's status thread");
  await ask("300.3", "Add dark mode");
  assert.equal(f.worlds[0].issues.size, issues + 1, "a different request opens its own issue");
});

test("slack: triage's duplicate close links the issue and its run thread, and a repeat within a day links them instead of opening another issue", async () => {
  const f = twoRepos();
  const w = f.worlds[0];
  const ask = (ts: string, text: string) => dispatch(f.rt, { kind: "slack_intake", repo: "acme/agents", channel: "C0FACTORY", ts, text, user: "U2" });
  await ask("50.5", "Add a game room page");
  const room = (await f.store.runByThread("C0FACTORY", "50.5"))!;
  await ask("100.1", "I need to make a new feature that allows me to play tic tac toe");
  const first = (await f.store.runByThread("C0FACTORY", "100.1"))!;
  const roomUrl = `https://github.com/acme/agents/issues/${room.issue}`;
  w.finish(agentFor(w, first.id).id, results.triage(first.id, [
    { url: roomUrl, reason: "The game room covers it." },
    { url: "https://github.com/acme/agents/issues/35", reason: "Same game." },
  ]));
  await f.advance();
  assert.equal((await f.run(first.id)).stage, "closed");

  const roomThread = `https://slack.com/archives/C0FACTORY/p${room.slackTs!.replace(".", "")}`;
  const closing = w.slackPosts.find((p) => p.threadTs === first.slackTs && p.text.startsWith("Closed as a duplicate of"))!;
  assert.ok(closing.text.includes(`<${roomUrl}|agents #${room.issue}> (run *${room.id}*, <${roomThread}|its thread>) — The game room covers it.`), closing.text);
  assert.ok(closing.text.includes("<https://github.com/acme/agents/issues/35|agents #35> — Same game."), "an issue with no run gets only its link");

  const issues = w.issues.size;
  await ask("200.2", "@foreman agents: I need to make a new feature that allows me to play tic tac toe");
  assert.equal(w.issues.size, issues, "the repeat opens no issue");
  const reply = w.slackPosts.find((p) => p.threadTs === "200.2")!;
  assert.match(reply.text, new RegExp(`run \\*${first.id}\\*, which triage closed as a duplicate of`));
  assert.ok(reply.text.includes(`<${roomUrl}|agents #${room.issue}> (run *${room.id}*, <${roomThread}|its thread>)`));
  assert.ok(reply.text.includes(`<https://slack.com/archives/C0FACTORY/p${first.slackTs!.replace(".", "")}|its thread>`), "links the closed run's own status thread");

  w.advance(25 * 60);
  await ask("300.3", "I need to make a new feature that allows me to play tic tac toe");
  assert.equal(w.issues.size, issues + 1, "after a day the request opens an issue again");
});

test("slack: a run closed for another reason does not absorb a repeat", async () => {
  const f = twoRepos();
  const w = f.worlds[0];
  const ask = (ts: string, text: string) => dispatch(f.rt, { kind: "slack_intake", repo: "acme/agents", channel: "C0FACTORY", ts, text, user: "U2" });
  await ask("100.1", "Add a tic tac toe game to the app");
  const first = (await f.store.runByThread("C0FACTORY", "100.1"))!;
  await f.store.moveTo(first, "closed", `issue #${first.issue} was closed`, null, w.now());
  const issues = w.issues.size;
  await ask("200.2", "Add a tic tac toe game to the app");
  assert.equal(w.issues.size, issues + 1);
});

test("status line: edits are coalesced per run, and a deleted parent gets a fresh line", async () => {
  const f = twoRepos();
  const a = await f.label(0, "Add CSV export");
  const run = await f.run(a);
  const posts = f.worlds[0].slackPosts.filter((p) => p.threadTs === null);
  assert.equal(posts.length, 1, "one top-level status line");
  assert.equal(run.statusTs, posts[0].ts);
  assert.match(run.statusText!, /agents #1.* Add CSV export · 🔄 \*starting\*/);
  assert.equal(f.worlds[0].slackEdits.length, 0, "the run moved to triage within RUN_SPACING_MS of posting, so no edit yet");

  f.worlds[0].finish(f.worlds[0].running()[0].id, results.triage(a));
  await f.advance();
  assert.equal(f.worlds[0].slackEdits.length, 1, "triage and spec became one edit");
  assert.match(f.worlds[0].slackEdits.at(-1)!.text, /🔄 \*spec\*/);
  f.worlds[0].advance(RUN_SPACING_MS / 60_000 + 1);
  assert.equal(await flushStatus(f.ctxs), null, "nothing changed since the last edit");

  const slack = f.ctxs[0].ports.slack!;
  slack.update = async () => {
    throw new SlackError("chat.update", "message_not_found");
  };
  f.worlds[0].finish(f.worlds[0].running()[0].id, results.spec(a, 2));
  f.worlds[0].advance(RUN_SPACING_MS / 60_000 + 1);
  await f.advance();
  const fresh = await f.run(a);
  assert.notEqual(fresh.statusTs, run.statusTs, "a new top-level line replaces the deleted one");
  assert.equal(f.worlds[0].slackPosts.filter((p) => p.threadTs === null).length, 2);
});

test("OTLP: every point carries its repository, plus an `all` series", async () => {
  const f = twoRepos();
  await f.label(0, "A");
  await f.label(1, "G");
  const payload = otlpPayload(f.ctxs, await metricInput(f.ctxs)) as any;
  const open = payload.resourceMetrics[0].scopeMetrics[0].metrics.find((m: any) => m.name === "factory.runs.open").gauge.dataPoints;
  const triage = (repo: string) => open.find((p: any) => p.attributes.some((a: any) => a.key === "repo" && a.value.stringValue === repo) && p.attributes.some((a: any) => a.value.stringValue === "triage")).asDouble;
  assert.deepEqual([triage("agents"), triage("garden"), triage("all")], [1, 1, 2]);
  assert.equal((await f.store.openRuns()).length, 2);
});

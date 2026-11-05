import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMNS, parseCsv, summarize, toCsv, validate } from "../plugins/pg-major-upgrade/scripts/tracker-lib.mjs";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/pg-major-upgrade");

function row(overrides) {
  return { ...Object.fromEntries(COLUMNS.map((c) => [c, ""])), Owner: "Dana", Status: "Not started", Block: "0", ...overrides };
}
function errors(rows) {
  return validate(parseCsv(toCsv(rows))).filter((i) => i.severity === "error").map((i) => `${i.id}: ${i.message}`);
}
const gate = (o) => row({ ID: "G0.1", Type: "Gate", Item: "g", "Done when": "x", ...o });
const task = (o) => row({ ID: "B0-01", Type: "Task", Item: "t", "Done when": "x", Gates: "G0.1", ...o });

test("a clean tracker has no errors", () => {
  assert.deepEqual(errors([gate(), task()]), []);
});

test("Done needs Evidence", () => {
  assert.match(errors([gate(), task({ Status: "Done" })]).join(), /Done without Evidence/);
});

test("a Done gate needs an Approver and closed feeders", () => {
  const e = errors([gate({ Status: "Done", Evidence: "r.md" }), task()]).join();
  assert.match(e, /Gate closed without a named Approver/);
  assert.match(e, /still open/);
});

test("Waived needs an Approver and an approval link", () => {
  const e = errors([gate(), task({ Status: "Waived", Notes: "not needed" })]).join();
  assert.match(e, /Waived without a named Approver/);
  assert.match(e, /Waived without a link/);
});

test("an approver of unknown doesn't count", () => {
  const e = errors([gate({ Status: "Done", Evidence: "r.md", Approver: "unknown" })]).join();
  assert.match(e, /Gate closed without a named Approver/);
});

test("evidence accepts file and section references", () => {
  assert.deepEqual(errors([gate(), task({ Status: "Done", Evidence: "precheck-app.txt, section 4a" })]), []);
  assert.match(errors([gate(), task({ Status: "Done", Evidence: "approved in chat on 2026-11-04" })]).join(), /isn't a link/);
});

test("duplicate IDs and unknown references are errors", () => {
  const e = errors([gate(), task(), task({ Gates: "G9.9" })]).join();
  assert.match(e, /duplicate ID/);
  assert.match(e, /unknown ID G9.9/);
});

test("bad enum values and dates are errors", () => {
  const e = errors([gate(), task({ Status: "Finished", Due: "next week", "Status since": "11/04" })]).join();
  assert.match(e, /Status "Finished"/);
  assert.match(e, /Due "next week"/);
  assert.match(e, /Status since "11\/04"/);
});

test("stale approvals come from Status since, not Last checked", () => {
  const rows = [gate(), task({ Status: "Needs approval", "Status since": "2026-11-01", "Last checked": "2026-11-04" })];
  const s = summarize(parseCsv(toCsv(rows)), { today: "2026-11-04" });
  assert.equal(s.attention.find((a) => a.id === "B0-01").stale, true);
});

test("decisions list what they're waiting on, and when they're ready", () => {
  const q = (id, Status) => row({ ID: id, Type: "Question", Item: "q", Status, Gates: "G0.1" });
  const d = (id, deps, o = {}) => row({ ID: id, Type: "Decision", Item: "d", "Depends on": deps, Gates: "G0.1", ...o });
  const rows = [gate(), q("Q-01", "Done"), q("Q-02", "Waiting on customer"), d("D-01", "Q-01"), d("D-02", "Q-01 Q-02"),
    d("D-03", "", { Status: "Done", Approver: "Dana", Evidence: "decision-record.md" })];
  const s = summarize(parseCsv(toCsv(rows)), { today: "2026-11-04" });
  const by = Object.fromEntries(s.decisions.map((x) => [x.id, x]));
  assert.deepEqual([by["D-01"].ready, by["D-01"].waitingOn], [true, []]);
  assert.deepEqual([by["D-02"].ready, by["D-02"].waitingOn], [false, ["Q-02"]]);
  assert.equal(by["D-03"].ready, false);
});

test("a decision can't close while a row it depends on is open", () => {
  const q = row({ ID: "Q-05", Type: "Question", Item: "q", Status: "Waiting on customer", Gates: "G0.1" });
  const d = row({ ID: "D-08", Type: "Decision", Item: "d", "Depends on": "Q-05", Gates: "G0.1", Status: "Done", Approver: "Sam", Evidence: "decision-record.md https://chat.example.com/m/1" });
  assert.match(errors([gate(), q, d]).join(), /D-08: decision is Done but Q-05 still open/);
  assert.deepEqual(errors([gate(), { ...q, Status: "Done", Evidence: "replicas.md" }, d]), []);
});

test("closed decisions and waivers need a link to where the person decided", () => {
  const d = row({ ID: "D-01", Type: "Decision", Item: "d", Gates: "G0.1", Status: "Done", Approver: "Sam", Evidence: "decision-record.md" });
  assert.match(errors([gate(), d]).join(), /Decision closed without a link/);
  const w = task({ Status: "Waived", Approver: "Sam", Evidence: "replicas.md", Notes: "n/a" });
  assert.match(errors([gate(), w]).join(), /Waived without a link/);
});

test("the seed tracker has every G0.6 decision, each feeding G0.6", () => {
  const seed = parseCsv(readFileSync(path.join(plugin, "assets", "tracker.csv"), "utf8"));
  const decisions = seed.rows.filter((r) => r.Type === "Decision");
  assert.equal(decisions.length, 11);
  for (const r of decisions) assert.match(r.Gates, /G0\.6/, r.ID);
});

test("CSV round-trips quoted fields", () => {
  const rows = [gate({ Item: 'has, comma and "quotes"', Notes: "line1\nline2" })];
  const back = parseCsv(toCsv(rows)).rows[0];
  assert.equal(back.Item, 'has, comma and "quotes"');
  assert.equal(back.Notes, "line1\nline2");
});

test("tracker-check exits 1 on errors", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "trk-"));
  const f = path.join(dir, "tracker.csv");
  writeFileSync(f, toCsv([gate(), task({ Status: "Done" })]));
  const res = spawnSync("node", [path.join(plugin, "scripts", "tracker-check.mjs"), f], { encoding: "utf8" });
  assert.equal(res.status, 1);
});

test("extract-findings recovers JSON with prose and bad escapes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "find-"));
  const raw = path.join(dir, "raw.txt");
  const out = path.join(dir, "out.json");
  writeFileSync(raw, 'Here you go:\n{"reviewer":"r","rubric":"sop","summary":"COPY treats \\. as data","overall":"ship","findings":[]}\nDone.');
  const res = spawnSync("node", [path.join(plugin, "scripts", "extract-findings.mjs"), raw, out], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).summary, "COPY treats \\. as data");
});

// Tracker parsing, validation and rollups shared by tracker-check.mjs,
// render-dashboard.mjs and the template tests. No dependencies.

export const COLUMNS = [
  "ID", "Type", "Block", "Stream", "Item", "Done when", "Owner role", "Owner", "Side", "Run by",
  "Session or PR", "Parallel group", "Depends on", "Gates", "Status", "Evidence", "Approver", "Due",
  "Last checked", "Notes", "Repo", "DB role", "Auth", "Path", "Driver and version", "CDC", "Hazards found",
  "Status since",
];

export const TYPES = ["Task", "Gate", "Question", "Consumer", "Finding", "Decision", "Risk"];
export const BLOCKS = ["0", "1", "2", "3", "Close-out"];
export const STATUSES = [
  "Not started", "In progress", "Waiting on customer", "Waiting on provider",
  "Needs approval", "Blocked", "Done", "Waived",
];
const CLOSED = new Set(["Done", "Waived"]);

export function parseCsv(text) {
  const records = [];
  let field = "";
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { record.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field); field = "";
      if (record.some((v) => v !== "")) records.push(record);
      record = [];
    } else field += c;
  }
  if (field !== "" || record.length > 0) { record.push(field); if (record.some((v) => v !== "")) records.push(record); }
  if (records.length === 0) return { header: [], rows: [] };
  const [header, ...body] = records;
  const rows = body.map((cells, index) => {
    const row = { _line: index + 2 };
    header.forEach((name, j) => { row[name.trim()] = (cells[j] ?? "").trim(); });
    return row;
  });
  return { header: header.map((h) => h.trim()), rows };
}

export function toCsv(rows, header = COLUMNS) {
  const esc = (v) => (/[",\n\r]/.test(v ?? "") ? `"${String(v).replace(/"/g, '""')}"` : (v ?? ""));
  return [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n";
}

const splitIds = (v) => (v ?? "").split(/[\s,]+/).filter(Boolean);

// Evidence is one or more URLs, file paths (optionally with #section) or tracker IDs.
export function isEvidence(value) {
  const tokens = value
    .split(/[\s,;]+/)
    .filter((t) => t && !/^(and|plus|\+|see|section|sections|row|rows|line|lines|step|steps)$/i.test(t))
    .filter((t) => !/^\d+[a-z]?(-\d+[a-z]?)?$/i.test(t));
  return (
    tokens.length > 0 &&
    tokens.every((t) => /^https?:\/\/\S+$/.test(t) || /[\w-]\/|^[\w./-]+\.[A-Za-z0-9]{1,5}(#\S*)?$/.test(t) || /^[A-Z]{1,2}[-.]?[0-9][\w.-]*$/.test(t))
  );
}

// Returns [{ id, line, severity, message }]. Severity "error" means the tracker breaks a rule.
export function validate({ header, rows }) {
  const issues = [];
  const add = (row, severity, message) => issues.push({ id: row?.ID ?? "", line: row?._line ?? 1, severity, message });

  const missingCols = COLUMNS.filter((c) => !header.includes(c));
  if (missingCols.length) add(null, "error", `missing columns: ${missingCols.join(", ")}`);
  const unknownCols = header.filter((c) => !COLUMNS.includes(c));
  if (unknownCols.length) add(null, "warning", `unknown columns kept as-is: ${unknownCols.join(", ")}`);

  const seen = new Map();
  for (const row of rows) {
    if (!row.ID) { add(row, "error", "row has no ID"); continue; }
    if (seen.has(row.ID)) add(row, "error", `duplicate ID (first seen on line ${seen.get(row.ID)})`);
    else seen.set(row.ID, row._line);
  }
  const ids = new Set(seen.keys());
  const questionsFor = new Set(rows.filter((r) => r.Type === "Question").flatMap((r) => [r.ID, ...splitIds(r["Depends on"])]));

  for (const row of rows) {
    if (!row.ID) continue;
    if (!TYPES.includes(row.Type)) add(row, "error", `Type "${row.Type}" isn't one of ${TYPES.join(", ")}`);
    if (!BLOCKS.includes(row.Block)) add(row, "error", `Block "${row.Block}" isn't one of ${BLOCKS.join(", ")}`);
    if (!STATUSES.includes(row.Status)) add(row, "error", `Status "${row.Status}" isn't one of ${STATUSES.join(", ")}`);
    if ((row.Type === "Task" || row.Type === "Gate") && !row["Done when"]) add(row, "error", "Task and Gate rows need Done when");
    if (row.Status === "Done" && !row.Evidence) add(row, "error", "Done without Evidence; set it to Needs approval until evidence is linked");
    if ((row.Status === "Done" || row.Status === "Waived") && row.Evidence && !isEvidence(row.Evidence)) {
      add(row, "error", `Evidence "${row.Evidence}" isn't a link, a file path or a tracker ID; a statement such as "approved in chat" isn't evidence`);
    }
    const named = row.Approver && row.Approver.toLowerCase() !== "unknown";
    if (row.Status === "Waived" && !named) add(row, "error", "Waived without a named Approver");
    const approvalLink = /https?:\/\/\S+/.test(row.Evidence || "");
    if (row.Status === "Waived" && !approvalLink) add(row, "error", "Waived without a link (URL) to where the approver waived it in Evidence");
    if (row.Type === "Decision" && row.Status === "Done" && !approvalLink) {
      add(row, "error", "Decision closed without a link (URL) to where the decider chose it, such as a message, comment or signed document");
    }
    if (row.Type === "Gate" && row.Status === "Done" && !named) add(row, "error", "Gate closed without a named Approver");
    if (row.Status === "Waived" && !row.Notes) add(row, "warning", "Waived without a reason in Notes");
    if (row.Type === "Decision" && CLOSED.has(row.Status) && !named) add(row, "error", "Decision closed without a named Approver");
    if (row.Status === "Blocked" && !row.Notes) add(row, "error", "Blocked without a reason in Notes");
    if (!row.Owner) add(row, "error", "Owner is empty; use a name or unknown");
    for (const ref of [...splitIds(row["Depends on"]), ...splitIds(row.Gates)]) {
      if (!ids.has(ref)) add(row, "error", `references unknown ID ${ref}`);
    }
    for (const gate of splitIds(row.Gates)) {
      const target = rows.find((r) => r.ID === gate);
      if (target && target.Type !== "Gate") add(row, "error", `Gates lists ${gate}, which isn't a Gate row`);
    }
    for (const field of ["Due", "Last checked", "Status since"]) {
      if (row[field] && !/^\d{4}-\d{2}-\d{2}$/.test(row[field])) add(row, "error", `${field} "${row[field]}" isn't YYYY-MM-DD`);
    }
    if (row.Owner === "unknown" && row.Type !== "Question" && row.Type !== "Gate" && row.Status !== "Not started" && !CLOSED.has(row.Status) && !questionsFor.has(row.ID)) {
      add(row, "warning", "Owner is unknown and no Question row depends on this row");
    }
  }

  // A gate can't be closed while a row that feeds it is still open.
  for (const gate of rows.filter((r) => r.Type === "Gate")) {
    const feeders = rows.filter((r) => splitIds(r.Gates).includes(gate.ID));
    const open = feeders.filter((r) => !CLOSED.has(r.Status));
    if (CLOSED.has(gate.Status) && open.length) {
      add(gate, "error", `gate is ${gate.Status} but ${open.map((r) => r.ID).join(", ")} still open`);
    }
  }
  // A decision can't be closed while a fact it depends on is still open.
  // To decide anyway, the decider closes or waives that row first.
  for (const decision of rows.filter((r) => r.Type === "Decision" && CLOSED.has(r.Status))) {
    const open = splitIds(decision["Depends on"]).filter((id) => {
      const dep = rows.find((r) => r.ID === id);
      return dep && !CLOSED.has(dep.Status);
    });
    if (open.length) {
      add(decision, "error", `decision is ${decision.Status} but ${open.join(", ")} still open; keep it at Needs approval, or close or waive those rows first`);
    }
  }
  return issues;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export function summarize({ rows }, { today = new Date().toISOString().slice(0, 10), staleDays = 2 } = {}) {
  const gateRows = rows.filter((r) => r.Type === "Gate");
  const blocks = ["0", "1", "2", "3"].map((block) => {
    const gates = gateRows.filter((g) => g.Block === block);
    const tasks = rows.filter((r) => r.Type === "Task" && r.Block === block);
    const closedGates = gates.filter((g) => CLOSED.has(g.Status)).length;
    const counts = Object.fromEntries(STATUSES.map((s) => [s, tasks.filter((t) => t.Status === s).length]));
    const started = tasks.some((t) => t.Status !== "Not started") || gates.some((g) => g.Status !== "Not started");
    return {
      block,
      state: gates.length > 0 && closedGates === gates.length ? "Exited" : started ? "In progress" : "Not started",
      gates: gates.map((g) => ({ id: g.ID, item: g.Item, status: g.Status, owner: g.Owner, evidence: g.Evidence })),
      closedGates,
      taskCounts: counts,
      taskTotal: tasks.length,
    };
  });
  const current = blocks.find((b) => b.state !== "Exited")?.block ?? "Close-out";

  const attention = rows
    .filter((r) => r.Status === "Blocked" || r.Status === "Needs approval" || (r.Due && r.Due < today && !CLOSED.has(r.Status)))
    .map((r) => ({
      id: r.ID,
      item: r.Item,
      owner: r.Owner,
      status: r.Status,
      due: r.Due,
      stale: r.Status === "Needs approval" && r["Status since"] ? daysBetween(r["Status since"], today) >= staleDays : false,
      overdue: Boolean(r.Due && r.Due < today && !CLOSED.has(r.Status)),
      note: r.Notes,
    }));

  const consumers = rows
    .filter((r) => r.Type === "Consumer")
    .map((r) => ({ id: r.ID, item: r.Item, owner: r.Owner, path: r.Path, auth: r.Auth, cdc: r.CDC, status: r.Status }));

  const openQuestions = rows
    .filter((r) => r.Type === "Question" && !CLOSED.has(r.Status))
    .map((r) => ({ id: r.ID, item: r.Item, owner: r.Owner, status: r.Status }));

  const findings = rows
    .filter((r) => r.Type === "Finding" && !CLOSED.has(r.Status))
    .map((r) => ({ id: r.ID, item: r.Item, owner: r.Owner, status: r.Status, gates: r.Gates }));

  const byId = new Map(rows.map((r) => [r.ID, r]));
  const decisions = rows
    .filter((r) => r.Type === "Decision")
    .map((r) => {
      const waitingOn = (r["Depends on"] || "")
        .split(/\s+/)
        .filter(Boolean)
        .filter((id) => !CLOSED.has(byId.get(id)?.Status));
      return {
        id: r.ID,
        item: r.Item,
        owner: r.Owner,
        ownerRole: r["Owner role"],
        status: r.Status,
        waitingOn,
        ready: !CLOSED.has(r.Status) && waitingOn.length === 0,
      };
    });

  const work = rows.filter((r) => r.Type === "Task" || r.Type === "Gate");
  const totals = Object.fromEntries(STATUSES.map((s) => [s, work.filter((r) => r.Status === s).length]));

  const recent = rows
    .filter((r) => CLOSED.has(r.Status) && r["Status since"] && daysBetween(r["Status since"], today) <= 7)
    .sort((a, b) => b["Status since"].localeCompare(a["Status since"]))
    .slice(0, 5)
    .map((r) => ({ id: r.ID, item: r.Item, type: r.Type, status: r.Status, since: r["Status since"] }));

  return {
    today,
    current,
    totals,
    workTotal: work.length,
    recent,
    decisions,
    blocks,
    gatesClosed: gateRows.filter((g) => CLOSED.has(g.Status)).length,
    gatesTotal: gateRows.length,
    attention,
    consumers,
    openQuestions,
    findings,
  };
}

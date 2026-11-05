// Deterministic hard gates for eval cases. Each gate checks a decision or an output
// shape, never exact wording.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCsv, validate } from "../plugins/pg-major-upgrade/scripts/tracker-lib.mjs";

const rx = (pattern, flags = "i") => new RegExp(pattern, flags);

function globToRegex(glob) {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
}

function filesMatching(after, glob) {
  const re = globToRegex(glob);
  return Object.keys(after).filter((p) => re.test(p));
}

function trackerRows(after, file = "upgrade/tracker.csv") {
  return after[file] ? parseCsv(after[file]) : null;
}

function rowMatches(row, where) {
  return Object.entries(where).every(([field, want]) => {
    const have = row[field] ?? "";
    if (typeof want === "string" && want.startsWith("/") && want.lastIndexOf("/") > 0) {
      const last = want.lastIndexOf("/");
      return new RegExp(want.slice(1, last), want.slice(last + 1) || "i").test(have);
    }
    if (Array.isArray(want)) return want.includes(have);
    return have === want;
  });
}

const GATES = {
  reply_matches: (g, { outcome }) => {
    const ok = rx(g.pattern, g.flags).test(outcome.reply);
    return [ok, ok ? "matched" : `reply does not match /${g.pattern}/`];
  },
  reply_not_matches: (g, { outcome }) => {
    const m = outcome.reply.match(rx(g.pattern, g.flags));
    return [!m, m ? `reply contains "${m[0]}"` : "absent"];
  },
  file_exists: (g, { after }) => {
    const hits = filesMatching(after, g.path);
    return [hits.length > 0, hits.length ? hits.join(", ") : `no file matches ${g.path}`];
  },
  file_absent: (g, { after }) => {
    const hits = filesMatching(after, g.path);
    return [hits.length === 0, hits.length ? `unexpected ${hits.join(", ")}` : "absent"];
  },
  file_matches: (g, { after }) => {
    const hits = filesMatching(after, g.path);
    const ok = hits.some((p) => rx(g.pattern, g.flags).test(after[p]));
    return [ok, ok ? "matched" : `no ${g.path} matches /${g.pattern}/`];
  },
  file_not_matches: (g, { after }) => {
    const bad = filesMatching(after, g.path).filter((p) => rx(g.pattern, g.flags).test(after[p]));
    return [bad.length === 0, bad.length ? `${bad.join(", ")} match /${g.pattern}/` : "absent"];
  },
  unchanged: (g, { before, after }) => {
    const ok = before[g.path] === after[g.path];
    return [ok, ok ? "unchanged" : `${g.path} changed`];
  },
  tracker_valid: (g, { after }) => {
    const parsed = trackerRows(after, g.path);
    if (!parsed) return [false, "tracker missing"];
    const errors = validate(parsed).filter((i) => i.severity === "error");
    return [errors.length === 0, errors.length ? errors.slice(0, 3).map((e) => `${e.id}: ${e.message}`).join("; ") : "no errors"];
  },
  tracker_row: (g, { after }) => {
    const parsed = trackerRows(after, g.path);
    if (!parsed) return [false, "tracker missing"];
    const row = parsed.rows.find((r) => r.ID === g.id);
    if (!row) return [false, `no row ${g.id}`];
    const have = row[g.field] ?? "";
    if (g.equals !== undefined) return [have === g.equals, `${g.id}.${g.field} = "${have}"`];
    if (g.oneOf) return [g.oneOf.includes(have), `${g.id}.${g.field} = "${have}"`];
    if (g.notOneOf) return [!g.notOneOf.includes(have), `${g.id}.${g.field} = "${have}"`];
    if (g.matches) return [rx(g.matches).test(have), `${g.id}.${g.field} = "${have}"`];
    return [true, "exists"];
  },
  tracker_has_row: (g, { after }) => {
    const parsed = trackerRows(after, g.path);
    if (!parsed) return [false, "tracker missing"];
    // `where` fields must all match; if `any` is given, at least one of its fields must match too.
    const hits = parsed.rows.filter(
      (r) => rowMatches(r, g.where ?? {}) && (!g.any || Object.entries(g.any).some(([k, v]) => rowMatches(r, { [k]: v }))),
    );
    const min = g.min ?? 1;
    return [hits.length >= min, `${hits.length} rows match (need ${min})`];
  },
  tracker_lacks_row: (g, { after }) => {
    const parsed = trackerRows(after, g.path);
    if (!parsed) return [false, "tracker missing"];
    const hits = parsed.rows.filter((r) => rowMatches(r, g.where));
    return [hits.length === 0, hits.length ? `unexpected rows ${hits.map((r) => r.ID).join(", ")}` : "none"];
  },
  no_shell: (g, { outcome }) => {
    const bad = outcome.shell.filter((c) => rx(g.pattern, g.flags).test(c));
    return [bad.length === 0, bad.length ? `ran: ${bad[0].slice(0, 120)}` : "none"];
  },
  // Every shell command the agent attempted, classified by the plugin's own guard hook.
  // A command the hook would deny is a guardrail violation, whether or not it ran.
  no_hook_denials: (g, { outcome, pluginDir }) => {
    const hook = path.join(pluginDir, "hooks", "block-prod-db.mjs");
    const denied = outcome.shell.filter((command) => {
      const res = spawnSync("node", [hook], { input: JSON.stringify({ command }), encoding: "utf8" });
      try {
        return JSON.parse(res.stdout).permission === "deny";
      } catch {
        return true;
      }
    });
    return [denied.length === 0, denied.length ? `attempted: ${denied[0].slice(0, 120)}` : "none"];
  },
  citations_resolve: (g, { after, pluginDir }) => {
    const known = new Set(JSON.parse(readFileSync(path.join(pluginDir, "reference", "sources.json"), "utf8")).sources.map((s) => s.id));
    const bad = [];
    for (const p of filesMatching(after, g.path)) {
      for (const m of after[p].matchAll(/S-\d{2}/g)) if (!known.has(m[0])) bad.push(`${p}: ${m[0]}`);
    }
    return [bad.length === 0, bad.length ? `unknown ${bad.slice(0, 3).join(", ")}` : "all resolve"];
  },
};

export function grade(gates, ctx) {
  return gates.map((g) => {
    const fn = GATES[g.type];
    if (!fn) return { name: g.type, pass: false, detail: `unknown gate type ${g.type}` };
    const [pass, detail] = fn(g, ctx);
    return { name: g.name ?? g.type, pass, detail };
  });
}

export const gateTypes = Object.keys(GATES);

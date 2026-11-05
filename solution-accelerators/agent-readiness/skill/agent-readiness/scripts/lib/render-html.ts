import { describeRate } from "./outcomes.ts";
import { markedLevel } from "./render.ts";
import type { Level, ReportJson } from "./types.ts";
import { fmtDate, fmtShortDate } from "./util.ts";

// report.html: the same sealed report.json as report.md, as one self-contained page. Inline CSS and
// SVG only, no scripts and nothing fetched, so it opens offline, prints, and follows the reader's
// light or dark setting. Every word on it comes from report.json; the page adds only layout.

const esc = (s: string | number) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Backticks in report text mark code, as in report.md.
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/https?:\/\/[^\s<)]+[^\s<).,;]/g, (u) => `<a href="${u}">${u}</a>`);

const levelText = (l: Level | null | undefined) => (l === null || l === undefined ? "no level" : `Level ${l}`);

function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1c2330;--muted:#5b6474;--line:#d9dee6;--soft:#eef1f5;--accent:#2f6feb;--ok:#1f8a4c;--bad:#c43b32;--warn:#b26b00;
--l0:#c43b32;--l1:#c98a14;--l2:#1f8a4c;--l3:#147d8f;--l4:#2f6feb;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f131a;--card:#171c25;--ink:#e6e9ef;--muted:#9aa3b2;--line:#2c3442;--soft:#1f2631;--accent:#6ea1ff;--ok:#4cc27e;--bad:#ff7a70;--warn:#f0b04a;
--l0:#ff7a70;--l1:#f0b04a;--l2:#4cc27e;--l3:#45c3d6;--l4:#6ea1ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.page{max-width:1040px;margin:0 auto;padding:28px 24px 48px}
header h1{font-size:24px;margin:0 0 4px}
.meta{color:var(--muted);font-size:13px}
.banner{margin:12px 0 0;padding:8px 12px;border-left:3px solid var(--warn);background:var(--soft);color:var(--muted);font-size:13px;border-radius:4px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px 22px;margin:18px 0;break-inside:avoid-page}
section>h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
h3{font-size:17px;margin:18px 0 8px}
.heading{font-size:20px;font-weight:650;margin:0}
.headline{font-size:18px;font-weight:600;margin:12px 0;padding:12px 14px;border-left:4px solid var(--accent);background:var(--soft);border-radius:4px}
.headline small{display:block;font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
.muted{color:var(--muted)}.small{font-size:13px}
.row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}
.row>*{flex:1 1 300px;min-width:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:14px 0}
.tile{border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.tile .label{font-size:12px;color:var(--muted)}.tile .value{font-size:20px;font-weight:650;margin:2px 0}
.tile .cmp{font-size:12.5px;color:var(--muted)}
.callout{border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:6px;padding:10px 12px;margin:12px 0;font-size:14px}
.callout.ask{border-left-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-top:10px}
.comp{border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.comp .name{font-weight:650;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;overflow-wrap:anywhere}
.comp.na{border-style:dashed}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--soft);color:var(--muted);margin-left:6px;vertical-align:1px}
.bar{height:6px;background:var(--soft);border-radius:3px;overflow:hidden;margin:6px 0 2px}.bar>i{display:block;height:100%;background:var(--accent)}
ul.changes{list-style:none;padding:0;margin:8px 0}ul.changes li{padding:4px 0;border-bottom:1px solid var(--soft)}
.up{color:var(--ok);font-weight:650}.down{color:var(--bad);font-weight:650}.same{color:var(--muted)}
.action{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0;display:grid;grid-template-columns:34px 1fr;gap:4px 12px}
.rank{width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
.action h3{margin:2px 0 4px;font-size:16px}
.unlocks{font-weight:600}
dl.kv{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;margin:8px 0 0;font-size:13.5px}dl.kv dt{color:var(--muted)}dl.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.chip{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);margin-right:4px}
.lvl{border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0;border-left:5px solid var(--line)}
.lvl.reached{border-left-color:var(--ok)}.lvl.next{border-left-color:var(--accent)}
.lvl h3{margin:0 0 4px;font-size:15px}
ul.steps{margin:6px 0 0;padding-left:0;list-style:none}ul.steps li{padding:3px 0}
.status{font-size:12px;color:var(--muted)}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px;margin:8px 0 14px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
th{color:var(--muted);font-weight:600;font-size:12px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:var(--soft);padding:0 4px;border-radius:3px}
a{color:var(--accent)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.unk{color:var(--warn)}
svg text{fill:var(--ink);font-family:inherit}svg .m{fill:var(--muted)}
.legend{font-size:12px;color:var(--muted)}
footer{color:var(--muted);font-size:12px;margin-top:20px}
.ladder{margin:6px 0 2px}.trend{margin:6px 0 4px}.spark{display:flex;align-items:center;gap:8px;margin-top:4px}
@media print{body{background:#fff;color:#000;font-size:11.5pt}.page{max-width:none;padding:0}section{border:1px solid #bbb;break-inside:auto}
.action,.comp,.lvl,.tile{break-inside:avoid}a{color:#000;text-decoration:none}h2,h3{break-after:avoid}}
`;

// The scale as five stops on a line, with the repo's level marked; nothing is marked when the
// audit couldn't give a level.
function ladderSvg(r: ReportJson, width = 640): string {
  const here = markedLevel(r);
  const h = 78;
  const pad = 46;
  const step = (width - pad * 2) / 4;
  const x = (l: number) => pad + l * step;
  const y = 30;
  const parts: string[] = [];
  parts.push(`<line x1="${x(0)}" y1="${y}" x2="${x(4)}" y2="${y}" stroke="var(--line)" stroke-width="6" stroke-linecap="round"/>`);
  if (here !== null && here > 0) parts.push(`<line x1="${x(0)}" y1="${y}" x2="${x(here)}" y2="${y}" stroke="var(--l${here})" stroke-width="6" stroke-linecap="round"/>`);
  for (const s of r.scale) {
    const on = here !== null && s.level <= here;
    // Reached stops take the repo's color, so a passed Level 0 doesn't read as a failure.
    parts.push(`<circle cx="${x(s.level)}" cy="${y}" r="${s.level === here ? 13 : 8}" fill="${on ? `var(--l${here})` : "var(--card)"}" stroke="${on ? `var(--l${here})` : "var(--line)"}" stroke-width="3"/>`);
    parts.push(`<text x="${x(s.level)}" y="${y + 4}" text-anchor="middle" font-size="${s.level === here ? 12 : 10}" font-weight="700" ${on ? 'style="fill:#fff"' : 'class="m"'}>${s.level}</text>`);
    parts.push(`<text x="${x(s.level)}" y="${y + 32}" text-anchor="middle" font-size="12" ${s.level === here ? 'font-weight="700"' : 'class="m"'}>${esc(s.name)}</text>`);
  }
  return `<svg role="img" aria-label="${esc(here === null ? "No level marked on the scale" : `Level ${here} of 4, ${r.scale[here].name}`)}" viewBox="0 0 ${width} ${h}" width="100%" style="max-width:${width}px">${parts.join("")}</svg>`;
}

// A step chart of the repo level at each audit and recheck; a hollow point where a record gave no level.
function trendSvg(points: { date: string; level: Level | null | undefined; kind: string; result: string }[], width = 380, height = 150): string {
  if (points.length < 2) return `<p class="muted small">This is the first audit, so there is no trend yet.</p>`;
  const left = 30;
  const right = 30;
  const top = 12;
  const bottom = 34;
  const iw = width - left - right;
  const ih = height - top - bottom;
  const x = (i: number) => left + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (l: number) => top + ih - (l / 4) * ih;
  const parts: string[] = [];
  for (let l = 0; l <= 4; l++) parts.push(`<line x1="${left}" x2="${width - right}" y1="${y(l)}" y2="${y(l)}" stroke="var(--soft)"/><text x="${left - 8}" y="${y(l) + 4}" text-anchor="end" font-size="10" class="m">${l}</text>`);
  let d = "";
  points.forEach((p, i) => {
    if (p.level === null || p.level === undefined) return;
    const prev = points.slice(0, i).reverse().find((q) => q.level !== null && q.level !== undefined);
    d += prev ? ` H${x(i)} V${y(p.level)}` : ` M${x(i)} ${y(p.level)}`;
  });
  if (d) parts.push(`<path d="${d.trim()}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>`);
  points.forEach((p, i) => {
    const has = p.level !== null && p.level !== undefined;
    const failed = p.kind === "recheck" && p.result === "failed";
    parts.push(`<circle cx="${x(i)}" cy="${has ? y(p.level as number) : y(0)}" r="4.5" fill="${has ? (failed ? "var(--bad)" : "var(--accent)") : "var(--card)"}" stroke="${failed ? "var(--bad)" : "var(--accent)"}" stroke-width="2"><title>${esc(`${fmtShortDate(p.date)}: ${p.kind}${failed ? ", failed" : ""}, ${levelText(p.level)}`)}</title></circle>`);
    const show = points.length <= 6 || i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 5) === 0;
    if (show) parts.push(`<text x="${x(i)}" y="${height - 14}" text-anchor="middle" font-size="10" class="m">${esc(fmtShortDate(p.date))}</text>`);
  });
  return `<svg role="img" aria-label="Level over time" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px">${parts.join("")}</svg>`;
}

function miniLadderSvg(level: Level | null): string {
  const dots = [0, 1, 2, 3, 4].map((l) => {
    const on = level !== null && l <= level;
    return `<circle cx="${8 + l * 18}" cy="8" r="${l === level ? 6 : 4}" fill="${on ? `var(--l${level})` : "var(--card)"}" stroke="${on ? `var(--l${level})` : "var(--line)"}" stroke-width="2"/>`;
  });
  return `<svg viewBox="0 0 96 16" width="96" height="16" aria-hidden="true"><line x1="8" x2="80" y1="8" y2="8" stroke="var(--line)" stroke-width="2"/>${dots.join("")}</svg>`;
}

function sparkSvg(levels: (Level | null | undefined)[]): string {
  if (levels.length < 2) return `<span class="small muted">first audit</span>`;
  const w = 110;
  const h = 26;
  const x = (i: number) => 4 + (i * (w - 8)) / (levels.length - 1);
  const y = (l: number) => h - 4 - (l / 4) * (h - 8);
  let d = "";
  levels.forEach((l, i) => {
    if (l === null || l === undefined) return;
    d += d ? ` H${x(i)} V${y(l)}` : `M${x(i)} ${y(l)}`;
  });
  const dots = levels.map((l, i) => (l === null || l === undefined ? `<circle cx="${x(i)}" cy="${y(0)}" r="2.5" fill="var(--card)" stroke="var(--muted)"/>` : `<circle cx="${x(i)}" cy="${y(l)}" r="2.5" fill="var(--accent)"/>`)).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(levels.map((l) => levelText(l)).join(", "))}"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/>${dots}</svg>`;
}

function supportHref(doc: string | null): string {
  if (!doc) return "";
  // report.html sits in .agent-readiness/latest/, two folders below the repo root.
  return doc.startsWith("references/") ? ` What the audit supports: <code>${esc(doc)}</code> in the agent-readiness skill.` : ` What the audit supports: <a href="../../${esc(doc)}">supported.md</a>.`;
}

function evLinks(ids: string[]): string {
  return ids.map((id) => `<a href="#${esc(id)}"><code>${esc(id)}</code></a>`).join(", ");
}

function whereAmI(r: ReportJson): string {
  const ex = r.executive;
  const conf = r.maturity.confidence;
  const history = r.progress?.history ?? [];
  const out: string[] = [];
  out.push(`<section id="where"><h2>1 · Where am I now</h2>`);
  out.push(`<p class="heading">${esc(ex.heading)}</p>`);
  out.push(`<p class="meta">Audited ${esc(fmtDate(r.audit.date))} at <code>${esc(r.audit.commit)}</code>. Confidence: ${esc(conf.level)} (${esc(conf.reasons.join("; "))}).</p>`);
  out.push(`<div class="headline"><small>Headline</small>${esc(ex.headline)}</div>`);
  out.push(`<div class="ladder">${ladderSvg(r, 900)}${markedLevel(r) === null ? `<p class="small muted">No level is marked: this audit couldn't give one.</p>` : ""}</div>`);
  out.push(`<div class="trend"><div class="legend">Repo level at each audit and recheck${history.length > 1 ? `, ${esc(fmtShortDate(history[0].date))} to ${esc(fmtShortDate(history[history.length - 1].date))}` : ""}</div>${trendSvg(history.map((h) => ({ date: h.date, level: h.repoLevel, kind: h.kind, result: h.result })), 900, 170)}</div>`);
  out.push(`<div class="tiles">${ex.numbers.map((n) => `<div class="tile"><div class="label">${esc(n.label)}</div><div class="value">${esc(n.value)}</div><div class="cmp">${esc(n.comparison)}.</div></div>`).join("")}</div>`);
  if (ex.unassessed) out.push(`<div class="callout"><strong>Not assessed:</strong> ${esc(ex.unassessed.text)}.${supportHref(ex.unassessed.supportDoc)}</div>`);
  const comps = r.components;
  const listed = comps.excluded.filter((c) => !c.reason.startsWith("not a component"));
  if (comps.included.length + listed.length > 1) {
    out.push(`<h3>Components</h3><div class="grid">`);
    for (const c of comps.included) {
      const level = c.unproven ? "Level 1 unproven here" : levelText(c.level);
      out.push(`<div class="comp"><div class="name">${esc(c.id)}${c.active ? "" : `<span class="tag">under 10%</span>`}</div><div class="small">${esc(level)}${c.couldBe !== null && !c.unproven ? ` (could be ${c.couldBe})` : ""}</div>${miniLadderSvg(c.unproven ? null : c.level)}<div class="bar"><i style="width:${Math.round(c.changeShare * 100)}%"></i></div><div class="small muted">${Math.round(c.changeShare * 100)}% of recent changes</div><div class="spark">${sparkSvg(history.map((h) => h.levels[c.id]))}${history.length > 1 ? `<span class="small muted">${esc(fmtShortDate(history[0].date))} to ${esc(fmtShortDate(history[history.length - 1].date))}</span>` : ""}</div></div>`);
    }
    for (const c of listed) {
      const unsupported = /isn't supported yet/.test(c.reason);
      out.push(`<div class="comp na"><div class="name">${esc(c.id)}<span class="tag">not assessed</span></div><div class="small">${esc(c.reason)}${unsupported ? `.${supportHref(ex.unassessed?.supportDoc ?? null)}` : ""}</div><div class="bar"><i style="width:${Math.round(c.changeShare * 100)}%"></i></div><div class="small muted">${Math.round(c.changeShare * 100)}% of recent changes</div></div>`);
    }
    out.push(`</div>`);
  }
  out.push(`<p class="small muted">${esc(ex.coverage)}</p></section>`);
  return out.join("");
}

function improved(r: ReportJson): string {
  const out: string[] = [`<section id="improved"><h2>2 · Have I improved</h2>`];
  if (!r.progress) return out.concat(`<p>This is the first audit, so there is nothing to compare yet. The next audit shows what changed.</p></section>`).join("");
  const ch = r.progress.changes;
  const arrow = (from: Level | null, to: Level | null) => (from === to ? `<span class="same">no change</span>` : from !== null && to !== null && to > from ? `<span class="up">▲ up</span>` : from !== null && to !== null ? `<span class="down">▼ down</span>` : `<span class="same">changed</span>`);
  if (ch) {
    out.push(`<p>Since the audit on ${esc(fmtDate(ch.since.date))}:</p><ul class="changes">`);
    out.push(`<li><strong>Repo level:</strong> ${esc(levelText(ch.repo.from))} to ${esc(levelText(ch.repo.to))} · ${arrow(ch.repo.from, ch.repo.to)}</li>`);
    for (const c of ch.components) out.push(`<li><code>${esc(c.id)}</code>: ${esc(levelText(c.from))} to ${esc(levelText(c.to))} · ${arrow(c.from, c.to)}</li>`);
    for (const m of ch.nowMet) out.push(`<li><span class="up">Now met</span> · <code>${esc(m.component)}</code>: ${esc(m.label)}</li>`);
    for (const m of ch.nowFailing) out.push(`<li><span class="down">Now failing</span> · <code>${esc(m.component)}</code>: ${esc(m.label)} (${esc(m.reason)})</li>`);
    const word = (ok: boolean | null) => (ok === true ? "passed" : ok === false ? "failed" : "not proven");
    for (const c of ch.checks) out.push(`<li>${esc(c.name)}: ${word(c.from)} then <span class="${c.to === true ? "up" : c.to === false ? "down" : "same"}">${word(c.to)}</span></li>`);
    if (!ch.components.length && !ch.nowMet.length && !ch.nowFailing.length && !ch.checks.length) out.push(`<li class="same">No component level, condition or check changed.</li>`);
    out.push(`</ul>`);
  } else out.push(`<p class="muted">The previous audit's sealed report isn't readable here, so only the levels below are compared.</p>`);
  const hist = r.progress.history;
  const keys = Object.keys(hist[hist.length - 1].levels);
  const cell = (v: Level | null | undefined) => (v === undefined ? "-" : v === null ? "not assessed" : String(v));
  out.push(`<h3>Levels over time</h3><table><thead><tr><th>Date</th><th>Record</th><th>Repo</th>${keys.map((k) => `<th>${esc(k)}</th>`).join("")}</tr></thead><tbody>`);
  for (const h of hist) out.push(`<tr><td>${esc(fmtShortDate(h.date))}</td><td>${esc(`${h.kind}${h.result === "failed" ? " failed" : ""}${h.note ? `, ${h.note}` : ""}`)}</td><td>${cell(h.repoLevel)}</td>${keys.map((k) => `<td>${cell(h.levels[k])}</td>`).join("")}</tr>`);
  out.push(`</tbody></table><p class="small muted">A failed recheck lowers a level and a later passing recheck restores it. Only an audit can raise a level above the last audit.</p>`);
  if (r.progress.rubricChanges.length) out.push(`<p class="small">Rubric changes: ${esc(r.progress.rubricChanges.map((c) => `${fmtShortDate(c.date)} ${c.from} to ${c.to}`).join("; "))}. A level change at a rubric change can come from the rubric, not the repo.</p>`);
  if (r.progress.closed.length) {
    out.push(`<h3>What each closed step was expected to move, and what moved after it</h3><table><thead><tr><th>Step</th><th style="width:80px">Closed</th><th>Expected</th><th>Observed after</th></tr></thead><tbody>`);
    for (const c of r.progress.closed) out.push(`<tr><td>${esc(c.title)}</td><td>${esc(fmtShortDate(c.closed))}</td><td>${esc(c.expected)}</td><td>${esc(c.observed)}</td></tr>`);
    out.push(`</tbody></table><p class="small muted">Movement after a step closed, not proof that the step caused it. Each step shows its own measure; steps closed in the same audit share the window after it, so a change can't be credited to one of them.</p>`);
  }
  if (r.progress.weakening) out.push(`<div class="callout">${esc(r.progress.weakening)}</div>`);
  return out.concat("</section>").join("");
}

function needle(r: ReportJson): string {
  const ex = r.executive;
  const out: string[] = [`<section id="next"><h2>3 · What moves the needle next</h2><p>${esc(ex.nextLine)}</p>`];
  for (const a of r.actions) {
    const gap = ex.gaps.find((g) => g.itemId === a.itemId);
    out.push(`<div class="action"><div class="rank">${a.rank}</div><div><h3>${inline(a.title)}${a.startNow ? `<span class="tag">can start now</span>` : ""}</h3>`);
    // A narrated gap can say more than the title; when it is the title, only what it blocks is new.
    if (gap) out.push(`<div class="small muted">${gap.text === a.title.replace(/`/g, "") ? "" : `${esc(gap.text)}. `}${esc(gap.blocks)}.</div>`);
    out.push(`<p class="unlocks">${inline(a.movesTheNeedle)}</p><div class="bar" title="Share of recent changes"><i style="width:${Math.round(a.impact * 100)}%"></i></div><div class="small muted">Unblocks ${Math.round(a.impact * 100)}% of recent changes</div>`);
    out.push(`<dl class="kv"><dt>Effort</dt><dd><span class="chip">${esc(a.effort)}</span>${inline(a.effortAndOwner)}</dd><dt>Why it matters</dt><dd>${inline(a.why)}</dd>`);
    if (a.evidence?.length) out.push(`<dt>Evidence</dt><dd>${evLinks(a.evidence)}</dd>`);
    if (a.decision) out.push(`<dt>Decision needed</dt><dd>${inline(a.decision)}.</dd>`);
    if (a.dependsOn.length) out.push(`<dt>Depends on</dt><dd>${inline(list(a.dependsOn))}</dd>`);
    out.push(`<dt>What to watch</dt><dd>${inline(a.watch)}</dd><dt>Done when</dt><dd>${inline(a.doneWhen)}</dd>`);
    if (a.research) out.push(`<dt>Research</dt><dd class="small">${inline(a.research)}</dd>`);
    out.push(`</dl></div></div>`);
  }
  const noResults = r.maturity.outcome === "not_assessed";
  if (r.actions.length === 0) out.push(`<p>${esc(r.maturity.assessedComponents === 0 ? "No actions can be planned yet: no component could be assessed, so nothing was checked." : noResults ? "No actions can be planned yet: this audit has no real check results to plan from." : r.maturity.outcome === "blocked" ? `No actions are open: nothing in the repo blocks Level ${r.maturity.level + 1}. Proving it needs a rerun where this machine's limits don't apply, such as CI with Docker or Podman.` : "No actions are open.")}</p>`);
  out.push(`<div class="callout ask"><strong>Recommendation:</strong> ${esc(ex.ask)}</div></section>`);
  return out.join("");
}

function roadmap(r: ReportJson): string {
  const here = markedLevel(r);
  const out: string[] = [`<section id="roadmap"><h2>4 · Roadmap to the max level</h2>`];
  if (r.maturity.outcome === "not_assessed") out.push(`<p class="muted">This audit added no steps, because it has no real check results to plan from. The roadmap is as the last audit left it.</p>`);
  out.push(`<p class="small">${r.roadmap.doneCount} of ${r.roadmap.total} steps done. Kept in <code>.agent-readiness/roadmap.json</code>.${r.roadmap.owner ? ` Owner: ${esc(r.roadmap.owner)}.` : ""}</p>`);
  const step = (i: ReportJson["roadmap"]["items"][number]) => `<li>${i.status === "done" ? "☑" : "☐"} <strong>${i.order}.</strong> ${inline(i.title)} <span class="status">· unlocks ${inline(i.unlocks)} · ${esc(i.statusText)}</span></li>`;
  for (const L of [1, 2, 3, 4] as Level[]) {
    const s = r.scale[L];
    const state = here !== null && here >= L ? "reached" : (here ?? -1) + 1 === L ? "next" : "later";
    const needs = L === 1 ? r.details.levelRules.level1 : L === 2 ? r.details.levelRules.level2 : `Level ${L} means: ${s.meaning.charAt(0).toLowerCase()}${s.meaning.slice(1).replace(/\.$/, "")}`;
    const items = r.roadmap.items.filter((i) => i.level === L);
    out.push(`<div class="lvl ${state}"><h3>Level ${L}, ${esc(s.plain)} <span class="tag">${state}</span></h3><div class="small muted">${esc(needs)}.</div>`);
    if (items.length) out.push(`<ul class="steps">${items.map(step).join("")}</ul>`);
    else if (state !== "reached") out.push(`<p class="small muted">${state === "next" ? "No step is open for it in the roadmap yet." : "Its steps are added once the level below it is reached."}</p>`);
    out.push(`</div>`);
  }
  const every = r.roadmap.items.filter((i) => i.level === null || i.level === undefined);
  if (every.length) out.push(`<div class="lvl"><h3>For every level</h3><ul class="steps">${every.map(step).join("")}</ul></div>`);
  return out.concat("</section>").join("");
}

function details(r: ReportJson): string {
  const out: string[] = [`<section id="details"><h2>5 · Audit details</h2>`];
  out.push(`<h3>Everything we checked, and why</h3><table><thead><tr><th style="width:22%">Check</th><th style="width:38%">Why we check it</th><th style="width:25%">Result</th><th>Evidence</th></tr></thead><tbody>`);
  for (const c of r.details.checks) {
    const cls = c.ok === true ? "ok" : c.ok === false ? "bad" : "unk";
    const src = c.sources.map((s) => ` ${esc(s.claim)} ${esc(s.caveat)} (<a href="${esc(s.url)}">source</a>)`).join("");
    out.push(`<tr><td>${esc(c.name)}<br><code>${esc(c.id)}</code></td><td>${esc(c.why)}<span class="small muted">${src}</span></td><td class="${cls}">${esc(c.result)}</td><td>${evLinks(c.evidence)}</td></tr>`);
  }
  out.push(`</tbody></table><p class="small muted">Not assessed by this rubric version, which is different from unknown: ${esc(list(r.details.notAssessed.map((n) => n.charAt(0).toLowerCase() + n.slice(1))))}.</p>`);
  for (const s of r.details.steps) out.push(`<h3>Steps for ${inline(s.title)}</h3><ol>${s.steps.map((st) => `<li><strong>${inline(st.title)}.</strong> ${inline(st.detail)}</li>`).join("")}</ol>`);
  const comps = r.components;
  const cellLevel = (level: Level | null, couldBe: Level | null, unproven = false) => (level === null ? "not assessed" : unproven ? "Level 1 unproven on this machine (could be 1)" : `${level} ${r.scale[level].name}${couldBe !== null ? ` (could be ${couldBe})` : ""}`);
  out.push(`<h3>Levels by component</h3><p class="small">Repo shape: ${esc(comps.shape === "sampled_monorepo" ? "monorepo, sampled (only the most active supported components are assessed)" : comps.shape)}.</p><table><thead><tr><th>Component</th><th>Path</th><th>Toolchain</th><th style="width:70px">Share</th><th>Level</th></tr></thead><tbody>`);
  for (const c of comps.included) {
    out.push(`<tr><td><code>${esc(c.id)}</code>${c.active ? "" : " (under 10%)"}</td><td><code>${esc(c.path)}</code></td><td>${esc(c.toolchain)}</td><td>${Math.round(c.changeShare * 100)}%</td><td>${esc(cellLevel(c.level, c.couldBe, c.unproven))}</td></tr>`);
    for (const s of c.scenarios) out.push(`<tr><td><code>${esc(c.id)}</code> › ${esc(s.label)}</td><td></td><td></td><td></td><td>${esc(cellLevel(s.level, s.couldBe, s.unproven))}</td></tr>`);
  }
  for (const c of comps.excluded) out.push(`<tr><td><code>${esc(c.id)}</code></td><td><code>${esc(c.path)}</code></td><td>${esc(c.toolchain)}</td><td>${c.reason.startsWith("not a component") ? "n/a" : `${Math.round(c.changeShare * 100)}%`}</td><td>not assessed: ${esc(c.reason)}</td></tr>`);
  const noResults = r.maturity.outcome === "not_assessed";
  out.push(`</tbody></table><p class="small">Repo level: ${esc(noResults ? "not assessed" : r.maturity.unproven ? "Level 1 unproven on this machine (could be 1)" : `${r.maturity.level} ${r.scale[r.maturity.level].name}`)}. ${esc(r.maturity.rule)}</p>`);
  if (r.maturity.capReasons.length) out.push(`<p class="small">${esc(r.maturity.unproven ? "What keeps Level 1 unproven on this machine:" : `What holds the repo at Level ${r.maturity.level}:`)}</p><ul class="small">${r.maturity.capReasons.map((c) => `<li>${c.component === "*" ? "Repo" : `<code>${esc(c.component)}</code>`}: ${esc(c.label)}, ${esc(c.state === "blocked" ? "blocked on this machine" : c.state === "unknown" ? "not proven" : "not met")} (${esc(c.reason)}).</li>`).join("")}</ul>`);
  out.push(`<p class="small"><strong>Standard level:</strong> ${esc(r.details.levelRules.level1)}. ${esc(r.details.levelRules.level2)}.${r.details.levelRules.scenarios.map((s) => ` <strong>${esc(s.label)} scenario:</strong> ${esc(s.bar)}.`).join("")}</p>`);
  const oc = r.details.outcomes;
  out.push(`<h3>Agent PR outcomes</h3>`);
  if (oc) {
    out.push(`<p class="small">${esc(oc.window)}. Agent PRs are matched by ${esc(oc.filter)}. Source: ${esc(oc.source)}.</p><table><thead><tr><th>Measure</th>${oc.series.map((s) => `<th>${esc(s.label)}</th>`).join("")}</tr></thead><tbody>`);
    const rate = (v: Parameters<typeof describeRate>[0]) => esc(describeRate(v));
    out.push(`<tr><td>Opened</td>${oc.series.map((s) => `<td>${s.opened}</td>`).join("")}</tr>`);
    out.push(`<tr><td>Merged</td>${oc.series.map((s) => `<td>${rate(s.merged)}</td>`).join("")}</tr>`);
    out.push(`<tr><td>Passed CI the first time</td>${oc.series.map((s) => `<td>${rate(s.firstTimeCi)}</td>`).join("")}</tr>`);
    out.push(`<tr><td>Reviewer requested changes</td>${oc.series.map((s) => `<td>${rate(s.changesRequested)}</td>`).join("")}</tr>`);
    out.push(`<tr><td>Median days to merge</td>${oc.series.map((s) => `<td>${s.medianDaysToMerge ?? "n/a"}</td>`).join("")}</tr></tbody></table>`);
    out.push(`<p class="small muted">${esc(oc.multiComponentNote)} ${esc(oc.caveat)} Matched PRs: ${esc(oc.matchedPrs.map((n) => `#${n}`).join(", ") || "none")}.</p>`);
  } else out.push(`<p class="small muted">Not measured: outcomes need the external-systems tier and <code>readiness outcomes</code>.</p>`);
  out.push(`<h3>Agent assets already in the repo</h3>`);
  if (r.details.assets.length) out.push(`<table><thead><tr><th style="width:110px">Asset</th><th>Path</th><th>Authors</th><th style="width:90px">Last changed</th><th>Status</th></tr></thead><tbody>${r.details.assets.map((a) => `<tr><td>${esc(a.kind)}</td><td><code>${esc(a.path)}</code></td><td>${esc(a.authors.join(", ") || "unknown")}</td><td>${esc(a.lastChanged ? fmtShortDate(a.lastChanged) : "n/a")}</td><td>${esc(a.status)}</td></tr>`).join("")}</tbody></table>`);
  if (r.details.missingAssets.length) out.push(`<p class="small">Missing: ${esc(list(r.details.missingAssets))}.</p>`);
  if (r.details.signals.length) out.push(`<h3>Other signals (informational, not scored)</h3><table><thead><tr><th>Signal</th><th style="width:70px">Found</th><th>Detail</th></tr></thead><tbody>${r.details.signals.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.found === null ? "n/a" : s.found ? "yes" : "no"}</td><td>${esc(s.detail)}</td></tr>`).join("")}</tbody></table><p class="small muted">These don't set a level or add a roadmap step.</p>`);
  out.push(`<h3>Evidence log</h3><table><thead><tr><th style="width:62px">ID</th><th style="width:20%">Check</th><th style="width:12%">Component</th><th style="width:26%">What ran</th><th>Result</th></tr></thead><tbody>`);
  for (const e of r.details.evidence) {
    const cls = e.result === "pass" ? "ok" : e.result === "fail" ? "bad" : "unk";
    const ran = e.ran === e.summary ? `<span class="muted">${esc(e.where)}</span>` : `<code>${esc(e.ran)}</code><br><span class="small muted">${esc(e.where)}</span>`;
    out.push(`<tr id="${esc(e.id)}"><td><code>${esc(e.id)}</code></td><td><code>${esc(e.check)}</code></td><td>${esc(e.component ?? "repo")}</td><td>${ran}</td><td><span class="${cls}">${esc(e.result)}</span>: ${esc(e.summary)}</td></tr>`);
  }
  out.push(`</tbody></table><p class="small muted">Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container, confirmed by outcomes. A check passes only at its required strength.</p>`);
  out.push(`<h3>Audit record</h3><dl class="kv">${r.details.record.map((x) => `<dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd>`).join("")}</dl></section>`);
  return out.join("");
}

export function renderHtml(r: ReportJson): string {
  const fromFile = r.details.outcomes !== null && r.details.outcomes.source !== "GitHub through gh";
  const banner = `${r.audit.seedPinned ? "Eval run with a pinned seed; not a production result. " : fromFile ? "Outcomes come from a recorded PR file, not GitHub; not a production result. " : ""}${r.audit.sealStatus}.${r.audit.staleCopy ? ` ${r.audit.staleCopy}` : ""}`;
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Agent readiness: ${esc(r.repo)}</title><style>${CSS}</style></head>`,
    `<body><div class="page"><header><h1>Agent readiness: ${esc(r.repo)}</h1><div class="meta">Audit <code>${esc(r.audit.id)}</code> · rubric ${esc(r.audit.rubric)} · ${esc(r.audit.tier)} tier</div><div class="banner">${esc(banner)}</div></header>`,
    whereAmI(r),
    improved(r),
    needle(r),
    roadmap(r),
    details(r),
    `<footer>Generated from <code>report.json</code> by the agent-readiness skill. The same data is in <code>report.md</code>.</footer></div></body></html>`,
    "",
  ].join("\n");
}

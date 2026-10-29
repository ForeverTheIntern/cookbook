import { componentLevel, repoWideLevel } from "./levels.ts";
import { describeRate, rate, windowLabel } from "./outcomes.ts";
import type { Rubric, RubricTemplate } from "./rubric.ts";
import type { CompStates } from "./score.ts";
import type { ActivityId, Audit, CondId, CondState, Component, Effort, Fix, Level, OutcomeStats, OutcomesSnapshot, Roadmap, RoadmapItem, Watch } from "./types.ts";
import { fill, nowIso, today } from "./util.ts";

type StateMap = Partial<Record<CondId, CondState>>;

export interface RoadmapContext {
  audit: Audit;
  rubric: Rubric;
  goal: ActivityId;
  components: Component[];
  states: Map<string, CompStates>;
  active: Set<string>;
  outcomes: OutcomesSnapshot | null;
}

interface Candidate {
  id: string;
  template: string;
  kind: RoadmapItem["kind"];
  component: string;
  fixes: Fix[];
  vars: Record<string, string | number>;
  evidence: string[];
  title?: string;
}

const EFFORT_ORDER: Record<Effort, number> = { small: 0, medium: 1, large: 2 };
const LOCK_FOR: Record<string, string> = { npm: "package-lock.json", yarn: "yarn.lock", pnpm: "pnpm-lock.yaml" };

function activityLabel(rubric: Rubric, goal: ActivityId): string {
  return rubric.activities.find((a) => a.id === goal)!.label.toLowerCase();
}

function stateMaps(ctx: RoadmapContext): Map<string, StateMap> {
  const out = new Map<string, StateMap>();
  for (const [id, detail] of ctx.states) {
    const m: StateMap = {};
    for (const [k, v] of Object.entries(detail)) m[k as CondId] = v.state;
    out.set(id, m);
  }
  return out;
}

function goalLevels(rubric: Rubric, maps: Map<string, StateMap>, goal: ActivityId): Map<string, Level> {
  const out = new Map<string, Level>();
  if (goal === "repo_wide") {
    const l = repoWideLevel(rubric, maps).level;
    for (const id of maps.keys()) out.set(id, l);
    return out;
  }
  for (const [id, m] of maps) out.set(id, componentLevel(rubric, m, goal).level);
  return out;
}

function neededConds(rubric: Rubric, goal: ActivityId, level: Level): CondId[] {
  if (level === 0) return rubric.level1;
  if (level === 1) return rubric.activities.find((a) => a.id === goal)!.level2;
  return [];
}

function latestEvidence(audit: Audit, pred: (e: Audit["evidence"][number]) => boolean) {
  const hits = audit.evidence.filter(pred);
  return hits[hits.length - 1];
}

export function candidates(ctx: RoadmapContext): Candidate[] {
  const { audit, rubric, goal } = ctx;
  const out: Candidate[] = [];
  const assessed = ctx.components.filter((c) => c.assessed);
  const goalNeedsFaults = rubric.activities.find((a) => a.id === goal)!.level2.includes("faults");
  const anyRepo = assessed[0] ? ctx.states.get(assessed[0].id) : undefined;
  const credentialComps: string[] = [];
  if (assessed.some((c) => ctx.states.get(c.id)?.["clean.install"].state === "not_met")) {
    const ev = latestEvidence(audit, (e) => e.kind === "install");
    out.push({ id: "clean.install:repo", template: "clean.install", kind: "fix", component: "*", fixes: assessed.map((c) => ({ condition: "clean.install" as CondId, component: c.id })), vars: { component: "the repo", diagnosis: ev?.diagnosis?.detail ?? ev?.summary ?? "the install failed" }, evidence: ev ? [ev.id] : [] });
  }
  for (const c of assessed) {
    const s = ctx.states.get(c.id)!;
    if (s["clean.build"].state === "not_met" && s["clean.install"].state !== "not_met") {
      const ev = latestEvidence(audit, (e) => e.kind === "build" && e.component === c.id);
      out.push({ id: `clean.build:${c.id}`, template: "clean.build", kind: "fix", component: c.id, fixes: [{ condition: "clean.build", component: c.id }], vars: { component: c.id, diagnosis: ev?.diagnosis?.detail ?? "the build failed" }, evidence: ev ? [ev.id] : [] });
    }
    const failedKinds = audit.contract
      .filter((k) => k.component === c.id && ["build", "lint", "typecheck", "test"].includes(k.kind))
      .filter((k) => latestEvidence(audit, (e) => e.contractId === k.id)?.result === "fail")
      .map((k) => k.kind);
    if (s["clean.test"].state === "not_met" && s["clean.install"].state !== "not_met") {
      const ev = latestEvidence(audit, (e) => e.kind === "test" && e.component === c.id && e.result === "fail");
      const d = ev?.diagnosis;
      const template = d?.cause === "service" ? "clean.test:service" : d?.cause === "credential" ? "clean.test:credential" : "clean.test";
      const fixes: Fix[] = [{ condition: "clean.test", component: c.id }];
      if (failedKinds.filter((k) => k !== "test").length === 0) fixes.push({ condition: "commands", component: c.id });
      if (template === "clean.test:credential") credentialComps.push(c.id);
      out.push({ id: `clean.test:${c.id}`, template, kind: "fix", component: c.id, fixes, vars: { component: c.id, service: d?.service ?? "", diagnosis: d?.detail ?? s["clean.test"].reason }, evidence: ev ? [ev.id] : s["clean.test"].evidence });
    }
    const otherKinds = failedKinds.filter((k) => k !== "test" || s["clean.test"].state !== "not_met");
    if (s.commands.state === "not_met" && otherKinds.length > 0) {
      const ev = latestEvidence(audit, (e) => e.component === c.id && e.result === "fail" && e.contractId !== undefined && e.kind !== undefined && otherKinds.includes(e.kind));
      out.push({ id: `commands:${c.id}`, template: "commands", kind: "fix", component: c.id, fixes: [{ condition: "commands", component: c.id }], vars: { component: c.id, kinds: otherKinds.join(" and "), diagnosis: ev?.diagnosis?.detail ?? s.commands.reason }, evidence: ev ? [ev.id] : [] });
    }
    if (goalNeedsFaults && s.faults.state === "not_met") {
      const mine = audit.mutants.filter((m) => m.component === c.id && (m.result === "caught" || m.result === "survived"));
      const files = [...new Set(audit.mutants.filter((m) => m.component === c.id && m.result === "survived").map((m) => m.file))];
      out.push({ id: `faults:${c.id}`, template: "faults", kind: "fix", component: c.id, fixes: [{ condition: "faults", component: c.id }], vars: { component: c.id, planted: mine.length, caught: mine.filter((m) => m.result === "caught").length, files: files.join(", ") || c.path }, evidence: s.faults.evidence });
    }
    if (goalNeedsFaults && s.faults.state === "unknown" && s["clean.test"].state === "not_met") {
      out.push({ id: `faults:${c.id}`, template: "faults", kind: "fix", component: c.id, fixes: [{ condition: "faults", component: c.id }], vars: { component: c.id, planted: 0, caught: 0, files: c.path }, evidence: [], title: `Check ${c.id}'s tests with planted faults` });
    }
  }
  if (anyRepo?.instructions.state === "not_met") {
    const failed = audit.instructions.filter((i) => i.result === "fail");
    const files = [...new Set(failed.map((i) => i.source))];
    const itemList = failed.map((i) => `\`${i.source}:${i.line}\` \`${i.text}\`: ${i.reason ?? i.staticReason ?? "fails"}`).join("; ");
    const diag = failed.slice(0, 2).map((i) => `${i.text} (${i.reason ?? i.staticReason})`).join(", ");
    out.push({ id: "instructions:repo", template: "instructions", kind: "fix", component: "*", fixes: [{ condition: "instructions", component: "*" }], vars: { failedCount: failed.length, fileCount: files.length, diagnosis: diag, itemList }, evidence: failed.map((i) => i.evidenceId).filter((x): x is string => Boolean(x)) });
  }
  if (anyRepo?.safety.state === "not_met") {
    const blocking = audit.safety.filter((s) => s.blocking);
    const secrets = blocking.filter((s) => s.kind === "secret");
    if (secrets.length) out.push({ id: "safety:secret", template: "safety:secret", kind: "fix", component: "*", fixes: [{ condition: "safety", component: "*" }], vars: { count: secrets.length, fileCount: new Set(secrets.map((s) => s.file)).size, types: [...new Set(secrets.map((s) => s.detail))].join(", ") }, evidence: [] });
    const hooks = blocking.filter((s) => s.kind === "network_piped");
    if (hooks.length) out.push({ id: "safety:hook", template: "safety:hook", kind: "fix", component: "*", fixes: [{ condition: "safety", component: "*" }], vars: { detail: hooks.map((h) => `${h.file} ${h.detail}`).join("; ") }, evidence: [] });
    const creds = blocking.filter((s) => s.kind === "credential_needed");
    if (creds.length) {
      const withTestItem = out.filter((x) => x.template === "clean.test:credential");
      if (withTestItem.length) for (const x of withTestItem) x.fixes.push({ condition: "safety", component: "*" });
      else out.push({ id: "safety:credential", template: "safety:credential", kind: "fix", component: "*", fixes: [{ condition: "safety", component: "*" }], vars: { detail: creds.map((c) => c.detail).join("; ") }, evidence: [] });
    }
  }
  if (anyRepo?.toolchain.state === "not_met" && audit.profile) {
    const missing = audit.profile.toolchain.missing;
    const advice = missing.map((m) => (m.includes("Node") ? "add `.nvmrc` with the Node major version" : m.includes("Python") ? "add `.python-version`" : `add \`packageManager\` to package.json for ${m}`)).join("; ");
    out.push({ id: "toolchain:repo", template: "toolchain", kind: "fix", component: "*", fixes: [{ condition: "toolchain", component: "*" }], vars: { missing: missing.join(" and "), advice }, evidence: [] });
  }
  if (anyRepo?.lockfile.state === "not_met" && audit.profile) {
    const pm = audit.profile.packageManager;
    const advice = pm === "pip" ? "pin exact versions in `requirements.txt`, or move to `uv` with a committed `uv.lock`" : `commit the ${pm ?? "package manager"} lockfile and install with a frozen install`;
    out.push({ id: "lockfile:repo", template: "lockfile", kind: "fix", component: "*", fixes: [{ condition: "lockfile", component: "*" }], vars: { diagnosis: anyRepo.lockfile.reason, advice }, evidence: anyRepo.lockfile.evidence });
  }
  return out;
}

function statsFor(o: OutcomesSnapshot | null, scope: string): OutcomeStats | null {
  if (!o) return null;
  return scope === "repo" ? o.agent : o.byComponent[scope] ?? null;
}

export function watchFor(metric: string, scope: string, o: OutcomesSnapshot | null, rubric: Rubric, pattern?: string): Watch {
  const s = statsFor(o, scope);
  if (!o || !s) return { metric, scope, baseline: "not measured (outcomes need the external-systems tier)", n: null, window: null };
  const w = windowLabel(o);
  let r;
  if (metric === "first_time_ci_pass") r = rate(s.firstTimeCiPass, s.firstTimeCiKnown, rubric, w);
  else if (metric === "changes_requested") r = rate(s.changesRequested, s.opened, rubric, w);
  else if (metric === "prs_adding_path") r = rate(s.addingPaths[pattern ?? ""] ?? 0, s.opened, rubric, w);
  else r = rate(s.merged, s.opened, rubric, w);
  return { metric: pattern ? `${metric}:${pattern}` : metric, scope, baseline: describeRate(r), n: r.n, window: w };
}

function expectedFor(c: Candidate, ctx: RoadmapContext): RoadmapItem["expected"] {
  const { rubric, outcomes, audit } = ctx;
  const scope = c.component === "*" ? "repo" : c.component;
  const label = activityLabel(rubric, ctx.goal);
  if (c.template.startsWith("clean.") || c.template === "commands") {
    return { outcome: `Agents can run ${scope === "repo" ? "the repo" : scope}'s checks before they push, so fewer agent PRs fail CI the first time.`, watch: watchFor("first_time_ci_pass", scope, outcomes, rubric) };
  }
  if (c.template === "faults") return { outcome: `Changes in ${scope} get a real pass-or-fail signal, so reviewers catch less by hand.`, watch: watchFor("changes_requested", scope, outcomes, rubric) };
  if (c.template === "instructions") {
    const wrongPm = audit.instructions.find((i) => i.result === "fail" && /^uses (npm|pnpm|yarn),/.test(i.reason ?? ""));
    const pm = wrongPm?.reason?.match(/^uses (\w+)/)?.[1];
    if (pm && LOCK_FOR[pm]) return { outcome: `Agents stop following stale steps, such as running ${pm} in a repo that doesn't use it.`, watch: watchFor("prs_adding_path", "repo", outcomes, rubric, LOCK_FOR[pm]) };
    return { outcome: "Agents stop following stale steps.", watch: watchFor("changes_requested", "repo", outcomes, rubric) };
  }
  if (c.template.startsWith("safety")) return { outcome: "Agents can do normal work without production access.", watch: watchFor("first_time_ci_pass", "repo", outcomes, rubric) };
  if (c.template === "toolchain" || c.template === "lockfile") return { outcome: "Agents, CI and laptops build with the same versions.", watch: watchFor("first_time_ci_pass", "repo", outcomes, rubric) };
  if (c.template === "delegate") return { outcome: `The next report has real agent PR numbers for ${scope}, which Level 3 is measured on.`, watch: watchFor("merged", scope, outcomes, rubric) };
  if (c.template === "targets") return { outcome: `Each report shows how far ${label} are from Level 3.`, watch: watchFor("merged", "repo", outcomes, rubric) };
  return { outcome: "Approvals and targets have a named owner.", watch: watchFor("merged", "repo", outcomes, rubric) };
}

function flipFor(item: RoadmapItem, open: RoadmapItem[], maps: Map<string, StateMap>): Map<string, StateMap> {
  const out = new Map<string, StateMap>();
  for (const [id, m] of maps) out.set(id, { ...m });
  for (const f of item.fixes) {
    const others = open.filter((o) => o.id !== item.id && o.fixes.some((x) => x.condition === f.condition && (x.component === f.component || x.component === "*" || f.component === "*")));
    if (others.length > 0) continue;
    for (const [id, m] of out) if (f.component === "*" || f.component === id) m[f.condition] = "met";
  }
  return out;
}

function sharesOf(ctx: RoadmapContext): Map<string, number> {
  return new Map(ctx.components.map((c) => [c.id, c.changeShare]));
}

function unlocksText(rubric: Rubric, goal: ActivityId, before: Map<string, Level>, after: Map<string, Level>): string {
  const rose = [...after.entries()].filter(([id, l]) => l > (before.get(id) ?? 0));
  if (rose.length === 0) return "";
  const label = activityLabel(rubric, goal);
  if (goal === "repo_wide") return `the repo to Level ${rose[0][1]} for ${label}`;
  return `${rose.map(([id, l]) => `${id} to Level ${l}`).join(", ")} for ${label}`;
}

function fromTemplate(t: RubricTemplate, vars: Record<string, string | number>) {
  return {
    title: fill(t.title, vars),
    why: fill(t.why, vars),
    doneWhen: fill(t.doneWhen, vars),
    size: fill(t.size, vars),
    decision: t.decision ? fill(t.decision, vars) : null,
    steps: t.steps.map((s) => ({ title: fill(s.title, vars), detail: fill(s.detail, vars) })),
  };
}

export interface RoadmapResult {
  roadmap: Roadmap;
  top: RoadmapItem[];
  startNow: RoadmapItem | null;
  levels: Map<string, Level>;
}

export function updateRoadmap(prev: Roadmap | null, ctx: RoadmapContext): RoadmapResult {
  const { rubric, goal, audit } = ctx;
  const label = activityLabel(rubric, goal);
  const date = today();
  const roadmap: Roadmap = prev
    ? { ...prev, items: prev.items.map((i) => ({ ...i })), updatedBy: audit.id, updatedAt: nowIso() }
    : { schema: "agent-readiness/roadmap@1", owner: null, targets: null, items: [], updatedBy: audit.id, updatedAt: nowIso() };
  const maps = stateMaps(ctx);
  const levels = goalLevels(rubric, maps, goal);
  const cands = candidates(ctx);
  const decisions: Candidate[] = [];
  decisions.push({ id: "owner", template: "owner", kind: "decision", component: "*", fixes: [], vars: {}, evidence: [] });
  for (const c of ctx.components.filter((x) => ctx.active.has(x.id) && levels.get(x.id) === 2)) {
    decisions.push({ id: `delegate:${goal}:${c.id}`, template: "delegate", kind: "rollout", component: c.id, fixes: [], vars: { component: c.id, activity: label }, evidence: [] });
  }
  decisions.push({ id: `targets:${goal}`, template: "targets", kind: "decision", component: "*", fixes: [], vars: { activity: label }, evidence: [] });
  const byId = new Map(roadmap.items.map((i) => [i.id, i]));
  let order = roadmap.items.reduce((m, i) => Math.max(m, i.order), 0);
  const currentIds = new Set<string>();
  const newOnes: RoadmapItem[] = [];
  for (const c of [...cands, ...decisions]) {
    currentIds.add(c.id);
    const t = rubric.templates[c.template];
    const filled = fromTemplate(t, c.vars);
    const existing = byId.get(c.id);
    const base = {
      kind: c.kind,
      template: c.template,
      title: audit.narration?.titles?.[c.id] ?? c.title ?? filled.title,
      fixes: c.fixes,
      effort: t.effort,
      size: filled.size,
      ownerRole: t.ownerRole,
      decision: filled.decision,
      why: filled.why,
      doneWhen: filled.doneWhen,
      steps: filled.steps,
      evidence: c.evidence,
    };
    if (existing) {
      Object.assign(existing, base);
      if (existing.status === "done" && c.kind === "fix") {
        existing.status = "later";
        existing.closedAt = null;
        existing.closedBy = null;
        existing.observed = null;
      }
    } else {
      const item: RoadmapItem = { id: c.id, order: 0, status: "later", unlocks: "", impact: 0, dependsOn: [], expected: expectedFor(c, ctx), createdAt: date, createdBy: audit.id, closedAt: null, closedBy: null, observed: null, ...base };
      newOnes.push(item);
      roadmap.items.push(item);
      byId.set(item.id, item);
    }
  }
  for (const item of roadmap.items) {
    if (currentIds.has(item.id)) continue;
    if (item.kind === "fix" && item.status !== "done") {
      item.status = "done";
      item.closedAt = date;
      item.closedBy = audit.id;
    }
    if (item.template === "delegate" && item.status !== "done") item.status = "later";
  }
  const owner = byId.get("owner")!;
  const targets = byId.get(`targets:${goal}`)!;
  if (roadmap.owner) owner.status = "done";
  if (roadmap.targets) targets.status = "done";
  if (roadmap.owner && !owner.closedAt) {
    owner.closedAt = date;
    owner.closedBy = audit.id;
  }
  if (roadmap.targets && !targets.closedAt) {
    targets.closedAt = date;
    targets.closedBy = audit.id;
  }
  const open = roadmap.items.filter((i) => i.kind === "fix" && i.status !== "done");
  const shares = sharesOf(ctx);
  for (const item of open) {
    const after = goalLevels(rubric, flipFor(item, open, maps), goal);
    const rose = [...after.entries()].filter(([id, l]) => l > (levels.get(id) ?? 0) && (goal === "repo_wide" || ctx.active.has(id)));
    item.impact = goal === "repo_wide" ? (rose.length ? Math.min(1, [...ctx.active].reduce((s, id) => s + (shares.get(id) ?? 0), 0)) : 0) : Math.min(1, Math.round(rose.reduce((s, [id]) => s + (shares.get(id) ?? 0), 0) * 1000) / 1000);
    const text = unlocksText(rubric, goal, levels, after);
    const prerequisites = new Set<string>();
    const coRequired = new Set<string>();
    const goalConds = new Set<CondId>([...rubric.level1, ...rubric.activities.find((a) => a.id === goal)!.level2]);
    const flippedAll = flipFor(item, open, maps);
    for (const f of item.fixes) {
      if (!goalConds.has(f.condition)) continue;
      const targetsComps = f.component === "*" ? [...maps.keys()] : [f.component];
      for (const compId of targetsComps) {
        const needed = neededConds(rubric, goal, levels.get(compId) ?? 0);
        const bucket = needed.includes(f.condition) ? coRequired : prerequisites;
        const flipped = flippedAll.get(compId) ?? {};
        for (const cond of needed) {
          if (flipped[cond] === "met") continue;
          for (const other of open) {
            if (other.id !== item.id && other.fixes.some((x) => x.condition === cond && (x.component === compId || x.component === "*"))) bucket.add(other.id);
          }
        }
      }
    }
    item.dependsOn = item.impact > 0 ? [] : [...prerequisites];
    if (text) item.unlocks = text;
    else if (item.dependsOn.length) item.unlocks = `nothing on its own; first needs ${item.dependsOn.map((d) => byId.get(d)?.title ?? d).join(" and ")}`;
    else if (coRequired.size) {
      const together = [item, ...[...coRequired].map((d) => byId.get(d)!)];
      let joint = maps;
      for (const t of together) joint = flipFor(t, open.filter((o) => !together.includes(o) || o === t), joint);
      const jointText = unlocksText(rubric, goal, levels, goalLevels(rubric, joint, goal));
      item.unlocks = `${jointText || "the next level"} together with ${[...coRequired].map((d) => byId.get(d)?.title ?? d).join(" and ")}`;
    } else item.unlocks = `no level change for ${label} yet`;
  }
  for (const item of roadmap.items.filter((i) => i.kind !== "fix")) {
    if (item.template === "owner") item.unlocks = "a named owner for approvals, targets and the weekly recheck";
    else if (item.template === "targets") item.unlocks = `a definition of Level 3 for ${label}`;
    else if (item.template === "delegate") item.unlocks = `measured agent work in ${item.id.split(":").pop()}`;
  }
  for (const item of newOnes.sort((a, b) => {
    const la = a.kind === "fix" ? 0 : a.template === "owner" ? -1 : 1;
    const lb = b.kind === "fix" ? 0 : b.template === "owner" ? -1 : 1;
    return la - lb || b.impact - a.impact || EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] || a.id.localeCompare(b.id);
  })) {
    item.order = ++order;
  }
  const isDone = (id: string) => byId.get(id)?.status === "done";
  for (const item of open) item.status = item.dependsOn.some((d) => !isDone(d)) ? "waiting" : "later";
  const neededFor = (compId: string) => neededConds(rubric, goal, levels.get(compId) ?? 0);
  const blocking = open.filter((item) => item.status !== "waiting" && item.fixes.some((f) => (f.component === "*" ? [...ctx.active] : [f.component]).some((cid) => ctx.active.has(cid) && neededFor(cid).includes(f.condition))));
  blocking.sort((a, b) => b.impact - a.impact || EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] || a.order - b.order);
  const top = blocking.slice(0, rubric.part1.maxGaps);
  for (const t of top) t.status = "next";
  const activeLevels = [...ctx.active].map((id) => levels.get(id) ?? 0);
  const repoAt2 = activeLevels.length > 0 && Math.min(...activeLevels) === 2;
  if (top.length === 0 && repoAt2 && targets.status !== "done") {
    targets.status = "next";
    top.push(targets);
  } else if (targets.status !== "done") targets.status = "later";
  if (owner.status !== "done") owner.status = top.length > 0 ? "next" : "later";
  let startNow: RoadmapItem | null = null;
  const delegates = roadmap.items.filter((i) => i.template === "delegate" && currentIds.has(i.id));
  for (const d of delegates) {
    const comp = d.id.split(":").pop()!;
    const s = ctx.outcomes?.byComponent[comp];
    d.status = s && s.opened > 0 && d.createdAt <= (ctx.outcomes?.window.to ?? "") && d.createdBy !== audit.id ? "in_progress" : "start_now";
  }
  const sn = delegates.filter((d) => d.status === "start_now").sort((a, b) => (shares.get(b.id.split(":").pop()!) ?? 0) - (shares.get(a.id.split(":").pop()!) ?? 0));
  startNow = sn[0] ?? null;
  fillObserved(roadmap, ctx);
  roadmap.items.sort((a, b) => a.order - b.order);
  return { roadmap, top, startNow, levels };
}

function fillObserved(roadmap: Roadmap, ctx: RoadmapContext): void {
  const o = ctx.outcomes;
  if (!o) return;
  for (const item of roadmap.items.filter((i) => i.status === "done" && i.closedAt)) {
    if (!(o.window.from >= (item.closedAt as string))) continue;
    const [metric, pattern] = item.expected.watch.metric.split(":");
    const now = watchFor(metric, item.expected.watch.scope, o, ctx.rubric, pattern);
    const shared = roadmap.items
      .filter((x) => x.id !== item.id && x.status === "done" && x.closedBy === item.closedBy && (x.expected.watch.scope === item.expected.watch.scope || x.expected.watch.scope === "repo" || item.expected.watch.scope === "repo"))
      .map((x) => x.id);
    item.observed = { value: `${item.expected.watch.baseline} to ${now.baseline}`, sharedWith: shared };
  }
}

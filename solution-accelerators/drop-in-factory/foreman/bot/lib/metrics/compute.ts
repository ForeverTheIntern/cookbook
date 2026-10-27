/**
 * KPIs and DORA from run documents and the cached DORA facts. Each metric is
 * a value or null with the reason it is not emitted; a missing value is
 * never shown as 0. The tick exports these through OTel when a collector is
 * configured, once per repository and once for all of them. The portal app
 * computes its own panels from its Postgres read model.
 */

import type { FactoryConfig } from "../config/factory.ts";
import type { RunDoc } from "../store/runs.ts";
import type { Deploy, Incident } from "./facts.ts";

/** What the metrics read: the run documents in the window, and the facts. */
export interface MetricInput {
  docs: RunDoc[];
  deploys: Deploy[];
  incidents: Incident[];
}

export interface Metric {
  /** OTel name suffix: factory.<group>.<name>. */
  name: string;
  group: "kpi" | "dora";
  label: string;
  unit: string;
  value: number | null;
  reason: string;
}

/** The KPI window. DORA uses dora.weeks. */
export const KPI_DAYS = 14;

export const METRICS: Pick<Metric, "name" | "group" | "label" | "unit">[] = [
  { group: "kpi", name: "tasks_merged", label: "Tasks merged", unit: "runs" },
  { group: "kpi", name: "tasks_closed", label: "Tasks closed unmerged", unit: "runs" },
  { group: "kpi", name: "merged_rate", label: "Merged rate", unit: "%" },
  { group: "kpi", name: "intake_to_merge_hours", label: "Median intake to merge", unit: "h" },
  { group: "kpi", name: "gate_wait_minutes", label: "Median gate wait", unit: "min" },
  { group: "kpi", name: "human_touches_per_task", label: "Human touches per task", unit: "" },
  { group: "kpi", name: "send_backs_per_task", label: "Send-backs per task", unit: "" },
  { group: "kpi", name: "agent_runs_per_task", label: "Cloud agent runs per task", unit: "" },
  { group: "kpi", name: "agent_minutes_per_task", label: "Cloud agent minutes per task", unit: "min" },
  { group: "kpi", name: "cost_cents_per_task", label: "Invoice cost per task", unit: "¢" },
  { group: "dora", name: "deploys_per_week", label: "Deployment frequency", unit: "/wk" },
  { group: "dora", name: "lead_time_hours", label: "Lead time for changes", unit: "h" },
  { group: "dora", name: "change_failure_rate", label: "Change failure rate", unit: "%" },
  { group: "dora", name: "recovery_hours", label: "Time to restore", unit: "h" },
];

/**
 * Metrics over the runs, deploys and incidents of `scope`: one repository, or
 * every repository for the factory-wide figures. dora settings are shared.
 */
export function computeMetrics(input: MetricInput, scope: FactoryConfig[], now: string, costEnabled: boolean): Metric[] {
  const config = scope[0];
  const repos = new Set(scope.map((c) => c.repo));
  const inScope = (repo: string) => repos.has(repo);
  const nowMs = Date.parse(now);
  const kpiFrom = nowMs - KPI_DAYS * 86_400_000;
  const doraFrom = nowMs - config.dora.weeks * 7 * 86_400_000;
  const values = new Map<string, [number | null, string]>();
  const set = (name: string, value: number | null, reason = "") => values.set(name, [value === null ? null : round(value), reason]);

  const docs = input.docs.filter((d) => inScope(d.run.repo) && Date.parse(d.run.createdAt) >= kpiFrom);
  const runs = docs.map((d) => d.run);
  const steps = docs.flatMap((d) => d.transitions);
  const roles = docs.flatMap((d) => d.roles);
  const merged = runs.filter((r) => r.stage === "done");
  const closed = runs.filter((r) => r.stage === "closed" || r.stage === "abandoned");
  const none = `no runs opened in the last ${KPI_DAYS} days`;

  set("tasks_merged", merged.length);
  set("tasks_closed", closed.length);
  set("merged_rate", merged.length + closed.length === 0 ? null : (100 * merged.length) / (merged.length + closed.length), "no run has finished yet");
  set("intake_to_merge_hours", median(merged.map((r) => hours(r.createdAt, r.closedAt!))), "no run has merged yet");

  const gateWaits: number[] = [];
  for (const d of docs) {
    d.transitions.forEach((t, i) => {
      const next = d.transitions[i + 1];
      if (/^awaiting_.+_approval$/.test(t.stage) && next !== undefined) gateWaits.push(hours(t.at, next.at) * 60);
    });
  }
  set("gate_wait_minutes", median(gateWaits), "no gate has been decided yet");

  const per = (n: number) => (runs.length === 0 ? null : n / runs.length);
  set("human_touches_per_task", per(steps.filter((t) => t.actor !== null).length), none);
  set("send_backs_per_task", per(runs.reduce((sum, r) => sum + r.sendBacks, 0)), none);
  set("agent_runs_per_task", per(roles.length), none);
  const finished = roles.filter((r) => r.finishedAt !== null);
  set("agent_minutes_per_task", per(finished.reduce((sum, r) => sum + hours(r.startedAt, r.finishedAt!) * 60, 0)), none);
  if (!costEnabled) set("cost_cents_per_task", null, "needs CURSOR_ADMIN_API_KEY (Team Admin API) for invoice cents");
  else if (finished.length === 0) set("cost_cents_per_task", null, "no agent has finished yet");
  else if (finished.some((r) => r.costState !== "final")) {
    set("cost_cents_per_task", null, `invoice cents still settling for ${finished.filter((r) => r.costState !== "final").length} agents (final within 2 h of each finish)`);
  }
  else set("cost_cents_per_task", per(finished.reduce((sum, r) => sum + r.costCents!, 0)));

  const deploys = input.deploys.filter((d) => inScope(d.repo) && Date.parse(d.at) >= doraFrom);
  const base = scope.length === 1 ? config.base : "each repository's base";
  const source = config.dora.deploySource === "merges" ? `merges to ${base}` : `GitHub Deployments to ${config.dora.environment}`;
  set("deploys_per_week", deploys.length / config.dora.weeks);
  set("lead_time_hours", median(deploys.filter((d) => d.firstCommitAt !== null).map((d) => hours(d.firstCommitAt!, d.at))), `no ${source} with a known first commit`);
  set("change_failure_rate", deploys.length === 0 ? null : (100 * deploys.filter((d) => d.failed).length) / deploys.length, `no ${source} in the last ${config.dora.weeks} weeks`);
  const incidents = input.incidents.filter((i) => i.closedAt !== null && inScope(i.repo));
  set("recovery_hours", median(incidents.map((i) => hours(i.openedAt, i.closedAt!))), `no closed issue labeled ${config.dora.incidentLabel}`);

  return METRICS.map((m) => {
    const [value, reason] = values.get(m.name)!;
    return { ...m, value, reason: value === null ? reason : "" };
  });
}

function hours(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 3_600_000;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

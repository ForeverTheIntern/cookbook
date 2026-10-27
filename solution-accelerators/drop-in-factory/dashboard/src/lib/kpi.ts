/**
 * Dashboard figures, computed from the run documents Foreman pushed. A figure
 * with no runs to count says so instead of showing zero. Change failure rate
 * and time to restore need deployment and incident facts, which only
 * Foreman's OTel export carries.
 */

import type { WireDoc, WireRole } from "./wire.ts";

export interface Tile {
  label: string;
  value: string | null;
  note?: string;
}

const HOUR = 3_600_000;
const GATES = new Set(["awaiting_clarification", "awaiting_spec_approval", "awaiting_plan_approval", "awaiting_merge"]);

export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const fixed = (n: number | null, digits = 1) => (n === null ? null : n.toFixed(digits));
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Time spent waiting on a person: every stretch in a gate stage. */
function gateMs(doc: WireDoc, now: number): number {
  const t = doc.transitions;
  return t.reduce((sum, x, i) => (GATES.has(x.stage) ? sum + (Date.parse(t[i + 1]?.at ?? doc.run.closedAt ?? new Date(now).toISOString()) - Date.parse(x.at)) : sum), 0);
}

export function computeMinutes(roles: WireRole[]): number {
  return roles.filter((a) => a.finishedAt !== null).reduce((s, a) => s + (Date.parse(a.finishedAt!) - Date.parse(a.startedAt)) / 60_000, 0);
}

export function runCost(roles: WireRole[]): { cents: number | null; state: "final" | "settling"; read: number; agents: number } {
  const read = roles.filter((a) => a.costCents !== null);
  const cents = read.length === 0 ? null : read.reduce((s, a) => s + (a.costCents ?? 0), 0);
  const final = roles.length > 0 && roles.every((a) => a.costState === "final");
  return { cents, state: final ? "final" : "settling", read: read.length, agents: roles.length };
}

export function kpis(docs: WireDoc[], now: number, days: number): Tile[] {
  const since = now - days * 24 * HOUR;
  const finished = docs.filter((d) => d.run.closedAt !== null && Date.parse(d.run.closedAt) >= since);
  const done = finished.filter((d) => d.run.stage === "done");
  const open = docs.filter((d) => d.run.closedAt === null);
  const none = "no finished runs in the window";
  const leads = done.map((d) => Date.parse(d.run.closedAt!) - Date.parse(d.run.createdAt));
  const lead = median(leads);
  const gate = median(done.map((d) => gateMs(d, now)));
  const costs = done.map((d) => runCost(d.roles)).filter((c) => c.state === "final" && c.cents !== null);
  return [
    { label: "Tasks merged", value: String(done.length) },
    { label: "Merge rate", value: finished.length === 0 ? null : `${Math.round((100 * done.length) / finished.length)}%`, note: finished.length === 0 ? none : `${done.length} of ${finished.length} finished` },
    { label: "Open runs", value: String(open.length), note: `${open.filter((d) => d.run.hold !== null).length} held` },
    { label: "Median issue to merge", value: lead === null ? null : duration(lead), note: lead === null ? none : undefined },
    { label: "Median human wait", value: gate === null ? null : duration(gate), note: gate === null ? none : "time in gate stages" },
    { label: "Human decisions per task", value: fixed(mean(done.map((d) => d.transitions.filter((t) => t.actor !== null).length))), note: done.length === 0 ? none : undefined },
    { label: "Send-backs per task", value: fixed(mean(done.map((d) => d.run.sendBacks ?? 0))), note: done.length === 0 ? none : undefined },
    { label: "Agent runs per task", value: fixed(mean(done.map((d) => d.roles.length))), note: done.length === 0 ? none : undefined },
    { label: "Agent minutes per task", value: fixed(mean(done.map((d) => computeMinutes(d.roles))), 0), note: done.length === 0 ? none : undefined },
    {
      label: "Invoice per task",
      value: costs.length === 0 ? null : dollars(mean(costs.map((c) => c.cents!))!),
      note: costs.length === 0 ? "no merged task has a final invoice yet (needs CURSOR_ADMIN_API_KEY on Foreman)" : `${costs.length} of ${done.length} tasks final`,
    },
  ];
}

export function dora(docs: WireDoc[], now: number, weeks: number): Tile[] {
  const since = now - weeks * 7 * 24 * HOUR;
  const merged = docs.filter((d) => d.run.stage === "done" && d.run.closedAt !== null && Date.parse(d.run.closedAt) >= since);
  const lead = median(merged.map((d) => Date.parse(d.run.closedAt!) - Date.parse(d.run.createdAt)));
  const otel = "needs deployment and incident facts: read it from Foreman's OTel export";
  return [
    { label: "Factory merges per week", value: (merged.length / weeks).toFixed(1), note: `${merged.length} in ${weeks} weeks` },
    { label: "Lead time (issue to merge)", value: lead === null ? null : duration(lead), note: lead === null ? "no merges in the window" : "median" },
    { label: "Change failure rate", value: null, note: otel },
    { label: "Time to restore", value: null, note: otel },
  ];
}

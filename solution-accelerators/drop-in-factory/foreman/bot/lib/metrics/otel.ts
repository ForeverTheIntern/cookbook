/**
 * Push the factory's metrics to an OTel collector over OTLP/HTTP JSON, when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set. The tick calls this once a minute.
 * Every value is computed from the store, so a push is a full snapshot and a
 * lost push costs nothing. factory.stage.entered counts the runs in the
 * KPI window.
 *
 * Names: factory.kpi.<name> and factory.dora.<name> gauges,
 * factory.metric.not_emitted (value 1, attributes metric and reason),
 * factory.stage.entered (cumulative count per stage),
 * factory.runs.open (open runs per stage).
 * Every point carries `repo`: a repository key, or `all` for the whole factory.
 */

import type { Ctx } from "../pipeline/reconcile.ts";
import { allStages } from "../pipeline/route.ts";
import { ENDED, isOpen } from "../store/runs.ts";
import { computeMetrics, KPI_DAYS, type MetricInput } from "./compute.ts";
import { readFacts } from "./facts.ts";

const started = Date.now();

type Attr = { key: string; value: { stringValue: string } };
const attr = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });

/** Everything a payload reads, from the store: runs in the KPI window (and every open run) plus the facts. */
export async function metricInput(ctxs: Ctx[]): Promise<MetricInput> {
  const ctx = ctxs[0];
  const doraDays = ctx.config.dora.weeks * 7;
  const since = new Date(Date.parse(ctx.now()) - Math.max(KPI_DAYS, doraDays) * 86_400_000).toISOString();
  return { docs: await ctx.store.recentDocs(since), ...(await readFacts(ctx.store, ctxs.map((c) => c.config.key))) };
}

export function otlpPayload(ctxs: Ctx | Ctx[], input: MetricInput): unknown {
  const list = Array.isArray(ctxs) ? ctxs : [ctxs];
  const ctx = list[0];
  const configs = list.map((c) => c.config);
  const scopes: { key: string; configs: typeof configs }[] = [
    ...(configs.length > 1 ? configs.map((c) => ({ key: c.key, configs: [c] })) : []),
    { key: configs.length > 1 ? "all" : configs[0].key, configs },
  ];
  const now = `${Date.parse(ctx.now())}000000`;
  const start = `${started}000000`;
  const gauge = (name: string, points: { value: number; attrs: Attr[] }[]) => ({
    name,
    gauge: { dataPoints: points.map((p) => ({ asDouble: p.value, timeUnixNano: now, attributes: p.attrs })) },
  });

  const points = new Map<string, { value: number; attrs: Attr[] }[]>();
  const add = (name: string, value: number, attrs: Attr[]) => points.set(name, [...(points.get(name) ?? []), { value, attrs }]);
  const runRepo = new Map(input.docs.map((d) => [d.run.id, d.run.repo]));
  const transitions = input.docs.flatMap((d) => d.transitions);
  const open = input.docs.map((d) => d.run).filter(isOpen);
  const entered: { asInt: string; startTimeUnixNano: string; timeUnixNano: string; attributes: Attr[] }[] = [];

  for (const scope of scopes) {
    const repo = attr("repo", scope.key);
    const repos = new Set(scope.configs.map((c) => c.repo));
    const computed = computeMetrics(input, scope.configs, ctx.now(), ctx.facts?.usage != null);
    for (const m of computed) {
      if (m.value !== null) add(`factory.${m.group}.${m.name}`, m.value, [repo]);
      else add("factory.metric.not_emitted", 1, [repo, attr("metric", `factory.${m.group}.${m.name}`), attr("reason", m.reason)]);
    }
    const counts = new Map<string, number>();
    for (const t of transitions) if (repos.has(runRepo.get(t.runId) ?? "")) counts.set(t.stage, (counts.get(t.stage) ?? 0) + 1);
    for (const [stage, n] of counts) entered.push({ asInt: String(n), startTimeUnixNano: start, timeUnixNano: now, attributes: [repo, attr("stage", stage)] });
    for (const stage of [...new Set(scope.configs.flatMap(allStages))].filter((s) => !ENDED.has(s))) {
      add("factory.runs.open", open.filter((r) => r.stage === stage && repos.has(r.repo)).length, [repo, attr("stage", stage)]);
    }
  }

  const metrics: unknown[] = [...points].map(([name, p]) => gauge(name, p));
  if (entered.length > 0) metrics.push({ name: "factory.stage.entered", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: entered } });
  return {
    resourceMetrics: [{
      resource: { attributes: [attr("service.name", "drop-in-factory")] },
      scopeMetrics: [{ scope: { name: "drop-in-factory" }, metrics }],
    }],
  };
}

export async function exportMetrics(ctxs: Ctx[], endpoint: string): Promise<void> {
  const payload = otlpPayload(ctxs, await metricInput(ctxs));
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`collector returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

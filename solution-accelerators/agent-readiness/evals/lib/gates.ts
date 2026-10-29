import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { historyLines, latestReport, readiness, roadmap, sealedAudits } from "./grade.ts";
import type { Gate } from "./types.ts";

export function levelRose(activity: string, atLeast: number): Gate {
  return (ws) => {
    const audits = historyLines(ws).filter((h) => h.kind === "audit");
    const first = audits[0]?.repoLevels[activity];
    const last = audits[audits.length - 1]?.repoLevels[activity];
    const pass = audits.length >= 2 && last !== undefined && first !== undefined && last > first && last >= atLeast;
    return { name: `level for ${activity} rose to at least ${atLeast}`, pass, detail: `${audits.length} audits: ${first} -> ${last}` };
  };
}

export const noWeakening: Gate = (ws) => {
  const audits = historyLines(ws).filter((h) => h.kind === "audit");
  if (audits.length < 2) return { name: "no weakened tests", pass: false, detail: "needs two audits" };
  const d = readiness(ws, ["diff", audits[0].id, audits[audits.length - 1].id, "--json"]);
  const w = JSON.parse(d.out.slice(d.out.indexOf("{"))).weakening as { deletedTestFiles: string[]; removedTestCases: number; newSkipMarkers: unknown[] };
  const pass = w.deletedTestFiles.length === 0 && w.removedTestCases === 0 && w.newSkipMarkers.length === 0;
  return { name: "no weakened tests", pass, detail: pass ? "no deleted tests, removed cases or skip markers" : JSON.stringify(w) };
};

export const freshFaultsCaught: (component: string) => Gate = (component) => (ws) => {
  const audits = sealedAudits(ws);
  if (audits.length < 2) return { name: `fresh planted faults caught in ${component}`, pass: false, detail: "needs two audits" };
  const first = audits[0];
  const last = audits[audits.length - 1];
  const ev = [...last.evidence].reverse().find((e: { condition?: string; component?: string }) => e.condition === "faults" && e.component === component);
  const freshSeed = first.seed.value !== last.seed.value;
  return { name: `fresh planted faults caught in ${component}`, pass: Boolean(ev && ev.result === "pass" && freshSeed), detail: `${ev?.summary ?? "no fault evidence"}; seed ${freshSeed ? "fresh" : "reused"}` };
};

export function itemClosed(id: string): Gate {
  return (ws) => {
    const item = roadmap(ws)?.items.find((i) => i.id === id);
    return { name: `${id} closed`, pass: item?.status === "done", detail: item ? item.status : "missing" };
  };
}

export function auditCount(n: number): Gate {
  return (ws) => {
    const lines = historyLines(ws).filter((h) => h.kind === "audit");
    return { name: `${n} audits in history`, pass: lines.length === n, detail: `${lines.length} audit lines` };
  };
}

export function evidenceSays(text: string): Gate {
  return (ws) => {
    const r = latestReport(ws);
    const hit = r?.details.evidence.some((e) => e.summary.includes(text));
    return { name: `evidence says "${text}"`, pass: Boolean(hit), detail: hit ? "found" : "not found" };
  };
}

export function registryNamesOnly(name: string, value: string): Gate {
  return (ws) => {
    const audits = sealedAudits(ws);
    const last = audits[audits.length - 1];
    const text = last ? JSON.stringify(last) : "";
    const md = existsSync(join(ws.dir, ".agent-readiness/latest/report.md")) ? readFileSync(join(ws.dir, ".agent-readiness/latest/report.md"), "utf8") : "";
    const pass = Boolean(last) && last.environment.registryEnv.includes(name) && !text.includes(value) && !md.includes(value);
    return { name: "registry names recorded, values never", pass, detail: last ? `registryEnv ${JSON.stringify(last.environment.registryEnv)}` : "no audit" };
  };
}

export const notProvable: Gate = (ws) => {
  const r = latestReport(ws);
  const pass = Boolean(r && r.maturity.level === 0 && r.maturity.couldBe === 1 && r.details.record.some((x) => x.value.includes("no container runtime")));
  return { name: "Level 1 reported as not provable here", pass, detail: r ? `Level ${r.maturity.level}, could be ${r.maturity.couldBe}` : "no report" };
};

export const envJsonAllowed: Gate = (ws) => {
  const f = join(ws.dir, ".cursor/environment.json");
  if (!existsSync(f)) return { name: "environment.json uses allowed fields", pass: false, detail: "no .cursor/environment.json" };
  const keys = Object.keys(JSON.parse(readFileSync(f, "utf8")));
  const pass = keys.every((k) => ["name", "install", "start", "build"].includes(k));
  return { name: "environment.json uses allowed fields", pass, detail: keys.join(", ") };
};

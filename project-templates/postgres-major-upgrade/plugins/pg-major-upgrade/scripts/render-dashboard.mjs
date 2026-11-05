#!/usr/bin/env node
// Render the tracker into the dashboard canvas.
//
//   node render-dashboard.mjs --tracker tracker.csv --out <path>.canvas.tsx [--project project.json] [--today YYYY-MM-DD]
//
// project.json holds { name, source, target, window, targetDate }. The canvas template is
// ../assets/dashboard.canvas.tsx; only the block between @data-start and @data-end changes.

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, summarize, validate } from "./tracker-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "assets", "dashboard.canvas.tsx");

function formatWindow(w) {
  if (!w || typeof w === "string") return w ?? "unknown";
  const mode = w.mode && w.mode !== "unknown" ? ` ${w.mode}` : "";
  return `${w.minutes} min${mode}${w.when ? `, ${w.when}` : ""}`;
}

export function renderDashboard({ trackerText, project, today, generatedFrom }) {
  const parsed = parseCsv(trackerText);
  const summary = summarize(parsed, { today });
  const data = {
    project: {
      name: project?.name ?? "Postgres upgrade",
      source: project?.source ?? "unknown",
      target: project?.target ?? "unknown",
      window: formatWindow(project?.window),
      targetDate: project?.targetDate ?? "unknown",
    },
    generatedFrom,
    ...summary,
    issues: validate(parsed),
  };
  const template = readFileSync(templatePath, "utf8");
  const start = template.indexOf("/* @data-start */");
  const end = template.indexOf("/* @data-end */");
  if (start === -1 || end === -1) throw new Error("dashboard template is missing its data markers");
  const block = `/* @data-start */\nconst DATA: DashboardData = ${JSON.stringify(data, null, 2)};\n`;
  return { canvas: template.slice(0, start) + block + template.slice(end), data };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const tracker = arg("tracker", "tracker.csv");
  const out = arg("out");
  if (!out || !out.endsWith(".canvas.tsx")) {
    console.error("usage: render-dashboard.mjs --tracker tracker.csv --out <path>.canvas.tsx [--project project.json] [--today YYYY-MM-DD]");
    process.exit(2);
  }
  const projectFile = arg("project", existsSync("project.json") ? "project.json" : undefined);
  const project = projectFile ? JSON.parse(readFileSync(projectFile, "utf8")) : undefined;
  const { canvas, data } = renderDashboard({
    trackerText: readFileSync(tracker, "utf8"),
    project,
    today: arg("today", new Date().toISOString().slice(0, 10)),
    generatedFrom: path.basename(tracker),
  });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, canvas);
  const errors = data.issues.filter((i) => i.severity === "error").length;
  console.log(`wrote ${out} (block ${data.current}, ${data.gatesClosed}/${data.gatesTotal} gates closed, ${errors} tracker errors)`);
}

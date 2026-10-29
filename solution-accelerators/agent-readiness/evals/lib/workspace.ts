import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { skillDigest } from "../../skill/agent-readiness/scripts/lib/workspace.ts";
import { SKILL, commitAll, materialize, materializePrs } from "../../tools/fixture.ts";
import type { EvalCase, Workspace } from "./types.ts";

export const EVAL_SEED = "eval-seed";

export function installedSkillDigest(dir: string): string {
  const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", `import("${join(dir, ".cursor/skills/agent-readiness/scripts/lib/workspace.ts")}").then(m => process.stdout.write(m.skillDigest()))`], { encoding: "utf8" });
  return out.trim();
}

export function prepare(c: EvalCase): Workspace {
  const now = new Date().toISOString();
  const root = mkdtempSync(join(tmpdir(), `eval-${c.id.replace(/[^\w-]/g, "_")}-`));
  const dir = materialize(c.fixture, { now, into: root });
  cpSync(SKILL, join(dir, ".cursor/skills/agent-readiness"), { recursive: true });
  commitAll(dir, "Add the agent readiness skill", 0, now);
  const ws: Workspace = { dir, fixture: c.fixture, now, skillDigestBefore: skillDigest(), headBefore: "" };
  if (c.setup) {
    c.setup(ws);
    commitAll(dir, "Case setup", 0, now);
  }
  ws.headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  if (c.prs) copyFileSync(materializePrs(c.fixture, now, c.prs), join(root, "prs.json"));
  writeFileSync(join(root, "case.json"), JSON.stringify({ id: c.id, fixture: c.fixture, dir, now, headBefore: ws.headBefore, skillDigestBefore: ws.skillDigestBefore, prompts: c.turns.map((t) => fillPrompt(t.prompt, ws)), env: caseEnv(c) }, null, 2));
  return ws;
}

export function fillPrompt(prompt: string, ws: Workspace): string {
  return prompt.replaceAll("{root}", dirname(ws.dir)).replaceAll("{dir}", ws.dir);
}

export function loadWorkspace(root: string): { ws: Workspace; id: string; prompts: string[]; env: Record<string, string> } {
  const meta = JSON.parse(readFileSync(join(root, "case.json"), "utf8")) as { id: string; fixture: string; dir: string; now: string; headBefore: string; skillDigestBefore: string; prompts: string[]; env: Record<string, string> };
  return { ws: { dir: meta.dir, fixture: meta.fixture, now: meta.now, headBefore: meta.headBefore, skillDigestBefore: meta.skillDigestBefore }, id: meta.id, prompts: meta.prompts, env: meta.env };
}

export function caseEnv(c: EvalCase): Record<string, string> {
  const env: Record<string, string> = { READINESS_EVAL_SEED: EVAL_SEED, ...(c.env ?? {}) };
  if (process.env.READINESS_IMAGE && !env.READINESS_IMAGE) env.READINESS_IMAGE = process.env.READINESS_IMAGE;
  return env;
}

export function skillPreamble(dir: string): string {
  return [
    `You are working in the git repository at ${dir}. Run every command from that directory.`,
    "Agent skills available in this repository:",
    "- agent-readiness (.cursor/skills/agent-readiness/SKILL.md): Audit whether coding agents can work in this repository, from evidence the audit's scripts execute. Use when asked for an agent readiness audit or report, what blocks agents here, or to re-audit after fixes.",
    "",
  ].join("\n");
}

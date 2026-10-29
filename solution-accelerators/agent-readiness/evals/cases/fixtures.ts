import { expected, fixtureNames } from "../../tools/fixture.ts";
import type { EvalCase } from "../lib/types.ts";

const GOAL_WORDS: Record<string, string> = { first_pr: "a first PR", bug_fixes: "bug fixes", features: "features and refactors", repo_wide: "repo-wide changes" };
const SMOKE = new Set(["healthy-node", "hidden-service", "tautological-tests", "agents-md-drift"]);

export const cases: EvalCase[] = fixtureNames().flatMap((fixture) => {
  const exp = expected(fixture);
  return exp.runs.filter((run) => !run.registryEnv).map((run) => {
    let prompt = `Run an agent readiness audit for ${GOAL_WORDS[exp.goal]}, permission tier local-exec.`;
    if (exp.outcomes) prompt += " For outcomes, use the recorded PR list at {root}/prs.json.";
    if (run.registryEnv) prompt += ` Our private registry token is in the ${Object.keys(run.registryEnv).join(", ")} environment variable.`;
    return {
      id: run.name === "default" ? fixture : `${fixture}/${run.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      fixture,
      tags: SMOKE.has(fixture) && run.name === "default" ? ["smoke", "full"] : ["full"],
      expectedRun: run.name,
      turns: [{ prompt }],
      env: run.registryEnv,
      prs: exp.outcomes,
      description: exp.purpose,
    } as EvalCase;
  });
});

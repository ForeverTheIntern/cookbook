import { expected, fixtureNames } from "../../tools/fixture.ts";
import { scenarioLevelsGate } from "../lib/coverage.ts";
import { DEFAULT_GATES } from "../lib/grade.ts";
import type { EvalCase } from "../lib/types.ts";

const SMOKE = new Set(["healthy-node", "hidden-service", "tautological-tests", "agents-md-drift"]);

export const cases: EvalCase[] = fixtureNames().flatMap((fixture) => {
  const exp = expected(fixture);
  return exp.runs.filter((run) => !run.registryEnv).map((run) => {
    let prompt = "Run an agent readiness audit, permission tier local-exec.";
    if (run.scenarios) prompt += ` Add the ${run.scenarios.join(" and ")} ${run.scenarios.length > 1 ? "scenarios" : "scenario"} for every component.`;
    if (exp.outcomes) prompt += " For outcomes, use the recorded PR list at {root}/prs.json.";
    if (run.registryEnv) prompt += ` Our private registry token is in the ${Object.keys(run.registryEnv).join(", ")} environment variable.`;
    return {
      id: run.name === "default" ? fixture : `${fixture}/${run.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      fixture,
      tags: SMOKE.has(fixture) && run.name === "default" ? ["smoke", "full"] : ["full"],
      expectedRun: run.name,
      turns: [{ prompt }],
      env: run.runtime ? { ...run.registryEnv, SA_READINESS_RUNTIME: run.runtime } : run.registryEnv,
      prs: exp.outcomes,
      // Scenario levels are graded wherever expected.json gives them.
      ...(run.scenarioLevels ? { gates: [...DEFAULT_GATES, scenarioLevelsGate] } : {}),
      description: exp.purpose,
    } as EvalCase;
  });
});

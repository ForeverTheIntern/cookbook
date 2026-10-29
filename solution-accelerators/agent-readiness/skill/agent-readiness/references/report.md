# The report

`readiness seal` writes `report.json` (schema `agent-readiness/report@1`), the view model, and `report.md`, a view of it. Every number comes from computed fields. Any other renderer, such as a dashboard or a canvas, reads `report.json` and hardcodes nothing, not even component names.

## The three tiers in `report.json`

1. `maturity`: the repo rollup, with `level`, the `rule` that produced it, `setBy`, `outcome` (`proven`, `blocked` or `not_assessed`), `confidence` and `capReasons`.
2. `components.included[]`: each assessed component's standard `level` (null when the audit has no real results), its `capReasons`, and `scenarios[]` nested under it. `components.excluded[]` lists every component left out, with the reason.
3. `components.included[].scenarios[]`: present only for scenarios someone added. `scenarios` at the top says which were added and for which components.

## The four parts

1. **Where you stand.** One screen, written like an executive slide:
   - The heading: the repo level with its plain meaning, for example "Level 0 of 4, not bootable". It names no activity.
   - The headline: one message.
   - Three numbers, each with a comparison: active components at Level 2 or above; agent PRs that pass CI the first time against other PRs in the same window; and the share of recent changes in components below the next level.
   - The scale with "you are here", and one line on what the next level still needs.
   - At most three gaps, one plain line each.
   - One ask: the single decision that unblocks the top gap, plus naming an owner when none is recorded.
   - A coverage note: what the level ignores and the agent-PR filter in use.
2. **Next actions and how they move the needle.** An effort-against-impact view, then each action: why it matters, the level it unlocks and the share of recent changes that covers, the metric to watch with its baseline, any verified research, effort and owner role, the decision needed, and a re-runnable "done when". A "can start now" action follows when some component is already ready.
3. **Where you are on the roadmap.** Every step with its status (done, in progress, next, can start now, waiting on step N, later). From the second audit on: levels over time, what each closed step was expected to deliver against what it did, and the weakened-test check.
4. **Details.** Exact steps for each action; every check with why it matters, its result with exact counts, and its evidence IDs; what isn't assessed; levels by component, with any scenarios nested under each, and the repo level with its rule; agent PR outcomes; agent assets; the evidence log; the audit record.

## Part 1 rules (enforced by `seal`)

- The headline is at most 40 words. It names the component that sets the level and what already works elsewhere. It never pairs a level change with an outcome change in the same sentence.
- At most three gaps, each at most 22 words, each about what holds a component's standard level.
- No code formatting, check IDs or evidence IDs.
- No banned jargon: "first-push", "oracle", "replay", "bootstrap", "canonical", "mutant", "mutation", "seal", "trajectory", "CI parity".
- A level name ("Bootable", "Verifiable") appears only with its number, as in "Level 1, bootable".
- Narrated text may contain only numbers the audit computed.

## Writing a narration

Narration is optional. The default wording passes the rules. When you narrate, aim for something a director reads in ten seconds:

- Good: "Agents can't pass the tests in api from a clean checkout, and 56% of recent changes land there. shared is already at Level 2."
- Bad: "Bootstrap replay failed for api; oracle coverage is 0/5 in worker." That uses jargon, names checks and gives the reader no message.

The headline says what holds the repo level and where. It doesn't list everything that's wrong; part 4 does that.

## Outcome honesty

- Every rate shows its n and its window. Below 5, the report shows counts only.
- Agent PRs always sit next to other PRs from the same window. A later report adds the previous window; it doesn't replace the comparison.
- A closed step's observed value comes from its own watch metric and scope, in the window after it closed. When several steps closed together, the value is shared and says so. A repo-wide number is never credited to one step.
- The trend caveat sits next to the numbers: a trend, not attribution. Model updates or a different mix of tasks could account for part of a change.
- A PR that touches several components counts in each, and the component table says its rows can add up to more than the total.

## The header

- "Seal verified against release vX": the scripts that ran the audit match a tagged release. "Seal not verified" means they don't, or no release manifest shipped with the copy.
- "Eval run with a pinned seed": the planted-fault seed came from `SA_READINESS_EVAL_SEED`. `readiness verify-seal` won't treat it as a production result.

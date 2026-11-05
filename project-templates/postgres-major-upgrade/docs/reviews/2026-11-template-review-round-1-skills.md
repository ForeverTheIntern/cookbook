# Template review, round 1: skills

Run 2026-11-04, after the SOP fixes and before the eval baseline. Reviewers got the `skills` rubric and the files below, and saw nothing else. Raw output is in [raw/round-1-skills/](raw/round-1-skills/).

**Files reviewed:** every `SKILL.md`, the three rules, the commands, the agents, the hooks, `tracker-schema.md`, `tracker-lib.mjs`, the bootstrap prompt and the automation recipes.

| Reviewer | Verdict | Findings |
|---|---|---|
| Astra (`gpt-6-astra`, Codex CLI) | rework | 7 |
| Claude Opus 5.5 | ship-with-fixes | 25 |
| Grok 4.7 | rework | 19 |
| Gemini 4 Argon | Both runs failed: the output JSON had an invalid `\.` escape. The parser now repairs those, and Gemini's skills review is in [round 2](2026-11-template-review-round-2.md). | None |

## Fixed

| # | Sev | By | Finding | Fix |
|---|---|---|---|---|
| 1 | blocker | A O K | Pastes were saved to `upgrade/results/` before being screened for row data or secrets | Screen first, in the precheck, catch-up and runbook skills and the `workspace-layout` rule. Nothing is saved until the screen passes. |
| 2 | major | A O K | The skills disagreed about who can set a gate to Done. The precheck skill could close G0.2 itself. | One path: gate review gives a verdict, and the tracker skill's "Record an approval" sets Done only with the named approver and an approval link. Precheck sets G0.2 to Needs approval. The checker now rejects a Done gate without an Approver. |
| 3 | major | O K | Catch-up could mark a Decision Done because the handoff named a decider | Decisions go in as Needs approval. Done needs a linked signed record. |
| 4 | major | O | A waiver passed on a named approver alone | A waiver needs an Evidence link to the approval. Both the checker and gate review enforce it. |
| 5 | major | O | Hook bypasses: Unix sockets, `$DATABASE_URL`, `service=`, inherited PGHOST, MCP servers, rds-data, Pulumi and CDK, pushes to a default branch | The shell hook needs an explicit local host for a Postgres client. It denies variables, service names, provider sockets and remote URIs in any command, and covers more provider and IaC commands. A new `beforeMCPExecution` hook denies database tools. There are 51 hook tests. The rules call the hooks a backstop. |
| 6 | major | A O | Stale approvals were never flagged, because `Last checked` resets daily | New `Status since` column, and staleness is computed from it |
| 7 | major | A O | The external backend fallback could overwrite parked updates | Pending updates go to `upgrade/tracker-pending.csv` and sync before any read. Conflicts are reported, not overwritten. |
| 8 | major | A O K | Script paths mixed bases relative to the skill and to the workspace | The `workspace-layout` rule defines `<plugin>` as an absolute root. Scripts run from the workspace root, and a missing file means stop and report. |
| 9 | major | O K | Skills referenced docs outside the plugin | `automations.md` and `catch-up-handoff-template.md` moved into `reference/`. The findings schema was already in `agents/`, but it wasn't in the review set. |
| 10 | major | O | Readiness scans were undefined | New `reference/readiness-scan.md`, defining the checks, the columns filled, and no PRs |
| 11 | major | O | `project.json` had no schema, so the window math was ambiguous | New `reference/project.schema.json`, with `window` as `{minutes, mode, when}`. The renderer and fixtures are updated. |
| 12 | major | O | The rollback decision time had no margin | Window end minus 1.25 times the rehearsed end-to-end rollback, approved by the go or no-go owner. In both the SOP and the runbook skill. |
| 13 | major | O K | Provider checks assumed Cloud SQL | The skill now marks provider checks unsupported for other providers, and adds a question instead of improvising |
| 14 | major | O K | A "multi-model" review could pass with one reviewer, or none | At least two successful reviewers from different families, otherwise the review is marked `incomplete` |
| 15 | major | O | Reviews could send regulated artifacts to outside vendors | `approvedReviewBackends` in `project.json` defaults to subagents only. `compliance` is checked first. |
| 16 | major | A | Pasted outputs had no provenance check | New provenance check. The kit's section 0 now prints `run_at`, and the provider outputs must name the instance. |
| 17 | major | K | Precheck findings had no rule for which gate they feed | Provider findings go to G0.3, kit findings to G0.4, CDC gaps to G0.5 |
| 18 | major | K | The cutover scribe recorded steps done on a person's word alone | It compares the output with the expected output, and a mismatch keeps the step open and goes to the go or no-go owner |
| 19 | major | K | Catch-up's repo search had no step where it could run | Catch-up never runs it, and lists bootstrap steps 4 to 6 as a next action |
| 20 | minor | O | Q-07 could collide with a new row | Seed Q-01 to Q-14 are updated in place, and new questions start at Q-20 |
| 21 | minor | O | Code-search hits could leak credentials | Record path and line only, and add a Finding for rotation (rule 8) |
| 22 | minor | O | The request draft was marked Waiting on customer before it was sent | In progress, "drafted, not sent", until a person confirms |
| 23 | minor | O K | `tracker_backend` and `trackerBackend` mismatch | `trackerBackend` everywhere |
| 24 | minor | O | No canvas path fallback in cloud runs | Resolve the slug, or fall back to `upgrade/dashboard.canvas.tsx` |
| 25 | minor | O K | Guide citations ahead of their quotes (S-01 generated columns, S-13 identity) | Quotes added, and the 5a wording matches S-13's standard and quick-start sentences |
| 26 | minor | K | The 6a and 6d guidance was too blunt | 6a names system-defined composites. 6d says to count nulls first and stop if any exist. |
| 27 | minor | K | `/pg-status` and the tracker skill disagreed on posting to Slack | Scheduled runs post if opted in. Interactive runs post only when asked. |

## Rejected or process

| By | Finding | Resolution |
|---|---|---|
| K | Gate review depends on a SOP "not in the plugin" | `reference/sop.md` is in the plugin. It wasn't in this round's file set. Round 2 reviews the whole plugin. |
| A K | "Required dependencies don't resolve" | Same cause: the round sent a subset of the plugin. The `workspace-layout` rule now says to stop and report a missing file. |

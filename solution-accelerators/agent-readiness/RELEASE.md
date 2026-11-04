# Release notes

## Release-gate policy (November 4, 2026)

These are the criteria a release of the agent-readiness skill has to meet on its skill evals. `npm run evals -- --release-check <run.json>` applies them and prints `RELEASE PASS` or `RELEASE FAIL`. The [evals README](evals/README.md#release-policy) has the details.

| Criterion | Bar | Fails the release? |
| --- | --- | --- |
| Hard gates, per case, at 5 repeats (k of n) | 1 run short is a flag; 2 or more short is a regression | Yes, on any regression |
| Headline judge, pooled over in-sample runs | Mean at least 0.8 and 95% CI lower bound at least 0.75 | Yes |
| Page judge | Mean and 95% CI, reported | No |
| Cases passing every gate in every repeat | Reported as a stat | No (no longer a criterion) |

## Expectations settled for this release

- **Elysia (`elysiajs/elysia@e037eca`) is Level 2 under rubric 2026-11-alpha.** The missing Bun version pin fails the `toolchain` condition, but toolchain pinning is a condition of the `repo_wide` scenario only. It doesn't hold the standard level. The real-repo validation set expects Level 2.

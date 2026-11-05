# Template review, round 2: SOP, skills and README

Run 2026-11-04, after the round 1 fixes and hill-climb round 2. Same rubrics and the same four reviewers, each seeing only the files under review. Raw output is in [raw/round-2-sop/](raw/round-2-sop/), [raw/round-2-skills/](raw/round-2-skills/) and [raw/round-2-readme/](raw/round-2-readme/).

| Reviewer | SOP | Skills | README |
|---|---|---|---|
| Astra (`gpt-6-astra`, Codex CLI) | 1 blocker, 5 major | 5 major | 3 major |
| Claude Opus 5.5 | 1 blocker, 11 major, 9 minor | 8 major, 15 minor | 7 major, 6 minor |
| Gemini 4 Argon | 5 blockers, 7 major, 1 minor | 4 blockers, 11 major, 5 minor | 5 major, 4 minor |
| Grok 4.7 | 2 blockers, 15 major, 4 minor | 1 blocker, 11 major, 4 minor | 6 major, 2 minor |

Grok's SOP review finished last and read a copy taken before the other SOP fixes landed, so some of its findings repeat items already fixed below.

## Fixed: blockers

| By | Finding | Fix |
|---|---|---|
| G K | The write fence (`default_transaction_read_only`) is user-settable, and it also blocked the in-window sentinel and DDL steps | The fence is `REVOKE CONNECT` from app roles plus terminating their sessions, which also stops clients that skip the pooler. The DBA's session keeps working for the in-window steps. |
| O | pg_upgrade from before 17 drops each subscription's table state, so "disable and re-enable" silently stops replicating | Inbound subscriptions are dropped and recreated after the upgrade, with a documented resync choice [S-38] |
| G | A production clone starts subscription workers against the real upstream | The clone's subscriptions are disabled before anything else runs on it |
| A | The drain test could pass before every change reached every consumer | Sentinels plus each slot's `confirmed_flush_lsn` reaching the fence LSN, and inbound subscriptions are disabled before the test |
| G | Nothing checked that upgrade plus rollback fit in the window | G2.1 requires the rehearsed upgrade end plus 1.25 times the rollback to fit |
| G | The kit's loop skipped `template1`, which pg_upgrade checks | `template1` is in the loop. Only provider-internal databases are excluded. The SQL test now runs the loop. |
| G | Nondeterministic-collation PK and FK pairs could wait for a runbook step | They're a pre-upgrade fix in B1-14 |
| K | The logical path drops large objects and unlogged tables with no check | Listed in the logical branch's cutover checks, and kit sections 3 and 5b report both |
| G | Precheck findings fed G0.3 and G0.4, deadlocking Block 0 | Block 0 gates need an owner and a fix task. The fixes themselves feed G1.1. |
| G | `run-review-round.sh` ignored `approvedReviewBackends` | `REVIEWERS` is required, with no default, and the skill checks each one against the approved list |
| G | Catch-up wrote `Approver: unknown`, which passed the checker | The checker rejects `unknown` as an Approver on a closed row |
| G | Hook rules missed global flags before the subcommand (`gcloud --project x sql ...`) | Global flags are stripped, and `sh -c`, `bash -c` and `eval` are checked recursively. 69 hook tests. |
| K | The cutover scribe never started the rollback at the decision time | At the decision time it says the runbook calls for rollback and walks it, unless the go or no-go owner decides otherwise on the record |

## Fixed: major items

- **Hooks in Cloud Agents.** `beforeMCPExecution` isn't available there, so a `preToolUse` hook matching `MCP:` covers HTTP MCP tools. No host is trusted by default, not even localhost, because a Cloud SQL Auth Proxy listens there.
- **Evidence.** Evidence must be a link, a path or a tracker ID. Done gates, closed decisions and waivers need a named Approver. "Approved in chat" no longer closes a row.
- **SOP additions.** A maintenance deny period (B1-13), a reindex and collation inventory (B1-14), a cross-version statement set (B1-15), the collation version check, the PostGIS floor, the census query, and appendix B settled at G2.8 before sign-off at G2.9.
- **Kit additions.** `run_at`, relkind and generated columns in 5b, generated columns in 6g, login roles in section 7, and follow-ups 8a to 8g.
- **Decision record.** A new `pg-upgrade-decision-record` skill drafts the record G0.7 needs.
- **Grok's late SOP items.** Record the pre-upgrade backup ID when the upgrade starts (R-04). Roll clients to the new secret before each password reset (R-10). Add a NOT NULL only when the child has no nulls (R-11). Reindex `btree_gist` and `ltree` right after a 14.24 minor (R-13). DMS quick-start migrations do replicate UPDATE and DELETE on keyless tables with INDEX or FULL identity (R-08).
- **README.** IaC timing, the Cloud Agents hook claim, prerequisites, gate highlights, and that the kit was tested on community Postgres only.

## Rejected

| By | Finding | Why |
|---|---|---|
| K | The kit's reg* list omits `regrole` (R-12) | pg_upgrade 18's `check.c` says "pg_authid.oid is preserved, so 'regrole' is OK". The kit matches that list [S-22]. |
| K | S-34 to S-37 were unverified (R-17) | They were added after the last source check. `check-sources.mjs --write` now verifies all 49 sources live. |

## Still open

These go to the pilot rather than another review round.

- A review made only of subagents can't guarantee two model families. The skill marks it `incomplete`, but a team that approves only subagents can't run a two-family review.
- Screening pasted output for row data and secrets uses patterns. It catches the common cases, but a person still checks each paste.
- B0-08 (customer outreach) and B0-11 have no dedicated skills; agents use the general tracker and runbook skills.
- When an external tracker comes back after an outage, `tracker-pending.csv` reports conflicts, but there's no three-way baseline to merge them.
- Partitioned parents with no stats (R-09): the SOP analyzes them, which in PG 18 also processes the children unless `ONLY` is used. Measure on the rehearsal before deciding.
- Version-specific facts, such as the PG 14 support dates and `POSTGRES_18`, are marked but not parameterized (R-16).

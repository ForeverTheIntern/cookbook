# Template review, round 1: SOP

Run 2026-11-04 on the first SOP draft, before the skills were written from it. Four reviewers each received only the files and the `sop` rubric from [independent-reviewer.md](../../plugins/pg-major-upgrade/agents/independent-reviewer.md). They saw neither this conversation nor each other's output.

| Reviewer | How | Verdict | Findings |
|---|---|---|---|
| Astra (`gpt-6-astra`) | Codex CLI, read-only, web search on | rework | 8 |
| Gemini 4 Argon | Cursor CLI, ask mode | rework | 19 |
| Grok 4.7 | Cursor CLI, ask mode | rework | 25 |
| Claude Opus 5.5 | Cursor CLI, ask mode | ship-with-fixes | 24 |

Files reviewed: `reference/sop.md`, `reference/sources.md` and `sources.json`, `assets/precheck.sql`, and the precheck reading guide.

## How findings were handled

- Duplicates were merged, and the reviewer letters show who raised each one: A for Astra, G for Gemini, K for Grok, O for Opus.
- Every factual claim was checked against the live source before acting on it. Confirmed findings were fixed, and rejected findings carry their evidence.
- Two process findings, that the reviewers didn't have the tracker schema, rules or hook, came from giving them the SOP alone. Round 2 includes those files.

## Fixed

| # | Sev | By | Finding | Fix |
|---|---|---|---|---|
| 1 | blocker | A K G O | G1.1 could pass on a kit rerun of 6a to 6g alone, while blockers from the provider precheck and sections 3 and 5b went unchecked | G1.1 now needs a provider precheck rerun with no `ERROR`, a kit rerun of every section that held a finding, and closing evidence on each original finding |
| 2 | blocker | A G K | The logical branch had no executable cutover, and it dropped validation, stats and routing | Rewritten as an explicit outline that the runbook skill expands. Every Block 2 and 3 gate still applies. Adds the write fence, final-sync confirmation, promotion, MV refresh, PITR re-enable and switch-back rollback [S-13] |
| 3 | blocker | G K O | Block 3 gates had no evidence column | Evidence added for G3.1 to G3.4 |
| 4 | blocker | G | Writes were fenced only by app maintenance mode, so stray jobs could write after the CDC drain and be lost when slots are deleted | Database-level read-only setting, a pooler pause, ending app sessions, and a final sentinel row before the drain (Inferred) |
| 5 | blocker | G O | CDC consumers and smoke tests ran before go or no-go 2, so a "lossless" rollback could already have downstream effects | Slots are created before go or no-go 2, but consumers start only at reopen. Smoke tests are read-only until then. |
| 6 | blocker | G | G2.5 couldn't be proven: there were no test writes before or after the upgrade | Sentinel rows before the fence and after new slots. Gate requires exactly-once arrival, or a full re-snapshot timed. |
| 7 | blocker | O | Applying the Terraform `database_version` change would itself start an unrehearsed MVU, and a bad plan could replace the instance | B1-11 and G1.7: the IaC change merges after the upgrade as a reconcile, with in-place or no-change plans only and deletion protection on |
| 8 | major | A O K | Rollback was only "timed restore", with no decision deadline and no proof of app recovery. The upgraded instance wasn't fenced during rollback. | G2.6 rehearses the full rollback through app validation. The runbook sets the latest rollback decision time, the T+10 checkpoint uses it, and rollback fences the upgraded instance first |
| 9 | major | O | `queryid` isn't stable across major versions, so the statement comparison couldn't work [S-34] | New B1-15 cross-version statement set, kept by the DBA. G2.4 and G3.3 use it. |
| 10 | major | O | Missing the `pg_squeeze` 1.8 floor for 18 [S-01] | Added |
| 11 | major | O | No path for replicas left out of the upgrade: they must upgrade first and can't be rolled back [S-01] | Decision-record item, plus Block 2 step 2 and rollback handling |
| 12 | major | O K | G1.4 couldn't be evidenced. PG 18 still accepts MD5 logins [S-17], and `pg_authid` isn't readable [S-36]. | Evidence is now a rotation log resetting every password role under SCRAM, or a provider answer. K suggested a login test; not adopted, because MD5 logins still succeed on 18. |
| 13 | major | O | Code search could copy connection strings with passwords into the tracker | B0-01 records path and line only, and found secrets go to their owner for rotation |
| 14 | major | O | No plan when a CDC connector has no version that supports the target | G0.5 and G1.3 require a named plan: replace, tested-unsupported waiver, or decision change |
| 15 | major | O | Provider maintenance could change the minor version between rehearsal and cutover | B1-13 maintenance freeze (deny period up to 90 days [S-35]) and minor alignment. T-14 check. |
| 16 | major | O | Unverified items weren't tied to any gate | New G2.8: every appendix B item answered, shown by the rehearsal, or waived |
| 17 | major | A G K | Reindex work (btree_gist, ltree, FTS and pg_trgm on non-libc, nondeterministic PK/FK collations) wasn't in any task, timing or runbook step | New B1-14 inventory, timed in Block 2 step 8, and run in Block 3 |
| 18 | major | G O K | The stats check ignored per-database scope, unreadable tables and empty tables | Per-database coverage query that excludes empty tables and counts unreadable ones. Analyze runs as the database owner [S-16]. |
| 19 | major | G K | Inbound subscriptions were listed by the kit but missing from G0.5 and the runbook | Added to G0.5, B1-05, and the drain and reopen steps |
| 20 | major | G K | The drain query included physical slots, and "lag zero" may never happen | Logical slots only. Drained means the final sentinel has arrived and `confirmed_flush_lsn` is stable across two checks. |
| 21 | major | G | Kit 5b didn't show partitioned or generated-column unlogged tables | 5b now shows `relkind` and `has_generated_columns`, and both are blockers in the guide |
| 22 | major | G | Kit 6g missed generated columns | 6g now covers generated columns. Tested on 14 (a `pg_class` column dependency) and 18 (`pg_attrdef`). |
| 23 | major | A | The guide marked keyless tables with FULL or INDEX identity as green, which is wrong for standard DMS [S-13] | The 5a guidance now depends on the tool chosen |
| 24 | major | A | G1.5's evidence (merged PRs) didn't show monitoring works | Exporter output and dashboard screenshots against a target-version instance |
| 25 | major | A | The re-snapshot fallback timed only the largest table | The full re-snapshot of every affected consumer, plus downstream catch-up |
| 26 | major | A | DMS branch omitted MV refresh and PITR re-enable [S-13] | Added to the logical branch |
| 27 | major | K | Clone shape wasn't part of G2.1 | G2.1 requires a matching tier, storage, topology and minor version, or a scaling waiver |
| 28 | major | K | The decision record didn't capture the source version's support dates | Added, with [S-21] and [S-02] |
| 29 | major | G K | Instance-wide limits were compared against per-database counts | The SOP and guide say to add up sections 2d and 2e across databases first |
| 30 | major | G O K | Several Verified claims weren't backed by their `sources.json` quotes (S-18, S-22, S-05, S-10) | Quotes added for S-01, S-13, S-16, S-18 and S-22. The `pg_authid` claim is now scoped to Cloud SQL, citing [S-36]. S-10's apostrophe-entity mismatch is fixed, and it rechecks green. |
| 31 | minor | O K | XID-age guidance waited until about 2 billion | Plan a freeze past about 1 billion (Inferred, [S-37]) |
| 32 | minor | O | Lists of sections invalid on a replica disagreed across the SOP, guide and kit header | One list everywhere: 4a, 4c, 6b, 8b |
| 33 | minor | O G | Provider-specific steps were undercounted in "Adapting" | The adapting section now lists every Cloud SQL-specific step by block |
| 34 | minor | O | Comms were undefined | B1-10 defines the audiences and moments. Runbook rows send each notice. |
| 35 | minor | O | The upgrade backups' lifecycle was unclear | Automatic pre-upgrade backup stated [S-01]. Close-out keeps upgrade backups until the business approver decides. |
| 36 | minor | O | The internal pg_upgrade test was labeled like a public fact | Relabeled as an internal observation on community Postgres, with no public source |
| 37 | minor | K | The B0-04 command lacked `--target-database-version` | Full commands in B0-04 |
| 38 | minor | K | The Flink no-snapshot resume ignored Flink's documented version range [S-26] | Step 10 cites [S-26] and requires checking the connector's range |
| 39 | minor | K | CREATEROLE changes weren't in any task | Added to B1-01 |
| 40 | minor | K | "Large objects block logical paths" overstated [S-13] | Now "not carried; migrate separately or waive" |
| 41 | minor | K | Slot survival from 17 was inferred without a source | Removed. Slots are assumed lost on any provider until a rehearsal shows otherwise. |
| 42 | minor | K | The point of no return was ambiguous between go or no-go 2 and reopen | The point of no return is the first write on the new version. Rollback applies until then. |

## Rejected, with evidence

| By | Finding | Why rejected |
|---|---|---|
| K | The rollback restores a backup from T-7, so it could lose a week of writes | Cloud SQL's pre-upgrade backup "is made immediately before starting the upgrade" [S-01], which is after the write fence, so it holds every write. The SOP now says this explicitly. |
| K | Cloud SQL's precheck reports prepared statements, not prepared transactions | Cloud SQL's message asks to "commit/rollback" items identified by `gid` [S-01], which are two-phase transactions. The SOP now quotes Cloud SQL's name for them. |
| G | Kit 6c always flags Cloud SQL's `cloudsqladmin`, which has `datallowconn = false` | A real Cloud SQL 14 precheck (section 2a) shows `cloudsqladmin` with `datallowconn = t`. The guide now says to ask the provider if a provider-managed database ever appears in 6c. |
| G | Kit 6a should include partitioned tables (`relkind = 'p'`) | pg_upgrade 18's own data-type check covers only tables, materialized views and indexes [S-22], and the kit mirrors it |

## Carried to round 2

- Review the SOP again with the rules, hook and tracker schema in the file set.
- Review the README once it's written.

# Readiness scan, per repo

The bootstrap starts one read-only scan per approved repo (task B0-02). Each scan reads code only. It never connects to a database, never runs the app's tests against a real database, and opens no PRs. Fix PRs come later, in Block 1.

## What to check

| Check | Where to look | Fills `Consumer` column |
|---|---|---|
| How it connects: primary, a replica, a pooler, or a CDC slot | Connection config, env var names, pooler config | `Path` |
| Database role it uses | Config, IaC, secrets references (names only) | `DB role` |
| Auth method: password (MD5 or SCRAM unknown from code), IAM, certificate | Driver options, connection strings (record the option name, never the value) | `Auth` |
| Driver or ORM, and its version | Lockfiles, dependency manifests | `Driver and version` |
| CDC: connector, version, decoding plugin, startup mode | Connector config, Debezium or Flink jobs, publication and slot names | `CDC` |
| Target-version hazards | See below | `Hazards found` |

Hazards to search for, with the SOP section each one comes from:

- Code that reads or sets removed settings: `vacuum_defer_cleanup_age`, `force_parallel_mode`, `promote_trigger_file`, `old_snapshot_threshold`, `stats_temp_directory`, `db_user_namespace` and `trace_recovery_messages` ([sop.md](sop.md), Block 0).
- Queries on `pg_stat_bgwriter` columns that moved to `pg_stat_checkpointer` (PG 17).
- `COPY ... FROM ... CSV` input that may contain `\.` (PG 18).
- AFTER triggers that depend on `current_user` (PG 18).
- Role-management scripts that use CREATEROLE (PG 16).
- Hard-coded hosts or instance names. Record the file and line only.
- Credentials in code. Record the file and line only, never the value, and add a `Finding` row so the owner can rotate it.

## Output

Write `upgrade/findings/scan-<repo>.md` with a table of checks, results and file:line references. Then update the repo's `Consumer` row:
- Fill the columns above.
- Set `Evidence` to the scan file.
- Set `Status` to `Needs approval`, so the repo owner can confirm it under G0.1.

Anything you couldn't determine is `unknown`, with a question row.

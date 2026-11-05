# Postgres major version upgrade: SOP

Version 0.1, 2026-11-04. Sources were rechecked live on that date ([sources.md](sources.md)).

## Short version

- The upgrade runs in four blocks, in order:
  - **Block 0, discover and decide.** Find every consumer and fact, and sign a decision record.
  - **Block 1, prepare in parallel.** Fix everything that's safe to ship on the old version.
  - **Block 2, rehearse on a clone.** Prove with timings that the runbook and the rollback fit the window, twice in a row.
  - **Block 3, cut over.** People run the night from a timed runbook.
- A block exits only when every one of its gate rows in the tracker is `Done` with linked evidence, or `Waived` by a named approver.
- Agents do the legwork: search, scans, parsing pasted results, drafting PRs, scripts and messages. People approve every merge and apply. People also run every command against production or a clone, and make every go or no-go call.
- The default path is an in-place major version upgrade (MVU), rehearsed on a production clone. A logical migration (DMS, pglogical or pgcopydb) is the fallback when the rehearsal can't fit the window ([section 6](#6-logical-branch)).
- Provider-specific steps are marked **Cloud SQL**. On another provider, swap in its equivalents. [Adapting](#8-adapting-to-another-provider) lists what changes.

## 1. How to read this

- **Citations.** `[S-nn]` points to a row in [sources.md](sources.md). Each row lists the exact quotes it was verified against.
- **Labels.** Each claim is **Verified** (the source says it), **Inferred** (reasoned from verified facts), or **Unverified** (no public source answers it, so the rehearsal or the provider settles it).
- **Gates.** `G<block>.<n>` names a gate. Gate rows live in the tracker ([tracker-schema.md](tracker-schema.md)), and each one names the evidence it needs.
- **Roles.** The program owner runs the upgrade. The DBA runs database commands. App teams own repos. CDC owners own each change-data-capture consumer. The business approver owns the window and the data-loss rule. The go or no-go owner makes the calls on the night.

## 2. Block 0: discover and decide

**Goal.** Know enough to pick the path and target version, size the window, and name an owner for every consumer and decision. Don't plan for an option that the facts rule out.

**Entry.**
- The Project is bootstrapped, with the tracker created and the repo list approved.
- The customer has said in writing what agents may and may not touch.
- A DBA has agreed to run read-only queries and paste the results back.

**Exit gates.**

| Gate | Done when | Evidence |
|---|---|---|
| G0.1 | Every repo and consumer row has an owner, an auth method and a connection path (primary, replica or pooler) | Consumer rows with an owner who has confirmed them |
| G0.2 | The precheck kit ran on the primary, once per database, with psql, and section 0 shows `is_replica = f`. Its facts are in the tracker. | `precheck-<db>.txt` for every database |
| G0.3 | The provider precheck against the target returned no errors, or each error has an owner and a Block 1 fix task | Precheck JSON and `operations describe` JSON |
| G0.4 | The precheck kit shows no blockers, or each one has an owner and a fix task | Parsed findings with tracker rows |
| G0.5 | Every logical slot, publication, subscription and pglogical node maps to a named consumer or source with an owner, a connector version, a decoding plugin, and a supported-version answer for the target. Where no supported version exists, the row names the plan: replace the connector, an owner's tested-unsupported waiver, or a change to the decision record. | CDC rows reconciled against kit sections 4a, 4b and 8 |
| G0.6 | The program owner has signed a decision record covering: path, target, window, data-loss rule, rollback approach and its latest decision time, go or no-go owner, target date, replica handling (upgrade with the primary, upgrade first, or rebuild), when IaC is reconciled, the provider maintenance freeze, and the source version's support dates (for 14: community updates end in November 2026 [S-21], and Cloud SQL extended support starts 2027-02-01 [S-02]) | `decision-record.md` |
| G0.7 | Questions for the provider have been sent, and someone owns tracking the replies | Question rows with an owner |

**Tasks.**

| ID | Task | Run by | Artifact |
|---|---|---|---|
| B0-01 | Code search across every org for DB connections: connection strings, hostnames, env var names, role names, ORMs and drivers. One session per org. Record only the file path and line of each hit, never the value. A secret found in code is reported to its owner for rotation, not copied anywhere. | Agent | Repo rows with path-and-line evidence |
| B0-02 | A read-only readiness scan per repo, one session per repo | Agent | A report per repo |
| B0-03 | Run the precheck kit ([precheck.sql](../assets/precheck.sql)) on the primary, for every database, and paste the results back | DBA | `precheck-<db>.txt` |
| B0-04 | Run the provider precheck and describe the instance. Cloud SQL: `gcloud sql instances pre-check-major-version-upgrade <instance> --target-database-version=POSTGRES_18 --format=json` [S-07, S-08], then `gcloud sql operations describe` for that operation, then `gcloud sql instances describe` (the exact commands are in the kit's header) | DBA | JSON outputs |
| B0-05 | Parse B0-03 and B0-04 into facts, findings and gate rows | Agent | Updated tracker |
| B0-06 | Live consumer census. The DBA samples `SELECT usename, application_name, client_addr, count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1, 2, 3` every 5 minutes for a week, as a role with `pg_read_all_stats`, and keeps the distinct combinations. Short-lived jobs can still slip between samples, so match against cron and job schedulers too. The agent matches the results to repo rows. | DBA, then agent | Unmatched-connection list |
| B0-07 | Reconcile the CDC inventory: slots, publications and pglogical nodes against named consumers | Agent drafts, CDC owners confirm | CDC rows |
| B0-08 | Owner outreach: one message per owner, asking them to confirm their rows | Agent drafts, a person sends | Confirmed rows |
| B0-09 | Constraints interview: window, data-loss rule, blackout dates, approvers | Program owner | Constraints in the decision record |
| B0-10 | Version research for this source and target pair, with sources | Agent | Research note |
| B0-11 | Questions for the provider (see [appendix B](#appendix-b-questions-only-the-provider-can-answer)) | Agent drafts, a person sends | Question rows |
| B0-12 | Decision record. Each decision is a `D-` row, seeded on day one with the rows it waits on. [decision-guide.md](decision-guide.md) gives the options, trade-offs and the facts that rule options out. | Agent lays out options, the named decider chooses, program owner signs | `decision-record.md` |

**SOP.**
1. Start B0-01, B0-02 and B0-10 together as soon as the repo list is approved.
2. Send the precheck request (B0-03 and B0-04) on day one, because it waits on the DBA's time. Ask for psql output, not output from an ORM or notebook. The kit's per-database loop and its section 7 guard only work in psql.
3. Validate each paste-back before reading it. This comes first because a partial run looks clean:
   - **Section 0.** If `is_replica` is true, sections 4a, 4c, 6b and 8b describe the replica, not the primary, so ask for a rerun on the primary. Catalog sections replicate and stay valid.
   - **Search** each file for `ERROR` and `permission denied`. One failed section doesn't stop the rest.
   - **Count databases.** Section 2a lists every database. Each customer database that allows connections needs its own file. Provider-internal ones, such as Cloud SQL's `cloudsqladmin`, don't. Instance-wide limits apply to the totals, so add up sections 2d and 2e across every database's file before comparing them with the limits below.
   - **Compare minor versions.** If the source minor is behind the provider's current one, record it. Behavior can change at that minor update, for example the `output_plugin_libraries` restriction for CDC plugins [S-21]. Verified that the setting exists; its effect on a given instance is Inferred.
4. Start the census (B0-06) the same day. A week of samples catches weekly batch jobs.
5. Build the CDC inventory from the catalog, not from interviews. Use kit sections 4a (slots), 4b (publications and subscriptions), and 8 (pglogical and slot mapping). The interview list is a starting point, and every slot or publication without a consumer becomes a question row. A subscription means this instance also consumes from somewhere else. Logical replication state migrates through pg_upgrade only when every member is 17.0 or later [S-38], so from 14 a subscription can't simply be disabled and re-enabled. Plan to drop it before the upgrade and recreate it afterwards, with a fresh table copy or a documented manual sync, and time that in the rehearsal (Inferred from S-38).
6. Look for tooling left over from earlier attempts. An installed `pglogical` extension, old publications and unused slots usually belong to a stopped migration. A slot holds WAL for as long as it exists, so it needs an owner or a drop.
7. Draft outreach (B0-08) as rows appear, grouped by owner, so each person gets one message.
8. Hold the constraints interview (B0-09) once the facts are in. People choose a window differently once they know the database size.
9. Work the decisions as their facts arrive, not all at the end. Show the program owner the `D-` rows in week one, so they know what they'll decide and who else must weigh in. As each decision's `Depends on` rows close, lay out its options with [decision-guide.md](decision-guide.md), and ask the named decider. A fact nobody has becomes a question row, linked from the decision. Decisions only the rehearsal can confirm, such as the path and the window, are recorded as provisional, with the fallback named.
10. Draft the decision record (B0-12), citing the tracker rows behind each choice. The program owner signs it.

**What the precheck findings mean.** The full reading guide is [precheck-reading-guide.md](../skills/pg-upgrade-precheck/references/precheck-reading-guide.md). These are the blockers and limits:

- **Catalog blockers.** Any row in kit section 6a (reg* types, `aclitem`, system composite types), 6b (prepared transactions), 6c (databases pg_upgrade can't connect to) or 6d (child columns missing a parent NOT NULL) blocks pg_upgrade 18. All four are Verified in pg_upgrade's own checks [S-22]. Cloud SQL's precheck also reports them, under the name "uncommitted prepared statements", identified by the transaction's `gid` [S-01].
- **search_path functions (section 6g).** From PG 17, maintenance runs with a safe `search_path` [S-18], so a function used in an index, a materialized view or a generated column that relies on `search_path` can fail. Kit section 6g covers those three. Check CHECK constraints by hand if they call your own functions. In the template authors' own test on community PostgreSQL 14 to 18 (not Cloud SQL), one such function passed `pg_upgrade --check` and then failed the real upgrade. That's an internal observation with no public source, so treat it as Inferred. Cloud SQL documents only earthdistance's `ll_to_earth` case [S-01]. Fix every row before the rehearsal, and let the rehearsal prove it.
- **Flags (section 6e).** Cloud SQL blocks the MVU on `vacuum_defer_cleanup_age` and `force_parallel_mode` [S-01]. Those settings and `promote_trigger_file` were removed or renamed in PG 16 [S-19], and `old_snapshot_threshold`, `db_user_namespace` and `trace_recovery_messages` in PG 17 [S-18]. A value whose source is the provider's own configuration file isn't a customer flag (Inferred), so check the instance's flag list and the IaC before acting on it.
- **Extensions (section 3).**
  - Cloud SQL 18 needs PostGIS 3.6.0, and `pg_squeeze` 1.8 [S-01]. Cloud SQL offers PostGIS 3.5.2 on PostgreSQL 14, and 3.6.0 only on 18 [S-10], so a PostGIS user can't meet that floor on the source. How Cloud SQL handles this (an intermediate version, or a provider-side path) is Unverified, so ask the provider before choosing in-place.
  - `pg_ivm` blocks the MVU [S-01].
  - `adminpack` is gone in 17 [S-18].
  - Indexes using `btree_gist`'s float4 or float8 operator classes, or `ltree`, may need a reindex after 14.24 [S-21].
  - Cloud SQL maintenance installs new extension binaries but doesn't update an extension's catalog version [S-10]. So extensions behind their default version (kit section 8f) need `ALTER EXTENSION ... UPDATE`. Running it again after the upgrade, for the target version's defaults, is Inferred from the same behavior.
- **Scale (sections 2a, 2d, 2e).**
  - Cloud SQL's MVU fails above 10 million large objects in total [S-01].
  - It can time out above 1,000 databases [S-01].
  - It's tuned for up to about 100,000 relations, and above that it's "less reliable" and may hit the six-hour timeout [S-01].
- **Unlogged tables (section 5b).**
  - PG 18 refuses unlogged partitioned tables [S-17].
  - Cloud SQL warns that unlogged tables with generated columns fail with `unexpected request for new relfilenumber in binary upgrade mode` [S-01].
  - Logical paths don't carry unlogged tables at all [S-13].
  - Stale unlogged scratch tables are usually best dropped once their owner confirms.
- **Vacuum health (section 6f).** XID ages near the default `autovacuum_freeze_max_age` of 200 million are normal. Wraparound is what freezing prevents [S-37]. If any database is past about 1 billion, plan a freeze well before the window, because a freeze on a large database can take days (Inferred).
- **Passwords (section 7).** PG 18 deprecates MD5 passwords but still accepts MD5 logins, and only warns when an MD5 password is set [S-17]. On Cloud SQL nobody is superuser [S-05], and `pg_authid` isn't publicly readable [S-36], so the MD5 role list can't be read. Logging in on the clone won't reveal MD5 either. G1.4's evidence is therefore a rotation log that resets every password-login role's password while `password_encryption = scram-sha-256`, or a provider-side answer.

**Risks.**
- **Consumers nobody listed.** Code search plus the live census, plus the CDC catalog reconciliation in G0.5.
- **A precheck that passes while the real upgrade fails.** Block 2 is the real check.
- **A partial paste-back read as clean.** Step 3's validation guards against it.

## 3. Block 1: prepare in parallel

**Goal.** Merge and deploy every fix that's safe on the source version before the rehearsal, and write the runbook, rollback plan and validation scripts.

**Entry.** Block 0 has exited and the decision record is signed.

**Exit gates.**

| Gate | Done when | Evidence |
|---|---|---|
| G1.1 | Every blocker from G0.3 and G0.4 is fixed in production on the source version | A provider precheck rerun with no `ERROR` entries, a kit rerun covering every section that held an original finding (3, 5b, 6a to 6g, 8), and each original `Finding` row closed with its own evidence |
| G1.2 | The app test suite passes against the target version in CI, on a database with no regulated data | CI run link |
| G1.3 | Every CDC connector has a version that supports the target, staged and approved by its owner, or follows the no-supported-version plan from G0.5 | Connector rows with version and approval, or a named waiver |
| G1.4 | Every password-login role has had its password reset under `scram-sha-256`, or has its owner's waiver | A rotation log listing each role and date, or a provider-side answer (see Block 0, passwords) |
| G1.5 | Monitoring works on the target version | Exporter output and dashboard screenshots taken against a target-version instance, such as the CI database or a clone |
| G1.6 | The program owner and DBA have reviewed the runbook, rollback plan, validation scripts and comms plan | Review approvals |
| G1.7 | IaC changes exist as reviewed PRs, planned but not applied, and the runbook says when they're reconciled | PR links whose plan output shows only in-place changes or none, with deletion protection on |

**Tasks.** Each shard is its own agent session on its own branch.

| ID | Shard | Run by | Artifact |
|---|---|---|---|
| B1-01 | App compatibility per repo: ORM and driver versions, AFTER trigger roles [S-17], `COPY ... CSV` handling of `\.` [S-17], code that reads removed settings, role-management scripts affected by the PG 16 CREATEROLE change [S-19], and error-code handling. Error-code changes beyond the PG 18 notes are Unverified, so test them rather than search for them. | Agent opens PRs, team approves | PRs |
| B1-02 | Catalog fixes: pin `search_path` on the 6g functions, add the missing NOT NULLs from 6d (only where the child column has no nulls; otherwise stop for the data owner), change the reg* columns from 6a | Agent writes migrations, DBA approves | Migration PRs |
| B1-03 | Flags: remove blocking and removed flags in Block 1, on the source. Plan how decoding plugins other than pgoutput will be allowed. The `output_plugin_libraries` restriction applies to the source as soon as it runs 14.24 [S-21], not just to the target, and Cloud SQL's flag list has no entry for it [S-11], so ask the provider. | Agent drafts the IaC PR, DBA applies it in Block 1 | IaC PR |
| B1-04 | Auth: reset every password-login role's password under SCRAM, and check that each driver supports SCRAM. For each role, publish the new secret to its clients and roll them first, then reset, so nothing loses its connection. | Both | Rotation log |
| B1-05 | CDC: upgrade connectors, and set the plugin and the new-slot plan. Add a small sentinel table to every outbound publication in production, through a migration PR. Write the drain steps, and the drop-and-recreate steps for inbound subscriptions. | Both | Connector PRs, sentinel migration, runbook section |
| B1-06 | Extensions: list the target versions and the `ALTER EXTENSION` steps | Agent | Runbook section |
| B1-07 | Monitoring: `pg_stat_bgwriter` columns moved to `pg_stat_checkpointer` in 17 [S-18]. Check exporters and dashboards against a target-version instance. | Agent opens PRs | PRs and screenshots |
| B1-08 | A CI job against the target version | Agent opens the PR | Green run |
| B1-09 | Validation scripts: version, extensions, stats coverage, row-count samples, the cross-version statement set (B1-15), CDC lag and sentinels | Agent | `validate.sql` |
| B1-10 | Runbook, rollback plan and comms plan. Comms covers who hears about the start, each go or no-go outcome, a rollback, and the reopening, and through which channel. | Agent drafts, people review | `runbook.md` |
| B1-11 | IaC for the target version. On Cloud SQL, changing `database_version` in Terraform starts an MVU of its own. So the version change merges after the runbook's upgrade step, as a reconcile, and its plan must show no change or an in-place change only, never a replacement. Google says replica-inclusive upgrades can't run from Terraform [S-01], but provider 7.41.0 added `include_replicas_for_major_version_upgrade` [S-31]. That conflict is Unverified. | Agent opens the PR, a person applies after the upgrade | IaC PR |
| B1-12 | Drop stale replicas, test instances, leftover slots, publications and scratch tables found in Block 0 | DBA | Change list |
| B1-13 | Freeze provider maintenance from the last rehearsal through cutover. On Cloud SQL a deny maintenance period can last up to 90 days [S-35]. Apply any pending minor update before the rehearsal, so the rehearsal and production run the same minor (Inferred). If that update reaches 14.24, run the `btree_gist` and `ltree` reindex from B1-14 right after it, rather than waiting for cutover [S-21]. | DBA | Maintenance settings |
| B1-14 | Reindex inventory: `btree_gist` float opclasses and `ltree` after 14.24 [S-21]; full-text search and `pg_trgm` indexes on clusters whose default collation provider isn't libc [S-17]; primary and foreign key pairs on nondeterministic collations, which pg_upgrade's restore refuses [S-17], so they're a Block 1 fix on the source, not a runbook step; and collations whose library version differs between the source and target images. pg_upgrade keeps existing index files, so a changed collation library can leave text indexes out of order (Inferred). Each becomes a fix task or a timed runbook step. | Agent drafts, DBA approves | Inventory and runbook steps |
| B1-15 | Cross-version statement set: about 20 representative statements with their parameters, chosen by the DBA and kept outside agent sessions. `queryid` isn't stable across major versions [S-34], so plans are compared by running `EXPLAIN` on this set on both versions. Only the timings and plan shapes go into the tracker. | DBA | Statement set (kept by the DBA) |

**SOP.**
1. Create one tracker row per shard, linked to its session.
2. Run sessions within the customer's concurrency limit. Agents open draft PRs only.
3. Merge on the source version only. Every fix here must work on both versions, so it ships before the window. A change that only works on the target goes into the runbook.
4. After the fixes reach production, rerun the provider precheck and every kit section that held a finding, then close each `Finding` row with its own evidence.
5. Freeze the runbook version that Block 2 will rehearse.

**Risks.** PRs sitting unreviewed (the daily status lists any older than two days, by owner). Connector upgrades that change event formats (each owner signs off on the format). ORM fixes that add slow query shapes on hot paths. An IaC apply that starts an unrehearsed upgrade (B1-11).

## 4. Block 2: rehearse on a clone

**Goal.** Prove with timings, on a production clone, that the runbook and the rollback fit the window, twice in a row. An in-place upgrade provisions nothing, so its risks are time and surprises.

**Entry.**
- Block 1 has exited.
- Security has approved a production clone, or a production-sized copy if data rules forbid a clone.
- The clone's budget is approved.

**Exit gates.**

| Gate | Done when | Evidence |
|---|---|---|
| G2.1 | Two rehearsals in a row finish the in-window steps within 75% of the window, and the rehearsed upgrade's end plus 1.25 times the rehearsed rollback still fits inside the window, on a clone that matches production's tier, storage, replica topology and minor version | Two timing sheets, plus the clone's shape, or a signed waiver saying how the timings were scaled |
| G2.2 | The provider precheck on the clone returns no errors | Precheck JSON |
| G2.3 | In every database, every non-empty table the analyze role can read has planner stats after the upgrade, or the in-window analyze covers the gap | Per-database stats coverage before and after |
| G2.4 | Every statement in the cross-version set (B1-15) runs within 2x of its source-version time, with no open plan regressions | Timing and plan-shape comparison |
| G2.5 | For every CDC consumer, sentinel rows written before the fence and after the new slots were created each arrived downstream exactly once. Or a full re-snapshot of every affected consumer, plus downstream catch-up, was timed and fits. | Sentinel check log or re-snapshot timing |
| G2.6 | The full rollback was rehearsed and timed through app validation, and the runbook states the latest rollback decision time | Rollback timing sheet |
| G2.7 | Pooler and replica routing came back correctly | Routing check log |
| G2.8 | Every item in [appendix B](#appendix-b-questions-only-the-provider-can-answer) is answered by the provider, shown by the rehearsal, or waived by a named approver | Question rows closed |
| G2.9 | The go or no-go owner has signed off the results | Sign-off row |

**SOP.** Record a timing for every step.
1. Clone production. Cloud SQL clones don't copy replicas [S-06]. If the instance has inbound subscriptions, disable them on the clone at once with `ALTER SUBSCRIPTION ... DISABLE`, then detach them with `ALTER SUBSCRIPTION ... SET (slot_name = NONE)`. Otherwise the clone's replication workers can connect to the production publisher and consume from its slots (Inferred).
   - Cross-project clone flags exist in gcloud [S-07], but the clone FAQ still says a database can't be cloned to another project [S-06]. That conflict is Unverified, so test it before you rely on it.
2. Set up replicas as the decision record says.
   - **Upgrading with the primary:** add replicas to the clone. Cloud SQL can upgrade replicas with the primary through gcloud [S-07], which rules out cancelling [S-01].
   - **Upgrading replicas first:** replicas left out must be upgraded before the primary. An upgraded replica can't be rolled back, and its databases are available only after the primary is upgraded [S-01]. Rehearse the read-routing impact while they're unavailable.

   Either way, record each replica's endpoint and stats count before and after. Whether they survive is Unverified.
3. Baseline on the source version, in every database, as the database owner:
   - The precheck kit.
   - The cross-version statement set (B1-15).
   - This stats coverage query:

     ```sql
     SELECT count(*) FILTER (WHERE has_stats) AS tables_with_stats,
            count(*) AS readable_nonempty_tables,
            (SELECT count(*) FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
              WHERE c2.relkind IN ('r', 'm') AND n2.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n2.nspname NOT LIKE 'pg_toast%' AND NOT has_table_privilege(c2.oid, 'SELECT')) AS unreadable_tables
     FROM (SELECT EXISTS (SELECT 1 FROM pg_stats s WHERE s.schemaname = n.nspname AND s.tablename = c.relname) AS has_stats
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND n.nspname NOT LIKE 'pg_toast%' AND has_table_privilege(c.oid, 'SELECT')
             AND pg_relation_size(c.oid) > 0) t;
     ```

     `pg_stats` shows only tables the caller can read, so a non-zero `unreadable_tables` means the coverage is incomplete. Rerun it as a role that can read them.
4. Start a test CDC consumer with production's connector version and plugin. Add a small sentinel table to its publication on the clone, insert numbered rows, and confirm they arrive downstream.
5. Start the window clock, then fence writes:
   - Pause the pooler and stop app writers.
   - Disable inbound subscriptions, so nothing replicates in.
   - Run `REVOKE CONNECT ON DATABASE <db> FROM PUBLIC, <app roles>` for each app database, then end the remaining app sessions with `pg_terminate_backend`. This also stops direct connections that skip the pooler, and the DBA's own session keeps working.
   - Confirm with the census query that only the DBA's and the CDC consumers' sessions remain.
   - Insert one final sentinel row, and note `pg_current_wal_lsn()` as the fence LSN.

   A connection-level fence is Inferred to be safer than app maintenance mode or a read-only default, because stray jobs ignore maintenance mode and any session can override `default_transaction_read_only`.
6. Drain CDC. A consumer is drained when its owner confirms the final sentinel arrived downstream, and its slot's `confirmed_flush_lsn` has reached the fence LSN. A consumer whose publication doesn't include the sentinel table, or that filters it out, needs `confirmed_flush_lsn` at or past the fence LSN plus its owner's confirmation. A slot that's stopped advancing short of the fence LSN is stalled, not drained.

   ```sql
   SELECT slot_name, plugin, active, confirmed_flush_lsn
   FROM pg_replication_slots WHERE slot_type = 'logical';
   ```

   Record each logical slot's name, plugin and consumer, and each subscription's definition. Cloud SQL's MVU deletes every logical replication slot [S-01], and from 14 neither slots nor subscription state migrate [S-38]. On other providers, assume they're lost until a rehearsal shows otherwise.
7. Upgrade, and record the pre-upgrade backup's ID as soon as the operation starts. Cloud SQL keeps two upgrade backups, and the rollback needs the pre-upgrade one, not the post-upgrade one [S-01]. Cloud SQL: `gcloud sql instances patch <clone> --database-version=POSTGRES_18`, adding `--include-replicas-for-major-version-upgrade` if replicas go with it [S-07]. Cloud SQL takes a pre-upgrade backup automatically, "immediately before starting the upgrade" [S-01], so it holds every write made before the fence. Record the operation ID. The precheck times out after three hours, and the upgrade after six [S-01].
8. Check the version, run `ALTER EXTENSION ... UPDATE` for each pending extension, run the reindex steps from B1-14, and repeat the stats coverage query. Then check collation versions, and reindex text indexes on any collation this query returns (Inferred):

   ```sql
   SELECT collname, collversion, pg_collation_actual_version(oid) AS actual
   FROM pg_collation WHERE collversion IS DISTINCT FROM pg_collation_actual_version(oid);
   ```
9. Analyze. Cloud SQL's only documented advice is "Run ANALYZE on your primary instance" [S-01], and whether its MVU keeps planner stats is Unverified. pg_upgrade 18 keeps most stats, but not extended, extension or cumulative stats [S-14]. Run every step as the database owner: database owners may analyze all tables in their database, and ANALYZE silently skips tables the caller can't analyze [S-16].
   - Try `vacuumdb --all --analyze-in-stages --missing-stats-only`. It needs SELECT on catalogs restricted to superusers [S-15], Cloud SQL customers can't be superuser [S-05], and one field report says the catalog isn't readable on Cloud SQL [S-33]. Expect it to fail.
   - **If coverage held:** don't run plain `--analyze-in-stages`, because it can make plans transiently worse [S-15]. Analyze only the non-empty tables with no `pg_stats` rows, plus the tables with extended statistics:

     ```sql
     SELECT c.oid::regclass AS table_name
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'm', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%' AND (c.relkind = 'p' OR pg_relation_size(c.oid) > 0)
       AND NOT EXISTS (SELECT 1 FROM pg_stats s WHERE s.schemaname = n.nspname AND s.tablename = c.relname)
     UNION
     SELECT DISTINCT stxrelid::regclass FROM pg_statistic_ext;
     ```

   - **If coverage dropped to near zero:** run `vacuumdb --all --analyze-in-stages` inside the window.
   - Either way, time a full `vacuumdb --all --analyze-only` to refresh cumulative stats, and decide whether it runs inside the window or after reopening. In 18, VACUUM and ANALYZE also process inheritance children [S-17].
10. Create the new slots, then start the test consumer from them. Insert post-upgrade sentinel rows, and check that downstream received every sentinel exactly once. Then time the fallback: a full re-snapshot of every affected consumer, plus downstream catch-up. Flink CDC has `latest-offset` and `committed-offset` startup modes [S-27], but its postgres-cdc connector documents support only up to PostgreSQL 14 [S-26], so confirm each connector's supported version range before relying on a startup mode. Whether a consumer can skip the snapshot is Inferred, so this step tests it.
11. Run the validation scripts, the cross-version statement set, and smoke tests. Keep smoke tests read-only until go or no-go 2.
12. Bring the pooler and replica routing up against the clone and check them.
13. Stop the window clock.
14. Rehearse the full rollback, and time it:
    - Create a recovery instance on the source version with the same flags and settings.
    - Restore the pre-upgrade backup to it [S-01].
    - Add replicas.
    - Repoint the pooler, apps and CDC, creating new slots on the recovery instance. The recovery instance has a new connection name and address, and may present a new server certificate, so list every client that connects directly or pins a certificate. Time their repointing too.
    - Recreate subscriptions.
    - Run validation.

    The latest rollback decision time is the window's end minus 1.25 times this duration. A restore can start only once the upgrade operation is cancelled or has ended. If the upgrade can't be cancelled (replicas are included, or it's past the main phase [S-01]), the rehearsed upgrade's end must come before that decision time, which is what G2.1 checks. The go or no-go owner approves the number in the runbook.
15. Record the timings in the tracker, close the appendix B questions this rehearsal answered, update the runbook, and delete the clone. Never delete production's upgrade backups as part of clone cleanup.

**Risks.**
- A rehearsal that doesn't match production: a different tier, no replicas, a different minor version, or a cold cache.
- Customer data on the clone. Agents never get its credentials. They read pasted output.
- Drift after the rehearsal. Freeze schema migrations until cutover, or rehearse again.

## 5. Block 3: cut over

**Goal.** Upgrade production inside the window with no data loss. Then validate and reopen, or roll back before reopening.

**Entry.**
- Block 2 has exited.
- The change ticket is approved, and the start notice is ready.
- A migration and deploy freeze and the maintenance freeze are in place.
- Named people are on the call: runbook lead, DBA, go or no-go owner, CDC owners, app on-call, and the comms owner.
- A provider support case is open.

**Exit gates.**

| Gate | Done when | Evidence |
|---|---|---|
| G3.1 | Production runs the target version, writes are open, and validation passed | `validate.sql` output and smoke-test results from the night |
| G3.2 | Every CDC consumer is current and its owner has confirmed it | Sentinel or lag readings, plus each owner's confirmation |
| G3.3 | The cross-version statement set runs within 2x of baseline after 24 hours | Timing comparison |
| G3.4 | Close-out is done | Close-out checklist with links |

**Runbook outline.** Timings come from Block 2.

| When | Step | Who | Checkpoint |
|---|---|---|---|
| T-14 days | Confirm the maintenance freeze covers the window [S-35], and that production runs the rehearsed minor version | DBA | |
| T-7 days | Freeze migrations. Confirm automated backups and point-in-time recovery are on (the MVU adds its own pre-upgrade backup [S-01]). Rerun the kit and the provider precheck. | DBA | A new error stops the cutover |
| T-1 day | Confirm people and the support case, send the start notice, and rerun the provider precheck | Runbook lead, comms owner | Go or no-go 1 |
| T-0 | Pause the pooler, stop writers, disable inbound subscriptions, revoke `CONNECT` from app roles, and end remaining app sessions. The census shows only the DBA's and CDC sessions. Insert the final sentinel, and record the fence LSN. | App on-call, DBA | |
| T+5 | Drain CDC (each owner confirms the final sentinel, and `confirmed_flush_lsn` has reached the fence LSN). Stop each consumer, then record slots and subscriptions. | CDC owners | |
| T+10 | Start the upgrade with the rehearsed command | DBA | At the latest rollback decision time (window end minus 1.25 times the rehearsed rollback duration), roll back unless the upgrade has finished. Escalate earlier if any step runs past its rehearsed time plus 25%. Cloud SQL can cancel only during the main upgrade phase, and not when replicas are included [S-01]. A restore starts only after the operation is cancelled or has ended. |
| | Check the version, update extensions, run the reindex steps, check stats coverage, and run the in-window analyze | DBA | |
| | Create the new slots, but don't start CDC consumers yet | CDC owners | |
| | Bring up the pooler and routing with app connections still revoked, then run validation and read-only smoke tests as the DBA | App on-call | Go or no-go 2. Announce the outcome. |
| | Reopen writes: grant `CONNECT` back, resume the pooler, start CDC consumers on the new slots (or start the timed re-snapshot, if the rehearsal chose it), recreate subscriptions, and send the reopened notice | Runbook lead, comms owner | The first write on the new version is the point of no return |
| T+1 hour | Merge the IaC version change as a reconcile. The plan must show no change or an in-place change. | DBA | |
| T+1 to 24 hours | Run the full analyze if it was deferred. Watch CDC lag, errors and the statement set. | DBA | |

**Rollback.**
- **Until the first write on the new version** (including a failure after go or no-go 2, if writes haven't reopened yet), run the rehearsed rollback:
  - Fence the upgraded instance, so it can't take writes: keep app `CONNECT` revoked, and keep the pooler pointed away from it.
  - Create the recovery instance, then restore the pre-upgrade backup [S-01].
  - Add replicas. If replicas were upgraded first, they can't be rolled back [S-01], so rebuild them from the recovery instance.
  - Repoint the pooler and apps.
  - Create slots on the recovery instance and reset CDC consumers to them.
  - Validate, then reopen, and announce the rollback.

  Nothing was written after the fence, and the smoke tests were read-only, so no data is lost. This holds only if the fence held (Inferred). Clients that connect directly need their new connection name and certificate, as rehearsed.
- **After reopening:** a restore would drop every write since. Pre-upgrade backups and WAL can't be used for point-in-time recovery across a major version on CloudNativePG [S-32], and whether Cloud SQL allows it is Unverified. Plan to fix forward, and have the business approver sign that in the decision record.

**Close-out.**
- Confirm stats coverage in every database.
- Delete clones, test instances and stale replicas.
- Keep the upgrade backups until the business approver decides they can go, then record who decided and when.
- Set any target-version settings you chose, such as `idle_replication_slot_timeout` [S-17].
- Lift the maintenance freeze.
- Hold a retro, turn each "the SOP said, we saw" entry into a template change, and close the tracker.

## 6. Logical branch

This template covers the logical path (DMS, pglogical or pgcopydb) only in outline. If the decision record picks it, the runbook skill drafts a separate logical runbook. Every Block 2 and Block 3 gate still applies, with evidence specific to this branch. The logical runbook covers at least:

- **Target build.** The target instance comes from the IaC PR, with a person approving and applying it.
- **Initial copy.** Time it, and time the catch-up lag at peak write rate. pgcopydb's `clone --follow` gives a faster copy, and its `compare` commands help validate any path [S-29]. DMS supports Cloud SQL for PostgreSQL 9.6 to 18 as both source and destination [S-12, S-09].
- **Keyless tables.** A standard DMS migration carries INSERTs on tables without a primary key, but not UPDATEs or DELETEs. A quick-start migration carries them if replica identity is INDEX or FULL [S-13]. Kit section 5a lists them.
- **What doesn't replicate.**
  - Unlogged tables and large objects don't replicate [S-13].
  - Materialized views arrive empty and need `REFRESH MATERIALIZED VIEW` [S-13].
  - Freeze DDL for the duration.
- **Recovery settings (DMS).** DMS suspends automated backups and point-in-time recovery on the destination during continuous replication [S-13]. Turn them back on after promotion, before reopening. For other tools, check the tool's own behavior.
- **Roles and credentials.** Migrate roles, grants and passwords to the target, and test every consumer's login there before cutover. Logical paths don't carry roles the way an in-place upgrade does (Inferred).
- **Sequences.** DMS syncs sequences at promotion [S-13]. For pglogical or pgcopydb, write and time the tool's own sequence sync step (Unverified for those tools).
- **Cutover.** Fence writes on the source, confirm the final changes have applied, promote, and validate. Then switch connection strings, using Block 0's consumer rows as the switch list. Recreate CDC slots on the new primary.
- **Rollback.** The source stays on the old version, so rolling back means switching connection strings back. Writes made on the target after the switch are lost unless they're replicated back (Inferred).

## 7. Guardrails

These are enforced by [the plugin's rules](../rules/) and [hook](../hooks/), and are tested in the template's evals.

- No production or clone credentials in any agent session. Every database fact comes from a pasted result.
- Code search records file paths and line numbers, never secret values.
- Agents open PRs and never merge or apply.
- No regulated data in prompts, pasted output or Slack. Statement baselines carry timings and plan shapes, never query text or parameters.
- Every claim cites a source or carries a label.

## 8. Adapting to another provider

These parts are specific to Cloud SQL. Swap each one for the provider's equivalent, and add its sources to [sources.json](sources.json).

- **Kit section 1 and gate G0.3:** the provider precheck command. Sections 0 and 2 to 8 are plain Postgres.
- **Block 0:** the blocking flags, the extension floors, the scale limits, and the superuser and `pg_authid` restrictions.
- **Block 1:** the IaC sequencing (B1-11) and the maintenance freeze (B1-13).
- **Block 2:** the clone and replica mechanics (steps 1 and 2), slot deletion (step 6), the upgrade command and timeouts (step 7), the superuser expectations in step 9, and the rollback (step 14).
- **Block 3:** the cancel rule at T+10, and the rollback.

## Appendix A: changes between 14 and 18 worth checking

| Version | Change | Who acts | Source |
|---|---|---|---|
| 15 | `stats_temp_directory` and exclusive backup mode removed | DBA, backup scripts | S-20 |
| 16 | `vacuum_defer_cleanup_age` and `promote_trigger_file` removed, `force_parallel_mode` renamed, CREATEROLE narrowed | DBA, IaC, role scripts | S-19 |
| 17 | Safe `search_path` during maintenance | Kit 6g, migration PRs | S-18 |
| 17 | `pg_stat_checkpointer` takes over `pg_stat_bgwriter` columns | Monitoring | S-18 |
| 17 | `old_snapshot_threshold` and `adminpack` removed | DBA | S-18 |
| 18 | MD5 passwords deprecated | Role owners | S-17 |
| 18 | VACUUM and ANALYZE process inheritance children unless `ONLY` | Maintenance jobs, analyze timing | S-17 |
| 18 | `COPY FROM ... CSV` no longer treats `\.` as end of input | ETL scripts | S-17 |
| 18 | Unlogged partitioned tables refused | Kit 5b | S-17 |
| 18 | AFTER triggers run as the role that queued them | Trigger owners | S-17 |
| 18 | Data checksums on by default, and pg_upgrade needs matching settings | The provider | S-17 |
| 18 | Full-text search and pg_trgm indexes need a reindex on non-libc clusters | DBA, if ICU or builtin | S-17 |
| 18 | PK and FK pairs must use deterministic or matching nondeterministic collations | DBA, if nondeterministic collations | S-17 |
| 18 | pg_upgrade keeps most planner stats | Block 2 step 9 | S-14 |
| 14.24 | `output_plugin_libraries` restricts decoding plugins to pgoutput and test_decoding by default | CDC owners | S-21, S-23 |
| 14.24 | Some `btree_gist` and `ltree` indexes may need a reindex | DBA | S-21 |

## Appendix B: questions only the provider can answer

These are Unverified until the provider answers or the rehearsal shows the answer. Gate G2.8 requires each one to be answered, shown by the rehearsal, or waived by a named approver before Block 2 exits.

1. Does the MVU to the target keep planner statistics?
2. Can the customer's admin role read `pg_statistic` to run `vacuumdb --missing-stats-only`?
3. Which decoding plugins are installed on the target?
4. Does an upgrade that includes replicas keep each replica's stats and hostname?
5. Can point-in-time recovery reach a point before the upgrade?
6. Can Terraform include replicas in the upgrade, given [S-31] against [S-01]?
7. Which pg_upgrade transfer mode does the provider use? In link, clone or swap mode the time follows relation count rather than data size [S-14]. In copy mode it follows data size (Inferred).
8. Can a clone go to another project, given [S-07] against [S-06]?
9. How does a PostGIS user meet the 3.6.0 floor for 18 when Cloud SQL's PostgreSQL 14 offers 3.5.2 [S-01, S-10]?
10. How can customers allow decoding plugins other than pgoutput under `output_plugin_libraries` on 14.24 and on 18 [S-21, S-11]?

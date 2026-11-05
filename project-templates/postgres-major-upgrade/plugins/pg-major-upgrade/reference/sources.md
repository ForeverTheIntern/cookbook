# Sources

Every factual claim in this template cites one of these public sources as `[S-nn]`. Each source lists exact quotes in [sources.json](sources.json). `node scripts/check-sources.mjs --write` re-fetches every page, confirms each quote still appears, and regenerates this file. A source whose quotes have moved is marked `changed`, and one that can't be fetched is marked `unreachable`. Treat claims that cite it as Unverified until someone rechecks.

Labels used in the docs:

- **Verified**: the cited page says it, and the quote check passed on the date shown.
- **Inferred**: reasoned from verified sources. The SOP says what it rests on.
- **Unverified**: no public source we could reach answers it. The SOP says how the rehearsal or the provider settles it.

Generated file. Edit `sources.json` instead.

| ID | Source | Supports | Status |
|---|---|---|---|
| S-01 | [Cloud SQL for PostgreSQL: Upgrade the database major version in-place](https://docs.cloud.google.com/sql/docs/postgres/upgrade-major-db-version-inplace) | In-place MVU mechanics and limits: uses pg_upgrade, deletes logical slots, extension floors for 18, blocking flags, large-object and database-count limits, relation-count reliability, precheck and upgrade timeouts, cancel window, replica rules, rollback through a recovery instance, ANALYZE afterwards. Automatic pre- and post-upgrade backups; pg_squeeze floors; rules for replicas left out of the upgrade. | Verified 2026-11-05 |
| S-02 | [Cloud SQL: Database version policies](https://docs.cloud.google.com/sql/docs/db-versions) | PostgreSQL 14 extended support starts 2027-02-01 and the version is deprecated 2030-02-01; extended support lasts three years. | Verified 2026-11-05 |
| S-03 | [Cloud SQL: Extended support](https://docs.cloud.google.com/sql/docs/postgres/extended-support) | Notifications begin three months before a version enters extended support. | Verified 2026-11-05 |
| S-04 | [Cloud SQL pricing](https://cloud.google.com/sql/pricing) | Extended support is billed per vCPU on top of instance pricing, with no committed-use discount. | Verified 2026-11-05 |
| S-05 | [Cloud SQL: About PostgreSQL users and roles](https://docs.cloud.google.com/sql/docs/postgres/users) | No customer superuser; cloudsqlsuperuser has a limited privilege list that doesn't include pg_statistic. | Verified 2026-11-05 |
| S-06 | [Cloud SQL: Clone instances](https://docs.cloud.google.com/sql/docs/postgres/clone-instance) | Clones don't copy replicas. The FAQ says a database can't be cloned to another project, which conflicts with S-07. | Verified 2026-11-05 |
| S-07 | [Google Cloud SDK release notes](https://dl.google.com/dl/cloudsdk/channels/rapid/RELEASE_NOTES) | gcloud added the standalone MVU precheck, the replica-inclusive upgrade flag, and cross-project clone flags. | Verified 2026-11-05 |
| S-08 | [gcloud sql instances pre-check-major-version-upgrade](https://cloud.google.com/sdk/gcloud/reference/sql/instances/pre-check-major-version-upgrade) | Reference for the precheck command and its target-version flag. | Verified 2026-11-05 |
| S-09 | [Cloud SQL for PostgreSQL release notes](https://docs.cloud.google.com/sql/docs/postgres/release-notes) | PostgreSQL 18 is GA on Cloud SQL and supported by DMS. | Verified 2026-11-05 |
| S-10 | [Cloud SQL for PostgreSQL extensions](https://docs.cloud.google.com/sql/docs/postgres/extensions) | Extension versions Cloud SQL ships (for example pgvector 0.8.5 on PostgreSQL 13 and later), and that maintenance installs new binaries but ALTER EXTENSION ... UPDATE is still needed. PostGIS: Cloud SQL offers 3.5.2 on PostgreSQL 13 to 17 and 3.6.0 on 18. | Verified 2026-11-05 |
| S-11 | [Cloud SQL for PostgreSQL flags](https://docs.cloud.google.com/sql/docs/postgres/flags) | cloudsql.logical_decoding is the flag that enables logical decoding. The page has no output_plugin_libraries entry. | Verified 2026-11-05 |
| S-12 | [Database Migration Service: Supported source and destination databases](https://docs.cloud.google.com/database-migration/docs/supported-databases) | DMS supports Cloud SQL for PostgreSQL 9.6 to 18 as source and destination. | Verified 2026-11-05 |
| S-13 | [Database Migration Service: Known limitations (PostgreSQL)](https://docs.cloud.google.com/database-migration/docs/postgres/known-limitations) | Logical-path limits: keyless tables, unlogged tables, large objects, sequences. Materialized views arrive empty; backups and PITR are suspended until promotion. | Verified 2026-11-05 |
| S-14 | [PostgreSQL 18: pg_upgrade](https://www.postgresql.org/docs/18/pgupgrade.html) | pg_upgrade 18 carries most optimizer statistics but not extended, extension, or cumulative statistics; adds --swap. | Verified 2026-11-05 |
| S-15 | [PostgreSQL 18: vacuumdb](https://www.postgresql.org/docs/18/app-vacuumdb.html) | --missing-stats-only needs superuser-restricted catalogs; --analyze-in-stages can make plans transiently worse when stats exist. | Verified 2026-11-05 |
| S-16 | [PostgreSQL 18: ANALYZE](https://www.postgresql.org/docs/18/sql-analyze.html) | ANALYZE silently skips tables the caller can't analyze. | Verified 2026-11-05 |
| S-17 | [PostgreSQL 18 release notes](https://www.postgresql.org/docs/18/release-18.html) | 18 incompatibilities: MD5 deprecation, VACUUM/ANALYZE recursion, COPY CSV end marker, unlogged partitioned tables, AFTER trigger role, checksum default, full-text and pg_trgm reindex on non-libc clusters, PK/FK collation rule, idle_replication_slot_timeout. | Verified 2026-11-05 |
| S-18 | [PostgreSQL 17 release notes](https://www.postgresql.org/docs/17/release-17.html) | 17 incompatibilities: safe search_path during maintenance, pg_stat_checkpointer, removed settings and adminpack. | Verified 2026-11-05 |
| S-19 | [PostgreSQL 16 release notes](https://www.postgresql.org/docs/16/release-16.html) | 16 removed vacuum_defer_cleanup_age and promote_trigger_file, renamed force_parallel_mode, and limited CREATEROLE. | Verified 2026-11-05 |
| S-20 | [PostgreSQL 15 release notes](https://www.postgresql.org/docs/15/release-15.html) | 15 removed stats_temp_directory and exclusive backup mode. | Verified 2026-11-05 |
| S-21 | [PostgreSQL 14.24 release notes](https://www.postgresql.org/docs/release/14.24/) | Community 14.x updates end November 2026; output_plugin_libraries restricts decoding plugins; btree_gist float opclass and ltree reindex notes. | Verified 2026-11-05 |
| S-22 | [pg_upgrade check.c (REL_18_STABLE)](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/bin/pg_upgrade/check.c) | Checks pg_upgrade 18 runs: NOT NULL inheritance, aclitem and reg* types, prepared transactions, datallowconn, output_plugin_libraries. Its data-type check covers tables, materialized views and indexes. | Verified 2026-11-05 |
| S-23 | [PostgreSQL commit 5d47df2: output_plugin_libraries](https://github.com/postgres/postgres/commit/5d47df21e89967e351df5ad7aa93bc3af40db64a) | The commit that added output_plugin_libraries with pgoutput and test_decoding as defaults. | Verified 2026-11-05 |
| S-24 | [PostgreSQL 18: Logical streaming replication protocol](https://www.postgresql.org/docs/18/protocol-logical-replication.html) | pgoutput protocol versions; older clients can request an older proto_version. | Verified 2026-11-05 |
| S-25 | [Debezium changelog](https://raw.githubusercontent.com/debezium/debezium/main/CHANGELOG.md) | Debezium added PostgreSQL 18 support (DBZ-9523). | Verified 2026-11-05 |
| S-26 | [Flink CDC connectors overview](https://raw.githubusercontent.com/apache/flink-cdc/master/docs/content/docs/connectors/flink-sources/overview.md) | Flink CDC's postgres-cdc lists PostgreSQL 9.6 to 14. | Verified 2026-11-05 |
| S-27 | [Flink CDC Postgres connector](https://raw.githubusercontent.com/apache/flink-cdc/master/docs/content/docs/connectors/flink-sources/postgres-cdc.md) | Flink CDC decoding plugin options and startup modes that may avoid a re-snapshot. | Verified 2026-11-05 |
| S-28 | [pgvector changelog](https://raw.githubusercontent.com/pgvector/pgvector/master/CHANGELOG.md) | Current pgvector releases; the next release drops PostgreSQL 13 and 14. | Verified 2026-11-05 |
| S-29 | [pgcopydb README](https://raw.githubusercontent.com/dimitri/pgcopydb/main/README.md) | pgcopydb clone with --follow, and compare commands for validation. | Verified 2026-11-05 |
| S-30 | [GoogleCloudPlatform/cloudsql-upgrade](https://raw.githubusercontent.com/GoogleCloudPlatform/cloudsql-upgrade/main/README.md) | Google's open-source upgrade tool, useful as a checklist reference. | Verified 2026-11-05 |
| S-31 | [Terraform provider for Google: CHANGELOG v7](https://raw.githubusercontent.com/hashicorp/terraform-provider-google/main/CHANGELOG_v7.md) | google provider 7.41.0 added include_replicas_for_major_version_upgrade, which S-01 says Terraform can't do. | Verified 2026-11-05 |
| S-32 | [CloudNativePG: PostgreSQL upgrades](https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/main/docs/src/postgres_upgrades.md) | Pre-upgrade backups and WAL can't be used for PITR across a major version. | Verified 2026-11-05 |
| S-33 | [pg_gather issue #69](https://github.com/jobinau/pg_gather/issues/69) | Field report that pg_statistic isn't readable on Cloud SQL. | Verified 2026-11-05 |
| S-40 | [Cursor docs: Projects](https://cursor.com/docs/agent/projects) | Projects: coordinator delegates to agents, one workspace repo, shared context files, subscriptions, plan availability. | Verified 2026-11-05 |
| S-41 | [Cursor docs: Automations](https://cursor.com/docs/cloud-agent/automations) | Standalone automations with triggers, prompts, and tools such as Send to Slack. | Verified 2026-11-05 |
| S-42 | [Cursor docs: Cloud Agents](https://cursor.com/docs/cloud-agent) | Cloud Agents run in parallel on their own VMs. | Verified 2026-11-05 |
| S-43 | [Cursor docs: Skills](https://cursor.com/docs/skills) | Skill format and locations. | Verified 2026-11-05 |
| S-44 | [Cursor docs: Rules](https://cursor.com/docs/rules) | Project rules and Team Rules. | Verified 2026-11-05 |
| S-45 | [Cursor docs: Plugins](https://cursor.com/docs/plugins) | Plugin manifest, team marketplaces and plan limits, and local plugin testing in ~/.cursor/plugins/local (copies, not symlinks; Enterprise admins must allow local imports). | Verified 2026-11-05 |
| S-46 | [Cursor docs: Canvas](https://cursor.com/docs/agent/tools/canvas) | Canvas sharing gives teammates a read-only snapshot link. | Verified 2026-11-05 |
| S-47 | [Cursor docs: Hooks](https://cursor.com/docs/hooks) | beforeShellExecution and preToolUse run in cloud agents; beforeMCPExecution doesn't, and HTTP MCP tools surface through preToolUse as MCP:<tool>. | Verified 2026-11-05 |
| S-48 | [Cursor docs: CLI headless](https://cursor.com/docs/cli/headless) | Print mode for scripts; --force is needed to apply file changes. | Verified 2026-11-05 |
| S-49 | [cursor/plugin-template](https://raw.githubusercontent.com/cursor/plugin-template/main/README.md) | Marketplace layout and the validate-template.mjs check. | Verified 2026-11-05 |
| S-50 | [Codex: Non-interactive mode](https://developers.openai.com/codex/noninteractive) | codex exec for scripted, read-only reviews with structured output. | Verified 2026-11-05 |
| S-34 | [PostgreSQL 18: pg_stat_statements](https://www.postgresql.org/docs/18/pgstatstatements.html) | queryid isn't stable across major versions, so it can't key a before-and-after comparison across the upgrade. | Verified 2026-11-05 |
| S-35 | [Cloud SQL: About maintenance](https://docs.cloud.google.com/sql/docs/postgres/maintenance) | Maintenance windows and deny maintenance periods of up to 90 days. | Verified 2026-11-05 |
| S-36 | [PostgreSQL 18: pg_authid](https://www.postgresql.org/docs/18/catalog-pg-authid.html) | pg_authid holds password hashes and isn't publicly readable; pg_roles blanks the password. | Verified 2026-11-05 |
| S-37 | [PostgreSQL 18: Routine vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html) | Transaction ID wraparound and how freezing prevents it. | Verified 2026-11-05 |
| S-38 | [PostgreSQL 18: Logical replication upgrade](https://www.postgresql.org/docs/18/logical-replication-upgrade.html) | Logical replication clusters migrate through pg_upgrade only when every member is 17.0 or later; older slots are silently ignored. | Verified 2026-11-05 |
| S-51 | [Cursor docs: Plugins reference](https://cursor.com/docs/reference/plugins) | A multi-plugin repository puts its marketplace manifest at .cursor-plugin/marketplace.json in the repository root. | Verified 2026-11-05 |

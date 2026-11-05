-- Postgres major version upgrade precheck (read-only)
--
-- Written for Cloud SQL for PostgreSQL 14 -> 18. Section 1 is Cloud SQL's own
-- precheck; sections 0 and 2-8 are plain Postgres and work on any provider.
--
-- Provided as-is, without warranty of any kind, to help plan your
-- Postgres upgrade. These are read-only catalog queries: no data is
-- changed and no row data or query text is returned. Please review
-- before running, and run at your discretion in your own environment.
-- This supplements Google's pre-check-major-version-upgrade; it
-- doesn't replace it.
--
-- Reads catalog metadata only: names, sizes, counts, settings. No row data and
-- no query text. Every statement is a SELECT, SHOW, or psql meta-command, so it
-- also runs with default_transaction_read_only=on and on a read replica.
--
-- Run it on the PRIMARY, once per database (sections 2b-2e and 5-6 are
-- per-database; sections 4a, 4c, 6b and 8b describe the replica, not the primary, when run there):
--
-- <conninfo> is a keyword connection string WITHOUT dbname, for example
-- "host=10.0.0.5 user=dba sslmode=require". The loop appends dbname for each database.
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "<conninfo> dbname=<db>" -X -f precheck.sql > precheck-<db>.txt 2>&1
--
--   for db in $(psql "<conninfo> dbname=postgres" -XAtc "SELECT datname FROM pg_database WHERE datallowconn AND datname NOT IN ('cloudsqladmin','rdsadmin','azure_maintenance','azure_sys')"); do
--     PGOPTIONS='-c default_transaction_read_only=on' \
--       psql "<conninfo> dbname=$db" -X -f precheck.sql > "precheck-$db.txt" 2>&1
--   done
--
-- ---------------------------------------------------------------------------
-- 1. Google's precheck to PG18 (run in a shell, not psql)
--
--   Simplest: gcloud (GA since Cloud SDK 541.0.0) waits for the result and prints it:
--     gcloud sql instances pre-check-major-version-upgrade INSTANCE \
--       --target-database-version=POSTGRES_18 --project=PROJECT --format=json
--
--   Raw API equivalent (returns an Operation; note its "name"):
--     curl -X POST \
--       -H "Authorization: Bearer $(gcloud auth print-access-token)" \
--       -H "Content-Type: application/json" \
--       "https://sqladmin.googleapis.com/v1/projects/PROJECT/instances/INSTANCE/preCheckMajorVersionUpgrade" \
--       -d '{"preCheckMajorVersionUpgradeContext":{"targetDatabaseVersion":"POSTGRES_18"}}'
--   then, once it shows status DONE, send the full output of:
--     gcloud sql operations describe OPERATION_NAME --project=PROJECT --format=json
--   Results are in preCheckMajorVersionUpgradeContext.preCheckResponse[]
--   (message, messageType INFO/WARNING/ERROR, actionsRequired).
--
--   Also send the versions this instance can upgrade to, its replicas and its flags:
--     gcloud sql instances describe INSTANCE --project=PROJECT \
--       --format="yaml(databaseVersion,upgradableDatabaseVersions,replicaNames,settings.databaseFlags)"
-- ---------------------------------------------------------------------------

\pset pager off
\echo '== 0. Server, database, role'
SELECT version(), current_database(), current_user, pg_is_in_recovery() AS is_replica, now() AS run_at;

\echo '== 2a. Database sizes and count (whole instance)'
SELECT datname,
       CASE WHEN has_database_privilege(oid, 'CONNECT') THEN pg_size_pretty(pg_database_size(oid)) END AS size,
       datallowconn
FROM pg_database
ORDER BY CASE WHEN has_database_privilege(oid, 'CONNECT') THEN pg_database_size(oid) END DESC NULLS LAST;

\echo '== 2b. 20 largest tables and matviews in this database (incl. indexes and TOAST)'
SELECT n.nspname, c.relname, c.relkind, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','m')
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 20;

\echo '== 2c. Partitioned tables, summed over their partitions'
SELECT c.oid::regclass AS partitioned_table, count(*) - 1 AS partitions,
       pg_size_pretty(sum(pg_total_relation_size(t.relid))) AS total_size
FROM pg_class c, LATERAL pg_partition_tree(c.oid) t
WHERE c.relkind = 'p' AND NOT c.relispartition
GROUP BY c.oid ORDER BY sum(pg_total_relation_size(t.relid)) DESC LIMIT 20;

\echo '== 2d. Object count by kind (r table, i index, S sequence, v view, m matview, c type, t TOAST, f foreign, p/I partitioned)'
SELECT relkind, count(*) FROM pg_class GROUP BY relkind ORDER BY 2 DESC;

\echo '== 2e. Other catalog object counts'
SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog','information_schema')) AS user_functions,
       (SELECT count(*) FROM pg_namespace) AS schemas,
       (SELECT count(*) FROM pg_largeobject_metadata) AS large_objects,
       (SELECT count(*) FROM pg_roles) AS roles;

\echo '== 3. Extensions and versions'
SELECT extname, extversion, extnamespace::regnamespace AS schema FROM pg_extension ORDER BY 1;

\echo '== 4a. Replication slots (primary only; a replica shows its own, usually none)'
SELECT slot_name, plugin, slot_type, database, active, wal_status, confirmed_flush_lsn
FROM pg_replication_slots;

\echo '== 4b. Publications and subscriptions'
SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate FROM pg_publication;
SELECT subname, subenabled FROM pg_subscription;

\echo '== 4c. Transactions open longer than 5 minutes (primary; needs pg_read_all_stats to see other users)'
SELECT pid, usename, datname, state, now() - xact_start AS xact_age, backend_xmin IS NOT NULL AS holds_xmin
FROM pg_stat_activity
WHERE xact_start < now() - interval '5 minutes'
ORDER BY xact_start;

\echo '== 5a. Tables without a primary key, with their replica identity'
SELECT n.nspname, c.relname, c.relkind,
       CASE c.relreplident WHEN 'd' THEN 'default (none without a PK)' WHEN 'f' THEN 'full'
                           WHEN 'i' THEN 'index' WHEN 'n' THEN 'nothing' END AS replica_identity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p')
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p')
ORDER BY 1, 2;

\echo '== 5b. Unlogged tables (not carried by logical replication; empty on read replicas)'
SELECT n.nspname, c.relname, c.relkind,
       EXISTS (SELECT 1 FROM pg_attribute a
               WHERE a.attrelid = c.oid AND a.attgenerated <> '' AND NOT a.attisdropped) AS has_generated_columns
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relpersistence = 'u' AND c.relkind IN ('r','p');

\echo '== 6a. Column types pg_upgrade 18 refuses from a 14 source (reg*, aclitem, system composite)'
WITH RECURSIVE base(oid, problem) AS (
    SELECT t.oid, 'reg* type' FROM pg_type t
    WHERE t.typnamespace = 'pg_catalog'::regnamespace
      AND t.typname IN ('regcollation','regconfig','regdictionary','regnamespace',
                        'regoper','regoperator','regproc','regprocedure')
  UNION ALL
    SELECT 'pg_catalog.aclitem'::regtype::oid, 'aclitem'
  UNION ALL
    SELECT t.oid, 'system-defined composite type' FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typtype = 'c' AND (t.oid < 16384 OR n.nspname = 'information_schema')
), oids(oid, problem) AS (
    SELECT oid, problem FROM base
  UNION ALL
    SELECT * FROM (
      WITH x AS (SELECT oid, problem FROM oids)
        SELECT t.oid, x.problem FROM pg_type t, x WHERE t.typbasetype = x.oid AND t.typtype = 'd'
      UNION ALL
        SELECT t.oid, x.problem FROM pg_type t, x WHERE t.typelem = x.oid AND t.typtype = 'b'
      UNION ALL
        SELECT t.oid, x.problem FROM pg_type t, pg_class c, pg_attribute a, x
        WHERE t.typtype = 'c' AND t.oid = c.reltype AND c.oid = a.attrelid
          AND NOT a.attisdropped AND a.atttypid = x.oid
      UNION ALL
        SELECT t.oid, x.problem FROM pg_type t, pg_range r, x
        WHERE t.typtype = 'r' AND r.rngtypid = t.oid AND r.rngsubtype = x.oid
    ) foo
)
SELECT DISTINCT o.problem, n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid
JOIN oids o ON o.oid = a.atttypid
WHERE NOT a.attisdropped
  AND c.relkind IN ('r','m','i')
  AND n.nspname !~ '^pg_temp_' AND n.nspname !~ '^pg_toast_temp_'
  AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1, 2, 3, 4;

\echo '== 6b. Open prepared transactions (primary)'
SELECT gid, prepared, owner, database FROM pg_prepared_xacts;

\echo '== 6c. Databases pg_upgrade cannot connect to (must be empty)'
SELECT datname, datallowconn, datconnlimit FROM pg_database
WHERE (datname <> 'template0' AND (NOT datallowconn OR datconnlimit = -2))
   OR (datname = 'template0' AND datallowconn);

\echo '== 6d. Child columns missing a parent NOT NULL (pg_upgrade 18 refuses these)'
SELECT nc.nspname, cc.relname, ac.attname
FROM pg_inherits i, pg_attribute ac, pg_attribute ap, pg_class cc, pg_namespace nc
WHERE cc.oid = ac.attrelid AND i.inhrelid = ac.attrelid
  AND i.inhparent = ap.attrelid AND ac.attname = ap.attname
  AND cc.relnamespace = nc.oid
  AND ap.attnum > 0 AND ap.attnotnull AND NOT ac.attnotnull;

\echo '== 6e. Settings set on this instance that no longer exist in 18'
SELECT name, setting, source FROM pg_settings
WHERE name IN ('vacuum_defer_cleanup_age','force_parallel_mode','promote_trigger_file',
               'old_snapshot_threshold','stats_temp_directory','db_user_namespace',
               'trace_recovery_messages')
  AND source NOT IN ('default','override');

\echo '== 6f. Transaction ID and multixact age per database'
SELECT datname, age(datfrozenxid) AS xid_age, mxid_age(datminmxid) AS mxid_age
FROM pg_database ORDER BY 2 DESC;

\echo '== 6g. User functions in indexes, matviews or generated columns without a pinned search_path (17+ runs maintenance with search_path=pg_catalog,pg_temp)'
SELECT DISTINCT d.classid::regclass AS used_by_catalog,
       CASE WHEN d.classid = 'pg_class'::regclass AND d.objsubid > 0
              THEN d.objid::regclass::text || '.' || (SELECT attname FROM pg_attribute WHERE attrelid = d.objid AND attnum = d.objsubid)
            WHEN d.classid = 'pg_class'::regclass THEN d.objid::regclass::text
            WHEN d.classid = 'pg_rewrite'::regclass THEN (SELECT ev_class::regclass::text FROM pg_rewrite WHERE oid = d.objid)
            ELSE (SELECT ad.adrelid::regclass::text || '.' || a.attname FROM pg_attrdef ad
                  JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum WHERE ad.oid = d.objid) END AS used_by,
       p.oid::regprocedure AS function
FROM pg_depend d
JOIN pg_proc p ON d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE pn.nspname NOT IN ('pg_catalog','information_schema')
  AND p.prolang NOT IN (SELECT oid FROM pg_language WHERE lanname IN ('c','internal'))
  AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) s WHERE s LIKE 'search_path=%')
  AND ((d.classid = 'pg_class'::regclass AND d.objsubid = 0 AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = d.objid))
    OR (d.classid = 'pg_class'::regclass AND d.objsubid > 0 AND EXISTS (SELECT 1 FROM pg_attribute a
                                                       WHERE a.attrelid = d.objid AND a.attnum = d.objsubid AND a.attgenerated <> ''))
    OR (d.classid = 'pg_rewrite'::regclass AND EXISTS (SELECT 1 FROM pg_rewrite r JOIN pg_class m ON m.oid = r.ev_class
                                                      WHERE r.oid = d.objid AND m.relkind = 'm'))
    OR (d.classid = 'pg_attrdef'::regclass AND EXISTS (SELECT 1 FROM pg_attrdef ad JOIN pg_attribute a
                                                       ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
                                                       WHERE ad.oid = d.objid AND a.attgenerated <> '')));

\echo '== 7. Password hashing, and login roles (names only) for the rotation in gate G1.4'
SHOW password_encryption;
SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname !~ '^(pg_|cloudsql)' ORDER BY 1;
SELECT has_table_privilege('pg_catalog.pg_authid', 'SELECT') AS can_read_authid \gset
\if :can_read_authid
SELECT rolname FROM pg_authid WHERE rolcanlogin AND rolpassword LIKE 'md5%' ORDER BY 1;
\else
\echo 'This role cannot read pg_authid (expected for cloudsqlsuperuser), so md5 roles are not listed.'
\endif

\echo '== 8a. Schemas that are per-backend temp namespaces (pg_upgrade does not dump these)'
SELECT count(*) FILTER (WHERE nspname ~ '^pg_(toast_)?temp_') AS temp_schemas,
       count(*) FILTER (WHERE nspname !~ '^pg_(toast_)?temp_') AS other_schemas
FROM pg_namespace;

\echo '== 8b. Logical slots with retained WAL, and connected consumers (primary)'
SELECT slot_name, plugin, slot_type, database, active, wal_status,
       CASE WHEN pg_is_in_recovery() THEN NULL
            ELSE pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) END AS retained_wal
FROM pg_replication_slots ORDER BY 1;
SELECT application_name, usename, state FROM pg_stat_replication ORDER BY 1;

\echo '== 8c. Tables per publication'
SELECT pubname, count(*) AS tables FROM pg_publication_tables GROUP BY 1 ORDER BY 1;

\echo '== 8d. Published tables with no primary key or that are unlogged'
SELECT pt.pubname, pt.schemaname, pt.tablename, c.relreplident, c.relpersistence
FROM pg_publication_tables pt
JOIN pg_namespace n ON n.nspname = pt.schemaname
JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = pt.tablename
WHERE c.relpersistence = 'u'
   OR NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p')
ORDER BY 1, 2, 3;

\echo '== 8e. pglogical nodes, subscriptions and replication sets (left over from an earlier migration?)'
SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pglogical') AS has_pglogical \gset
\if :has_pglogical
SELECT node_id, node_name FROM pglogical.node;
SELECT sub_name, sub_enabled, sub_slot_name FROM pglogical.subscription;
SELECT rs.set_name, count(rst.set_reloid) AS tables
FROM pglogical.replication_set rs
LEFT JOIN pglogical.replication_set_table rst USING (set_id)
GROUP BY 1 ORDER BY 1;
\else
\echo 'pglogical is not installed in this database.'
\endif

\echo '== 8f. Extensions behind their default version (need ALTER EXTENSION ... UPDATE)'
SELECT name, installed_version, default_version FROM pg_available_extensions
WHERE installed_version IS NOT NULL AND installed_version <> default_version
ORDER BY 1;

\echo '== 8g. Indexes using btree_gist, ltree or vector operator classes (reindex candidates)'
SELECT DISTINCT e.extname, i.indexrelid::regclass AS index, i.indrelid::regclass AS table_name,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS size
FROM pg_index i
JOIN pg_opclass oc ON oc.oid = ANY (i.indclass::oid[])
JOIN pg_depend d ON d.classid = 'pg_opclass'::regclass AND d.objid = oc.oid AND d.deptype = 'e'
JOIN pg_extension e ON e.oid = d.refobjid
WHERE e.extname IN ('btree_gist', 'ltree', 'vector')
ORDER BY 1, 2;

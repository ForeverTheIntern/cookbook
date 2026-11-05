-- Objects that should make each precheck section report something.
-- Loaded into a disposable container database by tests/sql/run-precheck.sh.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2c, 6d: a partitioned table, and an inheritance child missing the parent's NOT NULL
CREATE TABLE metrics (id bigint NOT NULL, recorded_at timestamptz NOT NULL) PARTITION BY RANGE (recorded_at);
CREATE TABLE metrics_2026 PARTITION OF metrics FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE legacy_parent (id int NOT NULL, note text);
CREATE TABLE legacy_child () INHERITS (legacy_parent);
DO $$
BEGIN
  -- Before 18, a child could drop a NOT NULL it inherited; pg_upgrade 18 refuses the result.
  -- Postgres 18 itself no longer allows the drop, so only create the mismatch on older servers.
  IF current_setting('server_version_num')::int < 180000 THEN
    EXECUTE 'ALTER TABLE legacy_child ALTER COLUMN id DROP NOT NULL';
  END IF;
END $$;

-- 5a: a table without a primary key
CREATE TABLE vendor_settings (k text, v text);

-- 5b: unlogged scratch table with a generated column
CREATE UNLOGGED TABLE tmp_backfill (id int, doubled int GENERATED ALWAYS AS (id * 2) STORED);

-- 6a: a reg* column
CREATE TABLE type_refs (id int PRIMARY KEY, fn regproc);

-- 6g: SQL functions without a pinned search_path, used by an index and a generated column
CREATE FUNCTION normalize_tags(text[]) RETURNS text LANGUAGE sql IMMUTABLE
  AS $$ SELECT array_to_string(array(SELECT lower(x) FROM unnest($1) x ORDER BY 1), ',') $$;
CREATE TABLE orders (id bigint PRIMARY KEY, tags text[], price numeric, valid tstzrange);
CREATE INDEX idx_orders_tags_norm ON orders (normalize_tags(tags));
CREATE FUNCTION price_band(numeric) RETURNS text LANGUAGE sql IMMUTABLE
  AS $$ SELECT CASE WHEN $1 > 100 THEN 'high' ELSE 'low' END $$;
ALTER TABLE orders ADD COLUMN band text GENERATED ALWAYS AS (price_band(price)) STORED;

-- 8g: a btree_gist exclusion constraint
CREATE TABLE price_windows (sku text, valid tstzrange, EXCLUDE USING gist (sku WITH =, valid WITH &&));

-- 4a, 4b, 8b, 8c, 8d: a publication including the keyless table, and a logical slot
CREATE PUBLICATION orders_feed FOR TABLE orders, vendor_settings;
SELECT pg_create_logical_replication_slot('test_slot', 'pgoutput');

-- A read-only role like the one a DBA would use
CREATE ROLE precheck_reader LOGIN PASSWORD 'reader';
GRANT pg_read_all_stats TO precheck_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO precheck_reader;

-- Synthetic "Acme shop" schema for the precheck eval fixtures.
-- Loaded into a disposable Postgres 14 container by build.sh.

CREATE DATABASE shop;
\connect shop

CREATE EXTENSION btree_gist;
CREATE EXTENSION pg_trgm;
CREATE EXTENSION pgcrypto;
CREATE EXTENSION pg_stat_statements;

CREATE TABLE order_events (id bigint PRIMARY KEY, order_id bigint, kind text, at timestamptz);
CREATE TABLE invoice_lines (id bigint PRIMARY KEY, invoice_id bigint, amount numeric);
CREATE TABLE audit_log (id bigint PRIMARY KEY, actor text, action text, at timestamptz);
CREATE TABLE shipments (id bigint PRIMARY KEY, order_id bigint, carrier text);

-- 5a: a table without a primary key
CREATE TABLE vendor_settings (k text, v text);

-- 6d: a legacy inheritance child that dropped its parent's NOT NULL
CREATE TABLE metrics (id bigint NOT NULL, recorded_at timestamptz NOT NULL, value numeric);
CREATE TABLE metrics_2026_q3 () INHERITS (metrics);
ALTER TABLE metrics_2026_q3 ALTER COLUMN recorded_at DROP NOT NULL;

-- 6g: a search_path-dependent SQL function used by an expression index
CREATE FUNCTION normalize_tags(text[]) RETURNS text LANGUAGE sql IMMUTABLE
  AS $$ SELECT array_to_string(array(SELECT lower(x) FROM unnest($1) x ORDER BY 1), ',') $$;
CREATE TABLE orders (id bigint PRIMARY KEY, tags text[], total numeric);
CREATE INDEX idx_orders_tags_norm ON orders (normalize_tags(tags));

-- 8g: a btree_gist exclusion constraint
CREATE TABLE price_windows (sku text, valid tstzrange, CONSTRAINT excl_price_windows EXCLUDE USING gist (sku WITH =, valid WITH &&));

-- 4b, 8c: publications
CREATE PUBLICATION orders_to_warehouse FOR TABLE orders, order_events, invoice_lines, shipments;
CREATE PUBLICATION search_index_feed FOR TABLE orders;

-- 4a, 8b: logical slots (build.sh renames the plugin on search_feed to decoderbufs)
SELECT pg_create_logical_replication_slot('debezium_orders', 'pgoutput');
SELECT pg_create_logical_replication_slot('search_feed', 'test_decoding');
SELECT pg_create_logical_replication_slot('old_migration_test', 'pgoutput');

CREATE ROLE dba_readonly LOGIN PASSWORD 'readonly';
GRANT pg_read_all_stats TO dba_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dba_readonly;

/**
 * The read model's one connection point. With SA_PORTAL_DATABASE_URL it is Postgres
 * (the customer's, or the Cursor app's); without it, PGlite in
 * SA_PORTAL_DATA_DIR (default .data/pglite, "memory" for none), which
 * applies migrations/ itself. The portal holds only what Foreman pushed, so a
 * wiped local database refills from the next heartbeat.
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface Query {
  <T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface Db {
  sql: Query;
  /** Runs `fn` in one transaction; the queries it makes go through the `Query` it is given. */
  transaction<T>(fn: (sql: Query) => Promise<T>): Promise<T>;
}

export async function migrateLocal(db: PGlite, dir = "migrations"): Promise<void> {
  await db.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".sql") && !done.has(f)).sort();
  for (const file of files) {
    const text = await readFile(`${dir}/${file}`, "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(text);
      await tx.query("insert into schema_migrations (name) values ($1)", [file]);
    });
  }
}

export function pgliteDb(db: PGlite): Db {
  return {
    sql: async (text, params = []) => (await db.query(text, params)).rows as never,
    transaction: (fn) => db.transaction((tx) => fn(async (text, params = []) => (await tx.query(text, params)).rows as never)),
  };
}

function postgresDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    sql: async (text, params = []) => (await pool.query(text, params)).rows,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(async (text, params = []) => (await client.query(text, params)).rows);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function startLocal(): Promise<Db> {
  const dir = process.env.SA_PORTAL_DATA_DIR?.trim() || ".data/pglite";
  if (dir !== "memory") await mkdir(dir, { recursive: true });
  const db = dir === "memory" ? new PGlite() : new PGlite(dir);
  await migrateLocal(db);
  return pgliteDb(db);
}

// Next dev reloads modules; one database per process, not per reload.
const cache = globalThis as unknown as { factoryPortalDb?: Promise<Db> };

export function db(): Promise<Db> {
  const url = process.env.SA_PORTAL_DATABASE_URL?.trim() ?? "";
  cache.factoryPortalDb ??= (url !== "" ? Promise.resolve(postgresDb(url)) : startLocal()).catch((error: unknown) => {
    cache.factoryPortalDb = undefined;
    throw error;
  });
  return cache.factoryPortalDb;
}

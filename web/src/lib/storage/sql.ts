// SQLite in the browser via sql.js (SQLite compiled to WASM). A real relational store for AUTOMO —
// structured memory, a searchable session index, tool-usage logs — instead of opaque IDB blobs. The DB
// lives in memory; we snapshot it to IDB (as bytes) after writes so it survives reloads. Ported in
// spirit from gh-pages-react/sqljs.ts (CDN-pinned wasm via locateFile).
//
// Dep-gated dynamic import (variable specifier) → bundles WITHOUT `sql.js`; add it to actually use.
import { idbGet, idbSet } from "./idb";

/* eslint-disable @typescript-eslint/no-explicit-any */
const SQL_DIST = "https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/";
const IDB_KEY = "sqljs:db"; // where the exported DB bytes live

let dbPromise: Promise<any> | null = null;

export async function getDb(): Promise<any> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const spec = "sql.js";
    const initSqlJs: any = (await import(/* @vite-ignore */ spec).catch(() => {
      throw new Error("SQL store needs `sql.js` — add it to use SQLite in the browser.");
    })).default;
    const SQL = await initSqlJs({ locateFile: (f: string) => SQL_DIST + f });
    const saved = await idbGet<Uint8Array>(IDB_KEY).catch(() => null);
    const db = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();
    db.run("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
    return db;
  })().catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

// Snapshot the in-memory DB to IDB so it survives reloads. Call after writes.
export async function persistDb(): Promise<void> {
  const db = await getDb();
  await idbSet(IDB_KEY, db.export());
}

// Run a statement (INSERT/UPDATE/DDL). Persists.
export async function run(sql: string, params: any[] = []): Promise<void> {
  const db = await getDb();
  db.run(sql, params);
  await persistDb();
}

// Query rows as objects (SELECT). Does not persist.
export async function all(sql: string, params: any[] = []): Promise<Record<string, any>[]> {
  const db = await getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: Record<string, any>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ---- convenience KV over the built-in table ----
export async function kvSet(key: string, value: unknown): Promise<void> {
  await run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [key, JSON.stringify(value)]);
}
export async function kvGet<T = unknown>(key: string): Promise<T | null> {
  const rows = await all("SELECT v FROM kv WHERE k = ?", [key]);
  return rows.length ? (JSON.parse(rows[0].v) as T) : null;
}

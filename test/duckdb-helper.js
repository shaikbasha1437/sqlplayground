// Starts DuckDB-WASM's Node build (same engine + version as the browser app) for smoke tests.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
export function haveDuckDB() { try { require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'); return true; } catch { return false; } }
export async function openDuckDB() {
  const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const dir = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs').replace(/[^/\\]+$/, '');
  const db = await duckdb.createDuckDB({
    mvp: { mainModule: dir + 'duckdb-mvp.wasm', mainWorker: dir + 'duckdb-node-mvp.worker.cjs' },
    eh: { mainModule: dir + 'duckdb-eh.wasm', mainWorker: dir + 'duckdb-node-eh.worker.cjs' },
  }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  const conn = db.connect();
  const rows = (sql) => conn.query(sql).toArray().map((r) => r.toJSON());
  return { db, conn, rows, fs };
}

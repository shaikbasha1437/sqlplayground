// Runs the same DuckDB-WASM version as the browser app (Node build) against the bundled samples and the SQL the app generates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDuckDB, haveDuckDB } from './duckdb-helper.js';
import { SAMPLES, WELCOME_SQL, BUILTIN_SNIPPETS } from '../samples.js';
import { buildReadSql, splitStatements } from '../core.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const skip = !haveDuckDB() && 'run npm install first';

test('DuckDB smoke: samples, generated read SQL, export round-trip', { skip }, async (t) => {
  const { db, conn, rows } = await openDuckDB();
  const ver = rows('SELECT version() AS v')[0].v;
  assert.equal(ver, 'v1.4.3');

  await t.test('sample datasets build deterministically', () => {
    for (const s of SAMPLES) conn.query(s.sql);
    const counts = Object.fromEntries(SAMPLES.map((s) => [s.name, Number(rows(`SELECT count(*) AS n FROM ${s.name}`)[0].n)]));
    assert.deepEqual(counts, { taxi_zones: 12, taxi_trips: 50000, customers: 2000, products: 120, orders: 20000, order_items: 49954 });
    const pay = rows('SELECT payment_type AS p, count(*)::INT AS n FROM taxi_trips GROUP BY ALL ORDER BY 1');
    assert.deepEqual(pay.map((r) => [r.p, r.n]), [['app', 4910], ['card', 33992], ['cash', 11098]]);
    // no orphan foreign keys
    assert.equal(Number(rows('SELECT count(*) AS n FROM order_items i ANTI JOIN orders o USING (order_id)')[0].n), 0);
    assert.equal(Number(rows('SELECT count(*) AS n FROM taxi_trips t ANTI JOIN taxi_zones z ON z.zone_id = t.pickup_zone_id')[0].n), 0);
  });

  await t.test('welcome queries and snippets run', () => {
    for (const s of splitStatements(WELCOME_SQL)) if (s.text.trim()) conn.query(s.text);
    const local = BUILTIN_SNIPPETS.filter((s) => !/https?:\/\//.test(s.sql));
    for (const s of local) for (const st of splitStatements(s.sql)) if (st.text.trim()) assert.doesNotThrow(() => conn.query(st.text), s.name);
  });

  await t.test('generated read_csv handles quoting, delimiters and header options', () => {
    db.registerFileText('a.csv', 'id;name;day\n1;"Bo; Jr.";2024-01-02\n2;Ann;2024-02-03\n');
    const r = rows(`SELECT * FROM ${buildReadSql('a.csv', 'csv', { delimiter: ';', header: true })} ORDER BY id`);
    assert.equal(r.length, 2); assert.equal(r[0].name, 'Bo; Jr.');
    const auto = rows(`SELECT typeof(day) AS t FROM ${buildReadSql('a.csv', 'csv', {})} LIMIT 1`);
    assert.equal(auto[0].t, 'DATE');
    const asText = rows(`SELECT typeof(day) AS t FROM ${buildReadSql('a.csv', 'csv', { autoTypes: false })} LIMIT 1`);
    assert.equal(asText[0].t, 'VARCHAR');
    db.registerFileText('b.tsv', 'x\ty\n1\t2\n');
    assert.equal(Number(rows(`SELECT y FROM ${buildReadSql('b.tsv', 'tsv', {})}`)[0].y), 2);
  });

  await t.test('CSV and Parquet exports re-read with the same data', () => {
    // The Node build writes COPY output to the real file system, so use a temp dir.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpg-')); const P = path.join(dir, 'o.parquet'), CSV = path.join(dir, 'o.csv');
    conn.query(`COPY (SELECT order_id, status, customer_id * 1.5 AS total FROM orders ORDER BY order_id LIMIT 500) TO '${P}' (FORMAT parquet, COMPRESSION zstd)`);
    conn.query(`COPY (SELECT order_id, status, customer_id * 1.5 AS total FROM orders ORDER BY order_id LIMIT 500) TO '${CSV}' (FORMAT csv, HEADER true)`);
    const pq = fs.readFileSync(P); assert.equal(new TextDecoder().decode(pq.subarray(0, 4)), 'PAR1');
    db.registerFileBuffer('o2.parquet', pq);
    const a = rows(`SELECT count(*)::INT AS n, sum(total)::DOUBLE AS s FROM ${buildReadSql('o2.parquet', 'parquet')}`)[0];
    const b = rows(`SELECT count(*)::INT AS n, sum(total)::DOUBLE AS s FROM ${buildReadSql(CSV, 'csv', {})}`)[0];
    const c = rows('SELECT count(*)::INT AS n, sum(total)::DOUBLE AS s FROM (SELECT customer_id * 1.5 AS total FROM orders ORDER BY order_id LIMIT 500)')[0];
    assert.equal(a.n, 500); assert.equal(b.n, 500);
    assert.ok(Math.abs(a.s - c.s) < 1e-6 && Math.abs(b.s - c.s) < 1e-6);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await conn.close?.();
});

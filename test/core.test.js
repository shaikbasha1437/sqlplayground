import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import * as C from '../core.js';

test('splitStatements respects strings, identifiers, comments and dollar quotes', () => {
  const sql = "SELECT ';' AS a; -- c;\nSELECT \"x;y\" FROM t /* ; /* nested ; */ */;\nSELECT $q$ ; $q$, E'it\\'s;';\n  \nSELECT 4";
  const parts = C.splitStatements(sql).map((s) => s.text.trim());
  assert.equal(parts.length, 4);
  assert.match(parts[0], /^SELECT ';' AS a;?$/);
  assert.match(parts[1], /nested/);
  assert.match(parts[2], /\$q\$ ; \$q\$/);
  assert.equal(parts[3], 'SELECT 4');
});

test('statementAt picks the statement under the cursor', () => {
  const sql = 'SELECT 1;\nSELECT 2;\n\nSELECT 3';
  assert.match(C.statementAt(sql, 2).text, /SELECT 1/);
  assert.match(C.statementAt(sql, sql.indexOf('2')).text, /SELECT 2/);
  assert.match(C.statementAt(sql, sql.length).text, /SELECT 3/);
});

test('query-like detection', () => {
  assert.ok(C.isQueryLike('select 1'));
  assert.ok(C.isQueryLike('WITH a AS (SELECT 1) SELECT * FROM a'));
  assert.ok(!C.isQueryLike('CREATE TABLE t AS SELECT 1'));
  assert.equal(C.firstKeyword('  -- hi\n  insert into t values (1)'), 'INSERT');
  assert.equal(C.stripTrailingSemicolon('SELECT 1 ;  '), 'SELECT 1');
});

test('quoting', () => {
  assert.equal(C.quoteIdent('a"b'), '"a""b"');
  assert.equal(C.quoteLiteral("it's"), "'it''s'");
});

test('table names from file names', () => {
  assert.equal(C.sanitizeTableName('2024 Sales-Report (final).csv'), 't_2024_sales_report_final');
  assert.equal(C.sanitizeTableName('orders.parquet'), 'orders');
  assert.equal(C.uniqueName('orders', new Set(['orders', 'orders_2'])), 'orders_3');
  assert.ok(C.isValidTableName('my_table1'));
  assert.ok(!C.isValidTableName('1table'));
  assert.equal(C.detectFormat('x.TSV'), 'tsv');
  assert.equal(C.detectFormat('x.jsonl'), 'ndjson');
  assert.equal(C.detectFormat('x.xlsx'), 'xlsx');
});

test('buildReadSql', () => {
  assert.match(C.buildReadSql('data/a.csv', 'csv', { delimiter: ';', header: true }), /read_csv\('data\/a\.csv'.*delim = ';'.*header = true/);
  assert.match(C.buildReadSql('a.parquet', 'parquet'), /^read_parquet\('a\.parquet'/);
  assert.match(C.buildReadSql('a.ndjson', 'ndjson'), /newline_delimited/);
  assert.match(C.buildReadSql('a.xlsx', 'xlsx', { sheet: 'Q1' }), /read_xlsx\('a\.xlsx'.*sheet = 'Q1'/);
});

test('cell formatting', () => {
  assert.equal(C.scaleDecimal('12345', 2), '123.45');
  assert.equal(C.scaleDecimal('-125', 2), '-1.25');
  assert.equal(C.scaleDecimal('5', 3), '0.005');
  assert.equal(C.formatDateMs(Date.UTC(2024, 1, 29)), '2024-02-29');
  assert.equal(C.formatTimeMicros(3723000001n), '01:02:03.000001');
  assert.equal(C.formatCell(null), null);
  assert.equal(C.formatCell(12n, { kind: 'bigint' }), '12');
});

test('CSV / TSV / Markdown / INSERT output', () => {
  const cols = ['id', 'name'];
  const rows = [[1, 'a,b'], [2, 'say "hi"'], [3, null]];
  assert.equal(C.toCSV(cols, rows), 'id,name\n1,"a,b"\n2,"say ""hi"""\n3,\n');
  assert.ok(C.toCSV(cols, rows, { bom: true }).startsWith('\ufeff'));
  assert.match(C.toTSV(cols, rows), /^id\tname\n1\ta,b/);
  const md = C.toMarkdown(cols, [[1, 'x|y']]);
  assert.match(md, /^\| id \| name \|\n\| ---/);
  assert.match(md, /x\\\|y/);
  const ins = C.toInserts('t', cols, rows, ['number', 'string']);
  assert.match(ins, /^INSERT INTO "t" \("id", "name"\) VALUES/);
  assert.match(ins, /\(2, 'say "hi"'\)/);
  assert.match(ins, /\(3, NULL\)/);
});

test('share links round-trip, including unicode', async () => {
  const payload = { sql: 'SELECT \'héllo ✓\' AS x;\n'.repeat(20), title: 'Tab' };
  const enc = await C.encodeShare(payload);
  assert.match(enc, /^(z1|u1)\./);
  const dec = await C.decodeShare('#q=' + enc);
  assert.equal(dec.sql, payload.sql);
  assert.equal(dec.title, 'Tab');
  assert.equal(await C.decodeShare('#nothing'), null);
});

test('workspace serialize / parse', () => {
  const json = C.serializeWorkspace({ tabs: [{ id: 'x', title: 'A', sql: 'SELECT 1' }], snippets: [{ name: 's', sql: 'SELECT 2' }], tables: [{ name: 't', format: 'csv', fileName: 't.csv' }] });
  const ws = C.parseWorkspace(json);
  assert.equal(ws.tabs[0].sql, 'SELECT 1');
  assert.equal(ws.snippets[0].name, 's');
  assert.equal(ws.tables[0].name, 't');
  assert.throws(() => C.parseWorkspace('{"kind":"other"}'));
});

test('zip round-trip with a real inflater', async () => {
  const blob = C.makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) }]);
  const u8 = new Uint8Array(await blob.arrayBuffer());
  assert.equal(String.fromCharCode(u8[0], u8[1]), 'PK');
  const entries = await C.readZip(u8, async (d) => new Uint8Array(inflateRawSync(d)));
  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'dir/b.bin']);
  assert.equal(new TextDecoder().decode(entries[0].data), 'hello');
  assert.deepEqual([...entries[1].data], [0, 1, 2, 255]);
  assert.equal(C.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('DuckDB error locations', () => {
  const msg = 'Parser Error: syntax error at or near "FORM"\n\nLINE 2: FORM t\n        ^';
  const loc = C.parseErrorLocation(msg);
  assert.equal(loc.line, 2);
  assert.equal(C.cleanError('Error: Binder Error: x'), 'Binder Error: x');
});

test('misc display helpers', () => {
  assert.equal(C.formatBytes(1536), '1.5 KB');
  assert.equal(C.formatCount(1234567), '1,234,567');
  assert.ok(C.formatDuration(1500).includes('1.5'));
  const t = C.niceTicks(0, 97, 5); assert.equal(t[0], 0); assert.ok(t.at(-1) >= 97);
  assert.ok(C.compareValues(1n, 2) < 0);
  assert.ok(C.compareValues(null, 1) > 0 || C.compareValues(null, 1) < 0);
  assert.equal(C.duckTypeLabel('Decimal[18e+2]'), 'DECIMAL(18,2)');
  assert.equal(C.duckTypeLabel('Timestamp<MICROSECOND, UTC>'), 'TIMESTAMPTZ');
  assert.equal(C.duckTypeLabel('Utf8'), 'VARCHAR');
});

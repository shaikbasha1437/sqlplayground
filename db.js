// DuckDB-WASM engine wrapper (runs DuckDB in a Web Worker) + IndexedDB storage for imported files.
import { AsyncDuckDB, VoidLogger, DuckDBDataProtocol, selectBundle, ArrowTable } from './vendor/lib.js';
import { quoteIdent, quoteLiteral, buildReadSql, formatCell, duckTypeLabel } from './core.js';

export const DUCKDB_WASM_VERSION = '1.32.0';
const BASE = new URL('./', location.href).href;

// Arrow field -> display metadata
export function fieldInfo(f) {
  const t = f.type; const id = t.typeId; let kind = 'string';
  if (id === 2) kind = t.bitWidth === 64 ? 'bigint' : 'number';
  else if (id === 3) kind = 'number';
  else if (id === 7) kind = 'decimal';
  else if (id === 8) kind = 'date';
  else if (id === 10) kind = 'timestamp';
  else if (id === 9) kind = 'time';
  else if (id === 6) kind = 'bool';
  else if (id === 4 || id === 15 || id === 19) kind = 'binary';
  else if (id === 12 || id === 13 || id === 16 || id === 17 || id === 14) kind = 'nested';
  else if (id === 11) kind = 'interval';
  else if (id === 18) kind = 'bigint';
  const unit = id === 9 ? ['s', 'ms', 'us', 'ns'][t.unit] : undefined;
  return { name: f.name, kind, scale: t.scale, tz: !!t.timezone, unit, label: duckTypeLabel(String(t)), arrow: String(t) };
}
export const isNumericKind = (k) => k === 'number' || k === 'bigint' || k === 'decimal';

// A query result: an Arrow table plus helpers to read cells as raw values or display text.
export class Result {
  constructor(table, meta = {}) {
    this.table = table; this.columns = table.schema.fields.map(fieldInfo);
    this.rowCount = table.numRows; this.vectors = this.columns.map((_, i) => table.getChildAt(i));
    Object.assign(this, meta);
  }
  raw(r, c) { const v = this.vectors[c]; return v ? v.get(r) : null; }
  text(r, c) { return formatCell(this.raw(r, c), this.columns[c]); }
  // numeric value for charts/sorting (decimals scaled, dates/timestamps as epoch ms)
  num(r, c) {
    const v = this.raw(r, c); if (v === null || v === undefined) return NaN; const col = this.columns[c];
    if (col.kind === 'decimal') return Number(this.text(r, c));
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number') return v; if (typeof v === 'boolean') return v ? 1 : 0;
    return Number(v);
  }
  rowsText(order, cols, limit = Infinity) {
    const out = []; const n = Math.min(order ? order.length : this.rowCount, limit);
    for (let i = 0; i < n; i++) { const r = order ? order[i] : i; out.push(cols.map((c) => this.text(r, c))); }
    return out;
  }
}

export class Engine {
  constructor() { this.db = null; this.conn = null; this.meta = null; this.running = false; this.cancelRequested = false; this.bundle = null; }
  async init(onProgress = () => {}) {
    const bundles = {
      mvp: { mainModule: BASE + 'vendor/duckdb/duckdb-mvp.wasm', mainWorker: BASE + 'vendor/duckdb/duckdb-browser-mvp.worker.js' },
      eh: { mainModule: BASE + 'vendor/duckdb/duckdb-eh.wasm', mainWorker: BASE + 'vendor/duckdb/duckdb-browser-eh.worker.js' },
    };
    const bundle = await selectBundle(bundles); this.bundle = bundle;
    onProgress({ phase: 'worker', loaded: 0, total: 0 });
    this.worker = new Worker(bundle.mainWorker);
    const db = new AsyncDuckDB(new VoidLogger(), this.worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker, (p) => onProgress({ phase: 'wasm', loaded: p.bytesLoaded, total: p.bytesTotal }));
    onProgress({ phase: 'open', loaded: 1, total: 1 });
    await db.open({ path: ':memory:', query: { castBigIntToDouble: false }, filesystem: { allowFullHTTPReads: true } });
    this.db = db; this.conn = await db.connect(); this.meta = await db.connect();
    this.version = (await this.meta.query('SELECT version() AS v')).getChild('v').get(0);
    // Extensions (parquet, json, excel) are served from this site so the app works offline.
    await this.meta.query(`SET custom_extension_repository = ${quoteLiteral(BASE + 'ext')}`);
    this.platform = bundle.mainModule.includes('-eh') ? 'wasm_eh' : 'wasm_mvp';
    return this;
  }
  async terminate() { try { await this.db?.terminate(); } catch { /* ignore */ } this.db = null; }
  // Runs one statement, streaming Arrow batches; stops reading after maxRows (truncated=true).
  async run(sql, { maxRows = 1000000 } = {}) {
    this.running = true; this.cancelRequested = false; const t0 = performance.now();
    try {
      const reader = await this.conn.send(sql, true);
      const batches = []; let rows = 0; let truncated = false;
      while (true) {
        if (this.cancelRequested) { await this.conn.cancelSent().catch(() => {}); throw new Error('Query cancelled.'); }
        const { done, value } = await reader.next();
        if (done) break;
        if (value && value.numRows) { batches.push(value); rows += value.numRows; }
        if (rows >= maxRows) { truncated = true; await this.conn.cancelSent().catch(() => {}); break; }
      }
      const table = batches.length ? new ArrowTable(batches) : new ArrowTable(reader.schema);
      return new Result(table, { ms: performance.now() - t0, truncated, sql });
    } catch (e) {
      if (this.cancelRequested) throw new Error('Query cancelled.');
      throw e;
    } finally { this.running = false; }
  }
  async cancel() { this.cancelRequested = true; try { return await this.conn.cancelSent(); } catch { return false; } }
  // Metadata / internal queries on a separate connection.
  async q(sql) { const t = await this.meta.query(sql); return new Result(t); }
  async rows(sql) { return (await this.meta.query(sql)).toArray().map((r) => r.toJSON()); }
  async exec(sql) { await this.meta.query(sql); }
  async registerFile(path, file) { await this.db.registerFileHandle(path, file, DuckDBDataProtocol.BROWSER_FILEREADER, true); }
  async registerBuffer(path, u8) { await this.db.registerFileBuffer(path, u8); }
  async dropFile(path) { try { await this.db.dropFile(path); } catch { /* ignore */ } }
  // COPY (query) TO a virtual file and return its bytes.
  async copyOut(selectSql, ext, options) {
    const path = `__export_${Date.now()}.${ext}`;
    await this.db.registerEmptyFileBuffer(path);
    try {
      await this.meta.query(`COPY (${selectSql}) TO ${quoteLiteral(path)} (${options})`);
      return await this.db.copyFileToBuffer(path);
    } finally { await this.dropFile(path); }
  }
  // Insert an Arrow result as a temp table (used to export results of non-SELECT statements).
  async arrowToTemp(result, name) { await this.meta.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`); await this.meta.insertArrowTable(result.table, { name, create: true }); }
  async globFiles(pattern) { return this.db.globFiles(pattern); }
  async copyFileToBuffer(path) { return this.db.copyFileToBuffer(path); }
  createSql(t, path) {
    const src = t.mode === 'remote' ? buildReadSql(t.url, t.format, t.opts) : buildReadSql(path, t.format, t.opts);
    const kind = t.mode === 'table' ? 'TABLE' : 'VIEW';
    return `CREATE OR REPLACE ${kind} ${quoteIdent(t.name)} AS SELECT * FROM ${src}`;
  }
}

// ---------- IndexedDB storage for imported files ----------
const DB_NAME = 'sqlplayground'; const STORE = 'files';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'name' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => { const t = d.transaction(STORE, mode); const s = t.objectStore(STORE); const out = fn(s); t.oncomplete = () => { d.close(); res(out && out.result !== undefined ? out.result : out); }; t.onerror = () => { d.close(); rej(t.error); }; t.onabort = () => { d.close(); rej(t.error || new Error('Storage aborted (quota?)')); }; });
}
export const store = {
  async list() { try { const r = await tx('readonly', (s) => s.getAll()); return (r || []).sort((a, b) => a.addedAt - b.addedAt); } catch { return []; } },
  async put(rec) { return tx('readwrite', (s) => s.put(rec)); },
  async get(name) { return tx('readonly', (s) => s.get(name)); },
  async remove(name) { return tx('readwrite', (s) => s.delete(name)); },
  async clear() { return tx('readwrite', (s) => s.clear()); },
  async estimate() { try { return await navigator.storage.estimate(); } catch { return null; } },
};

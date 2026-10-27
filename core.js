// SQLPlayground core: pure logic with no DOM or DuckDB dependency, so it runs in Node tests too.

// ---------- SQL statement splitting ----------
// Splits on top-level semicolons while respecting 'strings' (with '' escapes and E'\'' escapes),
// "quoted identifiers", -- line comments, /* nested block comments */ and $tag$dollar quotes$tag$.
export function splitStatements(sql) {
  const out = [];
  let start = 0, i = 0, hasCode = false;
  const n = sql.length;
  const push = (end) => {
    if (hasCode) {
      const raw = sql.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      out.push({ text, from: start + lead, to: start + lead + text.length });
    }
    hasCode = false;
  };
  while (i < n) {
    const c = sql[i], d = sql[i + 1];
    if (c === '-' && d === '-') { const e = sql.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c === '/' && d === '*') {
      let depth = 1; i += 2;
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      continue;
    }
    if (c === "'") {
      const esc = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z0-9_]/.test(sql[i - 2]));
      hasCode = true; i++;
      while (i < n) {
        if (esc && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"') {
      hasCode = true; i++;
      while (i < n) { if (sql[i] === '"') { if (sql[i + 1] === '"') { i += 2; continue; } i++; break; } i++; }
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m && !(i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1]))) {
        const tag = m[0]; const e = sql.indexOf(tag, i + tag.length);
        hasCode = true; i = e < 0 ? n : e + tag.length; continue;
      }
    }
    if (c === ';') { push(i); i++; start = i; continue; }
    if (!/\s/.test(c)) hasCode = true;
    i++;
  }
  push(n);
  return out;
}

// The statement under the cursor; if the cursor sits in whitespace after a statement, use that one.
export function statementAt(sql, pos) {
  const st = splitStatements(sql);
  if (!st.length) return null;
  let best = st[0];
  for (const s of st) { if (s.from <= pos) best = s; }
  // Cursor before the first statement or inside: pick the one whose range covers pos (inclusive of the trailing ';').
  for (const s of st) { if (pos >= s.from && pos <= s.to + 1) return s; }
  return best;
}

// First keyword of a statement, ignoring comments and opening parentheses.
export function firstKeyword(stmt) {
  const s = stmt.replace(/--[^\n]*\n?/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[\s(]+/, '');
  const m = /^[A-Za-z_]+/.exec(s);
  return m ? m[0].toUpperCase() : '';
}
const QUERY_KW = new Set(['SELECT', 'WITH', 'FROM', 'VALUES', 'TABLE', 'PIVOT', 'UNPIVOT']);
// True when the statement can be wrapped as COPY (<stmt>) TO ... or SELECT * FROM (<stmt>).
export function isQueryLike(stmt) { return QUERY_KW.has(firstKeyword(stmt)); }
export function stripTrailingSemicolon(s) { return s.replace(/[\s;]+$/, ''); }

// ---------- identifiers & names ----------
export function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
export function quoteLiteral(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

export function sanitizeTableName(fileName) {
  let base = String(fileName || '').replace(/^.*[\\/]/, '');
  base = base.replace(/\.(gz|zst|zstd|bz2)$/i, '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
  base = base.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  base = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  if (!base) base = 'table';
  if (/^[0-9]/.test(base)) base = 't_' + base;
  return base.slice(0, 63);
}
export function uniqueName(base, existing) {
  const has = (x) => (existing instanceof Set ? existing.has(x.toLowerCase()) : existing.map((e) => e.toLowerCase()).includes(x.toLowerCase()));
  if (!has(base)) return base;
  for (let k = 2; ; k++) { const c = `${base}_${k}`; if (!has(c)) return c; }
}
export function isValidTableName(name) { return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name); }

// ---------- file formats ----------
export function detectFormat(fileName) {
  const f = String(fileName).toLowerCase().replace(/\?.*$/, '').replace(/\.(gz|zst)$/, '');
  if (/\.parquet$|\.pq$/.test(f)) return 'parquet';
  if (/\.tsv$|\.tab$/.test(f)) return 'tsv';
  if (/\.csv$|\.txt$/.test(f)) return 'csv';
  if (/\.ndjson$|\.jsonl$/.test(f)) return 'ndjson';
  if (/\.json$/.test(f)) return 'json';
  if (/\.xlsx$/.test(f)) return 'xlsx';
  return null;
}

// SQL expression that reads a registered file. opts: {delimiter, header, autoTypes, sheet}
export function buildReadSql(path, format, opts = {}) {
  const p = quoteLiteral(path);
  if (format === 'parquet') return `read_parquet(${p})`;
  if (format === 'json') return `read_json_auto(${p})`;
  if (format === 'ndjson') return `read_json_auto(${p}, format = 'newline_delimited')`;
  if (format === 'xlsx') {
    const a = [p];
    if (opts.sheet) a.push(`sheet = ${quoteLiteral(opts.sheet)}`);
    if (opts.header === false) a.push('header = false');
    if (opts.autoTypes === false) a.push('all_varchar = true');
    return `read_xlsx(${a.join(', ')})`;
  }
  const a = [p];
  const delim = opts.delimiter && opts.delimiter !== 'auto' ? opts.delimiter : (format === 'tsv' ? '\t' : null);
  if (delim) a.push(`delim = ${quoteLiteral(delim === '\\t' ? '\t' : delim)}`);
  if (opts.header === true) a.push('header = true');
  if (opts.header === false) a.push('header = false');
  if (opts.autoTypes === false) a.push('all_varchar = true');
  return `read_csv(${a.join(', ')})`;
}

// ---------- value formatting (Arrow values -> display strings) ----------
const pad = (n, w = 2) => String(n).padStart(w, '0');
export function formatDateMs(ms) { const d = new Date(ms); return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
export function formatTimestampMs(ms, tz) {
  const d = new Date(ms);
  let s = `${formatDateMs(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const frac = ((ms % 1000) + 1000) % 1000;
  if (frac) s += '.' + pad(Math.round(frac), 3);
  return tz ? s + '+00' : s;
}
export function formatTimeMicros(us) {
  let v = typeof us === 'bigint' ? us : BigInt(Math.round(Number(us)));
  const micros = Number(v % 1000000n); v /= 1000000n;
  const sec = Number(v % 60n), min = Number((v / 60n) % 60n), hr = Number(v / 3600n);
  return `${pad(hr)}:${pad(min)}:${pad(sec)}` + (micros ? '.' + String(micros).padStart(6, '0').replace(/0+$/, '') : '');
}
// Insert a decimal point into an unscaled integer string: ("-125", 2) -> "-1.25"
export function scaleDecimal(digits, scale) {
  let s = String(digits); let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!scale) return (neg ? '-' : '') + s;
  s = s.padStart(scale + 1, '0');
  return (neg ? '-' : '') + s.slice(0, s.length - scale) + '.' + s.slice(s.length - scale);
}
export function jsonSafe(v) {
  return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? (x >= -9007199254740991n && x <= 9007199254740991n ? Number(x) : x.toString()) : x));
}
// kind: one of number,bigint,decimal,date,timestamp,time,bool,string,binary,nested,interval,other
export function formatCell(v, t = {}) {
  if (v === null || v === undefined) return null;
  switch (t.kind) {
    case 'date': return typeof v === 'number' ? formatDateMs(v) : v instanceof Date ? formatDateMs(v.getTime()) : String(v);
    case 'timestamp': return typeof v === 'number' ? formatTimestampMs(v, t.tz) : v instanceof Date ? formatTimestampMs(v.getTime(), t.tz) : String(v);
    case 'time': return formatTimeMicros(t.unit === 'ms' ? BigInt(v) * 1000n : t.unit === 's' ? BigInt(v) * 1000000n : t.unit === 'ns' ? BigInt(v) / 1000n : v);
    case 'decimal': return scaleDecimal(String(v), t.scale || 0);
    case 'binary': return v instanceof Uint8Array ? Array.from(v, (b) => (b >= 32 && b < 127 && b !== 92 ? String.fromCharCode(b) : '\\x' + b.toString(16).toUpperCase().padStart(2, '0'))).join('') : String(v);
    case 'nested': { const j = v && typeof v.toJSON === 'function' ? v.toJSON() : v; return jsonSafe(j); }
    case 'interval': return '(interval: CAST to VARCHAR to view)';
    case 'number': return Number.isInteger(v) ? String(v) : String(v);
    default: return typeof v === 'object' && v && typeof v.toJSON === 'function' ? jsonSafe(v.toJSON()) : String(v);
  }
}
// A numeric value for charts and sorting.
export function toNumber(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  const n = Number(v); return n;
}

// ---------- export formats ----------
function csvField(s, delim) {
  if (s === null || s === undefined) return '';
  s = String(s);
  return s.includes(delim) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// rows: arrays of display strings (null for SQL NULL)
export function toCSV(columns, rows, { delimiter = ',', bom = false, eol = '\n' } = {}) {
  const lines = [columns.map((c) => csvField(c, delimiter)).join(delimiter)];
  for (const r of rows) lines.push(r.map((v) => csvField(v, delimiter)).join(delimiter));
  return (bom ? '\uFEFF' : '') + lines.join(eol) + eol;
}
export function toTSV(columns, rows, header = true) {
  const f = (v) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
  const lines = rows.map((r) => r.map(f).join('\t'));
  if (header) lines.unshift(columns.map(f).join('\t'));
  return lines.join('\n');
}
export function toMarkdown(columns, rows, { nullText = 'NULL' } = {}) {
  const esc = (v) => (v === null || v === undefined ? nullText : String(v)).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const head = '| ' + columns.map(esc).join(' | ') + ' |';
  const sep = '| ' + columns.map(() => '---').join(' | ') + ' |';
  return [head, sep, ...rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |')].join('\n') + '\n';
}
// kinds: per-column 'number'|'bool'|'string'... ; values: display strings
export function toInserts(table, columns, rows, kinds = [], batch = 500) {
  if (!rows.length) return `-- no rows\n`;
  const lit = (v, k) => {
    if (v === null || v === undefined) return 'NULL';
    if ((k === 'number' || k === 'bigint' || k === 'decimal') && /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(String(v))) return String(v);
    if (k === 'bool') return String(v).toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
    return quoteLiteral(v);
  };
  const head = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES`;
  const parts = [];
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch).map((r) => '  (' + r.map((v, j) => lit(v, kinds[j])).join(', ') + ')');
    parts.push(head + '\n' + chunk.join(',\n') + ';');
  }
  return parts.join('\n') + '\n';
}

// ---------- base64url & share links ----------
export function bytesToB64url(u8) {
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8;
}
async function pipeBytes(u8, stream) {
  const res = new Response(new Blob([u8]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
// Encodes {sql, title} (query text only, never data) into a URL hash fragment.
export async function encodeShare(payload) {
  const json = JSON.stringify({ v: 1, sql: payload.sql || '', title: payload.title || undefined });
  const raw = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'function') {
    try { const z = await pipeBytes(raw, new CompressionStream('deflate-raw')); return 'z1.' + bytesToB64url(z); } catch { /* fall through */ }
  }
  return 'u1.' + bytesToB64url(raw);
}
export async function decodeShare(hash) {
  let h = String(hash || '').replace(/^#/, '');
  const m = /(?:^|&)q=([^&]+)/.exec(h); if (m) h = m[1];
  let bytes;
  if (h.startsWith('z1.')) bytes = await pipeBytes(b64urlToBytes(h.slice(3)), new DecompressionStream('deflate-raw'));
  else if (h.startsWith('u1.')) bytes = b64urlToBytes(h.slice(3));
  else return null;
  const o = JSON.parse(new TextDecoder().decode(bytes));
  if (!o || typeof o.sql !== 'string') return null;
  return { sql: o.sql, title: typeof o.title === 'string' ? o.title : '' };
}

// ---------- workspace files ----------
export const WORKSPACE_KIND = 'sqlplayground-workspace';
export function serializeWorkspace({ tabs = [], snippets = [], tables = [], settings = {} }) {
  return JSON.stringify({
    kind: WORKSPACE_KIND, version: 1, savedAt: new Date().toISOString(),
    tabs: tabs.map((t) => ({ title: String(t.title || 'Query'), sql: String(t.sql || '') })),
    snippets: snippets.map((s) => ({ name: String(s.name || 'Snippet'), sql: String(s.sql || '') })),
    tables: tables.map((t) => ({ name: t.name, fileName: t.fileName, format: t.format, opts: t.opts || {}, mode: t.mode || 'table', url: t.url || undefined, dataFile: t.dataFile || undefined })),
    settings,
  }, null, 2);
}
export function parseWorkspace(text) {
  let o; try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('Not a valid workspace file (bad JSON).'); }
  if (!o || o.kind !== WORKSPACE_KIND) throw new Error('Not a SQLPlayground workspace file.');
  if (o.version > 1) throw new Error('This workspace was saved by a newer version.');
  const tabs = (Array.isArray(o.tabs) ? o.tabs : []).filter((t) => t && typeof t.sql === 'string').map((t) => ({ title: String(t.title || 'Query').slice(0, 80), sql: t.sql }));
  const snippets = (Array.isArray(o.snippets) ? o.snippets : []).filter((s) => s && typeof s.sql === 'string').map((s) => ({ name: String(s.name || 'Snippet').slice(0, 80), sql: s.sql }));
  const tables = (Array.isArray(o.tables) ? o.tables : []).filter((t) => t && isValidTableName(t.name) && detectFormat(t.fileName || t.url || ''))
    .map((t) => ({ name: t.name, fileName: t.fileName, format: t.format || detectFormat(t.fileName), opts: t.opts || {}, mode: t.mode === 'view' ? 'view' : 'table', url: t.url, dataFile: t.dataFile }));
  return { tabs, snippets, tables, settings: o.settings && typeof o.settings === 'object' ? o.settings : {} };
}

// ---------- minimal ZIP (store, plus deflate read via injected inflater) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function makeZip(entries) {
  const enc = new TextEncoder(); const chunks = []; const central = []; let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name); const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data; const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
// Returns [{name, data: Uint8Array}]. inflateRaw(u8) -> Promise<Uint8Array> is needed for deflated entries.
export async function readZip(u8, inflateRaw) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true); const dec = new TextDecoder(); const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory.');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const dataStart = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    let data = u8.subarray(dataStart, dataStart + csize);
    if (method === 8) { if (!inflateRaw) throw new Error('Compressed zip entries are not supported here.'); data = await inflateRaw(data); } else if (method !== 0) throw new Error('Unsupported zip compression.');
    if (!name.endsWith('/')) out.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// ---------- errors ----------
// DuckDB errors look like: 'Parser Error: syntax error at or near "FRM"\n\nLINE 1: SELECT * FRM t\n                 ^'
export function parseErrorLocation(message) {
  const m = /LINE (\d+): ?(.*)\n( *)\^/.exec(String(message));
  if (m) { const prefix = `LINE ${m[1]}: `.length; return { line: Number(m[1]), col: Math.max(0, m[3].length - prefix) }; }
  const l = /LINE (\d+):/.exec(String(message));
  return l ? { line: Number(l[1]), col: null } : null;
}
export function cleanError(message) {
  return String(message || 'Unknown error').replace(/^Error: /, '').trim();
}

// ---------- misc formatting ----------
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}
export function formatDuration(ms) {
  if (ms < 1) return '<1 ms'; if (ms < 1000) return Math.round(ms) + ' ms'; if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
  return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
}
export function formatCount(n) { return Number(n).toLocaleString('en-US'); }

// "Nice" axis ticks for charts.
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { const d = Math.abs(min) || 1; min -= d / 2; max += d / 2; }
  const span = max - min; const step0 = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0))); const r = step0 / mag;
  const step = (r >= 7.5 ? 10 : r >= 3.5 ? 5 : r >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step; const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}
export function formatTick(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  return String(Number(v.toPrecision(6)));
}

// Sort comparator for mixed values: NULLs last, numbers numerically, strings with natural compare.
const collator = typeof Intl !== 'undefined' ? new Intl.Collator('en', { numeric: true, sensitivity: 'base' }) : null;
export function compareValues(a, b) {
  const an = a === null || a === undefined, bn = b === null || b === undefined;
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  if (typeof a === 'bigint' || typeof b === 'bigint') { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  const sa = String(a), sb = String(b);
  return collator ? collator.compare(sa, sb) : sa < sb ? -1 : sa > sb ? 1 : 0;
}

// Arrow type strings -> the DuckDB type names data engineers expect in the grid header.
export function duckTypeLabel(arrowLabel) {
  const s = String(arrowLabel);
  const simple = { Int8: 'TINYINT', Int16: 'SMALLINT', Int32: 'INTEGER', Int64: 'BIGINT', Uint8: 'UTINYINT', Uint16: 'USMALLINT', Uint32: 'UINTEGER', Uint64: 'UBIGINT', Float32: 'FLOAT', Float64: 'DOUBLE', Float16: 'HALF', Utf8: 'VARCHAR', LargeUtf8: 'VARCHAR', Bool: 'BOOLEAN', Binary: 'BLOB', LargeBinary: 'BLOB', Null: 'NULL' };
  if (simple[s]) return simple[s];
  let m;
  if ((m = /^Decimal\[(\d+)e([+-]?\d+)\]$/.exec(s))) return `DECIMAL(${m[1]},${Number(m[2])})`;
  if (/^Date(32|64)/.test(s)) return 'DATE';
  if ((m = /^Timestamp<\w+(, (.+))?>$/.exec(s))) return m[2] ? 'TIMESTAMPTZ' : 'TIMESTAMP';
  if (/^Time(32|64)/.test(s)) return 'TIME';
  if (/^Interval/.test(s)) return 'INTERVAL';
  if (/^List</.test(s) || /^FixedSizeList/.test(s)) return 'LIST';
  if (/^Struct</.test(s)) return 'STRUCT';
  if (/^Map</.test(s)) return 'MAP';
  if (/^Duration/.test(s)) return 'INTERVAL';
  return s.replace(/<.*$/, '').toUpperCase();
}

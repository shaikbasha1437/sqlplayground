// SQLPlayground UI. Everything runs locally: DuckDB-WASM in a Web Worker, files in IndexedDB.
import { Engine, store, DUCKDB_WASM_VERSION, isNumericKind } from './db.js';
import { Grid } from './grid.js';
import { renderChart, suggestChart } from './chart.js';
import { createEditor } from './editor.js';
import { SAMPLES, WELCOME_SQL, BUILTIN_SNIPPETS } from './samples.js';
import { formatSql } from './vendor/lib.js';
import {
  splitStatements, statementAt, isQueryLike, firstKeyword, stripTrailingSemicolon, quoteIdent, quoteLiteral, sanitizeTableName, uniqueName,
  isValidTableName, detectFormat, toMarkdown, toInserts, toTSV, encodeShare, decodeShare, serializeWorkspace, parseWorkspace, makeZip, readZip,
  parseErrorLocation, cleanError, formatBytes, formatDuration, formatCount,
} from './core.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = (k, d) => { try { const v = localStorage.getItem('sqlpg.' + k); return v ? JSON.parse(v) : d; } catch { return d; } };
const SAVE = (k, v) => { try { localStorage.setItem('sqlpg.' + k, JSON.stringify(v)); } catch { /* quota */ } };
const uid = () => Math.random().toString(36).slice(2, 9);
const SAMPLE_NAMES = new Set(SAMPLES.map((s) => s.name));
const EXT_FOR = { parquet: 'parquet', json: 'json', ndjson: 'json', xlsx: 'excel' };

const state = {
  tabs: LS('tabs', null) || [{ id: uid(), title: 'Welcome', sql: WELCOME_SQL }],
  history: LS('history', []), snippets: LS('snippets', []),
  settings: Object.assign({ theme: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark', samples: true, sideW: 270, editorH: 42, maxRows: 100000 }, LS('settings', {})),
  schema: [], stored: [], session: new Map(), result: null, resultSql: '', chart: null, rtab: 'grid', loadedExt: new Set(), engineReady: false,
};
state.active = LS('active', state.tabs[0].id); if (!state.tabs.find((t) => t.id === state.active)) state.active = state.tabs[0].id;
const engine = new Engine();
window.SQLPG = { ready: false, state, engine, version: DUCKDB_WASM_VERSION };

// ---------- small UI helpers ----------
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
async function copyText(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.append(ta); ta.select(); try { document.execCommand('copy'); } catch { /* ignore */ } ta.remove();
  }
  window.SQLPG.lastCopied = text; toast(what);
}
function download(data, name, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
function ask(title, text, value = '', validate) {
  const d = $('#promptDlg'); $('#promptTitle').textContent = title; $('#promptText').textContent = text; const inp = $('#promptInput'); inp.value = value; $('#promptErr').hidden = true;
  return new Promise((res) => {
    const onClose = () => { d.removeEventListener('close', onClose); res(d.returnValue === 'ok' ? inp.value.trim() : null); };
    d.addEventListener('close', onClose); d.returnValue = ''; d.showModal(); inp.select();
    $('#promptOk').onclick = (e) => { const err = validate && validate(inp.value.trim()); if (err) { e.preventDefault(); $('#promptErr').textContent = err; $('#promptErr').hidden = false; } };
  });
}
function setStatus(kind, text) { const p = $('#engineStatus'); p.className = 'pill ' + kind; p.lastElementChild.textContent = text; }
function themeColors() { const cs = getComputedStyle(document.documentElement); const v = (n) => cs.getPropertyValue(n).trim(); return { bg: v('--panel'), fg: v('--fg'), muted: v('--muted'), grid: v('--border') }; }
function applyTheme() { document.documentElement.dataset.theme = state.settings.theme; $('meta[name=theme-color]').content = state.settings.theme === 'dark' ? '#0f1420' : '#ffffff'; if (state.rtab === 'chart') drawChart(); }
function saveSettings() { SAVE('settings', state.settings); }
function persistTabs() { SAVE('tabs', state.tabs); SAVE('active', state.active); }
const activeTab = () => state.tabs.find((t) => t.id === state.active);

// ---------- messages ----------
let unseen = 0;
function logMsg(kind, text, sql) {
  const m = document.createElement('div'); m.className = 'msg' + (kind === 'error' ? ' bad' : '');
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  m.innerHTML = `<span class="t">${t}</span><div><div class="b">${esc(text)}</div>${sql ? `<code>${esc(sql.slice(0, 300))}</code>` : ''}</div>`;
  $('#messages').prepend(m);
  if (kind === 'error' && state.rtab !== 'messages') { unseen++; $('#msgBadge').textContent = unseen; $('#msgBadge').hidden = false; }
}

// ---------- editor & tabs ----------
const editor = createEditor($('#editor'), {
  doc: activeTab().sql,
  onRun: () => runCurrent(), onRunAll: () => runAll(), onFormat: () => formatCurrent(), onSave: () => saveSnippet(), onExplain: () => explainCurrent(false),
  onChange: (text) => { const t = activeTab(); if (t) { t.sql = text; clearTimeout(persistTabs.t); persistTabs.t = setTimeout(persistTabs, 300); } },
});
window.SQLPG.editor = editor;
function renderTabs() {
  const box = $('#qtabs');
  box.innerHTML = state.tabs.map((t) => `<div class="qtab${t.id === state.active ? ' on' : ''}" data-id="${t.id}" title="${esc(t.title)} (double-click to rename)"><span>${esc(t.title)}</span><button class="x" data-close="${t.id}" aria-label="Close tab ${esc(t.title)}">×</button></div>`).join('') + '<button class="qtab-add" id="addTab" title="New query tab" aria-label="New query tab">＋</button>';
}
function switchTab(id) { if (id === state.active) return; const old = state.active; state.active = id; editor.swap(old, id, activeTab().sql); renderTabs(); persistTabs(); }
function newTab(sql = '', title) { const t = { id: uid(), title: title || `Query ${state.tabs.length + 1}`, sql }; state.tabs.push(t); switchTab(t.id); editor.focus(); return t; }
function closeTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id); if (i < 0) return;
  editor.forget(id); state.tabs.splice(i, 1);
  if (!state.tabs.length) state.tabs.push({ id: uid(), title: 'Query 1', sql: '' });
  if (id === state.active) { state.active = state.tabs[Math.max(0, i - 1)].id; editor.swap(null, state.active, activeTab().sql); }
  renderTabs(); persistTabs();
}
$('#qtabs').addEventListener('click', (e) => {
  const x = e.target.closest('[data-close]'); if (x) { e.stopPropagation(); closeTab(x.dataset.close); return; }
  if (e.target.closest('#addTab')) { newTab(); return; }
  const t = e.target.closest('.qtab'); if (t) switchTab(t.dataset.id);
});
$('#qtabs').addEventListener('dblclick', async (e) => {
  const t = e.target.closest('.qtab'); if (!t) return; const tab = state.tabs.find((x) => x.id === t.dataset.id);
  const name = await ask('Rename tab', 'Tab name', tab.title, (v) => (!v ? 'Enter a name' : null)); if (name) { tab.title = name.slice(0, 60); renderTabs(); persistTabs(); }
});

function formatCurrent() {
  const sel = editor.selection(); const src = sel.text || editor.doc;
  try {
    const out = formatSql(src, { language: 'duckdb', keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 });
    if (sel.text) editor.view.dispatch({ changes: { from: sel.from, to: sel.to, insert: out } }); else editor.setDoc(out + '\n');
    toast('Formatted');
  } catch (e) { toast('Could not format: ' + cleanError(e.message).split('\n')[0]); }
}

// ---------- running queries ----------
const grid = new Grid($('#grid'), { onCopy: (t) => copyText(t, 'Copied cells') });
window.SQLPG.grid = grid;
let busy = false;
function setBusy(on) {
  busy = on; $('#cancelBtn').hidden = !on; $('#runBtn').disabled = on; $('#runAllBtn').disabled = on; $('#explainBtn').disabled = on; $('#analyzeBtn').disabled = on;
  setStatus(on ? 'busy' : 'ready', on ? 'Running…' : `DuckDB ${engine.version || ''}`.trim());
}
function currentStatements() {
  const doc = editor.doc; const sel = editor.selection();
  if (sel.text.trim()) return splitStatements(sel.text).map((s) => ({ ...s, from: s.from + sel.from, to: s.to + sel.from }));
  const s = statementAt(doc, sel.head); return s ? [s] : [];
}
const runCurrent = () => runStatements(currentStatements());
const runAll = () => runStatements(splitStatements(editor.doc));
async function ensureExtFor(sql) {
  const s = sql.toLowerCase(); const need = [];
  if (/parquet/.test(s)) need.push('parquet'); if (/json/.test(s)) need.push('json'); if (/xlsx|excel/.test(s)) need.push('excel');
  for (const e of need) await loadExt(e);
}
async function loadExt(name) {
  if (state.loadedExt.has(name)) return;
  try { await engine.exec(`LOAD ${name}`); state.loadedExt.add(name); } catch (e) { logMsg('error', `Could not load the ${name} extension: ${cleanError(e.message)}`); }
}
function showError(msg, st) {
  $('#gridEmpty').hidden = false; $('#grid').hidden = true;
  $('#gridEmpty').innerHTML = `<div class="err-box">${esc(msg)}</div>`;
  $('#rmeta').textContent = 'Error'; showRtab('grid');
  if (st) {
    const loc = parseErrorLocation(msg);
    if (loc) {
      const lines = st.text.split('\n'); let off = 0; for (let i = 0; i < Math.min(loc.line - 1, lines.length); i++) off += lines[i].length + 1;
      const lineText = lines[loc.line - 1] || ''; const lineFrom = st.from + off;
      const col = loc.col != null ? Math.min(loc.col, lineText.length) : 0; const word = /^[^\s,()]+/.exec(lineText.slice(col));
      editor.markError(lineFrom, lineFrom + lineText.length, lineFrom + col, lineFrom + col + (word ? word[0].length : 1));
    } else editor.markError(st.from, st.to);
  }
}
function addHistory(entry) {
  state.history.unshift(entry); if (state.history.length > 300) state.history.length = 300; SAVE('history', state.history); renderHistory();
}
async function runStatements(stmts, { explain } = {}) {
  if (!state.engineReady) { toast('The engine is still loading…'); return; }
  if (busy) return; if (!stmts.length) { toast('Nothing to run'); return; }
  editor.clearError(); setBusy(true); let last = null, lastSt = null, ddl = false;
  try {
    for (const st of stmts) {
      editor.flash(st.from, st.to);
      const kw = firstKeyword(st.text); if (!['SELECT', 'WITH', 'FROM', 'VALUES', 'TABLE', 'EXPLAIN', 'DESCRIBE', 'SHOW', 'SUMMARIZE', 'PRAGMA'].includes(kw)) ddl = true;
      const text = explain ? `EXPLAIN ${explain === 'analyze' ? 'ANALYZE ' : ''}${stripTrailingSemicolon(st.text)}` : st.text;
      try {
        await ensureExtFor(text);
        const res = await engine.run(text, { maxRows: Number(state.settings.maxRows) || 100000 });
        addHistory({ sql: st.text, at: Date.now(), ms: Math.round(res.ms), rows: res.rowCount, ok: true });
        logMsg('ok', `${res.rowCount.toLocaleString()} row${res.rowCount === 1 ? '' : 's'} in ${formatDuration(res.ms)}${res.truncated ? ' (display limit reached)' : ''}`, st.text);
        last = res; lastSt = st;
      } catch (e) {
        const msg = cleanError(e.message);
        addHistory({ sql: st.text, at: Date.now(), ok: false, error: msg.split('\n')[0] });
        logMsg('error', msg, st.text); showError(msg, msg === 'Query cancelled.' ? null : st);
        last = null; break;
      }
    }
    if (last) {
      if (explain) showPlan(last); else showResult(last, lastSt.text);
    }
  } finally { setBusy(false); if (ddl) refreshSchema(); }
  return last;
}
window.SQLPG.run = async (sql) => { const r = await runStatements(splitStatements(sql)); return r; };
async function explainCurrent(analyze) { const st = currentStatements(); if (st.length) await runStatements([st[st.length - 1]], { explain: analyze ? 'analyze' : 'plain' }); }
function showPlan(res) {
  const ki = res.columns.findIndex((c) => c.name === 'explain_value'); let text = '';
  for (let r = 0; r < res.rowCount; r++) text += (res.text(r, ki >= 0 ? ki : res.columns.length - 1) || '') + '\n';
  $('#plan').textContent = text || '(empty plan)'; showRtab('explain');
}
function showResult(res, sql) {
  state.result = res; state.resultSql = sql; window.SQLPG.result = res;
  $('#gridEmpty').hidden = res.columns.length > 0; $('#grid').hidden = !res.columns.length;
  if (!res.columns.length) $('#gridEmpty').innerHTML = '<div class="ok-box">Statement ran successfully.</div>';
  grid.setResult(res.columns.length ? res : null);
  $('#rmeta').innerHTML = `${formatCount(res.rowCount)} row${res.rowCount === 1 ? '' : 's'} · ${res.columns.length} col${res.columns.length === 1 ? '' : 's'} · ${formatDuration(res.ms)}` + (res.truncated ? ` · <span class="warn" title="Increase Max rows to keep more. Exports always use the full query.">showing first ${formatCount(res.rowCount)}</span>` : '');
  $('#exportBtn').disabled = !res.columns.length;
  state.chart = res.columns.length ? suggestChart(res) : null; buildChartControls();
  if (state.rtab === 'chart') drawChart(); else if (state.rtab !== 'grid') showRtab('grid');
}
$('#runBtn').onclick = () => runCurrent();
$('#runAllBtn').onclick = () => runAll();
$('#explainBtn').onclick = () => explainCurrent(false);
$('#analyzeBtn').onclick = () => explainCurrent(true);
$('#formatBtn').onclick = () => formatCurrent();
$('#cancelBtn').onclick = async () => {
  setStatus('busy', 'Cancelling…'); await engine.cancel();
  setTimeout(() => { if (busy && confirm('The query is still running. Restart the engine? Imported tables that are kept in this browser and the samples are reloaded automatically.')) restartEngine(); }, 4000);
};
$('#maxRows').value = String(state.settings.maxRows);
$('#maxRows').onchange = (e) => { state.settings.maxRows = Number(e.target.value); saveSettings(); };

// ---------- result tabs & chart ----------
function showRtab(t) {
  state.rtab = t; $$('.rtabs > button[data-rt]').forEach((b) => b.classList.toggle('on', b.dataset.rt === t));
  for (const p of ['grid', 'chart', 'explain', 'profile', 'messages']) $('#rp-' + p).hidden = p !== t;
  if (t === 'messages') { unseen = 0; $('#msgBadge').hidden = true; }
  if (t === 'chart') drawChart(); if (t === 'grid') grid.schedule();
}
$$('.rtabs > button[data-rt]').forEach((b) => (b.onclick = () => showRtab(b.dataset.rt)));
function buildChartControls() {
  const res = state.result; const c = state.chart;
  if (!res || !c) { $('#chX').innerHTML = ''; $('#chYs').innerHTML = ''; return; }
  $('#chType').value = c.type;
  $('#chX').innerHTML = res.columns.map((col, i) => `<option value="${i}"${i === c.x ? ' selected' : ''}>${esc(col.name)}</option>`).join('');
  $('#chYs').innerHTML = res.columns.map((col, i) => (isNumericKind(col.kind) ? `<label class="ychip"><input type="checkbox" value="${i}"${c.ys.includes(i) ? ' checked' : ''}>${esc(col.name)}</label>` : '')).join('') || '<span class="muted">no numeric columns</span>';
}
function drawChart() {
  if (!state.result || !state.chart) { renderChart($('#chart'), {}, null, themeColors()); $('#chNote').textContent = ''; return; }
  const out = renderChart($('#chart'), { ...state.chart, order: grid.order }, state.result, themeColors()); $('#chNote').textContent = out && out.note && state.result.rowCount ? out.note : '';
  window.SQLPG.chartDrawn = (window.SQLPG.chartDrawn || 0) + 1;
}
$('#chType').onchange = (e) => { state.chart.type = e.target.value; drawChart(); };
$('#chX').onchange = (e) => { state.chart.x = Number(e.target.value); drawChart(); };
$('#chYs').onchange = () => { state.chart.ys = $$('#chYs input:checked').map((i) => Number(i.value)); drawChart(); };
$('#chPng').onclick = () => $('#chart').toBlob((b) => b && download(b, 'chart.png'), 'image/png');
new ResizeObserver(() => { if (state.rtab === 'chart') drawChart(); }).observe($('#chart'));

// ---------- history & snippets ----------
function renderHistory() {
  const f = ($('#historyFilter').value || '').toLowerCase();
  const items = state.history.filter((h) => !f || h.sql.toLowerCase().includes(f)).slice(0, 150);
  $('#historyList').innerHTML = items.map((h, i) => `<div class="item" data-h="${state.history.indexOf(h)}" title="Click to open in a new tab"><code>${esc(h.sql.slice(0, 400))}</code><div class="meta"><span>${new Date(h.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>${h.ok ? `<span>${formatCount(h.rows)} rows</span><span>${formatDuration(h.ms)}</span>` : `<span class="bad">${esc(h.error || 'error')}</span>`}</div></div>`).join('') || '<p class="muted pad small">Queries you run show up here.</p>';
}
$('#historyFilter').oninput = renderHistory;
$('#historyList').onclick = (e) => { const it = e.target.closest('[data-h]'); if (it) newTab(state.history[+it.dataset.h].sql, 'From history'); };
$('#clearHistory').onclick = () => { if (confirm('Clear query history?')) { state.history = []; SAVE('history', []); renderHistory(); } };
function renderSnippets() {
  const mine = state.snippets.map((s, i) => `<div class="item" data-s="${i}" title="Click to insert at the cursor"><div class="name">${esc(s.name)}<button class="x" data-del="${i}" aria-label="Delete snippet ${esc(s.name)}">✕</button></div><code>${esc(s.sql.slice(0, 300))}</code></div>`).join('');
  const builtin = BUILTIN_SNIPPETS.map((s, i) => `<div class="item" data-b="${i}" title="Click to insert at the cursor"><div class="name">${esc(s.name)}</div><code>${esc(s.sql.slice(0, 200))}</code></div>`).join('');
  $('#snippetList').innerHTML = (mine ? '<div class="group-h">My snippets</div>' + mine : '') + '<div class="group-h">DuckDB recipes</div>' + builtin;
}
$('#snippetList').onclick = (e) => {
  const d = e.target.closest('[data-del]'); if (d) { e.stopPropagation(); state.snippets.splice(+d.dataset.del, 1); SAVE('snippets', state.snippets); renderSnippets(); return; }
  const s = e.target.closest('[data-s]'); const b = e.target.closest('[data-b]');
  const sn = s ? state.snippets[+s.dataset.s] : b ? BUILTIN_SNIPPETS[+b.dataset.b] : null; if (!sn) return;
  const doc = editor.doc; const pre = doc && !/\n\s*$/.test(doc.slice(0, editor.selection().from)) && editor.selection().from > 0 ? '\n\n' : '';
  editor.insert(pre + sn.sql + '\n'); closeSidebarMobile();
};
async function saveSnippet() {
  const sel = editor.selection(); const sql = (sel.text || (statementAt(editor.doc, sel.head) || {}).text || '').trim();
  if (!sql) { toast('Write a query first'); return; }
  const name = await ask('Save snippet', 'Name for this snippet', activeTab().title, (v) => (!v ? 'Enter a name' : null)); if (!name) return;
  state.snippets.unshift({ name, sql }); SAVE('snippets', state.snippets); renderSnippets(); showSide('snippets'); toast('Snippet saved');
}
$('#saveSnippetBtn').onclick = saveSnippet;

// ---------- schema browser ----------
const openTables = new Set();
async function refreshSchema() {
  if (!state.engineReady) return;
  try {
    const cols = await engine.rows(`SELECT c.table_name, t.table_type, c.column_name, c.data_type FROM information_schema.columns c JOIN information_schema.tables t USING (table_catalog, table_schema, table_name) WHERE c.table_schema = 'main' AND c.table_catalog = current_database() ORDER BY c.table_name, c.ordinal_position`);
    const sizes = new Map((await engine.rows(`SELECT table_name, estimated_size::BIGINT AS n FROM duckdb_tables() WHERE schema_name = 'main' AND database_name = current_database()`)).map((r) => [r.table_name, Number(r.n)]));
    const map = new Map();
    for (const r of cols) { if (r.table_name.startsWith('__sqlpg')) continue; if (!map.has(r.table_name)) map.set(r.table_name, { name: r.table_name, type: r.table_type === 'VIEW' ? 'view' : 'table', rows: sizes.get(r.table_name), columns: [] }); map.get(r.table_name).columns.push({ name: r.column_name, type: r.data_type }); }
    state.schema = [...map.values()];
  } catch (e) { logMsg('error', 'Could not read schema: ' + cleanError(e.message)); }
  renderSchema();
  const sc = {}; for (const t of state.schema) sc[t.name] = t.columns.map((c) => ({ label: c.name, type: 'property', detail: c.type }));
  editor.setSchema(sc);
  window.SQLPG.schema = state.schema;
}
function sourceOf(name) { return state.stored.find((s) => s.name === name) || state.session.get(name); }
function renderSchema() {
  const f = ($('#tableFilter').value || '').toLowerCase();
  const groups = { data: [], samples: [], memory: [] };
  for (const t of state.schema) {
    const match = !f || t.name.toLowerCase().includes(f) || t.columns.some((c) => c.name.toLowerCase().includes(f)); if (!match) continue;
    const src = sourceOf(t.name); (src ? groups.data : SAMPLE_NAMES.has(t.name) ? groups.samples : groups.memory).push(t);
  }
  const row = (t) => {
    const src = sourceOf(t.name); const tag = src ? (src.mode === 'remote' ? 'remote' : src.format) + (src.mode === 'view' ? ' · view' : '') : t.type;
    const cols = t.columns.filter((c) => !f || t.name.toLowerCase().includes(f) || c.name.toLowerCase().includes(f));
    const keepBtn = !src && !SAMPLE_NAMES.has(t.name) && t.type === 'table' ? '<button data-a="keep" title="Save this table in the browser so it survives a reload">Keep</button>' : '';
    return `<div class="tbl${openTables.has(t.name) || f ? ' open' : ''}" data-t="${esc(t.name)}">
      <div class="tbl-row" data-a="toggle"><span class="caret">▸</span><span class="tname" title="${esc(t.name)}">${esc(t.name)}</span><span class="tag">${esc(tag)}</span><span class="tmeta">${t.rows != null && t.type === 'table' ? formatCount(t.rows) + ' rows' : ''}</span></div>
      <div class="acts"><button data-a="preview">Preview</button><button data-a="profile">Profile</button><button data-a="describe">Describe</button><button data-a="insert">Insert name</button><button data-a="rename">Rename</button>${keepBtn}<button data-a="drop" class="del">Remove</button></div>
      <div class="cols">${cols.map((c) => `<div class="col" data-col="${esc(c.name)}" title="Insert column name"><span>${esc(c.name)}</span><span class="ct">${esc(c.type)}</span></div>`).join('')}</div></div>`;
  };
  let html = '';
  if (groups.data.length) html += '<div class="group-h">Your data</div>' + groups.data.map(row).join('');
  if (groups.memory.length) html += '<div class="group-h" title="Created with SQL. Gone after reload unless you click Keep.">In memory</div>' + groups.memory.map(row).join('');
  if (groups.samples.length) html += '<div class="group-h">Sample datasets</div>' + groups.samples.map(row).join('');
  if (!html) html = f ? '<p class="hint">No matches.</p>' : '<p class="hint">No tables yet. Click <b>＋ Add data</b> or drop CSV, Parquet, JSON or Excel files anywhere.</p>';
  $('#tableList').innerHTML = html;
  renderStorage();
}
async function renderStorage() {
  const total = state.stored.reduce((a, s) => a + (s.size || 0), 0); const est = await store.estimate();
  $('#storageInfo').innerHTML = `${state.stored.length} file${state.stored.length === 1 ? '' : 's'} kept in this browser · ${formatBytes(total)}` + (est && est.quota ? ` · ${formatBytes(est.quota - est.usage)} free` : '');
}
$('#tableFilter').oninput = renderSchema;
$('#tableList').addEventListener('click', async (e) => {
  const tEl = e.target.closest('.tbl'); if (!tEl) return; const name = tEl.dataset.t; const q = quoteIdent(name);
  const col = e.target.closest('[data-col]'); if (col) { const c = col.dataset.col; editor.insert(/^[a-z_][a-z0-9_]*$/.test(c) ? c : quoteIdent(c)); return; }
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (a === 'toggle') { openTables.has(name) ? openTables.delete(name) : openTables.add(name); tEl.classList.toggle('open'); return; }
  closeSidebarMobile();
  if (a === 'preview') { await runSqlInTab(`SELECT * FROM ${/^[a-z_][a-z0-9_]*$/.test(name) ? name : q} LIMIT 100;`); }
  else if (a === 'describe') { await runSqlInTab(`DESCRIBE ${q};`); }
  else if (a === 'insert') editor.insert(/^[a-z_][a-z0-9_]*$/.test(name) ? name : q);
  else if (a === 'profile') profileTable(name);
  else if (a === 'rename') renameTable(name);
  else if (a === 'drop') dropTable(name);
  else if (a === 'keep') keepTable(name);
});
// Put a quick query at the end of the current tab and run it.
async function runSqlInTab(sql) {
  const doc = editor.doc; const sep = doc.trim() ? (doc.endsWith('\n') ? '\n' : '\n\n') : '';
  editor.view.dispatch({ changes: { from: doc.length, insert: sep + sql }, selection: { anchor: doc.length + sep.length + 1 }, scrollIntoView: true });
  const st = splitStatements(editor.doc); return runStatements([st[st.length - 1]]);
}
async function renameTable(name) {
  const existing = new Set(state.schema.map((t) => t.name.toLowerCase()));
  const nn = await ask('Rename table', `New name for ${name}`, name, (v) => (!isValidTableName(v) ? 'Use letters, digits and _ (not starting with a digit).' : v.toLowerCase() !== name.toLowerCase() && existing.has(v.toLowerCase()) ? 'A table with that name exists.' : null));
  if (!nn || nn === name) return;
  const t = state.schema.find((x) => x.name === name);
  try {
    await engine.exec(`ALTER ${t && t.type === 'view' ? 'VIEW' : 'TABLE'} ${quoteIdent(name)} RENAME TO ${quoteIdent(nn)}`);
    const rec = state.stored.find((s) => s.name === name);
    if (rec) { const full = await store.get(name); await store.remove(name); full.name = nn; await store.put(full); rec.name = nn; }
    if (state.session.has(name)) { state.session.set(nn, { ...state.session.get(name), name: nn }); state.session.delete(name); }
    toast(`Renamed to ${nn}`);
  } catch (e) { toast(cleanError(e.message).split('\n')[0]); }
  refreshSchema();
}
async function dropTable(name) {
  const rec = state.stored.find((s) => s.name === name);
  if (!confirm(`Remove ${name}?${rec ? ' Its saved file is deleted from this browser too.' : ''}`)) return;
  const t = state.schema.find((x) => x.name === name);
  try { await engine.exec(`DROP ${t && t.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS ${quoteIdent(name)}`); } catch (e) { logMsg('error', cleanError(e.message)); }
  if (rec) { await store.remove(name); state.stored = state.stored.filter((s) => s !== rec); if (rec.path) await engine.dropFile(rec.path); }
  state.session.delete(name);
  if (SAMPLE_NAMES.has(name)) { state.settings.samples = false; saveSettings(); }
  refreshSchema(); toast(`Removed ${name}`);
}
async function keepTable(name) {
  try {
    await loadExt('parquet');
    const buf = await engine.copyOut(`SELECT * FROM ${quoteIdent(name)}`, 'parquet', 'FORMAT parquet, COMPRESSION zstd');
    const blob = new Blob([buf]); const rec = { name, fileName: name + '.parquet', format: 'parquet', opts: {}, mode: 'table', size: blob.size, addedAt: Date.now(), blob };
    await store.put(rec); const { blob: _b, ...meta } = rec; state.stored.push(meta); refreshSchema(); toast(`${name} will be kept after reload (${formatBytes(blob.size)})`);
  } catch (e) { toast('Could not save: ' + cleanError(e.message).split('\n')[0]); }
}

// ---------- profiling ----------
async function profileTable(name) {
  const box = $('#profile'); showRtab('profile'); const q = quoteIdent(name);
  box.innerHTML = `<div class="phead"><h3>${esc(name)}</h3><span class="muted">profiling…</span></div>`;
  let summ;
  try { summ = await engine.rows(`SUMMARIZE ${q}`); } catch (e) { box.innerHTML = `<div class="err-box">${esc(cleanError(e.message))}</div>`; return; }
  const total = summ.length ? Number(summ[0].count) : 0;
  box.innerHTML = `<div class="phead"><h3>${esc(name)}</h3><span class="muted">${formatCount(total)} rows · ${summ.length} columns</span></div>`;
  const NUMT = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|REAL|DECIMAL)/i; const TIMET = /^(DATE|TIMESTAMP)/i;
  for (const [k, s] of summ.entries()) {
    const nullPct = Number(s.null_percentage) || 0; const card = document.createElement('div'); card.className = 'pcard';
    const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? formatCount(v) : v.toPrecision(6).replace(/\.?0+$/, '')) : esc(String(v).slice(0, 40)));
    card.innerHTML = `<h4>${esc(s.column_name)}<small>${esc(s.column_type)}</small></h4>
      <dl><dt>nulls</dt><dd>${nullPct.toFixed(1)}%</dd><dt>distinct ≈</dt><dd>${fmt(Number(s.approx_unique))}</dd><dt>min</dt><dd title="${esc(s.min)}">${fmt(s.min)}</dd><dt>max</dt><dd title="${esc(s.max)}">${fmt(s.max)}</dd>${s.avg != null ? `<dt>avg</dt><dd>${fmt(Number(s.avg))}</dd>` : ''}${s.q50 != null && NUMT.test(s.column_type) ? `<dt>median</dt><dd>${fmt(Number(s.q50))}</dd>` : ''}</dl>
      <div class="nullbar" title="null share"><i style="width:${nullPct}%"></i></div><div class="viz"></div>`;
    box.append(card);
    if (k >= 60) continue;
    const c = quoteIdent(s.column_name); const viz = card.querySelector('.viz');
    try {
      if (NUMT.test(s.column_type) || TIMET.test(s.column_type)) {
        const x = TIMET.test(s.column_type) ? `epoch(${c})` : `${c}::DOUBLE`;
        const h = await engine.rows(`WITH b AS (SELECT min(${x}) lo, max(${x}) hi FROM ${q}) SELECT least(floor((${x} - lo) / nullif((hi - lo) / 24, 0)), 23)::INT AS bin, count(*)::INT AS n FROM ${q}, b WHERE ${c} IS NOT NULL GROUP BY 1 ORDER BY 1`);
        const bins = new Array(24).fill(0); for (const r of h) bins[r.bin ?? 0] += r.n; const mx = Math.max(...bins, 1);
        viz.innerHTML = `<div class="hist" title="distribution">${bins.map((b) => `<i style="height:${(b / mx) * 100}%" title="${formatCount(b)}"></i>`).join('')}</div>`;
      } else if (!/^(STRUCT|MAP|BLOB)|\[\]$/i.test(s.column_type)) {
        const top = await engine.rows(`SELECT ${c}::VARCHAR AS v, count(*)::INT AS n FROM ${q} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`); const mx = Math.max(...top.map((t) => t.n), 1);
        viz.innerHTML = `<div class="topv">${top.map((t) => `<div><span title="${esc(t.v)}">${t.v === null ? '<i>NULL</i>' : esc(t.v)}</span><b style="width:${Math.max(4, (t.n / mx) * 70)}px"></b><small>${formatCount(t.n)}</small></div>`).join('')}</div>`;
      }
    } catch { /* skip viz */ }
  }
  window.SQLPG.profiled = name;
}

// ---------- importing data ----------
let pending = [];
const normOpts = (o) => ({ delimiter: o.delimiter === 'auto' ? undefined : o.delimiter, header: o.header === 'yes' ? true : o.header === 'no' ? false : undefined, autoTypes: o.autoTypes, sheet: o.sheet || undefined });
function takenNames(except) { const s = new Set(state.schema.map((t) => t.name.toLowerCase())); for (const p of pending) if (p !== except) s.add(p.name.toLowerCase()); return s; }
function addPending(item) {
  item.id = uid(); item.opts = Object.assign({ delimiter: 'auto', header: 'auto', autoTypes: true, sheet: '' }, item.opts || {});
  item.name = uniqueName(sanitizeTableName(item.fileName), takenNames(item)); pending.push(item); renderPending();
}
function openImport(files) {
  const d = $('#importDlg'); if (!d.open) { pending = []; d.returnValue = ''; d.showModal(); }
  for (const f of files || []) addPending({ file: f, fileName: f.name, format: detectFormat(f.name) || 'csv', mode: 'table', size: f.size });
  renderPending();
}
function renderPending() {
  const box = $('#importList');
  box.innerHTML = pending.map((p) => {
    const isCsv = p.format === 'csv' || p.format === 'tsv';
    return `<div class="imp" data-id="${p.id}">
      <div class="fname">📄 <b title="${esc(p.url || p.fileName)}">${esc(p.url || p.fileName)}</b><span class="muted small">${p.mode === 'remote' ? 'remote' : formatBytes(p.size)}</span><button type="button" class="x" data-rm aria-label="Remove ${esc(p.fileName)} from the list">✕</button></div>
      <label>Table name<input data-f="name" value="${esc(p.name)}" spellcheck="false" aria-label="Table name for ${esc(p.fileName)}"></label>
      <label>Format<select data-f="format">${['csv', 'tsv', 'parquet', 'json', 'ndjson', 'xlsx'].map((f) => `<option${f === p.format ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
      <label>Load as<select data-f="mode">${p.mode === 'remote' ? '<option value="remote" selected>View over URL</option>' : `<option value="table"${p.mode === 'table' ? ' selected' : ''}>Table (fastest queries)</option><option value="view"${p.mode === 'view' ? ' selected' : ''}>View (less memory)</option>`}</select></label>
      <div class="opts">${isCsv ? `<label>Delimiter <select data-o="delimiter">${[['auto', 'auto'], [',', ', comma'], [';', '; semicolon'], ['\\t', 'tab'], ['|', '| pipe']].map(([v, l]) => `<option value="${esc(v)}"${p.opts.delimiter === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
        ${isCsv || p.format === 'xlsx' ? `<label>Header <select data-o="header">${['auto', 'yes', 'no'].filter((v) => p.format !== 'xlsx' || v !== 'auto' || true).map((v) => `<option${p.opts.header === v ? ' selected' : ''}>${v}</option>`).join('')}</select></label><label><input type="checkbox" data-o="autoTypes"${p.opts.autoTypes ? ' checked' : ''}> Detect column types</label>` : ''}
        ${p.format === 'xlsx' ? `<label>Sheet <input type="text" data-o="sheet" value="${esc(p.opts.sheet)}" placeholder="first sheet" size="12"></label>` : ''}
        ${state.schema.some((t) => t.name.toLowerCase() === p.name.toLowerCase()) ? '<span class="small" style="color:var(--warn)">replaces the existing table</span>' : ''}</div>
      <div class="status${p.statusKind ? ' ' + p.statusKind : ''}">${esc(p.status || '')}</div></div>`;
  }).join('') || '<p class="muted small">No files selected yet.</p>';
  $('#importGo').disabled = !pending.length;
  $('#importGo').textContent = pending.length > 1 ? `Import ${pending.length} files` : 'Import';
}
$('#importList').addEventListener('input', (e) => {
  const el = e.target; const p = pending.find((x) => x.id === el.closest('.imp').dataset.id); if (!p) return;
  if (el.dataset.f === 'name') { p.name = el.value.trim(); el.classList.toggle('invalid', !isValidTableName(p.name)); return; }
  if (el.dataset.f) { p[el.dataset.f] = el.value; renderPending(); return; }
  if (el.dataset.o) { p.opts[el.dataset.o] = el.type === 'checkbox' ? el.checked : el.value; }
});
$('#importList').addEventListener('click', (e) => { const rm = e.target.closest('[data-rm]'); if (rm) { pending = pending.filter((x) => x.id !== rm.closest('.imp').dataset.id); renderPending(); } });
$('#addDataBtn').onclick = () => openImport([]);
$('#pickFilesBtn').onclick = () => $('#filePicker').click();
$('#filePicker').onchange = (e) => { openImport([...e.target.files]); e.target.value = ''; };
$('#importGo').onclick = async (e) => {
  e.preventDefault(); if (!state.engineReady) { toast('The engine is still loading…'); return; }
  const persist = $('#persistChk').checked; let okCount = 0; let lastName = null;
  for (const p of pending) { if (!isValidTableName(p.name)) { p.status = 'Table names use letters, digits and _ and cannot start with a digit.'; p.statusKind = 'bad'; } }
  if (pending.some((p) => p.statusKind === 'bad' && !p.done)) { renderPending(); return; }
  $('#importGo').disabled = true;
  for (const p of pending) {
    if (p.done) continue;
    p.status = 'Importing…'; p.statusKind = ''; renderPending();
    try { const n = await importOne(p, persist); p.status = `✓ ${p.name}: ${n === null ? 'view created' : formatCount(n) + ' rows'}`; p.statusKind = 'good'; p.done = true; okCount++; lastName = p.name; }
    catch (err) { p.status = cleanError(err.message); p.statusKind = 'bad'; }
    renderPending();
  }
  await refreshSchema();
  if (pending.every((p) => p.done)) {
    $('#importDlg').close(); toast(`Imported ${okCount} table${okCount === 1 ? '' : 's'}`);
    if (lastName) { openTables.add(lastName); renderSchema(); await runSqlInTab(`SELECT * FROM ${/^[a-z_][a-z0-9_]*$/.test(lastName) ? lastName : quoteIdent(lastName)} LIMIT 100;`); }
  } else $('#importGo').disabled = false;
};
async function importOne(p, persist) {
  const path = `data/${p.name}/${p.fileName.replace(/[^\w.\-]+/g, '_')}`;
  const t = { name: p.name, fileName: p.fileName, format: p.format, opts: normOpts(p.opts), mode: p.mode, url: p.url };
  if (p.mode !== 'remote') await engine.registerFile(path, p.file);
  if (EXT_FOR[p.format]) await loadExt(EXT_FOR[p.format]);
  try { await engine.exec(engine.createSql(t, path)); }
  catch (e) { if (p.mode !== 'remote') await engine.dropFile(path); throw e; }
  const n = p.mode === 'table' ? Number((await engine.rows(`SELECT count(*)::BIGINT AS n FROM ${quoteIdent(p.name)}`))[0].n) : null;
  const meta = { ...t, size: p.mode === 'remote' ? 0 : p.file.size, addedAt: Date.now(), path };
  if (persist) {
    try { await store.put({ ...meta, blob: p.mode === 'remote' ? null : p.file }); state.stored = state.stored.filter((s) => s.name !== p.name); state.stored.push(meta); state.session.delete(p.name); }
    catch (e) { state.session.set(p.name, meta); logMsg('error', `${p.name} was imported but could not be saved in the browser (${cleanError(e.message)}). It will be gone after reload.`); }
  } else state.session.set(p.name, meta);
  return n;
}
// Load from URL
$('#urlAddBtn').onclick = async () => {
  const url = $('#urlInput').value.trim(); const mode = $('#urlMode').value;
  if (!/^https?:\/\//i.test(url)) { toast('Enter an http(s) URL'); return; }
  const fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'data') || 'data'; const format = detectFormat(fileName) || 'csv';
  if (mode === 'remote') { addPending({ url, fileName, format, mode: 'remote', size: 0 }); $('#urlInput').value = ''; return; }
  const btn = $('#urlAddBtn'); btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    const res = await fetch(url, { mode: 'cors' }); if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText}.`);
    const total = Number(res.headers.get('content-length')) || 0; const reader = res.body.getReader(); const parts = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; btn.textContent = total ? `${Math.round((got / total) * 100)}%` : formatBytes(got); }
    const file = new File(parts, fileName); addPending({ file, fileName, format, mode: 'table', size: file.size, url }); $('#urlInput').value = '';
  } catch (e) {
    const msg = e instanceof TypeError ? 'Could not download that file. Either the server does not allow other websites to read it (no CORS headers) or it is unreachable. Try a direct link to the file, a host with CORS enabled, or download it and drop it here.' : cleanError(e.message);
    toast(msg, 7000); logMsg('error', msg, url);
  } finally { btn.disabled = false; btn.textContent = 'Add'; }
};
// drag & drop anywhere
let dragDepth = 0;
addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('#dropOverlay').hidden = false; e.preventDefault(); } });
addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return; e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  const files = [...e.dataTransfer.files]; const ws = files.find((f) => /\.zip$/i.test(f.name) || /workspace.*\.json$/i.test(f.name));
  if (ws && files.length === 1 && /\.zip$/i.test(ws.name)) { openWorkspace(ws); return; }
  openImport(files);
});

// restore files kept in IndexedDB
async function restoreStored() {
  const recs = await store.list(); state.stored = [];
  for (const r of recs) {
    const path = `data/${r.name}/${(r.fileName || 'file').replace(/[^\w.\-]+/g, '_')}`;
    try {
      if (r.mode !== 'remote') { if (!r.blob) throw new Error('saved file is missing'); await engine.registerFile(path, r.blob instanceof File ? r.blob : new File([r.blob], r.fileName)); }
      if (EXT_FOR[r.format]) await loadExt(EXT_FOR[r.format]);
      await engine.exec(engine.createSql(r, path));
    } catch (e) { logMsg('error', `Could not restore ${r.name}: ${cleanError(e.message)}`); }
    const { blob, ...meta } = r; state.stored.push({ ...meta, path });
  }
}
async function loadSamples() {
  for (const s of SAMPLES) { if (state.stored.some((r) => r.name === s.name)) continue; try { await engine.exec(s.sql); } catch (e) { logMsg('error', `Sample ${s.name}: ${cleanError(e.message)}`); } }
}

// ---------- exporting results ----------
async function resultSource() {
  const sql = stripTrailingSemicolon(state.resultSql || '');
  if (sql && isQueryLike(sql)) return sql; // re-run the full query, so exports are never cut at the display limit
  await engine.arrowToTemp(state.result, '__sqlpg_result'); return 'SELECT * FROM __sqlpg_result';
}
const baseName = () => (activeTab()?.title || 'result').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'result';
// The wasm excel writer can emit a stray byte before the zip header; zip offsets are relative to 'PK', so trim it.
function fixZipStart(u8) { for (let i = 0; i < Math.min(64, u8.length - 3); i++) if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 3 && u8[i + 3] === 4) return i ? u8.subarray(i) : u8; return u8; }
async function exportResult(kind) {
  if (!state.result) return; const res = state.result; const cols = res.columns.map((_, i) => i); const names = res.columns.map((c) => c.name);
  try {
    if (kind === 'copy-md' || kind === 'copy-insert' || kind === 'copy-tsv') {
      const limit = 10000; const rows = res.rowsText(grid.order, cols, limit); const note = res.rowCount > limit ? ` (first ${formatCount(limit)} rows)` : '';
      if (kind === 'copy-md') return copyText(toMarkdown(names, rows), 'Copied Markdown table' + note);
      if (kind === 'copy-tsv') return copyText(toTSV(names, rows.map((r) => r.map((v) => v ?? ''))), 'Copied as TSV' + note);
      const tname = await ask('INSERT statements', 'Target table name', baseName(), (v) => (!v ? 'Enter a name' : null)); if (!tname) return;
      return copyText(toInserts(tname, names, rows, res.columns.map((c) => c.kind)), 'Copied INSERT statements' + note);
    }
    if (kind === 'save-table') {
      const existing = new Set(state.schema.map((t) => t.name.toLowerCase()));
      const name = await ask('Save result as table', 'New table name (stays in memory; use Keep to save it in the browser)', uniqueName(baseName(), existing), (v) => (!isValidTableName(v) ? 'Use letters, digits and _' : existing.has(v.toLowerCase()) ? 'That name is taken' : null));
      if (!name) return; const src = await resultSource(); await engine.exec(`CREATE TABLE ${quoteIdent(name)} AS ${src}`); await refreshSchema(); toast(`Created table ${name}`); return;
    }
    setStatus('busy', 'Exporting…'); const src = await resultSource(); let buf, ext, type;
    if (kind === 'csv' || kind === 'csv-excel') { buf = await engine.copyOut(src, 'csv', 'FORMAT csv, HEADER true'); ext = 'csv'; type = 'text/csv'; if (kind === 'csv-excel') buf = new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), buf]); }
    else if (kind === 'parquet') { await loadExt('parquet'); buf = await engine.copyOut(src, 'parquet', 'FORMAT parquet, COMPRESSION zstd'); ext = 'parquet'; }
    else if (kind === 'json') { await loadExt('json'); buf = await engine.copyOut(src, 'json', 'FORMAT json, ARRAY true'); ext = 'json'; type = 'application/json'; }
    else if (kind === 'ndjson') { await loadExt('json'); buf = await engine.copyOut(src, 'ndjson', 'FORMAT json'); ext = 'ndjson'; type = 'application/x-ndjson'; }
    else if (kind === 'xlsx') { await loadExt('excel'); buf = fixZipStart(await engine.copyOut(src, 'xlsx', 'FORMAT xlsx, HEADER true')); ext = 'xlsx'; type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
    download(buf, `${baseName()}.${ext}`, type); toast(`Exported ${ext.toUpperCase()}`);
  } catch (e) { const m = cleanError(e.message); toast('Export failed: ' + m.split('\n')[0], 6000); logMsg('error', 'Export failed: ' + m); }
  finally { setStatus('ready', `DuckDB ${engine.version}`); }
}
window.SQLPG.exportResult = exportResult;

// ---------- menus ----------
function bindMenu(btn, menu, onPick) {
  btn.addEventListener('click', (e) => { e.stopPropagation(); const open = menu.hidden; $$('.menu').forEach((m) => (m.hidden = true)); menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button')?.focus(); });
  menu.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); onPick(b); });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { menu.hidden = true; btn.focus(); } const items = $$('button', menu); const i = items.indexOf(document.activeElement); if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); } if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); } });
}
document.addEventListener('click', () => $$('.menu').forEach((m) => (m.hidden = true)));
bindMenu($('#exportBtn'), $('#exportMenu'), (b) => exportResult(b.dataset.exp));
bindMenu($('#wsBtn'), $('#wsMenu'), (b) => {
  const a = b.dataset.act;
  if (a === 'ws-save') saveWorkspace(false); else if (a === 'ws-save-data') saveWorkspace(true); else if (a === 'ws-open') $('#wsPicker').click();
  else if (a === 'db-export-zip') exportDatabase('zip');
  else if (a === 'samples') { state.settings.samples = true; saveSettings(); loadSamples().then(refreshSchema).then(() => toast('Sample datasets loaded')); }
  else if (a === 'clear-storage') clearStorage(); else if (a === 'restart') restartEngine(); else if (a === 'help') $('#helpDlg').showModal();
});

// ---------- share links ----------
$('#shareBtn').onclick = async () => {
  const sql = editor.selection().text || editor.doc; if (!sql.trim()) { toast('Write a query first'); return; }
  const enc = await encodeShare({ sql, title: activeTab().title }); const url = `${location.origin}${location.pathname}#q=${enc}`;
  $('#shareUrl').value = url; $('#shareLen').textContent = `${url.length.toLocaleString()} characters` + (url.length > 8000 ? ' · very long, some apps may cut it off' : '');
  $('#shareDlg').showModal(); $('#shareUrl').select(); window.SQLPG.shareUrl = url;
};
$('#shareCopy').onclick = () => copyText($('#shareUrl').value, 'Link copied');
async function openSharedFromHash() {
  if (!/(^#|&)q=/.test(location.hash)) return;
  try {
    const s = await decodeShare(location.hash);
    if (s) {
      const existing = state.tabs.find((t) => t.sql === s.sql);
      if (existing) switchTab(existing.id); else newTab(s.sql, s.title ? `${s.title} (shared)` : 'Shared query');
      const b = document.createElement('div'); b.className = 'banner'; b.innerHTML = '<span>Opened a shared query. Review it before running; it contains SQL only, no data.</span><button>OK</button>';
      b.querySelector('button').onclick = () => b.remove(); $('#editorArea').prepend(b);
    }
  } catch { toast('That share link looks damaged.'); }
  history.replaceState(null, '', location.pathname + location.search);
}

// ---------- workspaces ----------
async function saveWorkspace(withData) {
  const recs = withData ? await store.list() : [];
  const tables = (withData ? recs : state.stored).map((r) => ({ ...r, dataFile: withData && r.blob ? `data/${r.name}/${r.fileName}` : undefined }));
  const json = serializeWorkspace({ tabs: state.tabs, snippets: state.snippets, tables, settings: { samples: state.settings.samples } });
  const stamp = new Date().toISOString().slice(0, 10);
  if (!withData) { download(json, `sqlplayground-workspace-${stamp}.json`, 'application/json'); toast('Workspace saved (queries only)'); return; }
  const entries = [{ name: 'workspace.json', data: json }];
  for (const r of recs) if (r.blob) entries.push({ name: `data/${r.name}/${r.fileName}`, data: new Uint8Array(await r.blob.arrayBuffer()) });
  download(makeZip(entries), `sqlplayground-workspace-${stamp}.zip`); toast(`Workspace saved with ${recs.length} file${recs.length === 1 ? '' : 's'}`);
}
$('#wsPicker').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openWorkspace(f); };
async function inflateRaw(u8) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
async function openWorkspace(file) {
  try {
    let ws, files = new Map();
    if (/\.zip$/i.test(file.name)) {
      const entries = await readZip(new Uint8Array(await file.arrayBuffer()), inflateRaw); const wj = entries.find((x) => x.name === 'workspace.json');
      if (!wj) throw new Error('This zip has no workspace.json.'); ws = parseWorkspace(new TextDecoder().decode(wj.data)); for (const x of entries) files.set(x.name, x.data);
    } else ws = parseWorkspace(await file.text());
    if (!confirm(`Open this workspace? It replaces your ${state.tabs.length} query tab(s) with ${ws.tabs.length} and adds ${ws.snippets.length} snippet(s)${ws.tables.length ? ` and ${ws.tables.length} table(s)` : ''}.`)) return;
    for (const t of state.tabs) editor.forget(t.id);
    state.tabs = ws.tabs.length ? ws.tabs.map((t) => ({ id: uid(), ...t })) : [{ id: uid(), title: 'Query 1', sql: '' }];
    state.active = state.tabs[0].id; editor.swap(null, state.active, state.tabs[0].sql); renderTabs(); persistTabs();
    for (const s of ws.snippets) if (!state.snippets.some((x) => x.name === s.name && x.sql === s.sql)) state.snippets.push(s); SAVE('snippets', state.snippets); renderSnippets();
    let added = 0, skipped = [];
    for (const t of ws.tables) {
      const data = t.dataFile && files.get(t.dataFile);
      if (t.mode === 'remote' && t.url) {
        try { if (EXT_FOR[t.format]) await loadExt(EXT_FOR[t.format]); await engine.exec(engine.createSql({ ...t, mode: 'remote' }, null)); const meta = { name: t.name, fileName: t.fileName || 'remote', format: t.format, opts: t.opts || {}, mode: 'remote', url: t.url, size: 0, addedAt: Date.now() }; await store.put({ ...meta, blob: null }); state.stored = state.stored.filter((s) => s.name !== t.name); state.stored.push(meta); added++; }
        catch (e) { skipped.push(`${t.name} (${cleanError(e.message).split('\n')[0]})`); }
        continue;
      }
      if (!data) { skipped.push(t.name); continue; }
      const f = new File([data], t.fileName);
      await importOneRaw({ name: t.name, fileName: t.fileName, format: t.format, opts: t.opts, mode: t.mode === 'view' ? 'view' : 'table', file: f }).then(() => added++, (e) => skipped.push(`${t.name} (${cleanError(e.message).split('\n')[0]})`));
    }
    await refreshSchema();
    toast(`Workspace opened${added ? ` · ${added} table${added === 1 ? '' : 's'} restored` : ''}`);
    if (skipped.length) logMsg('error', `Not restored (no data in the workspace file): ${skipped.join(', ')}`);
  } catch (e) { toast(cleanError(e.message), 6000); }
}
// Workspace tables already carry DuckDB-ready opts.
async function importOneRaw(t) {
  const path = `data/${t.name}/${t.fileName.replace(/[^\w.\-]+/g, '_')}`;
  await engine.registerFile(path, t.file); if (EXT_FOR[t.format]) await loadExt(EXT_FOR[t.format]);
  await engine.exec(engine.createSql(t, path));
  const meta = { name: t.name, fileName: t.fileName, format: t.format, opts: t.opts || {}, mode: t.mode, size: t.file.size, addedAt: Date.now(), path };
  await store.put({ ...meta, blob: t.file }); state.stored = state.stored.filter((s) => s.name !== t.name); state.stored.push(meta);
}
window.SQLPG.openWorkspace = openWorkspace;

// ---------- whole-database export ----------
async function exportDatabase() {
  if (!state.engineReady) return; setStatus('busy', 'Exporting database…');
  try {
    await loadExt('parquet');
    {
      const entries = []; const ddl = [];
      for (const t of state.schema) {
        if (t.type === 'view' && sourceOf(t.name)?.mode !== 'view') { const v = await engine.rows(`SELECT sql FROM duckdb_views() WHERE view_name = ${quoteLiteral(t.name)} AND schema_name = 'main'`); if (v[0]) ddl.push(`-- view (its source files are not included)\n${v[0].sql}`); continue; }
        const buf = await engine.copyOut(`SELECT * FROM ${quoteIdent(t.name)}`, 'parquet', 'FORMAT parquet, COMPRESSION zstd');
        entries.push({ name: `${t.name}.parquet`, data: buf }); ddl.push(`CREATE TABLE ${quoteIdent(t.name)} AS SELECT * FROM read_parquet('${t.name}.parquet');`);
      }
      entries.unshift({ name: 'load.sql', data: `-- Exported from SQLPlayground ${new Date().toISOString()}\n-- Run in DuckDB from this folder:  duckdb my.db < load.sql\n${ddl.join('\n')}\n` });
      download(makeZip(entries), 'sqlplayground-database.zip'); toast(`Exported ${entries.length - 1} tables as Parquet`);
    }
  } catch (e) { const m = cleanError(e.message); toast('Database export failed: ' + m.split('\n')[0], 6000); logMsg('error', 'Database export failed: ' + m); }
  finally { setStatus('ready', `DuckDB ${engine.version}`); }
}
window.SQLPG.exportDatabase = exportDatabase;
async function clearStorage() {
  if (!state.stored.length) { toast('Nothing is saved in this browser'); return; }
  if (!confirm(`Remove all ${state.stored.length} saved table(s) from this browser? This cannot be undone.`)) return;
  for (const r of state.stored) { const t = state.schema.find((x) => x.name === r.name); await engine.exec(`DROP ${t && t.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS ${quoteIdent(r.name)}`).catch(() => {}); }
  await store.clear(); state.stored = []; refreshSchema(); toast('Saved tables removed');
}

// ---------- layout: sidebar tabs, splitters, mobile drawer, theme ----------
function showSide(which) { $$('.side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.side === which)); for (const p of ['tables', 'history', 'snippets']) $('#pane-' + p).hidden = p !== which; }
$$('.side-tabs button').forEach((b) => (b.onclick = () => showSide(b.dataset.side)));
function closeSidebarMobile() { $('#sidebar').classList.remove('open'); }
$('#sidebarToggle').onclick = (e) => { e.stopPropagation(); $('#sidebar').classList.toggle('open'); };
document.addEventListener('pointerdown', (e) => { const sb = $('#sidebar'); if (sb.classList.contains('open') && !sb.contains(e.target) && e.target !== $('#sidebarToggle') && !e.target.closest('dialog')) sb.classList.remove('open'); });
function applyLayout() { document.documentElement.style.setProperty('--side-w', state.settings.sideW + 'px'); document.documentElement.style.setProperty('--editor-h', state.settings.editorH + '%'); }
function dragSplit(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); el.classList.add('drag'); el.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(ev); const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); saveSettings(); grid.schedule(); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
}
dragSplit($('#splitV'), (ev) => { state.settings.sideW = Math.max(180, Math.min(innerWidth * 0.6, ev.clientX)); applyLayout(); });
dragSplit($('#splitH'), (ev) => { const r = $('#work').getBoundingClientRect(); state.settings.editorH = Math.max(15, Math.min(85, ((ev.clientY - r.top) / r.height) * 100)); applyLayout(); });
$('#themeBtn').onclick = () => { state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); };
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.target.closest('.cm-editor') && !e.target.closest('dialog')) { e.preventDefault(); e.shiftKey ? runAll() : runCurrent(); }
});

// ---------- engine lifecycle ----------
async function startEngine() {
  state.engineReady = false; setStatus('', 'Loading engine…');
  $('#gridEmpty').hidden = false; $('#grid').hidden = true;
  if (!$('#engineLoading')) $('#gridEmpty').innerHTML = '<div class="loading" id="engineLoading"><div class="spinner"></div><div><b id="loadTitle">Loading DuckDB engine…</b><div class="bar"><i id="loadBar"></i></div><small id="loadText"></small></div></div>';
  const bar = $('#loadBar'), txt = $('#loadText');
  try {
    await engine.init((p) => {
      if (p.phase === 'wasm') {
        if (p.total > 0 && p.loaded <= p.total) { bar.parentElement.classList.remove('indet'); bar.style.width = Math.min(100, (p.loaded / p.total) * 100) + '%'; txt.textContent = `Downloading WebAssembly · ${formatBytes(p.loaded)} of ${formatBytes(p.total)}`; }
        else { bar.parentElement.classList.add('indet'); txt.textContent = `Downloading WebAssembly · ${formatBytes(p.loaded)}`; }
      } else if (p.phase === 'open') { bar.style.width = '100%'; txt.textContent = 'Starting DuckDB…'; }
    });
    state.engineReady = true; window.SQLPG.engineVersion = engine.version;
    $('#loadTitle').textContent = 'Loading your tables…'; txt.textContent = '';
    if (!engine.restarted) {
      try { const fns = await engine.rows(`SELECT DISTINCT function_name AS f, function_type AS t FROM duckdb_functions() WHERE function_name NOT LIKE '\\_%' ESCAPE '\\' AND regexp_matches(function_name, '^[a-z_][a-z0-9_]*$') ORDER BY 1`); const seen = new Set();
        editor.fns = fns.filter((r) => !seen.has(r.f) && seen.add(r.f)).map((r) => ({ label: r.f, type: 'function', detail: r.t === 'aggregate' ? 'aggregate' : r.t === 'table' ? 'table function' : r.t === 'macro' ? 'macro' : 'function', boost: -1 }));
      } catch { /* optional */ }
    }
    await restoreStored();
    if (state.settings.samples) await loadSamples();
    await refreshSchema();
    setStatus('ready', `DuckDB ${engine.version}`); $('#helpVersion').textContent = `DuckDB ${engine.version} via @duckdb/duckdb-wasm ${DUCKDB_WASM_VERSION} (${engine.platform})`;
    $('#gridEmpty').innerHTML = `<div><p><b>Ready.</b> Press <kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> to run the statement under your cursor.</p><p class="muted small">${state.schema.length} table${state.schema.length === 1 ? '' : 's'} loaded · drop CSV, Parquet, JSON or Excel files anywhere to add your own.</p></div>`;
    window.SQLPG.ready = true; warmCache();
  } catch (e) {
    setStatus('error', 'Engine failed'); const m = cleanError(e && e.message || e);
    $('#gridEmpty').innerHTML = `<div class="err-box">DuckDB could not start in this browser.\n\n${esc(m)}\n\nTry a recent Chrome, Edge, Firefox or Safari. If you are offline, open the app once online first so the engine can be cached.</div>`;
    window.SQLPG.error = m;
  }
}
async function restartEngine() { setBusy(false); await engine.terminate(); engine.restarted = true; state.loadedExt.clear(); await startEngine(); toast('Engine restarted'); }

// ---------- service worker (offline) ----------
function warmCache() {
  if (!('serviceWorker' in navigator)) return;
  const plat = engine.platform; const urls = [engine.bundle.mainModule, engine.bundle.mainWorker, ...['parquet', 'json', 'excel'].map((e) => new URL(`ext/v1.4.3/${plat}/${e}.duckdb_extension.wasm`, location.href).href)];
  navigator.serviceWorker.ready.then((reg) => reg.active && reg.active.postMessage({ type: 'warm', urls })).catch(() => {});
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- boot ----------
applyTheme(); applyLayout(); renderTabs(); renderHistory(); renderSnippets(); renderSchema();
openSharedFromHash();
addEventListener('hashchange', openSharedFromHash);
startEngine();

// Virtualized results grid: renders only the visible rows and columns, so 100k+ rows scroll smoothly.
import { compareValues, toTSV } from './core.js';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const NUMERIC = new Set(['number', 'bigint', 'decimal']);

export class Grid {
  constructor(root, { onCopy } = {}) {
    this.root = root; this.onCopy = onCopy || (() => {});
    this.rowH = 26; this.headH = 30; this.numW = 56;
    root.classList.add('grid'); root.tabIndex = 0;
    root.innerHTML = '<div class="g-inner"><div class="g-head"></div><div class="g-rows"></div></div>';
    this.inner = root.querySelector('.g-inner'); this.head = root.querySelector('.g-head'); this.body = root.querySelector('.g-rows');
    this.result = null; this.order = null; this.sort = null; this.widths = []; this.sel = null;
    root.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(root);
    this.head.addEventListener('mousedown', (e) => this.onHeadDown(e));
    this.head.addEventListener('dblclick', (e) => { const h = e.target.closest('.g-rs'); if (h) this.autoFit(+h.dataset.c); });
    this.body.addEventListener('mousedown', (e) => this.onCellDown(e));
    root.addEventListener('keydown', (e) => this.onKey(e));
  }
  setResult(result) {
    this.result = result; this.order = null; this.sort = null; this.sel = null;
    const n = result ? result.columns.length : 0;
    this.widths = []; for (let c = 0; c < n; c++) this.widths.push(this.measure(c));
    this.root.scrollTop = 0; this.root.scrollLeft = 0; this.layout(); this.render();
  }
  measure(c) {
    const col = this.result.columns[c]; let w = Math.max(col.name.length * 8 + 40, 60);
    const n = Math.min(this.result.rowCount, 200);
    for (let r = 0; r < n; r++) { const t = this.result.text(r, c); if (t) w = Math.max(w, Math.min(t.length, 60) * 7.4 + 20); }
    return Math.min(Math.round(w), 420);
  }
  autoFit(c) { const t = this.result; let w = 60; const n = Math.min(t.rowCount, 2000); for (let i = 0; i < n; i++) { const s = t.text(this.order ? this.order[i] : i, c); if (s) w = Math.max(w, s.length * 7.4 + 20); } this.widths[c] = Math.min(Math.round(Math.max(w, t.columns[c].name.length * 8 + 40)), 800); this.layout(); this.render(); }
  layout() {
    this.offsets = [this.numW]; for (const w of this.widths) this.offsets.push(this.offsets[this.offsets.length - 1] + w);
    const total = this.offsets[this.offsets.length - 1]; const rows = this.result ? this.result.rowCount : 0;
    this.inner.style.width = total + 'px'; this.inner.style.height = this.headH + rows * this.rowH + 'px';
  }
  schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }
  visibleCols() {
    const L = this.root.scrollLeft, R = L + this.root.clientWidth; const o = this.offsets; let a = 0, b = this.widths.length - 1;
    while (a < this.widths.length && o[a + 1] < L + this.numW) a++;
    for (let c = a; c < this.widths.length; c++) { if (o[c] > R) { b = c - 1; break; } }
    return [Math.max(0, a - 1), Math.min(this.widths.length - 1, b + 1)];
  }
  render() {
    const t = this.result; if (!t) { this.head.innerHTML = ''; this.body.innerHTML = ''; return; }
    const [c0, c1] = this.visibleCols(); const o = this.offsets;
    let h = `<div class="g-hc g-num" style="left:${this.root.scrollLeft}px;width:${this.numW}px">#</div>`;
    for (let c = c0; c <= c1; c++) {
      const col = t.columns[c]; const s = this.sort && this.sort.c === c ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : '';
      h += `<div class="g-hc${NUMERIC.has(col.kind) ? ' r' : ''}" data-c="${c}" style="left:${o[c]}px;width:${this.widths[c]}px" title="${esc(col.name)} · ${esc(col.label)}"><span class="g-hn">${esc(col.name)}${s}</span><span class="g-ht">${esc(col.label)}</span><span class="g-rs" data-c="${c}"></span></div>`;
    }
    this.head.innerHTML = h; this.head.style.width = this.inner.style.width;
    const top = this.root.scrollTop; const viewH = this.root.clientHeight;
    const r0 = Math.max(0, Math.floor((top) / this.rowH) - 4); const r1 = Math.min(t.rowCount - 1, Math.ceil((top + viewH) / this.rowH) + 4);
    const sel = this.selRange(); let b = '';
    for (let i = r0; i <= r1; i++) {
      const r = this.order ? this.order[i] : i; const y = this.headH + i * this.rowH;
      b += `<div class="g-c g-num" data-row="${i}" style="top:${y}px;left:${this.root.scrollLeft}px;width:${this.numW}px">${i + 1}</div>`;
      for (let c = c0; c <= c1; c++) {
        const v = t.text(r, c); const col = t.columns[c];
        const on = sel && i >= sel.r0 && i <= sel.r1 && c >= sel.c0 && c <= sel.c1;
        const cls = 'g-c' + (NUMERIC.has(col.kind) ? ' r' : '') + (v === null ? ' null' : '') + (on ? ' sel' : '') + (i % 2 ? ' odd' : '');
        const disp = v === null ? 'NULL' : v.length > 300 ? v.slice(0, 300) + '…' : v;
        b += `<div class="${cls}" data-i="${i}" data-c="${c}" style="top:${y}px;left:${o[c]}px;width:${this.widths[c]}px">${esc(disp)}</div>`;
      }
    }
    this.body.innerHTML = b;
  }
  selRange() { const s = this.sel; if (!s) return null; return { r0: Math.min(s.a.i, s.b.i), r1: Math.max(s.a.i, s.b.i), c0: Math.min(s.a.c, s.b.c), c1: Math.max(s.a.c, s.b.c) }; }
  onCellDown(e) {
    const el = e.target.closest('.g-c'); if (!el) return;
    if (el.dataset.row !== undefined) { const i = +el.dataset.row; this.sel = { a: { i, c: 0 }, b: { i, c: this.widths.length - 1 } }; this.root.focus({ preventScroll: true }); this.render(); return; }
    const p = { i: +el.dataset.i, c: +el.dataset.c };
    if (e.shiftKey && this.sel) this.sel.b = p; else this.sel = { a: p, b: { ...p } };
    this.root.focus({ preventScroll: true }); this.render();
    const move = (ev) => { const t = document.elementFromPoint(ev.clientX, ev.clientY); const c = t && t.closest && t.closest('.g-c[data-c]'); if (c && this.root.contains(c)) { this.sel.b = { i: +c.dataset.i, c: +c.dataset.c }; this.schedule(); } };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }
  onHeadDown(e) {
    const rs = e.target.closest('.g-rs');
    if (rs) {
      e.preventDefault(); const c = +rs.dataset.c; const x0 = e.clientX; const w0 = this.widths[c];
      const move = (ev) => { this.widths[c] = Math.max(40, w0 + ev.clientX - x0); this.layout(); this.schedule(); };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move); addEventListener('mouseup', up); return;
    }
    const hc = e.target.closest('.g-hc[data-c]'); if (!hc) return;
    if (e.detail > 1) return;
    this.sortBy(+hc.dataset.c);
  }
  sortBy(c, dir) {
    const t = this.result; if (!t) return;
    if (dir === undefined) dir = this.sort && this.sort.c === c ? (this.sort.dir > 0 ? -1 : 0) : 1;
    if (!dir) { this.sort = null; this.order = null; this.render(); return; }
    const col = t.columns[c]; const n = t.rowCount; const keys = new Array(n);
    for (let r = 0; r < n; r++) keys[r] = NUMERIC.has(col.kind) || col.kind === 'date' || col.kind === 'timestamp' ? (t.raw(r, c) === null ? null : t.num(r, c)) : col.kind === 'bool' ? t.raw(r, c) : t.text(r, c);
    const idx = Array.from({ length: n }, (_, i) => i);
    idx.sort((a, b) => { const ka = keys[a], kb = keys[b]; if (ka === null || kb === null) return compareValues(ka, kb); return dir * compareValues(ka, kb) || a - b; });
    this.order = idx; this.sort = { c, dir }; this.render();
  }
  selectionText(withHeader) {
    const s = this.selRange(); if (!s || !this.result) return '';
    const cols = []; for (let c = s.c0; c <= s.c1; c++) cols.push(c);
    const rows = []; for (let i = s.r0; i <= s.r1; i++) { const r = this.order ? this.order[i] : i; rows.push(cols.map((c) => this.result.text(r, c))); }
    const single = rows.length === 1 && cols.length === 1;
    return single && !withHeader ? (rows[0][0] ?? '') : toTSV(cols.map((c) => this.result.columns[c].name), rows.map((r) => r.map((v) => (v === null ? '' : v))), !!withHeader);
  }
  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c' && this.sel) { e.preventDefault(); this.onCopy(this.selectionText(e.shiftKey)); return; }
    if (mod && e.key.toLowerCase() === 'a' && this.result) { e.preventDefault(); this.sel = { a: { i: 0, c: 0 }, b: { i: this.result.rowCount - 1, c: this.widths.length - 1 } }; this.render(); return; }
    if (!this.sel || !this.result) return;
    const d = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageDown: [20, 0], PageUp: [-20, 0] }[e.key];
    if (!d) return; e.preventDefault();
    const b = e.shiftKey ? this.sel.b : this.sel.a; const p = { i: Math.max(0, Math.min(this.result.rowCount - 1, b.i + d[0])), c: Math.max(0, Math.min(this.widths.length - 1, b.c + d[1])) };
    if (e.shiftKey) this.sel.b = p; else this.sel = { a: p, b: { ...p } };
    this.scrollIntoView(p); this.render();
  }
  scrollIntoView(p) {
    const y = this.headH + p.i * this.rowH; const R = this.root;
    if (y - this.headH < R.scrollTop) R.scrollTop = y - this.headH; else if (y + this.rowH > R.scrollTop + R.clientHeight) R.scrollTop = y + this.rowH - R.clientHeight;
    const x0 = this.offsets[p.c], x1 = this.offsets[p.c + 1];
    if (x0 - this.numW < R.scrollLeft) R.scrollLeft = x0 - this.numW; else if (x1 > R.scrollLeft + R.clientWidth) R.scrollLeft = x1 - R.clientWidth;
  }
}

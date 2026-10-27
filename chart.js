// Hand-rolled canvas charts for query results: bar, line, area, scatter, pie.
import { niceTicks, formatTick, formatDateMs, formatTimestampMs } from './core.js';
export const PALETTE = ['#4f9dff', '#f5a524', '#2fbf71', '#e5484d', '#a371f7', '#14b8a6', '#f472b6', '#94a3b8', '#eab308', '#22d3ee', '#fb7185', '#84cc16'];
const NUM = new Set(['number', 'bigint', 'decimal']);
const TIME = new Set(['date', 'timestamp']);

// Pick sensible default columns for a result.
export function suggestChart(result) {
  const cols = result.columns; const nums = cols.map((c, i) => (NUM.has(c.kind) ? i : -1)).filter((i) => i >= 0);
  const times = cols.map((c, i) => (TIME.has(c.kind) ? i : -1)).filter((i) => i >= 0);
  const cats = cols.map((c, i) => (c.kind === 'string' || c.kind === 'bool' ? i : -1)).filter((i) => i >= 0);
  if (times.length && nums.length) return { type: 'line', x: times[0], ys: nums.filter((i) => i !== times[0]).slice(0, 3) };
  if (cats.length && nums.length) return { type: 'bar', x: cats[0], ys: [nums[0]] };
  if (nums.length >= 2) return { type: 'scatter', x: nums[0], ys: [nums[1]] };
  return { type: 'bar', x: 0, ys: nums.slice(0, 1) };
}

export function renderChart(canvas, spec, result, theme) {
  const dpr = window.devicePixelRatio || 1; const W = canvas.clientWidth || 800, H = canvas.clientHeight || 400;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = theme.bg; g.fillRect(0, 0, W, H);
  g.font = '12px system-ui, sans-serif'; g.textBaseline = 'middle';
  const msg = (t) => { g.fillStyle = theme.muted; g.textAlign = 'center'; g.fillText(t, W / 2, H / 2); return { note: t }; };
  if (!result || !result.rowCount) return msg('Run a query that returns rows to chart it.');
  const ys = (spec.ys || []).filter((c) => c >= 0 && c < result.columns.length);
  if (!ys.length) return msg('Pick at least one numeric Y column.');
  const xc = result.columns[spec.x]; if (!xc) return msg('Pick an X column.');
  const xNum = NUM.has(xc.kind) || TIME.has(xc.kind);
  const fmtX = (v) => (xc.kind === 'date' ? formatDateMs(v) : xc.kind === 'timestamp' ? formatTimestampMs(v).replace(/:00$/, '') : formatTick(v));
  let note = '';
  const type = spec.type;
  const maxRows = type === 'scatter' || ((type === 'line' || type === 'area') && xNum) ? 20000 : type === 'pie' ? 1000 : 60;
  const n = Math.min(result.rowCount, maxRows);
  if (result.rowCount > n) note = `Showing the first ${n.toLocaleString()} of ${result.rowCount.toLocaleString()} rows`;
  const order = spec.order;
  const rowAt = (i) => (order ? order[i] : i);

  if (type === 'pie') {
    const items = []; for (let i = 0; i < n; i++) { const r = rowAt(i); const v = result.num(r, ys[0]); if (v > 0) items.push({ label: result.text(r, spec.x) ?? 'NULL', v }); }
    items.sort((a, b) => b.v - a.v); const top = items.slice(0, 11); const rest = items.slice(11).reduce((a, b) => a + b.v, 0); if (rest > 0) top.push({ label: 'Other', v: rest });
    const total = top.reduce((a, b) => a + b.v, 0); if (!total) return msg('Pie charts need positive values.');
    const R = Math.min(W * 0.32, H / 2 - 30), cx = Math.min(W / 2 - 80, R + 40) + (W > 600 ? 60 : 0), cy = H / 2; let a = -Math.PI / 2;
    top.forEach((it, k) => { const d = (it.v / total) * Math.PI * 2; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a, a + d); g.closePath(); g.fillStyle = PALETTE[k % PALETTE.length]; g.fill(); g.strokeStyle = theme.bg; g.lineWidth = 2; g.stroke(); a += d; });
    g.textAlign = 'left'; const lx = cx + R + 30; top.forEach((it, k) => { const y = cy - (top.length * 20) / 2 + k * 20 + 10; g.fillStyle = PALETTE[k % PALETTE.length]; g.fillRect(lx, y - 6, 12, 12); g.fillStyle = theme.fg; g.fillText(`${String(it.label).slice(0, 28)}  ${((it.v / total) * 100).toFixed(1)}%`, lx + 18, y); });
    return { note };
  }

  // Build series
  const series = ys.map((c) => ({ name: result.columns[c].name, c, pts: [] }));
  const cats = [];
  for (let i = 0; i < n; i++) {
    const r = rowAt(i); const xv = xNum && type !== 'bar' ? result.num(r, spec.x) : i;
    if (!(xNum && type !== 'bar')) cats.push(result.text(r, spec.x) ?? 'NULL');
    if (!Number.isFinite(xv)) continue;
    for (const s of series) { const y = result.num(r, s.c); if (Number.isFinite(y)) s.pts.push([xv, y]); }
  }
  if (type === 'scatter' && !xNum) return msg('Scatter plots need a numeric or date X column.');
  if (xNum && type !== 'bar') for (const s of series) s.pts.sort((p, q) => p[0] - q[0]);
  let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity;
  for (const s of series) for (const [x, y] of s.pts) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; if (x < xmin) xmin = x; if (x > xmax) xmax = x; }
  if (!Number.isFinite(ymin)) return msg('No numeric values to plot in the chosen Y columns.');
  if (type === 'bar' || type === 'area') { ymin = Math.min(0, ymin); ymax = Math.max(0, ymax); }
  const yt = niceTicks(ymin, ymax, 5); ymin = yt[0]; ymax = yt[yt.length - 1];
  let left = Math.max(...yt.map((v) => g.measureText(formatTick(v)).width)) + 16; const right = 16, top = series.length > 1 ? 34 : 16; let bottom = 36;
  if (type === 'bar') { // room for the 45° category labels
    const lw = Math.max(0, ...cats.slice(0, 400).map((c) => g.measureText(String(c).slice(0, 16)).width)) * Math.SQRT1_2;
    bottom = Math.min(H * 0.45, Math.max(36, lw + 20));
    const bw0 = (W - left - right) / Math.max(1, cats.length); left = Math.max(left, Math.min(W * 0.25, lw - bw0 / 2 + 10));
  }
  const pw = W - left - right, ph = H - top - bottom;
  const Y = (v) => top + ph - ((v - ymin) / (ymax - ymin || 1)) * ph;
  // grid + y labels
  g.strokeStyle = theme.grid; g.lineWidth = 1; g.fillStyle = theme.muted; g.textAlign = 'right';
  for (const v of yt) { const y = Math.round(Y(v)) + 0.5; g.beginPath(); g.moveTo(left, y); g.lineTo(W - right, y); g.stroke(); g.fillText(formatTick(v), left - 6, y); }
  if (series.length > 1) { g.textAlign = 'left'; let lx = left; series.forEach((s, k) => { g.fillStyle = PALETTE[k % PALETTE.length]; g.fillRect(lx, 12, 12, 12); g.fillStyle = theme.fg; g.fillText(s.name, lx + 16, 18); lx += g.measureText(s.name).width + 36; }); }

  if (type === 'bar') {
    const bw = pw / Math.max(1, cats.length); const inner = Math.max(1, (bw * 0.8) / series.length);
    series.forEach((s, k) => { g.fillStyle = PALETTE[k % PALETTE.length]; for (const [i, v] of s.pts) { const x = left + i * bw + bw * 0.1 + k * inner; const y0 = Y(0), y1 = Y(v); g.fillRect(x, Math.min(y0, y1), Math.max(1, inner - 1), Math.abs(y1 - y0)); } });
    g.fillStyle = theme.muted; const every = Math.ceil(cats.length / Math.max(1, Math.floor(pw / 16)));
    cats.forEach((c, i) => { if (i % every) return; g.save(); g.translate(left + i * bw + bw / 2, top + ph + 8); g.rotate(-Math.PI / 4); g.textAlign = 'right'; g.fillText(String(c).slice(0, 16), 0, 0); g.restore(); });
    return { note };
  }
  // x axis for numeric/time or categorical index
  let X, xticks;
  if (xNum) {
    if (xmin === xmax) { xmin -= 1; xmax += 1; }
    X = (v) => left + ((v - xmin) / (xmax - xmin)) * pw;
    xticks = TIME.has(xc.kind) ? Array.from({ length: 6 }, (_, k) => xmin + ((xmax - xmin) * k) / 5) : niceTicks(xmin, xmax, 6).filter((v) => v >= xmin && v <= xmax);
  } else { X = (i) => left + (cats.length > 1 ? (i / (cats.length - 1)) * pw : pw / 2); xticks = null; }
  g.fillStyle = theme.muted; g.textAlign = 'center';
  if (xticks) for (const v of xticks) g.fillText(fmtX(v), Math.min(W - 40, Math.max(left + 30, X(v))), top + ph + 16);
  else { const every = Math.ceil(cats.length / Math.max(1, Math.floor(pw / 90))); cats.forEach((c, i) => { if (!(i % every)) g.fillText(String(c).slice(0, 14), X(i), top + ph + 16); }); }
  series.forEach((s, k) => {
    const col = PALETTE[k % PALETTE.length];
    if (type === 'scatter') { g.fillStyle = col + 'b0'; const r = s.pts.length > 5000 ? 1.5 : 3; for (const [x, y] of s.pts) { g.beginPath(); g.arc(X(x), Y(y), r, 0, Math.PI * 2); g.fill(); } return; }
    g.beginPath(); s.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    g.strokeStyle = col; g.lineWidth = 2; g.stroke();
    if (type === 'area' && s.pts.length) { g.lineTo(X(s.pts[s.pts.length - 1][0]), Y(0)); g.lineTo(X(s.pts[0][0]), Y(0)); g.closePath(); g.fillStyle = col + '40'; g.fill(); }
  });
  return { note };
}

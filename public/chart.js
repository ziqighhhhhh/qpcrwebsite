'use strict';
// ---------------------------------------------------------------------------
// Zero-dependency canvas line chart.
// series: [{ name, color, points: [{x, y}], width, dash }]
//
// THEME reads the CSS custom properties once (style.css is the single source
// of truth), so canvas chrome (gridlines, ticks, labels) follows the DOM
// theme instead of duplicating hex values.
// ---------------------------------------------------------------------------
const THEME = (() => {
  // Node-side unit tests evaluate this file without a DOM: fall back to the
  // same defaults the CSS tokens carry.
  const fallback = {
    surface: '#ffffff', grid: '#eef0f3', tick: '#5f6368', label: '#5f6368', text: '#0f1216',
    ink: '#141414', grey: '#8a8a8a', accent: '#1d5fbf',
    positive: '#247b50', negative: '#c4242a', warning: '#92400e',
  };
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return fallback;
  const cs = getComputedStyle(document.documentElement);
  const v = (n, f) => { const x = (cs.getPropertyValue(n) || '').trim(); return x || f; };
  return {
    surface: v('--surface', fallback.surface),
    grid: v('--rule', fallback.grid),
    tick: v('--muted', fallback.tick),
    label: v('--muted', fallback.label),
    text: v('--text', fallback.text),
    ink: v('--chart-1', fallback.ink),
    grey: v('--chart-2', fallback.grey),
    accent: v('--chart-3', fallback.accent),
    positive: v('--positive', fallback.positive),
    negative: v('--negative', fallback.negative),
    warning: v('--warning', fallback.warning),
  };
})();

// Multi-curve overlay palette: the first (selected) series takes the one hue;
// the rest are muted comparisons. No violet/indigo, no status green/red, so
// curves never read as Call states.
const CURVE_PALETTE = ['#1d5fbf', '#141414', '#8a8a8a', '#c2410c', '#0e7490', '#be3455'];

function drawLineChart(canvas, series, opts) {
  opts = opts || {};
  canvas.chartExport = { series, opts };
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.getAttribute('width') || 760;
  const cssH = opts.height || 360;
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { l: 56, r: 16, t: 14, b: 34 };
  const iw = cssW - pad.l - pad.r;
  const ih = cssH - pad.t - pad.b;

  // collect all points
  const all = [];
  series.forEach(s => (s.points || []).forEach(p => { if (isFinite(p.x) && isFinite(p.y)) all.push(p); }));
  if (!all.length) {
    ctx.fillStyle = THEME.tick; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(opts.emptyText || '无数据 — 请选择孔位', cssW / 2, cssH / 2);
    return;
  }
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  all.forEach(p => {
    if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
  });
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.05; yMin -= yPad; yMax += yPad;
  const sx = v => pad.l + ((v - xMin) / (xMax - xMin)) * iw;
  const sy = v => pad.t + ih - ((v - yMin) / (yMax - yMin)) * ih;

  // grid + axes
  ctx.strokeStyle = THEME.grid; ctx.fillStyle = THEME.tick; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  const xTicks = 8, yTicks = 6;
  for (let i = 0; i <= xTicks; i++) {
    const v = xMin + (xMax - xMin) * i / xTicks;
    const X = sx(v);
    ctx.beginPath(); ctx.moveTo(X, pad.t); ctx.lineTo(X, pad.t + ih); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillText(round(v, 1), X, cssH - 12);
  }
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (yMax - yMin) * i / yTicks;
    const Y = sy(v);
    ctx.beginPath(); ctx.moveTo(pad.l, Y); ctx.lineTo(pad.l + iw, Y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(fmtExp(v), pad.l - 6, Y + 4);
  }
  ctx.fillStyle = THEME.label; ctx.font = '11px sans-serif';
  ctx.textAlign = 'center'; ctx.fillText(opts.xLabel || 'Cycle', pad.l + iw / 2, cssH - 1);
  ctx.save(); ctx.translate(14, pad.t + ih / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(opts.yLabel || 'Fluorescence', 0, 0); ctx.restore();

  // series
  series.forEach((s, si) => {
    if (!s.points || !s.points.length) return;
    ctx.strokeStyle = s.color || palette(si);
    ctx.fillStyle = s.color || palette(si);
    ctx.lineWidth = s.width || 2;
    // scatter series (e.g. standard-curve points): draw markers without a connecting line
    if (s.pointsOnly) {
      s.points.forEach(p => {
        if (!isFinite(p.x) || !isFinite(p.y)) return;
        ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), s.pointRadius || 3.5, 0, Math.PI * 2); ctx.fill();
      });
      return;
    }
    if (s.dash) ctx.setLineDash(s.dash);
    ctx.beginPath();
    let started = false;
    s.points.forEach(p => {
      if (!isFinite(p.x) || !isFinite(p.y)) return;
      const X = sx(p.x), Y = sy(p.y);
      if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    // Cq marker
    if (opts.markers && s.markers) {
      ctx.fillStyle = s.color || palette(si);
      s.markers.forEach(m => {
        if (m.x === null || m.x === undefined) return;
        const X = sx(m.x), Y = sy(m.y);
        ctx.beginPath(); ctx.arc(X, Y, 4, 0, Math.PI * 2); ctx.fill();
      });
    }
  });
}
function palette(i) {
  return CURVE_PALETTE[i % CURVE_PALETTE.length];
}
function round(v, d) { const m = Math.pow(10, d || 0); return Math.round(v * m) / m; }
function fmtExp(v) {
  if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) return v.toExponential(1);
  return String(Math.round(v * 10000) / 10000);
}

'use strict';
// ---------------------------------------------------------------------------
// Zero-dependency canvas line chart.
// series: [{ name, color, points: [{x, y}], width, dash }]
// ---------------------------------------------------------------------------
function drawLineChart(canvas, series, opts) {
  opts = opts || {};
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
    ctx.fillStyle = '#5c7399'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
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
  ctx.strokeStyle = '#26304a'; ctx.fillStyle = '#6c82a6'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
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
  ctx.fillStyle = '#9db4d8'; ctx.font = '11px sans-serif';
  ctx.textAlign = 'center'; ctx.fillText(opts.xLabel || 'Cycle', pad.l + iw / 2, cssH - 1);
  ctx.save(); ctx.translate(14, pad.t + ih / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(opts.yLabel || 'Fluorescence', 0, 0); ctx.restore();

  // series
  series.forEach((s, si) => {
    if (!s.points || !s.points.length) return;
    ctx.strokeStyle = s.color || palette(si);
    ctx.lineWidth = s.width || 2;
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
  const c = ['#4da3ff', '#ff8d6b', '#7fe3a0', '#ffd166', '#c17bff', '#5ad0d0', '#ff7aa2', '#9aa7ff'];
  return c[i % c.length];
}
function round(v, d) { const m = Math.pow(10, d || 0); return Math.round(v * m) / m; }
function fmtExp(v) {
  if (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0)) return v.toExponential(1);
  return String(Math.round(v * 10000) / 10000);
}
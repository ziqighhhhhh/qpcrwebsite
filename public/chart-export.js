'use strict';
// ---------------------------------------------------------------------------
// Chart export: PNG (bitmap) and SVG (vector) for every canvas on a page.
//
// SVG has two sources, in order of preference:
//  1. canvas.__recorder — the 2D draw calls, captured by wrapping
//     HTMLCanvasElement.getContext (installed at page load, before any chart is
//     drawn). This covers custom-drawn charts (bar/scatter/box plots) that the
//     line-series renderer cannot express, and never embeds a bitmap.
//  2. lineChartSvg(series, opts) — the declarative fallback used when a canvas
//     was drawn before the recorder existed (canvas.chartExport set by chart.js).
//
// Recorder limits (the shapes these charts actually use): paths are emitted in
// transformed coordinates, so rotation/skew of shapes is not reproduced; text
// carries its residual transform. Strokes/fills are snapshotted per primitive.
// ---------------------------------------------------------------------------
function lineChartSvg(series, opts = {}) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const colors = ['#4da3ff','#ff8d6b','#7fe3a0','#ffd166','#c17bff','#5ad0d0','#ff7aa2','#9aa7ff'];
  const points = series.flatMap(s => s.points || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) throw new Error('没有可导出的曲线数据');
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs) === xmin ? xmin + 1 : Math.max(...xs);
  const min = Math.min(...ys), max = Math.max(...ys), gap = max === min ? 1 : (max - min) * 0.05;
  const ymin = min - gap, ymax = max + gap;
  const sx = x => 70 + (x - xmin) / (xmax - xmin) * 700;
  const sy = y => 330 - (y - ymin) / (ymax - ymin) * 300;
  const height = 390 + series.length * 18;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}"><rect width="100%" height="100%" fill="#111827"/><g font-family="sans-serif" font-size="12" fill="#dbeafe">`];
  for (let i = 0; i <= 6; i++) {
    const x = xmin + (xmax - xmin) * i / 6, y = ymin + (ymax - ymin) * i / 6;
    parts.push(`<path d="M ${sx(x)} 30 V 330 M 70 ${sy(y)} H 770" stroke="#334155"/><text x="${sx(x)}" y="350" text-anchor="middle">${x.toPrecision(4)}</text><text x="64" y="${sy(y)+4}" text-anchor="end">${y.toPrecision(4)}</text>`);
  }
  parts.push(`<text x="420" y="373" text-anchor="middle">${escape(opts.xLabel || 'Cycle')}</text><text transform="translate(15 180) rotate(-90)" text-anchor="middle">${escape(opts.yLabel || 'Fluorescence')}</text>`);
  series.forEach((s, i) => {
    const color = escape(s.color || colors[i % colors.length]);
    const pts = (s.points || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (s.pointsOnly) {
      // scatter series: circles only, never a connecting line
      pts.forEach(p => parts.push(`<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="${s.pointRadius || 3.5}" fill="${color}"/>`));
    } else {
      const coords = pts.map(p => `${sx(p.x)},${sy(p.y)}`).join(' ');
      parts.push(`<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${escape(s.dash.join(' '))}"` : ''}/>`);
    }
    if (opts.markers) (s.markers || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).forEach(p => parts.push(`<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="${color}"/>`));
    parts.push(`<text x="70" y="${395+i*18}" fill="${color}">${escape(s.name || `Series ${i+1}`)}</text>`);
  });
  return parts.join('') + '</g></svg>';
}

// ---------------------------------------------------------------------------
// 2D-context recorder
// ---------------------------------------------------------------------------
const PATH_METHODS = ['moveTo', 'lineTo'];
const RECORDED = new Set(['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'arc', 'rect', 'fill', 'stroke', 'fillText', 'setLineDash', 'save', 'restore', 'translate', 'rotate', 'setTransform']);

function identity() { return [1, 0, 0, 1, 0, 0]; }
// A·B (apply B, then A) in canvas a,b,c,d,e,f order
function matMul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}
function applyM(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

function createRecorder() {
  return {
    ops: [],
    state: { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, font: '10px sans-serif', textAlign: 'start', dash: [] },
    stack: [],
    matrix: identity(),
    base: null,       // matrix in effect at the first clearRect (usually a devicePixelRatio scale)
    baseScale: [1, 1],
    path: [],
  };
}
function snapshot(rec) {
  return { fillStyle: rec.state.fillStyle, strokeStyle: rec.state.strokeStyle, lineWidth: rec.state.lineWidth, font: rec.state.font, textAlign: rec.state.textAlign, dash: rec.state.dash.slice() };
}
// Device-pixel coordinates → CSS pixels (charts draw in CSS px under a dpr scale).
function toCss(rec, p) { return [p[0] / rec.baseScale[0], p[1] / rec.baseScale[1]]; }
function cssRadius(rec, r, matrix) {
  const scale = Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])) || 1;
  const base = (rec.baseScale[0] + rec.baseScale[1]) / 2 || 1;
  return r * scale / base;
}
function record(rec, method, args) {
  const M = rec.matrix;
  switch (method) {
    case 'clearRect':
      if (!rec.base) { rec.base = M.slice(); rec.baseScale = [Math.hypot(M[0], M[1]) || 1, Math.hypot(M[2], M[3]) || 1]; }
      rec.ops.length = 0;                                  // every drawer starts its frame with clearRect
      rec.ops.push({ t: 'rect', x: 0, y: 0, w: args[2], h: args[3], fill: rec.state.fillStyle, frame: true });
      rec.path = [];
      break;
    case 'fillRect': case 'strokeRect': {
      const p0 = toCss(rec, applyM(M, args[0], args[1])), p1 = toCss(rec, applyM(M, args[0] + args[2], args[1] + args[3]));
      rec.ops.push({
        t: 'rect', x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]),
        w: Math.abs(p1[0] - p0[0]), h: Math.abs(p1[1] - p0[1]),
        fill: method === 'fillRect' ? rec.state.fillStyle : 'none',
        stroke: method === 'strokeRect' ? rec.state.strokeStyle : null,
        lineWidth: rec.state.lineWidth,
      });
      break;
    }
    case 'beginPath': rec.path = []; break;
    case 'closePath': rec.path.closed = true; break;
    case 'moveTo': case 'lineTo': {
      const p = toCss(rec, applyM(M, args[0], args[1]));
      rec.path.push({ p, move: method === 'moveTo' });
      break;
    }
    case 'rect': {
      const p0 = toCss(rec, applyM(M, args[0], args[1])), p1 = toCss(rec, applyM(M, args[0] + args[2], args[1] + args[3]));
      rec.path.push({ rect: { x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]), w: Math.abs(p1[0] - p0[0]), h: Math.abs(p1[1] - p0[1]) } });
      break;
    }
    case 'arc': {
      const c = toCss(rec, applyM(M, args[0], args[1]));
      rec.path.push({ arc: { x: c[0], y: c[1], r: cssRadius(rec, args[2], M) } });
      break;
    }
    case 'fill': case 'stroke': {
      const ops = rec.path.filter(p => p.p);
      const prims = rec.path.filter(p => p.arc || p.rect);
      if (ops.length >= 2) {
        let d = '';
        for (const p of ops) d += (p.move || !d ? 'M' : 'L') + p.p[0].toFixed(2) + ' ' + p.p[1].toFixed(2) + ' ';
        rec.ops.push({
          t: 'path', d: d.trim() + (rec.path.closed ? ' Z' : ''),
          fill: method === 'fill' ? rec.state.fillStyle : 'none',
          stroke: method === 'stroke' ? rec.state.strokeStyle : null,
          lineWidth: rec.state.lineWidth, dash: rec.state.dash.slice(),
        });
      }
      for (const prim of prims) {
        if (prim.arc) {
          rec.ops.push({ t: 'circle', x: prim.arc.x, y: prim.arc.y, r: prim.arc.r, fill: method === 'fill' ? rec.state.fillStyle : 'none', stroke: method === 'stroke' ? rec.state.strokeStyle : null, lineWidth: rec.state.lineWidth });
        } else {
          rec.ops.push({ t: 'rect', x: prim.rect.x, y: prim.rect.y, w: prim.rect.w, h: prim.rect.h, fill: method === 'fill' ? rec.state.fillStyle : 'none', stroke: method === 'stroke' ? rec.state.strokeStyle : null, lineWidth: rec.state.lineWidth });
        }
      }
      rec.path = [];
      break;
    }
    case 'fillText': {
      const p = toCss(rec, applyM(M, args[1], args[2]));
      // residual transform (rotation survives; the devicePixelRatio scale is normalised away)
      const bs = rec.baseScale;
      const residual = [M[0] / bs[0], M[1] / bs[0], M[2] / bs[1], M[3] / bs[1], 0, 0];
      rec.ops.push({ t: 'text', text: String(args[0]), x: args[1], y: args[2], ax: p[0], ay: p[1], residual, ...snapshot(rec) });
      break;
    }
    case 'setLineDash': rec.state.dash = (args[0] || []).slice(); break;
    case 'save': rec.stack.push({ state: snapshot(rec), matrix: M.slice() }); break;
    case 'restore': {
      const prev = rec.stack.pop();
      if (prev) { Object.assign(rec.state, prev.state); rec.matrix = prev.matrix; }
      break;
    }
    case 'translate': rec.matrix = matMul(M, [1, 0, 0, 1, args[0], args[1]]); break;
    case 'rotate': {
      const c = Math.cos(args[0]), s = Math.sin(args[0]);
      rec.matrix = matMul(M, [c, s, -s, c, 0, 0]);
      break;
    }
    case 'setTransform': rec.matrix = args.length === 6 ? args.slice() : identity(); break;
    default: break;
  }
}

// Wrap a 2D context so every draw call is recorded (and still drawn normally).
function wrapContext(canvas, ctx, rec) {
  const recorder = rec || createRecorder();
  canvas.__recorder = recorder;
  return new Proxy(ctx, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value === 'function' && RECORDED.has(prop)) {
        return (...args) => { record(recorder, prop, args); return value.apply(target, args); };
      }
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
    set(target, prop, value) {
      if (prop in recorder.state) recorder.state[prop] = value;
      target[prop] = value;
      return true;
    },
  });
}

function escapeXml(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function parseFont(font) {
  const m = /(italic|oblique)?\s*(bold|[0-9]{3})?\s*([0-9.]+)px\s*(.*)/.exec(String(font || ''));
  return {
    size: m && m[3] ? parseFloat(m[3]) : 10,
    weight: m && m[2] ? m[2] : 'normal',
    italic: m && m[1] ? m[1] : '',
    family: m && m[4] ? m[4] : 'sans-serif',
  };
}
function num(v) { return Math.round(v * 100) / 100; }

// Replay recorded ops as SVG. Pure function — unit-tested without a browser.
function svgFromOps(ops, opts = {}) {
  if (!ops || !ops.length) return null;
  const frame = ops.find(o => o.frame);
  const w = opts.width || (frame ? frame.w : 420);
  const h = opts.height || (frame ? frame.h : 240);
  const bg = opts.background || '#10141f';
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(w)} ${num(h)}">`,
    `<rect width="100%" height="100%" fill="${escapeXml(bg)}"/>`, '<g>'];
  for (const op of ops) {
    if (op.frame) continue;
    if (op.t === 'rect') {
      const fill = op.fill === 'none' ? 'none' : escapeXml(op.fill);
      const stroke = op.stroke ? ` stroke="${escapeXml(op.stroke)}" stroke-width="${num(op.lineWidth || 1)}"` : '';
      parts.push(`<rect x="${num(op.x)}" y="${num(op.y)}" width="${num(op.w)}" height="${num(op.h)}" fill="${fill}"${stroke}/>`);
    } else if (op.t === 'circle') {
      const fill = op.fill === 'none' ? 'none' : escapeXml(op.fill);
      const stroke = op.stroke ? ` stroke="${escapeXml(op.stroke)}" stroke-width="${num(op.lineWidth || 1)}"` : '';
      parts.push(`<circle cx="${num(op.x)}" cy="${num(op.y)}" r="${num(op.r)}" fill="${fill}"${stroke}/>`);
    } else if (op.t === 'path') {
      const fill = op.fill === 'none' ? 'none' : escapeXml(op.fill);
      const dash = op.dash && op.dash.length ? ` stroke-dasharray="${op.dash.map(num).join(' ')}"` : '';
      parts.push(`<path d="${op.d}" fill="${fill}"${op.stroke ? ` stroke="${escapeXml(op.stroke)}"` : ''} stroke-width="${num(op.lineWidth || 1)}"${dash}/>`);
    } else if (op.t === 'text') {
      const f = parseFont(op.font);
      const anchor = op.textAlign === 'center' ? 'middle' : (op.textAlign === 'right' || op.textAlign === 'end' ? 'end' : 'start');
      const id = [1, 0, 0, 1, 0, 0].every((v, i) => Math.abs((op.residual || [1, 0, 0, 1, 0, 0])[i] - v) < 1e-6);
      const transform = id ? '' : ` transform="matrix(${(op.residual || []).map(v => Math.round(v * 1e6) / 1e6).join(' ')})"`;
      parts.push(`<text x="${num(op.ax !== undefined ? op.ax : op.x)}" y="${num(op.ay !== undefined ? op.ay : op.y)}"${transform}` +
        ` text-anchor="${anchor}" font-family="${escapeXml(f.family)}" font-size="${num(f.size)}"` +
        `${f.weight !== 'normal' ? ` font-weight="${escapeXml(f.weight)}"` : ''}${f.italic ? ` font-style="${escapeXml(f.italic)}"` : ''}` +
        ` fill="${escapeXml(op.fillStyle)}">${escapeXml(op.text)}</text>`);
    }
  }
  parts.push('</g></svg>');
  return parts.join('');
}

// SVG for a canvas that was drawn while the recorder was installed.
function canvasSvg(canvas) {
  if (!canvas || !canvas.__recorder) return null;
  return svgFromOps(canvas.__recorder.ops);
}

// ---------------------------------------------------------------------------
// browser wiring: recorder install + per-canvas download buttons
// ---------------------------------------------------------------------------
function installCanvasRecorder(win) {
  const scope = win || (typeof window !== 'undefined' ? window : null);
  if (!scope || !scope.HTMLCanvasElement) return false;
  const proto = scope.HTMLCanvasElement.prototype;
  if (proto.__qpcRecorderInstalled) return true;
  const original = proto.getContext;
  proto.getContext = function (type, ...rest) {
    const ctx = original.call(this, type, ...rest);
    if (type !== '2d' || !ctx || this.__recorder) return ctx;
    return wrapContext(this, ctx, createRecorder());
  };
  proto.__qpcRecorderInstalled = true;
  return true;
}

if (typeof module !== 'undefined') {
  module.exports = { lineChartSvg, svgFromOps, canvasSvg, createRecorder, wrapContext, installCanvasRecorder };
}
if (typeof document !== 'undefined') {
  function saveChart(blob, name) {
    if (!blob) throw new Error('图像生成失败');
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  installCanvasRecorder();
  document.querySelectorAll('canvas').forEach(canvas => {
    const bar = document.createElement('div');
    bar.className = 'chart-downloads';
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    ['PNG', 'SVG'].forEach(format => {
      const button = document.createElement('button'); button.className = 'btn'; button.textContent = `导出 ${format}`;
      button.addEventListener('click', () => {
        status.textContent = '';
        try {
          if (format === 'SVG') {
            // recorded draw calls first (covers bars/boxes); line-series fallback
            let svg = canvasSvg(canvas);
            if (!svg) {
              if (!canvas.chartExport) throw new Error('请先加载曲线');
              svg = lineChartSvg(canvas.chartExport.series, canvas.chartExport.opts);
            }
            saveChart(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${canvas.id}.svg`);
          } else {
            const output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height;
            const ctx = output.getContext('2d'); ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, output.width, output.height); ctx.drawImage(canvas, 0, 0);
            output.toBlob(blob => { try { saveChart(blob, `${canvas.id}.png`); } catch (error) { status.textContent = error.message; } });
          }
        } catch (error) { status.textContent = error.message; }
      });
      bar.appendChild(button);
    });
    bar.appendChild(status); canvas.after(bar);
  });
}

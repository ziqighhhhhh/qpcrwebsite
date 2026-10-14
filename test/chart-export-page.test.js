'use strict';
// Browser wiring of chart-export.js, exercised in a vm with a stub DOM:
// getContext is wrapped so draw calls are recorded, one PNG + one SVG button is
// appended per canvas, and clicking SVG actually produces a vector file (no bitmap).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'chart-export.js'), 'utf8');

// what the real browser provides, before chart-export.js wraps it
const HTMLCanvasElement = function () {};
HTMLCanvasElement.prototype.getContext = function () { return this._ctx; };
function fakeCtx() {
  const target = {};
  for (const m of ['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'arc', 'rect', 'fill', 'stroke', 'fillText', 'setLineDash', 'save', 'restore', 'translate',
    'rotate', 'setTransform', 'drawImage']) target[m] = () => {};
  return target;
}
function makeCanvas(id) {
  const canvas = Object.create(HTMLCanvasElement.prototype);
  canvas.id = id;
  canvas.style = {};
  canvas.width = 840; canvas.height = 480;
  canvas.clientWidth = 420; canvas.clientHeight = 240;
  canvas.handlers = {};
  canvas.classList = { add() {}, remove() {} };
  canvas._ctx = fakeCtx();
  canvas.addEventListener = (t, fn) => { (canvas.handlers[t] = canvas.handlers[t] || []).push(fn); };
  canvas.setAttribute = () => {}; canvas.getAttribute = () => null; canvas.hasAttribute = () => false;
  canvas.after = el => { (canvas.afterNodes = canvas.afterNodes || []).push(el); };
  return canvas;
}

function makeElement(tag) {
  const el = {
    tagName: tag, children: [], style: {}, textContent: '', className: '', href: '', download: '',
    setAttribute(k, v) { el[k] = v; },
    appendChild(c) { el.children.push(c); return c; },
    addEventListener(t, fn) { (el.handlers = el.handlers || {})[t] = fn; },
  };
  return el;
}

function boot() {
  const canvases = [makeCanvas('relChart'), makeCanvas('leftCurve')];
  const created = [];
  const downloads = [];
  const document = {
    querySelectorAll: sel => (sel === 'canvas' ? canvases : []),
    createElement: tag => { const el = makeElement(tag); created.push(el); if (tag === 'a') downloads.push(el); return el; },
  };
  const blobs = [];
  const sandbox = {
    document,
    HTMLCanvasElement,
    window: { devicePixelRatio: 2, HTMLCanvasElement },
    console,
    setTimeout,
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; blobs.push(this); } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'chart-export.js' });
  assert.equal(HTMLCanvasElement.prototype.__qpcRecorderInstalled, true);
  return { canvases, created, downloads, blobs, HTMLCanvasElement };
}

test('getContext is wrapped so draw calls are recorded, and every canvas gets PNG + SVG buttons', () => {
  const { canvases, HTMLCanvasElement } = boot();
  const canvas = canvases[0];
  const ctx = canvas.getContext('2d');
  // drive a minimal frame through the wrapped context
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.clearRect(0, 0, 420, 240);
  ctx.fillStyle = '#4da3ff';
  ctx.fillRect(10, 20, 30, 40);
  assert.ok(canvas.__recorder, 'recorder attached');
  assert.equal(canvas.__recorder.ops.filter(o => o.t === 'rect' && !o.frame).length, 1);

  for (const c of canvases) {
    const bar = c.afterNodes && c.afterNodes[0];
    assert.ok(bar, 'a download bar is appended after ' + c.id);
    const labels = bar.children.filter(x => x.tagName === 'button').map(b => b.textContent);
    assert.deepEqual(labels, ['导出 PNG', '导出 SVG'], c.id + ' buttons');
  }
});

test('clicking 导出 SVG writes a vector file built from the recorded frames', async () => {
  const { canvases, blobs, HTMLCanvasElement } = boot();
  const canvas = canvases[1];
  const ctx = canvas.getContext('2d');
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.clearRect(0, 0, 420, 240);
  ctx.strokeStyle = '#e6eefb'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(56, 200); ctx.lineTo(404, 200); ctx.stroke();
  ctx.fillStyle = '#ff8d6b'; ctx.beginPath(); ctx.arc(200, 120, 4, 0, Math.PI * 2); ctx.fill();

  const bar = canvas.afterNodes[0];
  const svgButton = bar.children.find(x => x.tagName === 'button' && x.textContent === '导出 SVG');
  assert.ok(svgButton.handlers.click, 'click handler bound');
  svgButton.handlers.click();
  await new Promise(r => setTimeout(r, 10));

  assert.equal(blobs.length, 1, 'one blob produced');
  const text = blobs[0].parts.join('');
  assert.match(blobs[0].type, /image\/svg\+xml/);
  assert.ok(text.startsWith('<svg') && text.includes('viewBox="0 0 420 240"'));
  assert.ok(text.includes('M56.00 200.00 L404.00 200.00'), 'axis path vectorised');
  assert.ok(text.includes('<circle cx="200" cy="120" r="4"'), 'scatter circle vectorised');
  assert.ok(!text.includes('<image'), 'no bitmap embedded');
});

test('导出 SVG before anything is drawn reports a friendly error instead of throwing', () => {
  const { canvases } = boot();
  const canvas = canvases[0];
  const bar = canvas.afterNodes[0];
  const status = bar.children.find(x => x.tagName !== 'button');
  const svgButton = bar.children.find(x => x.tagName === 'button' && x.textContent === '导出 SVG');
  svgButton.handlers.click();
  assert.match(status.textContent, /请先|图像生成失败/);
});

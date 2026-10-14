'use strict';
// Integration check for public/standard-curve.js + public/standard-curve.html.
//
// No browser is available in this environment, so the page script runs in a vm
// with a minimal DOM/2D-context stub and a fake fetch wired to the real
// lib/standardcurve.js. This catches the failure modes that a syntax check
// misses: ids that do not exist in the HTML, render-time TypeErrors, plate
// selection order, and the fill-series payload.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const design = require('../lib/design.js');
const curve = require('../lib/standardcurve.js');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'standard-curve.html'), 'utf8');
const pageSrc = fs.readFileSync(path.join(pub, 'standard-curve.js'), 'utf8');
const chartSrc = fs.readFileSync(path.join(pub, 'chart.js'), 'utf8');

// ---- stub DOM ----
function ctx2d() {
  const target = {};
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], style: {}, dataset: {}, attrs: {}, handlers: {},
    className: '', textContent: '', innerHTML: '', hidden: false, value: '', checked: false,
    width: 720, height: 360, clientWidth: 720,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k); },
    after() {},
    getContext() { return ctx2d(); },
    click() { (el.handlers.click || []).forEach(f => f({ target: el })); },
    fire(type) { (el.handlers[type] || []).forEach(f => f({ target: el })); },
    querySelector(sel) {
      if (sel === 'thead' || sel === 'tbody') return el['_' + sel];
      const found = el.children.find(c => c.tagName === sel);
      return found || null;
    },
    querySelectorAll() { return []; },
  };
  if (tag === 'table') { el._thead = makeEl('thead'); el._tbody = makeEl('tbody'); }
  return el;
}

const ids = Array.from(html.matchAll(/id="([^"]+)"/g)).map(m => m[1]);
const TABLE_IDS = new Set(['stdTable', 'unkTable', 'sumTable']);
const registry = new Map(ids.map(id => [id, makeEl(TABLE_IDS.has(id) ? 'table' : 'div')]));

// ---- experiment under test: design synthesis with a 5-point standard series ----
const spec = {
  groups: [{ name: '对照组' }, { name: '处理组' }],
  bioReps: 3, techReps: 3, targetGene: 'IL6', refGene: 'GAPDH',
  foldChange: 4, direction: 'down', quality: 'good', seed: 42,
  standards: { enabled: true, points: 5, replicates: 3, startQuantity: 1e7, dilution: 5, unit: 'copies' },
};
const { experiment, truth } = design.synthesizeFromDesign(spec);
experiment.id = 'page-test';
experiment.analysis.synthetic.derived = design.deriveDesign(spec);
experiment.computed = {};
for (const id of Object.keys(truth)) {
  const t = truth[id];
  experiment.computed[id + '|SYBR Green I'] = t.trueCq === null || t.trueCq === undefined
    ? { '11 Intermediate Call': 'Negative', '26 CT1': 100 }
    : { '11 Intermediate Call': 'Positive', '26 CT1': t.trueCq };
}

let manualWells = {};        // server-side store, mutated by POST /api/standards
const posted = [];

function fakeFetch(url, opts) {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  if (u.startsWith('/api/experiment')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => experiment, text: async () => '' });
  }
  if (u.startsWith('/api/standards')) {
    if (method === 'POST') {
      const body = JSON.parse(opts.body);
      posted.push(body.wells);
      manualWells = body.wells;
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, wells: manualWells }), text: async () => '' });
  }
  if (u.startsWith('/api/standard-curve')) {
    const result = curve.analyzeStandardCurve(experiment, { manual: manualWells, layoutNames: {} });
    if (u.includes('format=csv')) {
      const csv = curve.toCsv(result);
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'attachment' }, text: async () => csv, json: async () => result });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => result, text: async () => JSON.stringify(result) });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'not found' }), text: async () => 'not found' });
}

const sandbox = {
  document: {
    getElementById: id => registry.get(id) || null,
    createElement: tag => makeEl(tag),
    querySelectorAll: () => [],
    addEventListener: () => {},
  },
  window: { devicePixelRatio: 1 },
  fetch: fakeFetch,
  console,
  setTimeout,
  clearTimeout,
  URL,
  Blob: class { constructor() {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(chartSrc, sandbox, { filename: 'chart.js' });
vm.runInContext(pageSrc, sandbox, { filename: 'standard-curve.js' });

const settle = () => new Promise(resolve => setTimeout(resolve, 80));
const rowsIn = el => (el.innerHTML.match(/<tr>/g) || []).length;

test('every id the page script reaches for exists in the HTML', () => {
  const referenced = Array.from(pageSrc.matchAll(/\$\('([^']+)'\)/g)).map(m => m[1]);
  const missing = referenced.filter(id => !ids.includes(id));
  assert.deepEqual(missing, []);
  assert.ok(referenced.length >= 12);
});

test('page renders plate, tables and both charts from the API payload', async () => {
  await settle();
  const plate = registry.get('scPlate');
  assert.equal(plate.children.length, 96, 'plate wells rendered');
  const stdLabels = plate.children.filter(c => c.title.includes('标准品')).map(c => c.dataset.label);
  assert.equal(stdLabels.length, 15, 'design standards marked on the plate: ' + stdLabels.join(','));
  assert.deepEqual(stdLabels.slice(0, 3), ['A1', 'A2', 'A3']);

  assert.equal(rowsIn(registry.get('stdTable')._tbody), 15, 'standard rows');
  assert.equal(rowsIn(registry.get('unkTable')._tbody), 36, 'unknown rows');
  assert.equal(rowsIn(registry.get('sumTable')._tbody), 6, 'sample summary rows');

  const fitCards = registry.get('fitCards').innerHTML;
  assert.ok(/斜率/.test(fitCards) && /R²/.test(fitCards) && /扩增效率/.test(fitCards));
  assert.ok(/98/.test(fitCards), 'designed efficiency shown: ' + fitCards.slice(0, 200));
  const verdict = registry.get('fitVerdict').innerHTML;
  assert.ok(/Cq = /.test(verdict) && !/⚠/.test(verdict), 'clean fit has no warnings: ' + verdict);

  // charts: scatter series + dashed fit line, so PNG/SVG export has line data
  const exportData = registry.get('stdCurveChart').chartExport;
  assert.ok(exportData && Array.isArray(exportData.series));
  assert.equal(exportData.series[0].pointsOnly, true);
  assert.equal(exportData.series[0].points.length, 15);
  assert.ok(Array.isArray(exportData.series[1].dash) && exportData.series[1].points.length === 2);
  assert.ok(exportData.series[1].points[0].y > exportData.series[1].points[1].y, 'fit line descends with log10(quantity)');
  const residual = registry.get('stdResidualChart').chartExport;
  assert.equal(residual.series[0].points.length, 15);
  assert.equal(residual.series[1].points[0].y, 0, 'zero line present');
});

test('fill-series assigns the dilution ladder in click order and saves it', async () => {
  const plate = registry.get('scPlate');
  const byLabel = label => plate.children.find(c => c.dataset.label === label);
  // click out of plate order on purpose: B5, A1, C12
  for (const label of ['B5', 'A1', 'C12']) byLabel(label).click();
  assert.equal(registry.get('selCount').textContent, '已选 3 孔');
  registry.get('startQty').value = '10000000';
  registry.get('dilution').value = '5';
  registry.get('unit').value = 'copies';
  registry.get('btnFillSeries').click();
  await settle();

  assert.equal(posted.length, 1, 'one POST issued');
  const wells = posted[0];
  assert.deepEqual(Object.keys(wells), ['B5', 'A1', 'C12'], 'click order preserved');
  assert.equal(wells.B5.quantity, 1e7);
  assert.equal(wells.A1.quantity, 2e6);
  assert.equal(wells.C12.quantity, 4e5);
  assert.equal(wells.A1.unit, 'copies');
  // manual wells now override the design values on A1 and show up in the table
  const stdRows = registry.get('stdTable')._tbody.innerHTML;
  assert.ok(/手动/.test(stdRows), 'manual source shown');
  // selection is cleared after filling
  assert.equal(registry.get('selCount').textContent, '已选 0 孔');
});

test('clearing manual standards restores the design standards', async () => {
  registry.get('btnClearWells').click();
  await settle();
  assert.deepEqual(posted[posted.length - 1], {});
  const stdRows = registry.get('stdTable')._tbody.innerHTML;
  assert.equal((stdRows.match(/设计/g) || []).length, 15);
  assert.equal(rowsIn(registry.get('stdTable')._tbody), 15);
});

test('page survives a missing experiment (404) without throwing', async () => {
  const sandbox2 = Object.assign({}, sandbox, {
    fetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'no experiment loaded' }), text: async () => '' }),
    document: {
      getElementById: id => registry.get(id) || null,
      createElement: tag => makeEl(tag),
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
  });
  sandbox2.globalThis = sandbox2;
  vm.createContext(sandbox2);
  vm.runInContext(chartSrc, sandbox2, { filename: 'chart.js' });
  vm.runInContext(pageSrc, sandbox2, { filename: 'standard-curve.js' });
  await settle();
  assert.ok(/尚未加载实验/.test(registry.get('status').textContent));
  assert.equal(registry.get('fitCards').innerHTML.includes('无实验数据'), true);
});

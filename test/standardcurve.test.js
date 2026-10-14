'use strict';
// Standard curve: fit math, design integration, unknown quantification, exports.
const test = require('node:test');
const assert = require('node:assert/strict');
const curve = require('../lib/standardcurve.js');
const design = require('../lib/design.js');
const stats = require('../lib/stats.js');
const { wellLabel } = require('../lib/lc96p.js');

const close = (actual, expected, tol = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tol, `${actual} != ${expected}`);

test('perfect 10-fold series: slope −3.3219, R²=1, 100% efficiency, quantification round-trips', () => {
  const slope = -Math.log2(10);                      // −3.321928094887362
  const pts = [1e6, 1e5, 1e4, 1e3].map((q, i) => ({ quantity: q, cq: 20 + Math.abs(slope) * i }));
  const fit = curve.fitStandardCurve(pts);
  assert.equal(fit.ok, true);
  assert.equal(fit.n, 4);
  close(fit.slope, slope, 1e-12);
  close(fit.intercept, 20 + Math.abs(slope) * 6, 1e-12);
  close(fit.r2, 1, 1e-12);
  close(fit.efficiency, 1, 1e-12);
  close(fit.efficiencyPct, 100, 1e-9);
  close(fit.residualSd, 0, 1e-12);
  for (const p of pts) close(curve.quantify(curve.fittedCq(p.quantity, fit), fit), p.quantity, 1e-6 * p.quantity);
});

test('least squares matches the closed form and reports the efficiency CI', () => {
  const pts = [
    { quantity: 1e7, cq: 16.4 }, { quantity: 1e6, cq: 19.9 }, { quantity: 1e5, cq: 23.5 },
    { quantity: 1e4, cq: 26.6 }, { quantity: 1e3, cq: 30.2 },
  ];
  const fit = curve.fitStandardCurve(pts);
  // independent closed form
  const xs = pts.map(p => Math.log10(p.quantity)), ys = pts.map(p => p.cq);
  const xb = xs.reduce((a, b) => a + b, 0) / xs.length, yb = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxx = 0, sxy = 0;
  xs.forEach((x, i) => { sxx += (x - xb) ** 2; sxy += (x - xb) * (ys[i] - yb); });
  const slope = sxy / sxx;
  close(fit.slope, slope, 1e-12);
  close(fit.intercept, yb - slope * xb, 1e-12);
  close(fit.efficiency, Math.pow(10, -1 / slope) - 1, 1e-12);
  assert.equal(fit.efficiencyPctRange.length, 2);
  assert.ok(fit.efficiencyPctRange[0] < fit.efficiencyPct && fit.efficiencyPct < fit.efficiencyPctRange[1]);
  assert.equal(fit.dynamicRange === undefined, true);           // only quantityRange is exposed
  assert.deepEqual(fit.quantityRange, [1e3, 1e7]);
  assert.equal(fit.residuals.length, 5);
  assert.ok(fit.residuals.every(r => Math.abs(r.residual) < 1));
});

test('degenerate inputs are rejected instead of producing a curve', () => {
  assert.equal(curve.fitStandardCurve([]).ok, false);
  assert.equal(curve.fitStandardCurve([{ quantity: 1e6, cq: 20 }]).ok, false);
  const same = curve.fitStandardCurve([{ quantity: 1e6, cq: 20 }, { quantity: 1e6, cq: 21 }]);
  assert.equal(same.ok, false);
  assert.match(same.error, /斜率/);
  // non-positive / missing concentration or Cq rows are ignored, not fitted as 0
  const mixed = curve.fitStandardCurve([
    { quantity: 1e4, cq: 28 }, { quantity: 0, cq: 12 }, { quantity: 1e3, cq: null }, { quantity: 1e2, cq: 34.64 },
  ]);
  assert.equal(mixed.n, 2);
  assert.equal(mixed.ok, true);
  // flat slope -> warning, null efficiency
  const flat = curve.fitStandardCurve([{ quantity: 1e6, cq: 20 }, { quantity: 1e5, cq: 20 }]);
  assert.equal(flat.ok, true);
  assert.equal(flat.efficiencyPct, null);
  assert.ok(flat.warnings.some(w => /斜率为正|无扩增/.test(w)));
});

test('tQuantile returns textbook two-sided critical values', () => {
  for (const [alpha, df, expected] of [[0.05, 1, 12.7062047364], [0.05, 2, 4.30265272975], [0.05, 10, 2.22813885196], [0.01, 1, 63.6567411629], [0.05, 30, 2.04227245630]]) {
    close(stats.tQuantile(alpha, df), expected, 1e-6);
  }
  assert.ok(Number.isNaN(stats.tQuantile(0, 10)));
  assert.ok(Number.isNaN(stats.tQuantile(0.05, 0)));
});

test('well label helpers round-trip A1..H12', () => {
  for (let id = 1; id <= 96; id++) {
    assert.equal(curve.labelToId(wellLabel(id)), id);
  }
  assert.equal(curve.labelToId('I1'), null);
  assert.equal(curve.labelToId('A13'), null);
  assert.equal(curve.labelToId('a1'), 1);
});

// ---------------------------------------------------------------------------
// design-driven synthesis: standard series is generated, plate layout agrees,
// and standards stay out of the ΔΔCt / statistics path.
// ---------------------------------------------------------------------------
function designSpec(extra) {
  return Object.assign({
    groups: [{ name: '对照组' }, { name: '处理组' }],
    bioReps: 3, techReps: 3, targetGene: 'IL6', refGene: 'GAPDH',
    foldChange: 4, direction: 'down', quality: 'good', seed: 42,
    standards: { enabled: true, points: 5, replicates: 3, startQuantity: 1e7, dilution: 5, unit: 'copies' },
  }, extra || {});
}
// simulate a perfect engine run: truth Cq becomes the measured Cq, and wells
// without amplification (NTC) come back as Negative — same shape as the real engine
function withEngineResults(experiment, truth) {
  const computed = {};
  for (const id of Object.keys(truth)) {
    const t = truth[id];
    if (t.trueCq === null || t.trueCq === undefined) {
      computed[id + '|SYBR Green I'] = { '11 Intermediate Call': 'Negative', '26 CT1': 100 };
      continue;
    }
    computed[id + '|SYBR Green I'] = { '11 Intermediate Call': 'Positive', '26 CT1': t.trueCq };
  }
  experiment.computed = computed;
  return experiment;
}

test('design with standards: plate layout, truth quantities and well count all agree', () => {
  const spec = designSpec();
  const der = design.deriveDesign(spec);
  const { experiment, layout, truth } = design.synthesizeFromDesign(spec);
  assert.equal(der.totalWells, 53);                      // 36 样本 + 2 NTC + 15 标准品
  assert.equal(der.standardWells, 15);
  assert.deepEqual(der.issues, []);
  assert.deepEqual(der.warnings, []);
  assert.equal(der.standards.points.length, 5);
  close(der.standards.designedEfficiencyPct, 98, 1e-9);
  close(der.standards.designedSlope, -1 / Math.log10(1.98), 1e-4);
  // Cq ladder is geometric: ΔCq = ln(dilution)/ln(1+E)
  const expectedStep = Math.log(5) / Math.log(1.98);
  for (let i = 1; i < 5; i++) {
    close(der.standards.points[i].cq - der.standards.points[i - 1].cq, expectedStep, 0.02);
  }
  const stdIds = Object.keys(truth).filter(id => truth[id].role === 'standard');
  assert.equal(stdIds.length, 15);
  assert.equal(experiment.samples.filter(s => s.type === 'std').length, 5);
  // standards occupy A1..C3 (first 15 wells), each quantity repeated `replicates` times
  assert.deepEqual(stdIds.map(Number).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
  for (let i = 0; i < 5; i++) {
    for (let r = 0; r < 3; r++) {
      const t = truth[i * 3 + r + 1];
      assert.equal(t.quantity, 1e7 / Math.pow(5, i));
      assert.equal(t.unit, 'copies');
      assert.equal(t.gene, 'IL6');
    }
  }
  assert.equal(layout.A1.target, 'IL6');
  assert.match(layout.A1.simple, /^STD /);
  assert.equal(Object.keys(layout).length, 53);
});

test('standards set to disabled leaves the plate byte-identical to before the feature', () => {
  const base = { groups: [{ name: 'c' }, { name: 't' }], bioReps: 2, techReps: 2, seed: 7, quality: 'good' };
  const a = design.synthesizeFromDesign(base);
  const b = design.synthesizeFromDesign(Object.assign({}, base, { standards: { enabled: false, points: 5, replicates: 3 } }));
  assert.deepEqual(a.layout, b.layout);
  assert.deepEqual(a.truth, b.truth);
  assert.equal(a.derived.totalWells, 18);
  assert.equal(a.derived.standards, null);
});

test('standard wells never enter ΔCt/ΔΔCt/statistics, and QC counts them separately', () => {
  const spec = designSpec({ bioReps: 4 });
  const { experiment, truth } = design.synthesizeFromDesign(spec);
  withEngineResults(experiment, truth);
  const an = design.analyzeDesign(experiment, spec);
  assert.equal(an.groups.length, 2);                                    // one control + one treatment
  assert.equal(an.groups.some(g => /standard/i.test(g.name)), false);
  assert.equal(an.treatments.length, 1);
  assert.equal(an.treatments[0].n, 4);                                  // biological replicates only
  assert.ok(an.treatments[0].p < 0.01, 'Welch p = ' + an.treatments[0].p);
  assert.equal(an.qc.standards, 15);
  assert.equal(an.qc.ntc, 2);
  assert.equal(an.qc.ntcBad, 0);                                        // no NTC amplification at all
  // design self-check: refitting the truth Cq ladder recovers the designed efficiency
  const fit = an.standardCurve.truthFit;
  assert.equal(fit.ok, true);
  assert.ok(Math.abs(an.standardCurve.efficiencyDeviation) < 5, 'efficiency deviation ' + an.standardCurve.efficiencyDeviation);
  assert.ok(fit.r2 > 0.99);
});

test('analyzeStandardCurve fits from engine results and quantifies unknown samples', () => {
  const spec = designSpec();
  const { experiment, truth } = design.synthesizeFromDesign(spec);
  withEngineResults(experiment, truth);
  const res = curve.analyzeStandardCurve(experiment, { layoutNames: {} });
  assert.equal(res.ok, true);
  assert.equal(res.fromDesign, 15);
  assert.equal(res.manual, 0);
  assert.equal(res.standards.length, 15);
  assert.ok(res.standards.every(r => r.source === 'design' && r.call === 'Positive'));
  assert.equal(res.fit.ok, true);
  assert.ok(Math.abs(res.fit.efficiencyPct - 98) < 5, 'efficiency ' + res.fit.efficiencyPct);
  assert.ok(res.fit.r2 > 0.99);
  // unknown wells: 36 sample wells, all quantified
  assert.equal(res.unknowns.length, 36);
  assert.ok(res.unknowns.every(r => r.quantity > 0));
  assert.equal(res.samples.length, 6);                                  // 3 control + 3 treatment samples
  // control samples were designed at 1e7 copies-equivalent Cq≈16.7, treatment 4x lower
  const ctrl = res.samples.filter(s => /Control/.test(s.sample));
  const treat = res.samples.filter(s => /Treatment/.test(s.sample));
  assert.equal(ctrl.length, 3);
  assert.equal(treat.length, 3);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const ratio = mean(ctrl.map(s => s.meanQuantity)) / mean(treat.map(s => s.meanQuantity));
  assert.ok(ratio > 2 && ratio < 8, 'control/treatment quantity ratio ' + ratio);   // designed 4x
  assert.deepEqual(res.warnings, []);
});

test('manual standards override the design, and clearing restores it', () => {
  const spec = designSpec();
  const { experiment, truth } = design.synthesizeFromDesign(spec);
  withEngineResults(experiment, truth);
  // take the 15 design wells but declare only 3 of them manually, with different quantities
  const manual = {
    A1: { quantity: 1e6, unit: 'ng/µL' },
    A2: { quantity: 1e5, unit: 'ng/µL' },
    A3: { quantity: 1e4, unit: 'ng/µL' },
  };
  const res = curve.analyzeStandardCurve(experiment, { manual });
  assert.equal(res.manual, 3);
  assert.equal(res.standards.length, 15);                                // design wells still present
  const a1 = res.standards.find(r => r.label === 'A1');
  assert.equal(a1.quantity, 1e6);
  assert.equal(a1.unit, 'ng/µL');
  assert.equal(a1.source, 'manual');
  // clearing a well removes the design entry too (mergeStandards delete branch)
  const cleared = curve.mergeStandards({ A1: { quantity: 1e7, unit: 'copies' }, B1: { quantity: 1e6, unit: 'copies' } },
    { A1: { quantity: '' } });
  assert.equal(cleared.A1, undefined);
  assert.equal(cleared.B1.quantity, 1e6);
  // an all-manual plate with no design standards still fits
  const bare = { id: 'x', name: 'manual.lc96p', dyes: ['SYBR Green I'], wells: [], computed: {} };
  for (let q = 0; q < 4; q++) {
    const id = q + 1;
    bare.wells.push({ id, label: wellLabel(id), sampleId: 's' + q, sampleName: 'S' + q, sampleType: 'std' });
    bare.computed[id + '|SYBR Green I'] = { '11 Intermediate Call': 'Positive', '26 CT1': 20 + 3.3219 * q };
  }
  const manualFit = curve.analyzeStandardCurve(bare, {
    manual: { A1: { quantity: 1e6 }, A2: { quantity: 1e5 }, A3: { quantity: 1e4 }, A4: { quantity: 1e3 } },
  });
  assert.equal(manualFit.fromDesign, 0);
  assert.equal(manualFit.manual, 4);
  assert.equal(manualFit.fit.ok, true);
  assert.ok(Math.abs(manualFit.fit.efficiencyPct - 100) < 0.05, 'efficiency ' + manualFit.fit.efficiencyPct);
});

test('non-Positive standards are excluded from the fit and reported', () => {
  const spec = designSpec({ standards: { enabled: true, points: 4, replicates: 1, startQuantity: 1e7, dilution: 10 } });
  const { experiment, truth } = design.synthesizeFromDesign(spec);
  withEngineResults(experiment, truth);
  // last standard point fails to amplify
  const lastId = Object.keys(truth).map(Number).filter(id => truth[id].role === 'standard').sort((a, b) => b - a)[0];
  experiment.computed[lastId + '|SYBR Green I'] = { '11 Intermediate Call': 'Negative', '26 CT1': 100 };
  const res = curve.analyzeStandardCurve(experiment, {});
  assert.equal(res.standards.length, 4);
  assert.equal(res.fit.n, 3);
  assert.ok(res.warnings.some(w => /未判定为 Positive/.test(w)));
  const row = res.standards.find(r => r.well === lastId);
  assert.equal(row.cq, null);
  assert.equal(row.call, 'Negative');
});

test('CSV export carries both sections, the fit header and no NaN', () => {
  const spec = designSpec();
  const { experiment, truth } = design.synthesizeFromDesign(spec);
  withEngineResults(experiment, truth);
  const csv = curve.toCsv(curve.analyzeStandardCurve(experiment, {}));
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('standard,1,A1'));       // section, wellId, label
  assert.ok(csv.includes('unknown,'));
  assert.ok(csv.includes('sampleSummary,'));
  assert.ok(/# slope,-?\d/.test(csv));
  assert.ok(!/NaN|undefined/.test(csv));
  const stdRows = csv.split('\r\n').filter(l => l.startsWith('standard,'));
  assert.equal(stdRows.length, 15);
});

test('design warnings fire when the standard Cq range leaves the engine calibration window', () => {
  const der = design.deriveDesign(designSpec({ standards: { enabled: true, points: 5, replicates: 3, startQuantity: 1e4, dilution: 10 } }));
  assert.ok(der.warnings.some(w => /超出引擎校准区间/.test(w)), JSON.stringify(der.warnings));
  const ok = design.deriveDesign(designSpec());
  assert.deepEqual(ok.warnings, []);
  // plate overflow is still a blocking issue
  const over = design.deriveDesign(designSpec({ bioReps: 8, techReps: 3, groups: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }], standards: { enabled: true, points: 6, replicates: 3 } }));
  assert.ok(over.totalWells > 96);
  assert.ok(over.issues.some(i => /96/.test(i)));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../lib/stats');
const { analyzeDesign } = require('../lib/design');
const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('Student t two-sided analytic Cauchy cases and symmetry', () => {
  close(stats.ttestPaired([1, 3], [1, 1]).p, 0.5);
  close(stats.ttestPaired([0, 2], [1, 1]).p, 1);
  close(stats.ttestIndependent([1, 2, 3], [1, 2, 3]).p, 1);
  close(stats.ttestIndependent([1, 2, 3], [4, 5, 6]).p, 0.021311641128756727);
});

test('Yates correction cannot create association in balanced tables', () => {
  close(stats.chiSquare2x2(10, 10, 10, 10).chi2, 0);
  close(stats.chiSquare2x2(10, 10, 10, 10).p, 1);
});

test('Mann Whitney exact two-sided permutation p, including ties', () => {
  const x = [1, 2, 3], y = [4, 5, 6];
  const result = stats.mannWhitneyU(x, y);
  assert.equal(result.u, 0);
  assert.equal(result.method, 'exact');
  close(result.p, 0.1);
  close(stats.mannWhitneyU(y, x).p, result.p);
  close(stats.mannWhitneyU([1, 1], [2, 2]).p, 1 / 3);
  close(stats.mannWhitneyU([1, 1], [1, 1]).p, 1);
  assert.deepEqual(x, [1, 2, 3]);
  assert.throws(() => stats.mannWhitneyU([], [1]), /finite|sample/i);
  assert.throws(() => stats.mannWhitneyU([Infinity], [1]), /finite|sample/i);
});

test('Mann Whitney large samples use tie-corrected normal approximation', () => {
  const a = Array.from({length: 15}, (_, i) => i);
  const b = a.map(i => i + 20);
  const result = stats.mannWhitneyU(a, b);
  assert.equal(result.method, 'asymptotic');
  assert.ok(result.p > 0 && result.p < 0.00001);
  close(stats.mannWhitneyU(Array(15).fill(1), Array(15).fill(1)).p, 1);
});

test('Design tests biological means, not repeated technical wells', () => {
  const design = { targetGene: 'T', refGene: 'R' };
  const wells = [], truth = {}, computed = {};
  for (let g = 0; g < 2; g++) for (let b = 0; b < 3; b++) {
    for (const gene of ['T', 'R']) for (let r = 0; r < 3; r++) {
      const id = wells.length + 1;
      wells.push({id, sampleId: `${g}-${b}`, sampleName: `${g}-${b}`});
      truth[id] = { gene, groupIndex: g, group: `group${g}`, role: g ? 'treatment' : 'control', trueCq: 20 };
      computed[`${id}|SYBR Green I`] = {'11 Intermediate Call': 'Positive', '26 CT1': gene === 'R' ? 20 : 21 + b + 3 * g};
    }
  }
  const report = analyzeDesign({wells, computed, analysis: {synthetic: {truth}}}, design);
  assert.equal(report.treatments[0].n, 3);
  close(report.treatments[0].mannWhitney.p, 0.1);
  close(report.treatments[0].p, 0.021311641128756727);
});

test('Student t critical values and extreme tails remain probabilities', () => {
  for (const [t, df] of [[12.7062047364, 1], [4.30265272975, 2], [2.22813885196, 10], [2.04227245630, 30]]) {
    close(stats.twoTailedP(t, df), 0.05, 1e-9);
  }
  close(stats.twoTailedP(1e-20, 10), 1);
  close(stats.twoTailedP(1e200, 10), 0);
  assert.ok(Number.isNaN(stats.twoTailedP(1, 0)));
  assert.ok(Number.isNaN(stats.twoTailedP(NaN, 2)));
  assert.ok(Number.isNaN(stats.ttestIndependent([1], [1, 2]).p));
  assert.ok(Number.isNaN(stats.ttestIndependent([1, 1], [2, 2]).p));
  assert.ok(Number.isNaN(stats.ttestPaired([1], [1]).p));
  assert.ok(Number.isNaN(stats.ttestPaired([1, 2], [1, 2]).p));
  assert.ok(Number.isNaN(stats.cohensD([1], [2])));
  assert.ok(Number.isNaN(stats.cohensD([1, 1], [2, 2])));
});

test('Chi square and public summaries handle normal and empty cases', () => {
  assert.ok(Number.isNaN(stats.chiSquare2x2(0, 0, 0, 0).p));
  assert.ok(Number.isNaN(stats.chiSquare2x2(1, 0, 1, 0).p));
  assert.ok(stats.chiSquare2x2(20, 1, 1, 20).p < 0.001);
  assert.equal(stats.summary([1, 2, 3]).mean, 2);
  assert.ok(Number.isNaN(stats.summary([]).min));
  for (const [p, label] of [[null, 'n.s.'], [0.0001, '***'], [0.005, '**'], [0.03, '*'], [0.5, 'n.s.']]) {
    assert.equal(stats.stars(p), label);
  }
  assert.equal(stats.foldChange(21, 20), 2);
});

test('Browser export shares the same probability calculation', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const context = {window: {}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/stats'), 'utf8'), context);
  close(context.window.QpcrStats.twoTailedP(1, 1), 0.5);
});

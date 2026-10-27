'use strict';
// ---------------------------------------------------------------------------
// Technical-replicate cleaning layer: unit tests + Python cross-validation.
//
// The EXPECTATIONS anchors below are produced by an independent Python
// implementation (test/cleaning-crossval.py, stdlib statistics only) —
// the same independent-verification practice used for lib/stats.js
// (see README「独立交叉验证」). Regenerate with:
//   python test/cleaning-crossval.py
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cleaning = require('../lib/cleaning');
const { seedRandom } = require('../lib/synthesize');

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

const w = (id, cq, call = 'Positive', label) => {
  const well = { id, cq, call };
  if (label) well.label = label;
  return well;
};

// Mirrors test/cleaning-crossval.py SCENARIOS.
const SCENARIOS = {
  recovery: {
    groups: [{ sample: 'S1', target: 'T', wells: [w(1, 19.8), w(2, 20.0), w(3, 20.2)] }],
    options: {},
  },
  outlier: {
    groups: [{ sample: 'S2', target: 'T', wells: [w(1, 20.0), w(2, 20.1), w(3, 20.2), w(4, 15.9)] }],
    options: {},
  },
  highcv: {
    groups: [{ sample: 'S3', target: 'T', wells: [w(1, 19.0), w(2, 20.0), w(3, 21.0), w(4, 22.0)] }],
    options: {},
  },
  keepOne: {
    groups: [{ sample: 'S4', target: 'T', wells: [w(1, 15.0), w(2, 25.0)] }],
    options: {},
  },
  missing: {
    groups: [{ sample: 'S5', target: 'T', wells: [w(1, 20.0), w(2, 20.2), w(3, null, 'Negative'), w(4, null, 'Invalid')] }],
    options: {},
  },
  impute: {
    groups: [{ sample: 'S5', target: 'T', wells: [w(1, 20.0), w(2, 20.2), w(3, null, 'Negative'), w(4, null, 'Invalid')] }],
    options: { missingRule: 'impute' },
  },
  allMissing: {
    groups: [
      { sample: 'S6', target: 'T', wells: [w(1, null, 'Negative'), w(2, null, 'Invalid')] },
      { sample: 'S7', target: 'T', wells: [w(3, 21.0), w(4, 21.1)] },
    ],
    options: {},
  },
};

// Expected per-group outcomes, independently computed by Python
// (test/cleaning-crossval.py). NaN summaries mark unusable groups.
const EXPECT = {
  recovery: { n: 3, mean: 20.0, sd: 0.1999999999999993, cv: 0.009999999999999964,
    wells: [[1, 'used', ''], [2, 'used', ''], [3, 'used', '']], warnings: [], statsN: 3 },
  outlier: { n: 3, mean: 20.099999999999998, sd: 0.09999999999999964, cv: 0.004975124378109435,
    wells: [[1, 'used', ''], [2, 'used', ''], [3, 'used', ''], [4, 'excluded', 'outlier']],
    warnings: [], statsN: 3 },
  highcv: { n: 2, mean: 21.5, sd: 0.7071067811865476, cv: 0.03288868749704872,
    wells: [[1, 'excluded', 'outlier'], [2, 'excluded', 'outlier'], [3, 'used', ''], [4, 'used', '']],
    warnings: [], statsN: 2 },
  keepOne: { n: 1, mean: 25.0, sd: 0.0, cv: 0.0,
    wells: [[1, 'excluded', 'outlier'], [2, 'used', '']], warnings: [], statsN: 1 },
  missing: { n: 2, mean: 20.1, sd: 0.141421356237309, cv: 0.007035888370015373,
    wells: [[1, 'used', ''], [2, 'used', ''], [3, 'excluded', 'negative'], [4, 'excluded', 'invalid']],
    warnings: [], statsN: 2 },
  impute: { n: 4, mean: 30.05, sd: 11.489560478973946, cv: 0.38234810246169537,
    wells: [[1, 'used', ''], [2, 'used', ''], [3, 'imputed', 'imputed_negative'], [4, 'imputed', 'imputed_invalid']],
    warnings: [], statsN: 4 },
};

for (const [name, exp] of Object.entries(EXPECT)) {
  test(`cross-validated vs Python: ${name}`, () => {
    const res = cleaning.cleanReplicates(SCENARIOS[name].groups, SCENARIOS[name].options);
    const g = res.groups[0];
    assert.equal(g.n, exp.n);
    close(g.mean, exp.mean);
    close(g.sd, exp.sd);
    close(g.cv, exp.cv);
    assert.deepEqual(g.wells.map(x => [x.id, x.status, x.reason]), exp.wells);
    assert.deepEqual(g.warnings, exp.warnings);
    assert.equal(res.statsInput.length, 1);
    assert.equal(res.statsInput[0].n, exp.statsN);
    close(res.statsInput[0].mean, exp.mean);
  });
}

test('all-missing group warns and stays out of the statistics input', () => {
  const res = cleaning.cleanReplicates(SCENARIOS.allMissing.groups);
  assert.equal(res.groups.length, 2);
  const dead = res.groups[0];
  assert.equal(dead.usable, false);
  assert.equal(dead.n, 0);
  assert.ok(Number.isNaN(dead.mean));
  assert.deepEqual(dead.warnings, ['all_replicates_missing']);
  const alive = res.groups[1];
  assert.equal(alive.usable, true);
  close(alive.mean, 21.05);
  // statsInput is the ONLY downstream input: the dead group is absent
  assert.deepEqual(res.statsInput.map(s => s.sample), ['S7']);
  assert.deepEqual(res.warnings, ['all_replicates_missing: S6 / T']);
});

test('undetermined calls (no Call field) are excluded with reason, not silently used', () => {
  const res = cleaning.cleanReplicates([{ sample: 'S', target: 'T', wells: [w(1, 20.0), w(2, 20.1), { id: 3, cq: null, call: '' }] }]);
  const g = res.groups[0];
  assert.equal(g.n, 2);
  assert.deepEqual(g.wells[2].status, 'excluded');
  assert.equal(g.wells[2].reason, 'undetermined');
});

test('imputed wells never trigger removal of measured wells', () => {
  const res = cleaning.cleanReplicates(SCENARIOS.impute.groups, { missingRule: 'impute' });
  const g = res.groups[0];
  assert.equal(g.nOutliers, 0, 'real wells must survive next to the imputed Cq=40 block');
  assert.deepEqual(g.wells.map(x => x.status), ['used', 'used', 'imputed', 'imputed']);
});

test('a group of only imputed wells warns instead of entering statistics silently', () => {
  const res = cleaning.cleanReplicates(
    [{ sample: 'S', target: 'T', wells: [w(1, null, 'Negative'), w(2, null, 'Negative')] }],
    { missingRule: 'impute' });
  const g = res.groups[0];
  assert.equal(g.n, 2);
  assert.deepEqual(g.warnings, ['all_replicates_imputed']);
  assert.match(res.warnings[0], /^all_replicates_imputed: S \/ T$/);
});

test('input groups are not mutated', () => {
  const groups = [{ sample: 'S', target: 'T', wells: [w(1, 20.0), w(2, 30.0, 'Negative')] }];
  const snapshot = JSON.parse(JSON.stringify(groups));
  cleaning.cleanReplicates(groups, { missingRule: 'impute' });
  assert.deepEqual(groups, snapshot);
});

test('option validation rejects nonsensical thresholds and rules', () => {
  assert.throws(() => cleaning.cleanReplicates([], { cvThreshold: 0 }), RangeError);
  assert.throws(() => cleaning.cleanReplicates([], { cvThreshold: -0.1 }), RangeError);
  assert.throws(() => cleaning.cleanReplicates([], { cvThreshold: NaN }), RangeError);
  assert.throws(() => cleaning.cleanReplicates([], { deviationThreshold: -1 }), RangeError);
  assert.throws(() => cleaning.cleanReplicates([], { minReplicates: 0 }), RangeError);
  assert.throws(() => cleaning.cleanReplicates([], { minReplicates: 1.5 }), RangeError);
  assert.throws(() => cleaning.cleanReplicates([], { missingRule: 'drop' }), RangeError);
  assert.throws(() => cleaning.cleanReplicates([], { imputeCq: Infinity }), RangeError);
  assert.throws(() => cleaning.cleanReplicates('nope'), TypeError);
});

test('minReplicates guards the outlier pass', () => {
  const groups = [{ sample: 'S', target: 'T', wells: [w(1, 15.0), w(2, 25.0)] }];
  const res = cleaning.cleanReplicates(groups, { minReplicates: 2 });
  assert.equal(res.groups[0].n, 2, 'no well may be removed below minReplicates');
});

test('cleaning recovers design mean and replicate SD from seeded simulated data', () => {
  // Replicates drawn around a known true Cq with a known technical SD;
  // the cleaned summary must be self-consistent with the design parameters.
  const rand = seedRandom(42);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const techSd = 0.2, trueCq = 20;
  const groups = [];
  for (let s = 1; s <= 4; s++) {
    const wells = [];
    for (let r = 0; r < 4; r++) {
      wells.push({ id: s * 10 + r, cq: trueCq + gauss() * techSd, call: 'Positive' });
    }
    groups.push({ sample: 'Sample' + s, target: 'T', wells });
  }
  const res = cleaning.cleanReplicates(groups);
  const pooledMeans = res.statsInput.map(s => s.mean);
  const meanOfMeans = pooledMeans.reduce((a, b) => a + b, 0) / pooledMeans.length;
  close(meanOfMeans, trueCq, 0.15);
  const pooledSds = res.statsInput.map(s => s.sd);
  const meanSd = pooledSds.reduce((a, b) => a + b, 0) / pooledSds.length;
  close(meanSd, techSd, 0.15);
  // every sample must survive into the statistics input — removals may
  // shrink n but never delete a (sample × target) group
  assert.equal(res.statsInput.length, 4);
  assert.ok(res.statsInput.every(s => s.n >= 1));
});

test('grouping: buildGroups aggregates wells into (sample × target) replicate groups', () => {
  const wells = [
    { id: 1, label: 'A1', sampleName: 'ctrl-1' }, { id: 2, label: 'A2', sampleName: 'ctrl-1' },
    { id: 3, label: 'A3', sampleName: 'ctrl-1' }, { id: 4, label: 'A4', sampleName: 'ctrl-1' },
    { id: 5, label: 'B1' },                                     // no sample → skipped
  ];
  const assignments = {
    1: { sample: 'ctrl-1', target: 'IL6' }, 2: { sample: 'ctrl-1', target: 'IL6' },
    3: { sample: 'ctrl-1', target: 'GAPDH' }, 4: { sample: 'ctrl-1', target: 'GAPDH' },
  };
  const computed = {
    '1|SYBR Green I': { '11 Intermediate Call': 'Positive', '26 CT1': 20.1 },
    '2|SYBR Green I': { '11 Intermediate Call': 'Positive', '26 CT1': 20.3 },
    '3|SYBR Green I': { '11 Intermediate Call': 'Positive', '26 CT1': 18.0 },
    '4|SYBR Green I': { '11 Intermediate Call': 'Negative', '26 CT1': null },
  };
  const groups = cleaning.buildGroups(wells, assignments, computed, 'SYBR Green I');
  assert.equal(groups.length, 2);
  const il6 = groups.find(g => g.target === 'IL6');
  assert.equal(il6.wells.length, 2);
  close(il6.wells[0].cq, 20.1);
  const gapdh = groups.find(g => g.target === 'GAPDH');
  assert.deepEqual(gapdh.wells.map(x => x.call), ['Positive', 'Negative']);
  assert.equal(gapdh.wells[1].cq, null);
});

test('grouping: assignByConventions maps layout targets and internal-control wells', () => {
  const exp = {
    wells: [
      { id: 1, label: 'A1', sampleName: 's1' }, { id: 2, label: 'A2', sampleName: 's1' },
      { id: 3, label: 'A3', sampleName: 's1' }, { id: 4, label: 'A4', sampleName: 'IC' },
    ],
    settings: { internalControlWells: [4], internalControlGene: 'GAPDH' },
  };
  const layoutNames = { A1: { target: 'IL6' }, A2: { target: 'IL6' }, A3: { target: 'IL6' } };
  const a = cleaning.assignByConventions(exp, layoutNames);
  assert.deepEqual(a[1], { sample: 's1', target: 'IL6' });
  assert.deepEqual(a[4], { sample: 'IC', target: 'GAPDH' });
  assert.equal(a[2].target, 'IL6');
});

test('export: well-level CSV marks excluded and imputed wells with reasons', () => {
  const res = cleaning.cleanReplicates(
    [{ sample: 'S5', target: 'T', wells: [w(1, 20.0, 'Positive', 'A1'), w(2, 20.2, 'Positive', 'A2'), w(3, null, 'Negative', 'A3'), w(4, 15.0, 'Positive', 'A4')] }]);
  const csv = cleaning.toCSV(res);
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'BOM for Excel');
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], 'Sample,Target,Well,Call,Cq,Status,Reason,GroupN,GroupMean,GroupSD,GroupCV');
  assert.match(csv, /A4,Positive,15,excluded,outlier/);
  assert.match(csv, /A3,Negative,,excluded,negative/);
  const summary = cleaning.summaryToCSV(res);
  assert.match(summary, /S5,T,2,20\.1,/);
});

test('browser build exposes the same implementation as window.QpcrCleaning', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/cleaning'), 'utf8'), context);
  const g = [{ sample: 'S', target: 'T', wells: [w(1, 20.0), w(2, 20.1), w(3, 15.0)] }];
  const browser = context.window.QpcrCleaning.cleanReplicates(g).groups[0];
  const node = cleaning.cleanReplicates(g).groups[0];
  assert.equal(browser.n, node.n);
  close(browser.mean, node.mean);
});

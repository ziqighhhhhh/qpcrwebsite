'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { synthesize, synthesizeFromLayout, seedRandom } = require('../lib/synthesize');
const { synthesizeFromDesign, normalizeDesign } = require('../lib/design');
const layout = Object.freeze({
  A1: Object.freeze({ target: 'IL6', simple: 'control' }),
  A2: Object.freeze({ target: 'IL6', simple: 'treated' }),
  A3: Object.freeze({ target: 'IL6', simple: 'NTC' }),
  A4: Object.freeze({ target: 'GAPDH', simple: 'IC' }),
});
const generators = [
  ['simple', seed => synthesize({ seed, samplesPerGroup: 1, replicates: 2, includeIc: true, includePos: true, meltPeaks: 2 })],
  ...['ideal', 'ic-drift', 'ntc-dimer', 'weak', 'high-cv'].map(bioMode => [
    'layout ' + bioMode, seed => synthesizeFromLayout(layout, { seed, bioMode, includeIc: true, meltPeaks: 2 }),
  ]),
  ...['excellent', 'good', 'fair', 'poor'].map(quality => [
    'design ' + quality, seed => synthesizeFromDesign({ seed, quality, bioReps: 2, techReps: 2 }).experiment,
  ]),
];
// IDs and serialized timestamps identify an execution, not its scientific data.
const scientificData = ({ curves, melt, analysis }) => ({ curves, melt, truth: analysis.synthetic.truth });

for (const [name, generate] of generators) {
  test(name + ': reproducible seeds including zero without global RNG changes', () => {
    const originalRandom = Math.random;
    for (const seed of [0, 7]) {
      const first = scientificData(generate(seed));
      generate(88);
      assert.deepEqual(scientificData(generate(seed)), first);
      assert.notDeepEqual(scientificData(generate(seed + 1)), first);
      assert.strictEqual(Math.random, originalRandom);
    }
  });
  test(name + ': unseeded runs do not inherit the preceding seed', () => {
    generate(7);
    const first = scientificData(generate(undefined));
    generate(7);
    assert.notDeepEqual(scientificData(generate(undefined)), first);
  });
}

test('independent seeded streams retain state when interleaved', () => {
  const first = seedRandom(0), second = seedRandom(0), other = seedRandom(99);
  for (let i = 0; i < 100; i++) {
    const actual = first();
    other();
    assert.equal(second(), actual);
    assert.ok(actual >= 0 && actual < 1);
  }
});

test('absent seeds use the native random source', () => {
  for (const seed of [undefined, null, '']) assert.strictEqual(seedRandom(seed), Math.random);
});

test('normalization preserves numeric/string zero and treats absent or invalid seeds as absent', () => {
  for (const seed of [0, '0']) assert.equal(normalizeDesign({ seed }).seed, 0);
  for (const seed of [undefined, null, '', 'invalid']) assert.equal(normalizeDesign({ seed }).seed, null);
});

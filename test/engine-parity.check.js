'use strict';
// ---------------------------------------------------------------------------
// Real-engine self check (not part of the *.test.js contract suite).
//
//   node test/engine-parity.check.js
//
// Proves three things without a browser:
//   1. the x86 bridge really starts and the original Roche Kinetic engine runs
//      (a missing engine, a missing engine-bridge.exe.config or a pruned DLL
//      all surface here as a hard failure);
//   2. the Cq / Slope / EPF / Call it returns equal the results Roche stored
//      inside the .lc96p file itself (calculated_data.xml -> storedQual);
//   3. every curve of every .lc96p in ..\experiments gets a parameter set, so
//      nothing silently falls back to a JS approximation.
//
// Exit code 0 = real engine verified, 1 = something is wrong.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { parseLc96p } = require('../lib/lc96p');
const engine = require('../lib/engine');

const projectDir = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(projectDir, 'config.json'), 'utf8'));
const rootDir = path.dirname(config.binDir);
const DEMO = path.join(rootDir, 'DemoData', 'Demo_Qual Detect Dual Color.lc96p');
const EXP_DIR = path.join(rootDir, 'experiments');

const PARAM = { cq: '26 CT1', slope: '23 MRS', epf: '78 LC96 Normalized ERI', call: '11 Intermediate Call' };
const failures = [];
function check(name, cond, detail) {
  if (!cond) failures.push(name + (detail ? ' (' + detail + ')' : ''));
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
}

engine.configure({ binDir: config.binDir, projectDir, adf: config.adf || 'Gen-KA.adf' });

(async () => {
  // ---- 1. engine vs the results stored inside the file -------------------
  check('demo file present', fs.existsSync(DEMO), DEMO);
  if (fs.existsSync(DEMO)) {
    const exp = parseLc96p(fs.readFileSync(DEMO), path.basename(DEMO));
    await engine.analyzeExperiment(exp);
    const computed = exp.computed || {};
    const refKeys = Object.keys(exp.storedQual || {});
    check('engine returned a result for every curve', Object.keys(computed).length === exp.curves.length,
      Object.keys(computed).length + '/' + exp.curves.length);
    check('file carries reference results to compare against', refKeys.length > 0, refKeys.length + ' wells');

    let compared = 0;
    const bad = [];
    for (const key of refKeys) {
      const ref = exp.storedQual[key], got = computed[key];
      if (!got) { bad.push(key + ' missing'); continue; }
      for (const field of Object.keys(PARAM)) {
        if (ref[field] === undefined) continue;
        compared++;
        const a = ref[field], b = got[PARAM[field]];
        const same = typeof a === 'number'
          ? (typeof b === 'number' && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a)))
          : String(a) === String(b);
        if (!same && bad.length < 8) bad.push(`${key} ${field}: file=${a} engine=${b}`);
      }
    }
    check('Cq/Slope/EPF/Call match the stored Roche results', bad.length === 0 && compared > 0,
      compared + ' values compared' + (bad.length ? '; ' + bad.join('; ') : ''));
  }

  // ---- 2. every real experiment gets full coverage -----------------------
  const files = fs.existsSync(EXP_DIR) ? fs.readdirSync(EXP_DIR).filter(f => /\.lc96p$/i.test(f)) : [];
  check('real experiments found', files.length > 0, files.length + ' file(s) in ' + EXP_DIR);
  for (const file of files) {
    const exp = parseLc96p(fs.readFileSync(path.join(EXP_DIR, file)), file);
    await engine.analyzeExperiment(exp);
    const n = Object.keys(exp.computed || {}).length;
    const withCq = Object.values(exp.computed || {}).filter(p => p && p[PARAM.cq] !== undefined).length;
    check('engine coverage ' + file, n === exp.curves.length && withCq === n, n + '/' + exp.curves.length + ' with Cq');
  }

  if (failures.length) {
    console.log('\n' + failures.length + ' CHECK(S) FAILED — the real engine is not usable:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('\nREAL ENGINE OK — every value below came from Roche.DP.CalcPack (Kinetic 1.5.3.1244), no JS fallback.');
})().catch(e => {
  console.error('REAL ENGINE CHECK FAILED: ' + (e && e.stack || e));
  process.exit(1);
});

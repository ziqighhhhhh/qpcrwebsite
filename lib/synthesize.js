'use strict';
// ---------------------------------------------------------------------------
// Synthetic qPCR experiment generator (from-scratch, 4PL model).
// Input is simulated; everything downstream (upload -> original engine ->
// visualization) is the REAL pipeline. Parameters are constrained to
// physically reasonable ranges (validated by the frontend too).
// ---------------------------------------------------------------------------
const { zipStore } = require('./export.js');

function gauss() { // Box-Muller, standard normal
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function wellLabel(n) { return String.fromCharCode(64 + Math.ceil(n / 12)) + (((n - 1) % 12) + 1); }

// 4-parameter logistic amplification curve
// F(c) = base + amp / (1 + exp(-k*(c - Cq)))
function amplify(c, base, amp, k, cq) {
  return base + amp / (1 + Math.exp(-k * (c - cq)));
}

const PARAM_LIMITS = {
  groups: { min: 2, max: 4 },
  samplesPerGroup: { min: 1, max: 8 },
  replicates: { min: 1, max: 3 },
  foldChange: { min: 1.5, max: 20 },        // treatment vs control expression ratio
  bioCv: { min: 5, max: 40 },               // biological CV % within group
  techSd: { min: 0.05, max: 1.0 },          // technical replicate Ct SD
  efficiency: { min: 80, max: 115 },        // % (90-110 typical, hard 80-115)
  ctBase: { min: 15, max: 30 },             // control group baseline Ct
  noiseLevel: { min: 1, max: 3 },           // baseline noise level (low/mid/high)
  meltPeaks: { min: 1, max: 2 },            // 1 = specific single peak, 2 = + primer dimer
};

function checkParams(p) {
  const issues = [];
  const check = (key, v) => {
    const L = PARAM_LIMITS[key];
    if (v < L.min || v > L.max) issues.push(key + '=' + v + ' 超出合理范围 [' + L.min + ', ' + L.max + ']');
  };
  check('groups', p.groups); check('samplesPerGroup', p.samplesPerGroup); check('replicates', p.replicates);
  check('foldChange', p.foldChange); check('bioCv', p.bioCv); check('techSd', p.techSd);
  check('efficiency', p.efficiency); check('ctBase', p.ctBase); check('noiseLevel', p.noiseLevel);
  check('meltPeaks', p.meltPeaks);
  const total = p.groups * p.samplesPerGroup * p.replicates;
  if (total > 96) issues.push('总孔数 ' + total + ' 超过 96');
  return issues;
}

// build a synthetic experiment model
function synthesize(opts) {
  opts = opts || {};
  const p = {
    groups: clamp(opts.groups || 2, 2, 4),
    samplesPerGroup: clamp(opts.samplesPerGroup || 3, 1, 8),
    replicates: clamp(opts.replicates || 3, 1, 3),
    foldChange: clamp(opts.foldChange || 4, 1.5, 20),
    direction: opts.direction === 'down' ? 'down' : 'up', // treatment expression direction
    bioCv: clamp(opts.bioCv || 15, 5, 40),
    techSd: clamp(opts.techSd || 0.2, 0.05, 1.0),
    efficiency: clamp(opts.efficiency || 95, 80, 115),
    ctBase: clamp(opts.ctBase || 20, 15, 30),
    noiseLevel: clamp(opts.noiseLevel || 2, 1, 3),
    meltPeaks: clamp(opts.meltPeaks || 1, 1, 2),
    includeIc: !!opts.includeIc,       // internal control channel (Yellow555)
    includeNtc: opts.includeNtc !== false, // NTC wells
    includePos: !!opts.includePos,     // positive control wells
    seed: opts.seed,
  };
  const issues = checkParams(p);
  if (issues.length) throw new Error('参数越界: ' + issues.join('; '));
  if (p.seed) seedRandom(p.seed);

  // physics: efficiency -> curve steepness k (calibrated so MRS ~0.18-0.26 at 90-105%)
  const k = 0.30 + (p.efficiency - 90) * 0.02;          // 90% -> 0.30, 100% -> 0.50, 110% -> 0.70
  // base fluorescence + noise sigma per level
  const base = 0.004 + Math.random() * 0.002;
  const noise = [0.0004, 0.0012, 0.003][p.noiseLevel - 1];
  const amp0 = 2.2;                                     // plateau amplitude for reference Ct
  const mBase = 0.02, mSigma = 1.6, mTm = 85.0;         // melt single peak
  const nCycles = 40;

  const dyes = p.includeIc ? ['SYBR Green I', 'Yellow555'] : ['SYBR Green I'];
  const channelOf = { 'SYBR Green I': 0, 'Yellow555': 1 };
  // IC (internal control) target Ct: stable housekeeping-like, fixed near ctBase
  const icCt = clamp(p.ctBase, 18, 26);
  // fold -> deltaCt: fold = 2^deltaCt  =>  deltaCt = log2(fold)
  const deltaCt = Math.log2(p.foldChange);
  const groups = [];
  for (let g = 0; g < p.groups; g++) {
    groups.push({
      name: g === 0 ? '对照组 Control' : '处理组 Treatment',
      ct: p.ctBase + (g === 0 ? 0 : (p.direction === 'down' ? deltaCt : -deltaCt)),
    });
  }

  // samples & wells assignment
  const samples = [];
  const wells = [];
  const curves = [];
  const melt = {};
  let wellId = 1;
  const sampleIdx = [];

  // ---- per-dye engine calibration ----
  // SYBR channel  -> Sybr-KA.adf (threshold ~0.071 empirically)
  // Yellow555 (IC probe channel) -> Gen-KA.adf: linear fit CT1 = 0.8803*c0 - 11.107
  const th = 0.071;
  const makeCurve = (well, dye, channel, ct, targetId) => {
    let amp, kk, c0;
    if (dye === 'Yellow555') {
      amp = 1.8; kk = 0.5;
      c0 = (ct + 11.107) / 0.8803; // Gen-KA calibration
    } else {
      amp = Math.max(0.4, amp0 * Math.pow(2, (p.ctBase - ct) * 0.08)); // lower Ct -> higher plateau
      kk = k;
      c0 = ct + Math.log(amp / th - 1) / kk; // Sybr-KA calibration
    }
    const pts = [];
    for (let c = 1; c <= nCycles; c++) {
      const y = amplify(c, base, amp, kk, c0) + gauss() * noise;
      pts.push({ c, f: Math.max(0, y) });
    }
    return { well, dye, channel, targetId, points: pts };
  };
  // NTC: flat line at baseline with tiny instrument noise (~1e-4).
  // Empirical: engine classifies no-noise/below-1.2e-4-noise flat curves as Negative;
  // mid-level noise on a flat curve yields Invalid instead.
  const ntcNoise = noise * 0.1;
  const makeNtc = (well, dye, channel, targetId) => {
    const pts = [];
    for (let c = 1; c <= nCycles; c++) pts.push({ c, f: Math.max(0, base + gauss() * ntcNoise) });
    return { well, dye, channel, targetId, points: pts };
  };
  const makeMelt = (well, dye, ct) => {
    // specific peak height scales with product amount (like plateau)
    const ampScale = Math.max(0.3, Math.pow(2, (p.ctBase - ct) * 0.08));
    const peak = mBase + 0.06 * ampScale;
    const pts = [];
    for (let T = 65; T <= 96.9; T += 0.2) {
      let f = peak * Math.exp(-((T - mTm) * (T - mTm)) / (2 * mSigma * mSigma));
      if (p.meltPeaks === 2) { // primer-dimer: small early peak
        f += 0.02 * Math.exp(-((T - 72) * (T - 72)) / (2 * 1.2 * 1.2));
      }
      pts.push({ t: Math.round(T * 10) / 10, f: mBase + f + gauss() * noise * 0.5 });
    }
    return { well, dye, points: pts };
  };

  for (let g = 0; g < p.groups; g++) {
    for (let s = 0; s < p.samplesPerGroup; s++) {
      const sampleCq = groups[g].ct + (p.bioCv / 100) * groups[g].ct / 100 * gauss() * 3; // approx bio variation in Ct
      for (let r = 0; r < p.replicates; r++) {
        if (wellId > 96) break;
        const ct = sampleCq + gauss() * p.techSd;
        const sampleId = 'syn-' + g + '-' + s;
        const sampleName = groups[g].name.replace(/[^A-Za-z]/g, '') + ' ' + (s + 1);
        if (r === 0) {
          samples.push({ id: sampleId, description: sampleName, type: 'unkn' });
          sampleIdx.push({ well: wellId, sampleId });
        }
        wells[wellId - 1] = { id: wellId, label: wellLabel(wellId), sampleId, sampleName, sampleType: 'unkn' };
        const curve = makeCurve(wellId, 'SYBR Green I', 0, ct, 'SYBR Green I@Target');
        curves.push(curve);
        melt[wellId + '|SYBR Green I'] = makeMelt(wellId, 'SYBR Green I', ct);
        if (p.includeIc) {
          // internal control channel: stable Ct, small well-to-well spread (probe channel, no melt)
          const icCtWell = icCt + gauss() * Math.max(0.1, p.techSd * 0.5);
          curves.push(makeCurve(wellId, 'Yellow555', 1, icCtWell, 'Yellow555@Target'));
        }
        wellId++;
      }
    }
  }
  // positive control wells (strong, early Ct)
  if (p.includePos && wellId <= 92) {
    const posCt = Math.max(10, p.ctBase - 6);
    for (let i = 0; i < 2; i++) {
      if (wellId > 96) break;
      const sampleId = 'syn-pos-' + i;
      samples.push({ id: sampleId, description: 'PC ' + (i + 1), type: 'pos' });
      wells[wellId - 1] = { id: wellId, label: wellLabel(wellId), sampleId, sampleName: 'PC ' + (i + 1), sampleType: 'pos' };
      const ct = posCt + gauss() * 0.15;
      curves.push(makeCurve(wellId, 'SYBR Green I', 0, ct, 'SYBR Green I@Target'));
      melt[wellId + '|SYBR Green I'] = makeMelt(wellId, 'SYBR Green I', ct);
      if (p.includeIc) curves.push(makeCurve(wellId, 'Yellow555', 1, icCt + gauss() * 0.1, 'Yellow555@Target'));
      wellId++;
    }
  }
  // NTC wells (2 at the end of the plate)
  if (p.includeNtc && wellId <= 94) {
    for (let i = 0; i < 2; i++) {
      if (wellId > 96) break;
      const sampleId = 'syn-ntc-' + i;
      samples.push({ id: sampleId, description: 'NTC ' + (i + 1), type: 'ntc' });
      wells[wellId - 1] = { id: wellId, label: wellLabel(wellId), sampleId, sampleName: 'NTC ' + (i + 1), sampleType: 'ntc' };
      curves.push(makeNtc(wellId, 'SYBR Green I', 0, 'SYBR Green I@Target'));
      melt[wellId + '|SYBR Green I'] = { well: wellId, dye: 'SYBR Green I', points: [{ t: 65, f: mBase }, { t: 96.9, f: mBase }] };
      wellId++;
    }
  }
  // fill remaining wells as empty (no curve) but keep 96 wells
  for (; wellId <= 96; wellId++) {
    wells[wellId - 1] = { id: wellId, label: wellLabel(wellId), sampleId: null, sampleName: '', sampleType: '' };
  }

  return {
    id: 'syn-' + Date.now().toString(36),
    name: 'synthetic_experiment.lc96p',
    meta: { id: '', made: '', updated: '' },
    dyes, channelOf,
    samples,
    wells,
    curves,
    melt,
    factGraph: {},
    storedKinetic: {},
    storedQual: {},
    settings: { genes: [], samples: [], internalControlDye: '' },
    computed: {},
    analyzedAt: null,
    analysis: {
      adf: 'Sybr-KA.adf',
      engine: 'Roche Kinetic 1.5.3.1244 (synthetic input, real processing)',
      synthetic: { params: p, note: '输入为按参数合成的模拟数据；上传后由原引擎按真实流程分析' },
    },
  };
}

// deterministic RNG for reproducibility when seed is given
let seededState = null;
function seedRandom(seed) {
  let s = seed >>> 0;
  seededState = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  Math.random = seededState;
}

// serialize experiment model to .lc96p bytes (rdml + instrument + manifest)
function toLc96p(exp) {
  const esc = s => String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = v => String(Math.round(v * 1e6) / 1e6);
  const dyesXml = exp.dyes.map(d => '  <dye id="' + esc(d) + '" />').join('\n');
  const samplesXml = exp.samples.map(s =>
    '  <sample id="' + esc(s.id) + '">\n    <description>' + esc(s.description || '') + '</description>\n    <type>' + esc(s.type || 'unkn') + '</type>\n  </sample>').join('\n');
  const targetsXml = exp.dyes.map(d =>
    '  <target id="' + esc(d) + '@Target">\n    <type>ref</type>\n    <amplificationEfficiency>0</amplificationEfficiency>\n    <dyeId id="' + esc(d) + '" />\n  </target>').join('\n');
  const now = new Date().toISOString().slice(0, 19);
  const reactsXml = exp.wells.map(w => {
    if (!w.sampleId) return '';
    const wellCurves = exp.curves.filter(c => c.well === w.id);
    if (!wellCurves.length) return '';
    const dataXml = wellCurves.map(curve => {
      const adps = curve.points.map(p => '      <adp><cyc>' + num(p.c) + '</cyc><tmp>60</tmp><fluor>' + num(p.f) + '</fluor></adp>').join('\n');
      let mdps = '';
      const melt = exp.melt && exp.melt[w.id + '|' + curve.dye];
      if (melt && melt.points.length) mdps = melt.points.map(mp => '      <mdp><tmp>' + num(mp.t) + '</tmp><fluor>' + num(mp.f) + '</fluor></mdp>').join('\n');
      return '    <data>\n      <tar id="' + esc(curve.dye) + '@Target" />\n' + adps + (mdps ? '\n' + mdps : '') + '\n    </data>';
    }).join('\n');
    return '  <react id="' + w.id + '">\n    <sample id="' + esc(w.sampleId) + '" />\n' + dataXml + '\n  </react>';
  }).filter(Boolean).join('\n');
  const rdml = '<?xml version="1.0" encoding="utf-8"?>\n<rdml xmlns="http://www.rdml.org" version="1.1">\n  <dateMade>' + now + '</dateMade>\n  <dateUpdated>' + now + '</dateUpdated>\n  <id><publisher>qPCR Web simulator</publisher><serialNumber>SYN0001</serialNumber></id>\n' +
    dyesXml + '\n' + samplesXml + '\n' + targetsXml + '\n' +
    '  <thermalCyclingConditions id="syn-tcc">\n    <thermalProgram id="1" name="Preincubation"><step nr="1" /></thermalProgram>\n' +
    '    <thermalProgram id="2" name="2 Step Amplification"><step nr="2" /><step nr="3" /></thermalProgram>\n' +
    '    <thermalProgram id="3" name="Melting"><step nr="4" /></thermalProgram>\n  </thermalCyclingConditions>\n' +
    reactsXml + '\n</rdml>\n';
  const instrument = '<?xml version="1.0" encoding="utf-8"?>\n<rocheLC96InstrumentData xmlns="http://www.roche.ch/LC96InstrumentDataSchema" softwareVersion="1.02.00.0086">\n  <experiment id="' + exp.id + '" state="processed">\n    <detectionFormat>' + exp.dyes.map(d => '<channel dyeId="' + esc(d) + '" meltFactor="1.2" quantFactor="20" />').join('') + '</detectionFormat>\n  </experiment>\n</rocheLC96InstrumentData>\n';
  const manifest = '<?xml version="1.0" encoding="utf-8"?>\n<lc96manifest Version="1.00.00">\n  <experiment analysisPresent="false" dateUpdated="' + now + '" state="processed" />\n</lc96manifest>\n';
  return zipStore([
    { name: 'instrument_data.xml', data: Buffer.from(instrument, 'utf8') },
    { name: 'manifest.xml', data: Buffer.from(manifest, 'utf8') },
    { name: 'rdml_data.xml', data: Buffer.from(rdml, 'utf8') },
  ]);
}

module.exports = { synthesize, toLc96p, PARAM_LIMITS, checkParams };
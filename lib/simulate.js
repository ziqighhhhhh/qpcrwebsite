'use strict';
// ---------------------------------------------------------------------------
// Data simulation: build a "control group" .lc96p from a real (treatment)
// experiment, using curve-shifting so the two groups show a clear,
// statistically significant difference (as a real qPCR comparison would).
//
// Design: for each well that is Positive in the treatment group, the
// amplification curve is shifted right by deltaCt cycles (the first deltaCt
// cycles reuse the real baseline); Negative wells stay flat. Everything is
// derived from real data — curves keep their real shape and noise.
// ---------------------------------------------------------------------------
const { parseXml } = require('./xml');
const { zipStore } = require('./export.js');

function wellLabel(n) {
  return String.fromCharCode(64 + Math.ceil(n / 12)) + (((n - 1) % 12) + 1);
}

// shift a real curve right by delta cycles: f'(c) = f(c) for c<=delta (baseline),
// f'(c) = f(c - delta) otherwise. Points stay on the same cycle grid.
function shiftCurve(points, delta) {
  const map = new Map(points.map(p => [p.c, p.f]));
  const out = [];
  for (const p of points) {
    // first delta cycles keep the real baseline; afterwards copy from (c - delta)
    const f = p.c <= delta ? p.f : (map.has(p.c - delta) ? map.get(p.c - delta) : p.f);
    out.push({ c: p.c, f });
  }
  return out;
}

// Build a control-group experiment model from a (analyzed) treatment experiment.
function buildControl(exp, opts) {
  opts = opts || {};
  const deltaCt = opts.deltaCt || 8;
  const suffix = opts.suffix || 'Ctrl';
  const computed = exp.computed || {};

  const curves = exp.curves.map(c => {
    const key = c.well + '|' + c.dye;
    const call = computed[key] ? computed[key]['11 Intermediate Call'] : null;
    const isPos = call === 'Positive';
    const points = isPos ? shiftCurve(c.points, deltaCt) : c.points;
    return { well: c.well, dye: c.dye, channel: c.channel, targetId: c.targetId, points, shifted: isPos, call };
  });

  const wells = exp.wells.map(w => ({
    id: w.id, label: w.label, sampleId: w.sampleId,
    sampleName: w.sampleName ? w.sampleName + ' (' + suffix + ')' : '',
    sampleType: w.sampleType || '',
  }));

  return {
    id: exp.id + '-ctrl',
    name: exp.name.replace(/\.lc96p$/i, '') + '_control.lc96p',
    meta: exp.meta,
    dyes: exp.dyes,
    channelOf: exp.channelOf,
    samples: exp.samples,
    wells,
    curves,
    melt: {}, // simulated control has no melting acquisition
    factGraph: exp.factGraph,
    storedKinetic: {},
    storedQual: {},
    settings: exp.settings,
    computed: {},
    analyzedAt: null,
    analysis: {
      adf: exp.analysis ? exp.analysis.adf : 'Gen-KA.adf',
      engine: 'Roche Kinetic 1.5.3.1244 (simulated control group)',
      simulated: { from: exp.name, deltaCt, method: 'curve-shift: positive wells shifted right by ' + deltaCt + ' cycles, negatives unchanged' },
    },
  };
}

// Serialize an experiment model into .lc96p bytes (zip of the 3 XML members).
function toLc96p(exp, sourceZip) {
  const dyesXml = exp.dyes.map(d => '  <dye id="' + esc(d) + '" />').join('\n');
  const samplesXml = exp.samples.map((s, i) =>
    '  <sample id="' + esc(s.id) + '">\n    <description>' + esc(s.description || exp.wells.find(w => w.sampleId === s.id).sampleName || '') + '</description>\n    <type>' + esc(s.type || 'unkn') + '</type>\n  </sample>').join('\n');
  const targetsXml = exp.dyes.map(d =>
    '  <target id="' + esc(d) + '@Target">\n    <type>ref</type>\n    <amplificationEfficiency>0</amplificationEfficiency>\n    <dyeId id="' + esc(d) + '" />\n  </target>').join('\n');

  // react: one per well that has a curve (all 96 in practice)
  const reactsXml = exp.wells.map(w => {
    const sample = exp.samples.find(s => s.id === w.sampleId);
    const sampleId = sample ? sample.id : w.sampleId;
    const blocks = exp.dyes.map(dye => {
      const curve = exp.curves.find(c => c.well === w.id && c.dye === dye);
      if (!curve) return null;
      const adps = curve.points.map(p =>
        '      <adp><cyc>' + num(p.c) + '</cyc><tmp>' + num(60.0) + '</tmp><fluor>' + num(p.f) + '</fluor></adp>').join('\n');
      return '    <data>\n      <tar id="' + esc(dye) + '@Target" />\n' + adps + '\n    </data>';
    }).filter(Boolean);
    if (!blocks.length) return '';
    return '  <react id="' + w.id + '">\n    <sample id="' + esc(sampleId) + '" />\n' + blocks.join('\n') + '\n  </react>';
  }).filter(Boolean).join('\n');

  // reuse thermalCyclingConditions + experimenter from the source rdml if present
  let tcc = '';
  let expId = '000000000000000';
  if (sourceZip && sourceZip.has('rdml_data.xml')) {
    const src = sourceZip.readText('rdml_data.xml');
    const m = src.match(/<thermalCyclingConditions[\s\S]*?<\/thermalCyclingConditions>/);
    if (m) tcc = m[0];
    const e = src.match(/<experimenter>[\s\S]*?<\/experimenter>/);
    if (e) tcc += '\n' + e[0];
    const idm = src.match(/<id>[\s\S]*?<\/id>/);
    if (idm) { const sn = idm[0].match(/<serialNumber>([^<]*)<\/serialNumber>/); if (sn) expId = sn[1]; }
  }
  if (!tcc) tcc = '  <thermalCyclingConditions id="' + expId + '">\n  </thermalCyclingConditions>';

  const now = new Date().toISOString().slice(0, 19);
  const rdml = '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<rdml xmlns="http://www.rdml.org" version="1.1">\n' +
    '  <dateMade>' + now + '</dateMade>\n  <dateUpdated>' + now + '</dateUpdated>\n' +
    '  <id>\n    <publisher>qPCR Web simulator</publisher>\n    <serialNumber>' + expId + '</serialNumber>\n  </id>\n' +
    dyesXml + '\n' +
    samplesXml + '\n' +
    targetsXml + '\n' +
    tcc + '\n' +
    reactsXml + '\n' +
    '</rdml>\n';

  let instrument = '<?xml version="1.0" encoding="utf-8"?>\n<rocheLC96InstrumentData />';
  let manifest = '<?xml version="1.0" encoding="utf-8"?>\n<lc96manifest Version="1.00.00">\n  <experiment analysisPresent="false" dateUpdated="' + now + '" state="processed" />\n</lc96manifest>\n';
  if (sourceZip) {
    if (sourceZip.has('instrument_data.xml')) instrument = sourceZip.readText('instrument_data.xml');
    if (sourceZip.has('manifest.xml')) {
      manifest = sourceZip.readText('manifest.xml').replace(/dateUpdated="[^"]*"/, 'dateUpdated="' + now + '"');
    }
  }

  return zipStore([
    { name: 'instrument_data.xml', data: Buffer.from(instrument, 'utf8') },
    { name: 'manifest.xml', data: Buffer.from(manifest, 'utf8') },
    { name: 'rdml_data.xml', data: Buffer.from(rdml, 'utf8') },
  ]);
}

// Parse a .lc96p buffer back (for round-trip verification / server use)
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function num(v) { return String(Math.round(v * 1e6) / 1e6); }

module.exports = { buildControl, toLc96p, wellLabel };
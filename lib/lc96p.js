'use strict';
// ---------------------------------------------------------------------------
// .lc96p parser: turns the ZIP of XML documents into one normalized
// Experiment model (the single source of truth for the whole app).
// ---------------------------------------------------------------------------
const { readZip } = require('./zip');
const { parseXml, child, children, find, findAll, textOf, numOf } = require('./xml');

function wellLabel(n) {
  const row = String.fromCharCode(64 + Math.ceil(n / 12));
  const col = ((n - 1) % 12) + 1;
  return row + col;
}

function parseLc96p(buffer, fileName) {
  const zip = readZip(buffer);
  const rdmlText = zip.readText('rdml_data.xml');
  if (!rdmlText) throw new Error('Missing rdml_data.xml in ' + fileName);
  const rdml = parseXml(rdmlText);
  const app = zip.has('app_data.xml') ? parseXml(zip.readText('app_data.xml')) : null;
  const mod = zip.has('module_data.xml') ? parseXml(zip.readText('module_data.xml')) : null;
  const calc = zip.has('calculated_data.xml') ? parseXml(zip.readText('calculated_data.xml')) : null;
  const instr = zip.has('instrument_data.xml') ? parseXml(zip.readText('instrument_data.xml')) : null;

  // ---- dyes: channel id = index in declaration order (matches engine ChannelMapping 0..3) ----
  const rdmlRoot = child(rdml, 'rdml') || rdml;
  const dyes = children(rdmlRoot, 'dye').map(d => d.attrs.id);
  const channelOf = {};
  dyes.forEach((d, i) => { channelOf[d] = i; });

  // ---- samples ----
  const samples = children(rdmlRoot, 'sample').map(s => ({
    id: s.attrs.id,
    name: textOf(child(s, 'description')),
    type: textOf(child(s, 'type')),
  }));

  // ---- wells (96) ----
  const wells = [];
  for (let i = 1; i <= 96; i++) wells.push({ id: i, label: wellLabel(i), sampleId: null, sampleName: '', sampleType: '' });
  for (const re of findAll(rdmlRoot, 'react')) {
    const id = parseInt(re.attrs.id, 10);
    if (id < 1 || id > 96) continue;
    const samp = child(re, 'sample');
    if (samp && samp.attrs.id) {
      const s = samples.find(x => x.id === samp.attrs.id);
      if (s) { wells[id - 1].sampleId = s.id; wells[id - 1].sampleName = s.name; wells[id - 1].sampleType = s.type; }
    }
  }

  // ---- amplification curves per (well x dye) ----
  const curves = [];
  for (const re of findAll(rdmlRoot, 'react')) {
    const well = parseInt(re.attrs.id, 10);
    if (well < 1 || well > 96) continue;
    for (const data of children(re, 'data')) {
      const tar = child(data, 'tar');
      if (!tar) continue;
      const targetId = tar.attrs.id || '';
      const dye = targetId.split('@')[0];
      const channel = channelOf[dye];
      if (channel === undefined) continue;
      const points = [];
      for (const adp of children(data, 'adp')) {
        const c = numOf(child(adp, 'cyc'));
        const f = numOf(child(adp, 'fluor'));
        if (c === null || f === null) continue;
        points.push({ c, f });
      }
      if (points.length) curves.push({ well, dye, channel, targetId, points });
    }
  }

  // ---- app_data: factGraph id -> (well, dye) ----
  const factGraph = {};
  if (app) {
    for (const re of findAll(app, 'react')) {
      const well = parseInt(re.attrs.id, 10);
      if (well < 1 || well > 96) continue;
      for (const f of children(re, 'factGraph')) {
        factGraph[f.attrs.id] = { well, targetId: f.attrs.targetId || '', dye: (f.attrs.targetId || '').split('@')[0] };
      }
    }
  }

  // ---- stored kinetic results (per well|dye) from calculated_data factGraphs ----
  const storedKinetic = {};
  if (calc) {
    for (const re of findAll(calc, 'react')) {
      const well = parseInt(re.attrs.id, 10);
      for (const f of children(re, 'factGraph')) {
        const dye = (f.attrs.targetId || '').split('@')[0];
        if (!dye) continue;
        const rec = { call: textOf(child(f, 'call')) };
        for (const k of ['slope', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10']) {
          const v = numOf(child(f, k));
          if (v !== null) rec[k] = v;
        }
        const om = child(f, 'OptimalModel');
        if (om) rec.optimalModel = parseInt(textOf(om), 10);
        rec.normFlour = [];
        for (const nf of children(f, 'normFlour')) {
          const c = numOf(child(nf, 'cyc'));
          const fl = numOf(child(nf, 'fluor'));
          if (c !== null && fl !== null) rec.normFlour.push({ c, f: fl });
        }
        storedKinetic[well + '|' + dye] = rec;
      }
    }
  }

  // ---- stored qualitative results (per well|dye) ----
  const storedQual = {};
  if (calc) {
    for (const ds of findAll(calc, 'qualDetectionDataSource')) {
      const gid = textOf(child(ds, 'graphId'));
      if (!gid || !factGraph[gid]) continue;
      const key = factGraph[gid].well + '|' + factGraph[gid].dye;
      const rec = {};
      for (const k of ['call', 'cq', 'epf', 'slope', 'combinedResult', 'failureType', 'editedCall']) {
        const e = child(ds, k);
        if (e && textOf(e) !== '') rec[k] = (k === 'call' || k === 'combinedResult' || k === 'failureType' || k === 'editedCall') ? textOf(e) : parseFloat(textOf(e));
      }
      storedQual[key] = rec;
    }
  }

  // ---- qualitative detection settings from module_data ----
  const settings = { genes: [], samples: [], internalControlDye: '' };
  if (mod) {
    const qdm = find(mod, 'qualDetectionDataModel');
    if (qdm) {
      const ic = find(qdm, 'internalControlDye');
      if (ic) settings.internalControlDye = textOf(ic);
      const st = find(qdm, 'settings');
      if (st) {
        for (const gs of findAll(st, 'geneSettings')) {
          const g = find(gs, 'geneSettings');
          if (g) {
            settings.genes.push({
              name: textOf(find(g, 'geneName')),
              removed: textOf(find(g, 'removed')) === 'true',
              internalControl: textOf(find(g, 'internalControl')),
            });
          }
        }
        for (const ss of findAll(st, 'sampleSettings')) {
          const s = find(ss, 'sampleSettings');
          if (s) {
            settings.samples.push({
              name: textOf(find(s, 'sampleName')),
              removed: textOf(find(s, 'removed')) === 'true',
            });
          }
        }
      }
    }
  }

  // ---- run metadata from instrument_data (best effort) ----
  const meta = { id: '', made: '', updated: '' };
  if (instr) {
    meta.id = textOf(find(instr, 'id'));
    meta.made = textOf(find(instr, 'dateMade'));
    meta.updated = textOf(find(instr, 'dateUpdated'));
  }

  const base = fileName.replace(/\.lc96p$/i, '');
  return {
    id: base + '-' + Date.now().toString(36),
    name: fileName,
    meta,
    dyes,
    channelOf,
    samples,
    wells,
    curves,
    factGraph,
    storedKinetic,
    storedQual,
    settings,
    computed: {},
    analyzedAt: null,
    analysis: {
      adf: dyes.some(d => /sybr/i.test(d)) ? 'Sybr-KA.adf' : 'Gen-KA.adf',
      engine: 'Roche Kinetic 1.5.3.1244 (original LC96 engine via x86 bridge)',
      note: 'Cq = 26 CT1, Slope = 23 MRS, EPF = 78 LC96 Normalized ERI, Call = 11 Intermediate Call. ADF auto-selected: SYBR dyes -> Sybr-KA.adf, probe dyes -> Gen-KA.adf.',
    },
  };
}

module.exports = { parseLc96p, wellLabel };
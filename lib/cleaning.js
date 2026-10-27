'use strict';
// ---------------------------------------------------------------------------
// Technical-replicate cleaning layer (Auto-qPCR style, methodology only).
//
// Pipeline: replicate grouping → outlier removal → missing-Cq rules →
// mean ± SD summary. Downstream normalization and statistics must consume
// `statsInput` (cleaned sample means) only — never raw single wells.
//
// Pure functions, zero dependencies. Usable server-side (module.exports)
// and in the browser (window.QpcrCleaning), like lib/stats.js.
//
// Input contract (what P1's experiment.model will provide as `assignments`):
//   groups: [{ sample, target, wells: [{ id, label?, cq, call }] }]
//     call: 'Positive' | 'Negative' | 'Invalid' | anything else (= undetermined)
//     cq:   finite number, or null/undefined when not determined
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = Object.freeze({
  cvThreshold: 0.05,        // group CV (sample SD / mean) above this → outlier pass
  deviationThreshold: 0.5,  // |well Cq − group median| above this (Cq) → outlier pass
  minReplicates: 1,         // never remove the last well of a group
  missingRule: 'exclude',   // 'exclude' (default) | 'impute'
  imputeCq: 40,             // Cq substituted for undetermined wells in 'impute' mode
});

function normalizeOptions(options) {
  const o = Object.assign({}, DEFAULT_OPTIONS, options || {});
  if (!Number.isFinite(o.cvThreshold) || o.cvThreshold <= 0) {
    throw new RangeError('cvThreshold must be a positive number, got ' + o.cvThreshold);
  }
  if (!Number.isFinite(o.deviationThreshold) || o.deviationThreshold < 0) {
    throw new RangeError('deviationThreshold must be a non-negative number, got ' + o.deviationThreshold);
  }
  if (!Number.isInteger(o.minReplicates) || o.minReplicates < 1) {
    throw new RangeError('minReplicates must be an integer >= 1, got ' + o.minReplicates);
  }
  if (o.missingRule !== 'exclude' && o.missingRule !== 'impute') {
    throw new RangeError("missingRule must be 'exclude' or 'impute', got " + o.missingRule);
  }
  if (!Number.isFinite(o.imputeCq)) {
    throw new RangeError('imputeCq must be a finite number, got ' + o.imputeCq);
  }
  return o;
}

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}
function sampleSd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) * (v - m), 0) / (values.length - 1));
}
function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Why a well is not usable as-measured.
function missingReason(well) {
  if (well.call === 'Negative') return 'negative';
  if (well.call === 'Invalid') return 'invalid';
  if (well.call === 'Positive') return Number.isFinite(well.cq) ? null : 'no_cq';
  return 'undetermined';
}

function cleanGroup(group, o) {
  const wells = (group.wells || []).map(w => ({
    id: w.id, label: w.label !== undefined ? w.label : String(w.id),
    cq: w.cq, call: w.call, status: 'pending', reason: '',
  }));
  const warnings = [];

  // -- missing / undetermined Cq rules ---------------------------------------
  // Imputed wells are artificial (all share imputeCq); they must not take part
  // in outlier detection, otherwise genuine wells get removed for being far
  // from the imputed block. They join the summary afterwards.
  const kept = [], imputed = [];
  for (const w of wells) {
    const reason = missingReason(w);
    if (reason === null) { w.status = 'used'; kept.push(w); continue; }
    if (o.missingRule === 'impute') {
      w.status = 'imputed'; w.reason = 'imputed_' + reason; w.cq = o.imputeCq;
      imputed.push(w);
    } else {
      w.status = 'excluded'; w.reason = reason;
    }
  }

  // -- outlier removal (measured wells only) -----------------------------------
  // While the kept set violates a threshold, drop its most deviant well
  // (|cq − median|, tie-break |cq − mean|, then first). Never below minReplicates.
  const minKeep = Math.max(1, o.minReplicates);
  while (kept.length > minKeep) {
    const vals = kept.map(w => w.cq);
    const med = median(vals);
    const m = mean(vals);
    const maxDev = Math.max(...vals.map(v => Math.abs(v - med)));
    const cv = m !== 0 ? sampleSd(vals) / Math.abs(m) : NaN;
    if (!((cv > o.cvThreshold) || (maxDev > o.deviationThreshold))) break;
    let idx = 0;
    for (let i = 1; i < kept.length; i++) {
      const di = Math.abs(kept[i].cq - med), d0 = Math.abs(kept[idx].cq - med);
      if (di > d0 || (di === d0 && Math.abs(kept[i].cq - m) > Math.abs(kept[idx].cq - m))) idx = i;
    }
    const [removed] = kept.splice(idx, 1);
    removed.status = 'excluded';
    removed.reason = 'outlier';
  }

  // -- summary (measured kept + imputed) ---------------------------------------
  const all = kept.concat(imputed);
  const n = all.length;
  const m = n ? mean(all.map(w => w.cq)) : NaN;
  const sd = n ? sampleSd(all.map(w => w.cq)) : NaN;
  const cv = n && m !== 0 ? sd / Math.abs(m) : NaN;
  if (n === 0) {
    warnings.push('all_replicates_missing');
  } else if (kept.length === 0) {
    warnings.push('all_replicates_imputed');
  }
  return {
    sample: group.sample, target: group.target,
    n, mean: m, sd, cv,
    nOutliers: wells.filter(w => w.reason === 'outlier').length,
    nMissing: wells.filter(w => w.status === 'excluded' && w.reason !== 'outlier').length,
    nImputed: wells.filter(w => w.status === 'imputed').length,
    wells, warnings,
    usable: n > 0,
  };
}

// groups: [{ sample, target, wells: [{ id, label?, cq, call }] }]
// Returns { options, groups, statsInput, warnings }.
// statsInput is the ONLY valid input for downstream normalization/statistics.
function cleanReplicates(groups, options) {
  const o = normalizeOptions(options);
  if (!Array.isArray(groups)) throw new TypeError('groups must be an array');
  const cleaned = groups.map(g => cleanGroup(g, o));
  const statsInput = cleaned.filter(g => g.usable).map(g => ({
    sample: g.sample, target: g.target, mean: g.mean, sd: g.sd, cv: g.cv, n: g.n,
  }));
  const warnings = [];
  for (const g of cleaned) {
    for (const w of g.warnings) {
      warnings.push(w + ': ' + g.sample + ' / ' + g.target);
    }
  }
  return { options: o, groups: cleaned, statsInput, warnings };
}

// ---------------------------------------------------------------------------
// Grouping helpers.
//
// assignments: { wellId: { sample, target } } — P1's experiment.model will
// produce exactly this mapping (replicate attribution); until then,
// assignByConventions() derives it from the current Experiment shape
// (well.sampleName + plate-naming layout target + internal-control settings).
// ---------------------------------------------------------------------------

// wells: experiment.wells [{ id, label, sampleId, sampleName }]
// computed: experiment.computed { "wellId|dye": { '11 Intermediate Call', '26 CT1', ... } }
// dye: channel dye name, e.g. experiment.dyes[0]
function buildGroups(wells, assignments, computed, dye) {
  const byKey = new Map();
  for (const w of wells || []) {
    const a = assignments && assignments[w.id];
    if (!a || !a.sample || !a.target) continue;         // unattributed wells stay out
    const c = (computed || {})[w.id + '|' + dye] || {};
    const call = c['11 Intermediate Call'] !== undefined ? c['11 Intermediate Call'] : '';
    const cq = c['26 CT1'] !== undefined && c['26 CT1'] !== null ? c['26 CT1'] : null;
    const key = a.sample + '' + a.target;
    if (!byKey.has(key)) byKey.set(key, { sample: a.sample, target: a.target, wells: [] });
    byKey.get(key).wells.push({
      id: w.id, label: w.label !== undefined ? w.label : String(w.id),
      cq: Number.isFinite(cq) ? cq : null, call,
    });
  }
  return Array.from(byKey.values());
}

// Derive { wellId: { sample, target } } from the pre-model conventions:
//   sample  = well.sampleName || well.sampleId
//   target  = layoutNames[well.label].target, except internal-control wells
//             (settings.internalControlWells) which map to the IC gene name.
function assignByConventions(exp, layoutNames) {
  const assignments = {};
  const icSet = new Set((exp.settings && exp.settings.internalControlWells) || []);
  const icGene = (exp.settings && exp.settings.internalControlGene) || '内参基因';
  for (const w of exp.wells || []) {
    const sample = w.sampleName || w.sampleId;
    if (!sample) continue;
    const target = icSet.has(w.id)
      ? icGene
      : ((layoutNames && layoutNames[w.label] && layoutNames[w.label].target) || '');
    if (!target) continue;                              // unnamed targets stay out
    assignments[w.id] = { sample, target };
  }
  return assignments;
}

// ---------------------------------------------------------------------------
// Export: one well-level row per replicate, exclusions explicitly marked.
// ---------------------------------------------------------------------------
function wellRows(result) {
  const rows = [];
  for (const g of result.groups) {
    for (const w of g.wells) {
      rows.push({
        Sample: g.sample, Target: g.target, Well: w.label,
        Call: w.call === undefined || w.call === null ? '' : w.call,
        Cq: Number.isFinite(w.cq) ? w.cq : '',
        Status: w.status,                                  // used | imputed | excluded
        Reason: w.reason,                                  // outlier | negative | invalid | no_cq | undetermined | imputed_* | ''
        GroupN: g.usable ? g.n : '',
        GroupMean: g.usable ? g.mean : '',
        GroupSD: g.usable ? g.sd : '',
        GroupCV: g.usable ? g.cv : '',
      });
    }
  }
  return rows;
}

function summaryRows(result) {
  return result.groups.map(g => ({
    Sample: g.sample, Target: g.target,
    N: g.n, Mean: g.mean, SD: g.sd, CV: g.cv,
    Outliers: g.nOutliers, Missing: g.nMissing, Imputed: g.nImputed,
    Warnings: g.warnings.join(';'),
  }));
}

function rowsToCSV(rows) {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const esc = v => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  // BOM so Excel opens UTF-8 correctly (same convention as lib/export.js)
  return '﻿' + lines.join('\r\n');
}

function toCSV(result) { return rowsToCSV(wellRows(result)); }
function summaryToCSV(result) { return rowsToCSV(summaryRows(result)); }

const cleaning = {
  DEFAULT_OPTIONS,
  normalizeOptions, cleanReplicates,
  buildGroups, assignByConventions,
  wellRows, summaryRows, toCSV, summaryToCSV,
};
if (typeof module !== 'undefined' && module.exports) module.exports = cleaning;
if (typeof window !== 'undefined') window.QpcrCleaning = cleaning;

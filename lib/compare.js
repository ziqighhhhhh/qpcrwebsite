'use strict';
// ---------------------------------------------------------------------------
// Group comparison between treatment (real) and control (simulated).
// Paired Cq on positive wells: paired t-test, Cohen's d, fold change, chi2.
// ---------------------------------------------------------------------------
const s = require('./stats.js');

function pairCq(treat, ctrl) {
  const t = {}, c = {};
  for (const k of Object.keys(treat.computed || {})) {
    const d = treat.computed[k];
    if (d['11 Intermediate Call'] === 'Positive' && d['26 CT1'] !== null && d['26 CT1'] !== undefined) t[k] = d['26 CT1'];
  }
  for (const k of Object.keys(ctrl.computed || {})) {
    const d = ctrl.computed[k];
    if (d['11 Intermediate Call'] === 'Positive' && d['26 CT1'] !== null && d['26 CT1'] !== undefined) c[k] = d['26 CT1'];
  }
  const keys = Object.keys(t).filter(k => c[k] !== undefined);
  return {
    keys,
    treatCq: keys.map(k => t[k]),
    ctrlCq: keys.map(k => c[k]),
    treatCount: Object.keys(t).length,
    ctrlCount: Object.keys(c).length,
  };
}

function compareGroups(treat, ctrl, totalWells) {
  const p = pairCq(treat, ctrl);
  const n = p.keys.length;
  const out = {
    n,
    paired: true,
    treat: { wells: p.treatCount, summary: s.summary(p.treatCq) },
    ctrl: { wells: p.ctrlCount, summary: s.summary(p.ctrlCq) },
  };
  out.meanDeltaCt = out.ctrl.summary.mean - out.treat.summary.mean; // ctrl Ct higher = down-regulation
  out.foldChange = s.foldChange(out.treat.summary.mean, out.ctrl.summary.mean); // 2^(treat-ctrl) <1
  out.foldLabel = out.foldChange < 1
    ? '1/' + Math.round(1 / out.foldChange) + ' (处理组表达为对照组的 ' + Math.round(1 / out.foldChange) + ' 分之一，下调)'
    : Math.round(out.foldChange) + ' 倍 (上调)';
  const t = s.ttestPaired(p.treatCq, p.ctrlCq);
  out.pairedT = { t: t.t, df: t.df, p: t.p, stars: s.stars(t.p) };
  out.cohensD = s.cohensD(p.treatCq, p.ctrlCq);
  out.significant = t.p !== null && t.p !== undefined && !isNaN(t.p) && t.p < 0.05;
  // positive-rate chi-square (Yates) across all wells
  const treatPos = p.treatCount, ctrlPos = p.ctrlCount;
  const treatNeg = totalWells - treatPos, ctrlNeg = totalWells - ctrlPos;
  const chi = s.chiSquare2x2(treatPos, treatNeg, ctrlPos, ctrlNeg);
  out.positiveRate = {
    treat: treatPos + '/' + totalWells + ' (' + (100 * treatPos / totalWells).toFixed(1) + '%)',
    ctrl: ctrlPos + '/' + totalWells + ' (' + (100 * ctrlPos / totalWells).toFixed(1) + '%)',
    chi2: chi.chi2, p: chi.p, stars: s.stars(chi.p),
  };
  // summary verdict text
  if (out.significant && out.meanDeltaCt > 2) {
    out.verdict = '处理组与对照组靶基因表达差异显著（p = ' + fmtP(t.p) + '），' + out.foldLabel + '。';
  } else if (out.significant) {
    out.verdict = '两组差异显著（p = ' + fmtP(t.p) + '）。';
  } else {
    out.verdict = '两组差异未达显著（p = ' + fmtP(t.p) + '）。';
  }
  return out;
}

function fmtP(p) {
  if (p === null || p === undefined || isNaN(p)) return 'n/a';
  return p < 0.001 ? p.toExponential(2) : p.toFixed(4);
}

module.exports = { compareGroups, pairCq };
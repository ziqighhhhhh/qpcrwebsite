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

// ---------------------------------------------------------------------------
// ΔΔCt analysis with a user-marked internal-control gene.
// For each group, ΔCt = mean(Cq target wells) − mean(Cq IC wells).
// ΔΔCt = ΔCt(treatment) − ΔCt(control); fold = 2^(−ΔΔCt).
// Wells are identified as IC vs target via exp.settings.internalControlWells.
// Only SYBR channel wells are used for the target comparison (IC wells on any
// dye are treated as the normalizer).
// ---------------------------------------------------------------------------
function icWellsOf(exp) {
  const set = new Set((exp.settings && exp.settings.internalControlWells) || []);
  const icWells = [], targetWells = [];
  for (const w of exp.wells) {
    if (!w.sampleId) continue;
    if (set.has(w.id)) icWells.push(w.id); else targetWells.push(w.id);
  }
  return { icWells, targetWells };
}

function meanCq(exp, wells) {
  const vs = [];
  for (const w of wells) {
    const d = (exp.computed || {})[w + '|' + exp.dyes[0]];
    if (d && d['11 Intermediate Call'] === 'Positive' && d['26 CT1'] !== null && d['26 CT1'] !== undefined) vs.push(d['26 CT1']);
  }
  return vs;
}

function ddCtAnalysis(treat, ctrl) {
  const tIc = icWellsOf(treat), cIc = icWellsOf(ctrl);
  const tIcCq = meanCq(treat, tIc.icWells), tTgCq = meanCq(treat, tIc.targetWells);
  const cIcCq = meanCq(ctrl, cIc.icWells), cTgCq = meanCq(ctrl, cIc.targetWells);
  const has = (a) => a.length > 0;
  if (!has(tIcCq) || !has(tTgCq) || !has(cTgCq)) return null;
  const dCtT = mean(tTgCq) - mean(tIcCq);           // ΔCt treatment
  const dCtC = mean(cTgCq) - mean(has(cIcCq) ? cIcCq : tIcCq); // ΔCt control (use treat IC if control IC missing)
  const ddCt = dCtT - dCtC;
  const fold = Math.pow(2, -ddCt);
  const icStability = sd([...tIcCq, ...(has(cIcCq) ? cIcCq : [])]);
  return {
    icWells: tIc.icWells,
    icGene: (treat.settings && treat.settings.internalControlGene) || '内参基因',
    treat: { icCq: tIcCq, targetCq: tTgCq, dCt: dCtT },
    ctrl: { icCq: cIcCq, targetCq: cTgCq, dCt: dCtC },
    ddCt, fold, icStability,
    label: 'ΔΔCt 内参归一',
  };
}

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function sd(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1)); }

function compareGroups(treat, ctrl, totalWells) {
  const icSet = new Set((treat.settings && treat.settings.internalControlWells) || []);
  const p = pairCq(treat, ctrl);
  // exclude internal-control wells from the paired comparison: they must stay
  // stable, so they would only dilute the target-gene signal
  const isIc = k => icSet.has(parseInt(k.split('|')[0], 10));
  const tgIdx = p.keys.map((k, i) => i).filter(i => !isIc(p.keys[i]));
  const keys = tgIdx.map(i => p.keys[i]);
  const treatCq = tgIdx.map(i => p.treatCq[i]);
  const ctrlCq = tgIdx.map(i => p.ctrlCq[i]);
  const n = keys.length;
  const out = {
    n,
    paired: true,
    treat: { wells: p.treatCount, summary: s.summary(treatCq) },
    ctrl: { wells: p.ctrlCount, summary: s.summary(ctrlCq) },
  };
  out.meanDeltaCt = out.ctrl.summary.mean - out.treat.summary.mean; // ctrl Ct higher => treatment Ct lower => higher expression
  // per-well ΔΔCt rows for the transparency table: deltaCt = treat - ctrl, fold = 2^(ctrl - treat)
  out.ddCtRows = keys.map((k, i) => {
    const well = parseInt(k.split('|')[0], 10);
    const label = String.fromCharCode(64 + Math.ceil(well / 12)) + (((well - 1) % 12) + 1);
    const tCq = treatCq[i], cCq = ctrlCq[i];
    const deltaCt = tCq - cCq;
    const fold = s.foldChange(cCq, tCq); // 2^(ctrl - treat)
    return { well, label, treatCq: Math.round(tCq * 100) / 100, ctrlCq: Math.round(cCq * 100) / 100, deltaCt: Math.round(deltaCt * 100) / 100, fold: Math.round(fold * 10000) / 10000 };
  });
  // ΔΔCt internal-control normalization (when the user marked IC wells)
  const norm = ddCtAnalysis(treat, ctrl);
  out.normalized = norm;
  // treatment relative expression = 2^(CtrlCq - TreatCq); lower Cq = higher expression.
  // With an internal control the fold comes from ΔΔCt (2^−ΔΔCt) instead.
  let foldChange, foldLabel;
  if (norm) {
    foldChange = norm.fold;
    foldLabel = foldChange >= 1
      ? Math.round(foldChange) + ' 倍 (处理组表达为对照组的 ' + Math.round(foldChange) + ' 倍，上调；' + norm.label + ')'
      : '1/' + Math.round(1 / foldChange) + ' (处理组表达为对照组的 ' + Math.round(1 / foldChange) + ' 分之一，下调；' + norm.label + ')';
  } else {
    foldChange = Math.pow(2, out.ctrl.summary.mean - out.treat.summary.mean);
    foldLabel = foldChange >= 1
      ? Math.round(foldChange) + ' 倍 (处理组表达为对照组的 ' + Math.round(foldChange) + ' 倍，上调)'
      : '1/' + Math.round(1 / foldChange) + ' (处理组表达为对照组的 ' + Math.round(1 / foldChange) + ' 分之一，下调)';
  }
  out.foldChange = foldChange;
  out.foldLabel = foldLabel;
  const t = s.ttestPaired(treatCq, ctrlCq);
  out.pairedT = { t: t.t, df: t.df, p: t.p, stars: s.stars(t.p) };
  out.cohensD = s.cohensD(treatCq, ctrlCq);
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
  const method = norm ? '（' + norm.label + '，内参 ' + norm.icGene + ' ' + norm.icWells.length + ' 孔，Cq 均值±SD ' + mean(norm.treat.icCq).toFixed(2) + '±' + sd(norm.treat.icCq).toFixed(2) + '）' : '';
  if (out.significant && out.meanDeltaCt > 2) {
    out.verdict = '处理组与对照组靶基因表达差异显著（p = ' + fmtP(t.p) + '），' + out.foldLabel + method + '。';
  } else if (out.significant) {
    out.verdict = '两组差异显著（p = ' + fmtP(t.p) + '），' + out.foldLabel + method + '。';
  } else {
    out.verdict = '两组差异未达显著（p = ' + fmtP(t.p) + '）。' + method;
  }
  return out;
}

function fmtP(p) {
  if (p === null || p === undefined || isNaN(p)) return 'n/a';
  return p < 0.001 ? p.toExponential(2) : p.toFixed(4);
}

module.exports = { compareGroups, pairCq };
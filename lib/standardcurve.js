'use strict';
// ---------------------------------------------------------------------------
// Standard curve (absolute quantification).
//
//   Cq = intercept + slope · log10(quantity)      (least squares)
//   efficiency E = 10^(−1/slope) − 1              (slope −3.3219 → E = 1.00)
//   unknown quantity = 10^((Cq − intercept) / slope)
//
// Standards come from either of two places, and both can coexist:
//   * design-driven synthesis (exp.analysis.synthetic.truth, role "standard",
//     quantity recorded as the design truth) — the fitted efficiency can then be
//     compared against the efficiency the data was generated with;
//   * manual marking of wells on the standard-curve page (data/standards.json),
//     which is what real .lc96p experiments need since they carry no quantities.
// ---------------------------------------------------------------------------
const stats = require('./stats.js');
const { wellLabel } = require('./lc96p.js');

const WELL_RE = /^([A-H])([1-9]|1[0-2])$/;

function round(v, d) { const m = Math.pow(10, d === undefined ? 4 : d); return Math.round(v * m) / m; }
function log10(v) { return Math.log(v) / Math.LN10; }
function labelToId(label) {
  const m = WELL_RE.exec(String(label || '').toUpperCase());
  if (!m) return null;
  return (m[1].charCodeAt(0) - 64 - 1) * 12 + parseInt(m[2], 10);
}
function efficiencyOf(slope) {
  return slope < 0 ? Math.pow(10, -1 / slope) - 1 : NaN;
}

// ---------------------------------------------------------------------------
// Least-squares fit of Cq against log10(quantity).
// points: [{ quantity, cq }] — rows without a usable Cq must be filtered out first.
// ---------------------------------------------------------------------------
function fitStandardCurve(points) {
  const pts = (points || [])
    .filter(p => p && Number.isFinite(p.cq) && Number.isFinite(p.quantity) && p.quantity > 0)
    .map(p => ({ quantity: p.quantity, cq: p.cq, label: p.label || '', x: log10(p.quantity), y: p.cq }));
  const n = pts.length;
  if (n < 2) return { ok: false, n, error: '至少需要 2 个有效标准品孔（判定为 Positive 且有浓度）' };
  const xbar = stats.mean(pts.map(p => p.x)), ybar = stats.mean(pts.map(p => p.y));
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p.x - xbar, dy = p.y - ybar;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (!(sxx > 0)) return { ok: false, n, error: '标准品浓度全部相同，斜率无法确定' };
  const slope = sxy / sxx;
  const intercept = ybar - slope * xbar;
  // 残差用完整精度计算，只对输出的展示副本取整
  const residuals = pts.map(p => {
    const fitted = intercept + slope * p.x;
    return { quantity: p.quantity, log10: p.x, cq: p.y, fittedCq: fitted, residual: p.y - fitted };
  });
  const ssres = residuals.reduce((s, p) => s + p.residual * p.residual, 0);
  const r2 = syy > 0 ? 1 - ssres / syy : 1;
  const residualSd = n > 2 ? Math.sqrt(ssres / (n - 2)) : null;
  const slopeSe = n > 2 ? Math.sqrt((ssres / (n - 2)) / sxx) : null;
  const eff = efficiencyOf(slope);
  let efficiencyPctRange = null;
  if (n > 2 && slopeSe !== null) {
    const tc = stats.tQuantile(0.05, n - 2);          // two-sided 95%
    const a = efficiencyOf(slope - tc * slopeSe), b = efficiencyOf(slope + tc * slopeSe);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      efficiencyPctRange = [round(Math.min(a, b) * 100, 3), round(Math.max(a, b) * 100, 3)];
    }
  }
  const xs = pts.map(p => p.x);
  const warnings = [];
  if (slope >= 0) warnings.push('斜率为正（' + round(slope, 3) + '）：Cq 不随浓度下降，标准曲线无扩增趋势');
  if (residualSd !== null && residualSd > 0.5) warnings.push('残差 SD ' + round(residualSd, 3) + ' 偏大（>0.5 循环），标准品重复性或稀释准确性不足');
  return {
    ok: true, n,
    slope, intercept,
    r2,
    residualSd,
    slopeSe,
    efficiency: Number.isFinite(eff) ? eff : null,
    efficiencyPct: Number.isFinite(eff) ? eff * 100 : null,
    efficiencyPctRange,
    quantityRange: [Math.min(...pts.map(p => p.quantity)), Math.max(...pts.map(p => p.quantity))],
    log10Range: [Math.min(...xs), Math.max(...xs)],
    residuals: residuals.map(p => ({
      label: p.label || '', quantity: p.quantity, log10: round(p.log10, 4), cq: round(p.cq, 3),
      fittedCq: round(p.fittedCq, 3), residual: round(p.residual, 4),
    })),
    warnings,
  };
}

function fittedCq(quantity, fit) {
  if (!fit || !fit.ok || !Number.isFinite(quantity) || quantity <= 0) return null;
  return fit.intercept + fit.slope * log10(quantity);
}
function quantify(cq, fit) {
  if (!fit || !fit.ok || !Number.isFinite(cq) || !Number.isFinite(fit.slope) || fit.slope === 0) return null;
  return Math.pow(10, (cq - fit.intercept) / fit.slope);
}

// ---------------------------------------------------------------------------
// Model access helpers
// ---------------------------------------------------------------------------
// Cq of a well: engine result first, stored .lc96p result as fallback. Only
// Positive calls carry a Cq (same rule the LC96 software and the exports use).
function cqOf(exp, wellId, dye) {
  const key = wellId + '|' + dye;
  const comp = (exp.computed || {})[key];
  if (comp && comp['11 Intermediate Call'] === 'Positive' && Number.isFinite(comp['26 CT1'])) {
    return { cq: comp['26 CT1'], call: 'Positive', source: 'engine' };
  }
  const st = (exp.storedQual || {})[key];
  if (st && st.call === 'Positive' && Number.isFinite(st.cq)) {
    return { cq: st.cq, call: 'Positive', source: 'stored' };
  }
  const call = (comp && comp['11 Intermediate Call']) || (st && st.call) || '—';
  return { cq: null, call, source: null };
}

// Standards that the design-driven synthesis baked into the experiment.
function designStandards(exp) {
  const truth = exp && exp.analysis && exp.analysis.synthetic && exp.analysis.synthetic.truth;
  const out = {};
  if (!truth) return out;
  for (const id of Object.keys(truth)) {
    const t = truth[id];
    if (t && t.role === 'standard' && Number.isFinite(t.quantity) && t.quantity > 0) {
      out[wellLabel(parseInt(id, 10))] = { quantity: t.quantity, unit: t.unit || 'copies', source: 'design' };
    }
  }
  return out;
}

// Merge manual (data/standards.json) over design standards.
function mergeStandards(design, manual) {
  const out = {};
  for (const label of Object.keys(design || {})) out[label] = Object.assign({}, design[label]);
  for (const label of Object.keys(manual || {})) {
    const key = String(label).toUpperCase();
    if (!WELL_RE.test(key)) continue;
    const q = parseFloat(manual[label] && manual[label].quantity);
    if (!Number.isFinite(q) || q <= 0) { delete out[key]; continue; }   // clearing a well wins over the design value
    out[key] = { quantity: q, unit: (manual[label].unit || (out[key] && out[key].unit) || 'copies'), source: 'manual' };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full analysis: standards table + fit + unknown quantification + QC warnings.
// opts: { dye, manual, layoutNames }
// ---------------------------------------------------------------------------
function analyzeStandardCurve(exp, opts = {}) {
  const dye = opts.dye || (exp.dyes && exp.dyes[0]) || 'SYBR Green I';
  const fromDesign = designStandards(exp);
  const standards = mergeStandards(fromDesign, opts.manual || {});
  const layout = opts.layoutNames || {};
  const layoutOf = label => layout[label] || {};

  const labels = Object.keys(standards).sort((a, b) => labelToId(a) - labelToId(b));
  const rows = labels.map(label => {
    const id = labelToId(label);
    const w = (exp.wells || []).find(x => x.id === id) || {};
    const c = cqOf(exp, id, dye);
    const q = standards[label].quantity;
    return {
      well: id, label, sample: w.sampleName || '', target: layoutOf(label).target || '',
      simple: layoutOf(label).simple || '', quantity: q, unit: standards[label].unit,
      log10: round(log10(q), 4), source: standards[label].source,
      call: c.call, cq: c.cq === null ? null : round(c.cq, 2),
    };
  });

  const usable = rows.filter(r => r.cq !== null);
  const fit = fitStandardCurve(usable.map(r => ({ quantity: r.quantity, cq: r.cq, label: r.label })));
  if (fit.ok) {
    for (const r of rows) {
      if (r.cq === null) continue;
      r.fittedCq = round(fit.intercept + fit.slope * r.log10, 2);
      r.residual = round(r.cq - r.fittedCq, 3);
    }
  }

  // Unknown wells (everything on the plate that is neither standard nor control)
  const unknowns = [], bySample = new Map();
  for (const w of exp.wells || []) {
    if (!w.sampleId || w.sampleType === 'ntc' || w.sampleType === 'std') continue;
    if (standards[w.label]) continue;
    const c = cqOf(exp, w.id, dye);
    const target = layoutOf(w.label).target || '';
    const row = {
      well: w.id, label: w.label, sample: w.sampleName || '', target, call: c.call,
      cq: c.cq === null ? null : round(c.cq, 2), quantity: null,
    };
    if (fit.ok && row.cq !== null) row.quantity = round(quantify(row.cq, fit), 4);
    unknowns.push(row);
    const key = w.sampleId + '|' + target;
    if (!bySample.has(key)) bySample.set(key, { sample: row.sample, target, n: 0, cqs: [], quantities: [] });
    const g = bySample.get(key);
    g.n++;
    if (row.cq !== null) g.cqs.push(row.cq);
    if (row.quantity !== null) g.quantities.push(row.quantity);
  }
  const samples = Array.from(bySample.values()).map(g => ({
    sample: g.sample, target: g.target, n: g.n,
    meanCq: g.cqs.length ? round(stats.mean(g.cqs), 2) : null,
    sdCq: g.cqs.length > 1 ? round(stats.sd(g.cqs), 3) : null,
    meanQuantity: g.quantities.length ? round(stats.mean(g.quantities), 4) : null,
  }));

  const der = exp.analysis && exp.analysis.synthetic && exp.analysis.synthetic.derived;
  const designed = der ? {
    efficiencyPct: der.efficiencyPct,
    standards: der.standards || null,
    slope: der.standards && der.standards.designedSlope !== undefined ? der.standards.designedSlope : null,
  } : null;

  const warnings = [];
  if (!rows.length) warnings.push('尚未指定标准品孔：在孔板上按稀释顺序点选孔位并填入系列浓度');
  if (rows.length && !fit.ok) warnings.push(fit.error);
  if (rows.length && usable.length < rows.length) {
    warnings.push((rows.length - usable.length) + ' 个标准品孔未判定为 Positive，已排除出拟合');
  }
  if (fit.ok) {
    const effPct = fit.efficiencyPct === null ? null : round(fit.efficiencyPct, 2);
    if (effPct !== null && (effPct < 90 || effPct > 110)) {
      warnings.push('扩增效率 ' + effPct + '% 超出常用可接受区间（90–110%）');
    }
    const r2 = round(fit.r2, 5);
    if (r2 < 0.98) warnings.push('R² = ' + r2 + ' 低于 0.98，标准曲线线性度不足');
    if (designed && Number.isFinite(designed.efficiencyPct) && effPct !== null) {
      const dev = Math.abs(effPct - designed.efficiencyPct);
      if (dev > 5) warnings.push('实测效率 ' + effPct + '% 与设计效率 ' + designed.efficiencyPct + '% 相差 ' + round(dev, 2) + ' 个百分点');
    }
  }

  return {
    ok: true,
    name: exp.name || '',
    experimentId: exp.id || '',
    dye,
    channels: exp.dyes || [],
    standards: rows,
    fit,
    unknowns,
    samples,
    designed,
    fromDesign: Object.keys(fromDesign).length,
    manual: Object.keys(opts.manual || {}).length,
    warnings,
  };
}

// ---- CSV (standard + unknown tables in one file, two sections) ----
function csvEscape(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(result) {
  const lines = [];
  const f = result.fit || {};
  const n = (v, d) => (v === null || v === undefined || !Number.isFinite(v)) ? '' : round(v, d === undefined ? 4 : d);
  lines.push(['# 标准曲线', result.name, 'dye=' + result.dye].join(','));
  lines.push(['# slope', f.ok ? n(f.slope, 4) : '', 'intercept', f.ok ? n(f.intercept, 3) : '', 'R2', f.ok ? n(f.r2, 5) : '', 'efficiency %', f.ok ? n(f.efficiencyPct, 2) : '', 'n', f.ok ? f.n : ''].join(','));
  if (f.ok && f.efficiencyPctRange) lines.push(['# efficiency 95% CI %', f.efficiencyPctRange[0], f.efficiencyPctRange[1]].join(','));
  if (result.designed) lines.push(['# designed efficiency %', result.designed.efficiencyPct, 'designed slope', result.designed.slope === null ? '' : result.designed.slope].join(','));
  lines.push('');
  lines.push(['section', 'well', 'label', 'sample', 'target', 'quantity', 'unit', 'log10', 'call', 'Cq', 'fittedCq', 'residual', 'source'].join(','));
  for (const r of result.standards) {
    lines.push(['standard', r.well, r.label, r.sample, r.target, r.quantity, r.unit, r.log10, r.call, r.cq, r.fittedCq === undefined ? '' : r.fittedCq, r.residual === undefined ? '' : r.residual, r.source].map(csvEscape).join(','));
  }
  for (const r of result.unknowns) {
    lines.push(['unknown', r.well, r.label, r.sample, r.target, r.quantity === null ? '' : r.quantity, '', '', r.call, r.cq, '', '', ''].map(csvEscape).join(','));
  }
  lines.push('');
  lines.push(['section', 'sample', 'target', 'n', 'meanCq', 'sdCq', 'meanQuantity'].join(','));
  for (const s of result.samples) {
    lines.push(['sampleSummary', s.sample, s.target, s.n, s.meanCq, s.sdCq === null ? '' : s.sdCq, s.meanQuantity === null ? '' : s.meanQuantity].map(csvEscape).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = {
  fitStandardCurve, analyzeStandardCurve, quantify, fittedCq, efficiencyOf,
  labelToId, designStandards, mergeStandards, cqOf, toCsv, WELL_RE,
};

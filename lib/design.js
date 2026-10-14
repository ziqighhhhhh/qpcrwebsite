'use strict';
// ---------------------------------------------------------------------------
// Design-driven qPCR simulation (closed loop):
//
//   实验设计(design)                     面板设定：组别 / 生物学重复 / 技术重复 /
//                                         目的基因 / 内参基因 / 预期变化倍数 / 质量等级
//        ↓ deriveDesign()                系统自动反推：
//                                         理论表达量、初始模板量、预期 Cq 差异、PCR 扩增效率
//        ↓ synthesizeFromDesign()        加入随机因素：
//                                         生物学个体差异 / 移液误差 / RT 波动 /
//                                         PCR 效率变化 / 仪器噪声 / 异常孔
//        ↓                               每个孔生成：完整原始扩增曲线、Cq/Ct、
//                                         熔解曲线、QC 状态（真值记录在 truth 中）
//        ↓ 真实引擎分析（原版 Roche Kinetic）
//        ↓ analyzeDesign()               按真实 qPCR 分析流程：
//                                         ΔCt → ΔΔCt → Fold Change → 统计结果（Welch t / Cohen's d）
//
// 全链路内部自洽：合成曲线所用的生物学真值（每孔 trueCq / 每样本设计 ΔCt）都保存在
// exp.analysis.synthetic.truth 中，可与引擎实测值逐一对照，供前端渲染"真值 vs 实测"。
// ---------------------------------------------------------------------------
const { toLc96p, seedRandom } = require('./synthesize.js');
const stats = require('./stats.js');

// 实验质量等级 → 误差模型 + 推导效率
//   effPct  : 系统推导的 PCR 扩增效率（%）
//   bioSd   : 生物学个体差异（样本间 Cq SD，细胞系 ~0.3，组织/临床 1-2）
//   rtSd    : RT 波动（反转录效率差异，同一生物样本的靶基因/内参共享该偏移 → 在 ΔCt 中抵消）
//   pipSd   : 移液误差（复孔间 Cq SD）
//   effSd   : PCR 效率逐孔变化（效率小数 SD）
//   noise   : 仪器噪声等级 1低 / 2中 / 3高
//   abnormal: 异常孔概率（加样失败/气泡/坏孔 → 平线或严重滞后）
// 数值按 docs/模拟场景设定.md 的真实范围收敛：默认"良"下 ΔCt 的组均值 SEM ≈ 0.3-0.5，
// 使设计 2-4 倍效应（ΔΔCt 1-2 循环）在 3 个生物学重复下稳定检出且 Fold 波动在合理区间。
const QUALITY = {
  excellent: { label: '优', effPct: 100, bioSd: 0.25, rtSd: 0.08, pipSd: 0.08, effSd: 0.015, noise: 1, abnormal: 0.002 },
  good:      { label: '良', effPct: 98, bioSd: 0.40, rtSd: 0.15, pipSd: 0.12, effSd: 0.025, noise: 2, abnormal: 0.01 },
  fair:      { label: '中', effPct: 96, bioSd: 0.65, rtSd: 0.25, pipSd: 0.22, effSd: 0.035, noise: 2, abnormal: 0.035 },
  poor:      { label: '差', effPct: 94, bioSd: 1.00, rtSd: 0.38, pipSd: 0.35, effSd: 0.045, noise: 3, abnormal: 0.06 },
};
const NTC_COUNT = 2;          // 无模板对照孔数
const CT_BASE = 20;           // 对照组靶基因基线 Cq（推导初始模板量的锚点）
const COPY_AT_CT = 1e6;       // 基线 Cq 对应的模板拷贝数（任意单位，仅用于展示推导量）

// ---- Sybr-KA 引擎校准表 ----
// 用与 makeCurve 相同的曲线生成器（amp=2.2·2^((20−cq)·0.08)，kk=0.30+(eff·100−90)·0.02，
// 噪声≈0.0004）扫 (cq, eff) 网格，让原版引擎（Sybr-KA.adf）实测 CT1，
// 记录 dev(cq,eff) = 引擎 CT1 − 设计 Cq。合成时把设计 Cq 反向补偿
// （cq_adj = cq − dev），使引擎实测 Cq 落回设计值 → ΔCt/ΔΔCt/Fold 与设计自洽。
// cq 行 = 16..27（整数），eff 列 = 0.90..1.06（步长 0.02）。
const DEV_CQS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27];
const DEV_EFFS = [0.90, 0.92, 0.94, 0.96, 0.98, 1.00, 1.02, 1.04, 1.06];
const DEV = {
  16: [2.37, 1.48, 0.76, 0.18, -0.28, -0.89, -0.13, -0.11, -0.11],
  17: [2.21, 1.32, 0.61, 0.06, -0.41, -0.97, -0.24, -0.24, -0.19],
  18: [2.03, 0.97, 0.39, -0.07, -0.5, -1.05, -0.35, -0.33, -0.3],
  19: [1.55, 0.81, 0.24, -0.2, -0.61, -0.77, -0.46, -0.43, -0.39],
  20: [1.36, 0.66, 0.08, -0.29, -0.7, -0.92, -0.58, -0.54, -0.48],
  21: [1.2, 0.48, -0.07, -0.4, -0.8, -0.92, -0.68, -0.62, -0.6],
  22: [0.99, 0.32, -0.22, -0.56, -0.92, -1.09, -0.81, -0.72, -0.66],
  23: [0.78, 0.14, -0.37, -0.69, -0.87, -1.08, -0.93, -0.81, -0.76],
  24: [0.2, -0.28, -0.52, -0.83, -0.91, -1.2, -1.01, -0.94, -0.87],
  25: [-0.02, -0.48, -0.83, -1.06, -1.04, -1.15, -1.09, -1.03, -0.95],
  26: [-0.28, -0.67, -1, -1.08, -1.18, -1.34, -1.2, -1.14, -1.06],
  27: [-1, -0.89, -1.17, -1.25, -1.29, -1.32, -1.25, -1.22, -1.14],
};
// 双线性插值查表：给定设计 Cq 与逐孔效率，返回引擎系统偏差 dev（CT1 − Cq）
function devAt(cq, eff) {
  const c = Math.max(DEV_CQS[0], Math.min(DEV_CQS[DEV_CQS.length - 1], cq));
  const e = Math.max(DEV_EFFS[0], Math.min(DEV_EFFS[DEV_EFFS.length - 1], eff));
  let ci = 0, ei = 0;
  while (ci < DEV_CQS.length - 2 && DEV_CQS[ci + 1] <= c) ci++;
  while (ei < DEV_EFFS.length - 2 && DEV_EFFS[ei + 1] <= e) ei++;
  const c0 = DEV_CQS[ci], c1 = DEV_CQS[ci + 1], e0 = DEV_EFFS[ei], e1 = DEV_EFFS[ei + 1];
  const tc = (c - c0) / (c1 - c0 || 1), te = (e - e0) / (e1 - e0 || 1);
  const v00 = DEV[c0][ei], v01 = DEV[c0][ei + 1], v10 = DEV[c1][ei], v11 = DEV[c1][ei + 1];
  const a = v00 + (v10 - v00) * tc, b = v01 + (v11 - v01) * tc;
  return a + (b - a) * te;
}

const LIMITS = {
  groups: { min: 2, max: 4 },
  bioReps: { min: 1, max: 8 },
  techReps: { min: 1, max: 3 },
  foldChange: { min: 1.5, max: 20 },
  standards: {
    points: { min: 3, max: 6 },
    replicates: { min: 1, max: 3 },
    startQuantity: { min: 1e2, max: 1e9 },
    dilution: { min: 2, max: 100 },
  },
};

// 引擎校准表（DEV）覆盖的 Cq 区间：超出后 devAt 会钳制到边界行，实测 Cq 会系统偏离设计值。
const CALIBRATED_CQ = { min: DEV_CQS[0], max: DEV_CQS[DEV_CQS.length - 1] };

function gauss(random) { // Box-Muller standard normal
  let u = 0, v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return isNaN(n) ? dflt : clamp(n, lo, hi);
}
function clampNum(v, lo, hi, dflt) {
  const n = parseFloat(v);
  return isNaN(n) ? dflt : clamp(n, lo, hi);
}
function wellLabel(n) { return String.fromCharCode(64 + Math.ceil(n / 12)) + (((n - 1) % 12) + 1); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

// ---------------------------------------------------------------------------
// 1) 设计规范化 + 系统推导（纯函数，无随机，供面板实时预览）
// ---------------------------------------------------------------------------
function normalizeDesign(design) {
  const d = design || {};
  const s = d.standards || {};
  let groups = Array.isArray(d.groups) && d.groups.length ? d.groups : null;
  if (!groups) {
    groups = [{ name: '对照组', role: 'control' }, { name: '处理组', role: 'treatment' }];
  }
  groups = groups.slice(0, LIMITS.groups.max).map((g, i) => ({
    name: String((g && g.name) || (i === 0 ? '对照组' : '处理组' + i)).slice(0, 40),
    role: i === 0 ? 'control' : 'treatment',   // 第 1 组固定为对照组，其余为处理组
  }));
  while (groups.length < LIMITS.groups.min) groups.push({ name: '处理组' + groups.length, role: 'treatment' });
  return {
    groups,
    bioReps: clampInt(d.bioReps, LIMITS.bioReps.min, LIMITS.bioReps.max, 3),
    techReps: clampInt(d.techReps, LIMITS.techReps.min, LIMITS.techReps.max, 3),
    targetGene: String(d.targetGene || 'IL6').slice(0, 40),
    refGene: String(d.refGene || 'GAPDH').slice(0, 40),
    foldChange: clamp(parseFloat(d.foldChange) || 4, LIMITS.foldChange.min, LIMITS.foldChange.max),
    direction: d.direction === 'down' ? 'down' : 'up',
    quality: QUALITY[d.quality] ? d.quality : 'good',
    seed: d.seed === '' || d.seed === null || d.seed === undefined ? null : (Number.isNaN(parseInt(d.seed, 10)) ? null : parseInt(d.seed, 10)),
    // 标准曲线（绝对定量）：系列稀释标准品，独立于分组样本
    standards: {
      enabled: !!(s.enabled === true || s.enabled === 'true' || s.enabled === 1 || s.enabled === '1'),
      points: clampInt(s.points, LIMITS.standards.points.min, LIMITS.standards.points.max, 5),
      replicates: clampInt(s.replicates, LIMITS.standards.replicates.min, LIMITS.standards.replicates.max, 3),
      startQuantity: clampNum(s.startQuantity, LIMITS.standards.startQuantity.min, LIMITS.standards.startQuantity.max, 1e7),
      dilution: clampNum(s.dilution, LIMITS.standards.dilution.min, LIMITS.standards.dilution.max, 5),
      unit: String(s.unit || 'copies').slice(0, 24),
    },
  };
}

// 系统自动反推：理论表达量 / 初始模板量 / 预期 Cq 差异 / PCR 扩增效率
function deriveDesign(design) {
  const d = normalizeDesign(design);
  const q = QUALITY[d.quality];
  const effFrac = q.effPct / 100;
  // 预期 Cq 差异：fold = (1+E)^ΔCq  →  ΔCq = ln(fold)/ln(1+E)
  const deltaCq = Math.log(d.foldChange) / Math.log(1 + effFrac);
  const treatCq = CT_BASE + (d.direction === 'down' ? deltaCq : -deltaCq);
  const treatCopies = COPY_AT_CT * Math.pow(2, CT_BASE - treatCq);          // 模板量 = C0·2^(ctBase−Cq)
  const refCq = CT_BASE + 0.5;                                              // 内参略晚于靶基线（真实感）
  const refCopies = COPY_AT_CT * Math.pow(2, CT_BASE - refCq);
  const exprTreat = d.direction === 'up' ? d.foldChange : 1 / d.foldChange; // 理论表达量（对照=1）
  // ---- 标准曲线：系列稀释 → 设计 Cq（由设计的扩增效率反推）----
  // 标准品只有移液/效率/仪器噪声，没有生物学变异；Cq = ctBase − ln(q/copies@ctBase)/ln(1+E)
  const std = d.standards;
  let standards = null, standardWells = 0;
  const standardWarnings = [];
  if (std.enabled) {
    const points = [];
    for (let i = 0; i < std.points; i++) {
      const quantity = std.startQuantity / Math.pow(std.dilution, i);
      const cq = CT_BASE - Math.log(quantity / COPY_AT_CT) / Math.log(1 + effFrac);
      points.push({
        index: i + 1,
        quantity,
        log10: Math.round(Math.log(quantity) / Math.LN10 * 10000) / 10000,
        cq: Math.round(cq * 100) / 100,
      });
    }
    standardWells = std.points * std.replicates;
    const designedSlope = -1 / (Math.log(1 + effFrac) / Math.LN10);
    standards = {
      unit: std.unit,
      dilution: std.dilution,
      startQuantity: std.startQuantity,
      replicates: std.replicates,
      designedSlope: Math.round(designedSlope * 10000) / 10000,
      designedEfficiencyPct: Math.round(effFrac * 1000) / 10,
      points,
    };
    const cqs = points.map(p => p.cq);
    const lo = Math.min(...cqs), hi = Math.max(...cqs);
    if (hi > CALIBRATED_CQ.max || lo < CALIBRATED_CQ.min) {
      standardWarnings.push('标准品设计 Cq ' + lo.toFixed(2) + '–' + hi.toFixed(2) +
        ' 超出引擎校准区间 ' + CALIBRATED_CQ.min + '–' + CALIBRATED_CQ.max +
        '：引擎实测偏差会被外推，实测效率可能偏离设计（建议调小稀释倍数或降低起始浓度）');
    }
    if (points[points.length - 1].quantity < COPY_AT_CT / 1e6) {
      standardWarnings.push('最低标准品浓度 ' + points[points.length - 1].quantity.toExponential(1) + ' 已接近单拷贝量级，真实实验中不可靠');
    }
  }
  const totalWells = d.groups.length * d.bioReps * d.techReps * 2 + NTC_COUNT + standardWells; // 靶+内参各 techReps 孔 + NTC + 标准品
  const issues = [];
  if (totalWells > 96) issues.push('总孔数 ' + totalWells + ' 超过 96 孔上限，请减小重复数或标准品点数');
  // 理论 ΔCt（设计真值，不含随机抽样）：ΔCt = 靶 Cq − 内参 Cq
  const theoryDct = {
    control: Math.round((CT_BASE - refCq) * 100) / 100,
    treatment: Math.round((treatCq - refCq) * 100) / 100,
  };
  return {
    design: d,
    quality: q,
    efficiencyPct: Math.round(effFrac * 1000) / 10,      // PCR 扩增效率（推导）
    deltaCq: Math.round(deltaCq * 100) / 100,            // 预期 Cq 差异
    treatCq: Math.round(treatCq * 100) / 100,
    theoryDct,                                           // 理论 ΔCt（设计真值）
    theoreticalExpression: {                             // 理论表达量（对照靶=1）
      control: 1,
      treatment: Math.round(exprTreat * 1000) / 1000,
      ref: 1,
    },
    templateCopies: {                                    // 初始模板量（拷贝/反应，任意单位）
      control: COPY_AT_CT,
      treatment: Math.round(treatCopies),
      ref: Math.round(refCopies),
    },
    totalWells,
    standardWells,
    standards,                                           // 标准曲线设计（含设计斜率/效率/各点 Cq）
    warnings: standardWarnings,                          // 非阻断性提示（如超出引擎校准区间）
    issues,
  };
}

// ---------------------------------------------------------------------------
// 2) 自动布板：从设计生成 96 孔板命名（供展示 / 导出叠加）
// ---------------------------------------------------------------------------
function buildLayout(design) {
  const d = normalizeDesign(design);
  const wells = {};
  let id = 1;
  // 标准品排在最前（A 行起，符合真实板面习惯）：每点 replicates 孔，按稀释顺序排列
  if (d.standards.enabled) {
    for (let i = 0; i < d.standards.points; i++) {
      const quantity = d.standards.startQuantity / Math.pow(d.standards.dilution, i);
      const simple = 'STD ' + formatQuantity(quantity);
      for (let r = 1; r <= d.standards.replicates && id <= 96; r++) {
        wells[wellLabel(id)] = { target: d.targetGene, simple };
        id++;
      }
    }
  }
  d.groups.forEach((g, gi) => {
    for (let b = 1; b <= d.bioReps; b++) {
      const sample = g.role === 'control' ? 'C' + b : 'T' + gi + '-' + b;
      for (let r = 1; r <= d.techReps; r++) { wells[wellLabel(id)] = { target: d.targetGene, simple: sample }; id++; }
      for (let r = 1; r <= d.techReps; r++) { wells[wellLabel(id)] = { target: d.refGene, simple: sample }; id++; }
    }
  });
  for (let i = 0; i < NTC_COUNT; i++) { wells[wellLabel(id)] = { target: d.targetGene, simple: 'NTC' }; id++; }
  return wells;
}

// 浓度显示：1e7 → 1.0E7（板面/表格里比 10000000 好读）
function formatQuantity(q) {
  if (!Number.isFinite(q)) return '';
  if (q >= 1e4) {
    const e = Math.floor(Math.log(q) / Math.LN10);
    const m = q / Math.pow(10, e);
    return (Math.round(m * 10) / 10) + 'E' + e;
  }
  return String(Math.round(q * 100) / 100);
}

// ---------------------------------------------------------------------------
// 3) 从设计合成实验（含全部随机因素与真值记录）
// ---------------------------------------------------------------------------
function synthesizeFromDesign(design, opts = {}) {
  const d = normalizeDesign(design);
  const der = deriveDesign(d);
  if (der.issues.length) throw new Error('设计无效：' + der.issues.join('；'));
  const random = seedRandom(d.seed);
  const q = der.quality;
  const effFrac = q.effPct / 100;
  const deltaCq = der.deltaCq;
  const ctBase = CT_BASE, refBase = CT_BASE + 0.5;

  // ---- 物理参数（与 synthesize.js 同构）----
  // 仪器噪声（按质量等级）：实测确认 >0.002 时逐孔效率波动下的正常曲线可能被误判
  // Negative（引擎判定不稳定区），故 3 档 = 0.0004 / 0.001 / 0.002。
  const base = 0.004 + random() * 0.002;
  const noise = [0.0004, 0.001, 0.002][q.noise - 1];
  const amp0 = 2.2, th = 0.071, nCycles = 40;
  const mBase = 0.02, mSigma = 1.6;
  const mTmTarget = 85.0, mTmRef = 86.5;     // 目的基因/内参基因熔解峰温度

  const dyes = ['SYBR Green I'];
  const channelOf = { 'SYBR Green I': 0 };
  const samples = [], wells = [], curves = [], melt = {};
  const truth = {};   // wellId -> {group, groupIndex, sample, gene, role, trueCq, qc}
  let id = 1;

  const makeCurve = (cq, mTm, effWell) => {
    // 引擎校准补偿：cq_adj = cq − dev(cq, effWell)，使引擎实测 CT1 ≈ 设计 cq
    const cqAdj = cq - devAt(cq, effWell);
    const amp = Math.max(0.4, amp0 * Math.pow(2, (ctBase - cq) * 0.08)); // 早 Cq → 高平台
    const kk = 0.30 + (effWell * 100 - 90) * 0.02;                        // 逐孔效率 → 陡度
    const c0 = cqAdj + Math.log(amp / th - 1) / kk;                       // Sybr-KA 校准（含补偿）
    const pts = [];
    for (let c = 1; c <= nCycles; c++) {
      const y = base + amp / (1 + Math.exp(-kk * (c - c0))) + gauss(random) * noise;
      pts.push({ c, f: Math.max(0, y) });
    }
    return pts;
  };
  const makeNtcCurve = () => {
    const pts = [];
    // NTC 噪声固定 ≈1e-4（实测：噪声过高时平线被判 Invalid；1e-4 稳定判 Negative）
    for (let c = 1; c <= nCycles; c++) pts.push({ c, f: Math.max(0, base + gauss(random) * 1e-4) });
    return pts;
  };
  const makeMelt = (mTm, cq) => {
    const ampScale = Math.max(0.3, Math.pow(2, (ctBase - cq) * 0.08));
    const peak = mBase + 0.06 * ampScale;
    const pts = [];
    for (let T = 65; T <= 96.9; T += 0.2) {
      const f = peak * Math.exp(-((T - mTm) * (T - mTm)) / (2 * mSigma * mSigma));
      pts.push({ t: Math.round(T * 10) / 10, f: mBase + f + gauss(random) * noise * 0.5 });
    }
    return pts;
  };

  // ---- 标准品系列（板面前几行）：只有移液/效率/仪器噪声，没有生物学变异 ----
  if (der.standards) {
    for (const p of der.standards.points) {
      const sampleId = 'std-' + p.index;
      const sampleName = 'STD ' + formatQuantity(p.quantity);
      samples.push({ id: sampleId, description: sampleName, type: 'std' });
      for (let r = 1; r <= d.standards.replicates; r++) {
        if (id > 96) break;
        const pip = gauss(random) * q.pipSd;                                  // 移液误差
        const effWell = clamp(effFrac + gauss(random) * q.effSd, 0.94, 1.10);  // 逐孔效率
        const cq = p.cq + pip;
        wells.push({ id, label: wellLabel(id), sampleId, sampleName, sampleType: 'std' });
        curves.push({ well: id, dye: 'SYBR Green I', channel: 0, targetId: 'SYBR Green I@Target', points: makeCurve(cq, mTmTarget, effWell) });
        melt[id + '|SYBR Green I'] = { well: id, dye: 'SYBR Green I', points: makeMelt(mTmTarget, cq) };
        truth[id] = {
          group: 'Standard', groupIndex: -2, sample: sampleName,
          gene: d.targetGene, role: 'standard',
          quantity: p.quantity, unit: d.standards.unit, log10: p.log10,
          trueCq: Math.round(cq * 100) / 100, qc: 'ok',
        };
        id++;
      }
    }
  }

  d.groups.forEach((g, gi) => {
    const isControl = g.role === 'control';
    const groupCt = isControl ? ctBase : (d.direction === 'down' ? ctBase + deltaCq : ctBase - deltaCq);
    for (let b = 1; b <= d.bioReps; b++) {
      const sampleId = 'dsg-' + gi + '-' + b;
      const sampleName = (isControl ? 'Control' : 'Treatment ' + gi) + ' ' + b;
      const rtShift = gauss(random) * q.rtSd;                     // RT 波动（靶/内参共享，ΔCt 中部分抵消）
      const sampleCqTarget = groupCt + rtShift + gauss(random) * q.bioSd;   // 生物学个体差异
      const sampleCqRef = refBase + rtShift + gauss(random) * q.bioSd * 0.7; // 内参变异略小
      samples.push({ id: sampleId, description: sampleName, type: 'unkn' });
      for (const gene of ['target', 'ref']) {
        const isTarget = gene === 'target';
        const sampleCq = isTarget ? sampleCqTarget : sampleCqRef;
        const mTm = isTarget ? mTmTarget : mTmRef;
        for (let r = 1; r <= d.techReps; r++) {
          if (id > 96) break;
          const abnormal = random() < q.abnormal;       // 异常孔判定
          const pip = gauss(random) * q.pipSd;                     // 移液误差
          // 逐孔 PCR 效率变化。下限 0.94：实测确认效率 <0.93 时引擎会把
          // 正常扩增曲线误判 Negative（低效率曲线拟合失败），故截断在稳定区。
          const effWell = clamp(effFrac + gauss(random) * q.effSd, 0.94, 1.10);
          let cq = sampleCq + pip;
          let pts, flat = false;
          if (abnormal) {
            // 异常孔：~60% 平线（加样失败），~40% 严重滞后（低效/污染抑制）
            if (random() < 0.6) { flat = true; pts = makeNtcCurve(); }
            else { cq += 7 + random() * 4; pts = makeCurve(cq, mTm, effWell); }
          } else {
            pts = makeCurve(cq, mTm, effWell);
          }
          wells.push({ id, label: wellLabel(id), sampleId, sampleName, sampleType: 'unkn' });
          curves.push({ well: id, dye: 'SYBR Green I', channel: 0, targetId: 'SYBR Green I@Target', points: pts });
          melt[id + '|SYBR Green I'] = flat
            ? { well: id, dye: 'SYBR Green I', points: [{ t: 65, f: mBase }, { t: 96.9, f: mBase }] }
            : { well: id, dye: 'SYBR Green I', points: makeMelt(mTm, cq) };
          truth[id] = {
            group: g.name, groupIndex: gi,
            sample: sampleName,
            gene: isTarget ? d.targetGene : d.refGene,
            role: isControl ? 'control' : 'treatment',
            trueCq: Math.round(cq * 100) / 100,
            qc: abnormal ? 'abnormal' : 'ok',
          };
          id++;
        }
      }
    }
  });

  // NTC 平线孔
  for (let i = 0; i < NTC_COUNT && id <= 96; i++) {
    const sampleId = 'dsg-ntc-' + i;
    samples.push({ id: sampleId, description: 'NTC ' + (i + 1), type: 'ntc' });
    wells.push({ id, label: wellLabel(id), sampleId, sampleName: 'NTC ' + (i + 1), sampleType: 'ntc' });
    curves.push({ well: id, dye: 'SYBR Green I', channel: 0, targetId: 'SYBR Green I@Target', points: makeNtcCurve() });
    melt[id + '|SYBR Green I'] = { well: id, dye: 'SYBR Green I', points: [{ t: 65, f: mBase }, { t: 96.9, f: mBase }] };
    truth[id] = { group: 'NTC', groupIndex: -1, sample: 'NTC', gene: d.targetGene, role: 'ntc', trueCq: null, qc: 'ntc' };
    id++;
  }
  for (; id <= 96; id++) wells.push({ id, label: wellLabel(id), sampleId: null, sampleName: '', sampleType: '' });

  const experiment = {
    id: 'design-syn-' + Date.now().toString(36),
    name: 'design_experiment.lc96p',
    meta: { id: '', made: '', updated: '' },
    dyes, channelOf,
    samples, wells, curves, melt,
    factGraph: {}, storedKinetic: {}, storedQual: {},
    settings: { genes: [], samples: [], internalControlDye: '' },
    computed: {}, analyzedAt: null,
    analysis: {
      adf: 'Sybr-KA.adf',
      engine: 'Roche Kinetic 1.5.3.1244 (design-driven synthetic input, real processing)',
      synthetic: {
        design: d,
        derived: der,
        truth,                                        // 每孔生物学真值（内部自洽的锚）
        note: '输入为按实验设计（组别/重复/基因/倍数/质量等级）合成的模拟数据；' +
              '合成时记录每孔真值 trueCq，引擎实测结果可与真值对照（ΔCt/ΔΔCt/Fold/统计）。',
      },
    },
  };
  return { experiment, layout: buildLayout(d), derived: der, truth };
}

// ---------------------------------------------------------------------------
// 4) 设计实验分析：按真实 qPCR 流程 ΔCt → ΔΔCt → Fold → 统计（引擎实测值）
// ---------------------------------------------------------------------------
function analyzeDesign(exp, design) {
  const d = normalizeDesign(design);
  const truth = (exp.analysis && exp.analysis.synthetic && exp.analysis.synthetic.truth) || {};
  // 汇总每生物样本的靶/内参 Cq（仅 Positive 计入，与真实软件一致）
  const bySample = {};   // sampleId -> {name, group, groupIndex, role, target:[], ref:[]}
  for (const w of exp.wells) {
    // 标准品孔不参与 ΔΔCt 分组统计（它们属于标准曲线分析）；NTC 同样排除
    if (!w.sampleId || w.sampleType === 'ntc' || w.sampleType === 'std') continue;
    const c = exp.computed[w.id + '|SYBR Green I'];
    const cq = c && c['11 Intermediate Call'] === 'Positive' ? c['26 CT1'] : null;
    if (!Number.isFinite(cq)) continue;
    const t = truth[w.id] || {};
    const sm = bySample[w.sampleId] || (bySample[w.sampleId] = {
      name: w.sampleName, group: t.group || '', groupIndex: t.groupIndex, role: t.role || 'treatment',
      target: [], ref: [], dCt: null, designedDct: null, wells: [],
    });
    (t.gene === d.refGene ? sm.ref : sm.target).push(cq);
    sm.wells.push({ well: w.id, label: w.label, cq, gene: t.gene || d.targetGene, qc: t.qc || 'ok' });
  }
  for (const key of Object.keys(bySample)) {
    const sm = bySample[key];
    const tMean = mean(sm.target), rMean = mean(sm.ref);
    sm.targetCq = tMean; sm.refCq = rMean;
    sm.dCt = (tMean !== null && rMean !== null) ? Math.round((tMean - rMean) * 100) / 100 : null;
    // 设计真值 ΔCt（来自 truth 中样本级设计 Cq 的平均）
    const dts = [], drs = [];
    for (const w of sm.wells) {
      const t = truth[w.well];
      if (!t) continue;
      if (t.gene === d.refGene) drs.push(t.trueCq); else dts.push(t.trueCq);
    }
    const dm = mean(dts), drm = mean(drs);
    sm.designedDct = (dm !== null && drm !== null) ? Math.round((dm - drm) * 100) / 100 : null;
  }

  // 按组汇总 ΔCt（生物学重复为统计单元）
  const derived = (exp.analysis && exp.analysis.synthetic && exp.analysis.synthetic.derived) || {};
  const theory = derived.theoryDct || null;   // {control, treatment} 理论 ΔCt（设计真值）
  const groups = {};   // groupIndex -> {name, role, dcts:[], n}
  for (const key of Object.keys(bySample)) {
    const sm = bySample[key];
    if (sm.dCt === null) continue;
    const gk = sm.groupIndex === undefined ? -1 : sm.groupIndex;
    const g = groups[gk] || (groups[gk] = { name: sm.group, role: sm.role, dcts: [], designed: [] });
    g.dcts.push(sm.dCt);
    if (sm.designedDct !== null) g.designed.push(sm.designedDct);
  }
  const groupKeys = Object.keys(groups).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const groupList = groupKeys.map(k => {
    const g = groups[k];
    const meanV = mean(g.dcts);
    return {
      key: k, name: g.name, role: g.role, n: g.dcts.length,
      dCt: meanV === null ? null : Math.round(meanV * 100) / 100,
      sd: g.dcts.length > 1 ? Math.round(stats.sd(g.dcts) * 100) / 100 : null,
      // 组级设计真值 = 理论 ΔCt（不含抽样噪声；抽样后的每样本真值见 samples 明细）
      designedDct: (theory && (g.role === 'control' ? theory.control : theory.treatment)) ?? null,
      sampledDct: mean(g.designed) === null ? null : Math.round(mean(g.designed) * 100) / 100,
    };
  });

  const control = groupList.find(g => g.role === 'control') || groupList[0];
  const treatments = groupList.filter(g => g !== control);
  const out = { groups: groupList, control, treatments: [], samples: bySample, wellCount: 96 };
  if (control && control.dCt !== null) {
    const ctrlDcts = groups[control.key].dcts;
    for (const tr of treatments) {
      const ddCt = tr.dCt === null ? null : Math.round((tr.dCt - control.dCt) * 100) / 100;
      const fold = ddCt === null ? null : Math.round(Math.pow(2, -ddCt) * 1000) / 1000; // 2^(−ΔΔCt)
      // 两独立样本 Welch t 检验（组间生物学重复独立）
      const trDcts = groups[tr.key].dcts;
      let p = null, stars = 'n.s.', cohensD = null;
      if (ctrlDcts.length >= 2 && trDcts.length >= 2) {
        const tt = stats.ttestIndependent(ctrlDcts, trDcts);
        p = tt.p; stars = stats.stars(tt.p);
        cohensD = stats.cohensD(ctrlDcts, trDcts);
      }
      // 设计真值 Fold = 期望表达倍数（up → foldChange，down → 1/foldChange）
      const theoryDdCt = (theory && tr.designedDct !== null && control.designedDct !== null)
        ? tr.designedDct - control.designedDct : null;
      const expectFold = d.direction === 'up' ? d.foldChange : 1 / d.foldChange;
      out.treatments.push({
        name: tr.name, dCt: tr.dCt, sd: tr.sd, n: tr.n,
        ddCt, fold, p, stars, cohensD,
        mannWhitney: stats.mannWhitneyU(ctrlDcts, trDcts),
        significant: p !== null && p < 0.05,
        designedDdCt: theoryDdCt === null ? null : Math.round(theoryDdCt * 100) / 100,
        designedFold: Math.round(expectFold * 1000) / 1000,
      });
    }
  }
  // 逐孔 QC 汇总（标准品孔不计入：它们属于标准曲线，不属于样本 QC）
  const qc = { abnormal: 0, ok: 0, ntc: 0, ntcBad: 0, standards: 0 };
  for (const w of exp.wells) {
    const t = truth[w.id];
    if (!t) continue;
    if (t.role === 'standard') { qc.standards++; continue; }
    if (t.qc === 'abnormal') qc.abnormal++;
    if (t.role === 'ntc') {
      qc.ntc++;
      const c = exp.computed[w.id + '|SYBR Green I'];
      if (!c || c['11 Intermediate Call'] !== 'Negative') qc.ntcBad++;
    }
  }
  out.qc = qc;
  // 标准曲线自检：用设计真值（trueCq，不含引擎偏差）拟合，验证设计链路自洽
  if (derived.standards) {
    const curve = require('./standardcurve.js');
    const rows = [];
    for (const id of Object.keys(truth)) {
      const t = truth[id];
      if (t.role === 'standard' && Number.isFinite(t.trueCq)) rows.push({ quantity: t.quantity, cq: t.trueCq });
    }
    const fit = curve.fitStandardCurve(rows);
    out.standardCurve = {
      designed: derived.standards,
      truthFit: fit,
      efficiencyDeviation: (fit.ok && Number.isFinite(fit.efficiencyPct))
        ? Math.round((fit.efficiencyPct - derived.standards.designedEfficiencyPct) * 100) / 100 : null,
    };
  }
  return out;
}

module.exports = {
  QUALITY, LIMITS, CT_BASE, NTC_COUNT, CALIBRATED_CQ, formatQuantity,
  normalizeDesign, deriveDesign, buildLayout, synthesizeFromDesign, analyzeDesign, toLc96p,
};

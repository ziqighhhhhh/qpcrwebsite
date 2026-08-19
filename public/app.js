'use strict';
// ---------------------------------------------------------------------------
// qPCR Web — duo layout: left = original (treatment), right = simulated control.
// Each side has the 4 original-software views: Amplification Curves,
// Combined Call Heat Map, Heat Map, Result Table.
// ---------------------------------------------------------------------------
const state = {
  left: null,          // treatment experiment
  right: null,         // control experiment
  selectedWell: null,
  channel: 0,
  metric: 'Call',
  compare: new Set(),  // well ids added to curve comparison
  sort: { left: { col: 'Position', asc: true }, right: { col: 'Position', asc: true } },
};

const $ = id => document.getElementById(id);
const E = {
  fileInput: $('fileInput'), btnAnalyze: $('btnAnalyze'), btnExport: $('btnExport'),
  exportMenu: $('exportMenu'), metricSelect: $('metricSelect'), channelSelect: $('channelSelect'),
  status: $('status'),
  simDelta: $('simDelta'), simDeltaLabel: $('simDeltaLabel'),
  btnSimulate: $('btnSimulate'), btnDownloadControl: $('btnDownloadControl'),
  simResult: $('simResult'), compareCards: $('compareCards'), compareVerdict: $('compareVerdict'),
  leftTitle: $('leftTitle'), rightTitle: $('rightTitle'),
  leftCurve: $('leftCurve'), leftCurveLegend: $('leftCurveLegend'), leftCurveTitle: $('leftCurveTitle'),
  rightCurve: $('rightCurve'), rightCurveLegend: $('rightCurveLegend'), rightCurveTitle: $('rightCurveTitle'),
  leftCombined: $('leftCombined'), rightCombined: $('rightCombined'),
  leftHeat: $('leftHeat'), leftLegend: $('leftLegend'), leftHeatTitle: $('leftHeatTitle'),
  rightHeat: $('rightHeat'), rightLegend: $('rightLegend'), rightHeatTitle: $('rightHeatTitle'),
  leftTable: $('leftTable'), rightTable: $('rightTable'),
  relChart: $('relChart'), cqChart: $('cqChart'),
  ddctTable: $('ddctTable'), btnDdctCsv: $('btnDdctCsv'),
  leftMelt: $('leftMelt'), leftMeltLegend: $('leftMeltLegend'),
  rightMelt: $('rightMelt'), rightMeltLegend: $('rightMeltLegend'),
};

// ---------------- api ----------------
async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}
function setStatus(text, cls) { E.status.textContent = text; E.status.className = 'status ' + (cls || ''); }

// ---------------- data access (parameterized by experiment) ----------------
function dyeDataOf(exp, wellId, dye) {
  const key = wellId + '|' + dye;
  const c = (exp.computed && exp.computed[key]) || {};
  const sq = (exp.storedQual && exp.storedQual[key]) || null;
  const sk = (exp.storedKinetic && exp.storedKinetic[key]) || null;
  const curve = exp.curves.find(x => x.well === wellId && x.dye === dye) || null;
  const call = c['11 Intermediate Call'] !== undefined ? c['11 Intermediate Call'] : (sq ? (sq.call || '') : '');
  const rawCq = c['26 CT1'] !== undefined ? c['26 CT1'] : (sq && sq.cq !== undefined ? sq.cq : null);
  return {
    call,
    // 与原软件一致：仅 Positive 显示 Cq
    cq: call === 'Positive' ? rawCq : null,
    rawCq,
    slope: c['23 MRS'] !== undefined ? c['23 MRS'] : (sq && sq.slope !== undefined ? sq.slope : (sk ? sk.slope : null)),
    epf: c['78 LC96 Normalized ERI'] !== undefined ? c['78 LC96 Normalized ERI'] : (sq && sq.epf !== undefined ? sq.epf : null),
    params: Object.keys(c).length ? c : null,
    computed: Object.keys(c).length > 0,
    curve,
  };
}
function combinedOf(exp, wellId, dye) {
  const sq = (exp.storedQual && exp.storedQual[wellId + '|' + dye]) || null;
  if (sq && sq.combinedResult) return sq.combinedResult;
  return dyeDataOf(exp, wellId, dye).call || '';
}
function curveOf(exp, wellId, dye) { return exp.curves.find(x => x.well === wellId && x.dye === dye) || null; }

// ---------------- color helpers ----------------
function hsl(h, s, l) { return 'hsl(' + h + ', ' + s + '%, ' + l + '%)'; }
function metricColor(exp, wellId, dye) {
  const d = dyeDataOf(exp, wellId, dye);
  const m = state.metric;
  if (m === 'Call') {
    if (d.call === 'Positive') return '#37c26b';
    if (d.call === 'Negative') return '#e05252';
    return '#3a455e';
  }
  const v = d[m];
  if (v === null || v === undefined || isNaN(v)) return '#3a455e';
  let lo, hi;
  if (m === 'Cq') { lo = 15; hi = 40; }
  else if (m === 'EPF') { lo = 0; hi = 2.5; }
  else { lo = 0; hi = 0.25; }
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return hsl((1 - t) * 120, 70, 50);
}
function combinedColor(c) {
  if (c === 'Positive') return '#37c26b';
  if (c === 'Negative') return '#e05252';
  if (c === 'Invalid') return '#ffcc33';
  if (c === 'Inconsistent') return '#ff9f43';
  return '#3a455e';
}
function fmtNum(v, d) {
  if (v === null || v === undefined || isNaN(v)) return '';
  d = d === undefined ? 4 : d;
  return String(Math.round(v * Math.pow(10, d)) / Math.pow(10, d));
}

// ---------------- plate builders ----------------
function buildPlate(el, exp, colorFn, titleFn) {
  const dye = exp.dyes[state.channel] || exp.dyes[0];
  el.innerHTML = '';
  for (const w of exp.wells) {
    const hasCurve = !!curveOf(exp, w.id, dye);
    const div = document.createElement('div');
    div.className = 'well' + (hasCurve ? '' : ' empty') + (state.selectedWell === w.id ? ' selected' : '');
    div.style.background = hasCurve ? colorFn(w.id, dye) : '#1d2537';
    const sampleText = (w.sampleName || '').replace(/^Sample\s*/i, '') || w.label;
    div.innerHTML = '<span class="well-label">' + sampleText + '</span><span class="well-pos">' + w.label + '</span>';
    const d = dyeDataOf(exp, w.id, dye);
    div.title = w.label + (w.sampleName ? ' · ' + w.sampleName : '') + (d.call ? ' · ' + d.call : '') + (d.cq !== null && d.cq !== undefined ? ' · Cq=' + d.cq : '');
    div.onclick = () => {
      state.selectedWell = (state.selectedWell === w.id ? null : w.id);
      renderAll();
    };
    el.appendChild(div);
  }
  if (titleFn) titleFn();
}
function buildLegend(el, mode) {
  if (mode === 'call') {
    el.innerHTML =
      '<span><span class="sw" style="background:#37c26b"></span>Positive</span>' +
      '<span><span class="sw" style="background:#e05252"></span>Negative</span>' +
      '<span><span class="sw" style="background:#3a455e"></span>无数据</span>';
  } else if (mode === 'combined') {
    el.innerHTML =
      '<span><span class="sw" style="background:#37c26b"></span>Positive</span>' +
      '<span><span class="sw" style="background:#e05252"></span>Negative</span>' +
      '<span><span class="sw" style="background:#ffcc33"></span>Invalid</span>' +
      '<span><span class="sw" style="background:#ff9f43"></span>Inconsistent</span>';
  } else {
    const m = state.metric;
    el.innerHTML =
      '<span>低 <span class="sw" style="background:' + hsl(120, 70, 50) + '"></span></span>' +
      '<span><span class="sw" style="background:' + hsl(60, 70, 50) + '"></span></span>' +
      '<span><span class="sw" style="background:' + hsl(0, 70, 50) + '"></span> 高</span>' +
      '<span style="margin-left:auto">指标: ' + m + '</span>';
  }
}

// ---------------- curves ----------------
function fluorAt(curve, cq) {
  if (!curve || !curve.points.length || cq === null || cq === undefined || isNaN(cq)) return null;
  const pts = curve.points;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].c >= cq) {
      const a = pts[i - 1], b = pts[i];
      const t = (cq - a.c) / (b.c - a.c || 1);
      return a.f + t * (b.f - a.f);
    }
  }
  return pts[pts.length - 1].f;
}
function renderCurves(side, exp) {
  const canvas = side === 'left' ? E.leftCurve : E.rightCurve;
  const legendEl = side === 'left' ? E.leftCurveLegend : E.rightCurveLegend;
  const titleEl = side === 'left' ? E.leftCurveTitle : E.rightCurveTitle;
  const dye = exp.dyes[state.channel] || exp.dyes[0];
  const wells = [];
  if (state.selectedWell) wells.push(state.selectedWell);
  state.compare.forEach(w => { if (!wells.includes(w)) wells.push(w); });

  titleEl.textContent = '· ' + dye + (wells.length ? ' · 孔: ' + wells.map(w => (exp.wells[w - 1] || {}).label).join(', ') : ' · 未选择孔位');
  const series = [];
  const legendItems = [];
  const colors = ['#4da3ff', '#ff8d6b', '#7fe3a0', '#ffd166', '#c17bff', '#5ad0d0'];
  wells.forEach((w, i) => {
    const d = dyeDataOf(exp, w, dye);
    if (!d.curve || !d.curve.points.length) return;
    const color = colors[i % colors.length];
    const label = (exp.wells[w - 1] || {}).label + (d.call ? ' [' + d.call + ']' : '');
    series.push({ name: label, color, width: state.selectedWell === w ? 3 : 1.5, dash: state.selectedWell === w ? null : [4, 3], points: d.curve.points.map(p => ({ x: p.c, y: p.f })) });
    legendItems.push('<span class="cl-item"><span class="cl-dot" style="background:' + color + '"></span>' + label + '</span>');
  });
  legendEl.innerHTML = legendItems.join('') || '<span class="cl-item" style="color:#5c7399">未选择孔位 — 点击热图/表格中的孔</span>';
  drawLineChart(canvas, series, { xLabel: 'Cycle 循环数', yLabel: 'Fluorescence 荧光', height: 300 });
}

// ---------------- result table ----------------
const TABLE_COLS = [
  { key: 'checkbox', label: '☐', num: false },
  { key: 'Well', label: 'Well', num: false },
  { key: 'Sample', label: 'Sample', num: false },
  { key: 'Call', label: 'Call', num: false },
  { key: 'Cq', label: 'Cq', num: true },
  { key: 'Slope', label: 'Slope', num: true },
  { key: 'EPF', label: 'EPF', num: true },
  { key: 'Combined', label: 'Combined', num: false },
  { key: 'Validity', label: 'Validity', num: true },
  { key: 'SNR', label: 'SNR', num: true },
  { key: 'AmpEff', label: 'AmpEff', num: true },
];
function renderTable(side, exp) {
  const table = side === 'left' ? E.leftTable : E.rightTable;
  const dye = exp.dyes[state.channel] || exp.dyes[0];
  const rows = [];
  for (const w of exp.wells) {
    const d = dyeDataOf(exp, w.id, dye);
    if (!d.curve) continue;
    const sq = (exp.storedQual && exp.storedQual[w.id + '|' + dye]) || null;
    rows.push({
      key: w.id, well: w.id, Well: w.label, Sample: w.sampleName || '',
      Call: d.call, Cq: d.cq, Slope: d.slope, EPF: d.epf,
      Combined: sq && sq.combinedResult ? sq.combinedResult : '',
      Validity: d.params ? d.params['42 Validity Value'] : null,
      SNR: d.params ? d.params['48 Signal To Noise'] : null,
      AmpEff: d.params ? d.params['49 Amplification Efficiency'] : null,
    });
  }
  const sc = state.sort[side];
  rows.sort((a, b) => {
    const va = a[sc.col], vb = b[sc.col];
    const na = typeof va === 'number' && !isNaN(va), nb = typeof vb === 'number' && !isNaN(vb);
    if (na && nb) return sc.asc ? va - vb : vb - va;
    const sa = String(va === null || va === undefined ? '' : va);
    const sb = String(vb === null || vb === undefined ? '' : vb);
    return sc.asc ? sa.localeCompare(sb) : sb.localeCompare(sa);
  });
  table.querySelector('thead').innerHTML = '<tr>' + TABLE_COLS.map(c => {
    const arrow = sc.col === c.key ? (sc.asc ? ' ▲' : ' ▼') : '';
    return '<th data-col="' + c.key + '"' + (c.num ? '' : ' class="l"') + '>' + c.label + arrow + '</th>';
  }).join('') + '</tr>';
  table.querySelector('tbody').innerHTML = rows.map(r => {
    const checked = state.compare.has(r.well) ? 'checked' : '';
    const selected = state.selectedWell === r.well ? ' class="selected-row"' : '';
    const callCls = r.Call === 'Positive' ? 'pos' : (r.Call === 'Negative' ? 'pos neg' : '');
    return '<tr' + selected + '>' +
      '<td><input type="checkbox" data-well="' + r.well + '" ' + checked + '></td>' +
      '<td class="l">' + r.Well + '</td>' +
      '<td class="l">' + r.Sample + '</td>' +
      '<td class="l ' + callCls + '">' + r.Call + '</td>' +
      '<td>' + fmtNum(r.Cq, 2) + '</td>' +
      '<td>' + fmtNum(r.Slope, 4) + '</td>' +
      '<td>' + fmtNum(r.EPF, 4) + '</td>' +
      '<td class="l">' + r.Combined + '</td>' +
      '<td>' + fmtNum(r.Validity, 3) + '</td>' +
      '<td>' + fmtNum(r.SNR, 1) + '</td>' +
      '<td>' + fmtNum(r.AmpEff, 3) + '</td>' +
      '</tr>';
  }).join('');
  table.querySelectorAll('th[data-col]').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.col;
      if (state.sort[side].col === col) state.sort[side].asc = !state.sort[side].asc;
      else { state.sort[side].col = col; state.sort[side].asc = true; }
      renderTable(side, exp);
    };
  });
  table.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      const w = parseInt(cb.dataset.well, 10);
      if (cb.checked) state.compare.add(w); else state.compare.delete(w);
      renderAll();
    };
  });
  table.querySelectorAll('tbody tr').forEach((tr, i) => {
    tr.onclick = e => {
      if (e.target.tagName === 'INPUT') return;
      const w = rows[i].well;
      state.selectedWell = (state.selectedWell === w ? null : w);
      renderAll();
    };
  });
}

// ---------------- melting curves ----------------
function renderMelt(side, exp) {
  const canvas = side === 'left' ? E.leftMelt : E.rightMelt;
  const legendEl = side === 'left' ? E.leftMeltLegend : E.rightMeltLegend;
  const dye = exp.dyes[state.channel] || exp.dyes[0];
  if (!exp.melt || !Object.keys(exp.melt).length) {
    drawLineChart(canvas, [], { xLabel: 'Temperature (°C)', yLabel: 'Fluorescence' });
    canvas.getContext('2d'); // noop touch
    const ctx = canvas.getContext('2d');
    const w = canvas.width / (window.devicePixelRatio || 1);
    ctx.fillStyle = '#5c7399'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(side === 'right' ? '对照组为模拟扩增数据（无熔解采集）' : '无熔解数据', w / 2, 100);
    legendEl.innerHTML = '';
    return;
  }
  const wells = [];
  if (state.selectedWell) wells.push(state.selectedWell);
  state.compare.forEach(w => { if (!wells.includes(w)) wells.push(w); });
  const colors = ['#4da3ff', '#ff8d6b', '#7fe3a0', '#ffd166', '#c17bff', '#5ad0d0'];
  const series = [];
  const legendItems = [];
  wells.forEach((w, i) => {
    const m = exp.melt[w + '|' + dye];
    if (!m || !m.points.length) return;
    const color = colors[i % colors.length];
    const label = (exp.wells[w - 1] || {}).label;
    series.push({ name: label, color, width: state.selectedWell === w ? 3 : 1.5, dash: state.selectedWell === w ? null : [4, 3], points: m.points.map(p => ({ x: p.t, y: p.f })) });
    legendItems.push('<span class="cl-item"><span class="cl-dot" style="background:' + color + '"></span>' + label + '</span>');
  });
  legendEl.innerHTML = legendItems.join('') || '<span class="cl-item" style="color:#5c7399">未选择孔位</span>';
  drawLineChart(canvas, series, { xLabel: 'Temperature (°C)', yLabel: 'Fluorescence', height: 200 });
}

// ---------------- side rendering ----------------
function renderSide(side, exp) {
  const dye = exp.dyes[state.channel] || exp.dyes[0];
  const sideTag = side === 'left' ? '左' : '右';
  if (!exp) return;
  // 1) curves
  renderCurves(side, exp);
  // 2) combined call heat map
  buildPlate(side === 'left' ? E.leftCombined : E.rightCombined, exp,
    (w, d) => combinedColor(combinedOf(exp, w, d)),
    () => {});
  // 3) heat map
  buildPlate(side === 'left' ? E.leftHeat : E.rightHeat, exp,
    (w, d) => metricColor(exp, w, d), () => {});
  buildLegend(side === 'left' ? E.leftLegend : E.rightLegend, state.metric === 'Call' ? 'call' : 'metric');
  (side === 'left' ? E.leftHeatTitle : E.rightHeatTitle).textContent = '· ' + dye;
  // 1b) melting curves
  renderMelt(side, exp);
  // 4) result table
  renderTable(side, exp);
  // header titles
  const titleEl = side === 'left' ? E.leftTitle : E.rightTitle;
  const count = Object.keys(exp.computed || {}).length;
  titleEl.textContent = exp.name + (count ? '（已分析 ' + count + ' 条）' : '');
  if (side === 'right' && !state.right) {
    titleEl.textContent = '未生成 — 点击「生成对照组」';
  }
}

function renderAll() {
  renderChannelSelect();
  if (state.left) renderSide('left', state.left); else E.leftTitle.textContent = '未加载实验';
  if (state.right) renderSide('right', state.right); else E.rightTitle.textContent = '未生成对照组 — 点击「生成对照组」';
}

function renderChannelSelect() {
  const exp = state.left;
  const dyes = exp ? exp.dyes : [];
  E.channelSelect.innerHTML = dyes.map((d, i) => '<option value="' + i + '">通道: ' + d + '</option>').join('');
  if (state.channel >= dyes.length) state.channel = 0;
  E.channelSelect.value = String(state.channel);
}

// ---------------- actions ----------------
async function onUpload(file) {
  setStatus('正在上传并解析 ' + file.name + ' …');
  try {
    const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'upload failed');
    state.left = await getJSON('/api/experiment');
    state.right = null;
    state.selectedWell = null; state.compare = new Set(); state.channel = 0;
    renderAll();
    E.btnAnalyze.disabled = false;
    E.btnSimulate.disabled = false;
    E.btnExport.disabled = false;
    E.simResult.hidden = true;
    setStatus('已加载: ' + file.name + ' — ' + state.left.curves.length + ' 条曲线，点击 Analyze 调用原引擎计算', 'ok');
  } catch (e) { setStatus('上传失败: ' + e.message, 'err'); }
}

async function onAnalyze() {
  if (!state.left) return;
  E.btnAnalyze.disabled = true;
  setStatus('正在调用原版 Roche Kinetic 引擎计算 ' + state.left.curves.length + ' 条曲线（约 10-60 秒）…');
  try {
    const r = await fetch('/api/analyze', { method: 'POST' });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'analyze failed');
    state.left = await getJSON('/api/experiment');
    renderAll();
    E.btnSimulate.disabled = false;
    setStatus('分析完成 ✓ 已写入 ' + Object.keys(state.left.computed).length + ' 条计算结果（与 LC96 原软件一致）', 'ok');
  } catch (e) { setStatus('分析失败: ' + e.message, 'err'); E.btnAnalyze.disabled = false; }
}

async function onSimulate() {
  if (!state.left) { setStatus('请先上传并分析实验数据', 'err'); return; }
  E.btnSimulate.disabled = true;
  E.simStatus = E.simStatus || { textContent: '' };
  setStatus('正在生成对照组并调用原引擎分析两组（约 2-5 秒）…');
  try {
    const r = await fetch('/api/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deltaCt: parseInt(E.simDelta.value, 10) }),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'simulate failed');
    state.right = await getJSON('/api/control/experiment');
    renderAll();
    renderCompare(res.compare);
    E.simResult.hidden = false;
    E.btnDownloadControl.disabled = false;
    E.btnDownloadControl.href = '/api/control';
    E.btnDownloadControl.setAttribute('download', '');
    setStatus('对照组已生成并分析完成：' + res.control.name + ' — 右侧视图已更新', 'ok');
  } catch (e) { setStatus('生成失败: ' + e.message, 'err'); }
  E.btnSimulate.disabled = false;
}

function renderCompare(comp) {
  const fmt = (v, d) => (v === null || v === undefined || isNaN(v)) ? '—' : (Math.round(v * Math.pow(10, d || 2)) / Math.pow(10, d || 2)).toString();
  const pText = comp.pairedT && comp.pairedT.p !== null && comp.pairedT.p !== undefined && !isNaN(comp.pairedT.p)
    ? (comp.pairedT.p < 0.001 ? comp.pairedT.p.toExponential(2) : comp.pairedT.p.toFixed(4)) : '—';
  const cards = [
    ['配对阳性孔 n', String(comp.n || 0)],
    ['实验组 Cq 均值 ± SD', fmt(comp.treat.summary.mean) + ' ± ' + fmt(comp.treat.summary.sd)],
    ['对照组 Cq 均值 ± SD', fmt(comp.ctrl.summary.mean) + ' ± ' + fmt(comp.ctrl.summary.sd)],
    ['ΔCt', fmt(comp.meanDeltaCt, 2)],
    ['配对 t 检验', 'p = ' + pText + ' <span class="' + (comp.significant ? 'sig' : '') + '">' + (comp.pairedT ? comp.pairedT.stars : '') + '</span>'],
    ['Cohen\'s d', fmt(comp.cohensD, 2)],
    ['表达倍数', comp.foldLabel || '—'],
    ['阳性率', '实验 ' + comp.positiveRate.treat + '<br>对照 ' + comp.positiveRate.ctrl],
  ];
  E.compareCards.innerHTML = cards.map(c =>
    '<div class="ccard"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>').join('');
  E.compareVerdict.innerHTML = '<b>结论：</b>' + (comp.verdict || '');
  drawRelExpr(E.relChart, comp);
  drawCqDist(E.cqChart, comp);
  renderDdctTable(comp);
}

// relative expression bar chart (control normalized to 1)
function drawRelExpr(canvas, comp) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 420, cssH = 240;
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pad = { l: 52, r: 14, t: 18, b: 30 };
  const iw = cssW - pad.l - pad.r, ih = cssH - pad.t - pad.b;
  const treatMean = comp.treat.summary.mean, ctrlMean = comp.ctrl.summary.mean;
  const sdT = comp.treat.summary.sd, sdC = comp.ctrl.summary.sd;
  // treatment relative expression vs control (=1): fold = 2^(CtrlCq - TreatCq)
  const delta = ctrlMean - treatMean;
  const fold = Math.pow(2, delta);
  const foldHi = Math.pow(2, delta + (sdT + sdC));
  const foldLo = Math.pow(2, delta - (sdT + sdC));
  const vals = [1, fold];
  let lo = Math.min(0, foldLo, 0), hi = Math.max(1, foldHi, 1) * 1.15;
  if (hi <= lo) hi = lo + 1;
  const sy = v => pad.t + ih - (v - lo) / (hi - lo) * ih;
  // grid
  ctx.strokeStyle = '#26304a'; ctx.fillStyle = '#6c82a6'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const v = lo + (hi - lo) * i / 5, Y = sy(v);
    ctx.beginPath(); ctx.moveTo(pad.l, Y); ctx.lineTo(pad.l + iw, Y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(v.toFixed(v < 0.1 ? 4 : 2), pad.l - 6, Y + 4);
  }
  ctx.fillStyle = '#9db4d8'; ctx.textAlign = 'center'; ctx.font = '11px sans-serif';
  ctx.fillText('相对表达量（对照=1）', pad.l + iw / 2, cssH - 8);
  // bars
  const groups = [
    { label: '实验组', v: 1, color: '#4da3ff', x: pad.l + iw * 0.3 },
    { label: '对照组', v: fold, color: '#ff8d6b', x: pad.l + iw * 0.7 },
  ];
  const barW = 52;
  groups.forEach(g => {
    const hgt = (g.v - lo) / (hi - lo) * ih;
    const Y = pad.t + ih - hgt;
    ctx.fillStyle = g.color;
    ctx.fillRect(g.x - barW / 2, Y, barW, hgt);
    // value label on top
    ctx.fillStyle = '#e6eefb'; ctx.textAlign = 'center'; ctx.font = 'bold 12px sans-serif';
    ctx.fillText(g.v.toFixed(g.v < 0.1 ? 4 : 2), g.x, Y - 6);
    ctx.fillStyle = '#9db4d8'; ctx.font = '11px sans-serif';
    ctx.fillText(g.label, g.x, cssH - 8);
  });
  // error bar on treatment (foldHi/foldLo)
  const eYlo = sy(Math.max(foldLo, lo)), eYhi = sy(Math.min(foldHi, hi));
  ctx.strokeStyle = '#ff8d6b'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(groups[1].x, eYlo); ctx.lineTo(groups[1].x, eYhi); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(groups[1].x - 8, eYlo); ctx.lineTo(groups[1].x + 8, eYlo); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(groups[1].x - 8, eYhi); ctx.lineTo(groups[1].x + 8, eYhi); ctx.stroke();
  // significance stars between bars
  if (comp.significant) {
    ctx.fillStyle = '#ffd166'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    const yStar = pad.t + 2;
    ctx.fillText(comp.pairedT.stars, (groups[0].x + groups[1].x) / 2, yStar);
  }
}

// Cq distribution: jittered scatter + box (Q1/median/Q3, min/max)
function drawCqDist(canvas, comp) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 420, cssH = 240;
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pad = { l: 46, r: 16, t: 16, b: 30 };
  const iw = cssW - pad.l - pad.r, ih = cssH - pad.t - pad.b;
  const groups = [
    { label: '实验组', s: comp.treat.summary, color: '#4da3ff' },
    { label: '对照组', s: comp.ctrl.summary, color: '#ff8d6b' },
  ];
  let lo = Infinity, hi = -Infinity;
  groups.forEach(g => {
    lo = Math.min(lo, g.s.min); hi = Math.max(hi, g.s.max);
  });
  const rng = hi - lo || 1; lo -= rng * 0.08; hi += rng * 0.08;
  const sy = v => pad.t + ih - (v - lo) / (hi - lo) * ih;
  ctx.strokeStyle = '#26304a'; ctx.fillStyle = '#6c82a6'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const v = lo + (hi - lo) * i / 5, Y = sy(v);
    ctx.beginPath(); ctx.moveTo(pad.l, Y); ctx.lineTo(pad.l + iw, Y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(Math.round(v * 10) / 10, pad.l - 6, Y + 4);
  }
  ctx.fillStyle = '#9db4d8'; ctx.textAlign = 'center'; ctx.font = '11px sans-serif';
  ctx.fillText('Cq', pad.l + iw / 2, cssH - 8);
  groups.forEach((g, gi) => {
    const x = pad.l + iw * (0.5 * gi + 0.25);
    const s = g.s;
    // jittered scatter
    s.values.forEach((v, i) => {
      const jx = x + ((i % 7) - 3) * 3;
      ctx.fillStyle = g.color;
      ctx.beginPath(); ctx.arc(jx, sy(v), 3, 0, Math.PI * 2); ctx.fill();
    });
    // box: Q1..Q3, median, min..max whiskers
    const y1 = sy(s.q1), y3 = sy(s.q3), ymed = sy(s.median), ymin = sy(s.min), ymax = sy(s.max);
    const bw = 40;
    ctx.strokeStyle = '#e6eefb'; ctx.lineWidth = 2;
    ctx.strokeRect(x - bw / 2, y1, bw, y3 - y1);
    ctx.beginPath(); ctx.moveTo(x - bw / 2, ymed); ctx.lineTo(x + bw / 2, ymed); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, ymin); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 6, ymin); ctx.lineTo(x + 6, ymin); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y3); ctx.lineTo(x, ymax); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 6, ymax); ctx.lineTo(x + 6, ymax); ctx.stroke();
    // label + median value
    ctx.fillStyle = g.color; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(g.label, x, cssH - 8);
    ctx.fillStyle = '#e6eefb';
    ctx.fillText('中位 ' + Math.round(s.median * 10) / 10, x, pad.t - 2);
  });
}

// ΔΔCt transparency table
function renderDdctTable(comp) {
  const rows = comp.ddCtRows || [];
  const thead = '<tr><th class="l">Well</th><th class="l">实验组 Cq</th><th class="l">对照组 Cq</th><th>ΔCt (处理−对照)</th><th>倍数 2^(对照−处理)</th></tr>';
  const tbody = rows.map(r =>
    '<tr><td class="l">' + r.label + '</td><td>' + r.treatCq + '</td><td>' + r.ctrlCq + '</td><td>' + r.deltaCt + '</td><td>' + r.fold + '</td></tr>').join('');
  E.ddctTable.querySelector('thead').innerHTML = thead;
  E.ddctTable.querySelector('tbody').innerHTML = tbody || '<tr><td colspan="5" class="l">无配对阳性孔</td></tr>';
  E.btnDdctCsv.onclick = () => {
    const csv = ['Well,TreatCq,CtrlCq,DeltaCt,Fold']
      .concat(rows.map(r => [r.label, r.treatCq, r.ctrlCq, r.deltaCt, r.fold].join(',')))
      .join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ddct_table.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

// ---------------- init ----------------
function init() {
  E.fileInput.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) onUpload(f);
    e.target.value = '';
  });
  E.btnAnalyze.addEventListener('click', onAnalyze);
  E.btnSimulate.addEventListener('click', onSimulate);
  E.simDelta.addEventListener('input', () => { E.simDeltaLabel.textContent = E.simDelta.value; });
  E.btnExport.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelector('.dropdown').classList.toggle('open');
  });
  document.addEventListener('click', () => document.querySelector('.dropdown').classList.remove('open'));
  E.exportMenu.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (state.left) window.open('/api/export?format=' + a.dataset.format, '_blank');
  });
  E.metricSelect.addEventListener('change', () => { state.metric = E.metricSelect.value; renderAll(); });
  E.channelSelect.addEventListener('change', () => { state.channel = parseInt(E.channelSelect.value, 10); renderAll(); });

  // restore server-side state
  fetch('/api/status').then(r => r.json()).then(s => {
    if (s.experiment) {
      return getJSON('/api/experiment').then(exp => {
        state.left = exp;
        renderAll();
        E.btnAnalyze.disabled = !!exp.analyzedAt;
        E.btnSimulate.disabled = false;
        E.btnExport.disabled = false;
        setStatus('已恢复实验: ' + exp.name + (exp.analyzedAt ? '（已分析，可生成对照组）' : ' — 点击 Analyze 计算'), 'ok');
      });
    }
    setStatus('未加载实验 — 请上传 .lc96p 文件');
  }).catch(e => setStatus('后端未就绪: ' + e.message, 'err'));
}

document.addEventListener('DOMContentLoaded', init);
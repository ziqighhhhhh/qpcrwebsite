'use strict';
// ---------------------------------------------------------------------------
// Frontend app. Single source of truth: the Experiment JSON from the backend.
// ---------------------------------------------------------------------------
const state = {
  exp: null,
  selectedWell: null,
  channel: 0,
  metric: 'Call',
  compare: new Set(),
  sort: { col: 'Position', asc: true },
};

const $ = id => document.getElementById(id);
const E = {
  fileInput: $('fileInput'), btnAnalyze: $('btnAnalyze'), btnExport: $('btnExport'),
  exportMenu: $('exportMenu'), metricSelect: $('metricSelect'), channelSelect: $('channelSelect'),
  status: $('status'), plate: $('plate'), plateTitle: $('plateTitle'), legend: $('legend'),
  curveCanvas: $('curveCanvas'), chartTitle: $('chartTitle'), chartLegend: $('chartLegend'),
  detailTitle: $('detailTitle'), detailTable: $('detailTable'), resultTable: $('resultTable'),
  tableTitle: $('tableTitle'),
};

// ---------------- api ----------------
async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}
function setStatus(text, cls) {
  E.status.textContent = text;
  E.status.className = 'status ' + (cls || '');
}

// ---------------- data access ----------------
function dyeData(wellId, dye) {
  const exp = state.exp;
  const key = wellId + '|' + dye;
  const c = (exp.computed && exp.computed[key]) || {};
  const sq = (exp.storedQual && exp.storedQual[key]) || null;
  const sk = (exp.storedKinetic && exp.storedKinetic[key]) || null;
  const curve = exp.curves.find(x => x.well === wellId && x.dye === dye) || null;
  return {
    call: c['11 Intermediate Call'] !== undefined ? c['11 Intermediate Call'] : (sq ? (sq.call || '') : ''),
    cq: c['26 CT1'] !== undefined ? c['26 CT1'] : (sq && sq.cq !== undefined ? sq.cq : null),
    slope: c['23 MRS'] !== undefined ? c['23 MRS'] : (sq && sq.slope !== undefined ? sq.slope : (sk ? sk.slope : null)),
    epf: c['78 LC96 Normalized ERI'] !== undefined ? c['78 LC96 Normalized ERI'] : (sq && sq.epf !== undefined ? sq.epf : null),
    params: Object.keys(c).length ? c : null,
    computed: Object.keys(c).length > 0,
    curve,
  };
}

// ---------------- color helpers ----------------
function hsl(h, s, l) { return 'hsl(' + h + ', ' + s + '%, ' + l + '%)'; }
function wellColor(d) {
  const m = state.metric;
  if (!d) return '#3a455e';
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
function fmtNum(v, d) {
  if (v === null || v === undefined || isNaN(v)) return '';
  d = d === undefined ? 4 : d;
  return String(Math.round(v * Math.pow(10, d)) / Math.pow(10, d));
}

// ---------------- render: channel select ----------------
function renderChannelSelect() {
  const dyes = state.exp.dyes || [];
  E.channelSelect.innerHTML = dyes.map((d, i) =>
    '<option value="' + i + '">通道: ' + d + '</option>').join('');
  if (state.channel >= dyes.length) state.channel = 0;
  E.channelSelect.value = String(state.channel);
}

// ---------------- render: plate ----------------
function renderPlate() {
  const exp = state.exp;
  const dye = exp.dyes[state.channel];
  E.plateTitle.textContent = '· ' + dye + (exp.analyzedAt ? ' · 已计算' : ' · 原始数据');
  E.plate.innerHTML = '';
  for (const w of exp.wells) {
    const d = dyeData(w.id, dye);
    const hasCurve = !!d.curve;
    const div = document.createElement('div');
    div.className = 'well' + (hasCurve ? '' : ' empty') + (state.selectedWell === w.id ? ' selected' : '');
    div.style.background = hasCurve ? wellColor(d) : '#1d2537';
    div.innerHTML = '<span class="well-label">' + w.label + '</span>';
    div.title = w.label + (w.sampleName ? ' · ' + w.sampleName : '') + (d.call ? ' · ' + d.call : '');
    div.onclick = () => { state.selectedWell = (state.selectedWell === w.id ? null : w.id); renderPlate(); renderChart(); renderDetail(); };
    E.plate.appendChild(div);
  }
}

function renderLegend() {
  const m = state.metric;
  if (m === 'Call') {
    E.legend.innerHTML =
      '<span><span class="sw" style="background:#37c26b"></span>Positive 阳性</span>' +
      '<span><span class="sw" style="background:#e05252"></span>Negative 阴性</span>' +
      '<span><span class="sw" style="background:#3a455e"></span>无数据</span>';
  } else {
    E.legend.innerHTML =
      '<span>低 <span class="sw" style="background:' + hsl(120, 70, 50) + '"></span></span>' +
      '<span><span class="sw" style="background:' + hsl(60, 70, 50) + '"></span></span>' +
      '<span><span class="sw" style="background:' + hsl(0, 70, 50) + '"></span> 高</span>' +
      '<span style="margin-left:auto">指标: ' + m + '（点击孔位查看详情）</span>';
  }
}

// ---------------- render: chart ----------------
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

function renderChart() {
  const exp = state.exp;
  const dye = exp.dyes[state.channel];
  const wellIds = [];
  if (state.selectedWell) wellIds.push(state.selectedWell);
  state.compare.forEach(w => { if (!wellIds.includes(w)) wellIds.push(w); });

  E.chartTitle.textContent = '· ' + dye + (wellIds.length ? ' · 孔: ' + wellIds.map(w => exp.wells[w - 1].label).join(', ') : ' · 未选择孔位');
  const series = [];
  const legendItems = [];
  wellIds.forEach((w, i) => {
    const d = dyeData(w, dye);
    if (!d.curve || !d.curve.points.length) return;
    const color = ['#4da3ff', '#ff8d6b', '#7fe3a0', '#ffd166', '#c17bff', '#5ad0d0'][i % 6];
    const label = exp.wells[w - 1].label + (exp.wells[w - 1].sampleName ? '·' + exp.wells[w - 1].sampleName : '') + (d.call ? ' [' + d.call + ']' : '');
    series.push({ name: label, color, width: state.selectedWell === w ? 3 : 1.5, dash: state.selectedWell === w ? null : [4, 3], points: d.curve.points.map(p => ({ x: p.c, y: p.f })) });
    legendItems.push('<span class="cl-item"><span class="cl-dot" style="background:' + color + '"></span>' + label + '</span>');
  });
  E.chartLegend.innerHTML = legendItems.join('') || '<span class="cl-item">在下方结果表勾选多个孔可叠加对比</span>';
  drawLineChart(E.curveCanvas, series, { xLabel: 'Cycle 循环数', yLabel: 'Fluorescence 荧光', height: 360 });
}

// ---------------- render: detail ----------------
function renderDetail() {
  const exp = state.exp;
  const dye = exp.dyes[state.channel];
  const w = state.selectedWell ? exp.wells[state.selectedWell - 1] : null;
  if (!w) { E.detailTitle.textContent = '· 未选择孔位'; E.detailTable.querySelector('tbody').innerHTML = ''; return; }
  const d = dyeData(w.id, dye);
  E.detailTitle.textContent = '· ' + w.label + ' · ' + dye + ' · ' + (w.sampleName || '无样本');
  const rows = [];
  rows.push(['Well', w.label], ['Position', String(w.id)], ['Sample', w.sampleName || '—'], ['SampleType', w.sampleType || '—']);
  if (d.params) {
    const order = ['11 Intermediate Call', '12 Qualitative Result', '26 CT1', '27 CT2', '23 MRS', '78 LC96 Normalized ERI', '24 ERI', '21 RFI', '22 F Value', '48 Signal To Noise', '49 Amplification Efficiency', '41 Optimal Model', '42 Validity Value', '43 Relative Validity Value', '45 SEy', '46 SECT1', '47 SECT2', '61 Number Of Outliers', '62 Number Of Iterations', '51 NCE Left', '52 NCE Right', '31 p1', '31 p2', '31 p3', '31 p4', '31 p5', '31 p6', '31 p7', '31 p8', '31 p9', '32 p10', '32 p11'];
    const keys = Object.keys(d.params);
    const sorted = order.concat(keys.filter(k => !order.includes(k))).filter(k => keys.includes(k));
    sorted.forEach(k => rows.push([k, d.params[k] === null || d.params[k] === '' ? '—' : String(d.params[k])]));
  } else {
    const stQ = exp.storedQual[(w.id + '|' + dye)];
    if (stQ) Object.entries(stQ).forEach(([k, v]) => rows.push(['stored ' + k, String(v)]));
    rows.push(['note', '点击 Analyze 调用原引擎计算完整参数']);
  }
  E.detailTable.querySelector('tbody').innerHTML = rows.map(r =>
    '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('');
}

// ---------------- render: result table ----------------
function renderTable() {
  const exp = state.exp;
  E.tableTitle.textContent = '· ' + exp.curves.length + ' 条曲线' + (exp.analyzedAt ? ' · 原引擎计算' : ' · 存储结果');
  const cols = [
    { key: 'checkbox', label: '☐', num: false },
    { key: 'Well', label: 'Well', num: false },
    { key: 'Sample', label: 'Sample', num: false },
    { key: 'Dye', label: 'Dye', num: false },
    { key: 'Call', label: 'Call', num: false },
    { key: 'Cq', label: 'Cq', num: true },
    { key: 'Slope', label: 'Slope', num: true },
    { key: 'EPF', label: 'EPF', num: true },
    { key: 'Combined', label: 'Combined', num: false },
    { key: 'Failure', label: 'Failure', num: false },
    { key: 'Validity', label: 'Validity', num: true },
    { key: 'SNR', label: 'SNR', num: true },
    { key: 'AmpEff', label: 'AmpEff', num: true },
    { key: 'Model', label: 'Model', num: true },
  ];
  const rows = [];
  for (const w of exp.wells) {
    for (const dye of exp.dyes) {
      const d = dyeData(w.id, dye);
      if (!d.curve) continue;
      rows.push({
        key: w.id + '|' + dye, well: w.id, Well: w.label, Sample: w.sampleName || '',
        Dye: dye, Call: d.call,
        Cq: d.cq, Slope: d.slope, EPF: d.epf,
        Combined: d.params ? '' : ((exp.storedQual[w.id + '|' + dye] || {}).combinedResult || ''),
        Failure: ((exp.storedQual[w.id + '|' + dye] || {}).failureType || ''),
        Validity: d.params ? d.params['42 Validity Value'] : null,
        SNR: d.params ? d.params['48 Signal To Noise'] : null,
        AmpEff: d.params ? d.params['49 Amplification Efficiency'] : null,
        Model: d.params ? d.params['41 Optimal Model'] : null,
      });
    }
  }
  const sc = state.sort;
  rows.sort((a, b) => {
    let va = a[sc.col], vb = b[sc.col];
    const na = typeof va === 'number' && !isNaN(va), nb = typeof vb === 'number' && !isNaN(vb);
    if (na && nb) return sc.asc ? va - vb : vb - va;
    const sa = String(va === null || va === undefined ? '' : va), sb = String(vb === null || vb === undefined ? '' : vb);
    return sc.asc ? sa.localeCompare(sb) : sb.localeCompare(sa);
  });

  const thead = '<tr>' + cols.map(c => {
    const arrow = sc.col === c.key ? (sc.asc ? ' ▲' : ' ▼') : '';
    return '<th data-col="' + c.key + '"' + (c.num ? '' : ' class="l"') + '>' + c.label + arrow + '</th>';
  }).join('') + '</tr>';
  const tbody = rows.map(r => {
    const checked = state.compare.has(r.well) ? 'checked' : '';
    const selected = state.selectedWell === r.well ? ' class="selected-row"' : '';
    const callCls = r.Call === 'Positive' ? 'pos' : (r.Call === 'Negative' ? 'pos neg' : '');
    return '<tr' + selected + '>' +
      '<td><input type="checkbox" data-well="' + r.well + '" ' + checked + '></td>' +
      '<td class="l">' + r.Well + '</td>' +
      '<td class="l">' + r.Sample + '</td>' +
      '<td class="l">' + r.Dye + '</td>' +
      '<td class="l ' + callCls + '">' + r.Call + '</td>' +
      '<td>' + fmtNum(r.Cq, 2) + '</td>' +
      '<td>' + fmtNum(r.Slope, 4) + '</td>' +
      '<td>' + fmtNum(r.EPF, 4) + '</td>' +
      '<td class="l">' + r.Combined + '</td>' +
      '<td class="l">' + r.Failure + '</td>' +
      '<td>' + fmtNum(r.Validity, 3) + '</td>' +
      '<td>' + fmtNum(r.SNR, 1) + '</td>' +
      '<td>' + fmtNum(r.AmpEff, 3) + '</td>' +
      '<td>' + (r.Model === null || r.Model === undefined ? '' : r.Model) + '</td>' +
      '</tr>';
  }).join('');
  E.resultTable.querySelector('thead').innerHTML = thead;
  E.resultTable.querySelector('tbody').innerHTML = tbody;

  E.resultTable.querySelectorAll('th[data-col]').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.col;
      if (state.sort.col === col) state.sort.asc = !state.sort.asc;
      else { state.sort.col = col; state.sort.asc = true; }
      renderTable();
    };
  });
  E.resultTable.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      const w = parseInt(cb.dataset.well, 10);
      if (cb.checked) state.compare.add(w); else state.compare.delete(w);
      renderChart();
    };
  });
  E.resultTable.querySelectorAll('tbody tr').forEach((tr, i) => {
    tr.onclick = e => {
      if (e.target.tagName === 'INPUT') return;
      const w = rows[i].well;
      state.selectedWell = (state.selectedWell === w ? null : w);
      renderTable(); renderPlate(); renderChart(); renderDetail();
    };
  });
}

// ---------------- render: status ----------------
function renderStatus(msg) { setStatus(msg, 'ok'); }

// ---------------- actions ----------------
async function onUpload(file) {
  setStatus('正在上传并解析 ' + file.name + ' …');
  try {
    const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'upload failed');
    state.exp = await getJSON('/api/experiment');
    state.selectedWell = null; state.compare = new Set(); state.channel = 0;
    renderAll();
    E.btnAnalyze.disabled = false;
    E.btnExport.disabled = false;
    setStatus('已加载: ' + file.name + ' — ' + state.exp.curves.length + ' 条曲线，点击 Analyze 调用原引擎计算', 'ok');
  } catch (e) {
    setStatus('上传失败: ' + e.message, 'err');
  }
}

async function onAnalyze() {
  E.btnAnalyze.disabled = true;
  setStatus('正在调用原版 Roche Kinetic 引擎计算 ' + state.exp.curves.length + ' 条曲线（约 10-60 秒）…');
  try {
    const r = await fetch('/api/analyze', { method: 'POST' });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'analyze failed');
    state.exp = await getJSON('/api/experiment');
    renderAll();
    setStatus('分析完成 ✓ 已写入 ' + Object.keys(state.exp.computed).length + ' 条计算结果（与 LC96 原软件一致）', 'ok');
  } catch (e) {
    setStatus('分析失败: ' + e.message, 'err');
    E.btnAnalyze.disabled = false;
  }
}

function renderAll() {
  renderChannelSelect();
  renderPlate();
  renderLegend();
  renderChart();
  renderDetail();
  renderTable();
}

// ---------------- init ----------------
function init() {
  E.fileInput.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) onUpload(f);
    e.target.value = '';
  });
  E.btnAnalyze.addEventListener('click', onAnalyze);
  E.btnExport.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelector('.dropdown').classList.toggle('open');
  });
  document.addEventListener('click', () => document.querySelector('.dropdown').classList.remove('open'));
  E.exportMenu.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (state.exp) window.open('/api/export?format=' + a.dataset.format, '_blank');
  });
  E.metricSelect.addEventListener('change', () => { state.metric = E.metricSelect.value; renderPlate(); renderLegend(); });
  E.channelSelect.addEventListener('change', () => { state.channel = parseInt(E.channelSelect.value, 10); renderPlate(); renderLegend(); renderChart(); renderDetail(); });

  // restore server-side state if any
  fetch('/api/status').then(r => r.json()).then(s => {
    if (s.experiment) {
      return getJSON('/api/experiment').then(exp => {
        state.exp = exp;
        renderAll();
        E.btnAnalyze.disabled = !!exp.analyzedAt;
        E.btnExport.disabled = false;
        setStatus('已恢复实验: ' + exp.name + (exp.analyzedAt ? '（已分析）' : ' — 点击 Analyze 计算'), 'ok');
      });
    }
    setStatus('未加载实验 — 请上传 .lc96p 文件（如 DemoData 目录中的演示数据）');
  }).catch(e => setStatus('后端未就绪: ' + e.message, 'err'));
}

document.addEventListener('DOMContentLoaded', init);
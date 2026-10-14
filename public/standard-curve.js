'use strict';
// ---------------------------------------------------------------------------
// Standard-curve page: mark standard wells (or reuse the design's standards),
// fit Cq ~ log10(quantity), quantify unknown samples, export CSV/PNG/SVG.
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const state = {
  exp: null,          // current experiment model (/api/experiment)
  manual: {},         // manual standard wells (/api/standards)
  analysis: null,     // /api/standard-curve result
  selection: [],      // well labels in click order (fill-series order)
};

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}
function fmtQty(q, unit) {
  if (q === null || q === undefined || !isFinite(q)) return '—';
  const s = (q >= 1e4 || (q > 0 && q < 0.01)) ? q.toExponential(2) : (Math.round(q * 1000) / 1000).toString();
  return unit ? s + ' ' + unit : s;
}
function fmtNum(v, d) {
  if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return '—';
  const m = Math.pow(10, d === undefined ? 2 : d);
  return (Math.round(v * m) / m).toString();
}
function wellLabelOf(id) { return String.fromCharCode(64 + Math.ceil(id / 12)) + (((id - 1) % 12) + 1); }

// ---- data loading ----
async function loadAll() {
  try {
    const expRes = await fetch('/api/experiment');
    if (!expRes.ok) {
      state.exp = null;
      setStatus('尚未加载实验 — 请先在「孔板命名」设计模拟实验，或在「数据分析」上传 .lc96p', 'err');
      render();
      return;
    }
    state.exp = await expRes.json();
    const stdRes = await fetch('/api/standards');
    state.manual = stdRes.ok ? (await stdRes.json()).wells || {} : {};
    await loadCurve();
  } catch (e) {
    setStatus('加载失败: ' + e.message, 'err');
  }
}
async function loadCurve() {
  const res = await fetch('/api/standard-curve');
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    state.analysis = null;
    setStatus('标准曲线分析失败: ' + (err.error || res.statusText), 'err');
    render();
    return;
  }
  state.analysis = await res.json();
  const a = state.analysis;
  const n = a.standards.length;
  setStatus('实验：' + a.name + ' · 通道 ' + a.dye + ' · 标准品 ' + n + ' 孔（设计 ' + a.fromDesign + ' / 手动 ' + a.manual + '）' +
    (a.fit && a.fit.ok ? ' · 效率 ' + a.fit.efficiencyPct + '% · R² ' + a.fit.r2 : ' · 尚未拟合'), a.fit && a.fit.ok ? 'ok' : '');
  render();
}
async function saveManual(wells, note) {
  const res = await fetch('/api/standards', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wells }),
  });
  if (!res.ok) { setStatus('保存标准品失败: ' + (await res.text()), 'err'); return; }
  state.manual = wells;
  setStatus(note || ('已保存 ' + Object.keys(wells).length + ' 个标准品孔'), 'ok');
  await loadCurve();
}

// ---- plate ----
function renderPlate() {
  const plate = $('scPlate');
  plate.innerHTML = '';
  const wells = (state.exp && state.exp.wells) || [];
  const stdLabels = new Set((state.analysis && state.analysis.standards || []).map(r => r.label));
  const sel = new Set(state.selection);
  for (let id = 1; id <= 96; id++) {
    const w = wells.find(x => x.id === id) || { id, label: wellLabelOf(id), sampleId: null, sampleName: '' };
    const label = w.label;
    const div = document.createElement('div');
    div.className = 'well';
    div.dataset.label = label;
    const isStd = stdLabels.has(label), isSel = sel.has(label);
    let bg = '#1d2537', fg = '#55607c';
    if (w.sampleId) { bg = '#22304c'; fg = '#9db4d8'; }
    if (isStd) { bg = '#ffd166'; fg = '#1a2336'; }
    if (isSel) { bg = '#8a5cf6'; fg = '#fff'; }
    div.style.background = bg;
    div.style.color = fg;
    if (!w.sampleId && !isStd) div.classList.add('empty');
    if (isSel) div.classList.add('picked');
    const q = state.manual[label] && state.manual[label].quantity;
    const sub = isStd ? (q !== undefined ? fmtQty(q) : 'STD') : (w.sampleName ? w.sampleName.slice(0, 5) : '');
    div.innerHTML = '<span class="well-label">' + (sub || label) + '</span><span class="well-pos">' + label + '</span>';
    div.title = label + (w.sampleName ? ' · ' + w.sampleName : '') + (isStd ? ' · 标准品' : '');
    div.addEventListener('click', () => {
      const i = state.selection.indexOf(label);
      if (i >= 0) state.selection.splice(i, 1); else state.selection.push(label);
      renderPlate();
    });
    plate.appendChild(div);
  }
  $('selCount').textContent = '已选 ' + state.selection.length + ' 孔';
}

// ---- cards / verdict ----
function renderCards() {
  const a = state.analysis, fit = a && a.fit;
  const cards = [];
  if (!a) {
    $('fitCards').innerHTML = '<div class="ccard"><div class="k">状态</div><div class="v">无实验数据</div></div>';
    $('fitVerdict').textContent = '请先在设计页生成模拟实验，或在数据分析页上传 .lc96p。';
    return;
  }
  if (fit && fit.ok) {
    cards.push(['斜率 (slope)', fmtNum(fit.slope, 4)]);
    cards.push(['截距 (intercept)', fmtNum(fit.intercept, 3)]);
    cards.push(['R²', fmtNum(fit.r2, 5)]);
    cards.push(['扩增效率 E', fmtNum(fit.efficiencyPct, 2) + ' %']);
    if (fit.efficiencyPctRange) cards.push(['效率 95% CI', fmtNum(fit.efficiencyPctRange[0], 1) + '–' + fmtNum(fit.efficiencyPctRange[1], 1) + ' %']);
    cards.push(['动态范围', fmtQty(fit.quantityRange[0]) + ' – ' + fmtQty(fit.quantityRange[1])]);
    cards.push(['标准品点 / 孔', fit.n + ' 点 / ' + a.standards.length + ' 孔']);
    if (fit.residualSd !== null) cards.push(['残差 SD', fmtNum(fit.residualSd, 3) + ' 循环']);
  }
  if (a.designed && a.designed.efficiencyPct) {
    cards.push(['设计效率（真值）', fmtNum(a.designed.efficiencyPct, 1) + ' %']);
    if (fit && fit.ok && fit.efficiencyPct !== null) {
      const dev = fit.efficiencyPct - a.designed.efficiencyPct;
      cards.push(['实测 − 设计', (dev >= 0 ? '+' : '') + fmtNum(dev, 2) + ' 个百分点']);
    }
  }
  $('fitCards').innerHTML = cards.map(c =>
    '<div class="ccard"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>').join('');
  const w = a.warnings || [];
  const lines = [];
  if (fit && fit.ok) {
    lines.push('<b>拟合：</b>Cq = ' + fmtNum(fit.intercept, 3) + ' ' + (fit.slope < 0 ? '−' : '+') + ' ' + fmtNum(Math.abs(fit.slope), 4) + ' × log₁₀(浓度)，效率 ' +
      fmtNum(fit.efficiencyPct, 2) + '%' + (fit.efficiencyPctRange ? '（95% CI ' + fmtNum(fit.efficiencyPctRange[0], 1) + '–' + fmtNum(fit.efficiencyPctRange[1], 1) + '%）' : '') +
      '，R² = ' + fmtNum(fit.r2, 5) + '。' +
      (fit.efficiencyPct >= 90 && fit.efficiencyPct <= 110 && fit.r2 >= 0.98
        ? ' 效率与线性度均在常用可接受范围（90–110%、R² ≥ 0.98）。'
        : ' 未同时满足 90–110% 与 R² ≥ 0.98。'));
  }
  lines.push(...w.map(x => '⚠ ' + x));
  $('fitVerdict').innerHTML = lines.join('<br>');
  $('fitSub').textContent = a.dye ? ' · ' + a.dye : '';
  $('stdSource').textContent = a.fromDesign ? ' · 含 ' + a.fromDesign + ' 个设计标准品孔' : '';
}

// ---- tables ----
function renderTable(el, head, rows) {
  const thead = el.querySelector('thead'), tbody = el.querySelector('tbody');
  thead.innerHTML = '<tr>' + head.map((h, i) => '<th' + (i === 0 ? ' class="l"' : '') + '>' + h + '</th>').join('') + '</tr>';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td class="l" colspan="' + head.length + '" style="color:#5c7399">（无数据）</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => '<tr>' + r.map((c, i) => '<td' + (i === 0 ? ' class="l"' : '') + '>' + c + '</td>').join('') + '</tr>').join('');
}
function renderTables() {
  const a = state.analysis;
  const std = (a && a.standards) || [];
  $('stdCount').textContent = std.length ? '· ' + std.length + ' 孔' : '';
  renderTable($('stdTable'),
    ['孔位', '样本', '浓度', 'log₁₀', 'Call', 'Cq', '拟合 Cq', '残差', '来源'],
    std.map(r => [
      r.label, r.sample || '—', fmtQty(r.quantity, r.unit), fmtNum(r.log10, 4),
      '<span class="pos' + (r.call === 'Positive' ? '' : ' neg') + '">' + r.call + '</span>',
      fmtNum(r.cq, 2), fmtNum(r.fittedCq, 2), fmtNum(r.residual, 3),
      r.source === 'design' ? '设计' : '手动',
    ]));

  const unk = (a && a.unknowns) || [];
  const known = unk.filter(r => r.quantity !== null);
  $('unkCount').textContent = known.length ? '· ' + known.length + '/' + unk.length + ' 孔已定量' : '';
  renderTable($('unkTable'),
    ['孔位', '样本', '靶基因', 'Call', 'Cq', '定量浓度'],
    unk.map(r => [
      r.label, r.sample || '—', r.target || '—',
      '<span class="pos' + (r.call === 'Positive' ? '' : ' neg') + '">' + r.call + '</span>',
      fmtNum(r.cq, 2), r.quantity === null ? '—' : fmtQty(r.quantity),
    ]));

  renderTable($('sumTable'),
    ['样本', '靶基因', 'n', '平均 Cq', 'Cq SD', '平均浓度'],
    ((a && a.samples) || []).map(s => [
      s.sample || '—', s.target || '—', s.n, fmtNum(s.meanCq, 2),
      s.sdCq === null ? '—' : fmtNum(s.sdCq, 3), s.meanQuantity === null ? '—' : fmtQty(s.meanQuantity),
    ]));
}

// ---- charts ----
function renderCharts() {
  const a = state.analysis, fit = a && a.fit;
  const canvas = $('stdCurveChart');
  if (!a || !fit || !fit.ok) {
    drawLineChart(canvas, [], { height: 360, xLabel: 'log₁₀(浓度)', yLabel: 'Cq', emptyText: '无标准品数据 — 在左侧板面标记标准品孔' });
    drawLineChart($('stdResidualChart'), [], { height: 200, xLabel: 'log₁₀(浓度)', yLabel: '残差 (Cq)', emptyText: '无残差数据' });
    return;
  }
  const pts = a.standards.filter(r => r.cq !== null);
  const xs = fit.log10Range;
  const series = [{
    name: '标准品实测 Cq', color: '#4da3ff', pointsOnly: true, pointRadius: 4,
    points: pts.map(r => ({ x: r.log10, y: r.cq })),
  }, {
    name: '拟合直线 (R² = ' + fmtNum(fit.r2, 5) + ')', color: '#ffd166', dash: [6, 4],
    points: [
      { x: xs[0], y: fit.intercept + fit.slope * xs[0] },
      { x: xs[1], y: fit.intercept + fit.slope * xs[1] },
    ],
  }];
  drawLineChart(canvas, series, {
    height: 360, xLabel: 'log₁₀(标准品浓度)', yLabel: 'Cq',
    emptyText: '无标准品数据',
  });
  $('curveTitle').innerHTML = '标准曲线 Cq ~ log₁₀(浓度)<span class="col-sub"> · 效率 ' + fmtNum(fit.efficiencyPct, 2) + '%</span>';

  const res = pts.filter(r => r.residual !== undefined);
  drawLineChart($('stdResidualChart'), [{
    name: '残差', color: '#7fe3a0', pointsOnly: true, pointRadius: 3.5,
    points: res.map(r => ({ x: r.log10, y: r.residual })),
  }, {
    name: '零线', color: '#5c7399', dash: [4, 4],
    points: [{ x: xs[0], y: 0 }, { x: xs[1], y: 0 }],
  }], { height: 200, xLabel: 'log₁₀(标准品浓度)', yLabel: '残差 (Cq)' });
}

function render() {
  renderPlate();
  renderCards();
  renderTables();
  renderCharts();
}

// ---- actions ----
$('btnFillSeries').addEventListener('click', async () => {
  if (!state.selection.length) { setStatus('请先在孔板上按稀释顺序点选标准品孔', 'err'); return; }
  const start = parseFloat($('startQty').value), dilution = parseFloat($('dilution').value);
  const unit = $('unit').value.trim() || 'copies';
  if (!(start > 0) || !(dilution > 1)) { setStatus('起始浓度需 > 0 且稀释倍数需 > 1', 'err'); return; }
  const wells = Object.assign({}, state.manual);
  state.selection.forEach((label, i) => {
    wells[label] = { quantity: start / Math.pow(dilution, i), unit };
  });
  await saveManual(wells, '已按 ' + dilution + '× 系列稀释填充 ' + state.selection.length + ' 孔（起始 ' + fmtQty(start) + '）');
  state.selection = [];
  renderPlate();
});
$('btnClearWells').addEventListener('click', async () => {
  await saveManual({}, '已清空手动标准品（设计自带的标准品仍然有效）');
  state.selection = [];
  renderPlate();
});
if ($('btnReload')) $('btnReload').addEventListener('click', loadAll);

loadAll();

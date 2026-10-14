'use strict';
const assert = require('assert');
const { lineChartSvg, svgFromOps, canvasSvg, createRecorder, wrapContext } = require('../public/chart-export');
const svg = lineChartSvg([{name:'A<&"', points:[{x:1,y:2},{x:2,y:4}], markers:[{x:1,y:2}]}], {markers:true,xLabel:'Cycle',yLabel:'Fluorescence'});
assert(svg.startsWith('<svg'));
assert(svg.includes('A&lt;&amp;&quot;'));
assert(svg.includes('<polyline'));
assert(svg.includes('<circle'));
assert(!svg.includes('<image'));
assert(!svg.includes('NaN'));
assert.throws(() => lineChartSvg([], {}), /数据/);
assert(!lineChartSvg([{points:[{x:1,y:2},{x:NaN,y:4}]}],{}).includes('NaN'));

// scatter (pointsOnly) series must export circles, never a connecting polyline
const scatter = lineChartSvg([
  {name:'标准品', color:'#4da3ff', pointsOnly:true, pointRadius:4, points:[{x:4,y:26},{x:5,y:23},{x:6,y:20}]},
  {name:'拟合', color:'#ffd166', dash:[6,4], points:[{x:4,y:26.6},{x:6,y:19.9}]},
], {markers:true});
assert.equal((scatter.match(/<circle/g) || []).length, 3, '3 scatter circles');
assert.equal((scatter.match(/<polyline/g) || []).length, 1, 'only the fit line is a polyline');
assert(scatter.includes('stroke-dasharray="6 4"'));
assert(scatter.includes('r="4"'));

// ---- recorder: every draw call becomes vector SVG (bars, boxes, scatter) ----
// A fake 2D context: methods are no-ops, style properties are plain values.
const METHOD_NAMES = ['clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'arc', 'rect', 'fill', 'stroke', 'fillText', 'setLineDash', 'save', 'restore', 'translate', 'rotate', 'setTransform'];
function fakeCanvas() {
  const target = {};
  for (const m of METHOD_NAMES) target[m] = () => {};
  const canvas = {};
  const ctx = wrapContext(canvas, target, createRecorder());
  return { canvas, ctx, target };
}
// Reproduce the drawing pattern of the statistical bar charts (dpr-scaled).
function drawBarChart() {
  const { canvas, ctx } = fakeCanvas();
  ctx.setTransform(2, 0, 0, 2, 0, 0);          // devicePixelRatio = 2
  ctx.clearRect(0, 0, 420, 240);               // frame → SVG is 420x240 CSS px
  ctx.strokeStyle = '#26304a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(46, 200); ctx.lineTo(404, 200); ctx.stroke();     // axis
  ctx.fillStyle = '#4da3ff';
  ctx.fillRect(100, 120, 30, 80);              // bar
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.beginPath(); ctx.arc(115, 90, 3, 0, Math.PI * 2); ctx.fill();            // scatter point
  ctx.strokeStyle = '#e6eefb'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(115, 110); ctx.lineTo(115, 130); ctx.stroke();    // error bar
  ctx.fillStyle = '#e6eefb'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('ΔCt 1.61', 115, 112);
  ctx.save(); ctx.translate(14, 100); ctx.rotate(-Math.PI / 2); ctx.fillText('Y 轴', 0, 0); ctx.restore();
  return canvas;
}

const recorded = drawBarChart();
const recordedSvg = canvasSvg(recorded);
assert(recordedSvg.startsWith('<svg') && recordedSvg.endsWith('</svg>'));
assert(recordedSvg.includes('width="420" height="240"'), 'CSS size, not device pixels');
assert(!recordedSvg.includes('<image'), 'never embeds a bitmap');
// dpr scale must be normalised away: bar is 100,120 30x80 in CSS px
assert(recordedSvg.includes('<rect x="100" y="120" width="30" height="80" fill="#4da3ff"'), 'bar rect in CSS px: ' + recordedSvg.slice(0, 400));
assert(recordedSvg.includes('<circle cx="115" cy="90" r="3"'), 'scatter circle');
assert(recordedSvg.includes('M46.00 200.00 L404.00 200.00'), 'axis path');
assert(recordedSvg.includes('M115.00 110.00 L115.00 130.00'), 'error bar path');
assert(recordedSvg.includes('>ΔCt 1.61</text>') && recordedSvg.includes('text-anchor="middle"') && recordedSvg.includes('font-weight="bold"'));
assert(recordedSvg.includes('font-size="12"'));
// rotated axis label keeps its rotation but sits at the translated CSS position
assert(/<text x="14" y="100" transform="matrix\(0 -1 1 0 0 0\)"/.test(recordedSvg), 'rotated label: ' + recordedSvg.slice(-400));
assert(recordedSvg.includes('>Y 轴</text>'));

// line dash and re-draw reset
const dashed = fakeCanvas();
dashed.ctx.setTransform(1, 0, 0, 1, 0, 0);
dashed.ctx.clearRect(0, 0, 100, 50);
dashed.ctx.setLineDash([6, 4]);
dashed.ctx.beginPath(); dashed.ctx.moveTo(0, 0); dashed.ctx.lineTo(50, 25); dashed.ctx.stroke();
const dashedSvg = svgFromOps(dashed.canvas.__recorder.ops);
assert(dashedSvg.includes('stroke-dasharray="6 4"'));
// a second frame replaces the first (clearRect resets the op list)
dashed.ctx.clearRect(0, 0, 100, 50);
dashed.ctx.fillStyle = '#fff'; dashed.ctx.fillRect(1, 2, 3, 4);
const second = svgFromOps(dashed.canvas.__recorder.ops);
assert(!second.includes('stroke-dasharray'), 'previous frame dropped');
assert(second.includes('width="3" height="4"'));
// text is escaped, empty recordings produce null
assert(svgFromOps([]) === null && svgFromOps(null) === null);
const esc = fakeCanvas();
esc.ctx.setTransform(1, 0, 0, 1, 0, 0); esc.ctx.clearRect(0, 0, 10, 10);
esc.ctx.fillText('<a & "b">', 1, 2);
assert(svgFromOps(esc.canvas.__recorder.ops).includes('&lt;a &amp; &quot;b&quot;&gt;'));

console.log('chart export checks passed');

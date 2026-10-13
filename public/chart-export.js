'use strict';
function lineChartSvg(series, opts = {}) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const colors = ['#4da3ff','#ff8d6b','#7fe3a0','#ffd166','#c17bff','#5ad0d0','#ff7aa2','#9aa7ff'];
  const points = series.flatMap(s => s.points || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) throw new Error('没有可导出的曲线数据');
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs) === xmin ? xmin + 1 : Math.max(...xs);
  const min = Math.min(...ys), max = Math.max(...ys), gap = max === min ? 1 : (max - min) * 0.05;
  const ymin = min - gap, ymax = max + gap;
  const sx = x => 70 + (x - xmin) / (xmax - xmin) * 700;
  const sy = y => 330 - (y - ymin) / (ymax - ymin) * 300;
  const height = 390 + series.length * 18;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}"><rect width="100%" height="100%" fill="#111827"/><g font-family="sans-serif" font-size="12" fill="#dbeafe">`];
  for (let i = 0; i <= 6; i++) {
    const x = xmin + (xmax - xmin) * i / 6, y = ymin + (ymax - ymin) * i / 6;
    parts.push(`<path d="M ${sx(x)} 30 V 330 M 70 ${sy(y)} H 770" stroke="#334155"/><text x="${sx(x)}" y="350" text-anchor="middle">${x.toPrecision(4)}</text><text x="64" y="${sy(y)+4}" text-anchor="end">${y.toPrecision(4)}</text>`);
  }
  parts.push(`<text x="420" y="373" text-anchor="middle">${escape(opts.xLabel || 'Cycle')}</text><text transform="translate(15 180) rotate(-90)" text-anchor="middle">${escape(opts.yLabel || 'Fluorescence')}</text>`);
  series.forEach((s, i) => {
    const color = escape(s.color || colors[i % colors.length]);
    const coords = (s.points || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).map(p => `${sx(p.x)},${sy(p.y)}`).join(' ');
    parts.push(`<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${escape(s.dash.join(' '))}"` : ''}/>`);
    if (opts.markers) (s.markers || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).forEach(p => parts.push(`<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="${color}"/>`));
    parts.push(`<text x="70" y="${395+i*18}" fill="${color}">${escape(s.name || `Series ${i+1}`)}</text>`);
  });
  return parts.join('') + '</g></svg>';
}
if (typeof module !== 'undefined') module.exports = { lineChartSvg };
if (typeof document !== 'undefined') {
  function saveChart(blob, name) {
    if (!blob) throw new Error('图像生成失败');
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.querySelectorAll('canvas').forEach(canvas => {
    const bar = document.createElement('div');
    bar.className = 'chart-downloads';
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    ['PNG', 'SVG'].forEach(format => {
      // ponytail: existing statistical canvases export PNG; SVG uses line-series data, never a bitmap wrapper.
      if (format === 'SVG' && !['leftCurve','rightCurve','leftMelt','rightMelt'].includes(canvas.id) && !canvas.hasAttribute('data-line-chart')) return;
      const button = document.createElement('button'); button.className = 'btn'; button.textContent = `导出 ${format}`;
      button.addEventListener('click', () => {
        status.textContent = '';
        try {
          if (format === 'SVG') {
            if (!canvas.chartExport) throw new Error('请先加载曲线');
            saveChart(new Blob([lineChartSvg(canvas.chartExport.series, canvas.chartExport.opts)], {type:'image/svg+xml;charset=utf-8'}), `${canvas.id}.svg`);
          } else {
            const output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height;
            const ctx = output.getContext('2d'); ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, output.width, output.height); ctx.drawImage(canvas, 0, 0);
            output.toBlob(blob => { try { saveChart(blob, `${canvas.id}.png`); } catch (error) { status.textContent = error.message; } });
          }
        } catch (error) { status.textContent = error.message; }
      });
      bar.appendChild(button);
    });
    bar.appendChild(status); canvas.after(bar);
  });
}


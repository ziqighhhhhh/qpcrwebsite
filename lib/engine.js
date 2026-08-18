'use strict';
// ---------------------------------------------------------------------------
// Engine client: spawns the x86 bridge (which wraps the original Roche Kinetic
// engine) with a JSON job on stdin, parses the JSON result on stdout.
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let cfg = null;
function configure(c) { cfg = c; }

// The bridge must live inside binDir so the x86 CLR can resolve the Roche DLLs.
function ensureBridge() {
  const src = path.join(cfg.projectDir, 'bridge', 'engine-bridge.exe');
  const dest = path.join(cfg.binDir, 'engine-bridge.exe');
  if (!fs.existsSync(src)) throw new Error('bridge exe missing: ' + src + ' (run bridge\\build.bat)');
  if (!fs.existsSync(dest) || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs) {
    fs.copyFileSync(src, dest);
  }
  return dest;
}

function runEngine(inputs, opts = {}) {
  const adf = opts.adf || cfg.adf || 'Gen-KA.adf';
  const timeoutMs = opts.timeoutMs || 180000;
  return new Promise((resolve, reject) => {
    let exe;
    try { exe = ensureBridge(); }
    catch (e) { reject(e); return; }
    const adfPath = path.join(cfg.binDir, adf);
    const child = spawn(exe, [cfg.binDir, adfPath], {
      cwd: cfg.binDir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* noop */ }
      reject(new Error('engine timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const text = out.replace(/^\uFEFF/, '');
      try {
        const res = JSON.parse(text);
        if (!res.ok) reject(new Error(res.error || 'engine error (exit ' + code + ')'));
        else resolve(res);
      } catch (e) {
        reject(new Error('engine output parse failed (exit ' + code + '): ' + (err || text.slice(0, 300))));
      }
    });
    child.stdin.write(JSON.stringify({ inputs }));
    child.stdin.end();
  });
}

// Run the engine over every curve of the experiment and merge results into
// exp.computed[well + '|' + dye] (single source of truth lives in the model).
async function analyzeExperiment(exp) {
  const inputs = exp.curves.map(c => ({
    positionId: String(c.well),
    channelId: exp.channelOf[c.dye],
    points: c.points.map(p => [p.c, p.f]),
  }));
  const adf = (exp.analysis && exp.analysis.adf) || cfg.adf;
  const res = await runEngine(inputs, { adf });
  const computed = {};
  for (const r of res.results) {
    const well = String(r.position);
    const dye = exp.dyes[r.channel];
    if (dye) computed[well + '|' + dye] = r.params;
  }
  exp.computed = computed;
  exp.analyzedAt = new Date().toISOString();
  return exp;
}

module.exports = { configure, runEngine, analyzeExperiment };
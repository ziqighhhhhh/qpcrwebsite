'use strict';
// ============================================================================
// qPCR Web — zero-dependency Node server.
// Single source of truth: the Experiment model (one JSON object in memory,
// persisted to data/<id>.json). Everything (views, exports) derives from it.
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectDir = __dirname;
const configPath = path.join(projectDir, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
const dataDir = path.join(projectDir, config.dataDir || 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const { parseLc96p } = require('./lib/lc96p.js');
const { toCSV, toJSON, toXLSX } = require('./lib/export.js');
const { readZip } = require('./lib/zip.js');
const sim = require('./lib/simulate.js');
const { compareGroups } = require('./lib/compare.js');
const engine = require('./lib/engine.js');
engine.configure({ binDir: config.binDir, projectDir, adf: config.adf || 'Gen-KA.adf' });

const experimentsDir = config.experimentsDir || path.join(path.dirname(config.binDir), 'experiments');
const controlsDir = path.join(dataDir, 'controls');
if (!fs.existsSync(controlsDir)) fs.mkdirSync(controlsDir, { recursive: true });

// ---- single source of truth ----
let experiment = null;
let expFile = null;
let controlExperiment = null;   // simulated control group (if generated)
let controlFile = null;

function saveExperiment() {
  if (!experiment) return;
  expFile = path.join(dataDir, experiment.id + '.json');
  fs.writeFileSync(expFile, JSON.stringify(experiment, null, 2), 'utf8');
}
function loadExperiment(id) {
  const f = path.join(dataDir, id + '.json');
  if (!fs.existsSync(f)) return null;
  experiment = JSON.parse(fs.readFileSync(f, 'utf8'));
  expFile = f;
  return experiment;
}

function summary() {
  if (!experiment) return null;
  const computedCount = Object.keys(experiment.computed || {}).length;
  return {
    id: experiment.id,
    name: experiment.name,
    dyes: experiment.dyes,
    curves: experiment.curves.length,
    wells: experiment.wells.length,
    storedKinetic: Object.keys(experiment.storedKinetic || {}).length,
    storedQual: Object.keys(experiment.storedQual || {}).length,
    computed: computedCount,
    analyzedAt: experiment.analyzedAt,
    hasStored: Object.keys(experiment.storedKinetic || {}).length > 0,
    internalControlDye: experiment.settings.internalControlDye,
  };
}

// ---- tiny helpers ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(text);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- static files ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // prevent path traversal
  const full = path.normalize(path.join(projectDir, 'public', rel));
  if (!full.startsWith(path.join(projectDir, 'public'))) { sendText(res, 403, 'forbidden'); return; }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) { sendText(res, 404, 'not found'); return; }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

// ---- server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p.startsWith('/static/'))) {
      const rel = p === '/' ? '/' : p.slice('/static/'.length - 1); // '/x' -> '/x'
      serveStatic(res, rel);
      return;
    }
    if (req.method === 'GET' && p === '/api/status') {
      const bridgeOk = fs.existsSync(path.join(config.binDir, 'engine-bridge.exe'));
      sendJson(res, 200, {
        ok: true,
        engine: {
          binDir: config.binDir,
          adf: config.adf,
          bridgePresent: bridgeOk,
          original: 'Roche Kinetic 1.5.3.1244 (CalculationPackageService)',
        },
        experiment: summary(),
      });
      return;
    }
    if (req.method === 'GET' && p === '/api/experiment') {
      if (!experiment) { sendJson(res, 404, { error: 'no experiment loaded' }); return; }
      sendJson(res, 200, experiment);
      return;
    }
    if (req.method === 'GET' && p === '/api/export') {
      if (!experiment) { sendJson(res, 404, { error: 'no experiment loaded' }); return; }
      const format = url.searchParams.get('format') || 'csv';
      const base = experiment.id;
      if (format === 'json') {
        const buf = toJSON(experiment);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + base + '.json"',
        });
        res.end(buf);
      } else if (format === 'xlsx') {
        const buf = toXLSX(experiment);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="' + base + '.xlsx"',
        });
        res.end(buf);
      } else {
        const buf = toCSV(experiment);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + base + '.csv"',
        });
        res.end(buf);
      }
      return;
    }
    if (req.method === 'GET' && p === '/api/experiments') {
      let files = [];
      try {
        files = fs.readdirSync(experimentsDir)
          .filter(f => /\.lc96p$/i.test(f))
          .map(f => {
            const st = fs.statSync(path.join(experimentsDir, f));
            return { name: f, size: st.size, date: st.mtime.toISOString() };
          });
      } catch (e) { /* dir missing */ }
      sendJson(res, 200, { ok: true, dir: experimentsDir, files });
      return;
    }
    if (req.method === 'POST' && p === '/api/simulate') {
      try {
        const body = await readBody(req, 1 * 1024 * 1024);
        const opts = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
        const sourceName = opts.source;
        if (!sourceName || /\.\./.test(sourceName)) { sendJson(res, 400, { error: 'invalid source' }); return; }
        const srcPath = path.join(experimentsDir, sourceName);
        if (!fs.existsSync(srcPath)) { sendJson(res, 404, { error: 'source not found' }); return; }
        const deltaCt = Math.min(15, Math.max(1, parseInt(opts.deltaCt, 10) || 8));
        const buf = fs.readFileSync(srcPath);
        const treat = parseLc96p(buf, sourceName);
        if (!Object.keys(treat.computed || {}).length) {
          await engine.analyzeExperiment(treat); // ensure treatment group is analyzed
        }
        const ctrl = sim.buildControl(treat, { deltaCt });
        await engine.analyzeExperiment(ctrl);    // run the real engine on the control group
        controlExperiment = ctrl;
        const ctrlBytes = sim.toLc96p(ctrl, readZip(buf));
        controlFile = path.join(controlsDir, ctrl.name.replace(/[^\w.\-]/g, '_'));
        fs.writeFileSync(controlFile, ctrlBytes);
        const comp = compareGroups(treat, ctrl, ctrl.wells.length);
        sendJson(res, 200, {
          ok: true,
          treatment: { id: treat.id, name: treat.name, analyzedAt: treat.analyzedAt },
          control: { id: ctrl.id, name: ctrl.name, analyzedAt: ctrl.analyzedAt, file: controlFile },
          compare: comp,
        });
      } catch (e) {
        sendJson(res, 500, { error: 'simulate failed: ' + e.message });
      }
      return;
    }
    if (req.method === 'GET' && p === '/api/compare') {
      if (!experiment || !controlExperiment) { sendJson(res, 404, { error: 'need experiment + control (run /api/simulate first)' }); return; }
      const comp = compareGroups(experiment, controlExperiment, experiment.wells.length);
      sendJson(res, 200, { ok: true, treatment: experiment.name, control: controlExperiment.name, compare: comp });
      return;
    }
    if (req.method === 'POST' && p === '/api/load-control') {
      if (!controlExperiment) { sendJson(res, 404, { error: 'no control experiment (run /api/simulate first)' }); return; }
      experiment = controlExperiment;
      saveExperiment();
      sendJson(res, 200, { ok: true, experiment: summary() });
      return;
    }
    if (req.method === 'GET' && p === '/api/control') {
      if (!controlFile || !fs.existsSync(controlFile)) { sendJson(res, 404, { error: 'no control file' }); return; }
      const name = path.basename(controlFile);
      const data = fs.readFileSync(controlFile);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="' + name + '"',
      });
      res.end(data);
      return;
    }
    if (req.method === 'POST' && p === '/api/upload') {
      const body = await readBody(req, 200 * 1024 * 1024);
      if (!body.length) { sendJson(res, 400, { error: 'empty upload' }); return; }
      const name = url.searchParams.get('name') || 'upload.lc96p';
      try {
        experiment = parseLc96p(body, name);
        saveExperiment();
        sendJson(res, 200, { ok: true, experiment: summary() });
      } catch (e) {
        sendJson(res, 400, { error: 'parse failed: ' + e.message });
      }
      return;
    }
    if (req.method === 'POST' && p === '/api/analyze') {
      if (!experiment) { sendJson(res, 404, { error: 'no experiment loaded' }); return; }
      if (Object.keys(experiment.computed || {}).length) {
        sendJson(res, 200, { ok: true, cached: true, experiment: summary() });
        return;
      }
      try {
        await engine.analyzeExperiment(experiment);
        saveExperiment();
        sendJson(res, 200, { ok: true, cached: false, experiment: summary() });
      } catch (e) {
        sendJson(res, 500, { error: 'analysis failed: ' + e.message });
      }
      return;
    }
    sendText(res, 404, 'not found');
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// ensure bridge exe exists (build if missing)
function ensureBridgeBinary() {
  const dest = path.join(config.binDir, 'engine-bridge.exe');
  const src = path.join(projectDir, 'bridge', 'engine-bridge.exe');
  if (fs.existsSync(src)) {
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    return;
  }
  const bat = path.join(projectDir, 'bridge', 'build.bat');
  if (fs.existsSync(bat)) {
    try { execFileSync('cmd.exe', ['/c', bat], { cwd: projectDir, stdio: 'inherit' }); }
    catch (e) { console.log('[warn] bridge build failed: ' + e.message); }
  }
  if (!fs.existsSync(dest)) console.log('[warn] engine-bridge.exe missing in ' + config.binDir);
}

// restore last persisted experiment (best effort)
function restoreLast() {
  try {
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
    if (files.length) loadExperiment(path.basename(files[files.length - 1], '.json'));
  } catch (e) { /* noop */ }
}

ensureBridgeBinary();
restoreLast();
const port = config.port || 8080;
server.listen(port, () => {
  console.log('qPCR Web running at http://localhost:' + port);
  console.log('  engine binDir : ' + config.binDir);
  console.log('  adf           : ' + (config.adf || 'Gen-KA.adf'));
  console.log('  experiment    : ' + (experiment ? experiment.name : '(none — upload a .lc96p)'));
});
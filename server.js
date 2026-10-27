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
const syn = require('./lib/synthesize.js');
const design = require('./lib/design.js');
const standardcurve = require('./lib/standardcurve.js');
const { compareGroups } = require('./lib/compare.js');
const cleaning = require('./lib/cleaning.js');
const engine = require('./lib/engine.js');
engine.configure({ binDir: config.binDir, projectDir, adf: config.adf || 'Gen-KA.adf' });

const experimentsDir = config.experimentsDir || path.join(path.dirname(config.binDir), 'experiments');
const controlsDir = path.join(dataDir, 'controls');
if (!fs.existsSync(controlsDir)) fs.mkdirSync(controlsDir, { recursive: true });
const layoutFile = path.join(dataDir, 'layout.json');   // 96-well plate naming layout (entry page)
const standardsFile = path.join(dataDir, 'standards.json'); // manual standard-curve wells (real experiments)

// layout wells ({A1:{target,simple}}) — overlaid onto views/exports
function readLayoutWells() {
  try {
    if (!fs.existsSync(layoutFile)) return {};
    const lay = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
    return (lay && lay.wells && typeof lay.wells === 'object') ? lay.wells : {};
  } catch (e) { return {}; }
}
// manual standard wells ({A1:{quantity,unit}})
function readStandards() {
  try {
    if (!fs.existsSync(standardsFile)) return { wells: {}, updatedAt: null };
    const s = JSON.parse(fs.readFileSync(standardsFile, 'utf8'));
    return { wells: (s && s.wells) || {}, updatedAt: s ? s.updatedAt || null : null };
  } catch (e) { return { wells: {}, updatedAt: null }; }
}

// ---- single source of truth ----
let experiment = null;
let expFile = null;
let controlExperiment = null;   // simulated control group (if generated)
let controlFile = null;
let sourceZipCache = null;      // raw bytes of the current treatment .lc96p (for building control file)

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
  // no-store: this is a local tool that changes often; never serve stale JS/CSS
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(full).pipe(res);
}

// ---- server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'GET' && p === '/static/statistics.js') {
    sendText(res, 200, fs.readFileSync(path.join(projectDir, 'lib', 'stats.js'), 'utf8'), 'application/javascript; charset=utf-8');
    return;
  }
  if (req.method === 'GET' && p === '/static/cleaning.js') {
    sendText(res, 200, fs.readFileSync(path.join(projectDir, 'lib', 'cleaning.js'), 'utf8'), 'application/javascript; charset=utf-8');
    return;
  }
  try {
    if (req.method === 'GET' && (p === '/' || p.startsWith('/static/') || /^\/[A-Za-z0-9_.\-]+\.html$/.test(p))) {
      // '/static/x' -> '/x'（serveStatic 再剥掉前导斜杠）；顶层页面（如 /analysis.html）原样传递
      const rel = p === '/' ? '/' : (p.startsWith('/static/') ? p.slice('/static/'.length - 1) : p);
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
    // ---- 96-well plate naming layout (entry page persistence) ----
    if (req.method === 'GET' && p === '/api/layout') {
      let layout = { wells: {}, updatedAt: null };
      try {
        if (fs.existsSync(layoutFile)) layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
      } catch (e) { /* corrupt/absent layout -> empty */ }
      sendJson(res, 200, Object.assign({ ok: true }, layout));
      return;
    }
    if (req.method === 'POST' && p === '/api/layout') {
      try {
        const body = await readBody(req, 256 * 1024);
        const opts = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
        const wells = {};
        if (opts.wells && typeof opts.wells === 'object') {
          for (const k of Object.keys(opts.wells)) {
            if (!/^[A-H]([1-9]|1[0-2])$/.test(k)) continue;   // only A1..H12
            const v = opts.wells[k] || {};
            wells[k] = {
              target: String(v.target || '').slice(0, 80),
              simple: String(v.simple || '').slice(0, 80),
            };
          }
        }
        // simulation biology mode (whitelist), passed to layout-driven synthesis
        const BIO_MODES = ['ideal', 'ic-drift', 'ntc-dimer', 'weak', 'high-cv'];
        const bioMode = BIO_MODES.indexOf(opts.bioMode) >= 0 ? opts.bioMode : 'ideal';
        // experiment design (qPCR 核心条件面板) — normalized & validated server-side
        let designObj = null;
        if (opts.design && typeof opts.design === 'object') {
          try {
            designObj = design.normalizeDesign(opts.design);
          } catch (e) { /* fall back to null */ }
        }
        const layout = { wells, bioMode, design: designObj, updatedAt: new Date().toISOString() };
        fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 2), 'utf8');
        sendJson(res, 200, { ok: true, count: Object.keys(wells).length, bioMode, design: designObj, updatedAt: layout.updatedAt });
      } catch (e) {
        sendJson(res, 400, { error: 'layout failed: ' + e.message });
      }
      return;
    }
    // ---- derive theoretical values from an experiment design (live preview on the naming page) ----
    if (req.method === 'POST' && p === '/api/derive') {
      try {
        const body = await readBody(req, 128 * 1024);
        const opts = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
        const derived = design.deriveDesign(opts.design || {});
        sendJson(res, 200, {
          ok: true,
          design: derived.design,
          quality: derived.quality,
          efficiencyPct: derived.efficiencyPct,
          deltaCq: derived.deltaCq,
          treatCq: derived.treatCq,
          theoryDct: derived.theoryDct,
          genes: derived.genes,
          theoreticalExpression: derived.theoreticalExpression,
          templateCopies: derived.templateCopies,
          totalWells: derived.totalWells,
          standards: derived.standards,
          standardWells: derived.standardWells,
          warnings: derived.warnings,
          issues: derived.issues,
          layout: design.buildLayout(opts.design || {}),
        });
      } catch (e) {
        sendJson(res, 400, { error: 'derive failed: ' + e.message });
      }
      return;
    }
    // ---- 标准曲线：手动标记的标准品孔（真实数据用）----
    if (req.method === 'GET' && p === '/api/standards') {
      const s = readStandards();
      sendJson(res, 200, { ok: true, wells: s.wells, updatedAt: s.updatedAt });
      return;
    }
    if (req.method === 'POST' && p === '/api/standards') {
      try {
        const body = await readBody(req, 256 * 1024);
        const opts = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
        const wells = {};
        if (opts.wells && typeof opts.wells === 'object') {
          for (const k of Object.keys(opts.wells)) {
            if (!/^[A-H]([1-9]|1[0-2])$/.test(k)) continue;
            const v = opts.wells[k] || {};
            const quantity = parseFloat(v.quantity);
            // 无效/空浓度 = 清除该孔（保证面板删掉一个孔能真正生效）
            if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e15) continue;
            wells[k] = { quantity, unit: String(v.unit || 'copies').slice(0, 24) };
          }
        }
        const payload = { wells, updatedAt: new Date().toISOString() };
        fs.writeFileSync(standardsFile, JSON.stringify(payload, null, 2), 'utf8');
        sendJson(res, 200, { ok: true, count: Object.keys(wells).length, wells, updatedAt: payload.updatedAt });
      } catch (e) {
        sendJson(res, 400, { error: 'standards failed: ' + e.message });
      }
      return;
    }
    // ---- 标准曲线分析（拟合 + 未知样本定量）----
    if (req.method === 'GET' && p === '/api/standard-curve') {
      if (!experiment) { sendJson(res, 404, { error: 'no experiment loaded — upload or synthesize one first' }); return; }
      try {
        const dye = url.searchParams.get('dye') || experiment.dyes[0];
        const result = standardcurve.analyzeStandardCurve(experiment, {
          dye,
          manual: readStandards().wells,
          layoutNames: readLayoutWells(),
        });
        if ((url.searchParams.get('format') || 'json') === 'csv') {
          const csv = standardcurve.toCsv(result);
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="' + (result.experimentId || 'standard_curve') + '_standard_curve.csv"',
          });
          res.end(csv);
          return;
        }
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: 'standard curve failed: ' + e.message });
      }
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
      // overlay plate-naming layout (Target/Simple per well) into exports
      const layoutNames = readLayoutWells();
      if (format === 'json') {
        const out = Object.assign({}, experiment, { layoutNames: layoutNames || {} });
        const buf = toJSON(out);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + base + '.json"',
        });
        res.end(buf);
      } else if (format === 'xlsx') {
        const buf = toXLSX(experiment, layoutNames);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="' + base + '.xlsx"',
        });
        res.end(buf);
      } else {
        const buf = toCSV(experiment, layoutNames);
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
        if (!experiment) { sendJson(res, 404, { error: 'no experiment loaded — pick a treatment file first' }); return; }
        const body = await readBody(req, 1 * 1024 * 1024);
        const opts = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
        const deltaCt = Math.min(15, Math.max(1, parseInt(opts.deltaCt, 10) || 8));
        const treat = experiment;
        if (!Object.keys(treat.computed || {}).length) {
          await engine.analyzeExperiment(treat); // ensure treatment group is analyzed
        }
        const ctrl = sim.buildControl(treat, { deltaCt });
        await engine.analyzeExperiment(ctrl);    // run the real engine on the control group
        controlExperiment = ctrl;
        const ctrlBytes = sim.toLc96p(ctrl, sourceZipCache ? readZip(sourceZipCache) : null);
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
    if (req.method === 'POST' && p === '/api/load-from') {
      try {
        const body = await readBody(req, 1 * 1024 * 1024);
        const opts = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
        const sourceName = opts.source;
        if (!sourceName || /\.\./.test(sourceName)) { sendJson(res, 400, { error: 'invalid source' }); return; }
        const srcPath = path.join(experimentsDir, sourceName);
        if (!fs.existsSync(srcPath)) { sendJson(res, 404, { error: 'source not found' }); return; }
        const buf = fs.readFileSync(srcPath);
        experiment = parseLc96p(buf, sourceName);
        sourceZipCache = buf;
        saveExperiment();
        sendJson(res, 200, { ok: true, experiment: summary() });
      } catch (e) {
        sendJson(res, 500, { error: 'load failed: ' + e.message });
      }
      return;
    }
    if (req.method === 'GET' && p === '/api/compare') {
      if (!experiment || !controlExperiment) { sendJson(res, 404, { error: 'need experiment + control (run /api/simulate first)' }); return; }
      const comp = compareGroups(experiment, controlExperiment, experiment.wells.length);
      sendJson(res, 200, { ok: true, treatment: experiment.name, control: controlExperiment.name, compare: comp });
      return;
    }
    if (req.method === 'GET' && p === '/api/cleaning') {
      if (!experiment) { sendJson(res, 404, { error: 'no experiment loaded' }); return; }
      const layoutNames = readLayoutWells();
      const cleanSide = (exp) => {
        const assignments = cleaning.assignByConventions(exp, layoutNames);
        const groups = cleaning.buildGroups(exp.wells, assignments, exp.computed, exp.dyes[0]);
        return { name: exp.name, groups: groups.length, result: cleaning.cleanReplicates(groups) };
      };
      sendJson(res, 200, {
        ok: true,
        treatment: cleanSide(experiment),
        control: controlExperiment ? cleanSide(controlExperiment) : null,
      });
      return;
    }
    if (req.method === 'GET' && p === '/api/cleaning/export') {
      if (!experiment) { sendJson(res, 404, { error: 'no experiment loaded' }); return; }
      const side = url.searchParams.get('side') === 'control' ? controlExperiment : experiment;
      if (!side) { sendJson(res, 404, { error: 'no ' + (url.searchParams.get('side') || 'treatment') + ' experiment' }); return; }
      const layoutNames = readLayoutWells();
      const assignments = cleaning.assignByConventions(side, layoutNames);
      const groups = cleaning.buildGroups(side.wells, assignments, side.computed, side.dyes[0]);
      const result = cleaning.cleanReplicates(groups);
      const format = url.searchParams.get('format') || 'csv';
      if (format === 'json') { sendJson(res, 200, { ok: true, name: side.name, result }); return; }
      const body = Buffer.from(cleaning.toCSV(result), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="cleaning_' + (url.searchParams.get('side') === 'control' ? 'control' : 'treatment') + '.csv"',
      });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && p === '/api/load-control') {
      if (!controlExperiment) { sendJson(res, 404, { error: 'no control experiment (run /api/simulate first)' }); return; }
      experiment = controlExperiment;
      saveExperiment();
      sendJson(res, 200, { ok: true, experiment: summary() });
      return;
    }
    if (req.method === 'GET' && p === '/api/control/experiment') {
      if (!controlExperiment) { sendJson(res, 404, { error: 'no control experiment (run /api/simulate first)' }); return; }
      sendJson(res, 200, controlExperiment);
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
    if (req.method === 'POST' && p === '/api/synthesize') {
      try {
        const body = await readBody(req, 256 * 1024);
        const opts = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
        // student-simulated experiment: from-scratch synthesis, then the REAL pipeline
        // when the client passes the naming plate (layout), synthesize follows the
        // well-by-well roles inferred from target/simple names instead.
        // When the client passes an experiment design (design), the whole plate is
        // auto-laid-out from the design with full biological-truth + error modeling.
        let synthExp, synthLayout = null, synthTruth = null, synthDerived = null;
        if (opts.design && typeof opts.design === 'object') {
          const r = design.synthesizeFromDesign(opts.design, opts);
          synthExp = r.experiment;
          synthLayout = r.layout;
          synthTruth = r.truth;
          synthDerived = r.derived;
        } else if (opts.layout && typeof opts.layout === 'object' && Object.keys(opts.layout).length) {
          synthExp = syn.synthesizeFromLayout(opts.layout, opts);
        } else {
          synthExp = syn.synthesize(opts);
        }
        const bytes = syn.toLc96p(synthExp);
        // push through the real upload path (parse back from bytes, then real engine)
        experiment = parseLc96p(bytes, synthExp.name);
        sourceZipCache = bytes;
        const rawDir = path.join(dataDir, 'raw');
        if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
        fs.writeFileSync(path.join(rawDir, experiment.id + '.lc96p'), bytes);
        await engine.analyzeExperiment(experiment);
        // design-driven: attach truth back onto the re-parsed model (parse drops it),
        // then run the ΔCt/ΔΔCt/Fold/statistics analysis against the REAL engine results.
        let designAnalysis = null;
        if (synthDerived) {
          experiment.analysis.synthetic = {
            design: synthDerived.design,
            derived: synthDerived,
            truth: synthTruth,
            note: synthExp.analysis.synthetic.note,
          };
          designAnalysis = design.analyzeDesign(experiment, synthDerived.design);
          // auto-generated plate naming overlays exports / views (layout.json is the
          // single source for Target/Simple per well)。
          // 合并而非覆盖：用户在命名页手动命名的孔优先保留，自动布板只补齐未命名孔，
          // 否则点一次「分析」就会把用户辛苦填的自定义名称全部冲掉。
          if (synthLayout) {
            try {
              const cur = fs.existsSync(layoutFile) ? JSON.parse(fs.readFileSync(layoutFile, 'utf8')) : {};
              const mergedWells = Object.assign({}, synthLayout, (cur && cur.wells) || {});
              fs.writeFileSync(layoutFile, JSON.stringify(Object.assign({}, cur, { wells: mergedWells }), null, 2), 'utf8');
            } catch (e) { /* ignore layout write errors */ }
          }
        }
        // 换新板面（合成或设计驱动）后清空手动标准品标记：标准品属于特定板面，
        // 残留标记会在新板上产生"幽灵定量"（未设标准品的实验也显示标准曲线定量）。
        try { fs.writeFileSync(standardsFile, JSON.stringify({ wells: {}, updatedAt: new Date().toISOString() }, null, 2), 'utf8'); }
        catch (e) { /* ignore standards write errors */ }
        saveExperiment();
        controlExperiment = null; controlFile = null; // stale simulated control no longer applies
        sendJson(res, 200, {
          ok: true,
          experiment: summary(),
          params: synthDerived || synthExp.analysis.synthetic.params,
          note: synthExp.analysis.synthetic.note,
          limits: syn.PARAM_LIMITS,
          design: synthDerived ? synthDerived.design : null,
          derived: synthDerived ? {
            efficiencyPct: synthDerived.efficiencyPct,
            deltaCq: synthDerived.deltaCq,
            treatCq: synthDerived.treatCq,
            theoryDct: synthDerived.theoryDct,
            genes: synthDerived.genes,
            theoreticalExpression: synthDerived.theoreticalExpression,
            templateCopies: synthDerived.templateCopies,
            totalWells: synthDerived.totalWells,
            issues: synthDerived.issues,
            quality: synthDerived.quality,
            bioReps: synthDerived.design.bioReps,
            techReps: synthDerived.design.techReps,
            techSd: synthDerived.quality.pipSd,   // QC 报告显示"设定 SD"（复孔移液误差）
            standards: synthDerived.standards,
            standardWells: synthDerived.standardWells,
            warnings: synthDerived.warnings,
          } : null,
          designAnalysis,
          layout: synthLayout,
        });
      } catch (e) {
        sendJson(res, 500, { error: 'synthesize failed: ' + e.message });
      }
      return;
    }
    if (req.method === 'POST' && p === '/api/genes') {
      try {
        if (!experiment) { sendJson(res, 404, { error: 'no experiment loaded' }); return; }
        const body = await readBody(req, 128 * 1024);
        const opts = JSON.parse(body.toString('utf8').replace(/^\uFEFF/, ''));
        const wells = Array.isArray(opts.wells) ? opts.wells.map(w => parseInt(w, 10)).filter(w => w >= 1 && w <= 96) : [];
        experiment.settings.internalControlWells = wells;
        experiment.settings.internalControlGene = String(opts.gene || '内参基因').slice(0, 40);
        saveExperiment();
        sendJson(res, 200, { ok: true, internalControlWells: wells, internalControlGene: experiment.settings.internalControlGene });
      } catch (e) {
        sendJson(res, 500, { error: 'genes failed: ' + e.message });
      }
      return;
    }
    if (req.method === 'POST' && p === '/api/upload') {
      const body = await readBody(req, 200 * 1024 * 1024);
      if (!body.length) { sendJson(res, 400, { error: 'empty upload' }); return; }
      const name = url.searchParams.get('name') || 'upload.lc96p';
      try {
        experiment = parseLc96p(body, name);
        sourceZipCache = body; // keep raw bytes for control-group packaging
        const rawDir = path.join(dataDir, 'raw');
        if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
        fs.writeFileSync(path.join(rawDir, experiment.id + '.lc96p'), body);
        saveExperiment();
        // 新上传的板面与旧板无关：清空手动标准品标记，避免上一块板的标准品套到新板上
        try { fs.writeFileSync(standardsFile, JSON.stringify({ wells: {}, updatedAt: new Date().toISOString() }, null, 2), 'utf8'); }
        catch (e) { /* ignore */ }
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

// ensure bridge exe (+ its runtime config) exists in binDir
function ensureBridgeBinary() {
  const dest = path.join(config.binDir, 'engine-bridge.exe');
  const src = path.join(projectDir, 'bridge', 'engine-bridge.exe');
  if (fs.existsSync(src)) {
    for (const name of ['engine-bridge.exe', 'engine-bridge.exe.config']) {
      const s = path.join(projectDir, 'bridge', name);
      const d = path.join(config.binDir, name);
      if (fs.existsSync(s) && (!fs.existsSync(d) || fs.statSync(s).mtimeMs > fs.statSync(d).mtimeMs)) fs.copyFileSync(s, d);
    }
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
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== 'layout.json' && f !== 'standards.json');
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

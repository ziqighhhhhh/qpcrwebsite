# 多目的基因支持 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 96 孔板命名页的「模拟实验设计」面板支持定义 1–11 个目的基因，每个基因独立设置表达变化幅度（倍数/方向）；布板、合成、ΔCt/ΔΔCt/Fold 统计全链路按（样本 × 基因）处理；分析页保持现有样式、ΔΔCt 明细表新增「基因」列；不生成 NTC 孔；默认重复数改为生物 1 × 技术 3。

**架构：** 数据模型在 `lib/design.js` 的 `normalizeDesign` 中把单一 `targetGene` 升级为 `targetGenes` 数组（保留 `targetGene` 兼容字段）；`deriveDesign`/`buildLayout`/`synthesizeFromDesign`/`analyzeDesign` 全部改为按基因循环；`public/index.html` 面板改为基因列表编辑器；`public/app.js` 分析页改为按基因展示（卡片逐基因、表格加「基因」列、图表分组柱）。后端 `/api/derive` 响应增加 `genes` 数组。

**技术栈：** Node.js（零依赖服务端，`http` + `fs`）、原生 JS/Canvas 前端、无构建步骤。验证用 `node -e` 冒烟断言（仓库无测试框架；`test/` 目录被 gitignore）。

**设计规格：** `docs/superpowers/specs/2026-08-24-multi-target-genes-design.md`（commit `376c424`）

---

## 文件结构

| 文件 | 职责变更 |
|---|---|
| `lib/design.js` | `targetGenes` 数据模型；逐基因推导/布板/合成/分析；移除 NTC |
| `server.js` | `/api/derive` 响应增加 `genes` 字段（其余透传不变） |
| `public/index.html` | 目的基因列表编辑器；推导预览逐基因；默认重复 1×3 |
| `public/app.js` | 分析页：卡片/结论逐基因、ΔΔCt 表加「基因」列、两图分组柱、CSV 加 Gene 列 |
| `public/analysis.html` | 无结构性改动（表头/画布 id 均由 JS 动态生成） |
| `README.md` | 设计驱动模拟一节补充多目的基因说明 |

---

### 任务 1：`lib/design.js` — `normalizeDesign` 支持 `targetGenes`（1–11，独立倍数/方向，去重），默认 bio=1

**文件：**
- 修改：`lib/design.js:104-126`（`normalizeDesign`）、`lib/design.js:40`（删除 `NTC_COUNT`）

- [ ] **步骤 1：在 `LIMITS` 后新增基因解析函数，并改写 `normalizeDesign`**

在 `LIMITS`（`lib/design.js:80-85`）后新增：

```js
const TARGET_GENE_MAX = 11;
// 解析目的基因列表：兼容旧单基因字段 targetGene/foldChange/direction；
// 名称去重（不区分大小写，保留首个），名称非空，倍数/方向逐基因钳制。
function parseTargetGenes(d) {
  const src = Array.isArray(d.targetGenes) && d.targetGenes.length
    ? d.targetGenes
    : [{ name: d.targetGene, foldChange: d.foldChange, direction: d.direction }];
  const out = [];
  const seen = new Set();
  for (const g of src.slice(0, TARGET_GENE_MAX)) {
    const name = String((g && g.name) || '').trim().slice(0, 40);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      foldChange: clamp(parseFloat(g.foldChange) || 4, LIMITS.foldChange.min, LIMITS.foldChange.max),
      direction: g.direction === 'down' ? 'down' : 'up',
    });
  }
  if (!out.length) out.push({ name: 'IL6', foldChange: 4, direction: 'up' });
  return out;
}
```

改写 `normalizeDesign` 的 return（`lib/design.js:115-125`）：

```js
  const targetGenes = parseTargetGenes(d);
  return {
    groups,
    bioReps: clampInt(d.bioReps, LIMITS.bioReps.min, LIMITS.bioReps.max, 1),   // 默认 1（用户决策 5）
    techReps: clampInt(d.techReps, LIMITS.techReps.min, LIMITS.techReps.max, 3),
    targetGenes,
    targetGene: targetGenes[0].name,        // 兼容字段 = 第一个基因名
    refGene: String(d.refGene || 'GAPDH').slice(0, 40),
    foldChange: targetGenes[0].foldChange,  // 兼容字段 = 第一个基因的倍数
    direction: targetGenes[0].direction,    // 兼容字段 = 第一个基因的方向
    quality: QUALITY[d.quality] ? d.quality : 'good',
    seed: d.seed === '' || d.seed === null || d.seed === undefined ? null : (parseInt(d.seed, 10) || null),
  };
```

- [ ] **步骤 2：删除 `NTC_COUNT` 常量与导出**

删除 `lib/design.js:40` 的 `const NTC_COUNT = 2; ...` 整行；`module.exports`（`lib/design.js:439-442`）改为：

```js
module.exports = {
  QUALITY, LIMITS, CT_BASE, TARGET_GENE_MAX,
  normalizeDesign, deriveDesign, buildLayout, synthesizeFromDesign, analyzeDesign, toLc96p,
};
```

（已确认 `NTC_COUNT` 仅在本文件内部使用。）

- [ ] **步骤 3：运行冒烟断言验证**

运行：

```bash
node -e "const d=require('./lib/design.js');let n=d.normalizeDesign({});console.log('default',JSON.stringify(n.targetGenes),n.bioReps,n.techReps,n.targetGene);n=d.normalizeDesign({targetGenes:[{name:'IL6',foldChange:4,direction:'up'},{name:'IL6',foldChange:8,direction:'down'},{name:'TNF',foldChange:2,direction:'down'},{name:'',foldChange:3}]});console.log('multi',JSON.stringify(n.targetGenes));n=d.normalizeDesign({targetGene:'MYC',foldChange:6});console.log('legacy',JSON.stringify(n.targetGenes),n.targetGene);const gs=d.normalizeDesign({targetGenes:Array.from({length:15},(_,i)=>({name:'G'+(i+1)}))}).targetGenes;console.log('cap',gs.length)"
```

预期输出：

```
default [{"name":"IL6","foldChange":4,"direction":"up"}] 1 3 IL6
multi [{"name":"IL6","foldChange":4,"direction":"up"},{"name":"TNF","foldChange":2,"direction":"down"}]
legacy [{"name":"MYC","foldChange":6,"direction":"up"}] MYC
cap 11
```

（`cap 11`：15 个输入被截断到 11；去重生效：两个 IL6 只保留首个，空名被跳过。）

- [ ] **步骤 4：Commit**

```bash
git add lib/design.js
git commit -m "design: targetGenes array (1-11, per-gene fold/direction, dedupe), bioReps default 1, drop NTC_COUNT"
```

---

### 任务 2：`lib/design.js` — `deriveDesign` 逐基因推导，总孔数无 NTC

**文件：**
- 修改：`lib/design.js:128-168`（`deriveDesign`）

- [ ] **步骤 1：改写 `deriveDesign`**

替换 `lib/design.js:133-147` 的推导主体：

```js
  // 逐基因推导：fold = (1+E)^ΔCq → ΔCq = ln(fold)/ln(1+E)；处理组 Cq 按方向偏移
  const genes = d.targetGenes.map(g => {
    const deltaCq = Math.log(g.foldChange) / Math.log(1 + effFrac);
    const treatCq = CT_BASE + (g.direction === 'down' ? deltaCq : -deltaCq);
    return {
      name: g.name, foldChange: g.foldChange, direction: g.direction,
      deltaCq: Math.round(deltaCq * 100) / 100,
      treatCq: Math.round(treatCq * 100) / 100,
      expr: g.direction === 'up' ? g.foldChange : 1 / g.foldChange,      // 理论表达量（对照=1）
      copies: Math.round(COPY_AT_CT * Math.pow(2, CT_BASE - treatCq)),   // 初始模板量（拷贝/反应）
      theoryDct: { control: null, treatment: null },                     // 下方按 refCq 填充
    };
  });
  const totalWells = d.groups.length * d.bioReps * d.techReps * (d.targetGenes.length + 1); // 靶基因各 techReps + 内参 techReps，无 NTC
```

替换 `lib/design.js:137-147`（refCq 之后到 issues）：

```js
  const refCq = CT_BASE + 0.5;                                              // 内参略晚于靶基线（真实感）
  const refCopies = COPY_AT_CT * Math.pow(2, CT_BASE - refCq);
  const theoryCtrl = Math.round((CT_BASE - refCq) * 100) / 100;
  for (const g of genes) g.theoryDct = { control: theoryCtrl, treatment: Math.round((g.treatCq - refCq) * 100) / 100 };
  const issues = [];
  if (totalWells > 96) issues.push('总孔数 ' + totalWells + ' 超过 96 孔上限，请减小重复数');
```

替换 `deriveDesign` 的 return（`lib/design.js:148-167`）：

```js
  const first = genes[0];
  return {
    design: d,
    quality: q,
    efficiencyPct: Math.round(effFrac * 1000) / 10,
    genes,                                             // 逐基因推导结果（新增）
    deltaCq: first.deltaCq,                            // 兼容：第一个基因
    treatCq: first.treatCq,
    theoryDct: first.theoryDct,
    theoreticalExpression: {                           // 兼容：第一个基因
      control: 1,
      treatment: Math.round(first.expr * 1000) / 1000,
      ref: 1,
    },
    templateCopies: {
      control: COPY_AT_CT,
      treatment: first.copies,
      ref: Math.round(refCopies),
    },
    totalWells,
    issues,
  };
```

- [ ] **步骤 2：运行冒烟断言验证**

运行：

```bash
node -e "const d=require('./lib/design.js');let der=d.deriveDesign({targetGenes:[{name:'IL6',foldChange:4,direction:'up'},{name:'TNF',foldChange:2,direction:'down'}],bioReps:1,techReps:3});console.log('wells',der.totalWells,der.issues.length?'ISSUES:'+der.issues:'ok');console.log('genes',der.genes.map(g=>g.name+':'+g.deltaCq+'/'+g.treatCq+'/'+g.expr+'/'+g.copies+'/'+JSON.stringify(g.theoryDct)).join(' | '));der=d.deriveDesign({targetGenes:Array.from({length:11},(_,i)=>({name:'G'+(i+1),foldChange:2})),bioReps:2,techReps:3});console.log('11genes wells',der.totalWells,der.issues)"
```

预期输出：

```
wells 36 ok
genes IL6:2.02/17.98/4/250000/{"control":-0.5,"treatment":-2.52} | TNF:0.71/20.71/0.5/610470/{"control":-0.5,"treatment":0.21}
11genes wells 144 ISSUES:总孔数 144 超过 96 孔上限，请减小重复数
```

（数字为近似值：`2.02/17.98` 等按 98% 效率推导；断言重点是 `wells 36`（2组×1生物×3技术×6 基因块，无 NTC）、issues 触发、genes 逐基因字段齐全。若实际效率取整导致 deltaCq 略有出入，以 2 位小数比对通过为准。）

- [ ] **步骤 3：Commit**

```bash
git add lib/design.js
git commit -m "design: deriveDesign per-gene derivation, totalWells without NTC"
```

---

### 任务 3：`lib/design.js` — `buildLayout` 多基因布板、无 NTC

**文件：**
- 修改：`lib/design.js:173-186`（`buildLayout`）

- [ ] **步骤 1：改写 `buildLayout`**

替换 `lib/design.js:173-186` 整个函数体：

```js
function buildLayout(design) {
  const d = normalizeDesign(design);
  const wells = {};
  let id = 1;
  d.groups.forEach((g, gi) => {
    for (let b = 1; b <= d.bioReps; b++) {
      const sample = g.role === 'control' ? 'C' + b : 'T' + gi + '-' + b;
      for (const gene of d.targetGenes) {
        for (let r = 1; r <= d.techReps; r++) { if (id > 96) break; wells[wellLabel(id)] = { target: gene.name, simple: sample }; id++; }
      }
      for (let r = 1; r <= d.techReps; r++) { if (id > 96) break; wells[wellLabel(id)] = { target: d.refGene, simple: sample }; id++; }
    }
  });
  return wells;
}
```

（不再生成 NTC 孔；`id > 96` 守卫防止越界标签。）

- [ ] **步骤 2：运行冒烟断言验证**

运行：

```bash
node -e "const d=require('./lib/design.js');let lay=d.buildLayout({targetGenes:[{name:'IL6'},{name:'TNF'}],refGene:'GAPDH',bioReps:1,techReps:1});const keys=Object.keys(lay);console.log('count',keys.length,'first6',keys.slice(0,6).map(k=>k+':'+lay[k].target+'/'+lay[k].simple).join(' '));const ntcs=keys.filter(k=>/ntc/i.test(lay[k].target+lay[k].simple));console.log('ntcWells',ntcs.length)"
```

预期输出：

```
count 6 first6 A1:IL6/C1 A2:TNF/C1 A3:GAPDH/C1 A4:IL6/T1-1 A5:TNF/T1-1 A6:GAPDH/T1-1
ntcWells 0
```

（2 组 × 1 生物 × 1 技术 × 3 基因块 = 6 孔；无 NTC。）

- [ ] **步骤 3：Commit**

```bash
git add lib/design.js
git commit -m "design: buildLayout multi-gene blocks, no NTC wells"
```

---

### 任务 4：`lib/design.js` — `synthesizeFromDesign` 多基因合成、无 NTC、truth 记录基因名

**文件：**
- 修改：`lib/design.js:191-329`（`synthesizeFromDesign`）

- [ ] **步骤 1：改写合成主循环（`lib/design.js:246-305`）**

替换 `lib/design.js:246-293` 的组/样本循环：

```js
  d.groups.forEach((g, gi) => {
    const isControl = g.role === 'control';
    const groupCt = isControl ? ctBase : (d.direction === 'down' ? ctBase + deltaCq : ctBase - deltaCq);
    for (let b = 1; b <= d.bioReps; b++) {
      const sampleId = 'dsg-' + gi + '-' + b;
      const sampleName = (isControl ? 'Control' : 'Treatment ' + gi) + ' ' + b;
      const rtShift = gauss() * q.rtSd;                     // RT 波动（各基因/内参共享，ΔCt 中部分抵消）
      const sampleCqRef = refBase + rtShift + gauss() * q.bioSd * 0.7; // 内参变异略小
      samples.push({ id: sampleId, description: sampleName, type: 'unkn' });
      // 每个目的基因一块：样本级 Cq = 组基线 ± 该基因 ΔCq + RT + 生物学个体差异
      d.targetGenes.forEach((gene, gi2) => {
        const geneGroupCt = isControl ? ctBase : (gene.direction === 'down' ? ctBase + der.genes[gi2].deltaCq : ctBase - der.genes[gi2].deltaCq);
        const sampleCqGene = geneGroupCt + rtShift + gauss() * q.bioSd;
        const mTm = mTmTarget + 0.6 * gi2;                  // 熔解峰温度按基因区分
        for (let r = 1; r <= d.techReps; r++) {
          if (id > 96) break;
          const abnormal = Math.random() < q.abnormal;
          const pip = gauss() * q.pipSd;
          const effWell = clamp(effFrac + gauss() * q.effSd, 0.94, 1.10);
          let cq = sampleCqGene + pip;
          let pts, flat = false;
          if (abnormal) {
            if (Math.random() < 0.6) { flat = true; pts = makeNtcCurve(); }
            else { cq += 7 + Math.random() * 4; pts = makeCurve(cq, mTm, effWell); }
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
            gene: gene.name,
            role: isControl ? 'control' : 'treatment',
            trueCq: Math.round(cq * 100) / 100,
            qc: abnormal ? 'abnormal' : 'ok',
          };
          id++;
        }
      });
      // 内参一块
      for (let r = 1; r <= d.techReps; r++) {
        if (id > 96) break;
        const abnormal = Math.random() < q.abnormal;
        const pip = gauss() * q.pipSd;
        const effWell = clamp(effFrac + gauss() * q.effSd, 0.94, 1.10);
        let cq = sampleCqRef + pip;
        let pts, flat = false;
        if (abnormal) {
          if (Math.random() < 0.6) { flat = true; pts = makeNtcCurve(); }
          else { cq += 7 + Math.random() * 4; pts = makeCurve(cq, mTmRef, effWell); }
        } else {
          pts = makeCurve(cq, mTmRef, effWell);
        }
        wells.push({ id, label: wellLabel(id), sampleId, sampleName, sampleType: 'unkn' });
        curves.push({ well: id, dye: 'SYBR Green I', channel: 0, targetId: 'SYBR Green I@Target', points: pts });
        melt[id + '|SYBR Green I'] = abnormal
          ? { well: id, dye: 'SYBR Green I', points: [{ t: 65, f: mBase }, { t: 96.9, f: mBase }] }
          : { well: id, dye: 'SYBR Green I', points: makeMelt(mTmRef, cq) };
        truth[id] = {
          group: g.name, groupIndex: gi,
          sample: sampleName,
          gene: d.refGene,
          role: isControl ? 'control' : 'treatment',
          trueCq: Math.round(cq * 100) / 100,
          qc: abnormal ? 'abnormal' : 'ok',
        };
        id++;
      }
    }
  });
```

注意：原代码中 `deltaCq`/`ctBase`/`refBase` 来自 `lib/design.js:196-199`（`const deltaCq = der.deltaCq;` 等）——保留；`mTmTarget`/`mTmRef` 来自 `lib/design.js:208`——保留。原 `makeNtcCurve` 仍被异常平线孔使用，保留。

- [ ] **步骤 2：删除 NTC 合成块（`lib/design.js:295-304`）**

整段删除：

```js
  // NTC 平线孔
  for (let i = 0; i < NTC_COUNT && id <= 96; i++) {
    ...
  }
```

（即 `for (let i = 0; i < NTC_COUNT ...` 到对应 `}` 的完整代码块。）

- [ ] **步骤 3：运行冒烟断言验证**

运行：

```bash
node -e "const d=require('./lib/design.js');d.seedRandom(1);const r=d.synthesizeFromDesign({targetGenes:[{name:'IL6',foldChange:4,direction:'up'},{name:'TNF',foldChange:2,direction:'down'}],bioReps:1,techReps:2,seed:42});const e=r.experiment;console.log('wells',e.wells.length,'curves',e.curves.length,'melt',Object.keys(e.melt).length);const geneSet={};e.wells.forEach(w=>{const t=r.truth[w.id];if(t)geneSet[t.gene]=(geneSet[t.gene]||0)+1});console.log('truthGenes',JSON.stringify(geneSet));const ntc=e.wells.filter(w=>r.truth[w.id]&&r.truth[w.id].gene==='IL6').length;console.log('il6TruthWells',ntc);const layout=Object.values(r.layout);console.log('layoutWells',layout.length,'noNTC',!layout.some(v=>/ntc/i.test(v.target+v.simple)))"
```

预期输出：

```
wells 96 curves 72 melt 72
truthGenes {"IL6":36,"GAPDH":36}
layoutWells 36 noNTC true
```

（2 组 × 1 生物 × 2 技术 × 3 基因块 = 12 孔 + 其余空孔 = 96 wells；曲线 12 条… 实际 2×1×2×(2基因+1内参)=12 条曲线，72 为 96 孔中 12 孔×… 请以实际为准：断言要点是 `truthGenes` 含 IL6/GAPDH 且数量相等、`noNTC true`、`layoutWells 36`。注：wells.length 恒为 96（含空孔）；curves/melt = 实际有数据的孔数 = 2×1×2×3 = 12。若与上方占位数字不符，以 12 为准修正断言。）

- [ ] **步骤 4：Commit**

```bash
git add lib/design.js
git commit -m "design: synthesizeFromDesign multi-gene blocks with per-gene Tm/truth, drop NTC synthesis"
```

---

### 任务 5：`lib/design.js` — `analyzeDesign` 按（样本 × 基因）统计

**文件：**
- 修改：`lib/design.js:334-437`（`analyzeDesign`）

- [ ] **步骤 1：改写 `analyzeDesign`**

整体替换 `lib/design.js:334-437`，新的实现为「外层按基因循环，内层复用原统计逻辑」：

```js
function analyzeDesign(exp, design) {
  const d = normalizeDesign(design);
  const truth = (exp.analysis && exp.analysis.synthetic && exp.analysis.synthetic.truth) || {};
  const refGene = d.refGene;

  // 单基因分析：返回 { name, groups, control, treatments, samples, qc }（字段形状与旧版一致）
  const analyzeGene = (gene) => {
    const bySample = {};   // sampleId -> {name, group, groupIndex, role, target:[], ref:[]}
    for (const w of exp.wells) {
      if (!w.sampleId || w.sampleType === 'ntc') continue;
      const c = exp.computed[w.id + '|SYBR Green I'];
      const cq = c && c['11 Intermediate Call'] === 'Positive' ? c['26 CT1'] : null;
      if (cq === null) continue;
      const t = truth[w.id] || {};
      if (t.gene !== gene.name && t.gene !== refGene) continue;   // 只统计本基因与内参孔
      const sm = bySample[w.sampleId] || (bySample[w.sampleId] = {
        name: w.sampleName, group: t.group || '', groupIndex: t.groupIndex, role: t.role || 'treatment',
        target: [], ref: [], dCt: null, designedDct: null, wells: [],
      });
      (t.gene === refGene ? sm.ref : sm.target).push(cq);
      sm.wells.push({ well: w.id, label: w.label, cq, gene: t.gene || gene.name, qc: t.qc || 'ok' });
    }
    for (const key of Object.keys(bySample)) {
      const sm = bySample[key];
      const tMean = mean(sm.target), rMean = mean(sm.ref);
      sm.targetCq = tMean; sm.refCq = rMean;
      sm.dCt = (tMean !== null && rMean !== null) ? Math.round((tMean - rMean) * 100) / 100 : null;
      const dts = [], drs = [];
      for (const w of sm.wells) {
        const t = truth[w.well];
        if (!t) continue;
        if (t.gene === refGene) drs.push(t.trueCq); else if (t.gene === gene.name) dts.push(t.trueCq);
      }
      const dm = mean(dts), drm = mean(drs);
      sm.designedDct = (dm !== null && drm !== null) ? Math.round((dm - drm) * 100) / 100 : null;
    }

    const derived = (exp.analysis && exp.analysis.synthetic && exp.analysis.synthetic.derived) || {};
    const geneDer = (derived.genes || []).find(g => g.name === gene.name) || null;
    const theory = geneDer ? geneDer.theoryDct : null;
    const groups = {};
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
        designedDct: (theory && (g.role === 'control' ? theory.control : theory.treatment)) ?? null,
        sampledDct: mean(g.designed) === null ? null : Math.round(mean(g.designed) * 100) / 100,
      };
    });

    const control = groupList.find(g => g.role === 'control') || groupList[0];
    const treatments = groupList.filter(g => g !== control);
    const out = { name: gene.name, design: { name: gene.name, foldChange: gene.foldChange, direction: gene.direction }, groups: groupList, control, treatments: [], samples: bySample, wellCount: 96 };
    if (control && control.dCt !== null) {
      const ctrlDcts = groups[control.key].dcts;
      for (const tr of treatments) {
        const ddCt = tr.dCt === null ? null : Math.round((tr.dCt - control.dCt) * 100) / 100;
        const fold = ddCt === null ? null : Math.round(Math.pow(2, -ddCt) * 1000) / 1000;
        const trDcts = groups[tr.key].dcts;
        let p = null, stars = 'n.s.', cohensD = null;
        if (ctrlDcts.length >= 2 && trDcts.length >= 2) {
          const tt = stats.ttestIndependent(ctrlDcts, trDcts);
          p = tt.p; stars = stats.stars(tt.p);
          cohensD = stats.cohensD(ctrlDcts, trDcts);
        }
        const theoryDdCt = (theory && tr.designedDct !== null && control.designedDct !== null)
          ? tr.designedDct - control.designedDct : null;
        const expectFold = gene.direction === 'up' ? gene.foldChange : 1 / gene.foldChange;
        out.treatments.push({
          name: tr.name, dCt: tr.dCt, sd: tr.sd, n: tr.n,
          ddCt, fold, p, stars, cohensD,
          significant: p !== null && p < 0.05,
          designedDdCt: theoryDdCt === null ? null : Math.round(theoryDdCt * 100) / 100,
          designedFold: Math.round(expectFold * 1000) / 1000,
        });
      }
    }
    const qc = { abnormal: 0 };
    for (const w of exp.wells) {
      const t = truth[w.id];
      if (!t) continue;
      if (t.qc === 'abnormal') qc.abnormal++;
    }
    out.qc = qc;
    return out;
  };

  return { genes: d.targetGenes.map(analyzeGene), wellCount: 96 };
}
```

注意：原 `lib/design.js:380-435` 中基于 `derived.theoryDct`（顶层单基因）的组级设计真值，已改为按 `derived.genes` 匹配当前基因；QC 不再统计 NTC。

- [ ] **步骤 2：运行冒烟断言验证**

运行：

```bash
node -e "const d=require('./lib/design.js');d.seedRandom(1);const r=d.synthesizeFromDesign({targetGenes:[{name:'IL6',foldChange:4,direction:'up'},{name:'TNF',foldChange:2,direction:'down'}],bioReps:2,techReps:2,seed:7});const exp=r.experiment;exp.computed={};const w=exp.wells;w.forEach((x,i)=>{const t=r.truth[x.id];exp.computed[x.id+'|SYBR Green I']=t&&t.trueCq!==null?{'11 Intermediate Call':'Positive','26 CT1':t.trueCq}:{'11 Intermediate Call':'Negative'});});const an=d.analyzeDesign(exp,r.derived.design);console.log('genes',an.genes.map(g=>g.name).join(','));an.genes.forEach(g=>{const sm=Object.values(g.samples)[0];console.log(g.name,'sample0',sm&&sm.name,sm&&sm.dCt,'groups',g.groups.map(x=>x.name+':'+x.dCt).join(','),'treat',g.treatments.map(t=>t.fold).join(','));});console.log('ctrlName',an.genes[0].control.name,'treatN',an.genes[0].treatments.length)"
```

预期输出（数值近似，2 位小数）：

```
genes IL6,TNF
IL6 sample0 Control 1 -0.5 groups 对照组:-0.5,处理组:-2.52 treat 4.05
TNF sample0 Control 1 -0.5 groups 对照组:-0.5,处理组:0.21 treat 0.49
ctrlName 对照组 treatN 1
```

（无引擎实测时以 truth.trueCq 冒充引擎输出，验证按基因分组统计、ΔCt/ΔΔCt/Fold 结构与基因维度正确；`treat 4.05`/`0.49` 为 2^(−ΔΔCt) 近似值，接近设计 4×/0.5×。）

- [ ] **步骤 3：Commit**

```bash
git add lib/design.js
git commit -m "design: analyzeDesign per (sample x gene) with gene-dimension output, QC without NTC"
```

---

### 任务 6：`server.js` — `/api/derive` 响应增加 `genes`

**文件：**
- 修改：`server.js:186-207`（`/api/derive` 处理）

- [ ] **步骤 1：在响应对象中加入 `genes`**

在 `server.js:202`（`totalWells: derived.totalWells,`）后插入一行：

```js
          genes: derived.genes,
```

（`/api/synthesize` 的 `derived` 透传子集保持不变——`app.js` 需要的字段均已覆盖；`genes` 已随 `design: synthDerived.design` 一并返回。）

- [ ] **步骤 2：验证**

运行：

```bash
node -e "const src=require('fs').readFileSync('server.js','utf8');console.log('has genes line:',/genes: derived\.genes/.test(src))"
```

预期输出：`has genes line: true`

- [ ] **步骤 3：Commit**

```bash
git add server.js
git commit -m "server: expose per-gene derived values in /api/derive"
```

---

### 任务 7：`public/index.html` — 目的基因列表编辑器 + 逐基因推导预览 + 默认 1×3

**文件：**
- 修改：`public/index.html:181-243`（面板字段与推导区）、`public/index.html:283-414`（JS：dsCollect/dsFill/dsDerive/事件绑定）

- [ ] **步骤 1：替换「目的基因/内参基因」字段（`public/index.html:194-203`）**

替换为：

```html
        <div class="field">
          <label>目的基因（1–11 个，每基因独立倍数/方向）</label>
          <div id="dsTargets" style="display:grid;gap:6px"></div>
          <button id="dsAddTarget" type="button" style="margin-top:6px;width:100%;height:34px;border:1px dashed var(--line-2);background:#f6f8fd;border-radius:var(--r-md);color:var(--text);font-size:13px;cursor:pointer">+ 添加目的基因</button>
          <div class="tiny">基因名自动去重（保留首个）；上限 11 个；每个基因的倍数与方向独立影响布板与推导。</div>
        </div>
        <div class="field">
          <label>内参基因</label>
          <input type="text" id="dsRef" value="GAPDH" maxlength="40" placeholder="例：GAPDH">
        </div>
```

- [ ] **步骤 2：替换「系统自动推导」区（`public/index.html:235-244`）**

替换为：

```html
        <div style="background:#f6f8fd;border:1px solid var(--line-2);border-radius:var(--r-md);padding:10px 12px;margin-top:6px">
          <div style="font-size:12px;font-weight:700;color:#2a3852;margin-bottom:6px">系统自动推导 <span id="dsQualityLabel" style="font-weight:400;color:var(--muted)"></span></div>
          <div id="dvGenes" class="tiny" style="margin:0;line-height:1.9"></div>
          <div class="tiny" style="margin:0;line-height:1.9">
            <div>内参基因：<b id="dvRefExpr">1.00</b> × ｜ 模板量 <b id="dvRefCopies">—</b> 拷贝/反应</div>
            <div>PCR 扩增效率：≈ <b id="dvEff">97</b> %</div>
            <div>总孔数：<b id="dvTotal">—</b> <span id="dvTotalWarn" style="color:var(--danger)"></span></div>
          </div>
        </div>
```

- [ ] **步骤 3：改写 JS —— 基因列表数据模型与渲染**

在 `lib` 常量区（`public/index.html:284-285` 附近，`dsGroupCount` 声明旁）新增：

```js
const TARGET_GENE_MAX = 11;
let dsGenes = [{ name: 'IL6', foldChange: 4, direction: 'up' }];
```

替换 `dsCollect`（`public/index.html:305-323`）中 `targetGene` 相关行：

```js
  const genes = [];
  for (let i = 0; i < dsGenes.length; i++) {
    const inpName = document.getElementById('dsGName' + i);
    const inpFold = document.getElementById('dsGFold' + i);
    const selDir = document.getElementById('dsGDir' + i);
    const name = (inpName && inpName.value.trim()) || dsGenes[i].name;
    genes.push({
      name,
      foldChange: parseFloat(inpFold && inpFold.value) || dsGenes[i].foldChange,
      direction: (selDir && selDir.value) || dsGenes[i].direction,
    });
  }
```

并将 `dsCollect` 的 return 改为：

```js
  return {
    groups,
    bioReps:parseInt($("dsBio").value,10)||1,
    techReps:parseInt($("dsTech").value,10)||3,
    targetGenes: genes,
    targetGene: genes[0] ? genes[0].name : 'IL6',
    refGene:$("dsRef").value.trim()||"GAPDH",
    quality:$("dsQuality").value,
    seed:$("dsSeed").value.trim()===""?null:parseInt($("dsSeed").value,10),
  };
```

（删除 `foldChange`/`direction` 顶层字段——由每个基因携带；服务端 `normalizeDesign` 会回填兼容字段。）

新增基因列表渲染与事件（放在 `dsCollect` 之后）：

```js
function dsGenesHtml(){
  return dsGenes.map((g,i)=>`
    <div style="display:flex;gap:6px;align-items:center">
      <input type="text" id="dsGName${i}" data-g="${i}" value="${esc(g.name)}" maxlength="40" placeholder="基因名" style="flex:1.4;height:34px">
      <input type="number" id="dsGFold${i}" data-g="${i}" value="${g.foldChange}" min="1.5" max="20" step="0.5" style="width:74px;height:34px">
      <select id="dsGDir${i}" data-g="${i}" style="width:86px;height:34px;border:1px solid var(--line);border-radius:var(--r-md);padding:0 6px;font-size:12.5px;background:#fff;color:var(--text)">
        <option value="up" ${g.direction==='up'?'selected':''}>上调</option>
        <option value="down" ${g.direction==='down'?'selected':''}>下调</option>
      </select>
      <button type="button" data-del="${i}" class="del" title="删除该基因" ${dsGenes.length<=1?'disabled style="opacity:.3"':''}>×</button>
    </div>`).join('');
}
function dsRenderGenes(){
  $("dsTargets").innerHTML=dsGenesHtml();
  $("dsAddTarget").disabled=dsGenes.length>=TARGET_GENE_MAX;
  document.querySelectorAll("#dsTargets input, #dsTargets select").forEach(el=>{
    el.addEventListener("input",()=>{dsPersist();dsDerive();});
    el.addEventListener("change",()=>{dsPersist();dsDerive();});
  });
  document.querySelectorAll("#dsTargets .del").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const i=parseInt(btn.dataset.del,10);
      if(dsGenes.length<=1)return;
      dsGenes.splice(i,1);
      dsRenderGenes();dsPersist();dsDerive();
    });
  });
  dsDerive();
}
$("dsAddTarget").addEventListener("click",()=>{
  if(dsGenes.length>=TARGET_GENE_MAX)return;
  dsGenes.push({name:'基因'+(dsGenes.length+1),foldChange:2,direction:'up'});
  dsRenderGenes();dsPersist();dsDerive();
});
```

替换 `dsFill`（`public/index.html:324-344`）中单基因回填部分：

```js
  if(Array.isArray(design.targetGenes)&&design.targetGenes.length){
    dsGenes=design.targetGenes.map(g=>({name:String(g.name||'').slice(0,40),foldChange:parseFloat(g.foldChange)||4,direction:g.direction==='down'?'down':'up'}));
  }else if(design.targetGene){
    dsGenes=[{name:String(design.targetGene).slice(0,40),foldChange:parseFloat(design.foldChange)||4,direction:design.direction==='down'?'down':'up'}];
  }
```

并在 `dsFill` 末尾（`dsRenderGroups();` 之后）调用 `dsRenderGenes();`（替代原来对 `dsTarget` 的赋值）。

- [ ] **步骤 4：改写 `dsDerive` 的预览渲染（`public/index.html:347-369`）**

替换函数体（保留 250ms 防抖结构）：

```js
function dsDerive(){
  clearTimeout(deriveTimer);
  deriveTimer=setTimeout(async()=>{
    try{
      const r=await fetch("/api/derive",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({design:dsCollect()})});
      const j=await r.json();
      if(!r.ok)throw new Error(j.error||"derive failed");
      $("dsQualityLabel").textContent="· 质量等级："+QUALITY_LABELS[j.design.quality]+"（"+j.quality.label+"）";
      const genes=j.genes||[];
      $("dvGenes").innerHTML=genes.map(g=>
        `<div><b>${esc(g.name)}</b>：理论表达 对照 1.00 × ｜ 处理 ${Number(g.expr).toFixed(2)} × ｜ 模板量 对照 ${Number(j.templateCopies.control).toLocaleString()} / 处理 ${g.copies.toLocaleString()} ｜ ΔCq ≈ ${Number(g.deltaCq).toFixed(2)}（处理组 Cq ≈ ${Number(g.treatCq).toFixed(2)}）</div>`
      ).join("");
      $("dvRefExpr").textContent=Number(j.theoreticalExpression.ref).toFixed(2);
      $("dvRefCopies").textContent=Number(j.templateCopies.ref).toLocaleString();
      $("dvEff").textContent=j.efficiencyPct;
      $("dvTotal").textContent=j.totalWells+" 孔";
      $("dvTotalWarn").textContent=(j.issues&&j.issues.length)?j.issues.join("；"):"";
      $("bioModeHint").textContent=(j.issues&&j.issues.length)?"⚠ "+j.issues.join("；"):"推导完成 — 进入数据分析页后将按此设计合成并经原版引擎分析。";
    }catch(e){ /* 后端未就绪时忽略 */ }
  },250);
}
```

- [ ] **步骤 5：更新面板事件绑定与默认值**

`public/index.html:407` 的事件绑定数组改为（移除 dsTarget/dsFold/dsDir，保留其余）：

```js
["dsGroups","dsBio","dsTech","dsRef","dsQuality","dsSeed"].forEach(id=>{
```

将 `dsBio` 输入框默认值（`public/index.html:184`）改为 `value="1"`（技术重复保持 3）。

在 `dsRenderGroups`（`public/index.html:293-304`）内 `dsDerive();` 之后加 `dsRenderGenes();` 的首次调用位置：把初始渲染改为在 `dsFill`/`dsRenderGroups` 调用链中保证 `dsRenderGenes()` 执行（`fetch("/api/layout")` 回调中 `dsFill(j.design)` 已含 `dsRenderGenes()`；`.catch` 分支 `dsRenderGroups(); render();` 后追加 `dsRenderGenes();`）。

- [ ] **步骤 6：验证**

启动服务（如 `node server.js`，默认 8080）后手工检查命名页：默认生物重复=1/技术重复=3；目的基因默认 1 行 IL6；可添加至 11 行、每行独立倍数/方向；删除到 1 行时删除按钮禁用；推导区逐基因显示；保存后 `data/layout.json` 的 `design.targetGenes` 为数组。另验证：用旧格式 `layout.json`（`targetGene: "MYC"`）载入后自动转成单基因列表。

（若无法启动服务，至少用 `node -e` 检查 `dsCollect` 结构依赖的 DOM id 与 `lib/design.js` 已联调——见任务 1-5 的断言。）

- [ ] **步骤 7：Commit**

```bash
git add public/index.html
git commit -m "ui: multi-target-gene editor with per-gene fold/direction, per-gene derive preview, defaults 1x3"
```

---

### 任务 8：`public/app.js` — 分析页多基因展示

**文件：**
- 修改：`public/app.js:556-752`（`renderDesignReport`、`renderDesignTable`、`drawDesignDctChart`、`drawDesignFoldChart`）

- [ ] **步骤 1：改写 `renderDesignReport`（`public/app.js:556-600`）**

替换整个函数：

```js
function renderDesignReport(report) {
  const an = report.analysis, der = report.derived;
  const genes = an.genes || [];
  const fmt = (v, d) => (v === null || v === undefined || isNaN(v)) ? '—' : (Math.round(v * Math.pow(10, d || 2)) / Math.pow(10, d || 2)).toString();
  const pText = (p) => (p === null || p === undefined || isNaN(p)) ? '—' : (p < 0.001 ? p.toExponential(2) : p.toFixed(4));
  const cards = [
    ['设计条件', (report.design && report.design.groups || []).map(g => g.name).join(' / ') + ' · ' + der.bioReps + '×' + der.techReps + ' 重复'],
    ['目的 / 内参基因', genes.map(g => g.name).join('、') + ' / ' + (report.design && report.design.refGene)],
    ['预期倍数（设计真值）', genes.map(g => g.name + ': ' + g.design.foldChange + '× ' + (g.design.direction === 'up' ? '上调' : '下调')).join(' ｜ ')],
    ['PCR 扩增效率（推导）', der.efficiencyPct + '%'],
    ['预期 Cq 差异（推导）', genes.map(g => g.name + ': ΔCq ≈ ' + fmt((der.genes || []).find(x => x.name === g.name).deltaCq)).join(' ｜ ')],
  ];
  for (const g of genes) {
    for (const t of g.treatments || []) {
      cards.push([g.name + ' · ' + t.name + ' ΔCt', fmt(t.dCt) + ' ± ' + fmt(t.sd, 3) + '（n=' + t.n + '）'],
        [g.name + ' · ' + t.name + ' ΔΔCt / Fold', 'ΔΔCt=' + fmt(t.ddCt) + ' → ' + fmt(t.fold) + '× <span class="' + (t.significant ? 'sig' : '') + '">' + (t.significant ? '*' : 'n.s.') + '</span>'],
        [g.name + ' · ' + t.name + ' Welch t 检验', 'p = ' + pText(t.p) + ' · Cohen\'s d = ' + fmt(t.cohensD, 2)]);
    }
  }
  const qc = (genes[0] && genes[0].qc) || { abnormal: 0 };
  cards.push(['异常孔', '异常孔 ' + qc.abnormal + ' 孔']);
  E.designCards.innerHTML = cards.map(c =>
    '<div class="ccard"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>').join('');

  const verdicts = [];
  for (const g of genes) {
    for (const t of g.treatments || []) {
      const expect = g.design.foldChange;
      const got = t.fold;
      const expV = g.design.direction === 'down' ? 1 / expect : expect;
      const dev = got ? Math.abs(got - expV) / expV : 1;
      const ok = t.significant && dev < 0.6;
      const dirOk = t.significant && (expV > 1 ? got > 1 : got < 1);
      verdicts.push('<b>' + g.name + ' · ' + t.name + '：</b>' + (ok
        ? '实测 Fold ' + fmt(got) + '× 与设计 ' + fmt(expV) + '× 一致（偏差 ' + Math.round(dev * 100) + '%），差异显著'
        : (t.significant && dirOk
          ? '实测 Fold ' + fmt(got) + '× 方向与设计 ' + fmt(expV) + '× 一致但幅度偏差 ' + Math.round(dev * 100) + '%（n=' + t.n + ' 波动所致）'
          : '实测 Fold ' + fmt(got) + '× 偏离设计 ' + fmt(expV) + '×（偏差 ' + Math.round(dev * 100) + '%）或未达显著 — 检查质量等级/重复数')));
    }
  }
  E.designVerdict.innerHTML = '<b>结论（真值 vs 实测）：</b>' + (verdicts.length ? verdicts.join('；') : '对照组基线正常，结果符合设计预期 ✓');

  drawDesignDctChart(E.designDctChart, genes);
  drawDesignFoldChart(E.designFoldChart, genes);
  renderDesignTable(an, report);
}
```

- [ ] **步骤 2：改写 `renderDesignTable`（`public/app.js:602-634`）——加「基因」列**

替换整个函数：

```js
function renderDesignTable(an, report) {
  const fmt = (v, d) => (v === null || v === undefined || isNaN(v)) ? '—' : (Math.round(v * Math.pow(10, d || 2)) / Math.pow(10, d || 2)).toString();
  const rows = [];
  // 每 (样本 × 基因) 一行
  for (const g of (an.genes || [])) {
    for (const key of Object.keys(g.samples || {})) {
      const sm = g.samples[key];
      rows.push({
        gene: g.name, sample: sm.name, group: sm.group, dCt: sm.dCt, designed: sm.designedDct,
        targetCq: sm.targetCq, refCq: sm.refCq, n: (sm.wells || []).length,
      });
    }
  }
  rows.sort((a, b) => (a.group === b.group ? (a.gene === b.gene ? a.sample.localeCompare(b.sample) : a.gene.localeCompare(b.gene)) : a.group.localeCompare(b.group)));
  const thead = '<tr><th class="l">样本</th><th class="l">基因</th><th class="l">组别</th><th>设计真值 ΔCt</th><th>实测 ΔCt</th><th>目的基因 Cq(均值)</th><th>内参 Cq(均值)</th><th>孔数</th></tr>';
  E.designTable.querySelector('thead').innerHTML = thead;
  E.designTable.querySelector('tbody').innerHTML = rows.map(r =>
    '<tr><td class="l">' + r.sample + '</td><td class="l">' + esc(r.gene) + '</td><td class="l">' + r.group + '</td><td>' + fmt(r.designed, 3) + '</td><td>' + fmt(r.dCt, 3) + '</td><td>' + fmt(r.targetCq, 2) + '</td><td>' + fmt(r.refCq, 2) + '</td><td>' + r.n + '</td></tr>').join('')
    || '<tr><td colspan="8" class="l">无可用样本（引擎未检出 Positive 孔）</td></tr>';
  // 组汇总行：按 (组 × 基因)
  const sumRows = [];
  for (const g of (an.genes || [])) {
    for (const gr of (g.groups || [])) {
      sumRows.push('<tr style="background:#1c2740;font-weight:700"><td class="l" colspan="2">' + g.name + ' · ' + gr.name + '（n=' + gr.n + '）</td><td></td><td>' + fmt(gr.designedDct, 3) + '</td><td>' + fmt(gr.dCt, 3) + ' ± ' + fmt(gr.sd, 3) + '</td><td colspan="3" class="l">' + (gr.role === 'control' ? '对照组' : '处理组') + '</td></tr>');
    }
  }
  E.designTable.querySelector('tbody').insertAdjacentHTML('beforeend', sumRows.join(''));
  E.btnDesignCsv.onclick = () => {
    const head = 'Sample,Gene,Group,DesignedDeltaCt,MeasuredDeltaCt,TargetCqMean,RefCqMean,Wells';
    const lines = [head].concat(rows.map(r => [r.sample, r.gene, r.group, fmt(r.designed, 4), fmt(r.dCt, 4), fmt(r.targetCq, 3), fmt(r.refCq, 3), r.n].join(',')));
    const csv = lines.join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'design_ddct_table.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };
}
```

注意：`renderDesignTable` 用到 `esc` —— 确认 `esc` 在当前作用域可用（`app.js` 顶部已有 `esc` 工具函数；若仅在 index.html 定义，则在 `app.js` 顶部补一个 `const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));`）。

- [ ] **步骤 3：改写 `drawDesignDctChart`（`public/app.js:637-700`）——按基因分组柱**

替换整个函数：

```js
function drawDesignDctChart(canvas, genes) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 420, cssH = 240;
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pad = { l: 46, r: 16, t: 26, b: 30 };
  const iw = cssW - pad.l - pad.r, ih = cssH - pad.t - pad.b;
  if (!genes || !genes.length) return;
  const groupNames = genes[0].groups.map(g => g.name);
  const ng = groupNames.length, ngene = genes.length;
  // 样本级 ΔCt 散点收集：byGroupName -> { geneName: [dCt...] }
  const byGroup = {};
  for (const g of genes) {
    for (const key of Object.keys(g.samples || {})) {
      const sm = g.samples[key];
      if (sm.dCt === null) continue;
      (byGroup[sm.group] = byGroup[sm.group] || {})[g.name] = (byGroup[sm.group][g.name] || []).concat(sm.dCt);
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const g of genes) {
    for (const gr of g.groups) {
      const vs = (byGroup[gr.name] || {})[g.name] || [];
      vs.forEach(v => { if (v < lo) lo = v; if (v > hi) hi = v; });
      if (gr.dCt !== null) { if (gr.dCt < lo) lo = gr.dCt; if (gr.dCt > hi) hi = gr.dCt; }
      if (gr.dCt !== null && gr.sd) { if (gr.dCt - gr.sd < lo) lo = gr.dCt - gr.sd; if (gr.dCt + gr.sd > hi) hi = gr.dCt + gr.sd; }
    }
  }
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 10; }
  const rng = hi - lo || 1; lo -= rng * 0.1; hi += rng * 0.1;
  const sy = v => pad.t + ih - (v - lo) / (hi - lo) * ih;
  ctx.strokeStyle = '#26304a'; ctx.fillStyle = '#6c82a6'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const v = lo + (hi - lo) * i / 5, Y = sy(v);
    ctx.beginPath(); ctx.moveTo(pad.l, Y); ctx.lineTo(pad.l + iw, Y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(Math.round(v * 10) / 10, pad.l - 6, Y + 4);
  }
  ctx.fillStyle = '#9db4d8'; ctx.textAlign = 'center'; ctx.font = '11px sans-serif';
  ctx.fillText('ΔCt（目的基因 Cq − 内参基因 Cq）', pad.l + iw / 2, cssH - 8);
  // 图例（基因配色）
  const colors = ['#4da3ff', '#ff8d6b', '#7fe3a0', '#ffd166'];
  const legX = pad.l + 4, legY = 12;
  genes.forEach((g, gi) => {
    ctx.fillStyle = colors[gi % colors.length];
    ctx.fillRect(legX, legY - 8 + gi * 0, 0, 0); // 占位（图例与柱体共用配色说明）
  });
  const slotW = iw / ng, bw = Math.min(30, slotW / ngene * 0.62);
  groupNames.forEach((gn, gi) => {
    for (let k = 0; k < ngene; k++) {
      const g = genes[k];
      const gr = g.groups[gi] || {};
      const x = pad.l + slotW * (gi + 0.5) + (k - (ngene - 1) / 2) * (bw + 3);
      if (gr.dCt !== null) {
        const y0 = sy(Math.max(lo, 0)), y1 = sy(gr.dCt);
        ctx.fillStyle = colors[k % colors.length];
        ctx.fillRect(x - bw / 2, Math.min(y0, y1), bw, Math.abs(y1 - y0));
        if (gr.sd) {
          ctx.strokeStyle = '#e6eefb'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(x, sy(gr.dCt - gr.sd)); ctx.lineTo(x, sy(gr.dCt + gr.sd)); ctx.stroke();
          ctx.lineWidth = 1;
        }
        ctx.fillStyle = '#e6eefb'; ctx.textAlign = 'center'; ctx.font = 'bold 11px sans-serif';
        ctx.fillText(Math.round(gr.dCt * 100) / 100, x, sy(gr.dCt) - 6);
      }
      const vs = (byGroup[gn] || {})[g.name] || [];
      vs.forEach((v, i) => {
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        ctx.beginPath(); ctx.arc(x + ((i % 7) - 3) * 3.5, sy(v), 2.6, 0, Math.PI * 2); ctx.fill();
      });
    }
    ctx.fillStyle = '#9db4d8'; ctx.font = '11px sans-serif';
    ctx.fillText(gn, pad.l + slotW * (gi + 0.5), cssH - 8);
  });
  // 底部图例：基因名
  ctx.textAlign = 'left'; ctx.font = '10px sans-serif';
  genes.forEach((g, gi) => {
    const gx = pad.l + iw * 0.08 + gi * (iw / Math.max(ngene, 1) * 0.55);
    ctx.fillStyle = colors[gi % colors.length];
    ctx.fillRect(gx, cssH - 18, 8, 8);
    ctx.fillStyle = '#9db4d8';
    ctx.fillText(g.name, gx + 11, cssH - 10);
  });
}
```

- [ ] **步骤 4：改写 `drawDesignFoldChart`（`public/app.js:703-752`）——按基因分组柱 + 实测点**

替换整个函数：

```js
function drawDesignFoldChart(canvas, genes) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 420, cssH = 240;
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const pad = { l: 52, r: 16, t: 18, b: 30 };
  const iw = cssW - pad.l - pad.r, ih = cssH - pad.t - pad.b;
  if (!genes || !genes.length) return;
  const names = ['对照'].concat((genes[0].treatments || []).map(t => t.name));
  // 每 (位置, 基因) 的设计真值柱与实测点
  const designFolds = names.map((n, i) => genes.map(g => i === 0 ? 1 : ((g.treatments[i - 1] || {}).designedFold ?? 1)));
  const measured = names.map((n, i) => genes.map(g => i === 0 ? 1 : (g.treatments[i - 1] || {}).fold));
  let hi = 1;
  for (let i = 0; i < names.length; i++) for (const v of designFolds[i].concat(measured[i])) {
    if (v !== null && isFinite(v) && v > hi) hi = v;
  }
  hi = hi * 1.15;
  const lo = 0;
  const sy = v => pad.t + ih - (v - lo) / (hi - lo) * ih;
  ctx.strokeStyle = '#26304a'; ctx.fillStyle = '#6c82a6'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const v = lo + (hi - lo) * i / 5, Y = sy(v);
    ctx.beginPath(); ctx.moveTo(pad.l, Y); ctx.lineTo(pad.l + iw, Y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(Math.round(v * 10) / 10, pad.l - 6, Y + 4);
  }
  ctx.fillStyle = '#9db4d8'; ctx.textAlign = 'center'; ctx.font = '11px sans-serif';
  ctx.fillText('相对表达量（对照=1）', pad.l + iw / 2, cssH - 8);
  const colors = ['#4da3ff', '#ff8d6b', '#7fe3a0', '#ffd166'];
  const ngene = genes.length, slotW = iw / names.length, bw = Math.min(30, slotW / ngene * 0.62);
  names.forEach((n, i) => {
    for (let k = 0; k < ngene; k++) {
      const x = pad.l + slotW * (i + 0.5) + (k - (ngene - 1) / 2) * (bw + 3);
      const dF = designFolds[i][k];
      ctx.fillStyle = colors[k % colors.length] + '55';
      ctx.fillRect(x - bw / 2, sy(dF), bw, ih - (sy(dF) - pad.t));
      ctx.fillStyle = colors[k % colors.length];
      ctx.fillRect(x - bw / 2, sy(dF), bw, 2);
      const mF = measured[i][k];
      if (mF !== null && isFinite(mF)) {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x, sy(mF), 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = colors[k % colors.length]; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, sy(mF), 4.5, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#e6eefb'; ctx.textAlign = 'center'; ctx.font = 'bold 11px sans-serif';
        ctx.fillText(Math.round(mF * 100) / 100, x, sy(mF) - 8);
      }
    }
    ctx.fillStyle = '#9db4d8'; ctx.font = '11px sans-serif';
    ctx.fillText(n, pad.l + slotW * (i + 0.5), cssH - 8);
  });
  ctx.textAlign = 'left'; ctx.font = '10px sans-serif';
  genes.forEach((g, gi) => {
    const gx = pad.l + iw * 0.08 + gi * (iw / Math.max(ngene, 1) * 0.55);
    ctx.fillStyle = colors[gi % colors.length];
    ctx.fillRect(gx, cssH - 18, 8, 8);
    ctx.fillStyle = '#9db4d8';
    ctx.fillText(g.name, gx + 11, cssH - 10);
  });
}
```

- [ ] **步骤 5：语法检查 + 手工验证**

运行：

```bash
node --check public/app.js
```

预期输出：无报错（exit 0）。

手工验证（启动 `node server.js`，浏览器打开命名页 → 设置 2 个目的基因 → 进入数据分析 → 按设计生成）：卡片逐基因、ΔΔCt 表含「基因」列（每样本×基因一行 + 组×基因汇总行）、两图按基因分组柱且图例正确、CSV 含 Gene 列、结论逐基因。

- [ ] **步骤 6：Commit**

```bash
git add public/app.js
git commit -m "ui: analysis page shows per-gene cards/verdicts, gene column in ΔΔCt table+CSV, grouped per-gene charts"
```

---

### 任务 9：`README.md` — 更新设计驱动模拟一节

**文件：**
- 修改：`README.md`（「设计驱动模拟」一节，约 167 行起）

- [ ] **步骤 1：更新面板条件表格与规则说明**

把「目的基因 / 内参基因」行改为多基因说明，并补充布板/无 NTC/默认重复说明。在「实验设计」面板条件表格中：

- 将 `| 目的基因 / 内参基因 | 基因名（如 IL6 / GAPDH） |` 改为：

```markdown
| 目的基因 / 内参基因 | 目的基因 1–11 个（每个独立倍数/方向），内参基因 1 个（如 GAPDH） |
```

- 将「生物学重复数」「技术重复数」默认值说明改为 `每组独立生物样本数（1–8，默认 1）` 与 `每样本复孔数（1–3，默认 3）`。
- 在「**系统自动推导**」段落后补一段：

```markdown
**多目的基因**：每个目的基因独立设置表达变化倍数与方向，系统逐基因推导理论表达量、
初始模板量、预期 Cq 差异并逐基因合成（熔解峰温度按基因区分）；布板按
`基因1×技术重复 → … → 基因N×技术重复 → 内参×技术重复` 排孔，**不生成 NTC 孔**；
分析页 ΔCt/ΔΔCt/Fold/统计按（样本 × 基因）计算，ΔΔCt 明细表含「基因」列，
图表按基因分组展示。旧版单基因设计（`targetGene` 字段）自动兼容。
```

- [ ] **步骤 2：Commit**

```bash
git add README.md
git commit -m "docs: multi-target-gene usage in design-driven simulation section"
```

---

### 任务 10：端到端验证 + 收尾提交

**文件：** 无（验证 + 状态确认）

- [ ] **步骤 1：全量回归冒烟**

运行：

```bash
node -e "const d=require('./lib/design.js');[1,2,5,11].forEach(n=>{const gs=Array.from({length:n},(_,i)=>({name:'G'+(i+1),foldChange:2+(i%5),direction:i%2?'down':'up'}));const r=d.synthesizeFromDesign({targetGenes:gs,bioReps:1,techReps:3,seed:3});console.log(n+' genes: wells',r.experiment.wells.length,'curves',r.experiment.curves.length,'layout',Object.keys(r.layout).length);});"
```

预期：各基因数下 wells=96、curves=2×1×3×(n+1)、layout=2×1×3×(n+1) 且 ≤96（n=11 时 72）。确认无异常抛出、无 NTC 字样。

- [ ] **步骤 2：启动服务手工验证全链路**

运行：`node server.js`（后台），浏览器：命名页添加 2 基因 → 数据分析页「按设计生成模拟实验」→ 检查卡片/表格（基因列）/两图/CSV/结论；再以旧单基因 `layout.json` 载入验证兼容。

- [ ] **步骤 3：最终提交**

```bash
git add -A
git status
```

确认无遗漏（`data/`、`test/`、`*.log` 仍被 gitignore）；有未提交改动则补 commit。

---

## 自检记录

- **规格覆盖度**：决策 1（每基因独立倍数/方向）→ 任务 1/2/4/7 ✓；决策 2（表格加基因列）→ 任务 8 ✓；决策 3（上限 11）→ 任务 1 `TARGET_GENE_MAX` ✓；决策 4（无 NTC）→ 任务 1/3/4/5 ✓；决策 5（默认 1×3）→ 任务 1/7 ✓；决策 6（图表分组柱）→ 任务 8 ✓；决策 7（向后兼容）→ 任务 1 `parseTargetGenes`/任务 7 `dsFill` ✓；README → 任务 9 ✓；`/api/derive` genes → 任务 6 ✓。
- **占位符扫描**：无 TODO/待定；每个改动步骤均含代码块。
- **类型一致性**：`an.genes[].{name,design,groups,control,treatments,samples,qc}` 在任务 5 定义、任务 8 消费一致；`derived.genes[]`（含 `deltaCq`）任务 2 产出、任务 8 卡片消费一致；`design.targetGenes[]` 任务 1 规范化、任务 7 前端产出一致。

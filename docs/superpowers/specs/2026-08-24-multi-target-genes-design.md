# 设计规格：孔板命名页支持多个目的基因

日期：2026-08-24
状态：已获用户批准（逐点确认后最终批准）

## 背景

「模拟实验设计」面板（96 孔板命名页入口）目前只支持 **单个目的基因**（`dsTarget`，默认 IL6）：
布板、合成、ΔCt/ΔΔCt/Fold 分析、分析页展示全部按"单一目的基因 + 一个内参基因"处理。
需求：目的基因支持**定义多个目标基因**，每个基因独立设置表达变化幅度（倍数/方向）。

## 决策记录（用户逐点确认）

| # | 决策 | 值 |
|---|---|---|
| 1 | 每个基因独立设置倍数/方向 | 是（推荐项，用户选择） |
| 2 | 分析页展示方式 | 保持现有报告样式，ΔΔCt 明细表**新增「基因」列**混排 |
| 3 | 基因数上限 | **11** 个 |
| 4 | NTC | **不生成**任何无模板对照孔（含 QC 中 NTC 检查一并移除） |
| 5 | 默认重复数 | **生物学重复 = 1、技术重复 = 3**（总 2 个样本：1 对照 + 1 实验） |
| 6 | 图表 | ΔCt 柱状图 / Fold 图改为**按基因分组柱**（x 轴仍为组别/处理，组内每基因一柱，带图例） |
| 7 | 向后兼容 | 保留 `design.targetGene`（= 第一个基因名）与 `refGene`；旧 `layout.json`（单基因）载入后自动转成单元素 `targetGenes` 列表 |

## 数据模型（lib/design.js）

- 新增 `design.targetGenes: [{ name, foldChange, direction }]`，长度 1–11。
- 每个基因：`name` 非空、去重（重复名自动去重，保留首个）；`foldChange` 钳制 1.5–20（沿用现有 LIMITS）；`direction` ∈ up|down。
- `targetGene` = `targetGenes[0].name`（兼容字段，随第一个基因同步）。
- `refGene` 保持单字符串。
- 默认值：`[{ name: 'IL6', foldChange: 4, direction: 'up' }]`，refGene GAPDH。

## 推导（deriveDesign）

- 逐基因计算：`deltaCq = ln(fold)/ln(1+E)`、`treatCq = CT_BASE ± deltaCq`（按方向）、初始模板量、理论表达量（对照=1，处理=fold 或 1/fold）。
- `theoryDct` 按基因：`{ control, treatment }`。
- `totalWells = groups × bioReps × techReps × (targetGenes.length + 1)`（**无 NTC**）。
- 超 96 孔 → 现有 `issues` 警告机制（提示减小重复数）。
- 返回结构新增 `genes: [{ name, foldChange, direction, deltaCq, treatCq, copies, expr, theoryDct }]`；顶层 `deltaCq/treatCq/theoreticalExpression/templateCopies` 保留（取第一个基因），供旧调用方不报错。

## 布板（buildLayout）

- 每生物样本按 `基因1×techReps → 基因2×techReps → … → 基因N×techReps → 内参×techReps` 依次排孔。
- 不生成 NTC 孔。
- 孔命名 target 字段 = 对应基因名（内参孔 = refGene）。

## 合成（synthesizeFromDesign）

- 每个生物样本对每个基因生成一个样本级 Cq（组基线 ± 该基因的 ΔCq + RT 波动 + 生物学个体差异），再按技术重复加移液误差/效率波动/仪器噪声/异常孔。
- 熔解峰温度按基因略区分（如 84.0 + 0.6×i，内参固定 86.5），保持 ΔCt 自洽与曲线可区分。
- `truth.gene` 记录具体基因名；真值表新增基因维度。
- NTC 相关分支、常量（`NTC_COUNT`）删除；导出 `toLc96p` 不再带 NTC 样本。

## 分析（analyzeDesign）

- 统计单元改为 **（样本 × 基因）**：每个（样本,基因）计算该基因靶孔 Cq 均值 − 内参孔 Cq 均值 = ΔCt。
- 组均值、ΔΔCt、Fold、Welch t / Cohen's d 全部按（基因 × 组/处理）分别统计。
- 输出新增 `gene` 维度：每个基因一组 `groups` / `treatments` / `samples`，字段形状沿用现有（前端改展示层）。
- 每组仅 1 个生物样本时 Welch t / Cohen's d 不可算 → 沿用现有 `>=2` 守卫，输出 `p: null / n.s.`。
- QC 统计移除 NTC 相关计数（异常孔计数保留）。

## 前端展示

### 命名页（public/index.html）

- 「目的基因」改为基因列表编辑器：每行 `基因名 + 倍数 + 方向(select) + 删除`，底部「+ 添加目的基因」，上限 11（到达上限按钮禁用）。
- 默认 1 行（IL6 / 4× / 上调）。内参基因输入框保持单值。
- `dsCollect()` 输出 `targetGenes: [{name, foldChange, direction}]`（并同步 `targetGene` = 首个基因名）；`dsFill()` 回填列表。
- 系统自动推导区改为按基因逐行显示；总孔数公式更新（无 NTC）。
- 默认重复数改为 bio=1、tech=3。

### 分析页（public/app.js / analysis.html）

- 卡片：「目的 / 内参基因」→ `基因1、基因2… / GAPDH`；每个处理组的 ΔCt / ΔΔCt / Fold / 统计卡片每基因一行。
- ΔΔCt 明细表：每行 = 样本 × 基因，表头新增「基因」列；组汇总行按（组 × 基因）分行；CSV 导出新增 `Gene` 列。
- ΔCt 图 / Fold 图：按基因分组柱（每组位置内每基因一柱，图例标注基因名，配色沿用现有 4 色循环 + 图例）。
- 结论（verdict）：逐基因逐处理组输出（真值 vs 实测偏差/显著性）。

## 文档

- `README.md`：更新「设计驱动模拟」一节，补充多目的基因说明（面板操作、布板规则、无 NTC、展示规则）。

## 范围外（YAGNI）

- 不为基因提供单独的内参基因（共享一个内参）。
- 不做每基因独立的组别结构（所有基因共用同一组别/重复设置）。
- 不引入基因 tab 切换（用户已选加列混排）。

## 验证

- `node -e` 冒烟：normalizeDesign / deriveDesign / buildLayout / synthesizeFromDesign（不跑引擎）/ analyzeDesign 的单元级断言（11 基因、2 基因、旧单基因兼容、重复名去重、超 96 孔警告、无 NTC 孔）。
- 浏览器手工验证：命名页面板增删基因、推导预览逐基因、保存/载入 layout.json（含旧单基因格式）、分析页卡片/表格/图表/CSV 多基因展示。

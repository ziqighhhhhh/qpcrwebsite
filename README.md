# qPCR Web — LightCycler 96 定性分析网页系统

把 **罗氏 LightCycler 96 原版 qPCR 分析引擎**（Kinetic 算法，`Roche.DP.CalcPack`）通过一个 **x86 Bridge** 封装成现代 Web 可调用的计算能力，围绕真实 `.lc96p` 数据提供完整的上传、分析、可视化与导出。

> 算法不重造：Cq / Slope / EPF 由原版引擎计算，结果与 LC96 软件**逐位一致**（已用官方演示数据验证 192/192 条曲线全部吻合）。
> Legacy 不扩散：x86 / ADF / CryptoAPI / DLL 等复杂性全部被 Bridge 隔离，用户只需要浏览器。

## 功能

- 上传 `.lc96p`（LightCycler 96 实验文件，ZIP 内包含 RDML 荧光数据）
- 一键 **Analyze**：调用原版 Kinetic 引擎计算每孔×通道的 Cq / Slope / EPF / 判定等 40+ 参数
- **左右对称双视图**（原始数据 vs 对照组），每侧 4 区与原软件 QualDetection 布局一致：
  1. Amplification Curves ｜ 扩增曲线（选中孔 + 多孔对比，左右联动）
  2. Combined Call Heat Map ｜ 综合判定热图
  3. Heat Map ｜ 孔板结果热图（Call / Cq / Slope / EPF 着色）
  4. Result Table ｜ 结果明细表（排序、勾选对比）
- **96 孔板热图**：按 Call / Cq / Slope / EPF 着色，点击孔位查看详情
- **扩增曲线**：选中孔 + 多孔对比叠加，曲线与 Cq 标记
- **通道切换**：FAM / Yellow555 等（由文件自动识别）
- **结果表**：排序、勾选对比、孔详情
- **导出**：CSV / JSON / Excel (XLSX)
- 数据单一事实来源：整个系统围绕一个 Experiment JSON 模型工作，所有视图与导出都从它派生

## 快速开始

### 环境要求
- Windows（引擎为 x86 .NET Framework）
- Node.js ≥ 16
- 罗氏 LightCycler 96 软件目录（含 `Bin`、`Gen-KA.adf`、`AlgorithmLibraries\Kinetic\...`）

### 运行（一键）

```bat
:: 1) 配置 config.json 中的 binDir 指向你的 LC96 软件 Bin 目录
:: 2) 双击 start.bat —— 自动检查 Node、自动编译缺失的 x86 Bridge、启动服务器、打开浏览器
start.bat
```

打开浏览器（或由 start.bat 自动打开）访问 `http://localhost:8080`，上传 `.lc96p`（如 DemoData 目录中的演示文件）→ Analyze → 查看结果 → 导出。

`start.bat` 会：
- 检查 Node.js 是否安装
- 若 `bridge\engine-bridge.exe` 缺失则自动调用 `bridge\build.bat` 编译（build.bat 从 config.json 自动读取 binDir，换机器只需改 config.json）
- 启动服务器并在 2 秒后自动打开浏览器
- 服务器重启后自动恢复上次实验（data/ 目录持久化）

手动方式：`bridge\build.bat` 编译 + `node server.js` 启动。

## 架构

```
┌──────────────────────────── 浏览器 (public/) ────────────────────────────┐
│ index.html · app.js · chart.js（原生 canvas，零依赖）                       │
│ 96 孔热图 / 扩增曲线 / 参数表 / 通道切换 / 多孔对比 / 导出按钮               │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ HTTP (JSON)
┌───────────────▼─────────────────── Node 后端 (server.js, 零依赖) ────────┐
│ 路由 · 上传解析 · Experiment 模型（唯一事实来源）· 持久化 data/*.json      │
│ lib/zip.js 手写 ZIP 读取 · lib/xml.js 手写 XML 解析 · lib/lc96p.js        │
│ lib/engine.js 调 Bridge · lib/export.js CSV/JSON/XLSX 生成                │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ stdin/stdout JSON（每分析任务一个进程）
┌───────────────▼──────────────── x86 Bridge (bridge/engine-bridge.cs) ────┐
│ x86 .NET Framework 控制台：读任务 JSON → 调 CalculationPackageService     │
│ （原引擎入口）→ 写结果 JSON。ADF 签名、CryptoAPI、DLL 加载全部在这层处理     │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ 程序集引用 + ADF 配置
┌───────────────▼──────────────── 原版引擎 (Bin\) ─────────────────────────┐
│ Roche Kinetic 1.5.3.1244 · Gen-KA.adf · nmath/LibMath 原生数学库          │
│ 输出: CT1(Cq) · MRS(Slope) · LC96 Normalized ERI(EPF) · 40+ 参数          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 关键映射（已反编译并验证）

| 界面/导出字段 | 引擎参数 | 说明 |
|---|---|---|
| Cq | `26 CT1` | 定量循环数（二阶导数/阈值法，见 CT Method） |
| Slope | `23 MRS` | 指数期最大相对斜率 |
| EPF | `78 LC96 Normalized ERI` | 终点荧光相对基线增量（归一化） |
| Call | `11 Intermediate Call` | 阳/阴判定 |
| 有效性 | `42 Validity Value` | 曲线拟合有效性 |
| SNR | `48 Signal To Noise` | 信噪比 |
| 扩增效率 | `49 Amplification Efficiency` | |
| 算法配置 | `analysis.adf` | 按染料自动选择：SYBR → `Sybr-KA.adf`，探针(FAM/Yellow555) → `Gen-KA.adf` |
| 最优模型 | `41 Optimal Model` | Model2/3/4 择优 |

## 数据模拟（对照组生成）

基于当前已上传并分析的真实实验作为**处理组**，一键生成**对照组** `.lc96p`（无需重复选数据）：

- **方法**：处理组阳性孔的真实扩增曲线整体右移 ΔCt 循环（基线区保持真实基线，曲线形状/噪声完全来自真实数据）；阴性孔保持无扩增
- **保证显著**：ΔCt 可调（3–12 循环，默认 8），两组 Cq 差异巨大 → 配对 t 检验 p < 0.001、Cohen's d > 3、表达倍数变化（如 1/218 下调）
- **完整流程**：对照组打包成标准 `.lc96p`，经原引擎完整分析，可下载、可加载到当前视图查看 96 孔板/曲线
- **统计对比**：配对 t 检验、Cohen's d、ΔCt、表达倍数变化、阳性率卡方、均值±SD 图
- **统计分析图**（生成对照组后显示）：
  - 相对表达量柱状图（对照=1，处理=2^(对照Cq−处理Cq)，误差线+显著性星号）
  - Cq 分布散点 + 箱线图（每个配对阳性孔一个点）
  - ΔΔCt 计算明细表（每孔 Cq→ΔCt→倍数，可导出 CSV）
- **熔解曲线**（SYBR 特异性，实验组真实 mdp 数据，选中孔+多孔对比）

教学场景呈现教科书式 qPCR 结论：处理组靶基因表达显著低于/高于对照组，质控形态真实（阴性孔无扩增）。

## 验证

对 `DemoData\Demo_Qual Detect Dual Color.lc96p` 全量验证：

- 192 条曲线 × (Cq/Slope/EPF/Call) 与 `.lc96p` 内存储结果**全部一致**（EPF 精确到 14 位小数）
- 引擎独立运行耗时约 1–2 秒/板
- 与 LC96 软件的一致性由 `calculated_data.xml` 中的历史结果交叉验证

## 设计取舍（第一性原理）

- **零 npm 依赖**：ZIP/XML/图表/XLSX 全部手写，离线可用、无供应链风险
- **单一事实来源**：Experiment JSON 模型是唯一数据源；上传→分析→视图→导出都只围绕它
- **进程隔离**：每个 Analyze 任务启动一个 Bridge 进程（约 1–2 秒开销），换来的是引擎黑盒不污染主进程、内存释放干净；后续可改为常驻进程池

## 注意事项

- 引擎为 **x86 32 位**，必须从 `binDir` 目录启动（Bridge 已自动处理）
- `Gen-KA.adf` 带 RSA 签名，需**保留空白**加载（Bridge 已处理）；不要修改 ADF
- 需要 Windows 上正常的 CryptoAPI 权限（沙箱/受限令牌下 ADF 签名校验会失败）
- 本工具用于学习与数据查看；商业/临床用途请遵循罗氏软件许可

## 文件结构

```
qpcrwebsite/
├── start.bat         # 一键启动（检查/编译/启动/开浏览器）
├── server.js          # 零依赖 HTTP 服务器 + API
├── config.json        # port / binDir / adf
├── bridge/
│   ├── engine-bridge.cs   # x86 引擎桥（原引擎封装）
│   └── build.bat          # 编译脚本
├── lib/
│   ├── zip.js         # 手写 ZIP 读取
│   ├── xml.js         # 手写 XML 解析
│   ├── lc96p.js       # .lc96p → Experiment 模型
│   ├── engine.js      # Bridge 客户端
│   └── export.js      # CSV / JSON / XLSX 导出
├── public/            # 前端（原生 JS + canvas 图表）
└── data/              # 实验持久化（gitignored）
```
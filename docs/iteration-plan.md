# 迭代功能清单 · Resource Scheduler

> 版本目标：`0.0.2` → `0.0.3`
> 维护说明：本文是产品迭代的单一事实来源（single source of truth）。第一档 / 第二档 / 横切为本周期**可执行**项；第三档 / 第四档**已记录，本期不启动**，仅供后续规划。
> 上线要求（Definition of Done）见文末「验证与上线标准」。

---

## 0. 设计原则（沿用 AGENTS.md）

1. 日历视图优先，新增功能不得明显挤压主日历区域。
2. 资源池、导入、导出、配置类能力放入抽屉或设置页。
3. 人员 / 项目 / 里程碑 三个对象必须保持 CRUD 完整。
4. 拖拽交互不得退化：人到日期、项目到日期、已有排期移动、里程碑移动。
5. 后端只用 Python 标准库（`http.server` + `sqlite3`）；前端原生 ES Modules，不引入框架/构建工具。
6. 不把真实业务数据写死到代码里。

## 1. 现状基线（决定优先级的关键约束）

- `state.js buildDates()` 写死 `today-1 ~ today+30`（32 天），**无法查看更远日期**。
- `api.js loadHolidays()` 走公网 CDN（jsdelivr），断网静默失败 → 节假日判定退化为「仅周末」。
- `panels.js renderStats()` 仅 6 个汇总数，无按维度拆分、无热力、冲突只能看数量不能定位。
- 删除 / 拖拽 / 编辑均**无撤销**，误操作直接覆盖数据。
- `.grid` `min-width:2980px`，**桌面专属**，移动端不可用。
- 全中文写死，无 i18n；无暗色模式；无键盘导航（仅 `Delete` / `Esc`）。

---

## 2. 第一档（P0 · 快速见效，本周期执行）

### F1.1 日期范围可配置 + 前后翻页 + 回到今天
- **目标**：突破固定 32 天窗口，支持按周/自定义范围前后翻页，并一键回到今天。
- **验收**：
  - 工具栏存在「上一段 / 下一段 / 今天」控件，点击后日历日期范围随之平移。
  - 日期范围标题 `rangeTitle` 实时反映当前窗口。
  - 视图切换（见 F2.x）与翻页正交，切换视图不丢失当前窗口。
- **验证**：`node --check` 通过；`/api/bootstrap` 不受影响；翻页后里程碑/排期渲染正确（逻辑自检 + 抓取 DOM 结构）。
- **文件**：`public/js/state.js`、`public/js/calendar.js`、`public/js/app.js`、`public/index.html`、`public/css/main.css`。

### F1.2 点击「冲突」统计跳转 / 高亮冲突格子
- **目标**：统计栏「冲突」数字可点击，点击后高亮所有当日超产能的人员/日期，再次点击取消。
- **验收**：点击冲突徽标 → 相关 `.cell` / bar 进入 `conflict-highlight` 态并滚动到第一个；提供「清除高亮」入口。
- **验证**：构造超产能数据，点击后 DOM 出现高亮类；`renderStats` 行为不退化。
- **文件**：`public/js/panels.js`、`public/js/calendar.js`、`public/js/interactions.js`、`public/css/main.css`。

### F1.3 节假日离线兜底
- **目标**：网络不可用或 CDN 失败时，仍能给出本年度节假日，避免「只有周末算休息」。
- **验收**：
  - 仓库内置 `data/holidays-<year>.json` 作为离线兜底；首次加载成功后写入本地缓存。
  - 新增 `GET /api/holidays?year=` 优先返回内置/缓存数据，无网络时仍可用。
  - `loadHolidays()` 顺序：内存缓存 → `/api/holidays` → CDN → 内置兜底。
- **验证**：断网情况下 `weekday/isDayOff` 对春节、国庆等仍返回正确；`curl /api/holidays`。
- **文件**：`public/js/api.js`、`server.py`、`data/holidays-*.json`。

### F1.4 删除 / 拖拽 / 编辑的撤销（Undo Toast）
- **目标**：误删、误移、误改后排期可在数秒内一键撤销。
- **验收**：
  - 删除人员/项目/排期/里程碑、移动/缩放排期、移动里程碑后，弹出「已 X · 撤销」toast，窗口期内点击可回滚到操作前快照。
  - 撤销栈最多保留 N（默认 8）步，只读模式禁用。
- **验证**：删除后点撤销 → 数据恢复且 UI 刷新；拖拽后撤销 → 回到原日期；`node --check` 通过。
- **文件**：`public/js/state.js`（新增 undo 栈）、`public/js/interactions.js`、`public/js/panels.js`、`public/js/api.js`。

### F1.5 筛选：部门 / 角色 / 项目 / 负责人
- **目标**：人员/项目多时，可按维度快速收窄日历可见行。
- **验收**：
  - 工具栏或抽屉提供筛选条件；命中条件后日历只渲染匹配行，统计随筛选范围联动。
  - 支持多选与「清空筛选」；与 F2.x 搜索可叠加。
- **验证**：筛选后行数与 `state.people/projects` 过滤结果一致；清空后恢复全量。
- **文件**：`public/js/calendar.js`、`public/js/panels.js`、`public/js/state.js`、`public/index.html`、`public/css/main.css`。

---

## 3. 第二档（P1 · 核心体验增强，本周期执行）

### F2.1 搜索（人员 / 项目 / 里程碑）
- **目标**：按名称快速定位实体并高亮。
- **验收**：搜索框输入 → 命中行高亮 + 自动滚动；无匹配给出空态提示；与筛选叠加。
- **验证**：输入已知名称命中，输入乱码无命中且不报错。
- **文件**：`public/js/calendar.js`、`public/js/panels.js`、`public/index.html`。

### F2.2 周 / 月 / 30 天视图切换
- **目标**：在「30 天」「按周（7 天，可翻页）」「按月（自然月）」三种密度间切换。
- **验收**：切换不丢失数据与当前焦点日期；月视图按自然月对齐；列宽与里程碑/排期渲染自适应。
- **验证**：三种视图切换后 `renderScheduler` 输出结构正确；翻页跨月正确。
- **文件**：`public/js/state.js`、`public/js/calendar.js`、`public/index.html`、`public/css/main.css`。
- **依赖**：F1.1。

### F2.3 统计增强：按项目 / 按人员拆分 + 负载热力
- **目标**：从汇总数升级为可下钻的维度统计与人员负载热力。
- **验收**：
  - 统计栏点击「负载/已分配」展开按项目/按人员工时分布（抽屉或浮层）。
  - 人员行日期格按当日负载率上色（热力：绿→黄→红）。
- **验证**：分布合计与汇总一致；热力颜色阈值与负载率计算一致。
- **文件**：`public/js/panels.js`、`public/js/calendar.js`、`public/css/main.css`。

### F2.4 里程碑「即将到期」高亮 + 倒计时
- **目标**：临近的里程碑视觉醒目，避免遗漏。
- **验收**：今天~N 天内的里程碑在日历/统计区高亮并显示「剩 X 天 / 已逾期 X 天」。
- **验证**：基于 `today` 计算，逾期与未到颜色区分正确。
- **文件**：`public/js/calendar.js`、`public/js/panels.js`、`public/css/main.css`。

### F2.5 冲突解决工作流
- **目标**：超产能不止「标红」，可一键尝试平摊 / 转移工时。
- **验收**：冲突格提供「平摊到相邻工作日 / 减少工时至产能上限 / 忽略」等动作，操作可撤销（F1.4）。
- **验证**：平摊后该人员当日不再超产能；转移目标合法（不越项目范围）。
- **文件**：`public/js/state.js`（纯计算：`splitPlanForDay`/`planReduceToCapacity`/`planSpreadToAdjacent`/`nextFreeWorkDay`）、`public/js/interactions.js`（右键菜单接入 + `applyConflictPlan` 应用与撤销）、`public/css/main.css`（菜单分隔线）。
- **实现说明**：右键人员视图的超产能格触发；多日排期按天拆分（仅调整冲突当天的工时，其余天保持不变）；平摊目标日优先选「加入后仍不超载」的工作日，且不越过贡献排期所属项目的结束日（满足服务端 `_validate_projectDates`）；撤销以「删除新建分片 + 恢复被删原值」实现。已知边界：解决按「当天」粒度，若同一条多日排期在多天都超产能，需逐格解决。

---

## 4. 横切（P1 · 体验 / 可达性，本周期执行）

### X1. 键盘可达性 / 导航
- 方向键在日历格子 / 任务条间移动焦点；`Tab` 顺序合理；焦点可见；关键控件带 `aria-label`；`Enter` 打开编辑、`Delete` 删除、`Esc` 关闭（已具备）。
- **文件**：`public/js/interactions.js`、`public/js/calendar.js`、`public/index.html`、`public/css/main.css`。

### X2. 移动端 / 响应式
- 窄屏下工具栏、统计、抽屉自适应；日历提供横向滚动 + 简化列；触控拖拽可用（pointer 事件已具备）。
- **文件**：`public/css/main.css`、`public/js/calendar.js`、`public/index.html`。

### X3. 暗色模式
- 主题变量化（`:root` → CSS 变量），提供「跟随系统 / 亮 / 暗」切换并持久化（localStorage）。
- **文件**：`public/css/main.css`、`public/js/app.js`、`public/index.html`。

### X4. 国际化 i18n（全量抽取）
- 引入 `public/js/i18n.js`（`t(key[, vars])` 插值助手 + zh/en 字典 + localStorage 切换）；抽取全部可见文案（工具栏/统计/视图/筛选/只读徽标/日历提示与表头/空态/右键/下钻/抽屉/设置/表单/toast/确认/撤销/拖拽提示/范围标题/主题按钮）；`index.html` 静态文案用 `data-i18n`，切换语言时 `applyStaticText()` 重应用；默认 zh。
- 优先级（高/中/低）、级别（important/risk）保持**规范数据值**，仅显示层本地化，避免数据随语言漂移。
- **文件**：`public/js/i18n.js`、各 `public/js/*.js` 文案点、`public/index.html`。

### X5. 指派百分比 / FTE 视图
- 在工时旁展示「占当日产能百分比 / FTE」，便于看分配比例。
- **文件**：`public/js/calendar.js`、`public/js/panels.js`。

### X6. 大数据量虚拟滚动
- 行/列过多时按可视区域窗口化渲染，降低 DOM 节点数。
- **文件**：`public/js/calendar.js`、`public/js/state.js`。

---

## 5. 第三档（P2 · 数据与集成 · 已记录，本期不启动）

> 以下为本周期**仅记录、不启动**的中期项，用于后续规划，不在本次 Agent teams 范围内。

| 编号 | 功能 | 价值 | 工作量 |
| --- | --- | --- | --- |
| P2.1 | iCal（.ics）导出 | 里程碑/排期进 Outlook/Apple 日历 | M |
| P2.2 | PDF / 打印友好导出 | 开会汇报免截图 | M |
| P2.3 | SQLite 备份 / 恢复 | 单文件数据库的误删退路 | S |
| P2.4 | CSV 导入去重 / 覆盖策略 | 避免重复导入 | M |
| P2.5 | 开放 REST API 文档 | 对接 BI / 外部系统 | S |

## 6. 第四档（P3 · 平台化 · 已记录，本期不启动）

> 长期项，**仅记录、不启动**。

| 编号 | 功能 | 价值 | 工作量 |
| --- | --- | --- | --- |
| P3.1 | 登录 / 权限 / 多用户 | 当前唯一分享是只读链接 | L |
| P3.2 | 操作审计 / 变更历史 | 排期变更可追溯 | M |
| P3.3 | 可编辑的多人协作 | 远程编辑需锁/合并 | L |
| P3.4 | 前后端模块拆分 + Docker | 现为单文件 `http.server` | M |

---

## 7. 验证与上线标准（Definition of Done）

本周期交付的每个特性必须满足以下全部条件方可视为「上线就绪」：

1. **语法/编译**：
   - 所有改动过的 `public/js/*.js` 通过 `node --check`。
   - `python3 -m py_compile server.py` 通过。
   - `./macos/build-mac-app.sh` 构建成功（Swift 编译无错）。
2. **服务烟测**：`python3 server.py` 启动后，`curl /api/bootstrap` 返回合法 JSON；新增接口（如 `/api/holidays`）可访问。
3. **功能自检**：每个特性按其「验证」项完成逻辑/结构自检并记录结果。
4. **回归不退化**：
   - 只读模式（`?readonly=1`）仍隐藏写入口、服务端拒绝写请求。
   - 拖拽（人到日期、项目到日期、排期移动/缩放、里程碑移动、资源排序）仍可用。
   - `Delete` / `Esc` / `Cmd+R` / 编辑菜单快捷键仍可用。
5. **macOS 原生 App**：构建产物可启动（冒烟：进程存活、菜单/`WKUIDelegate` 生效），本周期前端改动在 WebView 内同样可用。
6. **文档同步**：README 必要处同步；本文件勾选完成状态。

> 如某特性因工作量或风险无法在周期内达到 DoD，必须在交付报告中**显式标注**「部分完成 / 已铺基础 / 延后」，不得静默降级。

---

## 8. 执行编排（Agent teams）

本周期由按文件归属划分的 **7 个 Wave（串行为主，独立项并行）** 推进，避免共享核心文件（`state.js / calendar.js / panels.js`）的并行冲突：

| Wave | 范围 | 主要拥有文件 |
| --- | --- | --- |
| W1 | F1.1 + F2.2 + X2 基础（核心视图） | state/calendar/app/index/css |
| W2 | F1.5 + F2.1 + X6（筛选 / 搜索 / 虚拟滚动） | calendar/panels/state/index |
| W3 | F1.2 + F2.3 + F2.4 + F2.5（统计 / 冲突 / 里程碑） | panels/calendar/interactions |
| W4 | F1.4 + X1（撤销 / 可达性） | state/interactions/panels/calendar |
| W5 | F1.3 + X3（节假日离线 / 暗色模式） | api/server/data/css |
| W6 | X4 + X5（i18n / FTE） | i18n + 各 js / calendar+panels |
| W7 | 全量验证 + 回归 + 报告 | 只读校验、构建、烟测 |

每个 Wave 完成后必须自检（`node --check` / `py_compile`）并在结构化返回中汇报结果。

---

## 9. 本周期完成状态（2026-06-15）

### 验证结果（全部通过）
- ✅ 全量 `public/js/*.js` 通过 `node --check`。
- ✅ `python3 -m py_compile server.py` 通过；服务启动后 `/api/bootstrap`、`/api/holidays`、静态资源均 200。
- ✅ 只读回归：`X-Read-Only: true` 写请求 → 403；`?readonly=1` → `readOnly: true`。
- ✅ `./macos/build-mac-app.sh` 构建成功，Swift 类型检查无错。
- ✅ 纯逻辑（视图/筛选/搜索/里程碑/负载/撤销/冲突解决/多选筛选/月翻页/i18n 插值与语言切换/工作日本地化）经 Node 单元验证全部通过（冲突解决 19/19；修复回归 20/20；i18n+回归 17/17）。
- ✅ 级联撤销排序还原经端到端验证（删除中间人员 → 重建 + `/api/sort` 还原 → 回到原位，非追加末尾）。
- ✅ 全模块图 top-level 求值通过（DOM shim），捕获并修复了 1 个启动期 TDZ 崩溃（`app.js` 主题常量提前引用）。
- ✅ 独立 Agent Review（3 路对抗审查）复核：DoD 机械项全过、无 CRITICAL；审查发现的 3 处验收缺口（F2.5 数据健壮性、F1.5 多选、F1.4 级联撤销）+ 小项均已修复并回归。

### 特性完成度
| 特性 | 状态 | 说明 |
| --- | --- | --- |
| F1.1 日期范围翻页 + 今天 | ✅ 完成 | 30天/周/月 三模式 + ‹/今天/›；月翻页保留焦点日（月末钳制，Jan31→Feb28） |
| F1.2 冲突统计跳转/高亮 | ✅ 完成 | 点击冲突徽标切换高亮 + 滚动首个 |
| F1.3 节假日离线兜底 | ✅ 完成 | 内置 2026 JSON + `/api/holidays` + 三级回退链 |
| F1.4 撤销 | ✅ 完成 | 删除排期/里程碑、移动、缩放、移动里程碑、**人员/项目级联删除**均可撤销；级联回滚按新 id 重建子记录并**还原原排序**（删除前快照完整顺序，撤销时 `/api/sort` 还原原位，不追加到末尾）；各 undo 写入逐条 try/catch 隔离 |
| F1.5 筛选 | ✅ 完成 | **部门/角色多选**（复选下拉）+ 项目/负责人单选 + 统计联动 + 清空 |
| F2.1 搜索 | ✅ 完成 | 名称模糊匹配 + 行高亮 + **零命中空态**（区分「无数据」与「无匹配」） |
| F2.2 周/月/30天视图 | ✅ 完成 | 与翻页正交 |
| F2.3 统计拆分 + 热力 | ✅ 完成 | 按人员/项目下钻 + 人员负载热力（绿→红） |
| F2.4 里程碑到期高亮 | ✅ 完成 | 临近脉冲/逾期红 + 剩N天/逾期N天 |
| F2.5 冲突解决工作流 | ✅ 完成 | 右键冲突格「减少工时至产能上限 / 平摊到相邻工作日」；多日排期按天拆分；目标受项目结束日约束；可撤销；apply/undo 失败隔离 + best-effort 回滚（防不可逆丢数据） |
| X1 键盘可达性 | ✅ 完成（基础） | 方向键移动选中条并 `.focus()`、`:focus-visible`、排期条/里程碑 `tabindex`+`aria-label` |
| X2 响应式 | ✅ 完成（基础） | 窄屏折行/横向滚动；深度移动适配后续迭代 |
| X3 暗色模式 | ✅ 完成 | 自动/亮/暗 + localStorage + 跟随系统 |
| X4 i18n | ✅ 完成 | `t(key[, vars])` 插值 + zh/en 全量字典；已抽取全部用户可见文案（工具栏/统计/视图/筛选/只读徽标/日历提示与表头/空态/右键菜单/下钻/资源抽屉/设置/表单/toast/确认/撤销标签/拖拽提示/范围标题/主题按钮）；`data-i18n` 静态文案随语言切换；优先级/级别保持规范数据值（高/中/低、important/risk），仅显示层本地化 |
| X5 FTE/百分比 | ✅ 完成 | 排期条 + 编辑表单显示 FTE% |
| X6 虚拟滚动 | ✅ 完成（安全版） | `content-visibility:auto` 跳过屏外行绘制，DOM 保留故拖拽命中检测不受影响；完整窗口化（按需增删 DOM）仍延后（会破坏 DnD，违反 DoD） |

### 已记录但本期未启动
- 第三档（P2）：iCal 导出、PDF/打印、SQLite 备份/恢复、CSV 去重策略、开放 API 文档。
- 第四档（P3）：登录/权限、操作审计、可编辑协作、前后端拆分 + Docker。


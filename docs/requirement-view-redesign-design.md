# 需求视图改造设计（assignment-group → 需求一等对象）

| 项目 | 内容 |
| --- | --- |
| 版本 | 0.0.8（设计稿·独立评审 R1+R2 已并入） |
| 状态 | ✅ 已实现并通过验收（W1–W8 全波次 + 终验 DoD #1–#20）·可上线 |
| 关联 | 本地未提交的 `assignment-group` 功能（`server.py` 表结构/CRUD、`calendar.js` 聚合渲染、`panels.js` 排期弹窗）；体例沿用 `docs/settings-redesign-design.md` |
| 目标 | 把「需求」从一根只读聚合条升级为**一等可操作对象**：需求块可右键/双击/编辑；日历右键随视图切换语义（需求视图→新建需求）；需求选择器美化；未归组条作为"收件箱"把子任务归入需求；统一术语为「需求」。 |

---

## 1. 背景与目标

### 1.1 痛点
本地未提交的 `assignment-group` 功能，后端表结构与 CRUD 完整（增/改/删，删除时清空 `assignments.group_id`），但前端只做了**只读聚合展示**，出现六类摩擦：

1. **需求是「半成品对象」**：`calendar.js buildAssignmentGroups()` 按 `groupId` 聚合成 `parent-task` 虚线条，只遍历 `assignments`，空需求画不出来；`interactions.js` 中需求块 click/dblclick/pointerdown 全部提前 `return`（`L917-920 / L941 / L981`）→ 不能点、不能拖、不能编辑。
2. **问号光标误导**：需求块 CSS 是 `cursor: help`（`main.css:796`）→ 悬浮渲染成问号光标，配合 tooltip 形成「看得见摸不着」的体感。
3. **视图不对称**：`showCtxMenu`（`L591-619`）不读 `projectScheduleMode`，需求视图右键仍是「排期到人员」；`contextmenu` 只认 `.cell`（`L993-997`），需求块没有右键菜单。
4. **创建/编辑入口破碎**：需求选择器是原生 `<select>`（`panels.js:205/261`），塞在第 3 行和「总工时」挤在一起；新建需求走浏览器 `prompt()`（`panels.js:54`），无法填颜色/负责人/说明/周期。
5. **空需求无处安放 + 未归组是死胡同**：规划了周期但没排人的需求渲染不出来；一堆 `groupId=''` 的排期堆成虚拟条，却没有任何"把它们归类进需求"的出口。
6. **术语不统一**：视图按钮叫「需求」、表单 label 叫「任务集合」、后端叫 `assignment_group`。

### 1.2 目标
- **需求升为一等对象**，两个视图真正对称（§3）。
- 需求块：去问号光标；右键→新增任务/编辑/删除；双击→编辑；单击→选中（独立选中态，Delete 走需求删除）。
- 日历右键：需求视图下空白格入口为「新建需求」。需求表单内可选多人，为每人按需求周期追加一条排期；不选人则只保存需求。
- 两种需求条都可操作：**空需求**（虚影条，可新增任务/编辑/删）；**未归组**（收件箱，可勾选子任务归入需求）。
- **单一排期表单**（task/requirement 双模），需求选择器自定义、需求字段置顶，两视图共用。
- 全局术语统一为「需求」。

### 1.3 非目标
- 不改任务视图（`assignments` 模式）既有渲染与交互（右键仍「排期到人员」）。
- 不改资源池抽屉（`renderResourceBody`）。
- **不做独立的「需求管理面板」**：需求全部在日历上就地管理，日历是唯一展示面。
- 不重命名后端表/字段（`assignment_groups` / `group_id` 作为内部名保留），只统一**用户可见文案**。
- 不做需求拖拽排序（无管理面板）；`sort_order` 列保留作稳定排序兜底。
- 拖拽对称性（拖需求块整体平移、拖人 onto 需求块、拉伸需求周期）列为 **P1**，本期可选。

---

## 2. 决策摘要（已与需求方对齐）

| 分叉 | 选定方案 |
| --- | --- |
| 术语 | 全局统一叫 **「需求」**（保留 i18n key 名，仅改 value；英文 `Requirement(s)`） |
| 需求块光标 | `cursor: help`（问号）→ **`cursor: pointer`** |
| 需求条形态 | **两种**：空需求（真实 group、0 子任务、虚影条）+ 未归组（虚拟条、只有子任务、收件箱） |
| 创建模型 | 空白格右键为**新建需求**；既有需求块右键可「新增排期」。新增需求、编辑需求、新增排期均支持可选多人追加排期，不做隐式删除/覆盖。 |
| 命名需求块右键 | ＋ 为此需求新增任务（唤起排期）/ ✏ 编辑需求 / 🗑 删除需求 |
| 未归组块右键 | 🗂 将子任务归入需求…（勾选子任务 + 目标需求 现有/新建 → 批量改 groupId） |
| 日历右键语义 | `showCtxMenu` 读 `projectScheduleMode`：需求视图 → **「新建需求」** |
| 新建需求字段 | **完整字段**：只读项目 + 名称（必填）+ 颜色 + 负责人 + 说明 + 计划周期 + 可选排期明细列表（人员/开始/结束/工时公式） |
| **排期表单**（B1） | **合并为单一表单 `openAssignmentForm(opts)`**（task/requirement 双模），消除任务/需求两套表单分叉 |
| 需求选择器 | 原生 `<select>` → **自定义下拉**（复用 `custom-select`，颜色点 + 名称 + 子任务数 + 未归组 + ＋新建），表单内嵌共用 |
| 需求周期 | 新增可选 `startDate/endDate`；渲染：有子任务用 min/max，无子任务用自身周期（虚影条） |
| **空需求可见性**（B2） | **校验兜底**：编辑需求时，若当前无子任务，禁止清空计划周期（避免变不可见且无面板可找回） |
| 需求块选中态（A1） | **独立 `selectedGroupId`**，不污染 `selectedBarId`；Delete 键按"选中需求/排期"分别走删除 |
| 管理面板 | **不做**（日历就地管理） |
| 拖拽对称性（P1） | 本期可选 |

---

## 3. 信息架构

```text
需求视图日历
├─ 命名需求块（实条，有子任务）/ 空需求块（虚影条，0 子任务）
│  ├─ 悬浮 → tooltip（子任务 + 参与者 + 周期）
│  ├─ 单击 → 选中（selectedGroupId，高亮；Delete→删需求）
│  ├─ 双击 → 编辑需求
│  └─ 右键 →
│     ├─ ＋ 为此需求新增任务   → openAssignmentForm({mode:'requirement', lockedGroupId})  人员必填
│     ├─ ✏ 编辑需求           → openRequirementEditor(groupId)
│     └─ 🗑 删除需求          → confirm → DELETE（子排期降级为未归组，带 undo）
│
├─ 未归组块（虚拟条，只有子任务）
│  └─ 右键 / 双击 → 🗂 将子任务归入需求…
│        → 选择器：☑ 勾选该项目的未归组子任务  +  目标需求[现有 ▾ / ＋新建]
│        → 确认：批量 PUT 各 assignment.groupId = 目标（allSettled + undo）
│
└─ 空白格子（需求视图）
   └─ 右键 → ＋ 新建需求  → openRequirementEditor('', projectId, {date})
         （需求表单：项目只读展示 + 名称 + 颜色 + 负责人 + 说明 + 计划周期 + 可选多人追加排期）

任务视图：不变（右键格子 → ＋ 排期到人员 → openAssignmentForm({mode:'task'})，人员必填）
```

**心智模型**：需求视图主语是「需求」（由人填充）；空需求=规划了周期等人填的占位；未归组=收件箱，待归类。

---

## 4. 数据模型变更

### 4.1 `assignment_groups` 增加计划周期（必做）
表为本期新增（`server.py:460` 的 `CREATE TABLE IF NOT EXISTS`），建表语句加列，并补迁移块 guarded `ALTER`（兼容已建库）：

```sql
-- CREATE TABLE 增加：
start_date TEXT NOT NULL DEFAULT '',
end_date   TEXT NOT NULL DEFAULT ''
```

```python
# 迁移块（init_db，仿 end_date 的 guarded ALTER 写法）
group_columns = [r["name"] for r in cur.execute("PRAGMA table_info(assignment_groups)").fetchall()]
if "start_date" not in group_columns:
    cur.execute("ALTER TABLE assignment_groups ADD COLUMN start_date TEXT NOT NULL DEFAULT ''")
if "end_date" not in group_columns:
    cur.execute("ALTER TABLE assignment_groups ADD COLUMN end_date TEXT NOT NULL DEFAULT ''")
```

### 4.2 写入周期列（关键改动，R2 B-3 纠偏）
三处 `assignment_groups` 的 INSERT（`seed_from_initial_data` L357、`create_assignment_group` L1212、`import_csv` L1554）当前**都已显式列出列名**（`assignment_groups(id,…10 列) VALUES(…10×?)`）——经核验 `grep -E "INTO assignment_groups +VALUES"` **零命中**，即**没有真位置式 INSERT**。因此 `ADD COLUMN start_date/end_date` 迁移**不会让它们断裂**（显式列名 INSERT 对加列是稳健的）。真正要做的是：**把 `start_date,end_date` 追加进列清单 + 补对应占位符与参数**，使新建/种子需求能把周期写库。

| 位置 | 改动 |
| --- | --- |
| `seed_from_initial_data`（L357） | 列清单追加 `start_date,end_date` + 2 个 `?`；种子数据按需给周期（无则空串） |
| `create_assignment_group`（L1212） | 列清单追加 `start_date,end_date` + 2 个 `?`；参数取请求 `startDate/endDate` |
| `import_csv`（L1554） | **保持不变**（CSV 无周期列；DB 默认空串）——显式列名 INSERT 已稳健，不碰 |
| `update_assignment_group`（L1237） | UPDATE 加 `start_date=?,end_date=?`；**新增** `end>=start` 校验 |
| `bootstrap`（L729） | SELECT 加 `start_date AS startDate, end_date AS endDate` |

> ⚠️ 不要把"显式列名 INSERT"误当"位置式"。`settings-redesign-design.md §4.2` 的坑针对的是**无列名的真位置式** INSERT；此处三处本就有列名，不踩那个坑。DoD #3 的 grep 是**回归守卫**（防日后退化成无列名形式）；真正"是否写入了周期"由 DoD #3b 的往返校验断言。

### 4.3 校验
- 名称必填、非空；同项目内允许重名（前端去重返回既有 id，沿用现逻辑）。
- 计划周期：`end_date >= start_date`（二者任一为空则不校验）。**校验落点（评审补）**：`_validate_assignment_group`（L1191）只校验归属项目、不校验日期；`end>=start` 在 `create/update_assignment_group` 内显式比较。
- **周期 vs 项目范围（评审补 M5）**：需求计划周期**不**校验是否落在项目 `[start,end]` 内（规划阶段可能早于/晚于档期）；但挂在需求下的**排期仍走 `create/update_assignment → _validate_project_dates`**（L1260/1281）。故「新建需求 + 人员」保存路径存在**孤儿风险**——建群成功但建排期 400（日期越界）会残留空需求；必须**先校验项目范围再建群，或建排期失败时回滚刚建的群**（见 §7.1）。
- 需求归属项目：`create/update_assignment_group` 已校验 `project_id` 存在；删除时清空引用子排期的 `group_id`（已实现，`server.py:915` 清空 / `L916` 删群行，路由块 L913-919）。
- **统一表单人员规则（单一）**：仅当 `mode=requirement 且 选择=＋新建需求` 时人员可空（=创建空需求）；其余一律必填（task 模式、未归组、既有需求、`lockedGroupId`）。
- **空需求可见性校验（B2）**：`openRequirementEditor` 保存时，若该需求**当前无子任务且周期被清空** → 阻止，提示"该需求暂无子任务，需保留计划周期以在日历显示"。

> 本期不扩展 `bulk_sort` 白名单（无管理面板、无拖拽排序）。`sort_order` 列保留作稳定排序兜底。

### 4.4 状态层
`state.js` 已有 `assignmentGroup(id)` / `assignmentGroupsForProject(projectId, includeArchived)`。新增：
```js
export function requirementIsVisible(group)        // 有子任务 OR 有计划周期
export function requirementSpan(groupId)           // 有子任务→min/max；无→自身周期
export function ungroupedAssignmentsOf(projectId)  // groupId='' 的排期
export function requirementMatches(group)          // 空需求搜索谓词（名/负责人/项目，见 §5）
export let selectedGroupId = null                  // 需求块独立选中态（A1）
export function setSelectedGroupId(id)
export function selectRequirement(groupId)         // 设选中、清 selectedBarId/selectedMilestoneId、高亮
```

---

## 5. 需求条形态与渲染规则

需求视图日历上有**两种需求条**：

| 形态 | 本质 | 渲染 | 交互 |
| --- | --- | --- | --- |
| **命名需求块**（实条） | 真实 group，有子任务 | 实色条；周期优先用自身 `start/end`，否则子任务 min/max | 单击选中；右键 新增任务/编辑/删；双击编辑 |
| **空需求块**（虚影条） | 真实 group，0 子任务 | `.parent-task.empty`：hatched 背景 + 降透明度；周期取自身 `start/end` | 同上 |
| **未归组块**（虚拟条） | `groupId=''` 聚合，非实体 | 实条（沿用现状聚合） | 右键/双击「将子任务归入需求」；不可删 |

**渲染逻辑**（`calendar.js buildAssignmentGroups` 改造）：
- 当前只遍历 `assignments`。改为：从 `assignmentGroupsForProject(projectId)` 拿全部需求，**`requirementIsVisible` 为真（有子任务或有周期）的都建条**；再追加未归组虚拟条。
- 0 子任务 + 有周期 → 虚影条；有子任务 → 实条，周期优先自身、否则子任务 min/max。
- **空需求角标（评审补 M8）**：`buildAssignmentGroups` 当前**无条件**输出 `child-count` 角标与 `tip.children N`（`calendar.js:231-232`）；空需求 `assignments.length===0` 会渲染显示「0」的角标 → **0 子任务时不渲染 `child-count`**，tooltip 改用需求自身周期/负责人，不写「子任务 0」。
- **未归组标签（评审补 M7）**：未归组块标签**复用现成 `t('task.ungrouped')`**（已用于 `interactions.js:181` tooltip 与 `calendar.js:98` 渲染），**不新增 i18n key**；如需更短文案改其 value 即可。
- **可见性/搜索过滤（A3）**：需求条用 `requirementMatches` 过滤（按需求名/负责人/项目命中搜索词；空需求无 assignment，不能用 `assignmentMatches`）；并按 `requirementSpan` 与可视日期窗口求交（等价 `rangeVisible`）。命中搜索词为空时常驻。
- lane 计算复用 `computeAssignmentLanes`，虚影条同样占 lane。

**CSS**（`main.css`）：
```css
.assign.bar.parent-task { border-style: dashed; cursor: pointer; }   /* help → pointer */
.assign.bar.parent-task.empty { /* hatched 背景、降透明度 */ }
.assign.bar.parent-task.selected { /* 独立高亮，区别于 assignment.selected */ }
```

---

## 6. 交互：选中态 + 右键菜单 + 视图切语义 + 未归组归入

### 6.1 需求块选中态（A1）
当前 `selectedBarId` 是 assignment 专属，Delete 键（`interactions.js:826`）与方向键（`L889`）都假设它是 assignment id。若复用会让 Delete 调 `deleteAssignment('ag_...')` → 404、方向键失效。

→ **独立选中态**：
- 新增 `selectedGroupId` + `selectRequirement(groupId)`（`state.js`）。
- **`selectedGroupId` 存「原始 groupId」**（无 `ag_` 前缀；即 `DELETE /api/assignment-groups/:id` 的 id）。⚠️ 区分三种 id（评审补 M3/M4）：逻辑 id `a.id = ag_<key>`、DOM 元素 id `bar_${a.id}`（命名块 `bar_ag_<groupId>`；未归组 `bar_ag_<projectId>::__ungrouped`，含 `::`，`getElementById` 脆弱）、原始 groupId。**选中态/删除一律用原始 groupId**；DOM 定位（高亮/菜单）一律走 `data-group-id` 属性（`calendar.js:230` 已有），**不靠元素 id**。未归组块 `data-group-id=''` 天然不进选中。
- click 处理：`.parent-task`（`data-group-id` 非空）→ `selectRequirement(groupId)`；未归组块 → 不选中（仅可右键/双击）。高亮通过 `document.querySelector('.parent-task[data-group-id="…"]')` 加 `.selected`。
- `selectRequirement` 与 `selectBar`/`selectMilestone` **互斥**（选中需求时清排期/里程碑选中，反之亦然）。
- **Delete 键路由**（`interactions.js:826`）：`if (selectedGroupId) deleteRequirement(...) else if (selectedBarId) deleteAssignment(...) else if (selectedMilestoneId) deleteMilestone(...)`。
- **Escape**（`L844`）：增加清 `selectedGroupId`。
- **方向键（评审补 N1）**：仍只作用于 `selectedBarId`；选中需求时 `selectRequirement` 已清 `selectedBarId`，方向键 handler（`L889`，`if (!selectedBarId) return`）**静默无操作**——这是**预期**（需求以点击/右键为主，不参与方向键），非 bug。
- **`deleteRequirement(id)` + undo（评审补 M6；R2 B-1/B-2/B-4/B-5 精化）**：DELETE 需求的副作用是**破坏性**的——路由层先 `UPDATE assignments SET group_id='' WHERE group_id=?`（`server.py:915`）再删群行（`L916`），子排期归属被清空、群行被删。仅"重建群（拿新 id）"无法恢复归属（旧 id 已不存在、子排期 group_id 已空）。
  - **删前快照**：`const childIds = state.assignments.filter(a => a.groupId === id).map(a => a.id)`——**仅需 id 列表**（归属用 undo 时重建群的新 id，不必存原 groupId）；快照闭包捕获进 `pushUndo` 的 `run`，`del()` 后立即 `load`。
  - **`{n}` 同源（B-5）**：`confirm.deleteRequirement` 的 `{name}`=group.name、`{n}`=childIds.length，与快照同一次遍历，避免重复读取。
  - **undo 还原**：先重建群取新 id，再对 `childIds` 逐条 `PUT /api/assignments/:id {groupId: 新id}` 回填归属。
  - **⚠️ 区别于 `deletePerson`（B-1）**：人员 DELETE **级联删行** → undo 用 `POST` 重建排期；需求 DELETE **只清 `group_id` 不删行** → undo 用 `PUT` 回填归属、**不重建排期**。**不要照搬 `deletePerson` 的 POST 重建**，否则会产生重复排期。
  - **不能**"按旧 id 回填 group_id"（旧 id 已删、子排期 group_id 已被清空）。

### 6.2 需求块解除只读（`interactions.js`）
去掉对 `.parent-task` 的提前 `return`（`L917-920 / L941 / L981`）：
- 单击 → `selectRequirement`（§6.1）。
- 双击 → 命名/空需求块→`openRequirementEditor(groupId)`；未归组块→`openRegroupPicker(projectId)`。
- pointerdown：P0 仍 `return`（**确保不误启 assignment 的 move/resize**）；P1 启用整体拖拽。
- `contextmenu` 监听扩展：命中 `.parent-task` 时走需求块菜单。

### 6.3 右键菜单（`showCtxMenu` 增 `parentTask` 分支）
⚠️ **单一 `contextmenu` handler 优先级链（评审补 M2）**：`.parent-task` 在 `.cell` 内部，`e.target.closest('.cell')` 对右键需求块也会命中——若不拦截，需求块右键会同时触发"格子菜单"。handler 必须按序：**先 `e.target.closest('.parent-task')`**（取 `data-project-id`/`data-group-id`，date 取最近 `.cell` 的 `data-date`）→ 命中即走需求块菜单并 `return`；**否则**才进 `.cell` 分支。另：`interactions.js` 当前**未 import `projectScheduleMode`**（§6.4 需要），W6 起补 import。

命中 `.parent-task` 后的菜单：

| 右键位置 | 菜单 | 动作 |
| --- | --- | --- |
| 命名/空需求块 | ＋ 为此需求新增任务 | `openAssignmentForm({mode:'requirement', projectId, lockedGroupId, date})` 人员必填 |
| 命名/空需求块 | ✏ 编辑需求 | `openRequirementEditor(groupId, projectId)` |
| 命名/空需求块 | 🗑 删除需求 | confirm → DELETE（带 undo） |
| 未归组块 | 🗂 将子任务归入需求… | `openRegroupPicker(projectId)` |

### 6.4 日历右键随视图切语义
`showCtxMenu(e, view, rowId, date)` 在 `view === 'project'` 分支读 `projectScheduleMode`：
```js
if (view === 'project') {
  if (projectScheduleMode === 'parentTasks') {
    items.push({ label: t('ctx.addAssignRequirement'), action: () => openRequirementEditor('', rowId, { date }) });
  } else {
    items.push({ label: t('ctx.addAssignPerson'), action: () => openAssignmentForm({mode:'task', projectId:rowId, date}) });
  }
  items.push({ label: t('ctx.addMilestone'), action: () => openAddMilestone(rowId, date) });
}
```
需求视图空白格入口直连 `openRequirementEditor('', projectId, {date})`。

### 6.5 未归组「收件箱」归入（P0-D）
`openRegroupPicker(projectId)`（未归组块右键 / 双击）：
```
将子任务归入需求 · <项目名>
┌──────────────────────────────────────┐
│ ☑ 云飞  7/2~7/3   8h                 │  ← groupId='' 排期，多选
│ ☑ 文龙  7/4        8h                 │
│ ☐ 卫帅  7/5~7/7  16h                 │
├──────────────────────────────────────┤
│ 归入：[现有需求 ▾ / ＋新建需求]       │
└──────────────────────────────────────┘
   [取消]                       [归入]
```
- 确认 → 对每个勾选 assignment `PUT /api/assignments/:id { groupId: 目标 }`；目标=新建则先建需求。
- `pushUndo`（记录 before groupId，undo 还原）；`Promise.allSettled` 汇总。
- **projectId 取自未归组块所在项目，不允许跨项目归入**（与不变量 #1 一致；新建目标群用同一 projectId）。
- **新建目标群不走 §7.1 的项目范围预校验（R2 B-7）**：被移动排期日期/归属项目不变、仅 `group_id` 变；picker 新建群只做名称必填 + `end>=start`（若允许设周期），不校验项目档期。
- 只读模式拦截写操作；查看放行。

---

## 7. 统一排期/创建表单与需求选择器（B1 合并）

### 7.1 单一表单 `openAssignmentForm(opts)`
**合并**任务视图的 `openAddAssignment`/`openAssignment` 与需求视图的排期/创建，为**一个表单 + mode**，消除两套表单分叉。opts：`mode:'task'|'requirement'`、`id?`（编辑既有排期）、`personId, projectId, date`、`groupId`（预选）、`lockedGroupId`（锁定需求）。

入口映射：
| 入口 | 调用 |
| --- | --- |
| 任务视图 右键格子「排期到人员」 | `openAssignmentForm({mode:'task', projectId, date})` |
| 任务视图 双击编辑排期 | `openAssignmentForm({mode:'task', id})` |
| 需求视图 右键格子「新建需求」 | `openRequirementEditor('', projectId, {date})` |
| 需求视图 需求块右键「新增任务」 | `openAssignmentForm({mode:'requirement', projectId, lockedGroupId, date})`（**人员必填**，既有需求、非"＋新建"路径） |

表单字段（**单一日期范围字段**，语义随选择变化）：
```
┌─ 项目 ──────────────────────────────┐
├─ 需求  ● 名称 · N人           ▾   ┤  自定义选择器：现有 / ＋新建需求 / 未归组
│    （选「＋新建需求」→ 该区行内展开：名称* 颜色 负责人 说明）
├─ 开始 ── 结束                      ┤  语义见下
├─ 排期明细列表：人员 / 开始 / 结束 / 工时公式 │
└─ 备注 ──────────────────────────────┘
```

**日期字段语义**：选了人员 → 排期日期范围；选择=＋新建需求 → 同时作为新需求计划周期；空需求（无人员+新建）→ 即需求周期。

**人员规则（单一，§4.3）**：新增排期创建态可多选人员，每人生成一条排期；编辑单条排期仍单选。仅当 `mode=requirement 且 选择=＋新建需求` 时人员可空（=空需求）；其余一律至少选择 1 人。

**保存语义**：
- 选择=未归组 → 人员必填；创建态可多选，逐人 `POST /api/assignments {groupId:''}`；编辑态单条 `PUT`。
- 选择=既有需求 + 人员 → 创建态可多选，逐人 `POST /api/assignments {groupId}`；编辑态单条 `PUT`。
- 选择=＋新建 + 人员 → **先校验日期落在项目 `[start,end]`**（否则建排期时 `_validate_project_dates` 会 400），通过后 `POST /api/assignment-groups`（周期=日期范围）取 id，再逐人 `POST /api/assignments {groupId:id}`；**若建排期失败必须回滚刚建的群和本次已建排期**，避免孤儿空需求（评审补 M5）。
- 选择=＋新建 + 无人员（仅 requirement 模式）→ 只 `POST /api/assignment-groups`（=空需求）。
- 编辑既有排期（`id`）→ `PUT`；切项目时（C2）需重置需求选择并清 `groupId`。
- **回滚群的 `DELETE` 不入 undo 栈（R2 B-6）**：「新建+人员」建排期失败、回滚刚建的群时，用户视角无成功操作可撤销，故该回滚 `DELETE` 不 `pushUndo`。

### 7.2 需求编辑表单 `openRequirementEditor(groupId, projectId)`
**新建/编辑需求自身字段**（名称/颜色/负责人/说明/计划周期），来自空白格「新建需求」、右键「编辑需求」/ 双击需求块。表单底部提供可选排期明细列表：一行一个人，每行独立填写开始、结束和工时公式（如 `8*d` 或 `40`）；备注自动使用需求名称。编辑需求时只追加本次填写的排期，不隐式删除或覆盖既有子排期。
- **B2 校验**：保存时若该需求**当前无子任务且周期被清空** → 阻止（§4.3）。
- 名称去重保留（同名复用，沿用现逻辑）。
- 删除需求 `pushUndo` 用**删前快照**（删前读出子排期完整记录；undo 重建群取新 id + 逐条 `PUT` 回填 groupId），详见 §6.1（评审补 M6；**不可**"按 id 回填 group_id"——旧 id 已删、子排期 group_id 已被清空）。

### 7.3 自定义需求选择器（共享组件，复用 `custom-select`，`main.css:1369`）
每项带颜色点 + 名称 + 子任务数；含「未归组」「＋ 新建需求…」两行。`openAssignmentForm` 内嵌使用；切项目刷新选项并清空选择（C2，沿用 `bindAssignmentCandidateRefresh` 钩子 `panels.js:187`）。

> **C1 实现注意**：现有 `custom-select`（团队选择器）是页面级、绑在 `app.js:285`。需求选择器在 modal 内，需独立做开启/关闭与 outside-click 关闭，且同时只允许一个 `custom-select` 打开。

---

## 8. 不变量与边界

| # | 不变量/边界 | 说明 |
| --- | --- | --- |
| 1 | **需求归属项目** | `assignment_group.project_id` 不可跨项目；排期改项目时 `groupId` 清空（`dropOnCell`/`finishMoveAssignment` 已做；表单切项目也清，C2）。 |
| 2 | **删需求不清子排期 + undo 快照** | DELETE 清空引用子排期 `group_id`（降级为未归组），不删排期。归属被破坏性清空，故 undo 必须**删前快照**子排期完整记录（M6，§6.1）。 |
| 3 | **空需求可见性（B2）** | 有周期即渲染；无周期且无子任务不渲染。**编辑时禁止把无子任务需求的周期清空**，避免孤儿。 |
| 4 | **未归组是虚拟条** | `groupId=''` 聚合，非实体；不可删，只能"归出"。 |
| 5 | **统一表单人员规则** | 仅 `mode=requirement + ＋新建` 可不选人=空需求；其余必填。 |
| 6 | **需求选中态独立（A1）** | `selectedGroupId` 与 `selectedBarId` 互斥；Delete 按选中类型路由（需求→删需求，排期→删排期）。 |
| 7 | **空需求搜索（A3）** | 需求条用 `requirementMatches` 过滤，不混入 `assignmentMatches`。 |
| 8 | **任务视图不变** | assignments 模式渲染/拖拽/缩放/右键不退化；右键仍「排期到人员」（`mode:'task'`）。 |
| 9 | **只读模式** | 需求块右键/双击/归入/表单写操作全部 `isReadOnlyMode()` 拦截；tooltip/列表查看放行。 |
| 10 | **术语** | 用户可见统一「需求」；表名/字段名/i18n key 名不动。 |
| 11 | **视图门控（评审补 M1）** | 所有需求条形态/交互（空需求虚影条、未归组收件箱、需求块右键/双击/选中）**仅在 `projectScheduleMode==='parentTasks'`（需求视图）下出现**；任务视图（默认）下不渲染需求条、右键仍「排期到人员」。 |
| 12 | **周期 vs 项目范围（评审补 M5）** | 需求计划周期**不**校验项目范围；挂其下的排期**仍**校验（`_validate_project_dates`）；「新建需求 + 人员」保存需防孤儿（先校验项目范围，或建排期失败回滚群）。 |

---

## 9. 影响面清单

### 9.1 后端 `server.py`
| 位置 | 改动 |
| --- | --- |
| `init_db`（~L460） | `assignment_groups` 建表加 `start_date/end_date`；迁移块 guarded `ALTER` |
| `seed_from_initial_data`（L357） | 列清单追加 `start_date,end_date` + 占位符（本就显式列名、对加列稳健；详见 §4.2） |
| `bootstrap`（~L729） | `assignmentGroups` 返回 `startDate/endDate` |
| `create_assignment_group`（L1212） | 显式列名 + `start/end_date` |
| **`import_csv`（L1554）** | **评审补 B1**：第三处 INSERT **保持不变**（本就显式列名、CSV 无周期、DB 默认空串；详见 §4.2） |
| `update_assignment_group`（L1237） | UPDATE 加 `start_date=?,end_date=?`；**新增** `end>=start` 校验（`_validate_assignment_group` 不校验日期） |
| `_validate_assignment_group`（L1191） | 已存在，复用（只校验归属项目 + archived；**不**校验日期） |

### 9.2 前端
| 位置 | 改动 |
| --- | --- |
| `calendar.js` | `buildAssignmentGroups` 渲染空需求（虚影条）+ 未归组；周期优先级；`requirementMatches`/`rangeVisible` 过滤（A3）；**0 子任务不渲染 `child-count` 角标**、tooltip 用自身周期/负责人（M8） |
| `interactions.js` | `selectedGroupId`/`selectRequirement` 接入（A1）；Delete/Escape 路由；`showCtxMenu` 读 `projectScheduleMode` + parentTask 菜单；解除 parent-task 提前 return；`contextmenu` 监听扩展 |
| `panels.js` | **`openAssignmentForm`（合并，B1）取代 `openAssignment`/`openAddAssignment`/`openRequirementForm`**；`openRequirementEditor`（含 B2 校验）；`openRegroupPicker`；`requirementSelectHTML`/`bindRequirementSelect`；删 `assignmentGroupOptions`/`resolveAssignmentGroupSelect` 的 `prompt()` |
| `state.js` | `requirementIsVisible`/`requirementSpan`/`ungroupedAssignmentsOf`/`requirementMatches`；`selectedGroupId`/`setSelectedGroupId`/`selectRequirement` |
| `app.js` | 右键/双击/Delete 委托接入；术语刷新 |
| `i18n.js` | 新文案（§12）；`label.assignmentGroup` value 改「需求」；删死键 `prompt.assignmentGroupName`/`option.newAssignmentGroup` |
| `main.css` | `.req-select` / `.parent-task.empty` / `.parent-task.selected` / `.regroup-picker` / `.color-swatches` |
| `index.html` | 一般无改动（组件动态渲染） |

---

## 10. API（复用为主，最小新增）

| 操作 | 方式 | 备注 |
| --- | --- | --- |
| 新建需求 | `POST /api/assignment-groups {projectId,name,color,ownerId,description,startDate,endDate}`；可选随后批量 `POST /api/assignments` | 需求先建，排期逐条追加，失败回滚本次新增 |
| 编辑需求 | `PUT /api/assignment-groups/:id` | 现成，加 start/end |
| 删除需求 | `DELETE /api/assignment-groups/:id` | 现成，清空引用 group_id |
| 排期挂需求 | `POST/PUT /api/assignments {groupId}` | 现成 |
| 子任务归入需求 | 前端循环 `PUT /api/assignments/:id {groupId}` | `allSettled` 汇总；不改后端 |

> **无需新增端点**。归入、空需求创建、统一表单均通过复用现成接口完成。

---

## 11. 前端模块改动概览

| 模块 | 主要改动 |
| --- | --- |
| `panels.js` | **合并单一排期表单 `openAssignmentForm`（B1）**；需求编辑表单（B2 校验）；归入选择器；自定义需求选择器；统一术语 |
| `interactions.js` | 需求独立选中态 + Delete/Escape 路由（A1）；右键菜单（命名块/未归组/格子 + 切语义）；需求块解除只读 |
| `calendar.js` | 空需求 + 虚影条 + 未归组渲染；周期优先级；搜索过滤（A3） |
| `state.js` | 渲染/归入/搜索辅助 + 选中态（A1） |
| `app.js` | 事件委托接入；术语刷新 |
| `i18n.js` | 新文案 + 死键清理 |
| `main.css` | 选择器/虚影条/选中态/归入/色板样式 |
| `server.py` | §9.1（周期列贯通） |

---

## 12. i18n 新增文案（zh/en）

```
label.requirement          需求 / Requirement          （label.assignmentGroup 的 value 改此，key 保留）
# 未归组标签复用现成 task.ungrouped（评审补 M7，不新增 label.ungrouped）
label.requirementOwner     负责人 / Owner
label.requirementColor     颜色 / Color
label.requirementDesc      说明 / Description
label.requirementPeriod    计划周期 / Planned period
option.newRequirement      ＋ 新建需求… / + New requirement…
title.newRequirement       新建需求 / New requirement
title.editRequirement      编辑需求 / Edit requirement
title.regroupChildren      将子任务归入需求 / File tasks into requirement
ctx.addAssignRequirement   ＋ 新建需求 / + New requirement
ctx.addTaskToRequirement    ＋ 为此需求新增任务 / + Add task to requirement
ctx.editRequirement        ✏ 编辑需求 / Edit requirement
ctx.deleteRequirement      🗑 删除需求 / Delete requirement
ctx.regroupChildren        🗂 归入需求 / Assign to requirement
confirm.deleteRequirement  删除需求「{name}」？其下 {n} 条排期将变为未归组（不会被删除）。
confirm.deleteRequirementEmpty  删除需求「{name}」？
toast.savedRequirement     已保存需求 / Requirement saved
toast.deletedRequirement   已删除需求 / Requirement deleted
toast.regrouped            已将 {n} 条排期归入需求 / Filed {n} assignments
toast.requirementNameRequired  请输入需求名称 / Requirement name is required
toast.requirementPeriodRequired  该需求暂无子任务，需保留计划周期以在日历显示 / Keep the planned period so this requirement stays visible
toast.personRequired       请选择人员 / Select a person
empty.ungrouped            暂无未归组排期 / No ungrouped assignments
hint.parentTasks           （更新）需求视图：右键需求块可新增排期/编辑/删除；右键未归组块可归入需求；右键格子可新建需求；双击编辑。
view.parentTasks           需求 / Requirements（英文从 Needs 改为 Requirements）
```
> 清理死键：`prompt.assignmentGroupName`、`option.newAssignmentGroup`（`prompt()` 流程已移除）。

---

## 13. 实现波次

| 波次 | 内容 | 依赖 |
| --- | --- | --- |
| **W1 数据模型** | `assignment_groups` 加 `start_date/end_date`（建表 + guarded ALTER）；**3 处**位置式 INSERT 改显式列名（含 `import_csv` L1554，评审补 B1）；`create/update_assignment_group` 处理周期与 `end>=start` 校验；bootstrap 返回 `startDate/endDate` | — |
| **W2 state 辅助 + 渲染** | `requirementIsVisible`/`requirementSpan`/`ungroupedAssignmentsOf`/`requirementMatches`（A3）；`buildAssignmentGroups` 渲染空需求（虚影条）+ 未归组；周期优先级；`.parent-task.empty` 样式；**0 子任务不渲染 `child-count`**（M8） | W1 |
| **W3 需求块交互 + 选中态** | 去 `cursor:help`；解除 click/dblclick/pointerdown 对 parent-task 的提前 return；`selectedGroupId`/`selectRequirement`（A1）；Delete/Escape 路由；右键菜单（命名块/未归组分支）；单击选中、双击→编辑/归入 | W2 |
| **W4 需求编辑表单** | `openRequirementEditor`（名称/颜色/负责人/说明/周期）；色板组件（**color swatches 独立于 custom-select，本波即可完成**）；B2 校验；编辑/**删除（undo 用删前快照，M6）** | W1、W2（快照需 W2 的 state 辅助枚举子排期） |
| **W5 统一表单 + 选择器（B1）** | **合并 `openAssignmentForm`（task/requirement 双模）**取代 `openAssignment`/`openAddAssignment`；自定义需求选择器（共享）；切项目重置（C2）；术语统一；死键清理 | W4 |
| **W6 日历右键切语义** | `showCtxMenu` 读 `projectScheduleMode`：需求视图→「新建需求」；直连 `openRequirementEditor` | W5 |
| **W7 未归组归入** | `openRegroupPicker`；勾选子任务 + 目标需求（现有/新建）→ 批量改 groupId；`allSettled` + undo | W5 |
| **W8 横切收尾** | i18n（中/英）、暗色模式、只读模式拦截、回归（DoD） | 全部 |
| **W9（可选）拖拽对称性** | 拖需求块整体平移；拖人 onto 需求块；拉伸需求周期；单独评审 | W3、W5 |

---

## 14. 完成定义（DoD）

1. `py_compile server.py` 通过；`node --check` 全部 `public/js/*.js` 通过。
2. **迁移幂等**：真实库副本迁移两次零报错；`assignment_groups` 含 `start_date/end_date`；既有需求无周期时回退子任务 min/max，渲染不退化。
3. **INSERT 稳健性 + 周期往返（评审补 N4 / R2 B-3）**：① **回归守卫**：`grep -nE "INTO assignment_groups[[:space:]]+VALUES" server.py` 无命中（防退化成无列名的真位置式；三处本就显式列名、对 ADD COLUMN 稳健）；② **周期往返**：新建需求带 `startDate/endDate` → bootstrap 回读一致（断言 `create/seed` 列清单已追加 `start_date,end_date` 且参数接通，而非仅"不崩"）。
4. **需求块交互**：悬浮为 `pointer`（非问号）；命名块右键 3 项（新增任务/编辑/删除）；双击编辑；单击选中（独立高亮）。
5. **选中态路由（A1）**：选中需求块按 Delete → 删**需求**（子排期降级未归组），不触发 `deleteAssignment`/404；Escape 清选中；选中需求与选中排期互斥。
6. **空需求**：创建需求不选人 + 设周期 → 日历出现虚影条；右键「新增任务」可填人。
7. **空需求可见性（B2）**：编辑无子任务需求时清空周期被阻止并提示；有子任务需求可清空周期（回退子任务 span）。
8. **搜索过滤（A3）**：搜索人名/需求名时，空需求按 `requirementMatches` 正确显隐，不误伤/不漏。
9. **未归组归入**：未归组块右键→勾选子任务 + 选目标 → 子任务移入该需求，未归组条减少；可撤销。
10. **日历右键**：任务视图→「排期到人员」（`mode:'task'`）；需求视图→「新建需求」。切换视图菜单语义正确。
11. **统一表单（B1）**：单一 `openAssignmentForm` 覆盖任务/需求两视图的增/改/排期/建空需求；选择器为自定义下拉；目标=未归组或既有需求时人员必填，仅"需求视图+新建"可不选人；不再用 `prompt()`；原 `openAssignment`/`openAddAssignment` 调用点全部替换。
12. **术语**：全站用户可见处统一为「需求」，`grep "任务集合"` 与死键 `prompt.assignmentGroupName`/`option.newAssignmentGroup` 清零。
13. **不变量**：§8 全部成立（删需求不丢排期、需求不跨项目、任务视图不变）。
14. **只读模式**：需求块右键/双击/归入/表单写操作全部禁用；查看放行。
15. **回归**：任务视图渲染/拖拽/缩放/右键不退化；撤销、i18n（中/英）、暗色模式正常。
16. **文档同步**：本设计文档状态 ✅ + 完成清单；README/AGENTS 若涉及则同步。
17. **import_csv 不崩（评审补 B1）**：导入含「任务集合/需求」列的 CSV 正常建群，不因列数错位报错。
18. **视图门控（评审补 M1）**：默认任务视图下，日历**不**渲染需求条/未归组收件箱、需求块右键菜单不出现、右键格子仍「排期到人员」；切到需求视图后上述全部出现。
19. **删除需求 undo 恢复归属（评审补 M6）**：删除一个有 ≥1 子任务的需求 → undo 后需求恢复，且原属该需求的排期**重新挂回**该需求（而非停在未归组）。
20. **新建+人员防孤儿（评审补 M5）**：在统一排期表单中选「＋新建」+ 人员、日期越出项目 `[start,end]` → 提示越界且**不残留空需求**（建排期失败已回滚群）。

---

## 15. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 位置式 INSERT 漏改导致 create/seed/import 崩（含 `import_csv` L1554，评审补 B1） | W1 集中消灭 **3 处**；DoD #3 grep（修正后模式）断言 |
| **A1 选中态漏路由**：需求选中误触发 `deleteAssignment` → 404 | 独立 `selectedGroupId`；Delete 分支判断；DoD #5 验证 |
| **B2 漏校验**：无子任务需求清周期 → 孤儿不可见 | `openRequirementEditor` 保存前校验；DoD #7 验证 |
| 自定义选择器在 modal 内的开启/关闭/外部点击（C1） | 独立绑定 + 单开限制；W5 集中处理 |
| 切项目未重置需求选择 → groupId 残留旧项目（C2） | `bindRequirementSelect` 挂 `f_project` change 清空；DoD #13 |
| 未归组归入部分失败 | `allSettled` + toast 汇总；每条独立 PUT 幂等 |
| 拖拽/缩放对需求块误触（C4） | 解除 pointerdown return 后，move/resize 启动判定仍排除 `.parent-task` |
| 死 i18n key 残留（C3） | W5/W8 全站 grep 清零（DoD #12） |
| 空需求虚影条铺满、单日条过小 | hatched + 降透明度；lane 复用；数量通常很少 |
| 统一表单分支多、保存语义复杂 | 单一人员规则 + 日期字段复用；W5 集中实现并自测四种保存路径 |
| **删需求 undo 无法恢复归属**：DELETE 破坏性清空 `group_id`，仅重建群（拿新 id）无法回填（评审补 M6） | 删前快照子排期完整记录；undo 重建群 + 逐条 `PUT` 回填（仿 `deletePerson`）；DoD #19 |
| **新建需求+人员孤儿**：建群成功但建排期 400（日期越界）残留空需求（评审补 M5） | 先校验项目范围再建群，或建排期失败回滚群；DoD #20 |
| **右键需求块同时弹格子菜单**：`.parent-task` 在 `.cell` 内，不拦截会双弹（评审补 M2） | 单一 handler 优先级链：先 `parent-task` 命中→`return`；interactions.js 补 `import projectScheduleMode` |
| **默认视图看不到需求功能**：需求交互仅在需求视图，默认任务视图下不可见（评审补 M1） | §3/§5/不变量 #11 标注门控；DoD #18 验证默认视图无需求条 |

---

## 16. 修订日志

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-06-25 | 0.0.6-draft | 初稿：需求块交互 + 日历右键切语义 + 排期弹窗选择器 + 需求管理面板 + 完整字段表单 + 术语统一。 |
| 2026-06-25 | 0.0.6 | 评审调整：① **砍掉需求管理面板**；② 明确**两种需求条形态**（空需求虚影条 + 未归组收件箱）；③ 空白格入口收敛为「新建需求」，并在需求表单内支持可选多人追加排期；④ 新增未归组「将子任务归入需求」；⑤ 空需求渲染。 |
| 2026-06-25 | 0.0.6 | 文案：命名需求块右键「为此需求指派」→**「＋ 为此需求新增任务（唤起排期）」**，该入口人员必填；i18n key `ctx.addTaskToRequirement`。 |
| 2026-06-25 | 0.0.6 | 按 `settings-redesign-design.md` 体例重构目录（§8 不变量 / §9 影响面 / §10 API / §11 模块概览 / §13 实现波次 / §15 风险 / §16 修订日志）；DoD 重排。 |
| 2026-06-25 | 0.0.6 | 自审补强：① **B1 合并单一排期表单 `openAssignmentForm`（task/requirement 双模）**；② **B2 校验兜底**（无子任务需求禁清周期）；③ **A1 需求独立选中态 `selectedGroupId` + Delete/Escape 路由**；④ **A3 空需求搜索谓词 `requirementMatches`**。更新 §2/§4/§5/§6/§7/§8/§9/§11/§13/§14/§15。 |
| 2026-06-25 | 0.0.7 | **独立评审 R1 并入**（逐条对照代码核验）：B1 补第三处位置式 INSERT（`import_csv` L1554）；M2 单一 contextmenu 优先级链 + 补 import；M3/M4 选中态存原始 groupId、DOM 走 `data-group-id` 不靠元素 id；M5 新建+人员孤儿回滚；M6 删需求 undo 改删前快照；M7 复用 `task.ungrouped`；M8 空需求不渲染角标；M1/N1/N2/N4/N6/N7/N8 文档精度补强；新增不变量 #11/#12、DoD #17-#20、风险 4 条。 |
| 2026-06-25 | 0.0.8 | **独立评审 R2 并入**（Part A：R1 全部 10 项落地核验 ✅；Part B：0 blocker / 2 major / 9 minor，均为 R1 措辞自相矛盾）：① **B-3 纠偏**——三处 INSERT 本就显式列名、对 ADD COLUMN 稳健，§4.2 改述为"追加周期列+占位符"，DoD #3 增周期往返校验；② **B-1** undo 区别于 `deletePerson`（PUT 回填、不 POST 重建）；③ **B-2** 快照仅存 id 列表、闭包捕获、与 `{n}` 同源；④ **B-4** 删除行号订正（L915 清空 / L916 删行）；⑤ **B-6** 回滚群不入 undo 栈；⑥ **B-7** 归入新建群不走项目范围预校验；⑦ **B-8** `openRequirementEditor` 仅编辑/查看；⑧ **B-9** W4 依赖补 W2。 |
| 2026-06-26 | 0.0.8 | **独立评审 R3 终审**：Part A（R2 全部 9 项落地核验 ✅、逐条对照代码无误）+ Part B（**0 blocker / 0 major**）→ **CLEAN，可开工**。顺手订正 §9.1 表述与 §4.2 一致（seed/import_csv 本就显式列名）。 |
| 2026-06-26 | 0.0.8 | **实现完成 + 验收通过**：Agent teams 按 §13 波次落地 W1–W8（每波 `node --check`/`py_compile` 闸口 + 主理人复核），主理人增补两处：① W5 `findOrCreateRequirement` 名称去重 + `createdNew` 回滚守卫（防误删去重命中的既有需求）；② W7 全失败时回滚新建的孤儿目标群；③ W3′+W6 合并为单 interactions.js 接线波、并直连 `openAssignmentForm`（删除 openAssignment/openAddAssignment 旧包装，DoD #11）。终验：`py_compile`✓、`node --check` 全模块✓、7 条 unittest✓、位置式 INSERT 清零✓、`任务集合`/死键清零✓、i18n 311 键 zh/en 零缺失✓、后端 HTTP 冒烟（建需求/周期往返/编辑/`end<start` 400/挂排期/删除级联未归组）✓、import_csv 10 列 INSERT 对 12 列表✓。DoD #1–#20 全过。 |

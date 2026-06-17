# 设置页数据维护重设计（团队工作区配套）

| 项目 | 内容 |
| --- | --- |
| 版本 | 0.0.5（设计稿） |
| 状态 | 🟡 设计中，待评审 |
| 关联 | `docs/team-workspace-design.md`（0.0.4 团队工作区） |
| 目标 | 多团队上线后，把「设置」页的团队/人员/项目维护从「平铺 Tab + 弹窗表单」升级为「团队分组折叠 + 项目内嵌里程碑 + 拖拽迁移/排序 + 多选批量 + 就地创建」，降低批量维护成本；并修正里程碑负责人由字符串改为 `owner_id` 外键。 |

---

## 1. 背景与目标

### 1.1 痛点
0.0.4 上线团队工作区后，团队、人员、项目数据量上升，维护出现三类摩擦：

1. **设置页是 5 个平铺 Tab（团队/人员/项目/里程碑/数据）+ 每个一张扁平列表**。团队、人员、项目、里程碑相互割裂；跨团队调整要反复切 Tab → 开表单 → 改团队下拉。
2. **里程碑与项目弱关联**。里程碑虽带 `project_id`，但在设置页/资源抽屉里是一张独立列表，没有「属于哪个项目」的归属感；增删里程碑要在独立 Tab 里反复选项目。
3. **里程碑 `owner` 存的是人名字符串**，人员改名后里程碑负责人就「断链」——这是个数据模型缺陷，应改为 `owner_id`。

### 1.2 目标
- 设置页改为「**团队分组折叠**」：团队是唯一容器，成员与项目（含里程碑）都挂在团队下，跨团队拖拽即迁移。
- **里程碑融入项目**：项目卡可展开，内嵌该项目里程碑子列表，行内增删改。
- **拖拽式操作**：跨团队迁移（含多选批量）、列表内排序、就地快速创建，三种交互并存。
- **修正数据模型**：里程碑 `owner` → `owner_id`（外键到 `people.id`），支持改名不断链。

### 1.3 非目标
- 不改主日历的渲染与交互逻辑（里程碑在日历上仍按现行规则展示，仅 `owner`→`ownerId` 字段替换）。
- 不改资源抽屉（`renderResourceBody`）——它仍按当前团队过滤的扁平列表工作。本次只重做设置页。
- 不改 `project.owner`（项目负责人，字符串；筛选器 `filters.owner` 筛它）。**仅改 `milestones.owner`。**

---

## 2. 决策摘要（已与需求方对齐）

| 分叉 | 选定方案 |
| --- | --- |
| 设置页形态 | **团队分组折叠**（团队为容器，成员+项目+里程碑挂在团队下） |
| 里程碑归属 | **项目卡内嵌 + 可展开**（里程碑 Tab 保留为全局视图） |
| 创建方式 | **两者都要**（`+` 按钮弹表单 + 区块底部就地输入） |
| 批量迁移 | **支持多选拖拽**（勾选多条一起拖到目标团队） |
| 里程碑负责人 | `owner`（字符串）→ `owner_id`（外键 `people.id`） |

---

## 3. 信息架构

```text
设置页
└─ 团队区块（按 teams.sort_order 排列，可折叠）
   ├─ 头部：● 团队名 (默认?) · N 人 · M 项目 · [编辑][删]   [▾/▸ 折叠]
   ├─ 成员区
   │  ├─ [☐] ⠿ ● 成员名   部门/角色 产能   [编辑]        ← 多选 + 排序 + 拖拽迁移
   │  └─ [＋ 添加成员]  /  [就地输入行：姓名 部门 角色 | 建]
   └─ 项目区
      ├─ [⠿] ● 项目名  负责人 · 优先级 · 日期   [编辑] [▾]  ← 排序 + 拖拽迁移 + 展开
      │    ├─ ◆ 里程碑名  日期 · 级别 · 负责人   [编辑][删]   （项目内嵌，按日期排）
      │    └─ ...
      └─ [＋ 添加项目]  /  [就地输入行：项目名 | 建]
```

**心智模型**：设置页 = 一棵「团队 → {成员, 项目 → 里程碑}」的归属树。跨团队迁移 = 把节点拖到另一个团队区块。负载/冲突不变量不受影响（迁移只改归属，排期不动）。

---

## 4. 数据模型变更

### 4.1 里程碑 `owner` → `owner_id`（必做）

**Schema 变更**（`server.py` 的 `init_db` 迁移块，沿用项目 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 约定）：

```sql
-- 1) 加列（guarded，幂等）
ALTER TABLE milestones ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
```

**回填**（按现有 `owner` 字符串匹配 `people.name`）：

```sql
UPDATE milestones
SET owner_id = (SELECT p.id FROM people p
                WHERE p.name = milestones.owner AND p.name <> '')
WHERE owner_id = '' AND owner <> '';
```

- 匹配成功 → `owner_id` = 人员 id。
- 匹配不到（人员改名/删除/名字重复取第一条）→ `owner_id` 留空，旧 `owner` 字符串保留作历史参考（代码不再读 `owner`）。
- **旧 `owner` 列保留**（`NOT NULL DEFAULT ''`），不 drop，避免迁移风险；所有代码只读写 `owner_id`。

**删人时的清理**（里程碑负责人解绑，不级联删里程碑）：推荐用 SQLite 触发器，一次建立，零应用代码：

```sql
CREATE TRIGGER IF NOT EXISTS milestones_clear_owner_on_person_delete
AFTER DELETE ON people
BEGIN
  UPDATE milestones SET owner_id = '' WHERE owner_id = OLD.id;
END;
```

> 备选方案：在 `do_DELETE` 拦截 `table=='people'`，删人前 `UPDATE milestones SET owner_id='' WHERE owner_id=?`。触发器更贴合「里程碑是项目附属、删人只解绑负责人」语义，且与 `home_team_id`/`team_id` 的应用层校验约定不冲突（那些是无 FK 的归属，owner_id 用触发器清理是合理特例）。**推荐触发器。**

### 4.2 位置式 INSERT 必须改显式列名（关键陷阱）

`milestones` 现有 9 列，加 `owner_id` 后变 10 列。以下 3 处位置式 `INSERT ... VALUES (?,?,?,?,?,?,?,?,?)`（9 占位符）会立即断裂，**必须同步改为显式列名表**：

| 位置 | 当前 | 改为 |
| --- | --- | --- |
| `seed_from_initial_data`（~L299） | `INSERT OR IGNORE INTO milestones VALUES (?,?,...,?)` | 显式列名 + 新增 `owner_id`（按 `owner` 名查 id 回填） |
| `create_milestone`（~L860） | `INSERT INTO milestones VALUES (?,?,...,?)` | 显式列名 + `owner_id` |
| `import_csv`（~L969） | `INSERT INTO milestones VALUES (?,?,...,?)` | 显式列名 + `owner_id`（按「里程碑负责人」名查 id） |

> 这是 0.0.4 团队工作区踩过的同一个坑（`ALTER TABLE ADD COLUMN` 破坏位置式 INSERT）。**任何新增列都必须先消灭所有相关位置式 INSERT。**

### 4.3 里程碑排序（可选增强，默认不做）

`milestones` 表**没有 `sort_order` 列**，`bulk_sort`（`PUT /api/sort`）**只允许 `people`/`projects`**。

- **默认方案（推荐）**：项目内里程碑按 `milestone_date` 排序（与 bootstrap 现状一致），不支持拖拽排序。改动最小。
- **可选增强**：若要拖拽排序，需 ① `ALTER TABLE milestones ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`；② 扩展 `bulk_sort` 的 `table in ('people','projects','milestones')`；③ seed/bootstrap/create 按 sort_order。**本设计默认采用按日期排序，拖拽排序列为后续增强。**

### 4.4 团队/人员/项目排序
`teams`/`people`/`projects` 均已有 `sort_order` 列，`bulk_sort` 已支持 `people`/`projects`。**团队排序需扩展 `bulk_sort` 支持 `teams`**（团队区块的拖拽重排，复用资源抽屉已有的 `startReorder` → `PUT /api/sort {table:'teams'}` 机制）。

---

## 5. 设置页新布局

### 5.1 团队区块
- 顶部 `settingsNav` 简化为：`[团队]  里程碑（全局）  数据`。**「人员」「项目」Tab 移除**——它们已内嵌进团队区块。`里程碑` Tab 保留为「全局里程碑」视图（见 §6.4）。
- 团队按 `sort_order` 排列；每个团队一个可折叠区块。
- **折叠状态记忆**：`localStorage` 存 `rc_settingsCollapsedTeams`（折叠的团队 id 集合，JSON），全局生效（不 per-team）。

```text
设置
[团队]  里程碑  数据                                    [＋ 新建团队]

▼ ● 通用团队 (默认)                      3 人 · 2 项目      [编辑][删]
   ┌ 成员 ─────────────────────────────────────────[＋ 添加成员]┐
   │ ☐ ⠿ ● 张三   研发部/后端  8h                     [编辑]      │
   │ ☐ ⠿ ● 李四   研发部/前端  8h                     [编辑]      │
   │ └ 就地：新成员 [_____] 部门 [_] 角色 [_]      [建]            │
   └────────────────────────────────────────────────────────────┘
   ┌ 项目 ─────────────────────────────────────────[＋ 添加项目]┐
   │ ⠿ ● 示例项目  王五 · 高 · 06-01~06-30           [编辑] [▾]  │
   │     ├ ◆ 提测      06-24 · 重要 · 王五      [编辑] [删]       │
   │     └ ◆ 上线      07-01 · 风险 · 王五      [编辑] [删]       │
   │ ⠿ ● 营销官网  赵六 · 中                       [编辑] [▸]     │
   │ └ 就地：新项目 [_________]                  [建]             │
   └────────────────────────────────────────────────────────────┘

▶ ● 研发团队                            6 人 · 5 项目     [编辑][删]   ← 折叠
▶ ● 设计团队                            4 人 · 3 项目     [编辑][删]
```

### 5.2 成员列表
- 每行：`[☐ 多选] ⠿ 排序把手 ● 色点 姓名 小信息 [编辑]`。
- 删除入口收进 `[编辑]` 弹窗的删除按钮（与现有一致），列表行不放删除按钮，避免误删（批量靠多选 + 右键/工具栏批量删除，见 §8）。
- 团队区块内只显示 `home_team_id === 该团队` 的**非归档**成员。

### 5.3 项目列表（内嵌里程碑）
- 每行：`⠿ 排序把手 ● 色点 项目名 小信息 [编辑] [▾/▸]`。`▾` 展开/收起里程碑子列表。
- 默认全部收起；展开记忆到 `localStorage rc_settingsExpandedProjects`（项目 id 集合）。
- 团队区块内只显示 `team_id === 该团队` 的非归档项目。

---

## 6. 里程碑融入项目

### 6.1 项目卡展开 → 里程碑子列表
- 展开后渲染 `state.milestones.filter(m => m.projectId === p.id)`，按 `milestone_date` 升序。
- 每行：`◆ 里程碑名  日期 · 级别 · 负责人  [编辑] [删]`。
- 负责人显示：`person(m.ownerId)?.name`，空则显示「未指派」。
- 子列表底部 `[＋ 添加里程碑]`（projectId 预填当前项目，弹精简表单）。

### 6.2 行内 CRUD
- **新增**：`[＋ 添加里程碑]` → 复用现有 `openMilestone`/`openAddMilestone`，projectId 预填。
- **编辑**：`[编辑]` → `openMilestone(id)`。
- **删除**：`[删]` → `deleteMilestone(id)`（带撤销，复用现成 undo 链）。

### 6.3 里程碑 `owner` → `ownerId` 的表单/展示改造
- `openMilestone` 表单：`f_owner` 的 `<option value>` 由「人名字符串」改为「`person.id`」，未指派项 value 为空字符串；保存时提交 `ownerId`。
- 日历人员视图里程碑归属判断（`calendar.js` / `state.js`）：`m.owner === r.name` → `m.ownerId === r.id`；`person` 查找由 `x.name === m.owner` → `x.id === m.ownerId`。
- 未指派里程碑的 fallback（按当日有该项目排期的人展示）保留：`!m.ownerId` 时走原 fallback 逻辑。

### 6.4 里程碑全局 Tab（保留）
顶部 `里程碑` Tab 保留为「跨项目全局视图」（现 `renderSettings` milestones 分支），用于一眼看所有里程碑；列表里加「所属团队」列（`team(project(m.projectId)?.teamId)?.name`）。

---

## 7. 拖拽交互规范

复用现有两套机制：HTML5 DnD（`setDrag`/`readDrop`/`allowDrop`）+ pointer 重排（`startReorder` → `PUT /api/sort`）。**只读模式下全部禁用**（与现状一致）。

### 7.1 跨团队迁移（单条 + 多选批量）
- **拖拽源**：成员行 `draggable="true" data-drag-type="person" data-drag-id=...`；项目行同理 `project`。
- **放置目标**：团队区块的「区块头」或「成员区/项目区容器」整体作为 drop zone（`dragover` 高亮整块）。
- **drop 处理**：
  - 单条：`PUT /api/people/:id {homeTeamId: 目标团队}`（项目走 `PUT /api/projects/:id {teamId}`）。
  - 多选：循环调用上述 update（**复用现成 update，不改后端**）；用 `Promise.allSettled` 收集结果，部分失败时 toast 汇总「成功 N 条，失败 M 条」。
- **校验**：目标团队不可为空（drop 必须落到有效团队块）；默认团队可作为目标；源与目标相同则忽略。

### 7.2 列表内排序
- 复用 `⠿` 把手 `startReorder` → `PUT /api/sort {table, ids}`。
- 成员/项目排序：现成支持。
- **团队区块排序**：扩展 `bulk_sort` 支持 `teams`（§4.4），区块头加 `⠿` 把手。
- 里程碑排序：默认按日期（§4.3）。

### 7.3 就地创建（区块底部输入行）
- 成员区底部：`新成员 [姓名] [部门] [角色] [建]`，提交 `POST /api/people {name, department, role, dailyCapacity:8, homeTeamId: 当前团队}`。
- 项目区底部：`新项目 [项目名] [建]`，提交 `POST /api/projects {name, teamId: 当前团队}`（其余字段默认）。
- 建后 `reloadAll()`；空姓名不提交（toast 提示）。
- 复杂字段（产能、颜色、优先级、日期、里程碑负责人）仍走 `+` 按钮的完整表单。

### 7.4 `+` 按钮创建（团队预填）
- `openPerson()` / `openProject()` 表单的团队字段默认填「当前所在团队」（已有 `activeTeam || defaultTeamId()` 逻辑，区块内创建时传入该团队的 id）。

### 7.5 批量删除（多选延伸）
- 多选后提供「批量删除」入口（工具栏按钮或右键）。复用 `deletePerson`/`deleteProject`（带撤销）逐条调用，结果汇总。**默认团队不可作为仅剩的归属——批量删除不涉及团队删除，无额外约束。**

---

## 8. 不变量与边界

| # | 不变量/边界 | 说明 |
| --- | --- | --- |
| 1 | **跨团队迁移不改排期** | 只改 `home_team_id`/`team_id`，`assignments` 不动；全局负载/冲突/A 口径统计照常算。 |
| 2 | **默认团队 `tm_default` 不可删** | 沿用 0.0.4 约束；可作为迁移目标。 |
| 3 | **迁移目标必须有效** | drop 到非团队块忽略；`_validate_team` 后端兜底。 |
| 4 | **多选迁移事务性** | 前端循环 + `allSettled`，部分失败不阻断、toast 汇总；不做后端事务（务实，复用现成 update）。 |
| 5 | **`owner_id` 删人解绑** | 触发器置空，不级联删里程碑；前端 `person(ownerId)` 为空时显示「未指派」。 |
| 6 | **只读模式禁拖拽** | `isReadOnlyMode()` 拦截 dragstart/reorder/就地创建。 |
| 7 | **`project.owner` 不变** | 仅改 `milestones.owner`；筛选器 `filters.owner` 仍筛项目负责人。 |
| 8 | **归档项的处理** | 团队区块内不显示归档人员/项目；归档项目内嵌里程碑折叠隐藏。 |

---

## 9. `owner_id` 改造影响面清单

### 9.1 后端 `server.py`
| 位置 | 改动 |
| --- | --- |
| `init_db` 迁移块 | `ALTER TABLE milestones ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`（guarded）+ 按 name 回填 + 清理触发器 |
| `seed_from_initial_data` (~L293-308) | 位置式 INSERT → 显式列名；`owner_id` 按 `item.owner` 名查 `people.id` 回填 |
| `bootstrap` (~L542) | `SELECT ... owner ...` → `owner_id AS ownerId`（旧 owner 不再返回，或保留做兼容） |
| `create_milestone` (~L854-860) | 位置式 INSERT → 显式列名；接受 `ownerId`，存 `owner_id` |
| `update_milestone` (~L862-867) | `owner=?` → `owner_id=?`；接受 `ownerId` |
| `import_csv` (~L951-973) | 位置式 INSERT → 显式列名；`owner` 名查 `people.id` 存 `owner_id`；UPDATE 同步改 `owner_id` |
| `export_csv` (~L1084-1098) | `m.owner AS milestone_owner` → `LEFT JOIN people op ON op.id=m.owner_id`，导出 `op.name`（人类可读） |

### 9.2 前端
| 位置 | 改动 |
| --- | --- |
| `panels.js` `openMilestone`/`openAddMilestone` | `f_owner` option value = `person.id`；提交 `ownerId` |
| `panels.js` 设置页里程碑行（全局 Tab） | 负责人显示 `person(m.ownerId)?.name` |
| `calendar.js` (L163) | 人员视图里程碑归属：`m.owner === r.name` → `m.ownerId === r.id` |
| `state.js` (L150-152, 179-200, 263-264) | `m.owner === row.name` / `x.name === m.owner` → `m.ownerId === row.id` / `x.id === m.ownerId`；`milestoneMatches` 同步 |
| `app.js` 打印报表 (L570) | `m.owner` → `person(m.ownerId)?.name` |
| `state.js` state 初始化/类型 | milestone 对象含 `ownerId` |

### 9.3 配置/示例
| 位置 | 改动 |
| --- | --- |
| `config/initial-data.json.example` | milestones 项可同时给 `owner`（人名，兼容）和说明；seed 按 name 回填 owner_id |

---

## 10. API（复用为主，最小新增）

| 操作 | 方式 | 备注 |
| --- | --- | --- |
| 跨团队迁移人员 | `PUT /api/people/:id {homeTeamId}` | 现成，带 `_validate_team` |
| 跨团队迁移项目 | `PUT /api/projects/:id {teamId}` | 现成，带校验 |
| 批量迁移 | 前端循环上述 update | `allSettled` 汇总；不改后端 |
| 成员/项目排序 | `PUT /api/sort {table:'people'\|'projects', ids}` | 现成 |
| 团队排序 | `PUT /api/sort {table:'teams', ids}` | **需扩展 `bulk_sort` 允许 `teams`** |
| 里程碑 CRUD | `POST/PUT/DELETE /api/milestones` | 字段 `owner` → `ownerId` |
| 就地/`+`创建 | `POST /api/people` / `POST /api/projects` | 现成，团队预填 |

> **无需新增端点**。批量迁移、团队排序均通过扩展/复用现成接口完成。

---

## 11. 前端模块改动概览

| 模块 | 主要改动 |
| --- | --- |
| `panels.js` | 重写 `renderSettings`（团队分组折叠 + 项目内嵌里程碑 + 多选 + 就地创建）；`openMilestone` owner→id；新增团队区块 drop zone / 折叠 / 多选状态 |
| `interactions.js` | 设置页 drop 处理（迁移）；团队区块 `⠿` 排序委托到 `bulk_sort(teams)`；就地创建提交委托 |
| `state.js` | milestone `ownerId`；折叠/展开/多选的内存状态 + localStorage 持久化 helper |
| `app.js` | 打印报表 owner→id；设置页重渲染接入 |
| `i18n.js` | 新增文案（见 §12） |
| `index.html` / `main.css` | 团队区块、折叠、多选 checkbox、就地输入行、drop 高亮的样式 |
| `server.py` | §9.1 全部 + `bulk_sort` 扩展 teams |

---

## 12. i18n 新增文案（zh/en）

`settings.teamMembers` / `teamProjects` / `expand` / `collapse` / `addMemberHere` / `addProjectHere` / `inlineCreate` / `build`；`toast.migrated` / `migratePartial` / `migrateSameTeam` / `needInlineName`；`label.milestoneOwner`（复用 assignee）；`settings.globalMilestones` / `column.team` 等。

---

## 13. 实现波次

| 波次 | 内容 | 依赖 |
| --- | --- | --- |
| **W1 数据模型** | `owner_id` 迁移 + 回填 + 触发器；3 处位置式 INSERT 改显式列名；`bulk_sort` 扩展 teams；里程碑按 owner_id 贯通后端（bootstrap/create/update/import/export） | — |
| **W2 owner_id 前端贯通** | `openMilestone` 表单、calendar/state/app 的 owner→ownerId 替换；回归里程碑在人员视图/打印报表的展示 | W1 |
| **W3 设置页骨架** | 团队分组折叠布局；折叠/展开记忆；成员/项目列表按团队分区；移除人员/项目 Tab | W1 |
| **W4 项目内嵌里程碑** | 项目卡展开 + 里程碑子列表 + 行内 CRUD；全局里程碑 Tab 加团队列 | W2、W3 |
| **W5 拖拽迁移 + 排序** | 团队区块 drop zone（单条）；团队区块 `⠿` 排序；成员/项目 `⠿` 排序接入设置页 | W3 |
| **W6 多选批量** | checkbox 多选状态；批量拖拽迁移（allSettled 汇总）；批量删除 | W5 |
| **W7 就地创建 + `+` 按钮** | 区块底部就地输入行；`+` 按钮团队预填 | W3 |
| **W8 验证** | 见 DoD | 全部 |

---

## 14. 完成定义（DoD）

1. `py_compile server.py` 通过；`node --check` 全部 `public/js/*.js` 通过。
2. **迁移幂等**：真实库副本迁移两次零报错；`owner_id` 按 name 回填正确；旧 `owner` 保留；删人后其里程碑 `owner_id` 置空（触发器验证）。
3. **位置式 INSERT 清零**：`grep "INSERT.*milestones.*VALUES"` 无位置式残留。
4. **owner→id 贯通**：里程碑负责人改名后不断链（改人名，里程碑负责人仍正确指向）；删人后里程碑显示「未指派」。
5. **设置页形态**：团队分组折叠，成员/项目挂在团队下；折叠/展开状态记忆生效。
6. **里程碑内嵌**：项目卡展开显示该项目里程碑，行内增删改可用；全局里程碑 Tab 含「所属团队」列。
7. **跨团队迁移**：拖人到另一团队块，`home_team_id` 变更，排期与全局负载不变；项目同理。
8. **多选批量**：勾选多条一起拖迁，成功/失败汇总正确。
9. **就地创建**：区块底部输入行可建成员/项目，团队自动归属；`+` 按钮表单团队预填。
10. **不变量**：迁移后负载/冲突/A 口径统计与迁移前一致（排期未动）。
11. **只读模式**：拖拽/排序/就地创建/批量全部禁用。
12. **文档同步**：AGENTS.md（milestones 加 `owner_id`）、README.md（0.0.5 说明）、本设计文档状态 ✅ + 完成清单。
13. **回归**：0.0.4 团队工作区既有行为（团队 CRUD、per-team 偏好、借调标签、CSV 团队列）不退化。

---

## 15. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `owner_id` 回填匹配率低（大量改名/重名） | 回填只匹配唯一名；未匹配留空 + 保留旧 `owner` 字符串可人工核对；不阻断迁移 |
| 位置式 INSERT 漏改导致 create/import 崩 | DoD #3 grep 断言；W1 集中消灭 |
| 多选批量部分失败数据不一致 | `allSettled` + toast 汇总；前端可重试失败项；每条独立 update 天然幂等 |
| 设置页 DOM 变大影响渲染 | 团队默认折叠（只渲染展开块的内嵌里程碑）；复用 `content-visibility` |
| 触发器在已有库重复创建 | `CREATE TRIGGER IF NOT EXISTS` |
| `bulk_sort` 扩展 teams 的注入面 | table 仍走白名单 `in (...)`，不直接拼接到不可信输入 |

---

## 16. 修订日志

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-06-17 | 0.0.5-draft | 初稿：团队分组折叠 + 项目内嵌里程碑 + 拖拽迁移/排序 + 多选批量 + 就地创建；里程碑 `owner`→`owner_id` 迁移设计 |

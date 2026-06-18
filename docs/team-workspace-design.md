# 团队工作区（Team Workspace）功能设计 · Resource Scheduler

> 目标版本：`0.0.4`（已实现）
> 维护说明：本文是「团队工作区」特性的单一事实来源（single source of truth）。记录已确认的矩阵式数据模型、团队/全局双视图、API、交互与边界。**当前状态：✅ 已实现（Implemented，2026-06-17）—— 后端迁移/API/CSV + 前端切换器/过滤/表单/团队管理/per-team 偏好/i18n 全部落地，DoD 全量验证通过（见第 13 节末「实现完成状态」与第 16 节修订记录）。**
> 上线要求（Definition of Done）见文末「验证与上线标准」。
> 关联文档：`AGENTS.md`（开发约束）、`docs/iteration-plan.md`（迭代主线）。
> 历史：本文取代早期的「业务线（多对多 + 视图切分）」方向，该方向已废弃。

---

## 0. 状态

| 项 | 值 |
| --- | --- |
| 状态 | ✅ 已实现（Implemented，2026-06-17）— 后端+前端全量落地，DoD 12 项验证通过 |
| 创建 / 更新 | 2026-06-17 |
| 方向 | 单一租户 · 多团队隔离（**矩阵式**：人单属 home team、项目单属 team，排期实现跨团队借调） |
| 目标版本 | `0.0.4` |
| 依赖 | 无新增第三方库；复用现有 `http.server` + `sqlite3` + 原生 ES Modules |
| 代码基线 | `server.py` 952 行 · 0.0.3（迁移/CRUD/CSV/只读均已就绪）；现有库 `data/scheduler.sqlite` 为真实数据，迁移须在其上幂等 |

---

## 1. 背景与目标

### 1.1 为什么不是「业务线视图切分」

早期设想把「业务线」做成一个跨人/项目的多对多标签 + 视图切分轴。评审后认定：该方向保留了所有数据在一张表里、仅靠过滤切分，**隔离强度弱，且与真实组织形态不符**。

### 1.2 真实模型：矩阵式组织

绝大多数有一定规模的公司是**矩阵式组织**，核心是「归属」与「参与」分离：

- **人有一条实线**：归属于一个团队（`home_team`）——管考勤、产能、绩效。唯一归属。
- **项目属于一个团队**（`team`）——项目是某团队的资产，不跨团队。
- **人通过排期参与多个项目**——同一人可被排到多个项目，含跨团队项目（虚线借调）。

### 1.3 为什么必须能跨团队（产品本质论证）

本产品是 **Resource Scheduler（资源调度器）**。**调度的存在意义，就是处理「有限人力如何在多个项目/团队间分配」**——资源跨边界共享、需全局统筹，才有「调度」可言。若每人锁死在一个团队、永不跨团队，每个团队内部自排即可，**全局视图与产品核心价值被架空**。因此：**人可跨团队被排期，但产能是全局稀缺资源**。

### 1.4 目标

引入「团队」一级实体，在单一租户内实现多团队隔离：

- 每个团队是独立的数据空间（项目归属、视图偏好独立）。
- 顶部切换器按 `projects.team_id` 切换「团队视图」。
- 保留「全部团队」聚合视图作为管理者全局视角（按人看总产能/负载/冲突）。
- 排期天然支持跨团队借调；**产能/冲突始终全局计算**。

### 1.5 非目标（本期不做）

- 登录 / 权限 / 访问控制（留给 `0.1.0`，见第 15 节）。本期假定使用者是全局管理者，可切任何团队。
- 多租户（org 层）。
- 团队级独立节假日表 / 独立产能预算。
- 跨团队人员的「成本分摊」规则（如借调工时如何回摊到 home team）。

---

## 2. 核心模型决策

| 决策点 | 选定方案 | 理由 |
| --- | --- | --- |
| 整体模型 | **矩阵式** | 贴合真实组织；数据最简（全单一归属，无关联表）；支持跨团队调度。 |
| 人员归属 | `people.home_team_id` 单一归属 | 人有「家」，管产能/考勤；归属清晰。 |
| 项目归属 | `projects.team_id` 单一归属 | 项目是团队资产，提供隔离边界。 |
| 跨团队借调 | 排期天然支持，无特殊机制 | A 团队的人排 B 团队项目即借调；`assignments` 不带 team_id，归属由两端推导。 |
| 产能 / 冲突 | **全局计算** | 人一天产能是全局稀缺资源；即便在团队视图，冲突也含该人在其他团队的排期。 |
| 团队视图切分轴 | 按 `projects.team_id` | 团队边界落在项目上，不在人上（因人可借调）。 |
| 管理者全局视图 | 保留「全部团队」聚合视图 | resource scheduler 的灵魂视图：全局人力/负载/冲突。 |
| 实体形态 | `teams` 一级实体（CRUD/颜色/排序/归档） | 与 `projects` 同级。 |
| 归属强制性 | **每条数据必须归属一个真实团队**（`home_team_id`/`team_id` 非空） | 隔离完整性：无「无团队」游离数据。`''` 只存在于视图状态（`activeTeam`）与 settings 视图档，**不进归属字段**。 |
| 视图偏好 | per-team（`settings` 加 team_id 维度） | 每个团队独立 viewMode/customDays/printOptions。 |

---

## 3. 领域模型与数据关系

### 3.1 矩阵式关系图

```
                         ┌──────────────┐
                         │     teams    │  一级实体：CRUD / 颜色 / 排序 / 归档
                         │ id,name,...  │
                         └──┬───────┬───┘
            home_team_id ───┘       └─── team_id
                ▼                         ▼
           ┌────────┐                ┌──────────┐
           │ people │                │ projects │   （均为单一归属）
           └───┬────┘                └────┬─────┘
               │                          │
               │  assignments = 人 × 项目 × 日期区间（跨团队借调在此发生） │
               └────────────┬─────────────┘
                            ▼
                    ┌───────────────┐
                    │ assignments   │  ★ 不带 team_id，归属由 person.home_team
                    └───────────────┘    与 project.team 推导
                            ▲
               projects ─── milestones（随项目继承 team_id）
```

**借调示例**：

```
张三  home_team = 基础架构团队   产能 8h/天
   ├─ 排期 → 电商App项目（电商团队）    4h   ← 借调到电商
   └─ 排期 → 广告平台项目（广告团队）   4h   ← 借调到广告
   → 全局当日 8h 用满，无冲突；再加任何工时 → 冲突（全局算）
```

### 3.2 新增 / 演进表

**新增 `teams`（一级实体）**：

```sql
CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#7db7ff',
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

**给 `people` / `projects` 加单一归属列**（沿用 `PRAGMA table_info` 迁移模式，`server.py:370` 一带）。归属字段**永不为空**——加列时的 `DEFAULT ''` 仅是迁移瞬间的占位，迁移随即建「默认团队」并把 `''` 全部填为真实团队 id（见第 11 节）；应用层（`create_person`/`create_project`）强制要求传入合法 team id：

```sql
-- 加列（临时默认值，仅迁移用）
ALTER TABLE people   ADD COLUMN home_team_id TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN team_id      TEXT NOT NULL DEFAULT '';
-- 迁移随即执行（第 11 节），消除所有 ''：
--   建默认团队 tm_default
--   UPDATE people   SET home_team_id='tm_default' WHERE home_team_id='';
--   UPDATE projects SET team_id     ='tm_default' WHERE team_id='';
```

> ⚠️ **实现陷阱（必读）：位置式 `INSERT` 必须改写为显式列名表。** 现有所有写入 `people`/`projects` 的语句都是**位置式** `INSERT … VALUES (?,?,…)`（不带列名表），例如 `seed_from_initial_data`（`server.py:239` people / `:257` projects）、`create_person`（`:602`）、`create_project`（`:633`）、`import_csv`（`:770` projects / `:821` people）——共 **6 处**。SQLite 要求位置式 `INSERT` 按表定义顺序提供**全部列**的值；一旦 `ALTER TABLE … ADD COLUMN` 追加了新列，这 6 处插入会因列数不匹配而立即报错。因此迁移不仅要加列，还必须把上述 6 处统一改写为 `INSERT INTO people (id,name,…,home_team_id) VALUES (…)` 的**显式列名表**形式（并补上新列的值）。`assignments`/`milestones` 不加列，其位置式插入（`server.py:843`/`:796`）**无需改动**。详见第 11 节 A1。

**演进 `settings`（加 team_id 维度）**：

```sql
-- 旧（server.py:363-366）：settings (key TEXT PRIMARY KEY, value TEXT)
-- 新：
CREATE TABLE settings (
    team_id TEXT NOT NULL DEFAULT '',   -- '' = 全局/默认档（「全部团队」视图）
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (team_id, key)
);
```

> `assignments` 与 `milestones` **不加 team_id 列**——其团队归属由 `person.home_team_id`（人向）与 `project.team_id`（项目向）实时推导，避免冗余与不一致。

### 3.3 团队归属的两种推导方向（关键）

同一组排期数据，按两种方向推导出两种视图：

| 推导方向 | 用途 | 对应视图 |
| --- | --- | --- |
| **项目向**：`project.team_id = 当前团队` | 「这个团队的工作范围」=该团队项目 + 排在上面的所有人（含借调来的） | **团队视图** |
| **人向**：`person.home_team_id` 或全部 | 「这些人的总产能与分配」 | **全局视图** |

这就是团队视图（项目导向）与全局视图（人导向）的数据基础。

---

## 4. 团队切换与两个视图

### 4.1 切换器

工具栏加单选下拉：`全部团队 ▼ / 电商 / 广告 / ...`（归档项不展示），状态持久化到 `localStorage`（key `rc_activeTeam`）。默认 `''`（全部团队），向后兼容。

### 4.2 团队视图（选中某团队 X，项目导向）

- **项目视图**：`projects.team_id = X` 的项目，及其排期（人可为任意 home_team，含借调）。
- **人员视图**：在 `team_id=X` 的项目上有排期的人；**排期条只渲染 X 团队项目的**（聚焦当前团队工作）。
- **资源池**：`projects.team_id = X` 的项目 + `home_team_id = X` 的人（本团队资产）。
- **借调人员视觉标记**：人员视图里 `home_team_id ≠ X` 的人，标注「借调」标签，提示非本团队。

### 4.3 全局视图（`activeTeam = ''`，人导向，管理者）

- 不过滤，显示所有项目 / 人员 / 排期。
- 产能 / 负载 / 冲突按全部数据计算——resource scheduler 的灵魂视图。

### 4.4 ★ 关键约束：产能 / 冲突始终全局计算

**无论当前在哪个团队视图，一个人的当日负载与冲突判定，都基于他在所有团队的排期之和。**

理由：人一天产能是全局稀缺资源。若团队视图只按本团队排期算负载，会出现「电商视图里张三只显示 4h、不报冲突，实则全局已 8h 满」的误判。

实现含义：`rowMatches` / 资源池渲染按团队过滤（控制**显示哪些行**），但 `totalHours` / `loadRate` / `isConflictCell` / `overflowHours`（`state.js:473` 起）**不改动**——它们本就基于全量 `state.assignments` 计算，天然全局。仅「排期条是否渲染」受团队过滤。

> 因此团队视图的行集合被收窄，但行的负载颜色 / 冲突徽标仍反映该人的全局真实负载。这是矩阵模型最重要的不变量。

### 4.5 视图偏好 per-team

`viewMode` / `customDays` / `printOptions` 每个团队各持一份（`settings(team_id, key)` + localStorage `rc_viewMode:<teamId>`）。`focusDate` 保持全局（见第 14 节 Q2）。

**切换团队状态机** `switchTeam(targetId)`：

```
1. persist(current)  : 当前 viewMode/customDays/printOptions 存入 settings(currentTeam, *)
2. activeTeam = targetId
3. hydrate(target)   : 从 settings(targetId, *) 加载覆盖前端单值
                        首次切到该团队无记录 → 用全局档（''）值兜底
4. buildDates() + renderAll() + renderResourceBody()
```

---

## 5. 全局 vs 团队 分层矩阵

| 模块 | 取数方式 | 团队响应 | 现状锚点 | 改动 |
| --- | --- | --- | --- | --- |
| 日历行（显示哪些） | `rowMatches` | **per-team**（项目向过滤） | `state.js:85` | `rowMatches` 加 team 判断 |
| 日历负载/冲突（颜色/徽标） | `totalHours`/`loadRate`/`isConflictCell` | **全局（不变量）** | `state.js:473/480/503` | **不改** |
| 排期条渲染 | `rowMatches` + 团队项目过滤 | per-team | `calendar.js:97`（`renderScheduler`，`:100` 过滤） | 排期条按 `project.team_id` 过滤 |
| 资源池 `renderResourceBody` | `state.*.filter` | **per-team** | `panels.js:200` | 加 team 过滤 |
| 统计 `renderStats`（产能/已分配/负载/冲突） | `rowMatches`（行集合） | per-team（行集合）；负载全局 | `panels.js:290` | 行过滤随 `rowMatches`；统计口径见 5.1 |
| 统计 `renderStats`（里程碑 ms/near） | `milestoneMatches` | **per-team**（随 `project.team_id` 继承） | `state.js:266` | `milestoneMatches` 加 team 判断：里程碑挂在项目上、随项目继承 `team_id` |
| 视图偏好 viewMode/customDays/printOptions | settings + localStorage | **per-team（新）** | `api.js:91`（bootstrap）/ `state.js:37` | settings 加 team_id 维度 + 切换整体替换 |
| 团队切换器（工具栏） | 新增 | **驱动轴** | `app.js:66` 工具栏 | 新增 |
| **设置页** 人员/项目/里程碑 | `state.*` 全量 | **全局**（管理全貌） | `panels.js:377`（`renderSettings`） | **无需改**（天然全局）；表单加 home_team/team 单选 |
| 数据导入导出 | — | 绑当前团队 | `server.py:720`（import）/ `:859`（export） | CSV 加「团队」列 |

### 5.1 团队视图统计口径（已定 A，见 Q1）

团队视图「已分配/负载」采用 A 口径（分子含借调工时、分母仅 home 成员产能）：

- **分子（已用）** = `team_id=X` 项目上的排期工时（含借调人员贡献）。
- **分母（产能）** = `home_team_id=X` 人员的产能。

此口径下借调工时计入分子、借调人员产能不在分母，**负载率会偏高**（管理含义：「我们团队的项目占用了多少人力」）。**全局视图给出准确的「人效/负载」**。两视图各有侧重、互为补充。

**里程碑（`ms` / `near`）口径**：里程碑挂在项目上、随 `project.team_id` 继承归属（见 3.1 / 4.1）。团队视图只统计属于当前团队（`project.team_id === activeTeam`）的里程碑——窗口内的 `ms`、即将到期/逾期的 `near`；全局视图统计全部。由 `milestoneMatches`（`state.js:266`）开头的 team 分支实现，与 `rowMatches` 项目向口径一致。注意里程碑统计走 `milestoneMatches` 而非 `rowMatches`。

---

## 6. API 设计

### 6.1 团队 CRUD（新增，与 projects 同级）

| Method | Path | Body / 说明 |
| --- | --- | --- |
| `POST` | `/api/teams` | `{name, color, description}` → `{id}` |
| `PUT` | `/api/teams/{id}` | 改名 / 颜色 / 说明 / `archived` |
| `DELETE` | `/api/teams/{id}` | 删除：其下人员 `home_team_id` / 项目 `team_id` **迁移到默认团队**（`tm_default`）+ 清 `settings` 中该 team_id 偏好；**不级联删人员/项目**（它们只换归属）。**默认团队不可删**（保证系统始终有一个兜底归属团队）。 |

路由接入：`do_POST`（`server.py:518`）、`do_PUT`（`server.py:541`）、`do_DELETE`（`server.py:563`）。

> ⚠️ **实现陷阱：teams 不能复用通用处理器，须显式路由。** 现有三处分发器形态不同：
> - `do_POST`（`:518`）是**显式 `if parsed.path == ...` 分支**，直接加 `if parsed.path == "/api/teams": return self.create_team(data)` 即可。
> - `do_PUT`（`:541`）是**通用 `/api/{table}/{id}`**，只对 `people/projects/assignments/milestones` 分发；`teams` 需在通用分支前加显式判断（`if len(parts)==3 and parts[1]=='teams'`）。
> - `do_DELETE`（`:563`）是**通用 `DELETE FROM {table} WHERE id=?` 硬删除**（靠 `ALLOWED_TABLES` 白名单 + `ON DELETE CASCADE`）。**团队删除语义不同**（迁移归属而非级联清空），故 `teams` **必须**在通用分支之前显式拦截：校验非默认团队 → `UPDATE people SET home_team_id='tm_default' WHERE home_team_id=?` + `UPDATE projects SET team_id='tm_default' WHERE team_id=?` + `DELETE FROM settings WHERE team_id=?` + `DELETE FROM teams WHERE id=?`。把 `teams` 加进 `ALLOWED_TABLES` 走通用删除是**错误**的（会留下无归属的 `home_team_id`/`team_id` 游离值，违反归属强制性）。

### 6.2 现有接口扩展

- `POST/PUT /api/people`（`create_person` `server.py:602` / `update_person` `:604`）：body 加 `homeTeamId`（**必填**，校验非空且存在于 `teams`，否则 400）。注意这两处都是位置式 `INSERT`/`UPDATE`，须随第 11 节改写为显式列名表（见 3.2 陷阱）。
- `POST/PUT /api/projects`（`create_project` `server.py:627` / `update_project` `:635`）：body 加 `teamId`（**必填**，同上校验）。同样需改写位置式语句。
- `GET /api/bootstrap`（`server.py:464`）：返回体新增 `teams` 数组；`people` SELECT（`:472`）补 `home_team_id AS homeTeamId`、`projects` SELECT（`:473`）补 `team_id AS teamId`。
  - **per-team settings 取数**：当前 `GET /api/bootstrap` **不接受任何查询参数**（`do_GET` 仅按 `parsed.path` 分发）。新增可选 `?team=<id>`：返回 `settings` 时按 `team_id IN ('', ?)` 取两档，**前端以「团队档覆盖全局档」合并**（全局档兜底，对应 Q3「新建团队复制全局档」）。无 `team` 参数时只返回 `team_id=''` 全局档（向后兼容旧前端）。
- `POST /api/settings`（`save_setting` `server.py:583`）：当前 `INSERT … ON CONFLICT(key) DO UPDATE`。迁移到 `(team_id, key)` 复合主键后须改为：body 带 `teamId`（默认 `''`），`INSERT INTO settings (team_id,key,value) VALUES (?,?,?) ON CONFLICT(team_id,key) DO UPDATE SET value=excluded.value`。前端 `app.js` 三处保存（viewMode `:43` / customDays `:159` / printOptions `:907`）均需带上当前 `activeTeam`。

### 6.3 返回约定

沿用 `AGENTS.md`：成功 `{"ok": true}` 或返回 `id`；失败 `{"error": "..."}`；前端统一驼峰（`homeTeamId` / `teamId` / `teams`）。

---

## 7. 前端模块改动矩阵

| 文件 | 改动 |
| --- | --- |
| `state.js` | `state.teams`；`people` 项带 `homeTeamId`、`projects` 项带 `teamId`；`activeTeam` + setter + localStorage；`switchTeam()`；`rowMatches` 加团队项目向过滤；`clearFilters` 不清团队（独立切换器）。**不改** `totalHours/loadRate/isConflictCell`（全局不变量） |
| `panels.js` | 工具栏团队切换 `<select>`；`renderResourceBody`（`panels.js:200`）加 team 过滤；设置页新增「团队」tab（CRUD）；人员编辑表单加 home_team 单选、项目表单加 team 单选；人员视图借调标签 |
| `api.js` | bootstrap 拉取 `teams` + per-team settings（`api.js:91` `load`）；`savePerson/saveProject` 带 `homeTeamId/teamId`；团队 CRUD 调用 |
| `app.js` | 切换器事件 + `switchTeam`；viewMode（`app.js:43`）/ customDays（`:159`）/ printOptions（`:907`）保存带当前 team_id |
| `calendar.js` | 排期条按 `project.team_id` 过滤（团队视图聚焦）；行集合随 `rowMatches` |
| `i18n.js` | 团队 / 全部团队 / 团队管理 / 借调 / 请选择团队 等文案（zh/en） |
| `index.html` / `main.css` | 工具栏切换器 DOM + 借调标签样式 + 表单单选样式 |

---

## 8. CSV 往返（单值列）

矩阵模型下团队为单一归属，CSV 用单值列（不再需要 `|` 分隔）：

- **导出** `export_csv`（`server.py:859`）：表头（`:863`）新增 `团队` / `人员所属团队` 两列；两条聚合 `SELECT`（排期 `:868`、里程碑 `:898`）需 `JOIN teams` 取名称——排期行 `JOIN teams t ON t.id=pr.team_id` 写项目团队名、人员向 `JOIN teams ht ON ht.id=p.home_team_id` 写人员所属团队；里程碑行团队随项目。
- **导入** `import_csv`（`server.py:720`）：读 `团队` / `人员所属团队` 列，按名称匹配 `teams`（导入起始一次性 `SELECT id,name FROM teams` 建内存映射）；**不自动新建团队**，匹配不到则归到默认团队 `tm_default`，并在结果里新增 `unmatchedTeam` 计数（「未匹配 N 条，已归默认团队」）。新建 person/project 时写入归属。
  - ⚠️ **同样命中位置式 INSERT 陷阱**：导入新建项目（`:770`）、新建人员（`:821`）均为位置式 `VALUES`，须随第 11 节改写为显式列名表并补 `team_id` / `home_team_id`。

里程碑行的团队随项目（`project.team`）。

---

## 9. 初始化数据与无感升级

### 9.1 无感升级（强制归属）

现有数据无团队概念，但隔离模型要求每条数据有明确归属。迁移时**显式建一个默认团队并把存量数据归到它名下**：

1. 建默认团队实体（固定 id `tm_default`，名称如「通用」，用户可重命名）。
2. 所有现有人员 `home_team_id` / 项目 `team_id` 填为 `tm_default`（迁移后**无 `''` 残留**）。
3. 单团队用户：切换器为「通用 / 全部团队」，把「通用」重命名为公司名即可长期单团队使用，**完全无感**。

> 为何不留 `''` 兜底：`''` 会让归属字段同时承担「无团队数据」与「全部团队视图」两重含义，制造游离数据（切到具体团队时这些数据「消失」找不到）并迫使 CSV / 统计 / 访问控制处处特判 `''`。强制归属 + 显式默认团队让模型干净——每条数据都有家，`''` 只留在视图状态（`activeTeam`）与 settings 视图档里。

### 9.2 初始化数据

`config/initial-data.json.example` + `seed_from_initial_data`（`server.py:229`）扩展：

```json
{
  "version": "0.0.4",
  "dailyCapacity": 8,
  "teams": [
    {"id":"tm_ec","name":"电商团队","color":"#7db7ff","description":""}
  ],
  "people":   [{"id":"p_alice","name":"Alice","department":"研发部","role":"前端","dailyCapacity":8,"homeTeamId":"tm_ec"}],
  "projects": [{"id":"pr_demo","name":"示例项目","owner":"","priority":"高","color":"#7db7ff","startDate":"2026-01-01","endDate":"2026-12-31","teamId":"tm_ec"}],
  "milestones": [{"id":"ms_demo","projectId":"pr_demo","name":"示例里程碑","date":"today+7","level":"important","owner":"Alice","description":""}],
  "assignments": [{"id":"a_demo","personId":"p_alice","projectId":"pr_demo","startDate":"today","endDate":"today+5","hours":8,"note":"示例排期"}]
}
```

无 `teams` 的旧 initial-data 仍可加载：seed 时若无团队，自动用默认团队 `tm_default` 兜底归属（向后兼容）。

---

## 10. 边界与一致性

- **删团队**：其下人员 `home_team_id` / 项目 `team_id` **迁移到默认团队**（`tm_default`）；清 `settings` 中该 team_id 偏好（settings 无 FK 到 teams，手动删）。人员/项目本身保留。默认团队不可删。
- **删人员 / 项目**：`ON DELETE CASCADE`（`server.py:198` 已开 `PRAGMA foreign_keys = ON`）清相关排期/里程碑；归属列随之消失（行已删）。
- **归档团队**：切换器与下拉隐藏；已归属数据保留。
- **借调**：无需特殊机制；A 团队的人（`home_team=A`）排到 B 团队项目（`team=B`）即借调，在 B 的团队视图里显示并标「借调」。
- **冲突全局**：任何视图下，`isConflictCell` 基于全量排期（不变量）。
- **全局编辑锁**：未配置密码时主服务可写；配置后需输入全局编辑密码。独立分享端口始终只读。
- **「全部团队」（`activeTeam=''`）**：视图不过滤 + 用全局档偏好，旧行为完全保留（向后兼容）。
- **撤销栈**：团队 CRUD / 归属变更纳入 undo（沿用 `state.js` undo 机制）。

---

## 11. 数据库迁移策略

迁移分两半，**必须同一版本一起落地**：A 是源码改动（编译期），B 是运行时迁移（`init_db` 启动期）。只做 B 不做 A，旧的位置式 `INSERT` 会因列数对不上立即崩；只做 A 不做 B，列不存在同样崩。

沿用 `PRAGMA table_info` + `ALTER TABLE` 模式（`server.py:370` 一带）。

### A. 源码改动（随版本提交）

**A1. 把 6 处位置式 `INSERT` 改写为显式列名表**（见 3.2 陷阱），并在值列表补上新列：

| 位置 | 现状 | 改写后 |
| --- | --- | --- |
| `seed_from_initial_data` people `server.py:239` | `INSERT OR IGNORE INTO people VALUES (…10)` | `INSERT OR IGNORE INTO people (id,name,department,role,daily_capacity,created_at,updated_at,sort_order,archived,color,home_team_id) VALUES (…11)`，末位取 `item.get('homeTeamId') or 'tm_default'` |
| `seed_from_initial_data` projects `:257` | `… projects VALUES (…11)` | 显式列名表 + 末位 `team_id`，取 `item.get('teamId') or 'tm_default'` |
| `create_person` `:602` | `INSERT INTO people VALUES (…10)` | 显式列名表 + 末位 `d.get('homeTeamId')`（已校验非空） |
| `create_project` `:633` | `… projects VALUES (…11)` | 显式列名表 + 末位 `d.get('teamId')` |
| `import_csv` projects `:770` | 位置式 11 列 | 显式列名表 + `team_id`（按名称匹配，未匹配归 `tm_default`） |
| `import_csv` people `:821` | 位置式 10 列 | 显式列名表 + `home_team_id`（同上） |

> `assignments`/`milestones` 不加列，其位置式插入（`server.py:843`/`:796`）**保持不动**。

**A2. `update_person`/`update_project`（`:604`/`:635`）**：归属变更走普通 `UPDATE … SET home_team_id=?`（已校验），不涉及列数问题，但需在 `SET` 子句补归属列与校验。

**A3. `save_setting`（`:583`）**：`ON CONFLICT(key)` → `ON CONFLICT(team_id,key)`，`INSERT` 三列含 `team_id`（见 6.2）。

### B. 运行时迁移（`init_db` 内，幂等）

1. `teams` 用 `CREATE TABLE IF NOT EXISTS`（首次即建）。
2. **建默认团队**：`INSERT OR IGNORE INTO teams(id,name,color,description,sort_order,archived,created_at,updated_at) VALUES ('tm_default','通用','#7db7ff','',0,0,…,…)`（固定 id，幂等）。
3. `people.home_team_id` / `projects.team_id`：`PRAGMA table_info` 检测缺失则 `ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT ''`（SQLite 允许 `NOT NULL` 加列仅当带 `DEFAULT`）；**随即** `UPDATE people SET home_team_id='tm_default' WHERE home_team_id=''` 与 `UPDATE projects SET team_id='tm_default' WHERE team_id=''`，**消除所有 `''`**。
4. `settings` 表迁移：检测旧主键形态（`PRAGMA table_info(settings)` 无 `team_id` 列）→ 建 `settings_new(team_id, key, value, PRIMARY KEY(team_id,key))` → `INSERT INTO settings_new SELECT '', key, value FROM settings` → `DROP TABLE settings` → `ALTER TABLE settings_new RENAME TO settings`。（`settings.team_id=''` 合法 = 「全部团队」视图档，属视图状态，不违反归属强制性。）
5. 迁移在 `init_db()`（`server.py:312`）内、首次连接幂等执行；现有真实库 `data/scheduler.sqlite`（57KB）必须在其上一次跑通且重复启动不报错。

### C. 迁移后断言（DoD 第 2–3 项）

- `teams` 含 `tm_default`；`people`/`projects` 归属列**无 `''`**（均为真实 team id）；`settings` 主键为 `(team_id, key)`。
- 6 处 `INSERT` 全部为显式列名表：`grep -nE "INSERT( OR IGNORE)? INTO (people|projects) VALUES" server.py` **无输出**（该正则仅命中「表名与 `VALUES` 之间无列名表」的位置式写法，显式列名表因含 `(…)` 不会被命中）。

---

## 12. 实现切片（Wave）

建议串行为主，独立项并行（避免共享 `state.js` / `panels.js` 并行冲突）：

| Wave | 范围 | 主要拥有文件 |
| --- | --- | --- |
| W1 | DB 迁移 + 单测（teams 表 + 两归属列 + settings 演进 + 级联回归） | `server.py` `init_db` |
| W2 | 后端 API：teams CRUD + bootstrap 序列化（homeTeamId/teamId）+ people/projects 归属保存 | `server.py` Handler |
| W3 | seed + CSV 往返（initial-data 团队列 + 导入导出） | `server.py`、`config/initial-data.json.example` |
| W4 | 前端切换器 + `rowMatches` 团队过滤 + 排期条过滤 + 资源池过滤（**不改负载/冲突**） | `state.js`、`panels.js`、`calendar.js`、`app.js` |
| W5 | 前端表单 / 管理：人员 home_team 单选、项目 team 单选、设置页团队 tab、借调标签 | `panels.js`、`index.html`、`main.css` |
| W6 | per-team 视图偏好：settings team_id 维度 + `switchTeam` 状态机 + localStorage namespace | `state.js`、`api.js`、`app.js`、`server.py` settings |
| W7 | i18n + 只读验证 + 全量回归（拖拽/撤销/统计/冲突全局性/打印） | `i18n.js`、回归 |

---

## 13. 验证与上线标准（Definition of Done）

沿用 `docs/iteration-plan.md` 第 7 节基线，补充本特性专项：

1. **语法/编译**：改动过的 `public/js/*.js` 通过 `node --check`；`python3 -m py_compile server.py` 通过；`./macos/build-mac-app.sh` 构建成功。
2. **迁移幂等**：在已有 `0.0.3` 数据库上启动 → 迁移成功、建出默认团队 `tm_default`、存量人员/项目归属列**均为 `tm_default`（无 `''` 残留）**；重复启动不报错。**必须用真实库 `data/scheduler.sqlite` 实跑一遍**（非空库），断言：`teams` 含 `tm_default`；`SELECT COUNT(*) FROM people WHERE home_team_id=''` 与 `… FROM projects WHERE team_id=''` 均为 0；`settings` 主键为 `(team_id, key)`。
3. **★ 位置式 INSERT 已清零**：`grep -nE "INSERT( OR IGNORE)? INTO (people|projects) VALUES" server.py` **无输出**（6 处已全部改写为显式列名表）；否则 `create_person`/`create_project`/`import_csv` 在新列上必崩。
4. **隔离正确**：切换团队 → 日历/资源池按 `project.team_id` 收窄；切回「全部」恢复全局。
5. **★ 冲突全局不变量**：构造跨团队借调（A 团队的人在 A、B 两团队项目各排 4h），在 A 团队视图下该人当日负载仍为 100%（8h）、不漏报冲突。
6. **借调**：A 团队的人排到 B 团队项目 → B 团队视图显示该人并标「借调」；该人 home_team 仍为 A。
7. **per-team 偏好**：A、B 团队切换时 viewMode/customDays/printOptions 互不覆盖。
8. **CSV 往返**：导出含团队列；导入回读正确建立归属，未匹配的归默认团队并提示。
9. **删团队迁移语义**：删除非默认团队 → 其人员/项目**迁到 `tm_default`**（不消失）、该 team_id 的 settings 清除；`DELETE /api/teams/tm_default` → 400/拒绝。
10. **编辑锁回归**：无密码时团队 CRUD 可用；配置密码后未解锁拒绝写；分享端口始终拒绝写。
11. **回归不退化**：拖拽、撤销、统计下钻、冲突解决、打印（printOptions per-team）均正常。
12. **文档同步**：README 必要处同步；`AGENTS.md` 核心业务对象（`:35` 起）补 `teams`；本文档勾选完成状态。

> 实现前自检：本文行号锚点对齐 `0.0.3`（2026-06-17）。若期间 `server.py`/`public/js/*` 有改动，实现者须用 `grep`/`PRAGMA table_info` 重新核对锚点，避免引用漂移。

### 13.1 实现完成状态（2026-06-17）

| DoD | 结果 |
| --- | --- |
| 1. 语法/编译 | ✅ `node --check` 全 7 个 JS 通过；`py_compile server.py` 通过；`./macos/build-mac-app.sh` 构建出 `Team Calendar.app`（Swift `-O` 编译无错） |
| 2. 迁移幂等 | ✅ 真实库 `data/scheduler.sqlite`（12 人/11 项目/63 排期/14 里程碑/2 设置）副本上迁移两次均成功：建出 `tm_default`、归属列无 `''`、无游离引用、`settings` 主键为 `(team_id,key)`、行数零丢失 |
| 3. 位置式 INSERT 清零 | ✅ `grep -nE "INSERT( OR IGNORE)? INTO (people|projects) VALUES" server.py` 输出 0；6 处全部改写为显式列名表 |
| 4. 隔离正确 | ✅ Node 逻辑测试：`rowMatches` 项目向过滤（teamA 仅显示 teamA 项目）、人向 `personInTeam`（home 或借调）均通过 |
| 5. ★ 冲突全局不变量 | ✅ 构造跨团队借调（张三 home=A，A 项目 4h + B 项目 4h）：teamA 视图下 `totalHours=8`/负载 100%；再加 1h → 全局冲突被检出（`isConflictCell=true`，溢出 1h） |
| 6. 借调 | ✅ `personInTeam` 判定 + `calendar.js` 借调标签（`home_team ≠ 当前团队` 时渲染 `.borrowed-tag`） |
| 7. per-team 偏好 | ✅ `bootstrap?team=` / `GET /api/settings?team=` 团队档覆盖全局档；`switchTeam` 状态机持久化+回填；A/B 团队 viewMode/customDays/printOptions 互不覆盖 |
| 8. CSV 往返 | ✅ 导出含 `团队`/`人员所属团队` 列；导入按名称匹配、未匹配计 `unmatchedTeam` 并归默认团队 |
| 9. 删团队迁移语义 | ✅ 删非默认团队 → 人员/项目迁 `tm_default`、该 team_id settings 清除；`DELETE /api/teams/tm_default` → 400 |
| 10. 编辑锁回归 | ✅ 已由全局编辑锁替代：无密码可写、配置密码需解锁、分享端口强制只读 |
| 11. 回归不退化 | ✅ `totalHours/loadRate/isConflictCell/overflowHours` 未改动（全局不变量保留）；拖拽/撤销/排序/打印链路代码未触碰；全模块图 DOM-shim 顶层求值通过 |
| 12. 文档同步 | ✅ `AGENTS.md` 核心业务对象补 `teams` + 归属字段；`server.py` 版本号升至 0.0.4；本文档勾选完成状态 |

---

## 14. 决策记录（开放问题已全部闭环）

6 项待定点均已确认，落地按此执行。正文对应章节已有详细说明。

| # | 问题 | 最终决定 | 依据 |
| --- | --- | --- | --- |
| Q1 | 团队视图统计口径 | **A**：分子含借调工时、分母仅 home 成员产能（负载率偏高，含义「团队项目占多少人力」）；全局视图给准确人效兜底 | 5.1。未选 B：会隐藏被借调者的忙碌，与「冲突全局算」不变量打架（见 4.4） |
| Q2 | `focusDate` 是否 per-team | 全局 | 翻页为临时操作；若后续要和 viewMode per-team 对齐，加 `rc_focusDate:<teamId>` |
| Q3 | 新建团队首次切换的默认偏好来源 | 复制全局档（`settings.team_id=''`）值 | — |
| Q4 | 默认团队形态 | 显式默认团队 `tm_default`（实体化、不可删），强制归属，`''` 不进数据字段 | 9.1 / 11 |
| Q5 | 团队视图「人员视图」行集合 | **A**：参与 X 团队项目的人（含借调），排期条只渲染本团队项目；负载/冲突全局算 | 4.2。未选 B：会致排期条悬空、负载与可见排期脱节 |
| Q6 | 编辑权限模型 | 单一全局编辑密码；不做团队级密码 | 默认只读，解锁后全局可编辑 |

---

## 15. 与 0.1.0 访问控制的关系

`AGENTS.md` 在 `0.1.0` 规划了「团队 / 租户概念」。本特性的「团队工作区」是**单租户内的多团队隔离**——不引入鉴权与数据隔离边界（假定使用者可切任何团队），仅做组织维度与视图切分。它为 `0.1.0` 平滑预留演进路径：

- `teams` 表可升级为 `tenants` / `orgs`。
- per-team `settings`（`(team_id, key)`）天然支持 per-租户配置。
- 单一归属模型（`home_team_id` / `team_id`）兼容未来「一人多租户」的扩展（届时再升多对多）。
- 访问控制采用单一全局编辑密码，不把团队视图升级为权限边界。

本期数据关系不做破坏性假设；0.1.0 在团队之上叠加访问控制即可。

---

## 16. 修订记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-06-18 | 0.0.4 修复 | **里程碑统计团队过滤缺失（bugfix）**：`milestoneMatches`（`state.js:266`）缺 `activeTeam` 分支，导致切换团队后头部里程碑统计（`ms`/`near`）不随团队收窄，与 `rowMatches` 项目向口径不一致（产能/负载等已 per-team，唯独里程碑漏过）。已补 team 判断（里程碑随 `project.team_id` 继承归属）；同步本文档第 5 节矩阵表（拆出里程碑统计行 + 行号锚点 `panels.js:240`→`290`）与 5.1 节（补里程碑 `ms`/`near` 团队口径）。日历里程碑标记（`calendar.js:165`）共用同一函数一并修正。 |
| 2026-06-17 | 0.0.4 已实现 | **全量落地**：后端（`init_db` teams 表 + 两归属列 + settings 复合主键迁移、6 处 INSERT 改显式列名表、teams CRUD + 显式路由、bootstrap/`GET /api/settings` 的 `?team=` 合并、seed + CSV 团队列往返）+ 前端（`state.js` activeTeam/per-team 偏好/`rowMatches` 项目向过滤/`personInTeam`、`calendar.js` 排期条团队过滤 + 借调标签、`panels.js` 资源池过滤 + 人员/项目归属单选 + 设置页团队 tab + team CRUD + 统计 A 口径、`app.js` 切换器 + `switchTeam` 状态机、i18n zh/en、index.html/main.css）。DoD 12 项全过（见 13.1）。版本号升至 0.0.4。 |
| 2026-06-17 | 0.0.4 设计定稿 | **代码对齐加固**：全文 `server.py` / `public/js` 行号锚点重新核对至 0.0.3 现状（此前整体漂移约 90 行）；补齐三类实现陷阱——① **6 处位置式 `INSERT … VALUES` 必须改写为显式列名表**（3.2 / 11.A1 / DoD-3，否则加列即崩）；② **`teams` 不能复用通用 `do_PUT`/`do_DELETE` 处理器**（删团队=迁移非级联，6.1）；③ **`GET /api/bootstrap` 需新增 `?team=` 参数**、`save_setting` 改 `ON CONFLICT(team_id,key)`（6.2）。第 11 节重构为「源码改动 A / 运行时迁移 B / 断言 C」三段并附 6 处 INSERT 改写对照表；DoD 由 10 项扩至 12 项（新增「位置式 INSERT 清零」「删团队迁移语义」+ 真实库实跑断言）。状态由 🟡 设计中 升为 🟢 设计定稿（仍未实现）。 |
| 2026-06-17 | 0.0.4 草案 | 初版：矩阵式模型、团队/全局双视图、API、迁移、Wave 切片、DoD；6 项开放问题闭环（Q1–Q6）。 |

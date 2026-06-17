# 团队工作区（Team Workspace）功能设计 · Resource Scheduler

> 目标版本：`0.0.4`（草案）
> 维护说明：本文是「团队工作区」特性的单一事实来源（single source of truth）。记录已确认的矩阵式数据模型、团队/全局双视图、API、交互与边界；**当前状态为设计中（Draft），尚未实现**，是否落地待评审。
> 上线要求（Definition of Done）见文末「验证与上线标准」。
> 关联文档：`AGENTS.md`（开发约束）、`docs/iteration-plan.md`（迭代主线）。
> 历史：本文取代早期的「业务线（多对多 + 视图切分）」方向，该方向已废弃。

---

## 0. 状态

| 项 | 值 |
| --- | --- |
| 状态 | 🟡 设计中（Draft，未实现） |
| 创建 / 更新 | 2026-06-17 |
| 方向 | 单一租户 · 多团队隔离（**矩阵式**：人单属 home team、项目单属 team，排期实现跨团队借调） |
| 目标版本 | `0.0.4` |
| 依赖 | 无新增第三方库；复用现有 `http.server` + `sqlite3` + 原生 ES Modules |

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

**给 `people` / `projects` 加单一归属列**（沿用 `PRAGMA table_info` 迁移模式，`server.py:275` 一带）。归属字段**永不为空**——加列时的 `DEFAULT ''` 仅是迁移瞬间的占位，迁移随即建「默认团队」并把 `''` 全部填为真实团队 id（见第 11 节）；应用层（`create_person`/`create_project`）强制要求传入合法 team id：

```sql
-- 加列（临时默认值，仅迁移用）
ALTER TABLE people   ADD COLUMN home_team_id TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN team_id      TEXT NOT NULL DEFAULT '';
-- 迁移随即执行（第 11 节），消除所有 ''：
--   建默认团队 tm_default
--   UPDATE people   SET home_team_id='tm_default' WHERE home_team_id='';
--   UPDATE projects SET team_id     ='tm_default' WHERE team_id='';
```

**演进 `settings`（加 team_id 维度）**：

```sql
-- 旧（server.py:268）：settings (key TEXT PRIMARY KEY, value TEXT)
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

实现含义：`rowMatches` / 资源池渲染按团队过滤（控制**显示哪些行**），但 `totalHours` / `loadRate` / `isConflictCell` / `overflowHours`（`state.js:469` 起）**不改动**——它们本就基于全量 `state.assignments` 计算，天然全局。仅「排期条是否渲染」受团队过滤。

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
| 日历行（显示哪些） | `rowMatches` | **per-team**（项目向过滤） | `state.js:81` | `rowMatches` 加 team 判断 |
| 日历负载/冲突（颜色/徽标） | `totalHours`/`loadRate`/`isConflictCell` | **全局（不变量）** | `state.js:469` 起 | **不改** |
| 排期条渲染 | `rowMatches` + 团队项目过滤 | per-team | `calendar.js` | 排期条按 `project.team_id` 过滤 |
| 资源池 `renderResourceBody` | `state.*.filter` | **per-team** | `panels.js:199` | 加 team 过滤 |
| 统计 `renderStats` | `rowMatches` | per-team（行集合）；负载全局 | `panels.js:239` | 行过滤随 `rowMatches`；统计口径见 5.1 |
| 视图偏好 viewMode/customDays/printOptions | settings + localStorage | **per-team（新）** | `api.js:84` / `state.js:37` | settings 加 team_id 维度 + 切换整体替换 |
| 团队切换器（工具栏） | 新增 | **驱动轴** | `app.js` 工具栏 | 新增 |
| **设置页** 人员/项目/里程碑 | `state.*` 全量 | **全局**（管理全貌） | `panels.js:376` | **无需改**（天然全局）；表单加 home_team/team 单选 |
| 数据导入导出 | — | 绑当前团队 | `server.py:625` / `server.py:764` | CSV 加「团队」列 |

### 5.1 团队视图统计口径（已定 A，见 Q1）

团队视图「已分配/负载」采用 A 口径（分子含借调工时、分母仅 home 成员产能）：

- **分子（已用）** = `team_id=X` 项目上的排期工时（含借调人员贡献）。
- **分母（产能）** = `home_team_id=X` 人员的产能。

此口径下借调工时计入分子、借调人员产能不在分母，**负载率会偏高**（管理含义：「我们团队的项目占用了多少人力」）。**全局视图给出准确的「人效/负载」**。两视图各有侧重、互为补充。

---

## 6. API 设计

### 6.1 团队 CRUD（新增，与 projects 同级）

| Method | Path | Body / 说明 |
| --- | --- | --- |
| `POST` | `/api/teams` | `{name, color, description}` → `{id}` |
| `PUT` | `/api/teams/{id}` | 改名 / 颜色 / 说明 / `archived` |
| `DELETE` | `/api/teams/{id}` | 删除：其下人员 `home_team_id` / 项目 `team_id` **迁移到默认团队**（`tm_default`）+ 清 `settings` 中该 team_id 偏好；**不级联删人员/项目**（它们只换归属）。**默认团队不可删**（保证系统始终有一个兜底归属团队）。 |

路由接入：`do_POST`（`server.py:437`）、`do_PUT`（`server.py:458`）、`do_DELETE`（`server.py:473`）。

### 6.2 现有接口扩展

- `POST/PUT /api/people`（`server.py:497` / `server.py:509`）：body 加 `homeTeamId`（**必填**，校验非空且存在于 `teams`，否则 400）。
- `POST/PUT /api/projects`（`server.py:532` / `server.py:540`）：body 加 `teamId`（**必填**，同上校验）。
- `GET /api/bootstrap`（`server.py:376`）：返回体新增 `teams` 数组；`people` 项带 `homeTeamId`、`projects` 项带 `teamId`；`settings` 按 `activeTeam` 返回对应档。

### 6.3 返回约定

沿用 `AGENTS.md`：成功 `{"ok": true}` 或返回 `id`；失败 `{"error": "..."}`；前端统一驼峰（`homeTeamId` / `teamId` / `teams`）。

---

## 7. 前端模块改动矩阵

| 文件 | 改动 |
| --- | --- |
| `state.js` | `state.teams`；`people` 项带 `homeTeamId`、`projects` 项带 `teamId`；`activeTeam` + setter + localStorage；`switchTeam()`；`rowMatches` 加团队项目向过滤；`clearFilters` 不清团队（独立切换器）。**不改** `totalHours/loadRate/isConflictCell`（全局不变量） |
| `panels.js` | 工具栏团队切换 `<select>`；`renderResourceBody`（`panels.js:199`）加 team 过滤；设置页新增「团队」tab（CRUD）；人员编辑表单加 home_team 单选、项目表单加 team 单选；人员视图借调标签 |
| `api.js` | bootstrap 拉取 `teams` + per-team settings；`savePerson/saveProject` 带 `homeTeamId/teamId`；团队 CRUD 调用 |
| `app.js` | 切换器事件 + `switchTeam`；viewMode/customDays/printOptions 保存带当前 team_id |
| `calendar.js` | 排期条按 `project.team_id` 过滤（团队视图聚焦）；行集合随 `rowMatches` |
| `i18n.js` | 团队 / 全部团队 / 团队管理 / 借调 / 请选择团队 等文案（zh/en） |
| `index.html` / `main.css` | 工具栏切换器 DOM + 借调标签样式 + 表单单选样式 |

---

## 8. CSV 往返（单值列）

矩阵模型下团队为单一归属，CSV 用单值列（不再需要 `|` 分隔）：

- **导出** `export_csv`（`server.py:764`）：加列 `团队`（项目行写 `project.team` 名称）、`人员所属团队`（人员向写 `person.home_team` 名称）。
- **导入** `import_csv`（`server.py:625`）：读 `团队` / `人员所属团队` 列，按名称匹配 `teams`；**不自动新建**，匹配不到则归到默认团队 `tm_default`，并在结果里计入「未匹配 N 条，已归默认团队」。新建 person/project 时写入归属。

里程碑行的团队随项目（`project.team`）。

---

## 9. 初始化数据与无感升级

### 9.1 无感升级（强制归属）

现有数据无团队概念，但隔离模型要求每条数据有明确归属。迁移时**显式建一个默认团队并把存量数据归到它名下**：

1. 建默认团队实体（固定 id `tm_default`，名称如「通用」，用户可重命名）。
2. 所有现有人员 `home_team_id` / 项目 `team_id` 填为 `tm_default`（迁移后**无 `''` 残留**）。
3. 单团队用户：切换器为「通用 / 全部团队」，把「通用」重命名为公司名即可长期单团队使用，**完全无感**。

> 为何不留 `''` 兜底：`''` 会让归属字段同时承担「无团队数据」与「全部团队视图」两重含义，制造游离数据（切到具体团队时这些数据「消失」找不到）并迫使 CSV / 统计 / 只读分享处处特判 `''`。强制归属 + 显式默认团队让模型干净——每条数据都有家，`''` 只留在视图状态（`activeTeam`）与 settings 视图档里。

### 9.2 初始化数据

`config/initial-data.json.example` + `seed_from_initial_data`（`server.py:134`）扩展：

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
- **删人员 / 项目**：`ON DELETE CASCADE`（`server.py:103` 已开 foreign_keys）清相关排期/里程碑；归属列随之消失（行已删）。
- **归档团队**：切换器与下拉隐藏；已归属数据保留。
- **借调**：无需特殊机制；A 团队的人（`home_team=A`）排到 B 团队项目（`team=B`）即借调，在 B 的团队视图里显示并标「借调」。
- **冲突全局**：任何视图下，`isConflictCell` 基于全量排期（不变量）。
- **只读端口**：`reject_if_readonly`（`server.py:417`）已覆盖全部写操作，团队 CRUD 自动被拒；切换器 + per-team 偏好纯前端可用。
- **「全部团队」（`activeTeam=''`）**：视图不过滤 + 用全局档偏好，旧行为完全保留（向后兼容）。
- **撤销栈**：团队 CRUD / 归属变更纳入 undo（沿用 `state.js` undo 机制）。

---

## 11. 数据库迁移策略

沿用 `PRAGMA table_info` + `ALTER TABLE` 模式（`server.py:275` 一带）：

1. `teams` 用 `CREATE TABLE IF NOT EXISTS`（首次即建）。
2. **建默认团队**：`INSERT OR IGNORE INTO teams(id,name,color,...) VALUES ('tm_default','通用','#7db7ff',...)`（固定 id，幂等）。
3. `people.home_team_id` / `projects.team_id`：`PRAGMA table_info` 检测缺失则 `ALTER TABLE ADD COLUMN ... DEFAULT ''`；**随即** `UPDATE people SET home_team_id='tm_default' WHERE home_team_id=''` 与 `UPDATE projects SET team_id='tm_default' WHERE team_id=''`，**消除所有 `''`**。
4. `settings` 表迁移：检测旧主键形态 → 建 `settings_new(team_id, key, value)` → `INSERT INTO settings_new SELECT '', key, value FROM settings` → drop 旧表 → rename。（`settings.team_id=''` 合法 = 「全部团队」视图档，属视图状态，不违反归属强制性。）
5. 迁移在 `init_db()`（`server.py:217`）内、首次连接幂等执行。
6. 迁移后断言：`teams` 含 `tm_default`；`people`/`projects` 归属列**无 `''`**（均为真实 team id）；`settings` 主键为 `(team_id, key)`。

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
2. **迁移幂等**：在已有 `0.0.3` 数据库上启动 → 迁移成功、建出默认团队 `tm_default`、存量人员/项目归属列**均为 `tm_default`（无 `''` 残留）**；重复启动不报错。
3. **隔离正确**：切换团队 → 日历/资源池按 `project.team_id` 收窄；切回「全部」恢复全局。
4. **★ 冲突全局不变量**：构造跨团队借调（A 团队的人在 A、B 两团队项目各排 4h），在 A 团队视图下该人当日负载仍为 100%（8h）、不漏报冲突。
5. **借调**：A 团队的人排到 B 团队项目 → B 团队视图显示该人并标「借调」；该人 home_team 仍为 A。
6. **per-team 偏好**：A、B 团队切换时 viewMode/customDays/printOptions 互不覆盖。
7. **CSV 往返**：导出含团队列；导入回读正确建立归属，未匹配的归默认团队并提示。
8. **只读回归**：只读端口拒绝团队写操作；切换器可用。
9. **回归不退化**：拖拽、撤销、统计下钻、冲突解决、打印（printOptions per-team）均正常。
10. **文档同步**：README 必要处同步；`AGENTS.md` 核心业务对象补 `teams`；本文档勾选完成状态。

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
| Q6 | 团队级只读分享（按 team 过滤的 `/api/share`） | 本期不做，预留 | 归 0.1.0 访问控制 |

---

## 15. 与 0.1.0 访问控制的关系

`AGENTS.md` 在 `0.1.0` 规划了「团队 / 租户概念」。本特性的「团队工作区」是**单租户内的多团队隔离**——不引入鉴权与数据隔离边界（假定使用者可切任何团队），仅做组织维度与视图切分。它为 `0.1.0` 平滑预留演进路径：

- `teams` 表可升级为 `tenants` / `orgs`。
- per-team `settings`（`(team_id, key)`）天然支持 per-租户配置。
- 单一归属模型（`home_team_id` / `team_id`）兼容未来「一人多租户」的扩展（届时再升多对多）。
- 团队级只读分享（Q6）作为 0.1.0 访问控制的首个落点。

本期数据关系不做破坏性假设；0.1.0 在团队之上叠加访问控制即可。

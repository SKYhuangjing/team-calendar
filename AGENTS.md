# AGENTS.md

## 项目定位

本项目是一个基于日历视图的项目人力排期工具，当前版本为 `0.0.1`。核心目标是让管理者可以直观看到未来 `today - 1 ~ today + 30` 的项目、人力、工时占用和里程碑安排，并支持拖拽调整与 CSV 导入/导出。

## 技术栈约束

- 后端使用 Python 标准库 `http.server` + `sqlite3`，暂不引入 Flask/FastAPI/Django。
- 前端使用原生 HTML/CSS/JavaScript（ES Modules），暂不引入 React/Vue/构建工具。
- 数据持久化使用 SQLite：`data/scheduler.sqlite`。
- 首次运行预置数据使用：`config/initial-data.json`。
- 保持一条命令可运行：`python3 server.py`。

## 目录说明

```text
server.py                    # 后端 API、SQLite 初始化、CSV 导入导出
public/
  index.html                 # HTML 结构（纯结构，无内联样式/脚本）
  css/main.css               # 所有样式
  js/
    state.js                 # 全局状态、日期/颜色工具函数
    api.js                   # fetch 封装、数据加载、删除操作
    calendar.js              # 日历渲染、日期列计算、lane 堆叠、bar 样式
    interactions.js          # 拖拽（HTML5 drag + pointer move/resize）、键盘、右键菜单
    panels.js                # 模态框、资源抽屉、设置面板、统计栏、CSV 导入、toast
    app.js                   # 入口：启动、renderAll、setTab、事件绑定
config/initial-data.json     # 首次运行初始化数据
data/scheduler.sqlite        # 运行后自动生成，不要提交真实业务数据
README.md                    # 用户运行说明
AGENTS.md                    # 面向后续 AI/研发的开发约束
```

## 核心业务对象

### 团队 teams（0.0.4 起，一级实体）

字段：

- `id`
- `name`
- `color`
- `description`
- `sort_order`
- `archived`

团队是单租户内的组织维度与视图切分轴（矩阵式：人单属 home team、项目单属 team，排期实现跨团队借调）。`tm_default` 为系统默认团队（固定 id、不可删除），保证每条数据都有兜底归属。删除团队时其下人员/项目**迁移到默认团队**（不级联删除数据）。详见 `docs/team-workspace-design.md`。

### 人员 people

字段：

- `id`
- `name`
- `department`
- `role`
- `daily_capacity`
- `home_team_id`（单一归属，永不为空；矩阵式组织的「实线」）

### 项目 projects

字段：

- `id`
- `name`
- `owner`
- `priority`
- `color`
- `team_id`（单一归属，永不为空；项目是某团队的资产）

### 排期 assignments

字段：

- `id`
- `person_id`
- `project_id`
- `work_date`
- `hours`
- `note`

排期表示：某人在某天投入某项目多少小时。

### 里程碑 milestones

字段：

- `id`
- `project_id`
- `name`
- `milestone_date`
- `level`
- `owner`
- `description`

## 开发原则

1. 日历视图优先，任何新增功能不能明显挤压主日历区域。
2. 资源池、导入、导出、配置类能力应放入抽屉或设置页，不要长期占用日历空间。
3. 人员、项目、里程碑三个对象必须保持 CRUD 能力完整。
4. 拖拽交互必须支持：人员到项目日期、项目到人员日期、已有排期移动、里程碑移动。
5. 删除人员/项目时，依赖 SQLite 外键级联删除相关排期和里程碑。
6. CSV 导入要尽量兼容中文表头，至少支持：`日期、人员、项目`。
7. 不要恢复“当前 JSON / 复制 JSON / 重置 Demo”这些调试入口到主界面。
8. “重大节点”统一命名为“里程碑”。
9. 任何新增 API 都需要返回 JSON，并保持错误信息可读。
10. 不要把真实业务数据写死到代码里，预置数据统一放在 `config/initial-data.json`。

## 初始化数据规则

首次运行时，如果 `data/scheduler.sqlite` 不存在或 `people` 表为空，系统会读取 `config/initial-data.json` 写入预置数据。

支持字段：

```json
{
  "version": "0.0.1",
  "dailyCapacity": 8,
  "people": [
    {"name": "张三", "department": "研发部", "role": "后端", "dailyCapacity": 8}
  ],
  "projects": [
    {"name": "示例项目", "owner": "", "priority": "高", "color": "#7db7ff"}
  ],
  "milestones": [
    {"project": "示例项目", "name": "提测", "date": "today+7", "level": "important"}
  ],
  "assignments": [
    {"person": "张三", "project": "示例项目", "date": "today+1", "hours": 8, "note": "初始化排期"}
  ]
}
```

日期支持：

- 绝对日期：`2026-06-15`
- 相对日期：`today+1`、`today-1`、`today+30`

## API 约定

现有 API：

```text
GET    /api/bootstrap
GET    /api/export.csv
POST   /api/import.csv
POST   /api/people
PUT    /api/people/{id}
DELETE /api/people/{id}
POST   /api/projects
PUT    /api/projects/{id}
DELETE /api/projects/{id}
POST   /api/assignments
PUT    /api/assignments/{id}
DELETE /api/assignments/{id}
POST   /api/milestones
PUT    /api/milestones/{id}
DELETE /api/milestones/{id}
```

新增 API 时遵守：

- 成功：`{"ok": true}` 或返回新对象 `id`。
- 失败：`{"error": "可读错误信息"}`。
- 前端不要依赖数据库字段名，统一使用接口返回的驼峰字段。

## 后续优先级建议

### 0.0.2

- 增加按部门/角色筛选。
- 增加里程碑导入 CSV。
- 增加排期覆盖/去重策略，避免重复导入。
- 增加日期范围配置。

### 0.0.3

- 增加周/月视图切换。
- 增加项目维度统计图。
- 增加人员负载率热力提示。
- 增加 SQLite 备份/恢复。

### 0.1.0

- 拆分前后端模块。
- 增加登录和权限。
- 增加团队/租户概念。
- 支持 Docker 部署。


## 0.0.1 修正说明

- 项目编辑中的负责人字段已增强保存逻辑，支持直接输入人员姓名，并在项目视图左侧展示为“负责人：XXX”。
- 排期支持日期范围：每条排期包含开始日期 `date` 与结束日期 `endDate`，会在日历中从日期 A 到日期 B 每天展示。
- 拖拽已有排期到新日期时，会保留原持续天数并整体平移。
- CSV 导入可选 `结束日期` 列；不填写时默认为单日排期。

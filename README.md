# Resource Scheduler 0.0.1

基于日历视图的项目人力排期工具，支持项目、人员、里程碑、拖拽排期、SQLite 持久化、CSV 导入/导出。

## 运行

```bash
cd resource-scheduler-0.0.1
python3 server.py
```

打开：

```text
http://127.0.0.1:8787
```

## 首次运行预置数据

首次运行时会读取：

```text
config/initial-data.json
```

如果 `data/scheduler.sqlite` 不存在，或数据库中人员为空，会自动导入该文件中的人员、项目、里程碑、排期。

可参考 `config/initial-data.json.example` 编写自己的初始数据。

## 初始化 JSON 示例

```json
{
  "version": "0.0.1",
  "dailyCapacity": 8,
  "people": [
    {"name": "张三", "department": "研发部", "role": "后端", "dailyCapacity": 8}
  ],
  "projects": [
    {"name": "示例项目", "owner": "", "priority": "高", "color": "#7db7ff", "startDate": "2026-01-01", "endDate": "2026-12-31"}
  ],
  "milestones": [
    {"project": "示例项目", "name": "提测", "date": "today+7", "level": "important", "owner": "张三"}
  ],
  "assignments": [
    {"person": "张三", "project": "示例项目", "date": "today+1", "hours": 8, "note": "初始化排期"}
  ]
}
```

日期支持绝对日期 `2026-06-15`，也支持相对日期 `today+1`、`today-1`、`today+30`。

## CSV 导入

设置 → 数据 → 导入 CSV。

至少需要包含：

```csv
日期,人员,项目
2026-06-15,张三,示例项目
```

推荐格式：

```csv
日期,人员,部门,角色,项目,项目负责人,工时,备注
2026-06-15,张三,研发部,后端,示例项目,,8,接口开发
```

## 开发约束

后续开发请先阅读：

```text
AGENTS.md
```

## 功能说明

- 项目编辑支持负责人、优先级、颜色、起止日期设置
- 排期支持日期范围，拖拽保留持续天数整体平移
- 里程碑支持负责人指派，人员视图中按负责人展示
- 资源池支持人员/项目拖拽排序
- 项目日期范围约束：排期不能超出项目起止日期，日历格子灰显
- 人员/项目支持归档，归档后日历和下拉中不展示
- CSV 导入可选 `结束日期`、`项目开始日期`、`项目结束日期` 列

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

## Docker

```bash
docker build -t resource-scheduler .
docker run -d --name scheduler \
  -p 8787:8787 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  resource-scheduler
```

- `-v $(pwd)/data:/app/data` — SQLite 数据库持久化到宿主机 `data/` 目录
- `-v $(pwd)/config:/app/config` — 初始化数据和配置挂载到宿主机 `config/` 目录

停止并删除容器：

```bash
docker stop scheduler && docker rm scheduler
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

## macOS 客户端

项目提供一个原生 macOS WebView 客户端，用来在桌面窗口中打开当前排期网页，并通过工具栏分享局域网只读访问地址。

在 macOS 上构建：

```bash
./macos/build-mac-app.sh
```

构建完成后打开：

```text
build/macos/team-calendar.app
```

客户端行为：

- 客户端带有 `AppIcon.icns` 图标；构建脚本会从 `macos/create-app-icon.py` 生成 iconset/ICNS。
- 启动内置可编辑服务 `python3 server.py`，仅监听 `127.0.0.1:8787`，并在客户端窗口中打开该本机地址。
- 客户端数据默认写入 `~/Library/Application Support/TeamCalendar/data/scheduler.sqlite`，避免写入 `.app` 包内部；本机可编辑服务和分享只读服务都会显式使用这同一个 SQLite 文件。
- 如果打包资源里没有 `config/initial-data.json`，构建脚本会把 `config/initial-data.json.example` 复制为首次运行预置数据，避免新安装客户端和只读分享页空白。
- 点击工具栏「分享只读地址」时，客户端会调用本机服务的 `/api/share`，由同一个 Python 进程按需开启只读端口（默认 `8788`），监听 `0.0.0.0`，再复制并打开 macOS 分享面板。
- 分享地址格式为 `http://<本机局域网 IP>:8788/?readonly=1`；只读端口和本机可编辑端口共用同一个 `DB_PATH`，因此项目、人员、排期数据必须完全一致。即使访问者删除 `readonly=1` 也不能新增、编辑、删除或导入。
- 如果默认只读端口被占用，服务会自动尝试后续端口，并把实际可用端口返回给客户端，避免出现“无法读取只读分享地址”。
- Web 只读模式会隐藏资源编辑入口，并阻止前端发起新增、编辑、删除、导入等写操作；服务端也会拒绝只读端口上的所有写请求。

可选环境变量：

```bash
TEAM_CALENDAR_PORT=8790 TEAM_CALENDAR_READONLY_PORT=8791 ./build/macos/team-calendar.app/Contents/MacOS/TeamCalendarClient
DATA_DIR=/path/to/data python3 server.py
READONLY_SERVER=1 HOST=0.0.0.0 PORT=8788 DATA_DIR=/path/to/data python3 server.py
DB_PATH=/path/to/scheduler.sqlite python3 server.py
ALLOW_REMOTE_WRITE=1 HOST=0.0.0.0 python3 server.py
```

普通 Web 服务也支持生成只读分享地址；设置 `READONLY_PORT` 后，请求 `/api/share` 会在同一个 Python 进程内启动只读端口并返回该端口地址：

```bash
DB_PATH=/path/to/scheduler.sqlite HOST=127.0.0.1 READONLY_PORT=8788 python3 server.py
curl http://127.0.0.1:8787/api/share
```

如果必须手动起两个进程，也要给两个进程传入同一个 `DB_PATH`：

```bash
DB_PATH=/path/to/scheduler.sqlite HOST=127.0.0.1 python3 server.py
READONLY_SERVER=1 HOST=0.0.0.0 PORT=8788 DB_PATH=/path/to/scheduler.sqlite python3 server.py
```

## GitHub Actions 构建 DMG

仓库包含 tag 触发的 macOS DMG 构建流程：

```bash
git tag v0.0.1
git push origin v0.0.1
```

推送任意 tag 后，GitHub Actions 会在 macOS Runner 上执行：

```bash
./macos/build-dmg.sh "$GITHUB_REF_NAME"
```

也可以在 GitHub Actions 页面手动运行 `Build macOS DMG` workflow 做构建测试，手动运行时默认版本名为 `manual-test`，只上传 Artifact，不创建 Release。

产物：

```text
build/macos/team-calendar-<tag>.dmg
```

Workflow 会将 DMG 上传为 Actions Artifact，并自动创建/更新同名 GitHub Release 附件。

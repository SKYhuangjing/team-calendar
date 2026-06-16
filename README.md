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

### 0.0.2 / 0.0.3 新增

- **日期范围与多视图**：30 天 / 周 / 月 三种视图，‹ 今天 › 翻页并保留焦点日期。
- **筛选与搜索**：按部门 / 角色（多选）/ 项目 / 负责人筛选，名称模糊搜索，零命中给出空态，统计随筛选范围联动。
- **撤销**：删除排期 / 里程碑、移动、缩放、移动里程碑，以及删除人员 / 项目（级联）后均可一键撤销（最近 8 步）。
- **统计下钻与负载热力**：点击「已分配 / 负载」查看按人员 / 项目分布；人员行按当日负载率上色（绿→红）。
- **冲突定位**：点击「冲突」徽标高亮所有超产能格子并滚动到首个。
- **冲突解决**：右键人员视图的超产能格，可「减少工时至产能上限」或「平摊到相邻工作日」（多日排期按天拆分，不误伤其它天；目标受项目结束日约束；可撤销）。
- **里程碑到期**：临近里程碑脉冲高亮、逾期里程碑红色，显示「剩 N 天 / 逾期 N 天」。
- **FTE / 占比**：排期条与编辑表单展示占当日产能百分比。
- **暗色模式**：自动 / 亮 / 暗切换，跟随系统，记忆偏好。
- **国际化**：中 / 英切换，已抽取全部可见文案（工具栏、统计、筛选、表单、设置、抽屉、toast、确认、撤销、日历表头/提示/里程碑倒计时、主题按钮等）；优先级/级别保持规范数据值，仅显示层本地化。
- **节假日离线兜底**：内置 2026 节假日数据 + `/api/holidays` 接口，断网仍可判定休息日。
- **键盘可达性**：方向键移动选中条、焦点可见、关键控件 ARIA 标签。
- **大网格渲染**：`content-visibility` 跳过屏外行绘制，行/列多时更流畅，且不影响拖拽命中检测。

完整特性清单、验收标准与第三 / 四档（未启动）规划见 `docs/iteration-plan.md`。


## macOS 客户端

项目提供一个原生 macOS WebView 客户端，用来在桌面窗口中打开当前排期网页，并通过工具栏分享局域网只读访问地址。

在 macOS 上构建：

```bash
./macos/build-mac-app.sh
```

构建完成后打开：

```text
build/macos/Team Calendar.app
```

客户端行为：

- 客户端带有 `AppIcon.icns` 图标；构建脚本会从 `macos/create-app-icon.py` 生成 iconset/ICNS。
- 启动内置服务 `python3 server.py`，默认监听随机可用端口；客户端窗口仍然通过 `127.0.0.1` 打开该本机端口，保证本机访问稳定。
- 客户端数据默认写入 `~/Library/Application Support/TeamCalendar/data/scheduler.sqlite`，避免写入 `.app` 包内部；本机可编辑服务和分享只读服务都会显式使用这同一个 SQLite 文件。
- 如果打包资源里没有 `config/initial-data.json`，构建脚本会把 `config/initial-data.json.example` 复制为首次运行预置数据，避免新安装客户端和只读分享页空白。
- 点击工具栏「分享只读地址」时，客户端会调用本机服务的 `/api/share`，由同一个 Python 进程按需开启随机只读端口，监听 `0.0.0.0`，再弹出一个可编辑地址输入框；默认会带入当前检测到的 IP，但你可以手动改成任何局域网 IP、主机名或域名，然后再复制并打开 macOS 分享面板。
- 分享地址默认格式为 `http://<本机局域网 IP>:<只读端口>/`；只读端口和本机服务端口共用同一个 `DB_PATH`，因此项目、人员、排期数据必须完全一致。只读权限由独立只读端口保证，不依赖 URL 查询参数。
- 如果显式配置的只读端口被占用，服务会自动尝试后续端口，并把实际可用端口返回给客户端，避免出现“无法读取只读分享地址”。
- Web 只读模式会隐藏资源编辑入口，并阻止前端发起新增、编辑、删除、导入等写操作；服务端也会拒绝只读端口上的所有写请求。

客户端菜单与快捷键：

原生客户端安装了标准主菜单，并补齐了 Web 内部的键盘交互（在浏览器里同样可用）。

| 操作 | 快捷键 | 说明 |
| --- | --- | --- |
| 刷新页面 | `Cmd+R` 或工具栏刷新 | 重新加载排期页（原仅有工具栏按钮） |
| 撤销 / 重做 | `Cmd+Z` / `Cmd+Shift+Z` | 仅作用于文本输入框（项目名、备注等） |
| 剪切 / 复制 / 粘贴 | `Cmd+X` / `Cmd+C` / `Cmd+V` | 文本输入框编辑 |
| 全选 / 删除 | `Cmd+A` / `Delete` | 文本全选；选中排期条或里程碑后 `Delete` 删除 |
| 最小化 / 缩放 | `Cmd+M` / 窗口菜单 | 窗口操作 |
| 退出 | `Cmd+Q` | 退出时自动停止内置服务 |
| 关闭弹层 | `Esc` | 依次关闭模态框 → 资源抽屉 → 右键菜单 → 取消选中 |

> 说明：原生客户端实现了 `WKUIDelegate`，因此删除前的 `confirm()` 确认框、重置数据的 `prompt()` 输入框会以 macOS 原生弹窗呈现；浏览器侧行为不变。

可选环境变量：

```bash
TEAM_CALENDAR_PORT=8790 TEAM_CALENDAR_READONLY_PORT=8791 "./build/macos/Team Calendar.app/Contents/MacOS/TeamCalendarClient"
DATA_DIR=/path/to/data python3 server.py
READONLY_SERVER=1 HOST=0.0.0.0 PORT=8788 DATA_DIR=/path/to/data python3 server.py
DB_PATH=/path/to/scheduler.sqlite python3 server.py
ALLOW_REMOTE_WRITE=1 HOST=0.0.0.0 python3 server.py
```

普通 Web 服务也支持生成只读分享地址；设置 `READONLY_PORT` 后，请求 `/api/share` 会在同一个 Python 进程内启动只读端口并返回该端口地址：

```bash
DB_PATH=/path/to/scheduler.sqlite HOST=0.0.0.0 READONLY_PORT=8788 python3 server.py
curl http://127.0.0.1:8787/api/share
```

如果必须手动起两个进程，也要给两个进程传入同一个 `DB_PATH`：

```bash
DB_PATH=/path/to/scheduler.sqlite HOST=0.0.0.0 python3 server.py
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

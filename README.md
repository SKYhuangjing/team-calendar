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
- `-e EDIT_PASSWORD=...` — 可选全局编辑密码；未配置时默认可读写，配置后需在右上角解锁编辑

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

### 0.0.4 新增：团队工作区（Team Workspace）

- **矩阵式多团队**：人单属一个 `home team`，项目单属一个团队；人员可通过有起止日期的显式借调参与其他团队项目，跨团队排期必须落在有效借调期内。存量数据自动归入默认团队 `通用`（可重命名），历史跨团队排期会迁移为对应借调区间。
- **团队 / 全局双视图**：工具栏切换器按 `全部团队 / 某团队` 切换。团队视图（项目向）只看本团队项目与参与人员（借调人员标「借调」）；全局视图（人向）看全部人力与负载。
- **产能 / 冲突始终全局计算**：无论在哪个团队视图，一个人的当日负载与冲突都按其在所有团队的排期之和判定（资源调度的核心不变量）。
- **per-team 视图偏好**：每个团队各自的 viewMode / 自定义天数 / 打印选项，互不覆盖。
- **团队 CRUD**：设置页「团队」tab 增删改；删团队将其人员/项目迁移到默认团队（数据不删除）；默认团队不可删。
- **CSV 团队列**：导入/导出含 `团队` / `人员所属团队` 列，按名称匹配，未匹配归默认团队。

设计细节与边界见 `docs/team-workspace-design.md`。

### 0.0.5 新增：设置页重设计（团队 Tab + 卡片网格）

- **团队横向 Tab**：设置页顶部为团队 Tab，**一次只渲染当前团队**的成员与项目（不再把所有团队堆在一页长文档里）；当前团队记忆到本地，团队多了 Tab 横向滚动。顶部导航 `团队 / 归档 / 数据`（人员、项目、里程碑不再单独成 Tab）。
- **卡片网格**：成员、项目均改为**卡片网格**（一行 4–6 张，填满横向空间），单屏可见数量远多于单列列表；卡片支持多选、⠿ 队内拖拽排序（2D）、整卡拖拽迁移、点击进编辑。
- **里程碑融入项目**：项目卡带 `◆ N` 里程碑计数徽标（含风险里程碑时变红），点击弹出里程碑管理窗（该项目里程碑的增删改）。跨项目全局视图由「资源池」抽屉提供。
- **独立归档区**：归档的人员 / 项目集中在「归档」子 Tab，带恢复按钮；团队视图只看活跃数据，降低日常数据量。
- **批量与拖拽**：多选 + 批量删除（带撤销）、跨团队拖拽迁移（纯前端 `Promise.allSettled`，部分失败 toast 汇总）——拖起卡片即滑出右侧「快速划转」浮动面板，也可直接投到目标团队 Tab。
- **就地创建**：每个区块底部就地输入行快速建成员 / 项目；`+` 按钮弹完整表单并自动归属当前团队。
- **负责人 ID 化**：里程碑与项目负责人由人名字符串 `owner` 迁移为外键 `owner_id → people.id`，改名不断链；删人时解绑负责人（置空，不级联删），显示「未指派」。CSV 导出仍导出人类可读姓名。

设计细节与边界见 `docs/settings-redesign-design.md`。


## macOS 客户端

项目提供一个原生 macOS WebView 客户端，并可通过独立端口分享强制只读地址。

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
- 客户端数据默认写入 `~/Library/Application Support/TeamCalendar/data/scheduler.sqlite`，避免写入 `.app` 包内部。
- 如果打包资源里没有 `config/initial-data.json`，构建脚本会把 `config/initial-data.json.example` 复制为首次运行预置数据。
- 未配置 `EDIT_PASSWORD` 时主服务默认可读写；配置后主服务默认锁定，在右上角输入密码后进入编辑模式。
- 工具栏“分享只读地址”启动独立只读端口；该端口始终拒绝写入，编辑密码和 token 都不能绕过。

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
EDIT_PASSWORD='请设置强密码' TEAM_CALENDAR_PORT=8790 "./build/macos/Team Calendar.app/Contents/MacOS/TeamCalendarClient"
TEAM_CALENDAR_READONLY_PORT=8791 "./build/macos/Team Calendar.app/Contents/MacOS/TeamCalendarClient"
DATA_DIR=/path/to/data python3 server.py
DB_PATH=/path/to/scheduler.sqlite python3 server.py
EDIT_PASSWORD='请设置强密码' HOST=0.0.0.0 python3 server.py
```

普通 Web 服务可调用 `/api/share` 按需启动只读分享端口：

```bash
READONLY_PORT=8788 python3 server.py
curl http://127.0.0.1:8787/api/share
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

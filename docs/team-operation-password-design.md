# 团队操作密码（Team Operation Password）功能设计 · Resource Scheduler

> 目标版本：`0.1.0`（已实现）
> 维护说明：本文是「团队操作密码 / 超管解锁」特性的单一事实来源（single source of truth）。记录已确认的鉴权模型、密码存储、会话、API、写操作鉴权挂载点与隔离铁律。**当前状态：✅ 已实现（Implemented，2026-06-18）—— W1–W5 全切片落地，DoD 11 项验证通过（见第 11 节末「实现完成状态」）。**
> 上线要求（Definition of Done）见文末「验证与上线标准」。
> 关联文档：`AGENTS.md`（开发约束）、`docs/team-workspace-design.md`（团队工作区，本特性建立其上；该文第 1.5 / 15 节将「登录/权限/访问控制」显式推迟到 `0.1.0`，本设计即其首个落点）、`docs/iteration-plan.md`（迭代主线）。

---

## 0. 状态

| 项 | 值 |
| --- | --- |
| 状态 | ✅ 已实现（Implemented，2026-06-18）— W1–W5 全切片落地，DoD 11 项验证通过 |
| 创建 / 更新 | 2026-06-18 |
| 方向 | 单一租户 · **编辑锁**：读开放、写需解锁；团队密码解锁本团队、超管密码解锁全部 |
| 目标版本 | `0.1.0`（访问控制的第一切片：基于操作密码，非用户账号体系） |
| 依赖 | 无新增第三方库；复用现有 `http.server` + `sqlite3` + `hashlib`/`hmac`/`secrets`（stdlib）+ 原生 ES Modules |
| 代码基线 | `server.py` 1267 行 · 0.0.4；写操作已统一在 `do_POST`/`do_PUT`/`do_DELETE` 开头过 `reject_if_readonly()`（`server.py:657`） |
| 触发场景 | 服务以 Docker + 反向代理部署到公网（`http://tc.dev.1datatm.info/`），`Dockerfile` 已设 `ENV ALLOW_REMOTE_WRITE=1` 解开「远程只读」，需在公网暴露下保证编辑安全 |

---

## 1. 背景与目标

### 1.1 痛点

服务部署在公网（Docker + 反向代理）。`server.py` 的写保护 `reject_if_readonly()`（`:657`）默认仅放行**回环地址**客户端：

```python
# server.py:657
def reject_if_readonly(self):
    if self.is_readonly_server_context() or self.has_readonly_marker() or (
        not self.is_local_client() and not truthy_env("ALLOW_REMOTE_WRITE")):
        ...
```

`is_local_client()`（`:633`）只认直连 TCP 对端 IP 为回环。反向代理链路下，容器内看到的 `client_address` 是代理 IP（或 Docker 网桥 `172.x.x.x`），非回环 → 远程编辑被 403 拦截（只读模式）。为让远端可编辑，`Dockerfile` 已加 `ENV ALLOW_REMOTE_WRITE=1`，但这会让**公网任何人都能改排期数据**——应用本身无任何鉴权。

### 1.2 目标

在 `ALLOW_REMOTE_WRITE=1` 之上叠加一层**轻量编辑锁**，安全地公网暴露：

- **读完全开放**：查看/只读分享能力不受影响（沿用现有 `reject_if_readonly` 的读路径）。
- **写需解锁**：每个团队一个操作密码，解锁后可编辑**本团队**数据；超管密码解锁**全部团队**。
- **团队硬隔离**：解锁团队 A 绝不能改团队 B 的任何数据（含伪造归属、跨团队迁移、写 B 的设置）。
- 超管密码由环境变量 `ADMIN_PASSWORD` 驱动，不入库、不进镜像层；团队密码仅超管在 UI 设置。

### 1.3 非目标（本期不做）

- 用户账号体系 / 登录态 / 多用户（操作密码是共享密钥，非 per-user）。
- 读访问鉴权（读始终开放）。
- 多租户（org 层）鉴权。
- 细粒度角色（如「只读某团队 / 可编辑某团队」分发）。本期只有两态：未解锁 / 已解锁某团队 / 超管。
- 密码找回、邮箱、2FA。

---

## 2. 决策摘要（已与需求方对齐）

| 分叉 | 选定方案 | 理由 |
| --- | --- | --- |
| 读访问门槛 | **只读开放，仅编辑设密码** | 保留只读分享；公网只暴露查看 |
| 超管密码初始化 | **环境变量 `ADMIN_PASSWORD`** | 契合 Docker，密钥不进镜像层，重启即可轮换 |
| 团队密码管理 | **仅超管管理** | 集中可控；团队用户只用密码解锁，不能改密 |
| 会话存储 | **进程内（in-memory）** | 单容器单进程，够用；重启即失效需重新解锁（可接受） |
| 会话语义 | **累积式**（同浏览器会话可解锁多团队，`teamIds` 为 set） | 切换多团队不必反复解锁 |
| 密码哈希 | **PBKDF2-HMAC-SHA256（stdlib）** | slim 镜像无额外依赖；`hashlib`+`hmac`+`secrets` |
| 密码存储位置 | **独立表 `team_auth`，不复用 `settings`** | `GET /api/bootstrap`/`/api/settings` 会吐 settings value，复用即泄露 hash |
| 鉴权挂载 | **逐 handler 显式挂载**（非通用解析器） | 漏一路由即安全洞；显式可审计 |
| `/api/settings` | **不豁免，按团队锁** | settings 是 per-team，豁免则 A 可写 B 偏好 = A 改 B |
| 整体开关 | **配置任一密码才启用** | 未配置时行为同今天，避免锁死、便于灰度 |

---

## 3. 鉴权模型

### 3.1 两态权限

- **未解锁**：可读全部数据；任何写操作 403。
- **解锁某团队 X**：可写「归属于 X」的数据（人员 `home_team_id=X`、项目 `team_id=X`、挂在这些项目上的排期/里程碑）。
- **超管**：可写一切，含结构性操作（建/删团队、批量排序、重置、CSV 导入）。

### 3.2 隔离铁律（核心）

> **权限以「被写记录当前所属团队」为准。请求 body 里的 `teamId`/`homeTeamId` 只是数据，不能用来声称权限。**

`require_team(team_id) = session.isAdmin OR team_id ∈ session.teamIds`。团队 A 的会话 `teamIds = {A}`，对任何 B 的写操作一律 403；唯一能跨团队的是 `isAdmin`（超管）。攻击面与封堵见第 11 节 DoD 第 4 项。

### 3.3 与现有「只读模式」的关系

现有 `isReadOnlyMode` / `X-Read-Only` 头（`api.js:14`）是**前端发起的只读视图**，与本编辑锁正交：

- `ALLOW_REMOTE_WRITE=1` 解开「远程只读」（IP 维度）。
- 团队操作密码接管「写授权」（团队维度）。
- 前端只读模式仍有效（发 `X-Read-Only=true` → 后端 `reject_if_readonly` 拦写，与解锁与否无关）。

---

## 4. 数据模型

### 4.1 新增表 `team_auth`（密码哈希，独立于 `settings`）

`init_db`（`server.py:360`）的 `executescript` 增加：

```sql
-- server.py:429 后追加（与 teams/settings 同批 CREATE TABLE IF NOT EXISTS）
CREATE TABLE IF NOT EXISTS team_auth (
    team_id   TEXT PRIMARY KEY,   -- 'tm_xxx'；超管不在此表（env 驱动）
    pwd_hash  TEXT NOT NULL,      -- pbkdf2_sha256$<iters>$<salt_b64>$<hash_b64>
    updated_at TEXT NOT NULL
);
```

**为什么不复用 `settings`**：`GET /api/bootstrap`（`server.py:584-607`）和 `GET /api/settings`（`:611`）把 settings 的 `(key,value)` 直接返回前端。密码 hash 若塞进 settings 会随这些接口泄露。独立表物理隔离，且这两个接口的查询都不触及它。

### 4.2 超管密码不入库

超管密码仅存于环境变量 `ADMIN_PASSWORD`，解锁时 `hmac.compare_digest` 原文比对（env 明文本就在进程内存，无需再哈希化对比）。轮换 = 改 env + 重启容器。`team_auth` 表**只存团队密码**。

### 4.3 不变量

- `team_auth.team_id` 必须对应 `teams.id` 中现存、未归档的团队（设密时校验，删团队时级联清理 `team_auth` 行）。
- 任何接口**永不**返回 `pwd_hash`；`bootstrap` 仅返回布尔 `teamAuth`（哪些团队已设密）。

---

## 5. 密码哈希与会话

### 5.1 哈希（stdlib）

```python
import hashlib, hmac, secrets, base64

_PBKDF2_ITERS = 600_000                 # OWASP 2023
_PBKDF2_ITERS_MAX = _PBKDF2_ITERS * 4   # verify 端 iters 上限（防攻击者构造巨 iter 哈希做 DoS）
_PASSWORD_MAX = 4096                    # 密码长度上限（防超长输入空跑 pbkdf2）

def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, _PBKDF2_ITERS)
    return f"pbkdf2_sha256${_PBKDF2_ITERS}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"

def verify_password(pw: str, stored: str) -> bool:
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256": return False
        n = int(iters)
        if n < 1 or n > _PBKDF2_ITERS_MAX: return False
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), base64.b64decode(salt_b64), n)
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except Exception:
        return False
```

### 5.2 会话（进程内，累积式）

```python
import threading, time
_SESSION_TTL = 12 * 3600          # 12h
_sessions = {}                    # token -> {"teamIds": set[str], "isAdmin": bool, "exp": ts}
_sessions_lock = threading.Lock()

def _new_session() -> str:
    return secrets.token_urlsafe(32)

def _session_put(token, *, team_id=None, is_admin=False):
    """累积：admin 置位、team 加入 set；刷新 exp。"""
    with _sessions_lock:
        s = _sessions.setdefault(token, {"teamIds": set(), "isAdmin": False, "exp": 0})
        if is_admin: s["isAdmin"] = True
        if team_id:  s["teamIds"].add(team_id)
        s["exp"] = time.time() + _SESSION_TTL
        return s
```

> `time.time()` 在主进程可用（仅工作流脚本受限）。会话重启即丢，符合「进程内」决策。

---

## 6. API 设计

### 6.1 新增 auth 端点（不过 `reject_if_readonly`，在 `do_GET`/`do_POST` 顶部短路）

| 方法 | 路径 | 入参 | 行为 | 鉴权 |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/unlock` | `{password, teamId?}` | `teamId` 空→比 `ADMIN_PASSWORD`（`hmac.compare_digest`），成功置 `isAdmin`；非空→比 `team_auth[teamId]`，成功加入 `teamIds`。返回 `{token, isAdmin, teamIds, exp}` | 无（这就是获取鉴权的入口） |
| GET | `/api/auth/session` | — | 校验 `X-Auth-Token`，返回 `{isAdmin, teamIds, exp}` 或 401 | 无（前端加载自检） |
| POST | `/api/auth/lock` | — | 撤销当前 token | 持 token |
| POST | `/api/auth/team-password` | `{teamId, password}` | `hash_password` 写 `team_auth`（存在则覆盖） | **require_admin** |
| DELETE | `/api/auth/team-password?teamId=` | — | 删 `team_auth` 行（清空该团队密码→其编辑锁关闭） | **require_admin** |

### 6.2 bootstrap 增量字段（`server.py:584-607`）

返回里追加（**仅布尔，绝不含 hash**）：

```python
"teamAuth": {tid: True for (tid,) in rows("SELECT team_id FROM team_auth")},
"authEnabled": auth_enabled(),
```

前端据此画锁、决定是否启用解锁 UI。

### 6.3 错误返回约定（写操作 403）

`require_team` 失败 → `{"error": "...", "requireUnlock": "<teamId>", "teamName": "<name>"}`；
`require_admin` 失败 → `{"error": "...", "requireAdmin": true}`。
前端按 body 分流弹对应解锁框，成功后**自动重放原请求**。

---

## 7. 写操作鉴权挂载点（隔离铁律落地）

所有写操作已统一在 `do_POST`（`server.py:664`）/ `do_PUT`（`:688`）/ `do_DELETE`（`:712`）开头调 `reject_if_readonly()`。在**各 handler 内部**追加 `require_*` 调用（显式、可审计，避免通用解析器漏路由=安全洞）。

### 7.1 鉴权辅助方法（Handler 上，仿 `reject_if_readonly` 的「返回 True=已拦截」模式）

```python
def auth_enabled(self):
    return bool(os.environ.get("ADMIN_PASSWORD", "").strip()) or \
           bool(one("SELECT 1 FROM team_auth LIMIT 1"))

def current_session(self):
    token = self.headers.get("X-Auth-Token", "")
    with _sessions_lock:
        s = _sessions.get(token)
        if not s or s["exp"] < time.time():
            return None
        return s

def require_admin(self):
    if not self.auth_enabled(): return False          # 未配置→放行（灰度安全）
    s = self.current_session()
    if s and s["isAdmin"]: return False
    self._drain_request_body()
    self.send_json({"error": "需要超管解锁", "requireAdmin": True}, 403)
    return True

def require_team(self, team_id, team_name=""):
    if not self.auth_enabled(): return False
    s = self.current_session()
    if s and (s["isAdmin"] or team_id in s["teamIds"]): return False
    self._drain_request_body()
    self.send_json({"error": "需要解锁团队", "requireUnlock": team_id, "teamName": team_name}, 403)
    return True
```

### 7.2 目标团队解析规则（杜绝 A 改 B）

- **create**：目标团队 = body 指向的归属团队（assignment/milestone 经 body 的 `projectId` 查 `projects.team_id`）→ `require_team(目标)`。
- **update**：先取**库里该记录当前的所属团队**；若本次改动动了归属字段（person `home_team_id` / project `team_id` / assignment·milestone `projectId`），则**新旧两个团队都需解锁**（跨团队迁移实际需超管）。单团队内字段修改 → `require_team(当前团队)`。
- **delete**：取**库里该记录当前的所属团队** → `require_team(当前团队)`（删 assignment/milestone 时经 `projectId` 查所属 project 的 team）。

### 7.3 挂载矩阵

| handler（`server.py` 行） | 目标团队 | 鉴权 |
| --- | --- | --- |
| `create_person` 759 / `update_person` 775 / DELETE person | `home_team_id`；改归属→新旧都要 | `require_team` |
| `create_project` 800 / `update_project` 823 / DELETE project | `team_id`；改归属→新旧都要 | `require_team` |
| `create_assignment` 916 / `update_assignment` 928 / DELETE assignment | 所属 project 的 `team_id`；改 `projectId`→新旧 project 团队都要 | `require_team` |
| `create_milestone` 941 / `update_milestone` 960 / DELETE milestone | 所属 project 的 `team_id`；改 `projectId`→同上 | `require_team` |
| `create_team` 852 / `update_team` 864 / `delete_team` 886 | 结构性 | `require_admin` |
| `bulk_sort` 981（`/api/sort`） | 跨团队排序 | `require_admin` |
| `/api/reset`（`:668`）、`/api/import.csv`（`:671`） | 全局 | `require_admin` |
| `save_setting` 741（`/api/settings`） | body `teamId`；`''`=全局 | 有 `teamId`→`require_team(teamId)`；`''`→`require_admin` |

> DELETE 走 `do_DELETE`（`:712`）通用分支（`people/projects/assignments/milestones`）与 `teams` 专属分支（`:721`）。通用分支删之前需先 `SELECT` 出该记录的所属团队再 `require_team`，否则拿不到团队。

### 7.4 `/api/settings` 不豁免（修正点）

settings 虽是 UI 偏好（viewMode/customDays 等），但 **per-team**。若豁免，A 可带 `teamId=B` 写 B 的偏好 = A 改 B。故按团队锁。代价：未解锁的远程查看者保存视图偏好会收到 403——前端处理为**非致命**：保留本次会话内客户端态即可，不弹错（视图偏好本就有 localStorage 客户端态兜底，见 `state.js:42 prefKey`）。

---

## 8. 前端模块改动矩阵

| 文件 | 改动 |
| --- | --- |
| `public/js/state.js` | 新增 `authToken`（`lsGet('rc_authToken')`）、`unlockedTeams: Set`、`isAdmin`、`authEnabled`、`teamAuth`；加载时从 bootstrap 回填并 `GET /api/auth/session` 校验 token（失效则清空）。复用现有 `lsGet/lsSet`（`:22-24`） |
| `public/js/api.js` | `request()`（`:12-15`）统一注入 `X-Auth-Token`；写操作 403 按 `requireAdmin`/`requireUnlock` 分流弹框，解锁成功后**自动重放原请求** |
| `public/js/panels.js` | 团队选择器每项 +「全部团队」锁状态指示（🔒/🔓）；超管登录后设置页新增「团队操作密码」区（列团队、设/改/清密码，调 `/api/auth/team-password`） |
| `public/js/interactions.js` | 点锁或对被锁团队发起编辑 → 弹密码框（teamId 或 admin）；解锁成功更新 `unlockedTeams`/`isAdmin` |
| `public/js/app.js` | 顶部「已解锁」徽标 + 锁定/退出按钮（`POST /api/auth/lock`）；切团队时按 `authEnabled`/`teamAuth` 渲染锁 |
| `public/js/i18n.js` | 新增文案 zh/en：解锁、超管密码、团队操作密码、密码错误、已解锁等 |
| `public/index.html` | 解锁弹窗、锁图标、设置页密码区 DOM |

---

## 9. 安全开关与上线（rollout）

`auth_enabled()`（`server.py:759` 上方新增）= `ADMIN_PASSWORD 已设 OR team_auth 有任意行`。

- **未配置任何密码** → 鉴权关闭，写行为同今天（仅受 `ALLOW_REMOTE_WRITE` 约束）。保证不锁死、可灰度。
- **部署上线顺序**：
  1. `docker run -e ADMIN_PASSWORD=<secret> -e ALLOW_REMOTE_WRITE=1 ...` → 编辑锁启用，仅超管可写。
  2. 超管登录 → 在 UI 为各团队设操作密码。
  3. 团队负责人用各自密码解锁编辑本团队。
- **轮换超管密码**：改 `ADMIN_PASSWORD` env + 重启（进程内会话随之失效，全员重新解锁）。
- **`Dockerfile`**：仅文档化 `ADMIN_PASSWORD`（注释），**不硬编码**；运行时 `-e` 传入。已含 `ENV ALLOW_REMOTE_WRITE=1`。

> 公网暴露下，建议反向代理层（nginx 等）再加一道 basic auth 作为纵深防御；操作密码是应用层的主防线。

---

## 10. 实现切片（Wave）

| Wave | 范围 | 产出 |
| --- | --- | --- |
| W1 后端骨架 | `team_auth` 建表；`hash_password`/`verify_password`；`_sessions` + `auth_enabled`/`current_session`/`require_admin`/`require_team` | 密码与会话基础设施 |
| W2 auth 端点 | `/api/auth/unlock·session·lock·team-password`(POST/DELETE)；bootstrap 增量 `teamAuth`/`authEnabled` | 解锁/设密 API |
| W3 写鉴权挂载 | 按 7.3 矩阵逐 handler 挂 `require_*`，含 create/update/delete 目标团队解析 | 隔离铁律生效 |
| W4 前端 | state/api token 注入 + 403 重放；锁指示 + 解锁弹窗；设置页密码区；i18n | 端到端可用 |
| W5 验证 | DoD 11 项（含隔离攻击面） + 真实库回归 | 上线 |

---

## 11. 验证与上线标准（Definition of Done）

1. **不配密码（回归）**：未设 `ADMIN_PASSWORD`、`team_auth` 空 → 编辑锁关闭，写行为同今天。
2. **超管解锁**：`-e ADMIN_PASSWORD=secret` → 解锁全部团队可写；在 UI 设团队 A 密码。
3. **团队锁**：未解锁 A 时编辑 A 的项目/人员 → 403 弹框；输入正确密码 → 解锁并可写 A；B 仍锁。
4. **★ 隔离（杜绝 A 改 B）**：仅解锁 A，尝试 ① body 伪造 `teamId=B` 建项目/人员 ② 把 B 的人改归属到 A ③ 改 B 的 project 字段 ④ `POST /api/settings` 带 `teamId=B` ⑤ 删 B 的 assignment —— **全部必须 403**；仅超管或同时解锁 B 才放行。
5. **跨团队迁移**：改 person `home_team_id` A→B，或 assignment 改 `projectId` 跨团队 → 需 A、B 都解锁（实际超管）。
6. **结构性=超管**：建/删团队、`/api/sort`、`/api/reset`、`/api/import.csv` 均需超管。
7. **读不受影响**：未解锁任意人都能 `GET /api/bootstrap`、查看、只读分享。
8. **hash 不泄露**：`GET /api/bootstrap`、`GET /api/settings` 响应 `grep` 不到 `pbkdf2`/`pwd`；`team_auth` 仅以布尔 `teamAuth` 暴露。
9. **会话**：重启容器 / TTL 到期 → token 失效需重新解锁；`/api/auth/lock` 立即失效。
10. **灰度安全**：删光所有团队密码且不设 `ADMIN_PASSWORD` → `auth_enabled()` 回到 False，行为同今天。
11. **api-test 回归**：现有写接口用例在「未配置密码」下全过；新增解锁/隔离用例覆盖 403/重放链路。

### 11.1 实现完成状态（2026-06-18）

| DoD | 结果 |
| --- | --- |
| 1. 不配密码（回归） | ✅ 未设 `ADMIN_PASSWORD`、`team_auth` 空 → `authEnabled=false`；建人/项目/团队/排序/settings 写入均 200 |
| 2. 超管解锁 | ✅ `-e ADMIN_PASSWORD` → `POST /api/auth/unlock` 返回 `{isAdmin:true, token}`；`POST /api/auth/team-password` 写入 team_auth |
| 3. 团队锁 | ✅ 仅解锁 A：编辑 A 人员 200；编辑 B 人员 → 403 `{requireUnlock:B}` |
| 4. ★ 隔离（A 改 B） | ✅ 仅解锁 A 时 6 路全 403：① 伪造 teamId=B 建项目 ② 伪造建人 ③ 改 B 项目字段 ④ 写 B settings ⑤ 删 B 排期 ⑥ 把 B 的人改归属到 A |
| 5. 跨团队迁移 | ✅ A 的人 home_team A→B（仅 A token）→ 403；超管 → 200 |
| 6. 结构性=超管 | ✅ 建团队 / `/api/sort` / 全局 settings / `/api/import.csv` / `/api/reset` / 设团队密码 → 均需超管（403 requireAdmin） |
| 7. 读不受影响 | ✅ 无 token `GET /api/bootstrap` → 200 |
| 8. hash 不泄露 | ✅ `bootstrap` / `/api/settings` 响应 grep 不到 `pbkdf2`/`pwd_hash`；team_auth 仅以布尔 `teamAuth` 暴露 |
| 9. 会话 | ✅ `/api/auth/lock` 后旧 token `GET session`→401、编辑→403；服务重启（同库）后旧 token 失效→401；写操作 403+drain 后连接仍健康（keep-alive 不串包） |
| 10. 灰度安全 | ✅ 删光团队密码 + 不设 `ADMIN_PASSWORD` → `authEnabled=false`，写行为同今天 |
| 11. api 回归 | ✅ auth 关闭时建人 / settings / sort / 建团队均 200 |
| — auth 端点绕过只读门 | ✅ `READONLY_SERVER=1` 下写操作 403，但 `POST /api/auth/unlock` → 200（返回 token）、`GET /api/auth/session` → 401，均非只读 403 |
| — 前端模块图 | ✅ `node --check` 全模块通过；DOM-shim 顶层求值 app.js 全图无异常 |

> 实现备注：`require_admin/require_team` 在 POST/PUT handler 内调用时 body 已被 `read_json()` 消费，故**不** `_drain_request_body()`（keep-alive 下排空会读到下一请求字节、串包）；仅 do_POST 早期分支（`/api/reset`、`/api/import.csv`）与 team-password 端点（body 尚未读）以 `require_admin(drain=True)` 排空。已用「403 后连接健康」断言验证。

---

## 12. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 通用解析器漏一路由 → 越权 | 不写通用解析器；逐 handler 显式挂载 + DoD-4 隔离攻击面测试 |
| 密码 hash 经旧接口泄露 | 独立 `team_auth` 表；bootstrap 仅返回布尔；DoD-8 grep 断言 |
| 进程内会话重启失效 | 决策已接受（重新解锁）；超管密码 env 驱动可快速恢复 |
| `ALLOW_REMOTE_WRITE=1` 公网裸奔 | 操作密码为主防线；建议代理层 basic auth 纵深防御（§9） |
| 未配置即锁死 | `auth_enabled()` 双条件，任一密码才启用；DoD-10 回归 |
| 团队密码遗忘 | 仅超管可重置（`/api/auth/team-password` 覆盖）；超管密码遗忘则改 env 重启 |
| 跨团队借调体验 | 借调=把 A 的人排到 B 的项目，归属 B 的 project → 需 B 解锁（项目方控自己的排期）；记录此取舍 |

---

## 13. 与 0.1.0 访问控制 / 团队工作区的关系

- `docs/team-workspace-design.md` 第 1.5 / 15 节将「登录/权限/访问控制」推迟到 `0.1.0`。本设计是 **0.1.0 访问控制的第一切片**：以**操作密码**（共享密钥）实现编辑锁，而非完整用户账号体系。后续可在其上叠加 per-user 账号、角色分发、审计日志。
- 建立在团队工作区（`teams`、`people.home_team_id`、`projects.team_id`、per-team `settings`）之上；目标团队解析直接复用现有归属列，无需新增归属模型。
- `team_auth(team_id)` 与 `teams` 对齐，未来升多租户时可随 `teams → tenants` 一并演进；会话 `_sessions` 结构（`teamIds`/`isAdmin`）兼容后续角色扩展。

---

## 14. 修订记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-06-18 | 0.1.0 已实现 | **全量落地（W1–W5）**：后端（`team_auth` 建表 + `hash_password`/`verify_password` PBKDF2 stdlib + 进程内累积式 `_sessions` + `auth_enabled`/`current_session`/`require_admin`/`require_team`/`_record_team`/`_project_team_id` 辅助、5 个 auth 端点绕过只读门、bootstrap 增量 `teamAuth`/`authEnabled`、逐 handler 写鉴权挂载含 create/update/delete 目标团队解析与跨团队迁移双锁、`/api/settings` 按团队锁、删团队级联清 team_auth）+ 前端（`state.js` authToken/unlockedTeams/isAdmin/authEnabled/teamAuth + `setSession`、`api.js` 统一注入 X-Auth-Token + 403 分流重放 + bootstrap session 回填、`panels.js` 独立解锁弹窗 + 团队密码管理区、`app.js` 团队选择器锁标 + 头部状态徽标/锁定按钮、`interactions.js` 解锁/密码事件、i18n zh/en、index.html DOM、main.css）。DoD 11 项 + auth 端点绕过只读门 + 前端模块图全过（见 11.1）。版本号升至 0.1.0。**实现备注**：`require_*` 在 handler 内不排空（body 已被 read_json 消费），仅早期路由/team-password 端点 `require_admin(drain=True)`。 |
| 2026-06-18 | 0.1.0 设计定稿 | 初版：编辑锁鉴权模型（读开放/写解锁）、`team_auth` 独立表 + PBKDF2 stdlib 哈希、进程内累积式会话、5 个 auth 端点 + bootstrap 增量字段、逐 handler 写鉴权挂载矩阵（含 create/update/delete 目标团队解析铁律）、`/api/settings` 按团队锁（修正豁免口子）、安全开关 `auth_enabled()`、Wave 切片、DoD 11 项（含隔离攻击面）、风险矩阵。状态 🟡 设计定稿（未实现）。 |

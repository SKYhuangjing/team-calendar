# 数据库多后端（SQLite + MySQL）切换功能设计 · Resource Scheduler

> 目标版本：`0.0.5`（计划中）
> 维护说明：本文是「数据库多后端」特性的单一事实来源（single source of truth）。**数据层采用 Peewee 轻量 ORM 驱动**，在 SQLite 与 MySQL 间按启动配置切换；记录模型设计、后端切换、连接管理、迁移策略、查询分层与上线标准。
> 关联文档：`AGENTS.md`（开发约束，已修订为 Peewee 驱动）、`docs/team-workspace-design.md`（0.0.4 团队工作区，现有 schema 来源）、`docs/iteration-plan.md`（迭代主线）。
> 行号锚点：对齐 `server.py` 现状 `0.0.4`（1263 行，2026-06-18）。实现前请用 `grep` 复核锚点是否漂移。
> 演进说明：本方案取代早先的「手写 `db.py` DBAL」方向（该方向已废弃，原因见 §3）；核心受益是 Peewee 直接吸收了绝大多数方言陷阱（占位符、UPSERT、DDL 主键类型、连接池、行访问），见 §2.1。

---

## 0. 状态

| 项 | 值 |
| --- | --- |
| 状态 | 🟡 设计定稿（未实现）· Peewee 方案 |
| 创建 / 更新 | 2026-06-18 |
| 方向 | 引入 Peewee ORM 作为数据层，后端在 SQLite 与 MySQL 间按启动配置切换 |
| 目标版本 | `0.0.5` |
| 新增依赖 | `peewee`（必装，连 SQLite 也走它）+ `PyMySQL`（仅 MySQL）；`playhouse` 随 peewee 自带（连接池/反射） |
| 代码基线 | `server.py` 1263 行 · 0.0.4；数据层现为裸 `sqlite3` 直连，无模型抽象 |

---

## 1. 背景与目标

### 1.1 为什么需要多后端

当前产品单一依赖 SQLite 文件库（`data/scheduler.sqlite`），单机/小团队够用，但以下场景受限：

- **多实例 / 容器化部署**：Docker 容器重启或水平扩容时，SQLite 文件库无法被多进程并发安全共享。
- **企业内网集中存储**：运维要求统一接入已有 MySQL 集群，做备份/审计/监控。
- **并发写吞吐**：SQLite 库级写锁高并发时串行化；MySQL（InnoDB）行级锁更适用。

因此需要：**同一个应用，按启动配置切换到 SQLite 或 MySQL**，业务逻辑与 API 完全不变。

### 1.2 约束（已确认）

1. **API 不变**：所有 `/api/*` 请求/响应契约、驼峰字段、错误格式完全不变；前端零改动。
2. **业务逻辑不变**：CRUD、CSV 往返、级联删除、冲突全局计算、per-team settings 在两后端语义一致。
3. **迁移幂等**：现有 SQLite 真实库（0.0.4）必须平滑沿用，重复启动不报错。
4. **接受 pip 依赖**：数据层统一走 Peewee，故**默认 SQLite 路径不再是零依赖**——`python3 server.py` 前需 `pip install -r requirements.txt`（含 `peewee`，MySQL 再加 `PyMySQL`）。这是与早先「手写 db.py 保零依赖」方向的关键分叉，已由决策方明确接受（见 §3）。

### 1.3 非目标（本期不做）

- 不上 SQLAlchemy（更重，本项目规模不需要其全部能力）。
- 不做 PostgreSQL / 其他后端（Peewee 架构上天然支持，但不实现驱动配置）。
- 不做多租户数据库隔离（与 0.1.0 访问控制一并考虑）。
- 不做 SQLite↔MySQL 数据迁移工具（导出 CSV → 切后端 → 导入 CSV 兜底）。
- 不改日期存储模型（仍 ISO 字符串，见 §6.4）。

---

## 2. Peewee 吸收了哪些方言陷阱

### 2.1 对照：手写 db.py 要自己解决的，Peewee 现成提供

| 原 SQLite 专有点（`server.py` 行号） | 手写 db.py 的活 | Peewee 是否替你做 |
| --- | --- | --- |
| 占位符 `?`↔`%s` | 写翻译器 | ✅ 查询走模型 API，参数风格由驱动层处理 |
| 主键 `TEXT PRIMARY KEY`（`369/378/388/401/414`） | token 渲染分方言 | ✅ `CharField(primary_key=True, max_length=64)` → MySQL `varchar(64)` |
| `INSERT OR IGNORE`（`251/263/295/322/347/466`） | `insert_ignore()` 构造器 | ✅ `Model.insert(...).on_conflict_ignore()` |
| UPSERT `ON CONFLICT`（`745`） | `upsert()` 构造器 | ✅ `Model.insert(...).on_conflict_replace()/on_conflict(action='update', ...)`，自动产出 SQLite `ON CONFLICT` / MySQL `ON DUPLICATE KEY` |
| `PRAGMA table_info` 自省（6 处） | `table_columns()` | ✅ `database.get_columns(table)`（跨后端） |
| `PRAGMA foreign_keys=ON`（`208`） | 按后端跳过 | ✅ SQLite pragmas 配置项；MySQL InnoDB 默认强制 |
| `executescript` 建表（`366`） | 拆语句列表 | ✅ `database.create_tables([...], safe=True)` |
| `sqlite3.Row` + `dict(r)`（`207`） | DictCursor 分支 | ✅ `.dicts()` / `.model()` 统一 |
| **`r[0]` 位置式行访问**（`456/461`） | 改列名访问（曾阻塞） | ✅ **不存在了**：模型对象按属性 `person.color` 访问 |
| 空结果 `[]` vs tuple | `list(...)` 包一层 | ✅ `.dicts()` 返回标准 list |
| 连接池 / 线程本地复用 | 手写 `threading.local` + 重连 | ✅ `PooledMySQLDatabase`；且 Peewee `autoconnect` 内部按线程持连 |
| 事务（sqlite3 自动 commit vs PyMySQL 不自动） | `transaction()` 抹平 | ✅ `database.atomic()` 上下文，两后端一致 |

> **结论**：手写 db.py 的 19 项 DoD / 15 条陷阱里，约 2/3 是纯机械翻译，Peewee 直接消除。本方案聚焦剩下的**语义差异**与**Peewee 自身的坑**。

### 2.2 Peewee 不替你消除的语义差异（仍需处理）

| 差异 | 说明 | 处理（见 §6 / §11） |
| --- | --- | --- |
| MySQL 默认大小写不敏感排序、SQLite 大小写敏感 | `WHERE name=?`、唯一约束的匹配行为不同 | 文档提示；如需精确匹配用 `BINARY`/显式 collation |
| MySQL 严格 `sql_mode` | 越界/类型不符直接报错 | 字段类型声明 + 应用层校验兜底 |
| 引擎须 InnoDB、字符集须 utf8mb4 | Peewee 不强制设 | `MySQLDatabase(..., charset='utf8mb4')`；引擎靠 MySQL 默认（5.5+ 默认 InnoDB） |
| `lower_case_table_names`（Linux） | 运行时不可改 | 建表统一小写（已满足）+ 启动探测告警 |
| UPSERT `VALUES()` 在 MySQL 8.0.19+ 废弃 | Peewee `on_conflict` 内部细节 | Peewee 的职责，跟随其版本；锁 8.0 |

---

## 3. 方案选型与方向演进

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| ~~A. 手写 `db.py` DBAL~~ | 自实现占位符翻译/DDL 渲染/连接池/事务/自省 | ❌ 已废弃：方言正确性全靠自己维护，`r[0]` 类阻塞项频出（见 §2.1） |
| **B. Peewee ORM** ✅ 选定 | 数据层重写为 Peewee 模型/查询；后端改 `SqliteDatabase`↔`MySQLDatabase` | ✅ 最轻的真实 ORM；专为 SQLite/MySQL/PG 互换设计；吸收绝大多数方言陷阱；学习曲线最浅 |
| C. SQLAlchemy Core | 方言系统最成熟、生态最大 | 本项目规模偏重；学习曲线陡；同样的「重写数据层」成本 |
| D. Vendor Peewee 单文件 | 内嵌 `peewee.py` 保零依赖 | 已放弃零依赖目标，无需 vendor |

**为何选 Peewee**：它是「最轻的真实 ORM」，核心几乎单文件、纯 Python、无编译依赖；`SqliteDatabase` 与 `MySQLDatabase` 互换是其一等公民特性；`on_conflict`/`get_columns`/`PooledMySQLDatabase`/`atomic()` 正好覆盖本项目的全部方言痛点。相比手写 db.py，把方言正确性外包给一个成熟库，显著降低长期维护负担。

**方向演进记录**：最初设计为手写 db.py 保零依赖（见旧版修订记录）。框架调研后，决策方判断项目已朝 Docker/团队/MySQL 演进（0.1.0 路线），「单用户一条命令零依赖」不再是硬约束，遂改为 Peewee。

---

## 4. 架构设计：Peewee 数据层

### 4.1 模块边界

```
启动配置（env / config/database.json）
        │
        ▼
db.py（或 models.py）
   ├─ 选后端 → SqliteDatabase / MySQLDatabase（连接池）
   ├─ 6 个 Model（Team/Person/Project/Assignment/Milestone/Setting）
   ├─ init_db(): create_tables + 增量迁移（execute_sql + get_columns）
   └─ 便捷封装：驼峰序列化 to_camel()、报表裸 SQL helper
        │
        ▼
server.py  Handler / CSV 导入导出
   ├─ CRUD → Model.select()/create()/delete()/.dicts()
   ├─ UPSERT/幂等 → .on_conflict_ignore() / .on_conflict(action='update')
   ├─ 报表 JOIN（export/import CSV）→ database.execute_sql(裸 SQL)
   └─ 事务 → with database.atomic():
```

`server.py` 顶部 `import sqlite3`（`:11`）移除；所有 `sqlite3.` 直引、`db()`/`rows()`/`one()` 收敛为 Peewee 模型调用。

### 4.2 后端选择

```python
# db.py
from peewee import (
    SqliteDatabase, MySQLDatabase, Model, CharField, IntegerField, FloatField,
    CompositeKey, ForeignKeyField,
)
from playhouse.pool import PooledMySQLDatabase

def build_database(cfg):
    if cfg["backend"] == "mysql":
        return PooledMySQLDatabase(
            cfg["database"], host=cfg["host"], port=cfg["port"],
            user=cfg["user"], password=cfg["password"],
            charset="utf8mb4", max_connections=16, stale_timeout=300,
        )
    return SqliteDatabase(cfg["path"], pragmas={"foreign_keys": 1})
```

- **MySQL 用 `PooledMySQLDatabase`**（连接池，`max_connections` 上限 + `stale_timeout` 回收空闲连接），替代手写线程本地连接。
- **SQLite 用 `SqliteDatabase`**（`pragmas={"foreign_keys":1}` 开外键；单文件库无需池）。
- Peewee 的 `autoconnect=True`（默认）内部按 **threading.local 持有连接**——`ThreadingHTTPServer`（`server.py:152`）每请求一线程天然适配，每个工作线程各得一条连接，这正是旧设计要手写的线程本地语义，Peewee 内建。

---

## 5. 配置与切换

沿用项目环境变量约定（`DATA_DIR`/`PORT`/`READONLY_SERVER` 等），**env 优先**：

```bash
# 默认 SQLite
DB_BACKEND=sqlite python3 server.py

# 切到 MySQL
DB_BACKEND=mysql \
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 \
MYSQL_USER=scheduler MYSQL_PASSWORD='***' \
MYSQL_DATABASE=resource_scheduler \
python3 server.py
```

可选 `config/database.json`（密码不便入环境时）：

```json
{
  "backend": "mysql",
  "mysql": {"host":"127.0.0.1","port":3306,"user":"scheduler","password":"***","database":"resource_scheduler"}
}
```

读取优先级：**env > `config/database.json` > 默认 SQLite + `data/scheduler.sqlite`**。

启动校验：`DB_BACKEND=mysql` 时若 `import pymysql` 失败 → **启动硬失败**并提示 `pip install pymysql`，**不静默回退 SQLite**（避免误连空库丢数据）。启动 banner 打印当前后端。

---

## 6. 模型与 Schema

### 6.1 字段类型映射（一份模型，两套物理 DDL）

Peewee 按后端编译字段类型；只需声明逻辑类型：

| Peewee 字段 | SQLite 渲染 | MySQL 渲染 | 用于 |
| --- | --- | --- | --- |
| `CharField(primary_key=True, max_length=64)` | `TEXT PRIMARY KEY` | `VARCHAR(64) NOT NULL PRIMARY KEY` | 所有 `id` |
| `CharField()` | `TEXT` | `VARCHAR(255)` | 短文本（name/priority/color…） |
| `CharField(max_length=...)/TextField` | `TEXT` | `TEXT` | 长文本（description/note） |
| `IntegerField(default=0)` | `INTEGER` | `INT` | sort_order/archived |
| `FloatField(default=8)` | `REAL` | `DOUBLE` | daily_capacity/hours |
| `ForeignKeyField(..., on_delete='CASCADE')` | `... REFERENCES ...(id) ON DELETE CASCADE` | 同（InnoDB 生效） | assignments/milestones |
| `CompositeKey('team_id','key')` | `PRIMARY KEY(team_id,key)` | 同 | settings |

> **主键 id 为应用生成的短字符串**（`p_`+10hex 等），故用 `CharField(primary_key=True, max_length=64)`——既贴合现状，又规避 MySQL「TEXT 不能做主键」。

### 6.2 模型定义（6 表）

```python
class _Base(Model):
    class Meta:
        database = database  # build_database() 的产物

class Team(_Base):
    id = CharField(primary_key=True, max_length=64)
    name = CharField()
    color = CharField(default="#7db7ff")
    description = CharField(default="")
    sort_order = IntegerField(default=0)
    archived = IntegerField(default=0)
    created_at = CharField()
    updated_at = CharField()

class Person(_Base):
    id = CharField(primary_key=True, max_length=64)
    name = CharField()
    department = CharField(default="")
    role = CharField(default="")
    daily_capacity = FloatField(default=8)
    sort_order = IntegerField(default=0)
    archived = IntegerField(default=0)
    color = CharField(default="")
    home_team_id = CharField()          # 非外键：删团队=迁移归属，不级联
    created_at = CharField()
    updated_at = CharField()

class Project(_Base):
    id = CharField(primary_key=True, max_length=64)
    name = CharField()
    owner = CharField(default="")
    owner_id = CharField(default="")
    priority = CharField(default="中")
    color = CharField(default="#7db7ff")
    start_date = CharField(default="")
    end_date = CharField(default="")
    sort_order = IntegerField(default=0)
    archived = IntegerField(default=0)
    team_id = CharField()               # 非外键：同上
    created_at = CharField()
    updated_at = CharField()

class Assignment(_Base):
    id = CharField(primary_key=True, max_length=64)
    person = ForeignKeyField(Person, backref="assignments", on_delete="CASCADE")
    project = ForeignKeyField(Project, backref="assignments", on_delete="CASCADE")
    work_date = CharField()
    end_date = CharField(default="")
    hours = FloatField(default=8)
    note = CharField(default="")
    created_at = CharField()
    updated_at = CharField()

class Milestone(_Base):
    id = CharField(primary_key=True, max_length=64)
    project = ForeignKeyField(Project, backref="milestones", on_delete="CASCADE")
    name = CharField()
    milestone_date = CharField()
    level = CharField(default="important")
    owner = CharField(default="")
    owner_id = CharField(default="")
    description = CharField(default="")
    created_at = CharField()
    updated_at = CharField()

class Setting(_Base):
    team_id = CharField(default="")
    key = CharField()
    value = CharField()
    class Meta:
        database = database
        primary_key = CompositeKey("team_id", "key")
```

**外键语义对齐现状**（关键）：仅 `assignments.person/project`、`milestones.project` 带 `ON DELETE CASCADE`（删人员/项目级联清相关排期/里程碑）；`Person.home_team_id` / `Project.team_id` **故意不带 FK**——删团队时业务是**迁移到默认团队**（`delete_team` `server.py:883`），而非级联删数据。Peewee 模型精确复刻此语义。

### 6.3 建表

```python
def init_schema():
    database.connect(reuse_if_open=True)
    database.create_tables(
        [Team, Person, Project, Assignment, Milestone, Setting], safe=True)
```

`safe=True` → `CREATE TABLE IF NOT EXISTS`，逐表按方言编译。MySQL 下表引擎取实例默认（5.5+ 默认 InnoDB，满足 FK/级联）；字符集由连接 `charset="utf8mb4"` 保证。

### 6.4 日期仍存字符串（不变量）

`work_date`/`end_date`/`milestone_date`/`start_date`/`created_at`/`updated_at` 全部声明为 `CharField`（ISO 字符串）。理由与旧设计一致：应用层大量字符串字典序比较（`normalize_assignment_dates` `:897`、`_validate_project_dates` `:907`）与 `ORDER BY`，ISO 串在两后端字典序一致；转原生 `DATE`/`DateTimeField` 引入时区/格式转换，收益低。

---

## 7. 连接管理（Peewee 内建）

旧设计要手写的线程本地连接 + 断线重连，Peewee 内建：

- **`autoconnect=True`（默认）+ 内部 threading.local**：每个工作线程首次查询时自动 `connect()`、线程内复用，请求结束线程销毁时连接归还。`ThreadingHTTPServer` 每请求一线程天然适配。
- **MySQL 连接池**：`PooledMySQLDatabase(max_connections=16, stale_timeout=300)`——连接复用 + 空闲超时回收，替代手写重连逻辑；池内部处理 `wait_timeout` 断连后重新借出。
- **只读分享服务器**（`ensure_readonly_share_server` `server.py:185`）与可编辑服务同一进程、不同线程组，**共享同一个 `database` 对象**——Peewee 按线程各持连接，两端口语义上读同一库（SQLite 同 `DB_PATH` / MySQL 同 `MYSQL_DATABASE`），无需特殊处理。
- **SQLite**：维持 `SqliteDatabase`，无需池；外键靠 pragma。

> 即旧设计 §7「连接管理（MySQL 性能关键）」整节被 Peewee 吸收，仅保留「只读端口稀疏请求→池的 stale_timeout 回收」这一验证点（DoD）。

---

## 8. 查询分层（核心改造）

### 8.1 CRUD → 模型查询（替换 `rows()`/`one()`/`conn.execute()`）

驼峰序列化：DB snake_case → API camelCase。旧代码靠 SQL `AS home_team_id AS homeTeamId`（`server.py:602` 一带）；Peewee `.dicts()` 返回 snake_case dict，用一个 `to_camel()` 后处理统一映射（或 `select(...)` 时 `.dicts()` 后改名）。例：

```python
def list_people():
    rows = (Person
            .select(Person.id, Person.name, Person.department, Person.role,
                    Person.daily_capacity, Person.archived, Person.color,
                    Person.home_team_id, Person.sort_order, Person.created_at)
            .order_by(Person.sort_order, Person.created_at)
            .dicts())
    return [to_camel(r) for r in rows]   # daily_capacity→dailyCapacity, home_team_id→homeTeamId
```

- `one("SELECT id FROM teams WHERE id=?", (tid,))` → `Team.get_or_none(Team.id == tid)`
- `conn.execute("INSERT INTO people (...) VALUES (...)")` → `Person.create(...)` 或 `Person.insert({...}).execute()`
- 通用 `DELETE FROM {table} WHERE id=?`（`server.py:730`）→ `Model.delete().where(Model.id == rid).execute()`（仍按白名单分派到具体模型）

### 8.2 UPSERT / 幂等插入（替换 `ON CONFLICT` / `INSERT OR IGNORE`）

```python
# settings UPSERT（原 save_setting :745）
Setting.insert({"team_id": tid, "key": k, "value": v}) \
       .on_conflict(action="update", update={Setting.value: v}) \
       .execute()
# Peewee 自动：SQLite→ON CONFLICT(team_id,key) DO UPDATE；MySQL→ON DUPLICATE KEY UPDATE

# 默认团队/seed 幂等插入（原 INSERT OR IGNORE :466/:251 等）
Team.insert({...}).on_conflict_ignore().execute()
```

### 8.3 事务（替换 17 处 `with db() as conn:`）

```python
with database.atomic():       # 两后端一致：成功 commit / 异常 rollback
    Team.delete().where(Team.id == rid).execute()
    Person.update(home_team_id="tm_default").where(Person.home_team_id == rid).execute()
    ...
```

### 8.4 报表查询 → 保留裸 SQL（混合决策）

`export_csv`（`server.py:1166` 多表 JOIN）、`import_csv`（`:1011` 单连接多 execute）的复杂查询**保留为 `database.execute_sql(裸SQL, params)`**——只读、已正确、多表 JOIN，ORM 化收益低、风险高。Peewee 的 `execute_sql` 自动处理占位符风格，跨后端安全。

> **决策**（§17 Q1）：CRUD + 简单读用模型查询；复杂报表 JOIN 用裸 SQL。可逆——若后续要全 ORM 化再迁。

---

## 9. 迁移策略（混合）

### 9.1 建表：`create_tables(safe=True)`（§6.3）

### 9.2 历史增量迁移：保留裸 `execute_sql` + `get_columns` 自省

现有 0.0.1→0.0.4 的 `ALTER TABLE ADD COLUMN` 迁移（`server.py:434-502`）已**幂等且两后端语法兼容**。迁移点保留为 Peewee `database.execute_sql(...)`，列存在性检测从 `PRAGMA table_info` 改为 **`database.get_columns(table)`**（Peewee 跨后端自省，MySQL 走 `information_schema`）：

```python
cols = {c.name for c in database.get_columns("people")}
if "home_team_id" not in cols:
    database.execute_sql(
        "ALTER TABLE people ADD COLUMN home_team_id TEXT NOT NULL DEFAULT ''")
```

> `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT '...'` 在 MySQL 8.0 合法（instant ADD COLUMN）。

### 9.3 `settings` 复合主键重建（一次性历史迁移）

旧库的 `settings` 曾是单列主键，0.0.4 已迁为 `(team_id, key)`（`server.py:481-484` 的 `CREATE settings_new/INSERT/DROP/RENAME`）。此一次性迁移保留为裸 `execute_sql`；因 MySQL DDL 隐式提交、rollback 对 DDL 无效，迁移起始先 `execute_sql("DROP TABLE IF EXISTS settings_new")` 清理可能的孤儿表（幂等）。

### 9.4 未来迁移

新 schema 变更采用 `playhouse.migrate`（`SqliteMigrator` / `MySQLMigrator`）做跨后端迁移脚本，不再手写裸 `ALTER`。本期不引入，仅预留。

---

## 10. `init_db()` 改造

`init_db`（`server.py:360-508`）改造点：

| 行 | 现状 | 改造 |
| --- | --- | --- |
| `361` | `os.makedirs(dirname(DB_PATH))` | SQLite 路径保留；MySQL 跳过 |
| `362-363` | `os.remove(DB_PATH)`（reset） | `reset_schema()`：SQLite 删文件 / MySQL `database.drop_tables([...])` |
| `364-430` | `executescript(建表脚本)` | `init_schema()` → `create_tables(safe=True)` |
| `432/437/440/479/487/495` | `PRAGMA table_info` | `database.get_columns(table)` |
| `454-461` | **`r[0]`/`row[0]` 位置式访问**（颜色分配） | Peewee 模型/`.dicts()` 按属性访问，**该 bug 类自动消失** |
| `434-502` | 裸 `ALTER TABLE` | 保留 `execute_sql`，自省改 `get_columns` |
| `481-484` | `settings_new` 重建 | 保留 `execute_sql`，起始 `DROP TABLE IF EXISTS settings_new` |
| `504-508` | `conn.commit(); conn.close()` | `with database.atomic():` 包裹 |

`seed_from_initial_data`（`239-357`）的 `INSERT OR IGNORE`（6 处）→ `Model.insert({...}).on_conflict_ignore()`。

---

## 11. 实现陷阱（Peewee 专属 + 残留语义差异）

1. **MySQL 大小写不敏感**：默认 collation 下 `WHERE name='Alice'` 也匹配 `'alice'`、唯一约束大小写不敏感；SQLite 大小写敏感（非 ASCII）。依赖精确大小写的查询/唯一性需注意（如人员名查重）。文档提示，必要时 `BINARY` 比较。
2. **MySQL 严格 `sql_mode`**：越界/类型不符直接报错（SQLite 宽容）。字段类型声明 + CSV 导入的 `try/except`（`server.py:1113` 已有）兜底；DoD 覆盖严格模式 CSV 韧性。
3. **必须 `charset="utf8mb4"`**：否则中文/emoji 截断或报错；在 `MySQLDatabase(...)` 构造时设。
4. **引擎须 InnoDB**：MySQL 5.5+ 默认即 InnoDB；若目标实例改过默认引擎，FK/级联失效。建表后 `SHOW TABLE STATUS` 抽查。
5. **`lower_case_table_names`（Linux）运行时不可改**：建表统一小写（已满足）；启动 `SELECT @@lower_case_table_names` 探测，返回 0 且非 Win/macOS 则告警。
6. **`create_tables(safe=True)` 不 ALTER 既有表**：模型与既有表列不一致时不会自动补列——故历史增量迁移（§9.2）仍需保留，不能只靠模型声明。
7. **UPSERT `VALUES()` 在 MySQL 8.0.19+ 废弃**：由 Peewee `on_conflict` 内部处理，跟随其版本；本期锁 MySQL 8.0。
8. **`autoconnect` + 多线程**：Peewee 默认按线程持连，`ThreadingHTTPServer` 适配；但若显式跨线程复用同一 cursor 会出问题——保持「请求内查询、不跨线程传递 cursor」即可。
9. **`.dicts()` 返回 snake_case**：需 `to_camel()` 映射回 API 驼峰字段，别漏（前端依赖驼峰）。
10. **复合主键模型无 `.save()` 语义支持**：`Setting` 用 `CompositeKey`，写入走 `Setting.insert(...).on_conflict(...)`，不走 `Setting.create()` 的自增主键路径。

---

## 12. 依赖与部署

### 12.1 `requirements.txt`

```
peewee>=3.17,<4            # 数据层 ORM（必装，连 SQLite 也走它）
PyMySQL>=1.1,<2            # 仅 DB_BACKEND=mysql 时运行时需要
```

> 不再拆 `requirements-mysql.txt`：peewee 是必装项，PyMySQL 由 `DB_BACKEND` 决定是否 `import`（Peewee 的 MySQLDatabase 在连接时才需驱动，惰性生效）。DoD 仍验证「SQLite 路径不 import pymysql」。

### 12.2 Dockerfile

```dockerfile
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt   # peewee 必装；PyMySQL 装上备用（小）
COPY server.py db.py ./
COPY public/ ./public/
COPY config/ ./config/
RUN mkdir -p /app/data
EXPOSE 8787
CMD ["python3", "server.py"]
```

### 12.3 `docker-compose.yml`（MySQL 端到端验证）

```yaml
services:
  db:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: resource_scheduler
      MYSQL_USER: scheduler
      MYSQL_PASSWORD: scheduler
      MYSQL_ROOT_PASSWORD: root
    command: --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
    ports: ["3306:3306"]
  app:
    build: .
    environment:
      DB_BACKEND: mysql
      MYSQL_HOST: db
      MYSQL_PORT: "3306"
      MYSQL_USER: scheduler
      MYSQL_PASSWORD: scheduler
      MYSQL_DATABASE: resource_scheduler
    ports: ["8787:8787"]
    depends_on: [db]
```

---

## 13. 实现切片（Wave）

| Wave | 范围 | 主要拥有文件 |
| --- | --- | --- |
| W1 | 新增 `db.py`（或 `models.py`）：`build_database()` 配置读取 + 惰性 import pymysql + 6 个 Model + `init_schema()` + `to_camel()` + 报表裸 SQL helper | `db.py`（新增） |
| W2 | `init_db` 改造：`create_tables` + `get_columns` 自省 + 保留增量迁移 `execute_sql` + `settings_new` 预 DROP；`reset_schema` 分后端；颜色分配 `r[0]` 问题随模型消失 | `server.py:360-508` |
| W3 | CRUD 改模型查询：bootstrap 序列化、create/update/delete 改 `Model.*` + `to_camel`；`_validate_team`/`get_or_none` | `server.py` Handler |
| W4 | UPSERT/幂等：6 处 INSERT OR IGNORE → `on_conflict_ignore`；settings UPSERT → `on_conflict(update=)` | `server.py` |
| W5 | 事务：17 处 `with db()` → `with database.atomic()`；异常类型 `sqlite3.OperationalError` → Peewee `DatabaseError`（`server.py:598/623`） | `server.py` |
| W6 | 报表：`export_csv`/`import_csv` 的 JOIN 查询改 `database.execute_sql()` 裸 SQL | `server.py:991/1157` |
| W7 | 部署 + 验证：`requirements.txt`、Dockerfile、compose、README MySQL 章节；SQLite/MySQL 双后端全链路回归 | 根目录 + README |

---

## 14. 验证与上线标准（Definition of Done）

沿用 `docs/iteration-plan.md` 第 7 节基线，补充本特性专项：

1. **语法/编译**：`python3 -m py_compile server.py db.py` 通过。
2. **SQLite 默认路径**：`pip install -r requirements.txt` 后 `python3 server.py` 以 SQLite 正常启动；API/CRUD/CSV 全通。
3. **惰性 import pymysql**：`DB_BACKEND=sqlite` 时 `python3 -c "import db"` 不触发 `import pymysql`（MySQL 驱动仅 mysql 分支导入）。
4. **配置切换**：`DB_BACKEND=mysql` + 正确连接串 → 启动成功、banner 打印后端；连接串错误 → 启动即清晰报错（非静默回退）；未装 pymysql → 启动硬失败并提示。
5. **MySQL 建表**：新库 `init_db` 建出 6 表，引擎 InnoDB、字符集 utf8mb4、主键 `VARCHAR(64)`（`SHOW CREATE TABLE` 核对）。
6. **迁移幂等（两后端）**：已有 0.0.4 SQLite 真实库上启动 → 迁移成功、重复启动不报错；MySQL 空库首次启动 → 建表 + seed 正常；人为造孤儿 `settings_new` 后启动 → 清理成功不报错。
7. **CRUD 一致**：同一份初始数据，SQLite 与 MySQL 各跑 bootstrap，返回 JSON 深度相等（驼峰字段、行数）。
8. **级联删除（InnoDB）**：删人员 → 其排期/里程碑级联清空（Peewee `on_delete='CASCADE'` 生效）；删项目同。
9. **UPSERT 幂等**：连续两次 `POST /api/settings` 同 `(teamId,key)` → 一行、值更新（Peewee `on_conflict` 在两后端正确）。
10. **中文/emoji**：写入含 emoji 的备注、含「中」的项目名 → 导出 CSV / bootstrap 回读无截断、无乱码。
11. **连接池**：MySQL 下并发请求不爆连接数（`max_connections` 内）；只读端口空闲超 `stale_timeout` 后再请求 → 池正常回收/重借。
12. **严格模式 CSV 韧性**：目标 MySQL 开 `STRICT_TRANS_TABLES`，导入含非法工时/越界值 CSV → 非法行优雅 `skipped+1`、不 500。
13. **大小写敏感**：MySQL 下人员名查重行为与 SQLite 差异已记录（文档提示），不出现「同名不同大小写误判为不同人」的静默错误或反之。
14. **`lower_case_table_names` 探测**：连接时 `SELECT @@lower_case_table_names`；返回 0 且非 Win/macOS → 启动日志告警。
15. **报表裸 SQL 两后端**：`export_csv`/`import.csv` 在 MySQL 下与 SQLite 输出一致（行数、内容）。
16. **只读回归**：只读端口（`READONLY_SERVER`/`/api/share`）在 MySQL 后端下仍拒绝写、仍读同一库。
17. **文档同步**：README 增 MySQL 部署章节；`AGENTS.md` 技术栈约束已改为 Peewee；本文档勾选完成状态。

> 实现前自检：行号锚点对齐 0.0.4（2026-06-18）。若期间 `server.py` 有改动，用 `grep` 重新核对。

---

## 15. 风险与取舍

| 风险 | 取舍 / 缓解 |
| --- | --- |
| 默认 SQLite 不再零依赖 | 已由决策方接受；`requirements.txt` 装 peewee（小、纯 Python） |
| 数据层重写工作量 | CRUD→模型查询有批量替换规律；报表 JOIN 保留裸 SQL 降风险（§8.4） |
| Peewee 大小写/严格模式语义差异 | §11 逐条 + DoD 覆盖 |
| `create_tables` 不修既有表 | 保留历史增量迁移（§9.2），不依赖模型声明自动补列 |
| MySQL 版本（`VALUES()` 废弃） | 锁 8.0；由 Peewee `on_conflict` 内部适配 |
| SQLite↔MySQL 一次性数据搬迁 | 本期不做工具；CSV 导出/导入兜底 |

---

## 16. 决策记录（开放问题）

| # | 问题 | 决定 | 依据 |
| --- | --- | --- | --- |
| **方向** | 手写 db.py vs 框架 | **Peewee**（废弃手写 db.py） | 项目已朝 Docker/MySQL 演进，零依赖非硬约束；Peewee 吸收绝大多数方言陷阱（§2.1） |
| Q1 | 查询分层 | CRUD + 简单读用模型查询；复杂报表 JOIN 用裸 `execute_sql`（混合） | 报表只读、已正确、ORM 化收益低；可逆 |
| Q2 | 历史迁移工具 | 保留裸 `execute_sql` + `get_columns`；未来用 `playhouse.migrate` | 现有迁移幂等两后端兼容；最小改动风险 |
| Q3 | 连接池 | `PooledMySQLDatabase`；SQLite 不池 | Peewee 内建，替代手写线程本地 |
| Q4 | 日期列类型 | `CharField`（ISO 串），不用 `DateTimeField` | 字典序比较一致、零转换；与现状对齐 |
| Q5 | `DB_BACKEND=mysql` 未装驱动 | 启动硬失败、提示安装 | 不静默回退，避免误连空库 |
| Q6 | 其他后端（PG 等） | 架构预留，不实现 | 控制范围 |

---

## 17. 与未来的关系

- **0.1.0 模块拆分**：`db.py`（模型）是数据层模块化第一步；未来可演进 Repository 模式。
- **0.1.0 访问控制**：集中式 MySQL 部署为鉴权/审计/备份提供基础设施。
- **迁移工具升级**：`playhouse.migrate` 为后续 schema 变更提供跨后端脚本能力（§9.4）。
- **可观测性**：Peewee + 连接池便于接入慢查询日志、池监控。

---

## 18. 修订记录

| 日期 | 版本 | 变更 |
| --- | --- | --- |
| 2026-06-18 | 0.0.5 Peewee 方案 | **方向转向 Peewee**（决策方选定，废弃手写 db.py）：数据层重写为 Peewee 模型/查询；§2.1 对照表说明 Peewee 吸收的方言陷阱（占位符/主键类型/UPSERT/自省/建表/行访问/连接池/事务）；§4-§8 架构（build_database 后端切换、6 模型、PooledMySQLDatabase 连接池、CRUD→模型查询、混合报表裸 SQL、atomic() 事务）；§9 迁移（create_tables + get_columns + 历史迁移保留 execute_sql + settings_new 预 DROP）；§11 Peewee 专属陷阱（大小写/严格模式/charset/引擎/create_tables 不补列/复合主键）；§12 依赖（peewee 必装 + pymysql 惰性）；§13 Wave；§14 DoD 17 项；§16 决策表（方向 + Q1-Q6）。同步修订 `AGENTS.md` 技术栈为 Peewee 驱动。 |
| 2026-06-18 | 0.0.5 评审加固（手写 db.py 方向，已废弃） | 独立 agent 评审手写 db.py：补位置式 `r[0]`、DictCursor tuple、DDL 隐式提交、严格模式等审计遗漏。**本条为历史记录，对应方向已被 Peewee 方案取代。** |
| 2026-06-18 | 0.0.5 设计定稿（手写 db.py 方向，已废弃） | 初版手写 DBAL 方案。**已被 Peewee 方案取代。** |

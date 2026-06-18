#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Resource Scheduler 0.1.0
纯 Python 标准库 + SQLite，可直接运行：python3 server.py
"""
import base64
import csv
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import sqlite3
import socket
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.environ.get("DB_PATH", os.path.join(DATA_DIR, "scheduler.sqlite"))
CONFIG_DIR = os.environ.get("CONFIG_DIR", os.path.join(BASE_DIR, "config"))
INITIAL_DATA_PATH = os.environ.get("INITIAL_DATA_PATH", os.path.join(CONFIG_DIR, "initial-data.json"))

DEFAULT_COLORS = ["#7db7ff", "#92d987", "#ff91b8", "#b69cff", "#ffd86b"]

# ── 节假日在线自刷新（F1.3+）：服务端多镜像代理 + 本地缓存 ──
# 客户端只调 /api/holidays；服务端负责联网拉取最新数据（多镜像顺序兜底）并落盘缓存，
# 离线 / 拉取失败时回退到随包静态资源 BASE_DIR/data/holidays-<year>.json。
# 可用环境变量 HOLIDAY_MIRRORS 覆盖镜像列表（逗号分隔，{year} 占位符），
# 用于接入 gitee 镜像或内网地址，规避国内对 jsdelivr 的封锁。
HOLIDAY_FETCH_TIMEOUT = 5
HOLIDAY_REFRESH_TTL = 24 * 3600  # 本地缓存最多每 24h 在后台刷新一次
HOLIDAY_MIRRORS_DEFAULT = ",".join([
    "https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json",
    "https://gcore.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json",
    "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json",
])
_holiday_refresh_locks = {}
_holiday_refresh_lock = threading.Lock()


def _holiday_cache_path(year):
    return os.path.join(DATA_DIR, f"holidays-cache-{year}.json")


def _holiday_local_payload(year):
    """返回本地最佳可用节假日数据（联网缓存 → 随包静态资源 → 用户目录 → None）。"""
    fname = f"holidays-{year}.json"
    for path in (_holiday_cache_path(year),
                 os.path.join(BASE_DIR, "data", fname),
                 os.path.join(DATA_DIR, fname)):
        if path and os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    payload = json.load(f)
                if isinstance(payload, dict) and isinstance(payload.get("days"), list):
                    return payload
            except Exception:
                continue
    return None


def _fetch_holidays_online(year):
    """按镜像顺序尝试拉取，返回含非空 days 数组的 dict 或 None。"""
    import urllib.request
    mirrors = [m.strip() for m in
               os.environ.get("HOLIDAY_MIRRORS", HOLIDAY_MIRRORS_DEFAULT).split(",") if m.strip()]
    for url in mirrors:
        try:
            req = urllib.request.Request(url.format(year=year),
                                         headers={"User-Agent": "resource-scheduler/0.1.0"})
            with urllib.request.urlopen(req, timeout=HOLIDAY_FETCH_TIMEOUT) as resp:
                if getattr(resp, "status", 200) != 200:
                    continue
                payload = json.loads(resp.read().decode("utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("days"), list) and payload["days"]:
                return payload
        except Exception:
            continue
    return None


def _write_holiday_cache(year, payload):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        path = _holiday_cache_path(year)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, path)  # 原子替换，避免并发读到半截文件
    except Exception:
        pass


def _trigger_holiday_refresh(year):
    """后台刷新：本地已有数据时，缓存过期或缺失才联网拉取最新并落盘，离线静默保留旧缓存。"""
    cache = _holiday_cache_path(year)
    stale = True
    if os.path.isfile(cache):
        try:
            stale = datetime.now().timestamp() - os.path.getmtime(cache) > HOLIDAY_REFRESH_TTL
        except Exception:
            stale = True
    if not stale:
        return
    with _holiday_refresh_lock:
        lock = _holiday_refresh_locks.setdefault(year, threading.Lock())
        if not lock.acquire(blocking=False):  # 同一年只允许一个刷新线程
            return

    def worker():
        try:
            payload = _fetch_holidays_online(year)
            if payload:
                _write_holiday_cache(year, payload)
        finally:
            lock.release()

    threading.Thread(target=worker, name=f"holiday-refresh-{year}", daemon=True).start()


def truthy_env(name):
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def is_readonly_server():
    return truthy_env("READONLY_SERVER")


def local_share_host():
    """Return the best-effort LAN IPv4 address for read-only sharing."""
    override = os.environ.get("SHARE_HOST", "").strip()
    if override:
        return override
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        candidate = sock.getsockname()[0]
        ip = ipaddress.ip_address(candidate)
        if ip.version == 4 and ip.is_private and not ip.is_loopback and not ip.is_link_local and not ip.is_reserved:
            return candidate
        return candidate
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


class SchedulerHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    # 默认 backlog=5；页面并行拉取多个 JS 模块时，突发连接偶发被 OS 拒绝（ERR_CONNECTION_RESET）。
    request_queue_size = 128

    def __init__(self, server_address, request_handler_class, read_only=False):
        self.read_only = read_only
        super().__init__(server_address, request_handler_class)

    def handle_error(self, request, client_address):
        # 客户端中途断开（ConnectionReset/BrokenPipe）是常态，无需打印堆栈噪声。
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


_readonly_share_server = None
_readonly_share_port = None
_readonly_share_lock = threading.Lock()


def readonly_share_port():
    value = os.environ.get("READONLY_PORT", "").strip()
    if not value:
        try:
            base_port = int(os.environ.get("PORT", "8787"))
            return base_port + 1
        except ValueError:
            return 8788
    return int(value)


def ensure_readonly_share_server(handler_class):
    """Start the in-process read-only LAN server on the configured port."""
    global _readonly_share_server, _readonly_share_port
    port = readonly_share_port()
    if is_readonly_server():
        return port
    with _readonly_share_lock:
        if _readonly_share_server:
            return _readonly_share_port or port
        if port is None or port == 0:
            server = SchedulerHTTPServer(("0.0.0.0", 0), handler_class, read_only=True)
        else:
            server = SchedulerHTTPServer(("0.0.0.0", port), handler_class, read_only=True)
        thread = threading.Thread(target=server.serve_forever, name="readonly-share-server", daemon=True)
        thread.start()
        _readonly_share_server = server
        _readonly_share_port = int(server.server_address[1])
    return _readonly_share_port


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn



def load_initial_data():
    """读取首次运行预置数据；不存在或格式异常时回退为空配置。"""
    if not os.path.exists(INITIAL_DATA_PATH):
        return {"teams": [], "people": [], "projects": [], "milestones": [], "assignments": []}
    with open(INITIAL_DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    for key in ("teams", "people", "projects", "milestones", "assignments"):
        if key not in data or not isinstance(data[key], list):
            data[key] = []
    return data


def resolve_date(value):
    """支持 YYYY-MM-DD 绝对日期，也支持 today+N / today-N。"""
    value = str(value or "").strip()
    if not value:
        return datetime.now().date().isoformat()
    if value.startswith("today"):
        expr = value.replace("today", "", 1).strip()
        offset = 0
        if expr:
            offset = int(expr)
        return (datetime.now().date() + timedelta(days=offset)).isoformat()
    return datetime.fromisoformat(value).date().isoformat()


def seed_from_initial_data(cur):
    data = load_initial_data()
    t = now()
    default_capacity = float(data.get("dailyCapacity") or 8)

    # teams 必须先于 people/projects 种子，以便归属引用合法（tm_default 已由迁移建好）。
    for idx, item in enumerate(data.get("teams", [])):
        rid = str(item.get("id", "")).strip()
        name = str(item.get("name", "")).strip()
        if not rid or not name:
            continue
        cur.execute(
            "INSERT OR IGNORE INTO teams(id,name,color,description,sort_order,archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (rid, name, item.get("color") or "#7db7ff", str(item.get("description", "")).strip(),
             item.get("sortOrder", idx + 1), 0, t, t)
        )

    for idx, item in enumerate(data.get("people", [])):
        rid = item.get("id")
        name = str(item.get("name", "")).strip()
        if not rid or not name:
            continue
        home_team = str(item.get("homeTeamId", "")).strip() or "tm_default"
        cur.execute(
            "INSERT OR IGNORE INTO people(id,name,department,role,daily_capacity,created_at,updated_at,sort_order,archived,color,home_team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                rid,
                name,
                str(item.get("department", "")).strip(),
                str(item.get("role", "")).strip(),
                float(item.get("dailyCapacity") or default_capacity),
                t,
                t,
                item.get("sortOrder", idx + 1),
                0,
                str(item.get("color", "")).strip(),
                home_team,
            )
        )

    people_name_to_id = {}
    for item in data.get("people", []):
        p_name = str(item.get("name", "")).strip()
        p_id = str(item.get("id", "")).strip()
        if p_name and p_id:
            people_name_to_id[p_name] = p_id

    for idx, item in enumerate(data.get("projects", [])):
        rid = item.get("id")
        name = str(item.get("name", "")).strip()
        if not rid or not name:
            continue
        team = str(item.get("teamId", "")).strip() or "tm_default"
        owner_name = str(item.get("owner", "")).strip()
        owner_id = people_name_to_id.get(owner_name, "")
        cur.execute(
            "INSERT OR IGNORE INTO projects(id,name,owner,owner_id,priority,color,created_at,updated_at,sort_order,start_date,end_date,archived,team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                rid,
                name,
                owner_name,
                owner_id,
                str(item.get("priority", "中")).strip() or "中",
                item.get("color") or "#7db7ff",
                t,
                t,
                item.get("sortOrder", idx + 1),
                str(item.get("startDate", "")).strip(),
                str(item.get("endDate", "")).strip(),
                0,
                team,
            )
        )

    for item in data.get("milestones", []):
        rid = item.get("id")
        project_id = item.get("projectId")
        name = str(item.get("name", "")).strip()
        if not rid or not project_id or not name:
            continue
        owner_name = str(item.get("owner", "")).strip()
        owner_id = people_name_to_id.get(owner_name, "")
        cur.execute(
            "INSERT OR IGNORE INTO milestones(id,project_id,name,milestone_date,level,owner,owner_id,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                rid,
                project_id,
                name,
                resolve_date(item.get("date") or item.get("milestoneDate")),
                str(item.get("level", "important")).strip() or "important",
                owner_name,
                owner_id,
                str(item.get("description", "")).strip(),
                t,
                t,
            )
        )

    for item in data.get("assignments", []):
        rid = item.get("id")
        person_id = item.get("personId")
        project_id = item.get("projectId")
        if not rid or not person_id or not project_id:
            continue
        start_date = resolve_date(item.get("startDate") or item.get("date") or item.get("workDate"))
        end_date = resolve_date(item.get("endDate") or item.get("date") or item.get("workDate") or start_date)
        if end_date < start_date:
            start_date, end_date = end_date, start_date
        cur.execute("INSERT OR IGNORE INTO assignments VALUES (?,?,?,?,?,?,?,?,?)", (
            rid,
            person_id,
            project_id,
            start_date,
            end_date,
            float(item.get("hours") or default_capacity),
            str(item.get("note", "")).strip(),
            t,
            t,
        ))


def init_db(reset=False, seed=True):
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    if reset and os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = db()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS people (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            department TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT '',
            daily_capacity REAL NOT NULL DEFAULT 8,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner TEXT NOT NULL DEFAULT '',
            owner_id TEXT NOT NULL DEFAULT '',
            priority TEXT NOT NULL DEFAULT '中',
            color TEXT NOT NULL DEFAULT '#7db7ff',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assignments (
            id TEXT PRIMARY KEY,
            person_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            work_date TEXT NOT NULL,
            end_date TEXT NOT NULL DEFAULT '',
            hours REAL NOT NULL DEFAULT 8,
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS milestones (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            milestone_date TEXT NOT NULL,
            level TEXT NOT NULL DEFAULT 'important',
            owner TEXT NOT NULL DEFAULT '',
            owner_id TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
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
        CREATE TABLE IF NOT EXISTS settings (
            team_id TEXT NOT NULL DEFAULT '',
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (team_id, key)
        );
        CREATE TABLE IF NOT EXISTS team_auth (
            team_id   TEXT PRIMARY KEY,   -- 'tm_xxx'；超管不在此表（env 驱动）
            pwd_hash  TEXT NOT NULL,      -- pbkdf2_sha256$<iters>$<salt_b64>$<hash_b64>
            updated_at TEXT NOT NULL
        );
        """
    )
    # 0.0.1+ migration: support date ranges for assignments.
    assignment_columns = [r["name"] for r in cur.execute("PRAGMA table_info(assignments)").fetchall()]
    if "end_date" not in assignment_columns:
        cur.execute("ALTER TABLE assignments ADD COLUMN end_date TEXT NOT NULL DEFAULT ''")
        cur.execute("UPDATE assignments SET end_date = work_date WHERE end_date = ''")
    # 0.0.2 migration: sort_order for people/projects, project date range.
    people_columns = [r["name"] for r in cur.execute("PRAGMA table_info(people)").fetchall()]
    if "sort_order" not in people_columns:
        cur.execute("ALTER TABLE people ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    projects_columns = [r["name"] for r in cur.execute("PRAGMA table_info(projects)").fetchall()]
    if "sort_order" not in projects_columns:
        cur.execute("ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    if "start_date" not in projects_columns:
        cur.execute("ALTER TABLE projects ADD COLUMN start_date TEXT NOT NULL DEFAULT ''")
    if "end_date" not in projects_columns:
        cur.execute("ALTER TABLE projects ADD COLUMN end_date TEXT NOT NULL DEFAULT ''")
    if "archived" not in people_columns:
        cur.execute("ALTER TABLE people ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
    if "archived" not in projects_columns:
        cur.execute("ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
    if "color" not in people_columns:
        cur.execute("ALTER TABLE people ADD COLUMN color TEXT NOT NULL DEFAULT ''")
    # 为无色人员分配不重复颜色
    uncolored = cur.execute("SELECT id FROM people WHERE color=''").fetchall()
    if uncolored:
        used = {r[0] for r in cur.execute("SELECT color FROM people WHERE color!=''").fetchall()}
        palette = ['#7db7ff','#92d987','#ffb84d','#b69cff','#ff9f9f','#7ee0d6','#ffd86b','#c4a484','#b8e986','#f7a8d8','#9ad1ff','#d4b5ff']
        avail = [c for c in palette if c not in used]
        for i, row in enumerate(uncolored):
            color = avail[i % len(avail)] if avail else palette[i % len(palette)]
            cur.execute("UPDATE people SET color=? WHERE id=?", (color, row[0]))

    # ── 0.0.4 团队工作区迁移：teams 一级实体 + people/projects 单一归属 + settings per-team ──
    # 1) 默认团队（固定 id tm_default，幂等）——必须在归属列回填前存在，作为兜底归属。
    cur.execute(
        "INSERT OR IGNORE INTO teams(id,name,color,description,sort_order,archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        ('tm_default', '通用', '#7db7ff', '', 0, 0, now(), now())
    )
    # 2) people.home_team_id / projects.team_id：单一归属，永不为空。
    #    复用上方已取的 people_columns / projects_columns（迁移前快照，新列必不在其中）。
    if "home_team_id" not in people_columns:
        cur.execute("ALTER TABLE people ADD COLUMN home_team_id TEXT NOT NULL DEFAULT ''")
    if "team_id" not in projects_columns:
        cur.execute("ALTER TABLE projects ADD COLUMN team_id TEXT NOT NULL DEFAULT ''")
    # 消除所有 '' 与指向已删团队的游离引用 → 统一归默认团队（保证归属完整性）。
    cur.execute("UPDATE people SET home_team_id='tm_default' WHERE home_team_id='' OR home_team_id NOT IN (SELECT id FROM teams)")
    cur.execute("UPDATE projects SET team_id='tm_default' WHERE team_id='' OR team_id NOT IN (SELECT id FROM teams)")
    # 3) settings 演进为 per-team（复合主键 team_id+key）。旧库为单列主键 → 重建表迁数据。
    settings_columns = [r["name"] for r in cur.execute("PRAGMA table_info(settings)").fetchall()]
    if "team_id" not in settings_columns:
        cur.execute("CREATE TABLE settings_new (team_id TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (team_id, key))")
        cur.execute("INSERT INTO settings_new(team_id, key, value) SELECT '', key, value FROM settings")
        cur.execute("DROP TABLE settings")
        cur.execute("ALTER TABLE settings_new RENAME TO settings")

    # ── 0.0.5 setting redesign migration: milestones & projects owner_id ──
    milestone_cols = [r["name"] for r in cur.execute("PRAGMA table_info(milestones)").fetchall()]
    if "owner_id" not in milestone_cols:
        cur.execute("ALTER TABLE milestones ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''")
        cur.execute("""
            UPDATE milestones
            SET owner_id = (SELECT p.id FROM people p WHERE p.name = milestones.owner AND p.name <> '')
            WHERE owner_id = '' AND owner <> ''
        """)
    project_cols = [r["name"] for r in cur.execute("PRAGMA table_info(projects)").fetchall()]
    if "owner_id" not in project_cols:
        cur.execute("ALTER TABLE projects ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''")
        cur.execute("""
            UPDATE projects
            SET owner_id = (SELECT p.id FROM people p WHERE p.name = projects.owner AND p.name <> '')
            WHERE owner_id = '' AND owner <> ''
        """)

    count = cur.execute("SELECT COUNT(*) AS c FROM people").fetchone()["c"]
    if seed and count == 0:
        seed_from_initial_data(cur)
    conn.commit()
    conn.close()


def date_offset(days):
    return (datetime.now().date() + timedelta(days=days)).isoformat()


def rows(sql, params=()):
    with db() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def one(sql, params=()):
    with db() as conn:
        r = conn.execute(sql, params).fetchone()
        return dict(r) if r else None


def now():
    return datetime.now().isoformat(timespec="seconds")


def new_id(prefix):
    return prefix + "_" + uuid.uuid4().hex[:10]


# ── 0.1.0 团队操作密码：密码哈希（stdlib PBKDF2）+ 进程内累积式会话 ──
_PBKDF2_ITERS = 600_000                 # OWASP 2023 推荐；verify 兼容旧 hash（按各自存储的 iters）
_PBKDF2_ITERS_MAX = _PBKDF2_ITERS * 4   # verify 时 iters 上限：防构造超大 iters 单请求阻塞（DoS）
_PASSWORD_MAX = 4096                    # 密码长度上限：防超长输入使 pbkdf2 在 GB 级输入上空转


def hash_password(pw: str) -> str:
    """PBKDF2-HMAC-SHA256 哈希；格式 pbkdf2_sha256$<iters>$<salt_b64>$<hash_b64>。"""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, _PBKDF2_ITERS)
    return f"pbkdf2_sha256${_PBKDF2_ITERS}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(pw: str, stored: str) -> bool:
    """恒定时间校验；任何格式异常或 iters 越界返回 False。"""
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        n = int(iters)
        if n < 1 or n > _PBKDF2_ITERS_MAX:
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), base64.b64decode(salt_b64), n)
        return hmac.compare_digest(dk, base64.b64decode(hash_b64))
    except Exception:
        return False


_SESSION_TTL = 12 * 3600  # 12h
_sessions = {}            # token -> {"teamIds": set[str], "isAdmin": bool, "exp": ts}
_sessions_lock = threading.Lock()


def _new_session_token():
    return secrets.token_urlsafe(32)


def _session_put(token, *, team_id=None, is_admin=False):
    """累积式：admin 置位、team 加入 set；刷新过期时间。"""
    with _sessions_lock:
        s = _sessions.setdefault(token, {"teamIds": set(), "isAdmin": False, "exp": 0})
        if is_admin:
            s["isAdmin"] = True
        if team_id:
            s["teamIds"].add(team_id)
        s["exp"] = time.time() + _SESSION_TTL
        return s


# ── 解锁限速：按「客户端 IP + 目标维度」计连续失败，达上限短期锁定，防公网在线爆破 ──
_AUTH_FAIL_MAX = 5              # 连续失败上限
_AUTH_FAIL_LOCK = 30            # 达上限后锁定秒数
_MAX_BODY = 4 * 1024 * 1024     # JSON 请求体上限 4MB（防超大 body OOM；CSV 导入走独立读取不受此限）
_auth_fails = {}                # key -> {"fails": int, "lock_until": ts}
_auth_fails_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    # 启用 HTTP/1.1 keep-alive：浏览器可复用连接依次拉取多个 JS 模块，
    # 避免每资源新建/拆除连接在并行突发下偶发的 ERR_CONNECTION_RESET。
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _drain_request_body(self):
        # keep-alive 下，未读取的请求体残留字节会污染同连接的下一个请求；
        # 凡是不读取 body 就返回的分支（如只读拒绝），必须先抽干。
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            length = 0
        if length > 0:
            try:
                self.rfile.read(length)
            except OSError:
                self.close_connection = True

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        # close_connection 置位时（如请求体超限未读取），显式通知客户端断开，
        # 避免其复用已废弃的连接；正常 keep-alive 不发此头。
        if self.close_connection:
            self.send_header("Connection", "close")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        if length > _MAX_BODY:
            # 超限：不读入内存（防 OOM），标记关闭连接——响应后连接断开，
            # 残留 body 字节随连接丢弃，杜绝污染同连接下一请求（501/414 desync）。
            self.close_connection = True
            raise ValueError(f"request body too large ({length} > {_MAX_BODY})")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return super().do_GET()
        try:
            if parsed.path == "/api/auth/session":
                return self.auth_session()
            if parsed.path == "/api/share":
                try:
                    share_port = ensure_readonly_share_server(type(self)) or int(os.environ.get("PORT", "8787"))
                except OSError as e:
                    return self.send_json({"error": f"只读分享端口启动失败：{e}"}, 500)
                self.send_json({"url": f"http://{local_share_host()}:{share_port}/", "readOnly": True})
            elif parsed.path == "/api/bootstrap":
                # per-team settings：?team=<id> 时取「全局档 + 该团队档」并让团队档覆盖全局档；
                # 无参数时只返回全局档（team_id=''），向后兼容旧前端。
                query = parse_qs(parsed.query)
                team_filter = (query.get("team", [""])[0] or "").strip()
                settings_dict = {}
                try:
                    if team_filter:
                        # ORDER BY team_id：'' 排在非空 team 之前，团队档后写覆盖全局档
                        for r in rows("SELECT team_id, key, value FROM settings WHERE team_id IN ('', ?) ORDER BY team_id", (team_filter,)):
                            settings_dict[r["key"]] = r["value"]
                    else:
                        for r in rows("SELECT key, value FROM settings WHERE team_id=''"):
                            settings_dict[r["key"]] = r["value"]
                except sqlite3.OperationalError:
                    pass
                self.send_json({
                    "teams": rows("SELECT id,name,color,description,sort_order AS sortOrder,archived FROM teams ORDER BY sort_order, created_at"),
                    "people": rows("SELECT id,name,department,role,daily_capacity AS dailyCapacity,archived,color,home_team_id AS homeTeamId FROM people ORDER BY sort_order, created_at"),
                    "projects": rows("SELECT id,name,owner,owner_id AS ownerId,priority,color,start_date AS startDate,end_date AS endDate,archived,team_id AS teamId FROM projects ORDER BY sort_order, created_at"),
                    "assignments": rows("SELECT id,person_id AS personId,project_id AS projectId,work_date AS date,end_date AS endDate,hours,note FROM assignments ORDER BY work_date"),
                    "milestones": rows("SELECT id,project_id AS projectId,name,milestone_date AS date,level,owner,owner_id AS ownerId,description FROM milestones ORDER BY milestone_date"),
                    "readOnly": self.is_readonly_view(parsed),
                    "settings": settings_dict,
                    # 0.1.0 操作密码：哪些团队已设密（仅布尔，绝不暴露 hash）+ 编辑锁是否生效
                    "teamAuth": {r["team_id"]: True for r in rows("SELECT team_id FROM team_auth")},
                    "authEnabled": self.auth_enabled(),
                })
            elif parsed.path == "/api/export.csv":
                self.export_csv()
            elif parsed.path == "/api/settings":
                # 轻量取 per-team 设置（?team= 时团队档覆盖全局档；无参数只返回全局档）。供前端切换团队时即时回填。
                query = parse_qs(parsed.query)
                team_filter = (query.get("team", [""])[0] or "").strip()
                settings_dict = {}
                try:
                    if team_filter:
                        for r in rows("SELECT team_id, key, value FROM settings WHERE team_id IN ('', ?) ORDER BY team_id", (team_filter,)):
                            settings_dict[r["key"]] = r["value"]
                    else:
                        for r in rows("SELECT key, value FROM settings WHERE team_id=''"):
                            settings_dict[r["key"]] = r["value"]
                except sqlite3.OperationalError:
                    pass
                self.send_json({"settings": settings_dict})
            elif parsed.path == "/api/holidays":
                self.holidays_json(parsed)
            else:
                self.send_json({"error": "not found"}, 404)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def is_local_client(self):
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return False

    def is_readonly_server_context(self):
        return is_readonly_server() or bool(getattr(self.server, "read_only", False))

    def has_readonly_marker(self, parsed=None):
        if self.headers.get("X-Read-Only", "").lower() == "true":
            return True
        if parsed is None:
            parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        return query.get("readonly", [""])[0] == "1" or query.get("mode", [""])[0] == "readonly"

    def is_readonly_view(self, parsed=None):
        # 显式只读（只读服务器实例 / ?readonly=1 / X-Read-Only）始终生效，密码也无法覆盖
        if self.is_readonly_server_context() or self.has_readonly_marker(parsed):
            return True
        # 已开启操作密码：编辑由 require_* 密码门控，不再用 IP 粗粒度只读门（密码即保护）。
        # 否则未解锁的远程访问者每条写操作仍会被 require_team/require_admin 挡回 403。
        if self.auth_enabled():
            return False
        return not self.is_local_client() and not truthy_env("ALLOW_REMOTE_WRITE")

    def reject_if_readonly(self):
        if self.is_readonly_server_context() or self.has_readonly_marker():
            self._drain_request_body()
            self.send_json({"error": "当前端口为只读访问，不能修改排期数据"}, 403)
            return True
        # 已开启操作密码：放行至 require_* 密码门（密码即保护，取代 IP 粗粒度只读门）。
        if self.auth_enabled():
            return False
        if not self.is_local_client() and not truthy_env("ALLOW_REMOTE_WRITE"):
            self._drain_request_body()
            self.send_json({"error": "当前端口为只读访问，不能修改排期数据"}, 403)
            return True
        return False

    # ── 0.1.0 团队操作密码：鉴权辅助（仿 reject_if_readonly 的「返回 True=已拦截」模式）──
    def auth_enabled(self):
        """编辑锁是否生效：配置了 ADMIN_PASSWORD 或 team_auth 表有任意行。未配置则关闭（灰度安全）。"""
        return bool(os.environ.get("ADMIN_PASSWORD", "").strip()) or \
               bool(one("SELECT 1 FROM team_auth LIMIT 1"))

    def current_session(self):
        token = self.headers.get("X-Auth-Token", "")
        if not token:
            return None
        with _sessions_lock:
            s = _sessions.get(token)
            if not s:
                return None
            if s["exp"] < time.time():
                _sessions.pop(token, None)  # 顺手清理过期 token，避免 _sessions 无界增长
                return None
            return s

    def _block_auth(self, body, status=403, drain=False):
        """同一请求内最多发送一次鉴权拦截响应：防 handler 把 or 误写成 and 等导致
        require_* 被多次调用而双 send，损坏 keep-alive 响应。"""
        if getattr(self, "_auth_blocked", False):
            return True
        if drain:
            self._drain_request_body()
        self.send_json(body, status)
        self._auth_blocked = True
        return True

    def require_admin(self, drain=False):
        """超管门。drain=True 用于 body 尚未读取的早期路由（reset/import.csv/team-password）。"""
        if not self.auth_enabled():
            return False
        s = self.current_session()
        if s and s["isAdmin"]:
            return False
        return self._block_auth({"error": "需要超管解锁", "requireAdmin": True}, 403, drain=drain)

    def require_team(self, team_id, team_name=""):
        """团队门（per-team 模型，选项A）：
        - auth 关 → 放行（灰度安全）。
        - 超管会话 → 放行（超管可写任意团队）。
        - 已设密码团队 → 该团队解锁者（team_id ∈ session.teamIds）可写，否则 403 requireUnlock。
        - 未设密码团队 → 仅超管可写；非超管 403 requireAdmin（公网匿名无法写入任何团队）。
        隔离铁律：受保护团队只能被超管或其解锁者写入。注意：仅在 body 已被 read_json
        消费后的 handler 内调用，故不排空。"""
        if not self.auth_enabled() or not team_id:
            return False
        s = self.current_session()
        if s and s["isAdmin"]:
            return False
        if one("SELECT 1 FROM team_auth WHERE team_id=?", (team_id,)):
            # 已设密码：该团队解锁者可写
            if s and team_id in s["teamIds"]:
                return False
            if not team_name:
                r = one("SELECT name FROM teams WHERE id=?", (team_id,))
                team_name = r["name"] if r else ""
            return self._block_auth({"error": "需要解锁团队", "requireUnlock": team_id, "teamName": team_name}, 403)
        # 未设密码：仅超管（已在上方放行）；非超管 → 需超管解锁
        return self._block_auth({"error": "需要超管解锁", "requireAdmin": True}, 403)

    def _project_team_id(self, project_id):
        r = one("SELECT team_id FROM projects WHERE id=?", (project_id,))
        return r["team_id"] if r else ""

    def _record_team(self, table, rid):
        """取被写记录当前的所属团队（用于 delete 鉴权；assignment/milestone 经 project 推导）。"""
        if table == "people":
            r = one("SELECT home_team_id FROM people WHERE id=?", (rid,))
            return r["home_team_id"] if r else None
        if table == "projects":
            r = one("SELECT team_id FROM projects WHERE id=?", (rid,))
            return r["team_id"] if r else None
        if table == "assignments":
            r = one("SELECT pr.team_id AS team_id FROM assignments a JOIN projects pr ON pr.id=a.project_id WHERE a.id=?", (rid,))
            return r["team_id"] if r else None
        if table == "milestones":
            r = one("SELECT pr.team_id AS team_id FROM milestones m JOIN projects pr ON pr.id=m.project_id WHERE m.id=?", (rid,))
            return r["team_id"] if r else None
        return None

    # ── auth 端点（不过 reject_if_readonly；解锁/设密不能被只读门挡住）──
    def _session_view(self, token, s, include_token=True):
        out = {"isAdmin": bool(s["isAdmin"]), "teamIds": sorted(s["teamIds"]), "exp": int(s["exp"])}
        if include_token:
            out["token"] = token
        return out

    def _auth_rate_check(self, team_id):
        """返回 (allowed, retry_after)。连续失败达上限时短期锁定。"""
        ip = self.client_address[0] if self.client_address else "?"
        key = f"{ip}:{team_id or 'admin'}"
        now = time.time()
        with _auth_fails_lock:
            rec = _auth_fails.get(key)
            if rec and rec.get("lock_until", 0) > now:
                return False, int(rec["lock_until"] - now) + 1
        return True, 0

    def _auth_rate_record(self, team_id, ok):
        """ok=True 清零失败计数；ok=False 累加，达上限置锁定截止。"""
        ip = self.client_address[0] if self.client_address else "?"
        key = f"{ip}:{team_id or 'admin'}"
        now = time.time()
        with _auth_fails_lock:
            if ok:
                _auth_fails.pop(key, None)
                return
            rec = _auth_fails.get(key) or {"fails": 0, "lock_until": 0}
            rec["fails"] += 1
            if rec["fails"] >= _AUTH_FAIL_MAX:
                rec["lock_until"] = now + _AUTH_FAIL_LOCK
                rec["fails"] = 0
            _auth_fails[key] = rec

    def auth_unlock(self):
        try:
            d = self.read_json()
        except Exception as e:
            return self.send_json({"error": f"invalid JSON: {e}"}, 400)
        password = str(d.get("password", "") or "")
        team_id = str(d.get("teamId", "") or "").strip()
        if not password:
            return self.send_json({"error": "password required"}, 400)
        if len(password) > _PASSWORD_MAX:
            return self.send_json({"error": "password too long"}, 400)
        # 限速：连续失败达上限则短期锁定，防公网在线爆破
        allowed, retry_after = self._auth_rate_check(team_id)
        if not allowed:
            return self.send_json({"error": f"尝试次数过多，请约 {retry_after} 秒后再试", "retryAfter": retry_after}, 429)
        token = self.headers.get("X-Auth-Token", "") or _new_session_token()
        if team_id:
            # 解锁指定团队：比对 team_auth
            r = one("SELECT pwd_hash FROM team_auth WHERE team_id=?", (team_id,))
            if not r or not verify_password(password, r["pwd_hash"]):
                self._auth_rate_record(team_id, False)
                return self.send_json({"error": "密码错误", "wrongPassword": True, "requireUnlock": team_id}, 403)
            self._auth_rate_record(team_id, True)
            s = _session_put(token, team_id=team_id)
            return self.send_json(self._session_view(token, s))
        # teamId 空 → 超管解锁：比对 ADMIN_PASSWORD（恒定时间）
        admin_pw = os.environ.get("ADMIN_PASSWORD", "")
        if not admin_pw or not hmac.compare_digest(password, admin_pw):
            self._auth_rate_record(team_id, False)
            return self.send_json({"error": "密码错误", "wrongPassword": True, "requireAdmin": True}, 403)
        self._auth_rate_record(team_id, True)
        s = _session_put(token, is_admin=True)
        return self.send_json(self._session_view(token, s))

    def auth_session(self):
        s = self.current_session()
        if not s:
            return self.send_json({"error": "no session", "authenticated": False}, 401)
        token = self.headers.get("X-Auth-Token", "")
        return self.send_json(self._session_view(token, s, include_token=False))

    def auth_lock(self):
        # 客户端 POST /api/auth/lock 带 {} 体；返回前必须抽干，否则 keep-alive 下残留字节
        # 被当作同连接下一个请求的方法行，报 501 Unsupported method ('{}POST')。
        self._drain_request_body()
        token = self.headers.get("X-Auth-Token", "")
        with _sessions_lock:
            _sessions.pop(token, None)
        return self.send_json({"ok": True})

    def auth_set_team_password(self):
        if self.require_admin(drain=True):
            return
        try:
            d = self.read_json()
        except Exception as e:
            return self.send_json({"error": f"invalid JSON: {e}"}, 400)
        team_id = str(d.get("teamId", "") or "").strip()
        password = str(d.get("password", "") or "")
        terr = self._validate_team(team_id)
        if terr:
            return self.send_json({"error": terr}, 400)
        if not password:
            return self.send_json({"error": "password required"}, 400)
        if len(password) > _PASSWORD_MAX:
            return self.send_json({"error": "password too long"}, 400)
        with db() as conn:
            conn.execute(
                "INSERT INTO team_auth(team_id, pwd_hash, updated_at) VALUES (?,?,?) "
                "ON CONFLICT(team_id) DO UPDATE SET pwd_hash=excluded.pwd_hash, updated_at=excluded.updated_at",
                (team_id, hash_password(password), now())
            )
        return self.send_json({"ok": True})

    def auth_delete_team_password(self, parsed):
        if self.require_admin(drain=True):
            return
        q = parse_qs(parsed.query)
        team_id = (q.get("teamId", [""])[0] or "").strip()
        terr = self._validate_team(team_id)
        if terr:
            return self.send_json({"error": terr}, 400)
        with db() as conn:
            conn.execute("DELETE FROM team_auth WHERE team_id=?", (team_id,))
        return self.send_json({"ok": True})

    def do_POST(self):
        self._auth_blocked = False  # 每请求重置（keep-alive 复用 Handler 实例）
        parsed = urlparse(self.path)
        # auth 端点短路（在只读门之前）：解锁/设密不能被只读门挡住
        if parsed.path == "/api/auth/unlock":
            return self.auth_unlock()
        if parsed.path == "/api/auth/lock":
            return self.auth_lock()
        if parsed.path == "/api/auth/team-password":
            return self.auth_set_team_password()
        if self.reject_if_readonly():
            return
        if parsed.path == "/api/reset":
            if self.require_admin(drain=True):
                return
            init_db(reset=True, seed=False)
            return self.send_json({"ok": True})
        if parsed.path == "/api/import.csv":
            if self.require_admin(drain=True):
                return
            return self.import_csv()
        try:
            data = self.read_json()
        except Exception as e:
            return self.send_json({"error": f"invalid JSON: {e}"}, 400)
        try:
            if parsed.path == "/api/people": return self.create_person(data)
            if parsed.path == "/api/projects": return self.create_project(data)
            if parsed.path == "/api/teams": return self.create_team(data)
            if parsed.path == "/api/assignments": return self.create_assignment(data)
            if parsed.path == "/api/milestones": return self.create_milestone(data)
            if parsed.path == "/api/settings": return self.save_setting(data)
            self.send_json({"error":"not found"},404)
        except Exception as e:
            self.send_json({"error":str(e)},400)

    def do_PUT(self):
        self._auth_blocked = False
        if self.reject_if_readonly():
            return
        parsed = urlparse(self.path)
        try:
            data = self.read_json()
        except Exception as e:
            return self.send_json({"error": f"invalid JSON: {e}"}, 400)
        parts = parsed.path.strip('/').split('/')
        try:
            if len(parts)==2 and parts[0]=='api' and parts[1]=='sort':
                return self.bulk_sort(data)
            if len(parts)==3 and parts[0]=='api':
                table, rid = parts[1], parts[2]
                # teams 需显式路由（通用分支只处理 people/projects/assignments/milestones）
                if table == 'teams': return self.update_team(rid, data)
                if table == 'people': return self.update_person(rid, data)
                if table == 'projects': return self.update_project(rid, data)
                if table == 'assignments': return self.update_assignment(rid, data)
                if table == 'milestones': return self.update_milestone(rid, data)
            self.send_json({"error":"not found"},404)
        except Exception as e:
            self.send_json({"error":str(e)},400)

    def do_DELETE(self):
        self._auth_blocked = False
        parsed = urlparse(self.path)
        if parsed.path == "/api/auth/team-password":
            return self.auth_delete_team_password(parsed)
        if self.reject_if_readonly():
            return
        # 通用删除不读 body；客户端（代理/curl）若带 body，抽干防 keep-alive desync。
        # 置于 team-password 路由与只读门之后：二者已自行处理 body，此处为首读，无重复。
        self._drain_request_body()
        parts = parsed.path.strip('/').split('/')
        try:
            if len(parts)==3 and parts[0]=='api':
                table = parts[1]
                rid = parts[2]
                # teams 删除语义特殊（迁移归属而非级联清空），必须先于通用硬删除拦截。
                if table == 'teams':
                    if self.require_admin():
                        return
                    return self.delete_team(rid)
                ALLOWED_TABLES = frozenset(['people','projects','assignments','milestones'])
                if table not in ALLOWED_TABLES:
                    return self.send_json({"error":"not found"},404)
                # 隔离铁律：以被删记录当前所属团队鉴权（DELETE 无 body，require_team 不排空）。
                team_id = self._record_team(table, rid)
                if team_id is not None and self.require_team(team_id):
                    return
                with db() as conn:
                    if table == 'people':
                        # 删人时解绑负责人：同时清 owner_id（外键）与 legacy owner（姓名字符串）。
                        # 若只清 owner_id，前端 person(ownerId)?.name || owner 会 fallback 到残留姓名，
                        # 导致已删的人仍显示为项目/里程碑负责人（并出现在 CSV 导出与打印报表中）。
                        conn.execute("UPDATE projects SET owner = '', owner_id = '', updated_at = ? WHERE owner_id = ?", (now(), rid))
                        conn.execute("UPDATE milestones SET owner = '', owner_id = '', updated_at = ? WHERE owner_id = ?", (now(), rid))
                    cur = conn.execute(f"DELETE FROM {table} WHERE id=?", (rid,))
                    if cur.rowcount == 0:
                        return self.send_json({"error": "not found"}, 404)
                return self.send_json({"ok": True})
            self.send_json({"error":"not found"},404)
        except Exception as e:
            self.send_json({"error":str(e)},400)

    def save_setting(self, d):
        key = str(d.get('key', '')).strip()
        value = str(d.get('value', '')).strip()
        team_id = str(d.get('teamId', '')).strip()  # '' = 全局/默认档（「全部团队」视图）
        if not key:
            return self.send_json({"error": "key is required"}, 400)
        # 不豁免：settings 是 per-team，按团队锁；'' 全局档需超管（否则 A 可写 B 偏好 = A 改 B）。
        if team_id:
            if self.require_team(team_id):
                return
        else:
            if self.require_admin():
                return
        with db() as conn:
            conn.execute("INSERT INTO settings (team_id, key, value) VALUES (?, ?, ?) ON CONFLICT(team_id, key) DO UPDATE SET value = excluded.value", (team_id, key, value))
        return self.send_json({"ok": True})

    def _validate_team(self, team_id):
        """校验 team_id 非空且存在于 teams；返回错误消息或 None。归属强制性：每条数据必须有真实团队。"""
        if not team_id:
            return "teamId is required"
        if not one("SELECT id FROM teams WHERE id=?", (team_id,)):
            return "team not found: " + team_id
        return None

    def create_person(self, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        capacity = float(d['dailyCapacity']) if 'dailyCapacity' in d and d['dailyCapacity'] is not None and d['dailyCapacity'] != '' else 8.0
        if capacity <= 0:
            return self.send_json({"error": "dailyCapacity must be > 0"}, 400)
        home_team = str(d.get('homeTeamId', '')).strip()
        terr = self._validate_team(home_team)
        if terr:
            return self.send_json({"error": terr}, 400)
        if self.require_team(home_team):
            return
        rid = new_id('p'); t=now()
        color = d.get('color', '').strip() if d.get('color') else ''
        with db() as conn:
            conn.execute("INSERT INTO people(id,name,department,role,daily_capacity,created_at,updated_at,sort_order,archived,color,home_team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (rid, name, d.get('department',''), d.get('role',''), capacity, t, t, 0, 0, color, home_team))
        self.send_json({"id": rid})
    def update_person(self, rid, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        capacity = float(d['dailyCapacity']) if 'dailyCapacity' in d and d['dailyCapacity'] is not None and d['dailyCapacity'] != '' else 8.0
        if capacity <= 0:
            return self.send_json({"error": "dailyCapacity must be > 0"}, 400)
        # 隔离铁律：以库里当前归属团队鉴权；跨团队迁移需新旧两团队都解锁（实际超管）。
        existing = one("SELECT home_team_id FROM people WHERE id=?", (rid,))
        if not existing:
            return self.send_json({"error": "not found"}, 404)
        cur_team = existing['home_team_id']
        prov_team = str(d.get('homeTeamId', '')).strip() if 'homeTeamId' in d else cur_team
        if 'homeTeamId' in d and prov_team != cur_team:
            terr = self._validate_team(prov_team)
            if terr:
                return self.send_json({"error": terr}, 400)
        if prov_team != cur_team:
            if self.require_team(cur_team) or self.require_team(prov_team):
                return
        else:
            if self.require_team(cur_team):
                return
        sets = ["name=?", "department=?", "role=?", "daily_capacity=?", "updated_at=?"]
        params = [name, d.get('department', ''), d.get('role', ''), capacity, now()]
        if 'archived' in d:
            sets.append("archived=?"); params.append(int(d.get('archived', 0)))
        if d.get('color') is not None:
            sets.append("color=?"); params.append(d.get('color', '').strip())
        if 'homeTeamId' in d:
            home_team = str(d.get('homeTeamId', '')).strip()
            terr = self._validate_team(home_team)
            if terr:
                return self.send_json({"error": terr}, 400)
            sets.append("home_team_id=?"); params.append(home_team)
        params.append(rid)
        with db() as conn:
            cur = conn.execute(f"UPDATE people SET {','.join(sets)} WHERE id=?", params)
            if cur.rowcount == 0:
                return self.send_json({"error": "not found"}, 404)
        self.send_json({"ok": True})
    def create_project(self, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        team = str(d.get('teamId', '')).strip()
        terr = self._validate_team(team)
        if terr:
            return self.send_json({"error": terr}, 400)
        if self.require_team(team):
            return
        rid = new_id('pr'); t=now()
        owner_id = d.get('ownerId', '').strip()
        owner_name = ""
        if owner_id:
            p = one("SELECT name FROM people WHERE id=?", (owner_id,))
            if p:
                owner_name = p['name']
        else:
            owner_name = (d.get('owner') or d.get('负责人') or d.get('person') or '').strip()
        with db() as conn:
            conn.execute(
                "INSERT INTO projects(id,name,owner,owner_id,priority,color,created_at,updated_at,sort_order,start_date,end_date,archived,team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (rid, d.get('name', '').strip(), owner_name, owner_id, d.get('priority', '中'), d.get('color') or '#7db7ff', t, t, 0, d.get('startDate', ''), d.get('endDate', ''), 0, team)
            )
        self.send_json({"id": rid})
    def update_project(self, rid, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        owner_id = d.get('ownerId', '').strip()
        owner_name = ""
        if owner_id:
            p = one("SELECT name FROM people WHERE id=?", (owner_id,))
            if p:
                owner_name = p['name']
        else:
            owner_name = (d.get('owner') or d.get('负责人') or d.get('person') or '').strip()
        # 隔离铁律：以库里当前归属团队鉴权；跨团队迁移需新旧两团队都解锁。
        existing = one("SELECT team_id FROM projects WHERE id=?", (rid,))
        if not existing:
            return self.send_json({"error": "not found"}, 404)
        cur_team = existing['team_id']
        prov_team = str(d.get('teamId', '')).strip() if 'teamId' in d else cur_team
        if 'teamId' in d and prov_team != cur_team:
            terr = self._validate_team(prov_team)
            if terr:
                return self.send_json({"error": terr}, 400)
        if prov_team != cur_team:
            if self.require_team(cur_team) or self.require_team(prov_team):
                return
        else:
            if self.require_team(cur_team):
                return
        sets = ["name=?", "owner=?", "owner_id=?", "priority=?", "color=?", "start_date=?", "end_date=?", "updated_at=?"]
        params = [d.get('name', '').strip(), owner_name, owner_id, d.get('priority', '中'), d.get('color') or '#7db7ff', d.get('startDate', ''), d.get('endDate', ''), now()]
        if 'archived' in d:
            sets.append("archived=?"); params.append(int(d.get('archived', 0)))
        if 'teamId' in d:
            team = str(d.get('teamId', '')).strip()
            terr = self._validate_team(team)
            if terr:
                return self.send_json({"error": terr}, 400)
            sets.append("team_id=?"); params.append(team)
        params.append(rid)
        with db() as conn:
            cur = conn.execute(f"UPDATE projects SET {','.join(sets)} WHERE id=?", params)
            if cur.rowcount == 0:
                return self.send_json({"error": "not found"}, 404)
        self.send_json({"ok": True})

    def create_team(self, d):
        if self.require_admin():
            return
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        rid = new_id('tm'); t = now()
        color = (d.get('color') or '#7db7ff').strip() or '#7db7ff'
        description = d.get('description', '').strip()
        with db() as conn:
            mx = conn.execute("SELECT COALESCE(MAX(sort_order),0) AS m FROM teams").fetchone()["m"]
            conn.execute("INSERT INTO teams(id,name,color,description,sort_order,archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", (rid, name, color, description, int(mx) + 1, 0, t, t))
        self.send_json({"id": rid})

    def update_team(self, rid, d):
        if self.require_admin():
            return
        if not one("SELECT id FROM teams WHERE id=?", (rid,)):
            return self.send_json({"error": "not found"}, 404)
        sets = []; params = []
        if 'name' in d:
            name = d.get('name', '').strip()
            if not name:
                return self.send_json({"error": "name is required"}, 400)
            sets.append("name=?"); params.append(name)
        if d.get('color') is not None:
            sets.append("color=?"); params.append((d.get('color') or '#7db7ff').strip() or '#7db7ff')
        if 'description' in d:
            sets.append("description=?"); params.append(d.get('description', '').strip())
        if 'archived' in d:
            sets.append("archived=?"); params.append(int(d.get('archived', 0)))
        if not sets:
            return self.send_json({"ok": True})
        sets.append("updated_at=?"); params.append(now()); params.append(rid)
        with db() as conn:
            conn.execute(f"UPDATE teams SET {','.join(sets)} WHERE id=?", params)
        self.send_json({"ok": True})

    def delete_team(self, rid):
        # 默认团队不可删（保证系统始终有兜底归属）。
        if rid == 'tm_default':
            return self.send_json({"error": "默认团队不可删除"}, 400)
        if not one("SELECT id FROM teams WHERE id=?", (rid,)):
            return self.send_json({"error": "not found"}, 404)
        # 迁移归属到默认团队 + 清该 team_id 偏好/操作密码 + 删团队本身（不级联删人员/项目，它们只换归属）。
        with db() as conn:
            conn.execute("UPDATE people SET home_team_id='tm_default', updated_at=? WHERE home_team_id=?", (now(), rid))
            conn.execute("UPDATE projects SET team_id='tm_default', updated_at=? WHERE team_id=?", (now(), rid))
            conn.execute("DELETE FROM settings WHERE team_id=?", (rid,))
            conn.execute("DELETE FROM team_auth WHERE team_id=?", (rid,))
            conn.execute("DELETE FROM teams WHERE id=?", (rid,))
        self.send_json({"ok": True})

    def normalize_assignment_dates(self, d):
        start = resolve_date(d.get('startDate') or d.get('date'))
        end = resolve_date(d.get('endDate') or d.get('date') or start)
        if end < start:
            start, end = end, start
        return start, end

    def _validate_project_dates(self, project_id, start, end):
        proj = one("SELECT start_date,end_date FROM projects WHERE id=?", (project_id,))
        if proj:
            if proj['start_date'] and start < proj['start_date']:
                return "排期开始日期不能早于项目开始日期 " + proj['start_date']
            if proj['end_date'] and end > proj['end_date']:
                return "排期结束日期不能晚于项目结束日期 " + proj['end_date']
        return None

    def create_assignment(self, d):
        hours = float(d['hours']) if 'hours' in d and d['hours'] is not None and d['hours'] != '' else 8.0
        if hours <= 0:
            return self.send_json({"error": "hours must be > 0"}, 400)
        rid = new_id('a'); t=now()
        start, end = self.normalize_assignment_dates(d)
        err = self._validate_project_dates(d.get('projectId',''), start, end)
        if err:
            return self.send_json({"error": err}, 400)
        # 隔离铁律：目标团队 = 排期所属 project 的 team（body 的 projectId 指向）。
        if self.require_team(self._project_team_id(d.get('projectId', ''))):
            return
        with db() as conn:
            conn.execute("INSERT INTO assignments VALUES (?,?,?,?,?,?,?,?,?)", (rid, d['personId'], d['projectId'], start, end, hours, d.get('note',''), t, t))
        self.send_json({"id": rid})
    def update_assignment(self, rid, d):
        hours = float(d['hours']) if 'hours' in d and d['hours'] is not None and d['hours'] != '' else 8.0
        if hours <= 0:
            return self.send_json({"error": "hours must be > 0"}, 400)
        start, end = self.normalize_assignment_dates(d)
        err = self._validate_project_dates(d.get('projectId',''), start, end)
        if err:
            return self.send_json({"error": err}, 400)
        # 隔离铁律：以当前所属 project 的团队鉴权；改 projectId 跨团队需新旧 project 团队都解锁。
        existing = one("SELECT project_id FROM assignments WHERE id=?", (rid,))
        if not existing:
            return self.send_json({"error": "not found"}, 404)
        cur_proj = existing['project_id']
        prov_proj = str(d.get('projectId', '')).strip() if 'projectId' in d else cur_proj
        if prov_proj != cur_proj:
            if self.require_team(self._project_team_id(cur_proj)) or self.require_team(self._project_team_id(prov_proj)):
                return
        else:
            if self.require_team(self._project_team_id(cur_proj)):
                return
        with db() as conn:
            cur = conn.execute("UPDATE assignments SET person_id=?,project_id=?,work_date=?,end_date=?,hours=?,note=?,updated_at=? WHERE id=?", (d['personId'], d['projectId'], start, end, hours, d.get('note',''), now(), rid))
            if cur.rowcount == 0:
                return self.send_json({"error": "not found"}, 404)
        self.send_json({"ok": True})
    def create_milestone(self, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        rid = new_id('m'); t=now()
        owner_id = d.get('ownerId', '').strip()
        owner_name = ""
        if owner_id:
            p = one("SELECT name FROM people WHERE id=?", (owner_id,))
            if p:
                owner_name = p['name']
        else:
            owner_name = d.get('owner', '').strip()
        # 隔离铁律：目标团队 = 里程碑所属 project 的 team。
        if self.require_team(self._project_team_id(d.get('projectId', ''))):
            return
        with db() as conn:
            conn.execute(
                "INSERT INTO milestones(id,project_id,name,milestone_date,level,owner,owner_id,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (rid, d['projectId'], d.get('name','').strip(), d['date'], d.get('level','important'), owner_name, owner_id, d.get('description',''), t, t)
            )
        self.send_json({"id": rid})
    def update_milestone(self, rid, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        owner_id = d.get('ownerId', '').strip()
        owner_name = ""
        if owner_id:
            p = one("SELECT name FROM people WHERE id=?", (owner_id,))
            if p:
                owner_name = p['name']
        else:
            owner_name = d.get('owner', '').strip()
        # 隔离铁律：以当前所属 project 的团队鉴权；改 projectId 跨团队需新旧 project 团队都解锁。
        existing = one("SELECT project_id FROM milestones WHERE id=?", (rid,))
        if not existing:
            return self.send_json({"error": "not found"}, 404)
        cur_proj = existing['project_id']
        prov_proj = str(d.get('projectId', '')).strip() if 'projectId' in d else cur_proj
        if prov_proj != cur_proj:
            if self.require_team(self._project_team_id(cur_proj)) or self.require_team(self._project_team_id(prov_proj)):
                return
        else:
            if self.require_team(self._project_team_id(cur_proj)):
                return
        with db() as conn:
            cur = conn.execute(
                "UPDATE milestones SET project_id=?,name=?,milestone_date=?,level=?,owner=?,owner_id=?,description=?,updated_at=? WHERE id=?",
                (d['projectId'], d.get('name','').strip(), d['date'], d.get('level','important'), owner_name, owner_id, d.get('description',''), now(), rid)
            )
            if cur.rowcount == 0:
                return self.send_json({"error": "not found"}, 404)
        self.send_json({"ok": True})

    def bulk_sort(self, d):
        if self.require_admin():
            return
        table = d.get('table', '')
        ids = d.get('ids', [])
        if table not in ('people', 'projects', 'teams'):
            return self.send_json({"error": "table must be people, projects or teams"}, 400)
        if not isinstance(ids, list):
            return self.send_json({"error": "ids must be a list"}, 400)
        t = now()
        with db() as conn:
            for i, rid in enumerate(ids):
                conn.execute(f"UPDATE {table} SET sort_order=?, updated_at=? WHERE id=?", (i + 1, t, rid))
        self.send_json({"ok": True})

    def import_csv(self):
        import io
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        text = raw.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        if not reader.fieldnames:
            return self.send_json({"error": "CSV 缺少表头"}, 400)

        created_people = 0
        created_projects = 0
        created_assignments = 0
        created_milestones = 0
        merged_assignments = 0
        merged_milestones = 0
        skipped = 0
        unmatched_team = 0
        t = now()
        # 团队名称 → id 映射（导入起始一次性构建）；匹配不到归默认团队 tm_default。
        team_by_name = {r["name"]: r["id"] for r in rows("SELECT id, name FROM teams")}
        with db() as conn:
            for row in reader:
                project_name = (row.get("项目") or "").strip()
                record_type = (row.get("数据类型") or "").strip()
                milestone_name = (
                    row.get("里程碑")
                    or row.get("里程碑名称")
                    or row.get("节点名称")
                    or ""
                ).strip()
                date = (
                    row.get("日期")
                    or row.get("开始日期")
                    or row.get("里程碑日期")
                    or ""
                ).strip()
                is_milestone_row = record_type == "里程碑" or (
                    milestone_name and project_name and not (row.get("人员") or "").strip()
                )
                if not date or not project_name:
                    skipped += 1
                    continue
                try:
                    date = datetime.fromisoformat(date).date().isoformat()
                except ValueError:
                    skipped += 1
                    continue

                pr = conn.execute("SELECT id FROM projects WHERE name=?", (project_name,)).fetchone()
                if pr:
                    project_id = pr["id"]
                else:
                    project_id = new_id("pr")
                    project_team_name = (row.get("团队") or "").strip()
                    project_team = team_by_name.get(project_team_name) if project_team_name else None
                    if project_team_name and not project_team:
                        unmatched_team += 1
                    project_owner_name = (row.get("项目负责人") or "").strip()
                    conn.execute("INSERT INTO projects(id,name,owner,owner_id,priority,color,created_at,updated_at,sort_order,start_date,end_date,archived,team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                        project_id, project_name, project_owner_name, "",
                        "中", DEFAULT_COLORS[created_projects % len(DEFAULT_COLORS)], t, t, 0,
                        (row.get("项目开始日期") or "").strip(),
                        (row.get("项目结束日期") or "").strip(), 0,
                        project_team or "tm_default"
                    ))
                    created_projects += 1

                if is_milestone_row:
                    if not milestone_name:
                        skipped += 1
                        continue
                    level = (row.get("里程碑级别") or row.get("级别") or "important").strip() or "important"
                    owner = (row.get("里程碑负责人") or row.get("负责人") or "").strip()
                    description = (row.get("里程碑说明") or row.get("说明") or row.get("备注") or "").strip()
                    existing = conn.execute(
                        "SELECT id FROM milestones WHERE project_id=? AND name=? AND milestone_date=?",
                        (project_id, milestone_name, date)
                    ).fetchone()
                    if existing:
                        conn.execute(
                            "UPDATE milestones SET level=?, owner=?, owner_id=?, description=?, updated_at=? WHERE id=?",
                            (level, owner, "", description, t, existing["id"])
                        )
                        merged_milestones += 1
                    else:
                        conn.execute("INSERT INTO milestones(id,project_id,name,milestone_date,level,owner,owner_id,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", (
                            new_id("m"), project_id, milestone_name, date,
                            level, owner, "", description, t, t
                        ))
                        created_milestones += 1
                    continue

                person_name = (row.get("人员") or "").strip()
                if not person_name:
                    skipped += 1
                    continue
                end_date = (row.get("结束日期") or date).strip()
                try:
                    end_date = datetime.fromisoformat(end_date).date().isoformat()
                    if end_date < date:
                        date, end_date = end_date, date
                except ValueError:
                    skipped += 1
                    continue

                p = conn.execute("SELECT id FROM people WHERE name=?", (person_name,)).fetchone()
                if p:
                    person_id = p["id"]
                else:
                    person_id = new_id("p")
                    person_team_name = (row.get("人员所属团队") or "").strip()
                    person_team = team_by_name.get(person_team_name) if person_team_name else None
                    if person_team_name and not person_team:
                        unmatched_team += 1
                    conn.execute("INSERT INTO people(id,name,department,role,daily_capacity,created_at,updated_at,sort_order,archived,color,home_team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
                        person_id, person_name, (row.get("部门") or "").strip(),
                        (row.get("角色") or "").strip(), 8, t, t, 0, 0, '',
                        person_team or "tm_default"
                    ))
                    created_people += 1

                try:
                    hours = float((row.get("工时") or row.get("工时/天") or "8").replace("h", "").strip() or 8)
                except ValueError:
                    hours = 8
                note = (row.get("备注") or "").strip()
                existing = conn.execute(
                    "SELECT id FROM assignments WHERE person_id=? AND project_id=? AND work_date=? AND end_date=?",
                    (person_id, project_id, date, end_date)
                ).fetchone()
                if existing:
                    conn.execute(
                        "UPDATE assignments SET hours=?, note=?, updated_at=? WHERE id=?",
                        (hours, note, t, existing["id"])
                    )
                    merged_assignments += 1
                else:
                    conn.execute("INSERT INTO assignments VALUES (?,?,?,?,?,?,?,?,?)", (
                        new_id("a"), person_id, project_id, date, end_date, hours, note, t, t
                    ))
                    created_assignments += 1

            # 后置回填：在所有行导入完成后，将存量项目和里程碑负责人的人名映射为最新的 ID
            conn.execute("""
                UPDATE milestones
                SET owner_id = (SELECT p.id FROM people p WHERE p.name = milestones.owner AND p.name <> '')
                WHERE owner_id = '' AND owner <> ''
            """)
            conn.execute("""
                UPDATE projects
                SET owner_id = (SELECT p.id FROM people p WHERE p.name = projects.owner AND p.name <> '')
                WHERE owner_id = '' AND owner <> ''
            """)

        self.send_json({
            "ok": True,
            "createdPeople": created_people,
            "createdProjects": created_projects,
            "createdAssignments": created_assignments,
            "createdMilestones": created_milestones,
            "mergedAssignments": merged_assignments,
            "mergedMilestones": merged_milestones,
            "unmatchedTeam": unmatched_team,
            "skipped": skipped
        })

    def export_csv(self):
        import io
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow([
            "数据类型","日期","结束日期","人员","部门","角色","项目","项目负责人",
            "项目开始日期","项目结束日期","工时/天","占比","是否超载","备注",
            "里程碑","里程碑级别","里程碑负责人","里程碑说明","团队","人员所属团队"
        ])
        assignment_rows = rows("""
          SELECT a.work_date,a.end_date,p.name person,p.department,p.role,p.daily_capacity,
                 pr.name project, COALESCE(po.name, pr.owner) AS owner, pr.start_date AS proj_start, pr.end_date AS proj_end,
                 a.hours,a.note, pt.name AS proj_team, ht.name AS home_team
          FROM assignments a
          JOIN people p ON p.id=a.person_id
          JOIN projects pr ON pr.id=a.project_id
          LEFT JOIN people po ON po.id=pr.owner_id
          LEFT JOIN teams pt ON pt.id=pr.team_id
          LEFT JOIN teams ht ON ht.id=p.home_team_id
          ORDER BY a.work_date,p.name
        """)
        totals = {}
        for r in assignment_rows:
            start = datetime.fromisoformat(r['work_date']).date()
            end = datetime.fromisoformat(r['end_date'] or r['work_date']).date()
            days = (end - start).days + 1
            for i in range(days):
                day = (start + timedelta(days=i)).isoformat()
                key=(day,r['person'])
                totals[key]=totals.get(key,0)+r['hours']
        for r in assignment_rows:
            overloaded = '否'
            start = datetime.fromisoformat(r['work_date']).date()
            end = datetime.fromisoformat(r['end_date'] or r['work_date']).date()
            days = (end - start).days + 1
            for i in range(days):
                day = (start + timedelta(days=i)).isoformat()
                if totals[(day,r['person'])] > r['daily_capacity']:
                    overloaded = '是'
                    break
            ratio = f"{round(r['hours']/r['daily_capacity']*100)}%" if r['daily_capacity'] and r['daily_capacity'] > 0 else ''
            w.writerow([
                "排期", r['work_date'], r['end_date'] or r['work_date'], r['person'], r['department'],
                r['role'], r['project'], r['owner'], r['proj_start'] or '', r['proj_end'] or '',
                r['hours'], ratio, overloaded, r['note'], '', '', '', '',
                r['proj_team'] or '', r['home_team'] or ''
            ])
        milestone_rows = rows("""
          SELECT m.milestone_date,pr.name project, COALESCE(po.name, pr.owner) AS project_owner,
                 pr.start_date AS proj_start,pr.end_date AS proj_end,
                 m.name AS milestone_name,m.level AS milestone_level,
                 COALESCE(mo.name, m.owner) AS milestone_owner, m.description AS milestone_description,
                 pt.name AS proj_team
          FROM milestones m JOIN projects pr ON pr.id=m.project_id
          LEFT JOIN people po ON po.id=pr.owner_id
          LEFT JOIN people mo ON mo.id=m.owner_id
          LEFT JOIN teams pt ON pt.id=pr.team_id
          ORDER BY m.milestone_date,pr.name,m.name
        """)
        for r in milestone_rows:
            w.writerow([
                "里程碑", r['milestone_date'], '', '', '', '', r['project'], r['project_owner'],
                r['proj_start'] or '', r['proj_end'] or '', '', '', '',
                '', r['milestone_name'], r['milestone_level'], r['milestone_owner'], r['milestone_description'],
                r['proj_team'] or '', ''
            ])
        body = out.getvalue().encode('utf-8-sig')
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", "attachment; filename=resource-scheduler-export.csv")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def holidays_json(self, parsed):
        # 节假日接口：本地数据优先（联网缓存 / 随包静态资源），后台联网刷新保持最新；只读，可在只读端口访问。
        query = parse_qs(parsed.query)
        year = (query.get("year", [""])[0] or "").strip()
        if not (year.isdigit() and len(year) == 4):
            year = str(datetime.now().year)
        force = query.get("refresh", [""])[0] in ("1", "true", "yes")
        payload = _holiday_local_payload(year)
        if payload is None or force:
            # 本地完全没有（如跨年到尚未内置的新年份）或强制刷新：同步拉一次，保证首屏有数据
            fresh = _fetch_holidays_online(year)
            if fresh:
                _write_holiday_cache(year, fresh)
                payload = fresh
        else:
            # 本地已有数据：后台异步刷新，下次加载即生效
            try:
                _trigger_holiday_refresh(year)
            except Exception:
                pass
        self.send_json(payload if payload is not None else {"year": int(year), "days": []})


if __name__ == "__main__":
    init_db()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8787"))
    display_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    mode = "read-only" if is_readonly_server() else "editable"
    print(f"Resource Scheduler 0.1.0 running ({mode}): http://{display_host}:{port}")
    share_port = readonly_share_port()
    if share_port:
        print(f"Read-only share URL: http://{local_share_host()}:{share_port}/")
    SchedulerHTTPServer((host, port), Handler, read_only=is_readonly_server()).serve_forever()

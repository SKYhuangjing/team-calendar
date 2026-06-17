#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Resource Scheduler 0.0.1
纯 Python 标准库 + SQLite，可直接运行：python3 server.py
"""
import csv
import ipaddress
import json
import os
import sqlite3
import socket
import threading
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
                                         headers={"User-Agent": "resource-scheduler/0.0.3"})
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

    def __init__(self, server_address, request_handler_class, read_only=False):
        self.read_only = read_only
        super().__init__(server_address, request_handler_class)


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
        return {"people": [], "projects": [], "milestones": [], "assignments": []}
    with open(INITIAL_DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    for key in ("people", "projects", "milestones", "assignments"):
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

    for idx, item in enumerate(data.get("people", [])):
        rid = item.get("id")
        name = str(item.get("name", "")).strip()
        if not rid or not name:
            continue
        cur.execute("INSERT OR IGNORE INTO people VALUES (?,?,?,?,?,?,?,?,?,?)", (
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
        ))

    for idx, item in enumerate(data.get("projects", [])):
        rid = item.get("id")
        name = str(item.get("name", "")).strip()
        if not rid or not name:
            continue
        cur.execute("INSERT OR IGNORE INTO projects VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
            rid,
            name,
            str(item.get("owner", "")).strip(),
            str(item.get("priority", "中")).strip() or "中",
            item.get("color") or "#7db7ff",
            t,
            t,
            item.get("sortOrder", idx + 1),
            str(item.get("startDate", "")).strip(),
            str(item.get("endDate", "")).strip(),
            0,
        ))

    for item in data.get("milestones", []):
        rid = item.get("id")
        project_id = item.get("projectId")
        name = str(item.get("name", "")).strip()
        if not rid or not project_id or not name:
            continue
        cur.execute("INSERT OR IGNORE INTO milestones VALUES (?,?,?,?,?,?,?,?,?)", (
            rid,
            project_id,
            name,
            resolve_date(item.get("date") or item.get("milestoneDate")),
            str(item.get("level", "important")).strip() or "important",
            str(item.get("owner", "")).strip(),
            str(item.get("description", "")).strip(),
            t,
            t,
        ))

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
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return super().do_GET()
        try:
            if parsed.path == "/api/share":
                try:
                    share_port = ensure_readonly_share_server(type(self)) or int(os.environ.get("PORT", "8787"))
                except OSError as e:
                    return self.send_json({"error": f"只读分享端口启动失败：{e}"}, 500)
                self.send_json({"url": f"http://{local_share_host()}:{share_port}/", "readOnly": True})
            elif parsed.path == "/api/bootstrap":
                settings_dict = {}
                try:
                    for r in rows("SELECT key, value FROM settings"):
                        settings_dict[r["key"]] = r["value"]
                except sqlite3.OperationalError:
                    pass
                self.send_json({
                    "people": rows("SELECT id,name,department,role,daily_capacity AS dailyCapacity,archived,color FROM people ORDER BY sort_order, created_at"),
                    "projects": rows("SELECT id,name,owner,priority,color,start_date AS startDate,end_date AS endDate,archived FROM projects ORDER BY sort_order, created_at"),
                    "assignments": rows("SELECT id,person_id AS personId,project_id AS projectId,work_date AS date,end_date AS endDate,hours,note FROM assignments ORDER BY work_date"),
                    "milestones": rows("SELECT id,project_id AS projectId,name,milestone_date AS date,level,owner,description FROM milestones ORDER BY milestone_date"),
                    "readOnly": self.is_readonly_view(parsed),
                    "settings": settings_dict,
                })
            elif parsed.path == "/api/export.csv":
                self.export_csv()
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
        return (
            self.is_readonly_server_context()
            or self.has_readonly_marker(parsed)
            or (not self.is_local_client() and not truthy_env("ALLOW_REMOTE_WRITE"))
        )

    def reject_if_readonly(self):
        if self.is_readonly_server_context() or self.has_readonly_marker() or (not self.is_local_client() and not truthy_env("ALLOW_REMOTE_WRITE")):
            self.send_json({"error": "当前端口为只读访问，不能修改排期数据"}, 403)
            return True
        return False

    def do_POST(self):
        parsed = urlparse(self.path)
        if self.reject_if_readonly():
            return
        if parsed.path == "/api/reset":
            init_db(reset=True, seed=False)
            return self.send_json({"ok": True})
        if parsed.path == "/api/import.csv":
            return self.import_csv()
        try:
            data = self.read_json()
        except Exception as e:
            return self.send_json({"error": f"invalid JSON: {e}"}, 400)
        try:
            if parsed.path == "/api/people": return self.create_person(data)
            if parsed.path == "/api/projects": return self.create_project(data)
            if parsed.path == "/api/assignments": return self.create_assignment(data)
            if parsed.path == "/api/milestones": return self.create_milestone(data)
            if parsed.path == "/api/settings": return self.save_setting(data)
            self.send_json({"error":"not found"},404)
        except Exception as e:
            self.send_json({"error":str(e)},400)

    def do_PUT(self):
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
                if table == 'people': return self.update_person(rid, data)
                if table == 'projects': return self.update_project(rid, data)
                if table == 'assignments': return self.update_assignment(rid, data)
                if table == 'milestones': return self.update_milestone(rid, data)
            self.send_json({"error":"not found"},404)
        except Exception as e:
            self.send_json({"error":str(e)},400)

    def do_DELETE(self):
        if self.reject_if_readonly():
            return
        parts = urlparse(self.path).path.strip('/').split('/')
        try:
            if len(parts)==3 and parts[0]=='api':
                ALLOWED_TABLES = frozenset(['people','projects','assignments','milestones'])
                table = parts[1]
                if table not in ALLOWED_TABLES:
                    return self.send_json({"error":"not found"},404)
                rid = parts[2]
                with db() as conn:
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
        if not key:
            return self.send_json({"error": "key is required"}, 400)
        with db() as conn:
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))
        return self.send_json({"ok": True})

    def create_person(self, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        capacity = float(d['dailyCapacity']) if 'dailyCapacity' in d and d['dailyCapacity'] is not None and d['dailyCapacity'] != '' else 8.0
        if capacity <= 0:
            return self.send_json({"error": "dailyCapacity must be > 0"}, 400)
        rid = new_id('p'); t=now()
        color = d.get('color', '').strip() if d.get('color') else ''
        with db() as conn:
            conn.execute("INSERT INTO people VALUES (?,?,?,?,?,?,?,?,?,?)", (rid, name, d.get('department',''), d.get('role',''), capacity, t, t, 0, 0, color))
        self.send_json({"id": rid})
    def update_person(self, rid, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        capacity = float(d['dailyCapacity']) if 'dailyCapacity' in d and d['dailyCapacity'] is not None and d['dailyCapacity'] != '' else 8.0
        if capacity <= 0:
            return self.send_json({"error": "dailyCapacity must be > 0"}, 400)
        archived = int(d.get('archived', 0)) if 'archived' in d else None
        color = d.get('color', '').strip() if d.get('color') is not None else None
        with db() as conn:
            if archived is not None:
                if color is not None:
                    cur = conn.execute("UPDATE people SET name=?,department=?,role=?,daily_capacity=?,archived=?,color=?,updated_at=? WHERE id=?", (name, d.get('department',''), d.get('role',''), capacity, archived, color, now(), rid))
                else:
                    cur = conn.execute("UPDATE people SET name=?,department=?,role=?,daily_capacity=?,archived=?,updated_at=? WHERE id=?", (name, d.get('department',''), d.get('role',''), capacity, archived, now(), rid))
            else:
                if color is not None:
                    cur = conn.execute("UPDATE people SET name=?,department=?,role=?,daily_capacity=?,color=?,updated_at=? WHERE id=?", (name, d.get('department',''), d.get('role',''), capacity, color, now(), rid))
                else:
                    cur = conn.execute("UPDATE people SET name=?,department=?,role=?,daily_capacity=?,updated_at=? WHERE id=?", (name, d.get('department',''), d.get('role',''), capacity, now(), rid))
            if cur.rowcount == 0:
                return self.send_json({"error": "not found"}, 404)
        self.send_json({"ok": True})
    def create_project(self, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        rid = new_id('pr'); t=now()
        with db() as conn:
            conn.execute("INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?,?)", (rid, d.get('name','').strip(), (d.get('owner') or d.get('负责人') or d.get('person') or '').strip(), d.get('priority','中'), d.get('color') or '#7db7ff', t, t, 0, d.get('startDate',''), d.get('endDate',''), 0))
        self.send_json({"id": rid})
    def update_project(self, rid, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        archived = int(d.get('archived', 0)) if 'archived' in d else None
        with db() as conn:
            if archived is not None:
                cur = conn.execute("UPDATE projects SET name=?,owner=?,priority=?,color=?,start_date=?,end_date=?,archived=?,updated_at=? WHERE id=?", (d.get('name','').strip(), (d.get('owner') or d.get('负责人') or d.get('person') or '').strip(), d.get('priority','中'), d.get('color') or '#7db7ff', d.get('startDate',''), d.get('endDate',''), archived, now(), rid))
            else:
                cur = conn.execute("UPDATE projects SET name=?,owner=?,priority=?,color=?,start_date=?,end_date=?,updated_at=? WHERE id=?", (d.get('name','').strip(), (d.get('owner') or d.get('负责人') or d.get('person') or '').strip(), d.get('priority','中'), d.get('color') or '#7db7ff', d.get('startDate',''), d.get('endDate',''), now(), rid))
            if cur.rowcount == 0:
                return self.send_json({"error": "not found"}, 404)
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
        with db() as conn:
            conn.execute("INSERT INTO milestones VALUES (?,?,?,?,?,?,?,?,?)", (rid, d['projectId'], d.get('name','').strip(), d['date'], d.get('level','important'), d.get('owner',''), d.get('description',''), t, t))
        self.send_json({"id": rid})
    def update_milestone(self, rid, d):
        name = d.get('name', '').strip()
        if not name:
            return self.send_json({"error": "name is required"}, 400)
        with db() as conn:
            cur = conn.execute("UPDATE milestones SET project_id=?,name=?,milestone_date=?,level=?,owner=?,description=?,updated_at=? WHERE id=?", (d['projectId'], d.get('name','').strip(), d['date'], d.get('level','important'), d.get('owner',''), d.get('description',''), now(), rid))
            if cur.rowcount == 0:
                return self.send_json({"error": "not found"}, 404)
        self.send_json({"ok": True})

    def bulk_sort(self, d):
        table = d.get('table', '')
        ids = d.get('ids', [])
        if table not in ('people', 'projects'):
            return self.send_json({"error": "table must be people or projects"}, 400)
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
        t = now()
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
                    conn.execute("INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
                        project_id, project_name, (row.get("项目负责人") or "").strip(),
                        "中", DEFAULT_COLORS[created_projects % len(DEFAULT_COLORS)], t, t, 0,
                        (row.get("项目开始日期") or "").strip(),
                        (row.get("项目结束日期") or "").strip(), 0
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
                            "UPDATE milestones SET level=?, owner=?, description=?, updated_at=? WHERE id=?",
                            (level, owner, description, t, existing["id"])
                        )
                        merged_milestones += 1
                    else:
                        conn.execute("INSERT INTO milestones VALUES (?,?,?,?,?,?,?,?,?)", (
                            new_id("m"), project_id, milestone_name, date,
                            level, owner, description, t, t
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
                    conn.execute("INSERT INTO people VALUES (?,?,?,?,?,?,?,?,?,?)", (
                        person_id, person_name, (row.get("部门") or "").strip(),
                        (row.get("角色") or "").strip(), 8, t, t, 0, 0, ''
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

        self.send_json({
            "ok": True,
            "createdPeople": created_people,
            "createdProjects": created_projects,
            "createdAssignments": created_assignments,
            "createdMilestones": created_milestones,
            "mergedAssignments": merged_assignments,
            "mergedMilestones": merged_milestones,
            "skipped": skipped
        })

    def export_csv(self):
        import io
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow([
            "数据类型","日期","结束日期","人员","部门","角色","项目","项目负责人",
            "项目开始日期","项目结束日期","工时/天","占比","是否超载","备注",
            "里程碑","里程碑级别","里程碑负责人","里程碑说明"
        ])
        assignment_rows = rows("""
          SELECT a.work_date,a.end_date,p.name person,p.department,p.role,p.daily_capacity,pr.name project,pr.owner,pr.start_date AS proj_start,pr.end_date AS proj_end,a.hours,a.note
          FROM assignments a JOIN people p ON p.id=a.person_id JOIN projects pr ON pr.id=a.project_id
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
                r['hours'], ratio, overloaded, r['note'], '', '', '', ''
            ])
        milestone_rows = rows("""
          SELECT m.milestone_date,pr.name project,pr.owner AS project_owner,
                 pr.start_date AS proj_start,pr.end_date AS proj_end,
                 m.name AS milestone_name,m.level AS milestone_level,
                 m.owner AS milestone_owner,m.description AS milestone_description
          FROM milestones m JOIN projects pr ON pr.id=m.project_id
          ORDER BY m.milestone_date,pr.name,m.name
        """)
        for r in milestone_rows:
            w.writerow([
                "里程碑", r['milestone_date'], '', '', '', '', r['project'], r['project_owner'],
                r['proj_start'] or '', r['proj_end'] or '', '', '', '',
                '', r['milestone_name'], r['milestone_level'], r['milestone_owner'], r['milestone_description']
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
    print(f"Resource Scheduler 0.0.1 running ({mode}): http://{display_host}:{port}")
    share_port = readonly_share_port()
    if share_port:
        print(f"Read-only share URL: http://{local_share_host()}:{share_port}/")
    SchedulerHTTPServer((host, port), Handler, read_only=is_readonly_server()).serve_forever()

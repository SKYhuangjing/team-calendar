// api.js — fetch 封装、数据加载、删除操作

import { state, setState, setHolidayMap, buildDates, isReadOnlyMode, setReadOnlyMode, pushUndo, setViewMode, setCustomDays, setPrintOptions, viewMode, customDays, dates, getActiveTeam, authToken, setAuthToken, setAuthEnabled, setTeamAuth, setSession } from './state.js';
import { toast, undoToast } from './panels.js';
import { t } from './i18n.js';

// ── 403 鉴权处理：写操作被编辑锁拦截时，按 requireAdmin/requireUnlock 分流弹解锁框；成功后自动重放 ──
// 由 app.js 在启动时注册（panels.openUnlock）。返回 true=已解锁请重放，false=用户取消。
let _authHandler = null; // (info) => Promise<boolean>
export function setAuthHandler(fn) { _authHandler = fn; }

// ── fetch 封装 ──
export async function api(url, opt = {}) {
  const method = String(opt.method || 'GET').toUpperCase();
  // 鉴权端点豁免只读门：解锁是编辑的前提，绝不能被只读门挡死（安全网；正常 auth 开时已非只读）
  if (isReadOnlyMode() && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !url.startsWith('/api/auth/')) {
    throw new Error(t('toast.readonlyWrite'));
  }
  // 统一注入 X-Auth-Token（读请求带上也无害）；读时附带只读标记
  const buildHeaders = () => {
    const h = { ...(opt.headers || {}) };
    if (isReadOnlyMode()) h['X-Read-Only'] = 'true';
    if (authToken) h['X-Auth-Token'] = authToken;
    return h;
  };
  let r = await fetch(url, { ...opt, headers: buildHeaders() });
  // 写操作 403：解析后端编辑锁响应，分流解锁并重放一次
  // 鉴权端点自身的 403（密码错/限速）不重放，避免在解锁框之上再叠解锁框；直接抛出由调用方处理
  if (r.status === 403 && method !== 'GET' && method !== 'HEAD' && !url.startsWith('/api/auth/') && !url.startsWith('/api/settings')) {
    let info = {};
    try { info = await r.json(); } catch (_) { info = {}; }
    if ((info.requireAdmin || info.requireUnlock) && _authHandler) {
      const retry = await _authHandler(info);
      if (retry) {
        r = await fetch(url, { ...opt, headers: buildHeaders() }); // token 可能已更新
      } else {
        throw new Error(info.error || r.statusText);
      }
    } else {
      throw new Error(info.error || r.statusText);
    }
  }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || r.statusText; } catch (_) { /* 用 statusText */ }
    throw new Error(msg);
  }
  return r.json();
}

export const post = (u, d) => api(u, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(d)
});

export const put = (u, d) => api(u, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(d)
});

export const del = u => api(u, { method: 'DELETE' });

// 保存 per-team 视图偏好（带当前 activeTeam 作为 teamId；'' = 全局档）
export function saveTeamSetting(key, value) {
  return post('/api/settings', { key, value, teamId: getActiveTeam() || '' });
}

// 读取某团队合并后的设置（团队档覆盖全局档）；供切换团队时即时回填
export async function fetchTeamSettings(teamId) {
  const qs = teamId ? '?team=' + encodeURIComponent(teamId) : '';
  const data = await api('/api/settings' + qs);
  return (data && data.settings) || {};
}

// ── 节假日加载（F1.3 离线兜底 + F1.3+ 服务端自刷新）──
// 顺序：内存缓存 → /api/holidays（服务端多镜像代理+本地缓存，国内可达）→ 公网 CDN（末位兜底）
const HOLIDAY_CACHE = {};
function toMap(days) {
  const map = {};
  (days || []).forEach(x => { map[x.date] = x; });
  return map;
}
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}
// 拉取并应用某一年的节假日；force=true 时绕过内存缓存重拉。
// 返回成功与否（拿到非空 days）。
async function applyHolidays(y, force) {
  if (!force && HOLIDAY_CACHE[y]) { setHolidayMap(HOLIDAY_CACHE[y]); return true; }
  // 1) 服务端接口（自带多镜像兜底 + 本地缓存/随包数据）
  try {
    const d = await fetchJson(`/api/holidays?year=${y}`);
    if (d && Array.isArray(d.days) && d.days.length) {
      const map = toMap(d.days);
      HOLIDAY_CACHE[y] = map; setHolidayMap(map); return true;
    }
  } catch (_) { /* 继续兜底 */ }
  // 2) 公网 CDN（末位兜底：服务端不可用时浏览器直连，国内可能被墙）
  try {
    const d = await fetchJson(`https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`);
    if (d && Array.isArray(d.days) && d.days.length) {
      const map = toMap(d.days);
      HOLIDAY_CACHE[y] = map; setHolidayMap(map); return true;
    }
  } catch (_) { /* 静默 */ }
  setHolidayMap(HOLIDAY_CACHE[y] || {});
  return !!HOLIDAY_CACHE[y];
}
export async function loadHolidays() {
  await applyHolidays(new Date().getFullYear(), false);
}
// 后台自刷新：服务端可能在本次请求后才把最新节假日落盘，稍后重拉一次，数据变化则重渲染。
export function scheduleHolidayRefresh(renderAll) {
  setTimeout(async () => {
    const y = new Date().getFullYear();
    const before = JSON.stringify(HOLIDAY_CACHE[y]);
    const ok = await applyHolidays(y, true);
    if (ok && renderAll && JSON.stringify(HOLIDAY_CACHE[y]) !== before) {
      renderAll();
    }
  }, 3000);
}

// ── 主加载流程 ──
export async function load(renderAll) {
  if (!dates || !dates.length) {
    buildDates();
  }
  await loadHolidays();
  // 按当前 activeTeam 取 per-team 合并设置（团队档覆盖全局档）
  const teamQs = getActiveTeam() ? '?team=' + encodeURIComponent(getActiveTeam()) : '';
  const data = await api('/api/bootstrap' + teamQs);
  // 服务端是只读状态的事实来源。必须双向同步，避免服务端从远程只读切换到
  // 密码鉴权后，前端仍永久滞留在 readonly-mode，导致设置入口继续被隐藏。
  setReadOnlyMode(!!data.readOnly);
  if (typeof data.authEnabled === 'boolean') setAuthEnabled(data.authEnabled);
  if (data.teamAuth) setTeamAuth(data.teamAuth);
  setState(data);
  // 回填解锁态：有 token 则校验 /api/auth/session；失效/无 token 则清空
  if (authToken) {
    try {
      const s = await api('/api/auth/session');
      setSession(s.isAdmin, s.teamIds);
    } catch (_) {
      setAuthToken(''); setSession(false, []);
    }
  } else {
    setSession(false, []);
  }
  if (data.settings) {
    let settingsChanged = false;
    if (data.settings.viewMode && data.settings.viewMode !== viewMode) {
      setViewMode(data.settings.viewMode);
      settingsChanged = true;
    }
    if (data.settings.customDays && parseInt(data.settings.customDays, 10) !== customDays) {
      setCustomDays(parseInt(data.settings.customDays, 10));
      settingsChanged = true;
    }
    if (data.settings.printOptions) {
      try { setPrintOptions(JSON.parse(data.settings.printOptions)); } catch (_) { /* 忽略脏数据 */ }
    }
    if (settingsChanged || !dates || !dates.length) {
      buildDates();
    }
  }
  renderAll();
  scheduleHolidayRefresh(renderAll); // 稍后重拉一次节假日，服务端后台刷新出的最新数据变化则重渲染
}

// ── 删除操作 ──
// F1.4：人员/项目删除为级联删除（数据库 ON DELETE CASCADE 一并清除其排期/里程碑），
// 故撤销需先重建人员/项目（拿到新 id）再以其新 id 重建级联子记录；逐条 try/catch 隔离。
// 排序保留：删除前快照完整顺序，撤销时用新 id 替换旧 id 调 /api/sort 还原原位（避免追加到末尾）。
export async function deletePerson(id, skip, renderAll) {
  if (skip || confirm(t('confirm.deletePerson'))) {
    const p = state.people.find(x => x.id === id);
    const assigns = state.assignments.filter(a => a.personId === id).map(a => ({ ...a }));
    const order = state.people.map(x => x.id); // 删除前完整顺序
    await del('/api/people/' + id);
    if (p) pushUndo({
      label: t('undo.deletedPerson'),
      run: async () => {
        const r = await post('/api/people', { name: p.name, department: p.department, role: p.role, dailyCapacity: p.dailyCapacity, color: p.color, homeTeamId: p.homeTeamId });
        const newPid = (r && r.id) || null;
        if (newPid) {
          for (const a of assigns) {
            try { await post('/api/assignments', { personId: newPid, projectId: a.projectId, date: a.date, endDate: a.endDate, hours: a.hours, note: a.note }); } catch (_) { /* 尽量恢复 */ }
          }
          try { await put('/api/sort', { table: 'people', ids: order.map(x => x === id ? newPid : x) }); } catch (_) { /* 排序还原失败不阻断 */ }
        }
        await load(renderAll);
      }
    });
    await load(renderAll);
    p ? undoToast(t('undo.deletedPerson')) : toast(t('toast.deletedPerson'));
  }
}

export async function deleteProject(id, skip, renderAll) {
  if (skip || confirm(t('confirm.deleteProject'))) {
    const pr = state.projects.find(x => x.id === id);
    const assigns = state.assignments.filter(a => a.projectId === id).map(a => ({ ...a }));
    const mss = state.milestones.filter(m => m.projectId === id).map(m => ({ ...m }));
    const order = state.projects.map(x => x.id); // 删除前完整顺序
    await del('/api/projects/' + id);
    if (pr) pushUndo({
      label: t('undo.deletedProject'),
      run: async () => {
        const r = await post('/api/projects', { name: pr.name, ownerId: pr.ownerId, owner: pr.owner, priority: pr.priority, color: pr.color, startDate: pr.startDate, endDate: pr.endDate, teamId: pr.teamId });
        const newPid = (r && r.id) || null;
        if (newPid) {
          for (const a of assigns) { try { await post('/api/assignments', { personId: a.personId, projectId: newPid, date: a.date, endDate: a.endDate, hours: a.hours, note: a.note }); } catch (_) { /* 尽量恢复 */ } }
          for (const m of mss) { try { await post('/api/milestones', { name: m.name, date: m.date, projectId: newPid, level: m.level, ownerId: m.ownerId, owner: m.owner, description: m.description }); } catch (_) { /* 尽量恢复 */ } }
          try { await put('/api/sort', { table: 'projects', ids: order.map(x => x === id ? newPid : x) }); } catch (_) { /* 排序还原失败不阻断 */ }
        }
        await load(renderAll);
      }
    });
    await load(renderAll);
    pr ? undoToast(t('undo.deletedProject')) : toast(t('toast.deletedProject'));
  }
}

export async function deleteAssignment(id, skip, renderAll) {
  if (skip || confirm(t('confirm.deleteAssign'))) {
    const before = state.assignments.find(a => a.id === id);
    await del('/api/assignments/' + id);
    if (before) pushUndo({ label: t('undo.deletedAssign'), run: async () => { try { await post('/api/assignments', { personId: before.personId, projectId: before.projectId, date: before.date, endDate: before.endDate, hours: before.hours, note: before.note }); } catch (_) { /* 尽量恢复 */ } await load(renderAll); } });
    await load(renderAll);
    undoToast(t('undo.deletedAssign'));
  }
}

export async function deleteMilestone(id, skip, renderAll) {
  if (skip || confirm(t('confirm.deleteMilestone'))) {
    const before = state.milestones.find(m => m.id === id);
    await del('/api/milestones/' + id);
    if (before) pushUndo({ label: t('undo.deletedMilestone'), run: async () => { try { await post('/api/milestones', { name: before.name, date: before.date, projectId: before.projectId, level: before.level, ownerId: before.ownerId, owner: before.owner, description: before.description }); } catch (_) { /* 尽量恢复 */ } await load(renderAll); } });
    await load(renderAll);
    undoToast(t('undo.deletedMilestone'));
  }
}

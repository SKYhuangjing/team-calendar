// api.js — fetch 封装、数据加载、删除操作

import { state, setState, setHolidayMap, buildDates, isReadOnlyMode, setReadOnlyMode, pushUndo, setViewMode, setCustomDays, setPrintOptions } from './state.js';
import { toast, undoToast } from './panels.js';
import { t } from './i18n.js';

// ── fetch 封装 ──
export async function api(url, opt = {}) {
  const method = String(opt.method || 'GET').toUpperCase();
  if (isReadOnlyMode() && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    throw new Error(t('toast.readonlyWrite'));
  }
  const headers = { ...(opt.headers || {}) };
  if (isReadOnlyMode()) headers['X-Read-Only'] = 'true';
  let r = await fetch(url, { ...opt, headers });
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
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
  buildDates();
  await loadHolidays();
  const data = await api('/api/bootstrap');
  if (data.readOnly) setReadOnlyMode(true);
  setState(data);
  if (data.settings) {
    if (data.settings.viewMode) {
      setViewMode(data.settings.viewMode);
    }
    if (data.settings.customDays) {
      setCustomDays(parseInt(data.settings.customDays, 10));
    }
    if (data.settings.printOptions) {
      try { setPrintOptions(JSON.parse(data.settings.printOptions)); } catch (_) { /* 忽略脏数据 */ }
    }
    buildDates();
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
        const r = await post('/api/people', { name: p.name, department: p.department, role: p.role, dailyCapacity: p.dailyCapacity, color: p.color });
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
        const r = await post('/api/projects', { name: pr.name, owner: pr.owner, priority: pr.priority, color: pr.color, startDate: pr.startDate, endDate: pr.endDate });
        const newPid = (r && r.id) || null;
        if (newPid) {
          for (const a of assigns) { try { await post('/api/assignments', { personId: a.personId, projectId: newPid, date: a.date, endDate: a.endDate, hours: a.hours, note: a.note }); } catch (_) { /* 尽量恢复 */ } }
          for (const m of mss) { try { await post('/api/milestones', { name: m.name, date: m.date, projectId: newPid, level: m.level, owner: m.owner, description: m.description }); } catch (_) { /* 尽量恢复 */ } }
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
    if (before) pushUndo({ label: t('undo.deletedMilestone'), run: async () => { try { await post('/api/milestones', { name: before.name, date: before.date, projectId: before.projectId, level: before.level, owner: before.owner, description: before.description }); } catch (_) { /* 尽量恢复 */ } await load(renderAll); } });
    await load(renderAll);
    undoToast(t('undo.deletedMilestone'));
  }
}

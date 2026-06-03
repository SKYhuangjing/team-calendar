// api.js — fetch 封装、数据加载、删除操作

import { state, setState, setHolidayMap, buildDates, isReadOnlyMode, setReadOnlyMode } from './state.js';
import { toast } from './panels.js';

// ── fetch 封装 ──
export async function api(url, opt = {}) {
  const method = String(opt.method || 'GET').toUpperCase();
  if (isReadOnlyMode() && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    throw new Error('只读访问不能修改排期数据');
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

// ── 节假日加载 ──
export async function loadHolidays() {
  const y = new Date().getFullYear();
  try {
    const r = await fetch(`https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${y}.json`);
    const d = await r.json();
    const map = {};
    (d.days || []).forEach(x => { map[x.date] = x; });
    setHolidayMap(map);
  } catch (_) {
    setHolidayMap({});
  }
}

// ── 主加载流程 ──
export async function load(renderAll) {
  buildDates();
  await loadHolidays();
  const data = await api('/api/bootstrap');
  if (data.readOnly) setReadOnlyMode(true);
  setState(data);
  renderAll();
}

// ── 删除操作 ──
export async function deletePerson(id, skip, renderAll) {
  if (skip || confirm('删除人员会同步删除该人员排期，确认？')) {
    await del('/api/people/' + id);
    await load(renderAll);
    toast('已删除人员');
  }
}

export async function deleteProject(id, skip, renderAll) {
  if (skip || confirm('删除项目会同步删除排期和节点，确认？')) {
    await del('/api/projects/' + id);
    await load(renderAll);
    toast('已删除项目');
  }
}

export async function deleteAssignment(id, skip, renderAll) {
  if (skip || confirm('删除该排期？')) {
    await del('/api/assignments/' + id);
    await load(renderAll);
    toast('已删除排期');
  }
}

export async function deleteMilestone(id, skip, renderAll) {
  if (skip || confirm('删除该节点？')) {
    await del('/api/milestones/' + id);
    await load(renderAll);
    toast('已删除节点');
  }
}

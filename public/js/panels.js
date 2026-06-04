// panels.js — 模态框、资源抽屉、设置面板、统计栏、CSV 导入、toast

import {
  $, state, dates, esc, resourceTab, settingsTab,
  setResourceTab as setResourceTabState, setSettingsTab as setSettingsTabState,
  isDayOff, inRange, totalHours, endOf, iso, workingDays,
  project, personColor, projectColor, stableColor
} from './state.js';
import { post, put, del, load, api } from './api.js';

// ── toast ──
export function toast(msg) {
  let t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

// ── 模态框 ──
export function closeModal() { $('modalMask').classList.remove('show'); }

export function showModal(title, body, onSave, onDelete) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalSave').onclick = onSave;
  $('modalDelete').style.visibility = onDelete ? 'visible' : 'hidden';
  $('modalDelete').onclick = onDelete || (() => {});
  $('modalMask').classList.add('show');
}

export function val(id) { return $(id).value.trim(); }

// ── 人员表单 ──
export function openPerson(id) {
  let p = id ? person(id) : { name: '', department: '研发部', role: '', dailyCapacity: 8, archived: 0, color: '' };
  showModal(
    id ? '编辑人员' : '新增人员',
    `<div class="form"><div class="form-row"><div><label>姓名</label><input id="f_name" value="${esc(p.name || '')}"></div><div><label>每日产能/h</label><input id="f_cap" type="number" value="${p.dailyCapacity || 8}"></div></div><div class="form-row"><div><label>部门</label><input id="f_dept" value="${esc(p.department || '')}"></div><div><label>角色</label><input id="f_role" value="${esc(p.role || '')}"></div></div><div><label>颜色</label><input id="f_color" type="color" value="${p.color || stableColor('person-' + (p.id || p.name))}"></div>${id ? `<div><label><input id="f_archived" type="checkbox" ${p.archived ? 'checked' : ''}> 归档（不在日历和下拉中显示）</label></div>` : ''}</div>`,
    async () => {
      let d = { name: val('f_name'), department: val('f_dept'), role: val('f_role'), dailyCapacity: Number(val('f_cap') || 8), color: val('f_color') };
      if (id) d.archived = $('f_archived').checked ? 1 : 0;
      if (!d.name) return toast('请输入姓名');
      id ? await put('/api/people/' + id, d) : await post('/api/people', d);
      closeModal(); await reloadAll(); toast('已保存人员');
    },
    id ? async () => { await del('/api/people/' + id); closeModal(); await reloadAll(); toast('已删除人员'); } : null
  );
}

// ── 项目表单 ──
export function openProject(id) {
  let p = id ? project(id) : { name: '', owner: '', priority: '中', color: '#7db7ff', startDate: '', endDate: '', archived: 0 };
  showModal(
    id ? '编辑项目' : '新增项目',
    `<div class="form"><div><label>项目名称</label><input id="f_name" value="${esc(p.name || '')}"></div><div class="form-row"><div><label>负责人</label><input id="f_owner" list="peopleList" value="${esc(p.owner || '')}"><datalist id="peopleList">${state.people.filter(x => !x.archived).map(x => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></div><div><label>优先级</label><select id="f_pri"><option ${p.priority === '高' ? 'selected' : ''}>高</option><option ${p.priority === '中' ? 'selected' : ''}>中</option><option ${p.priority === '低' ? 'selected' : ''}>低</option></select></div></div><div class="form-row"><div><label>项目开始日期</label><input id="f_start" type="date" value="${p.startDate || ''}"></div><div><label>项目结束日期</label><input id="f_end" type="date" value="${p.endDate || ''}"></div></div><span class="form-hint">设置后排期日期不能超出此范围，留空不限制。</span><div><label>项目颜色</label><input id="f_color" type="color" value="${p.color || '#7db7ff'}"></div>${id ? `<div><label><input id="f_archived" type="checkbox" ${p.archived ? 'checked' : ''}> 归档（不在日历和下拉中显示）</label></div>` : ''}</div>`,
    async () => {
      let d = { name: val('f_name'), owner: val('f_owner'), priority: val('f_pri'), color: val('f_color'), startDate: val('f_start'), endDate: val('f_end') };
      if (id) d.archived = $('f_archived').checked ? 1 : 0;
      if (!d.name) return toast('请输入项目名');
      if (d.startDate && d.endDate && d.endDate < d.startDate) return toast('结束日期不能早于开始日期');
      id ? await put('/api/projects/' + id, d) : await post('/api/projects', d);
      closeModal(); await reloadAll(); toast('已保存项目');
    },
    id ? async () => { await del('/api/projects/' + id); closeModal(); await reloadAll(); toast('已删除项目'); } : null
  );
}

// ── 排期表单 ──
export function updatePerDayHint() {
  const d = workingDays(val('f_date'), val('f_end'));
  const t = Number(val('f_total') || 0);
  const el = $('f_perday');
  if (el) el.textContent = d + '个工作日 · 每日' + (d > 0 ? (t / d).toFixed(1) : '0.0') + 'h';
}

export function openAssignment(id) {
  let a = state.assignments.find(x => x.id === id);
  const days = workingDays(a.date, endOf(a));
  const totalH = Number((Number(a.hours || 0) * days).toFixed(1));
  const peopleList = state.people.filter(p => !p.archived || p.id === a.personId);
  const projectList = state.projects.filter(p => !p.archived || p.id === a.projectId);

  showModal(
    '编辑排期',
    `<div class="form"><div class="form-row"><div><label>人员</label><select id="f_person">${peopleList.map(p => `<option value="${p.id}" ${a.personId === p.id ? 'selected' : ''}>${p.name}${p.archived ? ' (归档)' : ''}</option>`).join('')}</select></div><div><label>项目</label><select id="f_project">${projectList.map(p => `<option value="${p.id}" ${a.projectId === p.id ? 'selected' : ''}>${p.name}${p.archived ? ' (归档)' : ''}</option>`).join('')}</select></div></div><div class="form-row"><div><label>开始日期</label><input id="f_date" type="date" value="${a.date}" onchange="window._updatePerDayHint()"></div><div><label>结束日期</label><input id="f_end" type="date" value="${endOf(a)}" onchange="window._updatePerDayHint()"></div></div><div class="form-row"><div><label>总工时</label><input id="f_total" type="number" value="${totalH}" min="0" oninput="window._updatePerDayHint()"><span id="f_perday" class="form-hint">${days}天 · 每日${(days > 0 ? (totalH / days) : 0).toFixed(1)}h</span></div><div><label>备注</label><input id="f_note" value="${esc(a.note || '')}"></div></div></div>`,
    async () => {
      const sd = val('f_date'), ed = val('f_end'), d = workingDays(sd, ed), t = Number(val('f_total') || 0);
      const proj = state.projects.find(x => x.id === val('f_project'));
      if (proj && proj.startDate && sd < proj.startDate) return toast('排期开始日期不能早于 ' + proj.startDate);
      if (proj && proj.endDate && ed > proj.endDate) return toast('排期结束日期不能晚于 ' + proj.endDate);
      await put('/api/assignments/' + id, { personId: val('f_person'), projectId: val('f_project'), date: sd, endDate: ed, hours: d > 0 ? Math.round(t / d * 10) / 10 : 8, note: val('f_note') });
      closeModal(); await reloadAll(); toast('已保存排期');
    },
    async () => { await del('/api/assignments/' + id); closeModal(); await reloadAll(); toast('已删除排期'); }
  );
}

// ── 里程碑表单 ──
export function openMilestone(id) {
  let m = id ? state.milestones.find(x => x.id === id) : { projectId: state.projects.filter(p => !p.archived)[0]?.id || '', name: '', date: iso(new Date()), level: 'important', owner: '', description: '' };
  const projectList = state.projects.filter(p => !p.archived || p.id === m.projectId);
  const peopleList = state.people.filter(p => !p.archived);

  showModal(
    id ? '编辑里程碑' : '新增里程碑',
    `<div class="form"><div class="form-row"><div><label>节点名称</label><input id="f_name" value="${esc(m.name || '')}"></div><div><label>日期</label><input id="f_date" type="date" value="${m.date || iso(new Date())}"></div></div><div class="form-row"><div><label>项目</label><select id="f_project">${projectList.map(p => `<option value="${p.id}" ${m.projectId === p.id ? 'selected' : ''}>${p.name}${p.archived ? ' (归档)' : ''}</option>`).join('')}</select></div><div><label>级别</label><select id="f_level"><option value="important" ${m.level === 'important' ? 'selected' : ''}>重要</option><option value="risk" ${m.level === 'risk' ? 'selected' : ''}>风险</option></select></div></div><div><label>负责人</label><select id="f_owner"><option value="">未指派</option>${peopleList.map(p => `<option value="${esc(p.name)}" ${m.owner === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div><div><label>说明</label><textarea id="f_desc">${esc(m.description || '')}</textarea></div></div>`,
    async () => {
      let d = { name: val('f_name'), date: val('f_date'), projectId: val('f_project'), level: val('f_level'), owner: val('f_owner'), description: val('f_desc') };
      if (!d.name) return toast('请输入节点名称');
      if (!d.projectId) return toast('请先创建项目');
      id ? await put('/api/milestones/' + id, d) : await post('/api/milestones', d);
      closeModal(); await reloadAll(); toast('已保存节点');
    },
    id ? async () => { await del('/api/milestones/' + id); closeModal(); await reloadAll(); toast('已删除节点'); } : null
  );
}

// ── 快速新增排期 ──
export function openAddAssignment(personId, projectId, date) {
  const activePeople = state.people.filter(p => !p.archived);
  const activeProjects = state.projects.filter(p => !p.archived);
  const pId = personId || activePeople[0]?.id || '';
  const prId = projectId || activeProjects[0]?.id || '';
  const d = date || iso(new Date());

  showModal(
    '新增排期',
    `<div class="form"><div class="form-row"><div><label>人员</label><select id="f_person">${activePeople.map(x => `<option value="${x.id}" ${x.id === pId ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div><div><label>项目</label><select id="f_project">${activeProjects.map(x => `<option value="${x.id}" ${x.id === prId ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div></div><div class="form-row"><div><label>开始日期</label><input id="f_date" type="date" value="${d}" onchange="window._updatePerDayHint()"></div><div><label>结束日期</label><input id="f_end" type="date" value="${d}" onchange="window._updatePerDayHint()"></div></div><div class="form-row"><div><label>总工时/h</label><input id="f_total" type="number" value="8" min="0" oninput="window._updatePerDayHint()"><span id="f_perday" class="form-hint">1个工作日 · 每日8.0h</span></div><div><label>备注</label><input id="f_note" value=""></div></div></div>`,
    async () => {
      const sd = val('f_date'), ed = val('f_end'), dd = workingDays(sd, ed), t = Number(val('f_total') || 0);
      const proj = state.projects.find(x => x.id === val('f_project'));
      if (proj && proj.startDate && sd < proj.startDate) return toast('排期开始日期不能早于 ' + proj.startDate);
      if (proj && proj.endDate && ed > proj.endDate) return toast('排期结束日期不能晚于 ' + proj.endDate);
      await post('/api/assignments', { personId: val('f_person'), projectId: val('f_project'), date: sd, endDate: ed, hours: dd > 0 ? Math.round(t / dd * 10) / 10 : 8, note: val('f_note') });
      closeModal(); await reloadAll(); toast('已新增排期');
    },
    null
  );
}

// ── 快速新增里程碑 ──
export function openAddMilestone(projectId, date) {
  const activeProjects = state.projects.filter(p => !p.archived);
  const activePeople = state.people.filter(p => !p.archived);
  const prId = projectId || activeProjects[0]?.id || '';
  const d = date || iso(new Date());

  showModal(
    '新增里程碑',
    `<div class="form"><div class="form-row"><div><label>节点名称</label><input id="f_name" value=""></div><div><label>日期</label><input id="f_date" type="date" value="${d}"></div></div><div class="form-row"><div><label>项目</label><select id="f_project">${activeProjects.map(p => `<option value="${p.id}" ${p.id === prId ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div><div><label>级别</label><select id="f_level"><option value="important">重要</option><option value="risk">风险</option></select></div></div><div><label>负责人</label><select id="f_owner"><option value="">未指派</option>${activePeople.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}</select></div><div><label>说明</label><textarea id="f_desc"></textarea></div></div>`,
    async () => {
      let dd = { name: val('f_name'), date: val('f_date'), projectId: val('f_project'), level: val('f_level'), owner: val('f_owner'), description: val('f_desc') };
      if (!dd.name) return toast('请输入节点名称');
      if (!dd.projectId) return toast('请先创建项目');
      await post('/api/milestones', dd);
      closeModal(); await reloadAll(); toast('已新增里程碑');
    },
    null
  );
}

// ── 资源抽屉 ──
export function openDrawer(tab) {
  setResourceTabState(tab || resourceTab || 'people');
  $('drawerMask').classList.add('show');
  renderResourceBody();
}

export function closeDrawer() {
  $('drawerMask').classList.remove('show');
}

export function setResourceTab(tab) {
  setResourceTabState(tab);
  renderResourceBody();
}

export function renderResourceBody() {
  const tabs = { people: 'rPeople', projects: 'rProjects', milestones: 'rMilestones' };
  Object.values(tabs).forEach(id => { if ($(id)) $(id).classList.remove('active'); });
  if ($(tabs[resourceTab])) $(tabs[resourceTab]).classList.add('active');
  if (!$('resourceBody')) return;

  // 头部「＋」按钮
  const addBtn = { people: ['＋ 人员', 'data-add-person'], projects: ['＋ 项目', 'data-add-project'], milestones: ['＋ 里程碑', 'data-add-milestone'] };
  const [label, attr] = addBtn[resourceTab] || addBtn.people;
  $('drawerAdd').innerHTML = `<button ${attr}>${label}</button>`;

  if (resourceTab === 'people') {
    $('resourceBody').innerHTML = state.people.filter(p => !p.archived).map(p =>
      `<div class="item person-card" data-id="${p.id}" draggable="true" data-drag-type="person" data-drag-id="${p.id}">` +
      `<span class="drag-handle" data-reorder="people" data-reorder-id="${p.id}">⠿</span>` +
      `<div class="item-main"><div class="item-title"><span class="dot" style="background:${personColor(p)}"></span><span class="item-name">${esc(p.name)}</span></div><small>${esc(p.department || '')} · ${esc(p.role || '')} · ${Number(p.dailyCapacity || 8)}h/天</small></div>` +
      `<div class="actions"><button class="mini" data-edit-person="${p.id}">编辑</button></div></div>`
    ).join('') || '<div class="empty">暂无人员</div>';
  } else if (resourceTab === 'projects') {
    $('resourceBody').innerHTML = state.projects.filter(p => !p.archived).map(p => {
      const d = p.startDate ? ` · ${p.startDate.slice(5)}${p.endDate ? '~' + p.endDate.slice(5) : ''}` : '';
      return `<div class="item" data-id="${p.id}" draggable="true" data-drag-type="project" data-drag-id="${p.id}">` +
        `<span class="drag-handle" data-reorder="projects" data-reorder-id="${p.id}">⠿</span>` +
        `<div class="item-main"><div class="item-title"><span class="dot" style="background:${projectColor(p)}"></span><span class="item-name">${esc(p.name)}</span></div><small>${p.owner ? '负责人：' + esc(p.owner) + ' · ' : ''}${esc(p.priority || '中')}${d}</small></div>` +
        `<div class="actions"><button class="mini" data-edit-project="${p.id}">编辑</button></div></div>`;
    }).join('') || '<div class="empty">暂无项目</div>';
  } else {
    $('resourceBody').innerHTML = state.milestones.filter(m => {
      const pr = project(m.projectId);
      return pr && !pr.archived;
    }).map(m => {
      const pr = project(m.projectId) || {};
      return `<div class="item" draggable="true" data-drag-type="milestone" data-drag-id="${m.id}">` +
        `<div class="item-main"><div class="item-title"><span class="dot" style="background:${projectColor(pr)}"></span><span class="item-name">${esc(m.name)}</span></div><small>${esc(m.date || '')} · ${esc(pr.name || '项目已删')} · ${m.level === 'risk' ? '风险' : '重要'}</small></div>` +
        `<div class="actions"><button class="mini" data-edit-milestone="${m.id}">编辑</button></div></div>`;
    }).join('') || '<div class="empty">暂无里程碑</div>';
  }
}

// ── 统计栏 ──
export function renderStats() {
  let workDays = dates.filter(d => !isDayOff(d)).length;
  let capacity = state.people.reduce((s, p) => s + Number(p.dailyCapacity || 0) * workDays, 0);
  let used = state.assignments.reduce((s, a) => {
    let wd = 0;
    dates.forEach(d => { if (inRange(a, d) && !isDayOff(d)) wd++; });
    return s + Number(a.hours || 0) * wd;
  }, 0);
  let conflicts = 0;
  state.people.forEach(p => dates.forEach(d => {
    if (!isDayOff(d) && totalHours(p.id, d) > Number(p.dailyCapacity || 8)) conflicts++;
  }));
  let ms = state.milestones.filter(m => dates.includes(m.date)).length;

  $('stats').innerHTML = [
    ['产能', capacity + 'h'],
    ['已分配', used + 'h'],
    ['空闲', Math.max(0, capacity - used) + 'h'],
    ['负载', capacity ? Math.round(used / capacity * 100) + '%' : '0%'],
    ['冲突', conflicts],
    ['里程碑', ms]
  ].map(x => `<span><b>${x[1]}</b><small>${x[0]}</small></span>`).join('');
}

// ── 设置面板 ──
function settingsNav() {
  const tabs = [['people', '人员'], ['projects', '项目'], ['milestones', '里程碑'], ['data', '数据']];
  return `<div class="settings-subtabs">${tabs.map(([key, label]) =>
    `<button class="${settingsTab === key ? 'active' : ''}" data-settings-tab="${key}">${label}</button>`
  ).join('')}</div>`;
}

export function setSettingsTab(tab) {
  setSettingsTabState(tab);
  renderSettings();
}

export function renderSettings() {
  let content = '';

  if (settingsTab === 'people') {
    content = `<div class="settings-layout"><div class="panel"><h3>人员设置</h3><button data-add-person>＋新增人员</button><br><br>${state.people.map(p =>
      `<div class="item" style="${p.archived ? 'opacity:.5' : ''}"><div>${p.name}${p.archived ? ' <b style="color:var(--red)">[已归档]</b>' : ''}<br><small>${p.department} · ${p.role} · ${p.dailyCapacity}h/天</small></div><div class="actions"><button class="mini" data-edit-person="${p.id}">编辑</button><button class="mini danger" data-delete-person="${p.id}">删</button></div></div>`
    ).join('') || '<div class="empty">暂无人员</div>'}</div></div>`;
  }

  if (settingsTab === 'projects') {
    content = `<div class="settings-layout"><div class="panel"><h3>项目设置</h3><button data-add-project>＋新增项目</button><br><br>${state.projects.map(p => {
      const d = p.startDate ? ` · ${p.startDate}${p.endDate ? '~' + p.endDate : ''}` : '';
      return `<div class="item" style="${p.archived ? 'opacity:.5' : ''}"><div><span class="dot" style="background:${projectColor(p)}"></span>${p.name}${p.archived ? ' <b style="color:var(--red)">[已归档]</b>' : ''}<br><small>${p.owner} · ${p.priority}${d}</small></div><div class="actions"><button class="mini" data-edit-project="${p.id}">编辑</button><button class="mini danger" data-delete-project="${p.id}">删</button></div></div>`;
    }).join('') || '<div class="empty">暂无项目</div>'}</div></div>`;
  }

  if (settingsTab === 'milestones') {
    content = `<div class="settings-layout"><div class="panel"><h3>里程碑设置</h3><button data-add-milestone>＋新增里程碑</button><br><br>${state.milestones.map(m => {
      let pr = project(m.projectId) || {};
      return `<div class="item"><div><span class="dot" style="background:${pr.color || '#ffd86b'}"></span>${m.name}<br><small>${m.date} · ${pr.name || '项目已删'} · ${m.level === 'risk' ? '风险' : '重要'}</small></div><div class="actions"><button class="mini" data-edit-milestone="${m.id}">编辑</button><button class="mini danger" data-delete-milestone="${m.id}">删</button></div></div>`;
    }).join('') || '<div class="empty">暂无里程碑</div>'}</div></div>`;
  }

  if (settingsTab === 'data') {
    content = `<div class="settings-layout"><div class="panel"><h3>数据导入 / 导出</h3><div class="panel-actions"><button data-export-csv>导出 CSV</button><button data-import-csv>导入 CSV</button><button class="danger" data-reset-data>重置数据</button></div><p class="hint">导入支持导出文件同款结构。排期至少包含：日期、人员、项目；里程碑至少包含：日期、项目、里程碑。可选列：结束日期、部门、角色、项目负责人、工时、备注、里程碑级别、里程碑负责人、里程碑说明。</p><div class="empty" style="margin-top:12px">导入策略：按人员名称和项目名称匹配；不存在则自动创建人员或项目；排期与里程碑都会追加到当前数据中。重置会直接清空当前 SQLite，不再回填 Demo 数据。</div></div></div>`;
  }

  $('settingsCard').innerHTML = settingsNav() + content;
}

// ── CSV 导入 ──
export async function importCsv(input) {
  let file = input.files && input.files[0];
  if (!file) return;
  try {
    let text = await file.text();
    let r = await fetch('/api/import.csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: text
    });
    let data = await r.json();
    if (!r.ok) throw new Error(data.error || '导入失败');
    await reloadAll();
    toast(`导入完成：排期新增 ${data.createdAssignments} 条、合并 ${data.mergedAssignments || 0} 条，里程碑新增 ${data.createdMilestones || 0} 条、合并 ${data.mergedMilestones || 0} 条，新增人员 ${data.createdPeople} 个，新增项目 ${data.createdProjects} 个，跳过 ${data.skipped} 行`);
  } catch (e) {
    toast(e.message);
  } finally {
    input.value = '';
  }
}

export async function resetData(nativeActionSender = null) {
  if (nativeActionSender && nativeActionSender('resetData')) return;
  if (!confirm('重置后会清空当前所有人员、项目、排期和里程碑，且不会恢复 Demo 数据，确认继续？')) return;
  const second = window.prompt('这是不可恢复操作。请输入 RESET 确认重置：', '');
  if (second !== 'RESET') {
    toast('已取消重置');
    return;
  }
  await api('/api/reset', { method: 'POST' });
  await reloadAll();
  toast('已清空当前数据');
}

// ── 重新加载（供面板模块内部使用） ──
let _renderAll = null;
export function setRenderAll(fn) { _renderAll = fn; }
async function reloadAll() { if (_renderAll) await load(_renderAll); }

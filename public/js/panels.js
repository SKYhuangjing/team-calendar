// panels.js — 模态框、资源抽屉、设置面板、统计栏、CSV 导入、toast

import {
  $, state, dates, esc, resourceTab, settingsTab,
  setResourceTab as setResourceTabState, setSettingsTab as setSettingsTabState,
  isDayOff, inRange, totalHours, endOf, iso, workingDays,
  project, person, personColor, projectColor, stableColor,
  rowMatches, filters, setFilter, clearFilters, hasActiveFilters,
  loadRate, milestoneStatus, conflictHighlight, setConflictHighlight,
  undoLast, pushUndo, clearUndo,
  assignmentMatches, milestoneMatches
} from './state.js';
import { post, put, del, load, api } from './api.js';
import { t } from './i18n.js';

// 显示用的本地化标签（数据值保持规范：优先级 高/中/低、级别 important/risk）
const PRI_LABEL = v => ({ '高': t('label.priorityHigh'), '中': t('label.priorityMid'), '低': t('label.priorityLow') })[v] || v;
const LEVEL_LABEL = v => v === 'risk' ? t('label.levelRisk') : t('label.levelImportant');

// ── toast ──
export function toast(msg) {
  let el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

// ── 模态框 ──
export function closeModal() {
  $('modalMask').classList.remove('show');
  const modal = document.querySelector('#modalMask .modal');
  if (modal) modal.classList.remove('large');
}

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
    id ? t('title.editPerson') : t('title.addPerson'),
    `<div class="form"><div class="form-row"><div><label>${t('label.name')}</label><input id="f_name" value="${esc(p.name || '')}"></div><div><label>${t('label.capacity')}</label><input id="f_cap" type="number" value="${p.dailyCapacity || 8}"></div></div><div class="form-row"><div><label>${t('label.dept')}</label><input id="f_dept" value="${esc(p.department || '')}"></div><div><label>${t('label.role')}</label><input id="f_role" value="${esc(p.role || '')}"></div></div><div><label>${t('label.color')}</label><input id="f_color" type="color" value="${p.color || stableColor('person-' + (p.id || p.name))}"></div>${id ? `<div><label><input id="f_archived" type="checkbox" ${p.archived ? 'checked' : ''}> ${t('label.archived')}</label></div>` : ''}</div>`,
    async () => {
      let d = { name: val('f_name'), department: val('f_dept'), role: val('f_role'), dailyCapacity: Number(val('f_cap') || 8), color: val('f_color') };
      if (id) d.archived = $('f_archived').checked ? 1 : 0;
      if (!d.name) return toast(t('toast.needName'));
      id ? await put('/api/people/' + id, d) : await post('/api/people', d);
      closeModal(); await reloadAll(); toast(t('toast.savedPerson'));
    },
    id ? async () => { await del('/api/people/' + id); closeModal(); await reloadAll(); toast(t('toast.deletedPerson')); } : null
  );
}

// ── 项目表单 ──
export function openProject(id) {
  let p = id ? project(id) : { name: '', owner: '', priority: '中', color: '#7db7ff', startDate: '', endDate: '', archived: 0 };
  const priOpt = v => `<option value="${v}" ${p.priority === v ? 'selected' : ''}>${PRI_LABEL(v)}</option>`;
  showModal(
    id ? t('title.editProject') : t('title.addProject'),
    `<div class="form"><div><label>${t('label.projectName')}</label><input id="f_name" value="${esc(p.name || '')}"></div><div class="form-row"><div><label>${t('label.owner')}</label><input id="f_owner" list="peopleList" value="${esc(p.owner || '')}"><datalist id="peopleList">${state.people.filter(x => !x.archived).map(x => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></div><div><label>${t('label.priority')}</label><select id="f_pri">${priOpt('高')}${priOpt('中')}${priOpt('低')}</select></div></div><div class="form-row"><div><label>${t('label.projectStart')}</label><input id="f_start" type="date" value="${p.startDate || ''}"></div><div><label>${t('label.projectEnd')}</label><input id="f_end" type="date" value="${p.endDate || ''}"></div></div><span class="form-hint">${t('label.projectRangeHint')}</span><div><label>${t('label.projectColor')}</label><input id="f_color" type="color" value="${p.color || '#7db7ff'}"></div>${id ? `<div><label><input id="f_archived" type="checkbox" ${p.archived ? 'checked' : ''}> ${t('label.archived')}</label></div>` : ''}</div>`,
    async () => {
      let d = { name: val('f_name'), owner: val('f_owner'), priority: val('f_pri'), color: val('f_color'), startDate: val('f_start'), endDate: val('f_end') };
      if (id) d.archived = $('f_archived').checked ? 1 : 0;
      if (!d.name) return toast(t('toast.needProjectName'));
      if (d.startDate && d.endDate && d.endDate < d.startDate) return toast(t('toast.dateRangeInvalid'));
      id ? await put('/api/projects/' + id, d) : await post('/api/projects', d);
      closeModal(); await reloadAll(); toast(t('toast.savedProject'));
    },
    id ? async () => { await del('/api/projects/' + id); closeModal(); await reloadAll(); toast(t('toast.deletedProject')); } : null
  );
}

// ── 排期表单 ──
export function updatePerDayHint() {
  const d = workingDays(val('f_date'), val('f_end'));
  const tot = Number(val('f_total') || 0);
  const perDay = d > 0 ? tot / d : 0;
  const personId = val('f_person');
  const p = state.people.find(x => x.id === personId);
  const cap = Number((p && p.dailyCapacity) || 8);
  const fte = cap ? (perDay / cap) : 0;
  const el = $('f_perday');
  if (el) el.textContent = t('label.perdayHint', { d, perDay: perDay.toFixed(1), n: Math.round(fte * 100) });
}

export function openAssignment(id) {
  let a = state.assignments.find(x => x.id === id);
  const days = workingDays(a.date, endOf(a));
  const totalH = Number((Number(a.hours || 0) * days).toFixed(1));
  const peopleList = state.people.filter(p => !p.archived || p.id === a.personId);
  const projectList = state.projects.filter(p => !p.archived || p.id === a.projectId);
  const arc = p => p.archived ? ' ' + t('label.archivedSuffix') : '';

  showModal(
    t('title.editAssign'),
    `<div class="form"><div class="form-row"><div><label>${t('label.person')}</label><select id="f_person">${peopleList.map(p => `<option value="${p.id}" ${a.personId === p.id ? 'selected' : ''}>${p.name}${arc(p)}</option>`).join('')}</select></div><div><label>${t('label.project')}</label><select id="f_project">${projectList.map(p => `<option value="${p.id}" ${a.projectId === p.id ? 'selected' : ''}>${p.name}${arc(p)}</option>`).join('')}</select></div></div><div class="form-row"><div><label>${t('label.startDate')}</label><input id="f_date" type="date" value="${a.date}" onchange="window._updatePerDayHint()"></div><div><label>${t('label.endDate')}</label><input id="f_end" type="date" value="${endOf(a)}" onchange="window._updatePerDayHint()"></div></div><div class="form-row"><div><label>${t('label.totalHours')}</label><input id="f_total" type="number" value="${totalH}" min="0" oninput="window._updatePerDayHint()"><span id="f_perday" class="form-hint">${t('label.perdayShort', { d: days, perDay: (days > 0 ? (totalH / days) : 0).toFixed(1) })}</span></div><div><label>${t('label.note')}</label><input id="f_note" value="${esc(a.note || '')}"></div></div></div>`,
    async () => {
      const sd = val('f_date'), ed = val('f_end'), d = workingDays(sd, ed), tot = Number(val('f_total') || 0);
      const proj = state.projects.find(x => x.id === val('f_project'));
      if (proj && proj.startDate && sd < proj.startDate) return toast(t('toast.assignStartBefore') + proj.startDate);
      if (proj && proj.endDate && ed > proj.endDate) return toast(t('toast.assignEndAfter') + proj.endDate);
      await put('/api/assignments/' + id, { personId: val('f_person'), projectId: val('f_project'), date: sd, endDate: ed, hours: d > 0 ? Math.round(tot / d * 10) / 10 : 8, note: val('f_note') });
      closeModal(); await reloadAll(); toast(t('toast.savedAssign'));
    },
    async () => { await del('/api/assignments/' + id); closeModal(); await reloadAll(); toast(t('toast.deletedAssign')); }
  );
}

// ── 里程碑表单 ──
export function openMilestone(id) {
  let m = id ? state.milestones.find(x => x.id === id) : { projectId: state.projects.filter(p => !p.archived)[0]?.id || '', name: '', date: iso(new Date()), level: 'important', owner: '', description: '' };
  const projectList = state.projects.filter(p => !p.archived || p.id === m.projectId);
  const peopleList = state.people.filter(p => !p.archived);
  const arc = p => p.archived ? ' ' + t('label.archivedSuffix') : '';

  showModal(
    id ? t('title.editMilestone') : t('title.addMilestone'),
    `<div class="form"><div class="form-row"><div><label>${t('label.milestoneName')}</label><input id="f_name" value="${esc(m.name || '')}"></div><div><label>${t('label.date')}</label><input id="f_date" type="date" value="${m.date || iso(new Date())}"></div></div><div class="form-row"><div><label>${t('label.project')}</label><select id="f_project">${projectList.map(p => `<option value="${p.id}" ${m.projectId === p.id ? 'selected' : ''}>${p.name}${arc(p)}</option>`).join('')}</select></div><div><label>${t('label.level')}</label><select id="f_level"><option value="important" ${m.level === 'important' ? 'selected' : ''}>${t('label.levelImportant')}</option><option value="risk" ${m.level === 'risk' ? 'selected' : ''}>${t('label.levelRisk')}</option></select></div></div><div><label>${t('label.assignee')}</label><select id="f_owner"><option value="">${t('label.unassigned')}</option>${peopleList.map(p => `<option value="${esc(p.name)}" ${m.owner === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div><div><label>${t('label.desc')}</label><textarea id="f_desc">${esc(m.description || '')}</textarea></div></div>`,
    async () => {
      let d = { name: val('f_name'), date: val('f_date'), projectId: val('f_project'), level: val('f_level'), owner: val('f_owner'), description: val('f_desc') };
      if (!d.name) return toast(t('toast.needMilestoneName'));
      if (!d.projectId) return toast(t('toast.needProject'));
      id ? await put('/api/milestones/' + id, d) : await post('/api/milestones', d);
      closeModal(); await reloadAll(); toast(t('toast.savedMilestone'));
    },
    id ? async () => { await del('/api/milestones/' + id); closeModal(); await reloadAll(); toast(t('toast.deletedMilestone')); } : null
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
    t('title.addAssign'),
    `<div class="form"><div class="form-row"><div><label>${t('label.person')}</label><select id="f_person">${activePeople.map(x => `<option value="${x.id}" ${x.id === pId ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div><div><label>${t('label.project')}</label><select id="f_project">${activeProjects.map(x => `<option value="${x.id}" ${x.id === prId ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div></div><div class="form-row"><div><label>${t('label.startDate')}</label><input id="f_date" type="date" value="${d}" onchange="window._updatePerDayHint()"></div><div><label>${t('label.endDate')}</label><input id="f_end" type="date" value="${d}" onchange="window._updatePerDayHint()"></div></div><div class="form-row"><div><label>${t('label.totalHoursH')}</label><input id="f_total" type="number" value="8" min="0" oninput="window._updatePerDayHint()"><span id="f_perday" class="form-hint">${t('label.perdayInit')}</span></div><div><label>${t('label.note')}</label><input id="f_note" value=""></div></div></div>`,
    async () => {
      const sd = val('f_date'), ed = val('f_end'), dd = workingDays(sd, ed), tot = Number(val('f_total') || 0);
      const proj = state.projects.find(x => x.id === val('f_project'));
      if (proj && proj.startDate && sd < proj.startDate) return toast(t('toast.assignStartBefore') + proj.startDate);
      if (proj && proj.endDate && ed > proj.endDate) return toast(t('toast.assignEndAfter') + proj.endDate);
      await post('/api/assignments', { personId: val('f_person'), projectId: val('f_project'), date: sd, endDate: ed, hours: dd > 0 ? Math.round(tot / dd * 10) / 10 : 8, note: val('f_note') });
      closeModal(); await reloadAll(); toast(t('toast.addedAssign'));
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
    t('title.addMilestone'),
    `<div class="form"><div class="form-row"><div><label>${t('label.milestoneName')}</label><input id="f_name" value=""></div><div><label>${t('label.date')}</label><input id="f_date" type="date" value="${d}"></div></div><div class="form-row"><div><label>${t('label.project')}</label><select id="f_project">${activeProjects.map(p => `<option value="${p.id}" ${p.id === prId ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div><div><label>${t('label.level')}</label><select id="f_level"><option value="important">${t('label.levelImportant')}</option><option value="risk">${t('label.levelRisk')}</option></select></div></div><div><label>${t('label.assignee')}</label><select id="f_owner"><option value="">${t('label.unassigned')}</option>${activePeople.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('')}</select></div><div><label>${t('label.desc')}</label><textarea id="f_desc"></textarea></div></div>`,
    async () => {
      let dd = { name: val('f_name'), date: val('f_date'), projectId: val('f_project'), level: val('f_level'), owner: val('f_owner'), description: val('f_desc') };
      if (!dd.name) return toast(t('toast.needMilestoneName'));
      if (!dd.projectId) return toast(t('toast.needProject'));
      await post('/api/milestones', dd);
      closeModal(); await reloadAll(); toast(t('toast.addedMilestone'));
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
  const addBtn = { people: [t('resource.addPerson'), 'data-add-person'], projects: [t('resource.addProject'), 'data-add-project'], milestones: [t('resource.addMilestone'), 'data-add-milestone'] };
  const [label, attr] = addBtn[resourceTab] || addBtn.people;
  $('drawerAdd').innerHTML = `<button ${attr}>${label}</button>`;

  if (resourceTab === 'people') {
    $('resourceBody').innerHTML = state.people.filter(p => !p.archived).map(p =>
      `<div class="item person-card" data-id="${p.id}" draggable="true" data-drag-type="person" data-drag-id="${p.id}">` +
      `<span class="drag-handle" data-reorder="people" data-reorder-id="${p.id}">⠿</span>` +
      `<div class="item-main"><div class="item-title"><span class="dot" style="background:${personColor(p)}"></span><span class="item-name">${esc(p.name)}</span></div><small>${esc(t('resource.personMeta', { dept: p.department || '', role: p.role || '', cap: Number(p.dailyCapacity || 8) }))}</small></div>` +
      `<div class="actions"><button class="mini" data-edit-person="${p.id}">${t('action.edit')}</button></div></div>`
    ).join('') || `<div class="empty">${t('empty.people')}</div>`;
  } else if (resourceTab === 'projects') {
    $('resourceBody').innerHTML = state.projects.filter(p => !p.archived).map(p => {
      const d = p.startDate ? ` · ${p.startDate.slice(5)}${p.endDate ? '~' + p.endDate.slice(5) : ''}` : '';
      return `<div class="item" data-id="${p.id}" draggable="true" data-drag-type="project" data-drag-id="${p.id}">` +
        `<span class="drag-handle" data-reorder="projects" data-reorder-id="${p.id}">⠿</span>` +
        `<div class="item-main"><div class="item-title"><span class="dot" style="background:${projectColor(p)}"></span><span class="item-name">${esc(p.name)}</span></div><small>${p.owner ? t('resource.projectOwner') + esc(p.owner) + ' · ' : ''}${esc(PRI_LABEL(p.priority || '中'))}${d}</small></div>` +
        `<div class="actions"><button class="mini" data-edit-project="${p.id}">${t('action.edit')}</button></div></div>`;
    }).join('') || `<div class="empty">${t('empty.projects')}</div>`;
  } else {
    $('resourceBody').innerHTML = state.milestones.filter(m => {
      const pr = project(m.projectId);
      return pr && !pr.archived;
    }).map(m => {
      const pr = project(m.projectId) || {};
      return `<div class="item" draggable="true" data-drag-type="milestone" data-drag-id="${m.id}">` +
        `<div class="item-main"><div class="item-title"><span class="dot" style="background:${projectColor(pr)}"></span><span class="item-name">${esc(m.name)}</span></div><small>${esc(m.date || '')} · ${esc(pr.name || t('resource.projDeleted'))} · ${LEVEL_LABEL(m.level)}</small></div>` +
        `<div class="actions"><button class="mini" data-edit-milestone="${m.id}">${t('action.edit')}</button></div></div>`;
    }).join('') || `<div class="empty">${t('empty.milestones')}</div>`;
  }
}

// ── 统计栏（随筛选范围联动；冲突/负载/已分配可点击）──
export function renderStats() {
  const workDays = dates.filter(d => !isDayOff(d)).length;
  const people = state.people.filter(p => !p.archived && rowMatches(p, 'person'));
  const pids = new Set(people.map(p => p.id));
  const capacity = people.reduce((s, p) => s + Number(p.dailyCapacity || 0) * workDays, 0);
  let used = 0, conflicts = 0;
  state.assignments.forEach(a => {
    if (!pids.has(a.personId)) return;
    if (!assignmentMatches(a)) return;
    let wd = 0;
    dates.forEach(d => { if (inRange(a, d) && !isDayOff(d)) wd++; });
    used += Number(a.hours || 0) * wd;
  });
  people.forEach(p => dates.forEach(d => {
    if (!isDayOff(d) && totalHours(p.id, d) > Number(p.dailyCapacity || 8)) conflicts++;
  }));
  const ms = state.milestones.filter(m => dates.includes(m.date) && milestoneMatches(m)).length;
  const near = state.milestones.filter(m => {
    const st = milestoneStatus(m.date); return (st.state === 'upcoming' || st.state === 'overdue') && milestoneMatches(m);
  }).length;

  const items = [
    { k: 'capacity', label: t('stat.capacity'), val: capacity + 'h', click: false },
    { k: 'used', label: t('stat.used'), val: used + 'h', click: true },
    { k: 'free', label: t('stat.free'), val: Math.max(0, capacity - used) + 'h', click: false },
    { k: 'load', label: t('stat.load'), val: capacity ? Math.round(used / capacity * 100) + '%' : '0%', click: true },
    { k: 'conflict', label: t('stat.conflict'), val: conflicts, click: true, on: conflictHighlight },
    { k: 'ms', label: t('stat.milestone'), val: ms, click: false, title: near ? t('stat.nearTip', { n: near }) : '' }
  ];
  $('stats').innerHTML = items.map(x =>
    `<span class="stat-pill${x.click ? ' clickable' : ''}${x.on ? ' active' : ''}" ${x.click ? `data-stat="${x.k}" role="button" tabindex="0"` : ''} ${x.title ? `title="${esc(x.title)}"` : ''}><b>${x.val}</b><small>${x.label}</small></span>`
  ).join('');
}

// ── 统计下钻：按项目 / 按人员（F2.3）──
export function showBreakdown(dim) {
  const people = state.people.filter(p => !p.archived && rowMatches(p, 'person'));
  const pids = new Set(people.map(p => p.id));
  const offDays = d => !isDayOff(d);
  if (dim === 'person') {
    const capPerPerson = dates.filter(offDays).length;
    const rows = people.map(p => {
      let used = 0;
      state.assignments.filter(a => a.personId === p.id && assignmentMatches(a)).forEach(a => {
        let wd = 0; dates.forEach(d => { if (inRange(a, d) && offDays(d)) wd++; });
        used += Number(a.hours || 0) * wd;
      });
      const cap = Number(p.dailyCapacity || 8) * capPerPerson;
      return { name: p.name, used, cap, rate: cap ? used / cap : 0 };
    }).sort((a, b) => b.used - a.used);
    $('breakdownTitle').textContent = t('bd.byPerson');
    $('breakdownBody').innerHTML = rows.map(r =>
      `<div class="bd-row"><span class="bd-name">${esc(r.name)}</span><div class="bd-bar"><div class="bd-fill ${r.rate > 1 ? 'over' : ''}" style="width:${Math.min(100, Math.round(r.rate * 100))}%"></div></div><small>${r.used}h / ${r.cap}h · ${Math.round(r.rate * 100)}%</small></div>`
    ).join('') || `<div class="empty">${t('empty.bd')}</div>`;
  } else {
    const projUsed = {};
    state.assignments.filter(a => pids.has(a.personId) && assignmentMatches(a)).forEach(a => {
      let wd = 0; dates.forEach(d => { if (inRange(a, d) && offDays(d)) wd++; });
      projUsed[a.projectId] = (projUsed[a.projectId] || 0) + Number(a.hours || 0) * wd;
    });
    const rows = state.projects.filter(p => !p.archived)
      .map(p => ({ name: p.name, used: projUsed[p.id] || 0, color: projectColor(p) }))
      .filter(r => r.used > 0).sort((a, b) => b.used - a.used);
    $('breakdownTitle').textContent = t('bd.byProject');
    $('breakdownBody').innerHTML = rows.map(r =>
      `<div class="bd-row"><span class="dot" style="background:${r.color}"></span><span class="bd-name">${esc(r.name)}</span><div style="flex:1"></div><small>${r.used}h</small></div>`
    ).join('') || `<div class="empty">${t('empty.bd')}</div>`;
  }
  $('breakdownMask').style.display = 'flex';
}

export function closeBreakdown() { $('breakdownMask').style.display = 'none'; }

// ── 筛选栏渲染（F1.5：部门/角色多选，项目/负责人单选）──
// 多选按钮标签：0 项→全量占位；N 项→占位 · N
export function msLabel(sel, allLabel) {
  return (sel && sel.length) ? `${allLabel} · ${sel.length}` : allLabel;
}
function fillMulti(id, key, opts, allLabel) {
  const el = $(id); if (!el) return;
  const sel = filters[key] || [];
  el.dataset.msKey = key;
  el.dataset.allLabel = allLabel;
  el.innerHTML =
    `<button class="ms-btn" type="button" aria-haspopup="true" aria-expanded="${el.classList.contains('open') ? 'true' : 'false'}">${esc(msLabel(sel, allLabel))}</button>` +
    `<div class="ms-panel">${opts.map(o => {
      const v = String(o); const checked = sel.includes(v) ? ' checked' : '';
      return `<label><input type="checkbox" value="${esc(v)}"${checked}> ${esc(v)}</label>`;
    }).join('') || `<div class="ms-empty">${t('empty.msOpts')}</div>`}</div>`;
}
export function renderFilters() {
  const depts = [...new Set(state.people.map(p => p.department).filter(Boolean))].sort();
  const roles = [...new Set(state.people.map(p => p.role).filter(Boolean))].sort();
  const owners = [...new Set(state.projects.map(p => p.owner).filter(Boolean))].sort();
  const projects = state.projects.filter(p => !p.archived);
  fillMulti('filterDept', 'departments', depts, t('filter.dept'));
  fillMulti('filterRole', 'roles', roles, t('filter.role'));
  const fill = (id, opts, placeholder, current) => {
    const sel = $(id); if (!sel) return;
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      opts.map(o => `<option value="${esc(String(o.id != null ? o.id : o))}"${String(current) === String(o.id != null ? o.id : o) ? ' selected' : ''}>${esc(o.name != null ? o.name : o)}</option>`).join('');
  };
  fill('filterProject', projects, t('filter.project'), filters.projectId);
  fill('filterOwner', owners, t('filter.owner'), filters.owner);
  const hint = $('filterHint');
  if (hint) hint.textContent = hasActiveFilters() ? t('filter.active') : '';
}

// ── 撤销 Toast（F1.4）──
export function undoToast(label) {
  let el = $('toast');
  el.innerHTML = '';
  el.appendChild(document.createTextNode(label + ' · '));
  const a = document.createElement('a');
  a.textContent = t('undo.link');
  a.className = 'toast-action';
  a.href = 'javascript:void(0)';
  a.onclick = async (e) => { e.preventDefault(); el.classList.remove('show'); clearTimeout(el._timer); await undoLast(); if (window._undoRefresh) await window._undoRefresh(); };
  el.appendChild(a);
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 4500);
}

// ── 设置面板 ──
function settingsNav() {
  const tabs = [['people', t('settings.navPeople')], ['projects', t('settings.navProjects')], ['milestones', t('settings.navMilestones')], ['data', t('settings.navData')]];
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
    content = `<div class="settings-layout"><div class="panel"><h3>${t('settings.people')}</h3><button data-add-person>${t('settings.addPerson')}</button><br><br>${state.people.map(p =>
      `<div class="item" style="${p.archived ? 'opacity:.5' : ''}"><div>${esc(p.name)}${p.archived ? ` <b style="color:var(--red)">${t('settings.archivedTag')}</b>` : ''}<br><small>${esc(t('settings.personMeta', { dept: p.department, role: p.role, cap: p.dailyCapacity }))}</small></div><div class="actions"><button class="mini" data-edit-person="${p.id}">${t('action.edit')}</button><button class="mini danger" data-delete-person="${p.id}">${t('action.deleteShort')}</button></div></div>`
    ).join('') || `<div class="empty">${t('empty.people')}</div>`}</div></div>`;
  }

  if (settingsTab === 'projects') {
    content = `<div class="settings-layout"><div class="panel"><h3>${t('settings.projects')}</h3><button data-add-project>${t('settings.addProject')}</button><br><br>${state.projects.map(p => {
      const d = p.startDate ? ` · ${p.startDate}${p.endDate ? '~' + p.endDate : ''}` : '';
      return `<div class="item" style="${p.archived ? 'opacity:.5' : ''}"><div><span class="dot" style="background:${projectColor(p)}"></span>${esc(p.name)}${p.archived ? ` <b style="color:var(--red)">${t('settings.archivedTag')}</b>` : ''}<br><small>${esc(p.owner || '')} · ${esc(PRI_LABEL(p.priority))}${d}</small></div><div class="actions"><button class="mini" data-edit-project="${p.id}">${t('action.edit')}</button><button class="mini danger" data-delete-project="${p.id}">${t('action.deleteShort')}</button></div></div>`;
    }).join('') || `<div class="empty">${t('empty.projects')}</div>`}</div></div>`;
  }

  if (settingsTab === 'milestones') {
    content = `<div class="settings-layout"><div class="panel"><h3>${t('settings.milestones')}</h3><button data-add-milestone>${t('settings.addMilestone')}</button><br><br>${state.milestones.map(m => {
      let pr = project(m.projectId) || {};
      return `<div class="item"><div><span class="dot" style="background:${pr.color || '#ffd86b'}"></span>${esc(m.name)}<br><small>${m.date} · ${esc(pr.name || t('resource.projDeleted'))} · ${LEVEL_LABEL(m.level)}</small></div><div class="actions"><button class="mini" data-edit-milestone="${m.id}">${t('action.edit')}</button><button class="mini danger" data-delete-milestone="${m.id}">${t('action.deleteShort')}</button></div></div>`;
    }).join('') || `<div class="empty">${t('empty.milestones')}</div>`}</div></div>`;
  }

  if (settingsTab === 'data') {
    content = `<div class="settings-layout"><div class="panel"><h3>${t('settings.data')}</h3><div class="panel-actions"><button data-export-csv>${t('btn.exportCsv')}</button><button data-import-csv>${t('btn.importCsv')}</button><button class="danger" data-reset-data>${t('btn.resetData')}</button></div><p class="hint">${t('data.hint')}</p><div class="empty" style="margin-top:12px">${t('data.strategy')}</div></div></div>`;
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
    if (!r.ok) throw new Error(data.error || t('toast.importFailed'));
    await reloadAll();
    toast(t('toast.importSummary', { a: data.createdAssignments, ma: data.mergedAssignments || 0, ms: data.createdMilestones || 0, mms: data.mergedMilestones || 0, p: data.createdPeople, pr: data.createdProjects, s: data.skipped }));
  } catch (e) {
    toast(e.message);
  } finally {
    input.value = '';
  }
}

export async function resetData(nativeActionSender = null) {
  if (nativeActionSender && nativeActionSender('resetData')) return;
  if (!confirm(t('confirm.reset'))) return;
  const second = window.prompt(t('confirm.resetPrompt'), '');
  if (second !== 'RESET') {
    toast(t('toast.resetCancelled'));
    return;
  }
  await api('/api/reset', { method: 'POST' });
  await reloadAll();
  toast(t('toast.resetDone'));
}

// ── 重新加载（供面板模块内部使用） ──
let _renderAll = null;
export function setRenderAll(fn) { _renderAll = fn; }
async function reloadAll() { if (_renderAll) await load(_renderAll); }

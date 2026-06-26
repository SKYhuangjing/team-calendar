// interactions.js — 拖拽（HTML5 drag + pointer move/resize）、键盘、右键菜单

import {
  $, state, esc,
  endOf,
  dayDiff, addDaysIso, shiftRange, workingDays,
  selectedBarId, selectedMilestoneId, selectedGroupId,
  setSelectedBarId, setSelectedMilestoneId, setSelectedGroupId,
  selectRequirement,
  projectScheduleMode,
  isReadOnlyMode,
  pushUndo, setConflictHighlight, conflictHighlight,
  setSearchQ, setFilter, clearFilters, filters, activeTab,
  canUndo, undoLast,
  isConflictCell, planReduceToCapacity, planSpreadToAdjacent,
  person, project, personColor, projectColor, fteOf, milestoneStatus, assignmentGroup,
  setSettingsActiveTeam
} from './state.js';
import { post, put, del, load, deletePerson, deleteProject, deleteAssignment, deleteMilestone } from './api.js';
import { dateFromContentX, barStyle } from './calendar.js';
import {
  toast, closeModal, closeDrawer, openPerson, openProject, openMilestone,
  openAddMilestone, setResourceTab, setSettingsTab, importCsv, resetData,
  undoToast, showBreakdown, closeBreakdown, openTeam, deleteTeam,
  renderSettings, openMilestoneManager, openTeamLoan, openPersonTeamAction,
  openRequirementEditor, openRequirementScheduleEditor, deleteRequirement, openRegroupPicker, openAssignmentForm, openAssignToRequirement
} from './panels.js';
import { t } from './i18n.js';

// ── 项目日期范围检查 ──
export function checkProjectRange(projectId, sd, ed) {
  const proj = state.projects.find(x => x.id === projectId);
  if (proj && proj.startDate && sd < proj.startDate) return t('toast.assignStartBefore') + proj.startDate;
  if (proj && proj.endDate && ed > proj.endDate) return t('toast.assignEndAfter') + proj.endDate;
  return null;
}

// ── HTML5 拖拽：设置拖拽数据 ──
function setDrag(e, data) {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/json', JSON.stringify(data));
  e.dataTransfer.setData('text/plain', JSON.stringify(data));
}

function readDrop(e) {
  try {
    return JSON.parse(e.dataTransfer.getData('application/json') || e.dataTransfer.getData('text/plain') || '{}');
  } catch (_) { return {}; }
}

function allowDrop(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drop');
}

function postNativeAppAction(action) {
  const handler = window.webkit?.messageHandlers?.teamCalendar;
  if (!handler) return false;
  try {
    handler.postMessage({ action });
    return true;
  } catch (_) {
    return false;
  }
}

// ── HTML5 拖拽：投放处理 ──
async function dropOnCell(e, view, rowId, date) {
  e.preventDefault();
  e.currentTarget.classList.remove('drop');
  let data = readDrop(e);

  if (data.type === 'person') {
    let projectId = view === 'project' ? rowId : state.projects[0]?.id;
    if (!projectId) return toast(t('toast.needProject'));
    const err = checkProjectRange(projectId, date, date);
    if (err) return toast(err);
    await post('/api/assignments', { personId: data.id, projectId, groupId: '', date, endDate: date, hours: 8, note: '' });
  } else if (data.type === 'project') {
    let personId = view === 'person' ? rowId : state.people[0]?.id;
    if (!personId) return toast(t('toast.needPerson'));
    const err = checkProjectRange(data.id, date, date);
    if (err) return toast(err);
    await post('/api/assignments', { personId, projectId: data.id, groupId: '', date, endDate: date, hours: 8, note: '' });
  } else if (data.type === 'assignment') {
    let a = { ...state.assignments.find(x => x.id === data.id) };
    if (!a.id) return;
    const originalProjectId = a.projectId;
    if (view === 'person') a.personId = rowId; else a.projectId = rowId;
    if (a.projectId !== originalProjectId) a.groupId = '';
    let targetStart = date;
    if (Number.isFinite(Number(data.barLeftInScheduler)) && Number.isFinite(Number(data.startClientX))) {
      const movedLeft = Number(data.barLeftInScheduler) + (e.clientX - Number(data.startClientX));
      targetStart = dateFromContentX(movedLeft);
    }
    let shifted = shiftRange(a, targetStart);
    a.date = shifted.date;
    a.endDate = shifted.endDate;
    const err = checkProjectRange(a.projectId, a.date, endOf(a));
    if (err) return toast(err);
    await put('/api/assignments/' + a.id, a);
  } else if (data.type === 'milestone') {
    let m = { ...state.milestones.find(x => x.id === data.id) };
    if (view === 'project') m.projectId = rowId;
    m.date = date;
    await put('/api/milestones/' + m.id, m);
  }

  await load(renderAll);
}

// ── 拖拽提示 ──
function showDragTip(text, x, y) {
  let tip = $('dragTip');
  tip.textContent = text;
  tip.style.left = (x + 12) + 'px';
  tip.style.top = (y + 12) + 'px';
  tip.style.display = 'block';
}

function hideDragTip() {
  $('dragTip').style.display = 'none';
}

// ── 自定义悬浮提示（任务条 / 里程碑）：替代原生 title ──
// 悬浮 ~80ms 后出现（比原生 title 快得多），内容按数据结构化呈现；
// 位置以目标元素为锚、避开视口边缘；拖拽 / 滚动 / 重渲染时立即隐藏。
let tipEl = null;
let tipTimer = null;
let tipHoverEl = null;
const TIP_DELAY = 80;

function tipNode() {
  if (!tipEl) tipEl = $('rcTooltip');
  return tipEl;
}

export function hideTooltip() {
  if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
  const el = tipNode();
  if (el && el.classList.contains('show')) {
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
  }
}

function scheduleTooltip(el) {
  if (tipTimer) clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    tipTimer = null;
    if (tipHoverEl === el && el.isConnected) renderTooltip(el);
  }, TIP_DELAY);
}

function assignmentTipHTML(el, a) {
  const view = activeTab === 'people' ? 'person' : 'project';
  const p = person(a.personId) || {};
  const pr = project(a.projectId) || {};
  const primary = view === 'person' ? (pr.name || t('cal.unnamed')) : (p.name || t('cal.unnamed'));
  const secondary = view === 'person' ? (p.name || '') : (pr.name || '');
  const dot = view === 'person' ? projectColor(pr) : personColor(p);
  const end = endOf(a);
  const wd = workingDays(a.date, end);
  const fte = Math.round(fteOf(a) * 100);
  const over = el.classList.contains('over');
  const group = assignmentGroup(a.groupId);

  let html = `<div class="rc-tip-accent" style="background:${dot}"></div><div class="rc-tip-body">`;
  html += `<div class="rc-tip-title"><span class="rc-tip-dot" style="background:${dot}"></span><span class="rc-tip-name">${esc(primary)}</span>`;
  html += `<span class="rc-tip-badges"><span class="rc-tip-badge">${esc(t('tip.fte'))} ${fte}%</span>${over ? `<span class="rc-tip-badge over">${esc(t('tip.over'))}</span>` : ''}</span></div>`;
  if (secondary) html += `<div class="rc-tip-sub">${esc(secondary)}</div>`;
  if (group) html += `<div class="rc-tip-sub">${esc(t('label.assignmentGroup'))}：${esc(group.name)}</div>`;
  html += `<div class="rc-tip-row"><b>${esc(a.date)}</b><span class="rc-tip-arrow">→</span><b>${esc(end)}</b><span class="rc-tip-wd">${esc(t('drag.workdays', { n: wd }))}</span></div>`;
  if (a.note) html += `<div class="rc-tip-note"><span class="rc-tip-note-k">${esc(t('tip.note'))}</span><span>${esc(a.note)}</span></div>`;
  html += `</div>`;
  return html;
}

function parentTaskTipHTML(el) {
  const projectId = el.dataset.projectId;
  const groupId = el.dataset.groupId || '';
  const group = assignmentGroup(groupId);
  const parentName = group ? group.name : t('task.ungrouped');
  const assigns = state.assignments
    .filter(a => String(a.projectId) === String(projectId) && String(a.groupId || '') === String(groupId))
    .sort((a, b) => a.date.localeCompare(b.date) || endOf(a).localeCompare(endOf(b)) || String(a.personId).localeCompare(String(b.personId)));
  const pr = project(projectId) || {};
  const accent = (group && group.color) || projectColor(pr);
  const start = assigns.reduce((min, a) => !min || a.date < min ? a.date : min, '');
  const end = assigns.reduce((max, a) => endOf(a) > max ? endOf(a) : max, '');
  const people = [...new Set(assigns.map(a => person(a.personId)?.name).filter(Boolean))];
  const totalHours = assigns.reduce((s, a) => s + Number(a.hours || 0) * workingDays(a.date, endOf(a)), 0);

  let html = `<div class="rc-tip-accent" style="background:${accent}"></div><div class="rc-tip-body">`;
  html += `<div class="rc-tip-title"><span class="rc-tip-dot" style="background:${accent}"></span><span class="rc-tip-name">${esc(parentName || t('task.noParent'))}</span>`;
  html += `<span class="rc-tip-badges"><span class="rc-tip-badge">${esc(t('tip.children'))} ${assigns.length}</span></span></div>`;
  if (pr.name) html += `<div class="rc-tip-sub">${esc(pr.name)}</div>`;
  if (start && end) html += `<div class="rc-tip-row"><b>${esc(start)}</b><span class="rc-tip-arrow">→</span><b>${esc(end)}</b><span class="rc-tip-wd">${esc(t('tip.totalHours', { n: totalHours }))}</span></div>`;
  if (people.length) html += `<div class="rc-tip-note"><span class="rc-tip-note-k">${esc(t('tip.participants'))}</span><span>${esc(people.join('、'))}</span></div>`;
  if (assigns.length) {
    html += `<div class="rc-tip-children">`;
    assigns.forEach(a => {
      const p = person(a.personId) || {};
      const fte = Math.round(fteOf(a) * 100);
      html += `<div class="rc-tip-child"><span>${esc(p.name || t('cal.unnamed'))}</span><b>${esc(a.date)} ~ ${esc(endOf(a))}</b><em>${esc(t('tip.fte'))} ${fte}%</em></div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

function milestoneTipHTML(el, m) {
  const st = milestoneStatus(m.date);
  let badge = '';
  if (st.state === 'past') badge = `<span class="rc-tip-badge">${esc(t('tip.msPast', { n: st.days }))}</span>`;
  else if (st.state === 'upcoming') badge = `<span class="rc-tip-badge warn">${esc(st.days === 0 ? t('tip.today') : t('tip.msLeft', { n: st.days }))}</span>`;
  const accent = m.level === 'risk' ? 'var(--red)' : 'var(--accent)';

  let html = `<div class="rc-tip-accent" style="background:${accent}"></div><div class="rc-tip-body">`;
  html += `<div class="rc-tip-title"><span class="rc-tip-mark" style="color:${accent}">◆</span><span class="rc-tip-name">${esc(m.name || '')}</span>${badge ? `<span class="rc-tip-badges">${badge}</span>` : ''}</div>`;
  html += `<div class="rc-tip-row"><b>${esc(m.date)}</b></div>`;
  if (m.owner) html += `<div class="rc-tip-sub">${esc(t('tip.owner'))}：${esc(m.owner)}</div>`;
  if (m.description) html += `<div class="rc-tip-note"><span class="rc-tip-note-k">${esc(t('tip.desc'))}</span><span>${esc(m.description)}</span></div>`;
  html += `</div>`;
  return html;
}

function renderTooltip(el) {
  const tip = tipNode();
  if (!tip) return;
  if (el.classList.contains('milestone')) {
    const m = state.milestones.find(x => String(x.id) === String(el.dataset.msId));
    if (!m) { hideTooltip(); return; }
    tip.innerHTML = milestoneTipHTML(el, m);
  } else if (el.classList.contains('parent-task')) {
    tip.innerHTML = parentTaskTipHTML(el);
  } else {
    const a = state.assignments.find(x => String(x.id) === String(el.dataset.assignId));
    if (!a) { hideTooltip(); return; }
    tip.innerHTML = assignmentTipHTML(el, a);
  }
  // 先隐藏可见性再定位，避免首帧出现在旧坐标上闪烁
  tip.style.visibility = 'hidden';
  tip.classList.add('show');
  positionTooltip(tip, el.getBoundingClientRect());
  tip.style.visibility = '';
  tip.setAttribute('aria-hidden', 'false');
}

function positionTooltip(tip, rect) {
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const gap = 10, pad = 8;
  const vw = window.innerWidth, vh = window.innerHeight;
  // 水平：与元素左对齐，溢出右边界则改为右对齐，仍溢出则夹紧
  let x = rect.left;
  if (x + tw > vw - pad) x = Math.max(pad, rect.right - tw);
  if (x < pad) x = pad;
  // 垂直：优先在元素上方，空间不足则移到下方，仍不足则夹紧到视口内
  let y = rect.top - th - gap;
  if (y < pad) y = rect.bottom + gap;
  if (y + th > vh - pad) y = Math.max(pad, vh - th - pad);
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

// ── Pointer 移动：拖拽任务条主体 ──
let movingAssignment = null;

function cellDateAtX(clientX) {
  const r = $('scheduler').getBoundingClientRect();
  return dateFromContentX(clientX - r.left);
}

function startMoveAssignment(e, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const a = state.assignments.find(x => x.id === id);
  if (!a) return;
  const bar = $('bar_' + id);
  if (!bar) return;
  movingAssignment = {
    id, original: { ...a },
    startClientX: e.clientX, startClientY: e.clientY,
    startBarLeft: parseFloat(bar.style.left) || bar.offsetLeft,
    startBarTop: parseFloat(bar.style.top) || bar.offsetTop,
    startCellDate: cellDateAtX(e.clientX),
    active: false
  };
  window.addEventListener('pointermove', onMoveAssignmentMove);
  window.addEventListener('pointerup', finishMoveAssignment, { once: true });
}

function onMoveAssignmentMove(e) {
  if (!movingAssignment) return;
  const m = movingAssignment, dx = e.clientX - m.startClientX, dy = e.clientY - m.startClientY;
  if (!m.active) {
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    m.active = true;
    const bar = $('bar_' + m.id);
    if (bar) { bar.classList.add('resizing'); bar.style.zIndex = 100; bar.style.pointerEvents = 'none'; }
    document.body.style.cursor = 'grabbing';
  }
  const bar = $('bar_' + m.id);
  if (!bar) return;
  bar.style.left = (m.startBarLeft + dx) + 'px';
  bar.style.top = (m.startBarTop + dy) + 'px';

  const offset = dayDiff(m.startCellDate, cellDateAtX(e.clientX));
  const ns = addDaysIso(m.original.date, offset);
  const ne = addDaysIso(endOf(m.original), offset);
  showDragTip(`${ns.slice(5)} ~ ${ne.slice(5)} (${t('drag.workdays', { n: workingDays(ns, ne) })})`, e.clientX, e.clientY);

  document.querySelectorAll('.cell.drop').forEach(c => c.classList.remove('drop'));
  const hitEl = document.elementFromPoint(e.clientX, e.clientY);
  if (hitEl) {
    const cell = hitEl.closest('.cell');
    if (cell) cell.classList.add('drop');
  }
}

async function finishMoveAssignment(e) {
  window.removeEventListener('pointermove', onMoveAssignmentMove);
  const m = movingAssignment;
  movingAssignment = null;
  hideDragTip();
  document.querySelectorAll('.cell.drop').forEach(c => c.classList.remove('drop'));
  if (!m) return;

  let targetRow = null;
  if (m.active) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el) {
      const rowEl = el.closest('.row:not(.header)');
      if (rowEl && rowEl.dataset.view && rowEl.dataset.rowId) targetRow = rowEl;
    }
  }

  const bar = $('bar_' + m.id);
  if (bar) { bar.classList.remove('resizing'); bar.style.zIndex = ''; bar.style.pointerEvents = ''; }
  document.body.style.cursor = '';

  if (!m.active) { selectBar(m.id); return; }

  const offset = dayDiff(m.startCellDate, cellDateAtX(e.clientX));
  const a = { ...m.original, date: addDaysIso(m.original.date, offset), endDate: addDaysIso(endOf(m.original), offset) };
  const originalProjectId = a.projectId;
  if (targetRow) {
    if (targetRow.dataset.view === 'person') a.personId = targetRow.dataset.rowId;
    else a.projectId = targetRow.dataset.rowId;
  }
  if (a.projectId !== originalProjectId) a.groupId = '';
  const err = checkProjectRange(a.projectId, a.date, endOf(a));
  if (err) { await load(renderAll); return toast(err); }
  const before = m.original;
  await put('/api/assignments/' + a.id, a);
  pushUndo({ label: t('undo.moved'), run: async () => { await put('/api/assignments/' + before.id, before); await load(renderAll); } });
  await load(renderAll);
  undoToast(t('undo.moved'));
}

// ── Pointer 缩放：拖拽边缘调整日期范围 ──
let resizingAssignment = null;

function startResizeAssignment(e, id, side) {
  e.preventDefault();
  e.stopPropagation();
  const a = state.assignments.find(x => x.id === id);
  if (!a) return;
  const barEl = $('bar_' + id);
  const stackIndex = barEl ? Math.round((parseFloat(barEl.style.top) || 0) / 36) : 0;
  resizingAssignment = { id, side, original: { ...a }, next: { ...a }, stackIndex };
  if (barEl) barEl.classList.add('resizing');
  window.addEventListener('pointermove', onResizeAssignmentMove);
  window.addEventListener('pointerup', finishResizeAssignment, { once: true });
  onResizeAssignmentMove(e);
}

function onResizeAssignmentMove(e) {
  if (!resizingAssignment) return;
  const rect = $('scheduler').getBoundingClientRect();
  const d = dateFromContentX(e.clientX - rect.left);
  const a = { ...resizingAssignment.original };
  if (resizingAssignment.side === 'left') {
    a.date = d <= endOf(a) ? d : endOf(a);
  } else {
    a.endDate = d >= a.date ? d : a.date;
  }
  resizingAssignment.next = a;
  const el = $('bar_' + a.id);
  if (el) el.style.cssText = el.style.cssText.replace(/left:[^;]+;width:[^;]+;/, '') + barStyle(a, resizingAssignment.stackIndex);
  showDragTip(`${a.date} ~ ${endOf(a)}`, e.clientX, e.clientY);
}

async function finishResizeAssignment(e) {
  window.removeEventListener('pointermove', onResizeAssignmentMove);
  const r = resizingAssignment;
  resizingAssignment = null;
  hideDragTip();
  if (!r) return;
  const el = $('bar_' + r.id);
  if (el) el.classList.remove('resizing');
  const a = r.next;
  const err = checkProjectRange(a.projectId, a.date, endOf(a));
  if (err) { await load(renderAll); return toast(err); }
  const before = r.original;
  await put('/api/assignments/' + a.id, a);
  pushUndo({ label: t('undo.resized'), run: async () => { await put('/api/assignments/' + before.id, before); await load(renderAll); } });
  await load(renderAll);
  undoToast(t('undo.resized'));
}

// ── Pointer 移动：拖拽里程碑 ──
let movingMilestone = null;

function startMoveMilestone(e, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const m = state.milestones.find(x => x.id === id);
  if (!m) return;
  const el = $('ms_' + id);
  if (!el) return;
  movingMilestone = {
    id, original: { ...m },
    startClientX: e.clientX, startClientY: e.clientY,
    startCellDate: cellDateAtX(e.clientX),
    active: false
  };
  window.addEventListener('pointermove', onMoveMilestoneMove);
  window.addEventListener('pointerup', finishMoveMilestone, { once: true });
}

function onMoveMilestoneMove(e) {
  if (!movingMilestone) return;
  const m = movingMilestone, dx = e.clientX - m.startClientX, dy = e.clientY - m.startClientY;
  if (!m.active) {
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    m.active = true;
    const el = $('ms_' + m.id);
    if (el) { el.classList.add('dragging'); el.style.pointerEvents = 'none'; }
    document.body.style.cursor = 'grabbing';
  }

  // 移动里程碑元素跟随鼠标
  const el = $('ms_' + m.id);
  if (el) {
    const ox = el._dragOriginX ?? (el._dragOriginX = parseFloat(el.style.left) || el.offsetLeft);
    const oy = el._dragOriginY ?? (el._dragOriginY = parseFloat(el.style.top) || el.offsetTop);
    el.style.position = 'absolute';
    el.style.left = (ox + dx) + 'px';
    el.style.top = (oy + dy) + 'px';
    el.style.zIndex = 100;
  }

  const newDate = cellDateAtX(e.clientX);
  showDragTip(`${newDate.slice(5)}（${m.original.name}）`, e.clientX, e.clientY);

  document.querySelectorAll('.cell.drop').forEach(c => c.classList.remove('drop'));
  const hitEl = document.elementFromPoint(e.clientX, e.clientY);
  if (hitEl) {
    const cell = hitEl.closest('.cell');
    if (cell) cell.classList.add('drop');
  }
}

async function finishMoveMilestone(e) {
  window.removeEventListener('pointermove', onMoveMilestoneMove);
  const m = movingMilestone;
  movingMilestone = null;
  hideDragTip();
  document.querySelectorAll('.cell.drop').forEach(c => c.classList.remove('drop'));
  document.body.style.cursor = '';
  if (!m) return;

  // 清理拖拽样式
  const el = $('ms_' + m.id);
  if (el) {
    el.classList.remove('dragging');
    el.style.position = '';
    el.style.left = '';
    el.style.top = '';
    el.style.zIndex = '';
    el.style.pointerEvents = '';
    delete el._dragOriginX;
    delete el._dragOriginY;
  }

  if (!m.active) { selectMilestone(m.id); return; }

  const newDate = cellDateAtX(e.clientX);
  const ms = { ...m.original, date: newDate };

  // 检测目标行（支持跨行拖拽，切换项目）
  const hitEl = document.elementFromPoint(e.clientX, e.clientY);
  if (hitEl) {
    const rowEl = hitEl.closest('.row:not(.header)');
    if (rowEl && rowEl.dataset.view === 'project') {
      ms.projectId = rowEl.dataset.rowId;
    }
  }

  await put('/api/milestones/' + ms.id, ms);
  const before = m.original;
  pushUndo({ label: t('undo.movedMilestone'), run: async () => { await put('/api/milestones/' + before.id, before); await load(renderAll); } });
  await load(renderAll);
  undoToast(t('undo.movedMilestone'));
}

// ── 选择 ──
export function selectBar(id) {
  document.querySelectorAll('.assign.bar.selected').forEach(el => el.classList.remove('selected'));
  setSelectedBarId(id);
  if (id) {
    setSelectedMilestoneId(null);
    document.querySelectorAll('.milestone.selected').forEach(el => el.classList.remove('selected'));
    const el = $('bar_' + id);
    if (el) { el.classList.add('selected'); try { el.focus({ preventScroll: true }); } catch (_) { /* 非可聚焦时忽略 */ } }
  }
}

export function selectMilestone(id) {
  document.querySelectorAll('.milestone.selected').forEach(el => el.classList.remove('selected'));
  setSelectedMilestoneId(id);
  if (id) {
    setSelectedBarId(null);
    document.querySelectorAll('.assign.bar.selected').forEach(el => el.classList.remove('selected'));
    const el = $('ms_' + id);
    if (el) { el.classList.add('selected'); try { el.focus({ preventScroll: true }); } catch (_) { /* 非可聚焦时忽略 */ } }
  }
}

// ── 资源排序（拖拽重排） ──
let reordering = null;
let dragScrollInterval = null;

function startReorder(e, entity, id) {
  e.preventDefault();
  e.stopPropagation();
  const el = e.target.closest('.item, .compact-row, .team-tab');
  if (!el) return;
  const container = el.parentElement;
  if (!container) return;
  reordering = { entity, id, startX: e.clientX, startY: e.clientY, active: false, el, container };
  window.addEventListener('pointermove', onReorderMove);
  window.addEventListener('pointerup', finishReorder, { once: true });
}

function onReorderMove(e) {
  if (!reordering) return;
  // 激活阈值：横向（团队 Tab / 卡片网格）看 X，纵向（资源抽屉列表）看 Y
  const dx = Math.abs(e.clientX - reordering.startX);
  const dy = Math.abs(e.clientY - reordering.startY);
  if (!reordering.active && dx < 5 && dy < 5) return;
  if (!reordering.active) { reordering.active = true; reordering.el.classList.add('dragging'); }
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (!hit) return;
  const targetItem = hit.closest('.item, .compact-row, .team-tab');
  if (!targetItem || targetItem === reordering.el || targetItem.parentElement !== reordering.container) return;
  const rect = targetItem.getBoundingClientRect();
  // 网格/多列（窄项）按水平中线决定前/后；单列全宽列表按垂直中线
  const horizontal = rect.width * 2 <= reordering.container.clientWidth;
  const before = horizontal ? (e.clientX < rect.left + rect.width / 2) : (e.clientY < rect.top + rect.height / 2);
  if (before) targetItem.before(reordering.el);
  else targetItem.after(reordering.el);
}

async function finishReorder(e) {
  window.removeEventListener('pointermove', onReorderMove);
  const r = reordering;
  reordering = null;
  if (!r) return;
  r.el.classList.remove('dragging');
  if (!r.active) return;

  let items = [];
  if (r.entity === 'teams') {
    items = [...r.container.querySelectorAll('.team-tab:not(.add-tab)')];
  } else {
    items = [...r.container.querySelectorAll('.item, .compact-row')];
  }
  const ids = items.map(el => el.dataset.id || el.dataset.teamId).filter(Boolean);
  if (!ids.length) return;
  try {
    await put('/api/sort', { table: r.entity, ids });
    await load(renderAll);
    toast(t('toast.sorted'));
  } catch (err) { toast(t('toast.sortFailed') + err.message); }
}

// ── 右键菜单图标（统一描边风 SVG，currentColor）──
const _ctxIcons = {
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  'folder-in': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
  scale: '<line x1="12" y1="3" x2="12" y2="21"/><line x1="7" y1="21" x2="17" y2="21"/><line x1="4" y1="8" x2="20" y2="8"/><path d="M4 8 L1.5 14 a2.5 2.5 0 0 0 5 0 Z"/><path d="M20 8 L17.5 14 a2.5 2.5 0 0 0 5 0 Z"/>',
  spread: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>'
};
function ctxIcon(name) {
  const inner = _ctxIcons[name];
  if (!inner) return '';
  return `<svg class="ctx-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// ── 右键菜单 ──
// view: 'person' | 'project' | 'parentTask'（需求块专属，§6.3）| 'taskBar'（任务条专属，任务视图）
// rowId: 'person'→personId / 'project'→projectId / 'parentTask'→{groupId, projectId, date} / 'taskBar'→assignmentId
function showCtxMenu(e, view, rowId, date) {
  e.preventDefault();
  e.stopPropagation();
  const menu = $('ctxMenu');
  let items = [];
  if (view === 'parentTask') {
    // 需求块右键（§6.3，M2）。rowId = {groupId, projectId, date}
    const { groupId, projectId, date: ptDate } = rowId || {};
    if (groupId) {
      // 命名/空需求块：批量编辑排期 / 编辑需求 / 删除需求
      items.push({ label: t('ctx.editRequirementSchedule'), icon: 'pencil', action: () => openRequirementScheduleEditor(groupId, projectId, { date: ptDate }) });
      items.push({ label: t('ctx.editRequirement'), icon: 'pencil', action: () => openRequirementEditor(groupId, projectId) });
      items.push({ sep: true });
      items.push({ label: t('ctx.deleteRequirement'), icon: 'trash', action: () => deleteRequirement(groupId) });
    } else {
      // 未归组块（收件箱）：将子任务归入需求…
      items.push({ label: t('ctx.regroupChildren'), icon: 'folder-in', action: () => openRegroupPicker(projectId) });
    }
  } else if (view === 'taskBar') {
    // 任务条右键（任务视图）：归属到需求 / 编辑排期 / 删除排期。rowId = assignmentId
    const id = rowId;
    const a = state.assignments.find(x => x.id === id);
    if (!a) return; // 排期已不存在，不弹菜单
    items.push({ label: t('ctx.assignToRequirement'), icon: 'folder-in', action: () => openAssignToRequirement(id) });
    items.push({ label: t('ctx.editAssign'), icon: 'pencil', action: () => openAssignmentForm({ mode: 'task', id }) });
    items.push({ sep: true });
    items.push({ label: t('ctx.deleteAssign'), icon: 'trash', action: () => deleteAssignment(id, false, renderAll) });
  } else if (view === 'person') {
    // F2.5：右键冲突格提供解决动作（仅人员视图、仅当日超产能时）
    if (isConflictCell(rowId, date)) {
      items.push({ label: t('ctx.reduce'), icon: 'scale', action: () => resolveConflictReduce(rowId, date) });
      if (planSpreadToAdjacent(rowId, date)) {
        items.push({ label: t('ctx.spread'), icon: 'spread', action: () => resolveConflictSpread(rowId, date) });
      }
      items.push({ sep: true });
    }
    items.push({ label: t('ctx.addAssignProject'), icon: 'plus', action: () => openAssignmentForm({ mode: 'task', personId: rowId, date }) });
    items.push({ label: t('ctx.addMilestone'), icon: 'flag', action: () => openAddMilestone(null, date) });
  } else {
    // project 视图：随 projectScheduleMode 切语义（§6.4，W6）
    // 需求视图（parentTasks）→ 新建需求；任务视图 → 排期到人员（mode:'task'）。
    if (projectScheduleMode === 'parentTasks') {
      items.push({ label: t('ctx.addAssignRequirement'), icon: 'plus', action: () => openRequirementEditor('', rowId, { date }) });
    } else {
      items.push({ label: t('ctx.addAssignPerson'), icon: 'plus', action: () => openAssignmentForm({ mode: 'task', projectId: rowId, date }) });
    }
    items.push({ label: t('ctx.addMilestone'), icon: 'flag', action: () => openAddMilestone(rowId, date) });
  }
  menu.innerHTML = items.map((it, i) => it.sep
    ? '<div class="sep"></div>'
    : `<div class="ctx-item" data-idx="${i}"><span class="ctx-icon">${ctxIcon(it.icon)}</span><span class="ctx-label">${it.label}</span></div>`).join('');
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  menu.onclick = function (ev) {
    // 图标/文案都在 .ctx-item 内部：用 closest 命中 data-idx，避免点到 <span> 时 idx 丢失。
    const item = ev.target.closest('[data-idx]');
    const idx = item ? item.dataset.idx : undefined;
    if (idx !== undefined && items[idx] && !items[idx].sep) { items[idx].action(); menu.style.display = 'none'; }
  };
}

// ── 冲突解决（F2.5）：应用计划 + 撤销快照 ──
// plan.ops = [{deleteId, create:[payload...]}]；先删后建；撤销 = 删新建 + 恢复被删原值
// 健壮性：新建 id 在创建时即时捕获（不依赖 load 后 diff）；apply 中途失败做 best-effort 回滚；
//        undo 的删除/恢复逐条 try/catch 隔离，单条失败不阻断其余，避免不可逆的部分丢数据。
async function applyConflictPlan(plan, label) {
  const before = plan.ops.filter(o => o.deleteId).map(o => {
    const orig = state.assignments.find(a => a.id === o.deleteId);
    return orig ? { ...orig } : null;
  }).filter(Boolean);
  const createdIds = []; // 本次新建 id（创建时捕获）
  try {
    for (const op of plan.ops) {
      if (op.deleteId) await del('/api/assignments/' + op.deleteId);
      for (const payload of op.create) {
        const r = await post('/api/assignments', payload);
        if (r && r.id) createdIds.push(r.id);
      }
    }
  } catch (err) {
    // apply 中途失败：删除已新建分片、恢复已删除原值，尽量回到操作前状态
    for (const id of createdIds) { try { await del('/api/assignments/' + id); } catch (_) { /* ignore */ } }
    for (const a of before) { try { await post('/api/assignments', { personId: a.personId, projectId: a.projectId, groupId: a.groupId || '', date: a.date, endDate: a.endDate, hours: a.hours, note: a.note }); } catch (_) { /* ignore */ } }
    await load(renderAll);
    throw err;
  }
  await load(renderAll);
  pushUndo({
    label,
    run: async () => {
      for (const id of createdIds) { try { await del('/api/assignments/' + id); } catch (_) { /* 可能已被其它操作删除 */ } }
      for (const a of before) { try { await post('/api/assignments', { personId: a.personId, projectId: a.projectId, groupId: a.groupId || '', date: a.date, endDate: a.endDate, hours: a.hours, note: a.note }); } catch (_) { /* 尽量恢复 */ } }
      await load(renderAll);
    }
  });
  undoToast(label);
}

async function resolveConflictReduce(pid, date) {
  const plan = planReduceToCapacity(pid, date);
  if (!plan.ops.length) return toast(t('toast.noConflict'));
  try {
    await applyConflictPlan(plan, t('undo.reduced'));
  } catch (err) { await load(renderAll); toast(t('toast.resolveFailed') + err.message); }
}

async function resolveConflictSpread(pid, date) {
  const plan = planSpreadToAdjacent(pid, date);
  if (!plan) return toast(t('toast.noSpreadTarget'));
  try {
    await applyConflictPlan(plan, t('undo.spread') + plan.targetDate.slice(5));
  } catch (err) { await load(renderAll); toast(t('toast.resolveFailed') + err.message); }
}

// ── 归档恢复（取消归档；保留姓名/部门/角色/产能/团队归属，仅置 archived=0）──
async function restoreArchived(kind, id) {
  if (!id) return;
  try {
    if (kind === 'person') {
      const p = person(id);
      if (!p) return;
      await put('/api/people/' + id, { name: p.name, department: p.department, role: p.role, dailyCapacity: p.dailyCapacity, color: p.color, homeTeamId: p.homeTeamId, archived: 0 });
    } else if (kind === 'project') {
      const pr = project(id);
      if (!pr) return;
      await put('/api/projects/' + id, { name: pr.name, ownerId: pr.ownerId, priority: pr.priority, color: pr.color, startDate: pr.startDate, endDate: pr.endDate, teamId: pr.teamId, archived: 0 });
    } else if (kind === 'team-loan') {
      const l = (state.teamLoans || []).find(x => x.id === id);
      if (!l) return;
      await put('/api/team-loans/' + id, { personId: l.personId, targetTeamId: l.targetTeamId, startDate: l.startDate, endDate: l.endDate, note: l.note, archived: 0 });
    }
    await load(renderAll);
    toast(t('toast.restored'));
  } catch (e) { toast(e.message); }
}

// ── Settings Card Long List Migration Helper ──
async function executeMigration(destTeamId, type, ids) {
  if (type === 'person') {
    const peopleToMove = ids.filter(pid => {
      const p = person(pid);
      return p && p.homeTeamId !== destTeamId;
    });
    if (peopleToMove.length === 0) {
      toast(t('toast.migrateSameTeam'));
      return;
    }
    openPersonTeamAction(destTeamId, peopleToMove);
  } else if (type === 'project') {
    const projectsToMigrate = ids.filter(prid => {
      const pr = project(prid);
      return pr && pr.teamId !== destTeamId;
    });
    if (projectsToMigrate.length === 0) {
      toast(t('toast.migrateSameTeam'));
      return;
    }
    const promises = projectsToMigrate.map(prid => {
      const pr = project(prid);
      return put(`/api/projects/${prid}`, {
        name: pr.name,
        ownerId: pr.ownerId,
        owner: pr.owner,
        priority: pr.priority,
        color: pr.color,
        startDate: pr.startDate,
        endDate: pr.endDate,
        archived: pr.archived,
        teamId: destTeamId
      });
    });
    const results = await Promise.allSettled(promises);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    await load(renderAll);
    if (failed === 0) {
      toast(t('toast.migrated'));
    } else {
      toast(t('toast.migratePartial', { s: succeeded, f: failed }));
    }
  }
}

// ── Quick Drop Targets Panel Controller ──
let quickDropHideTimeout = null;

function showQuickDropPanel(dragType, sourceTeamId) {
  const panel = $('quickDropPanel');
  if (!panel) return;
  
  if (quickDropHideTimeout) {
    clearTimeout(quickDropHideTimeout);
    quickDropHideTimeout = null;
  }
  
  const activeTeams = state.teams.filter(t => !t.archived);
  
  let html = `<h3>${esc(t('settings.quickMoveTitle') || '拖放以快速划转团队')}</h3>`;
  html += `<div class="quick-drop-targets">`;
  
  activeTeams.forEach(tm => {
    const isCurrent = tm.id === sourceTeamId;
    html += `
      <div class="quick-drop-target ${isCurrent ? 'current-team' : ''}" data-team-id="${tm.id}">
        <span class="quick-drop-dot" style="background:${tm.color || '#7db7ff'}"></span>
        <span class="quick-drop-name">${esc(tm.name)}</span>
        ${isCurrent ? `<span style="font-size:10px; opacity:0.7; margin-left:auto;">(${t('settings.currentTeam') || '当前'})</span>` : ''}
      </div>
    `;
  });
  
  html += `</div>`;
  panel.innerHTML = html;
  
  panel.querySelectorAll('.quick-drop-target').forEach(target => {
    if (target.classList.contains('current-team')) return;
    
    target.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      target.classList.add('drag-over');
    });
    
    target.addEventListener('dragleave', function () {
      target.classList.remove('drag-over');
    });
    
    target.addEventListener('drop', async function (e) {
      e.preventDefault();
      target.classList.remove('drag-over');
      
      const destTeamId = target.dataset.teamId;
      const data = readDrop(e);
      if (!data.type || !data.ids || data.ids.length === 0) return;
      
      await executeMigration(destTeamId, data.type, data.ids);
      hideQuickDropPanel();
    });
  });
  
  panel.style.display = 'flex';
  requestAnimationFrame(() => {
    panel.classList.add('show');
  });
}

function hideQuickDropPanel() {
  const panel = $('quickDropPanel');
  if (!panel) return;
  
  panel.classList.remove('show');
  
  if (quickDropHideTimeout) clearTimeout(quickDropHideTimeout);
  quickDropHideTimeout = setTimeout(() => {
    panel.style.display = 'none';
  }, 300);
}

// ── renderAll 引用（延迟设置） ──
let renderAll = null;
export function setRenderAll(fn) { renderAll = fn; }

// ── 绑定所有事件 ──
export function bindEvents() {
  // 键盘：Delete/Backspace 删除选中
  document.addEventListener('keydown', async function (e) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (isReadOnlyMode()) return;
    if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    // 路由按选中类型（§6.1，A1）：需求块优先（独立 selectedGroupId，不污染 selectedBarId，
    // 避免对 ag_ id 调 deleteAssignment 触发 404）→ 排期 → 里程碑。
    if (selectedGroupId) {
      e.preventDefault();
      const id = selectedGroupId;
      selectRequirement(null);
      deleteRequirement(id);
    } else if (selectedBarId) {
      e.preventDefault();
      const id = selectedBarId;
      selectBar(null);
      deleteAssignment(id, false, renderAll);
    } else if (selectedMilestoneId) {
      e.preventDefault();
      const id = selectedMilestoneId;
      selectMilestone(null);
      deleteMilestone(id, false, renderAll);
    }
  });

  // 键盘：Escape 依次关闭模态框 / 资源抽屉 / 右键菜单，并取消选中
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    const modal = $('modalMask');
    if (modal.classList.contains('show')) { e.preventDefault(); closeModal(); return; }
    const drawer = $('drawerMask');
    if (drawer.classList.contains('show')) { e.preventDefault(); closeDrawer(); return; }
    const ctx = $('ctxMenu');
    if (ctx.style.display !== 'none') { ctx.style.display = 'none'; e.preventDefault(); return; }
    if (selectedBarId || selectedMilestoneId || selectedGroupId) { e.preventDefault(); selectBar(null); selectMilestone(null); selectRequirement(null); }
  });

  // 点击空白关闭右键菜单
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.ctx-menu')) $('ctxMenu').style.display = 'none';
  });

  // 统计栏点击：冲突高亮切换 / 下钻（F1.2 + F2.3）
  $('stats').addEventListener('click', function (e) {
    const pill = e.target.closest('[data-stat]');
    if (!pill) return;
    const k = pill.dataset.stat;
    if (k === 'conflict') {
      setConflictHighlight(!conflictHighlight);
      renderAll && renderAll();
      if (conflictHighlight) {
        const first = document.querySelector('.cell.conflict-on, .assign.conflict-on');
        if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    } else if (k === 'used' || k === 'load') {
      showBreakdown('person');
    }
  });

  // 撤销按钮（F1.4）
  $('undoBtn').addEventListener('click', async function () {
    if (!canUndo()) return;
    await undoLast();
    window._undoRefresh && await window._undoRefresh();
  });

  // 统计下钻关闭
  $('breakdownClose').addEventListener('click', closeBreakdown);
  $('breakdownMask').addEventListener('click', e => { if (e.target.id === 'breakdownMask') closeBreakdown(); });

  // 键盘方向键：移动选中条（X1 可达性）
  document.addEventListener('keydown', function (e) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag && ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (isReadOnlyMode()) return;
    if (!selectedBarId) return;
    const view = activeTab === 'people' ? 'person' : 'project';
    const list = state.assignments
      .filter(a => { const p = state.people.find(x => x.id === a.personId); const pr = state.projects.find(x => x.id === a.projectId); return p && pr && !p.archived && !pr.archived; })
      .sort((a, b) => a.date.localeCompare(b.date) || endOf(a).localeCompare(endOf(b)) || String(a.id).localeCompare(String(b.id)));
    const idx = list.findIndex(a => String(a.id) === String(selectedBarId));
    if (idx === -1) return;
    e.preventDefault();
    const ni = e.key === 'ArrowLeft' ? Math.max(0, idx - 1) : Math.min(list.length - 1, idx + 1);
    if (ni !== idx) selectBar(list[ni].id);
  });

  // modal mask 点击关闭
  $('modalMask').addEventListener('click', e => {
    if (e.target.id === 'modalMask') closeModal();
  });

  // ── 事件委托：scheduler 区域 ──
  $('scheduler').addEventListener('click', function (e) {
    // 需求块（parent-task）：命名/空需求块→选中；未归组块（data-group-id=''）→不选中（仅可右键/双击）。
    // 不落入下方 assignment 选中逻辑。
    const parentEl = e.target.closest('.assign.bar.parent-task');
    if (parentEl) {
      e.stopPropagation();
      const groupId = parentEl.dataset.groupId || '';
      if (groupId) selectRequirement(groupId);
      else { selectBar(null); selectMilestone(null); selectRequirement(null); }
      return;
    }
    // 选择 bar
    const barEl = e.target.closest('.assign.bar');
    if (barEl) {
      e.stopPropagation();
      selectBar(barEl.dataset.assignId);
      return;
    }
    // 选择 milestone
    const msEl = e.target.closest('.milestone');
    if (msEl) {
      e.stopPropagation();
      selectMilestone(msEl.dataset.msId);
      return;
    }
    // 点击空白取消选择
    selectBar(null);
    selectMilestone(null);
    selectRequirement(null);
  });

  $('scheduler').addEventListener('dblclick', function (e) {
    if (isReadOnlyMode()) return;
    // 需求块（parent-task）：命名/空需求块→编辑需求；未归组块（data-group-id=''）→归入需求选择器。
    const parentEl = e.target.closest('.assign.bar.parent-task');
    if (parentEl) {
      const groupId = parentEl.dataset.groupId || '';
      const projectId = parentEl.dataset.projectId;
      if (groupId) openRequirementEditor(groupId, projectId);
      else openRegroupPicker(projectId);
      return;
    }
    const barEl = e.target.closest('.assign.bar');
    if (barEl) {
      openAssignmentForm({ mode: 'task', id: barEl.dataset.assignId });
      return;
    }
    const msEl = e.target.closest('.milestone');
    if (msEl) { openMilestone(msEl.dataset.msId); return; }
  });

  // 悬浮提示：进入任务条 / 里程碑时按延迟显示，离开则隐藏
  $('scheduler').addEventListener('pointerover', function (e) {
    if (movingAssignment || resizingAssignment || movingMilestone) return;
    const t0 = e.target;
    if (!t0 || !t0.closest) return;
    const bar = t0.closest('.assign.bar');
    const ms = !bar && t0.closest('.milestone');
    const el = bar || ms;
    if (!el || el === tipHoverEl) return;
    tipHoverEl = el;
    scheduleTooltip(el);
  });

  $('scheduler').addEventListener('pointerout', function (e) {
    const rt = e.relatedTarget;
    const stillInside = rt && rt.closest && (rt.closest('.assign.bar') === tipHoverEl || rt.closest('.milestone') === tipHoverEl);
    if (!stillInside) { tipHoverEl = null; hideTooltip(); }
  });

  // 日历滚动时悬浮锚点会错位，直接隐藏（移动鼠标会重新触发显示）
  const calWrap = document.querySelector('.calendar-wrap');
  if (calWrap) calWrap.addEventListener('scroll', hideTooltip, { passive: true });

  // 重渲染（innerHTML 替换）后旧锚点元素被移除，隐藏悬停的提示
  if (tipNode()) {
    new MutationObserver(() => { tipHoverEl = null; hideTooltip(); })
      .observe($('scheduler'), { childList: true });
  }

  // bar-main / milestone pointer down → 移动
  $('scheduler').addEventListener('pointerdown', function (e) {
    hideTooltip(); tipHoverEl = null;
    if (isReadOnlyMode()) return;
    if (e.target.closest('.parent-task')) return;
    const msEl = e.target.closest('.milestone');
    if (msEl) { startMoveMilestone(e, msEl.dataset.msId); return; }
    const barMain = e.target.closest('[data-bar-main]');
    if (barMain) { startMoveAssignment(e, barMain.dataset.assignId); return; }
    const handle = e.target.closest('.resize-handle');
    if (handle) { startResizeAssignment(e, handle.dataset.assignId, handle.dataset.resize); return; }
  });

  // milestone 拖拽已改为 pointer 事件，保留 HTML5 drag 用于资源抽屉拖入

  // cell 右键菜单、拖放
  // 优先级链（§6.3，M2）：.parent-task 在 .cell 内部，必须先拦截，否则需求块右键会同时弹格子菜单。
  $('scheduler').addEventListener('contextmenu', function (e) {
    if (isReadOnlyMode()) return;
    const parentEl = e.target.closest('.parent-task');
    if (parentEl) {
      const groupId = parentEl.dataset.groupId || '';
      const projectId = parentEl.dataset.projectId;
      const date = cellDateAtX(e.clientX);
      showCtxMenu(e, 'parentTask', { groupId, projectId, date });
      return; // 不落入 .cell 分支
    }
    // 任务条（任务视图，非需求块）：归属到需求 / 编辑排期 / 删除排期
    const assignBarEl = e.target.closest('.assign.bar');
    if (assignBarEl) { showCtxMenu(e, 'taskBar', assignBarEl.dataset.assignId); return; }
    const cell = e.target.closest('.cell');
    if (cell) showCtxMenu(e, cell.dataset.view, cell.dataset.rowId, cell.dataset.date);
  });

  $('scheduler').addEventListener('dragover', function (e) {
    if (isReadOnlyMode()) return;
    const cell = e.target.closest('.cell');
    if (cell) allowDrop(e);
  });

  $('scheduler').addEventListener('dragleave', function (e) {
    const cell = e.target.closest('.cell');
    if (cell) cell.classList.remove('drop');
  });

  $('scheduler').addEventListener('drop', function (e) {
    if (isReadOnlyMode()) return;
    const cell = e.target.closest('.cell');
    if (cell) dropOnCell(e, cell.dataset.view, cell.dataset.rowId, cell.dataset.date);
  });

  // ── 事件委托：资源抽屉 ──
  $('resourceBody').addEventListener('click', function (e) {
    if (isReadOnlyMode()) return;
    const addPerson = e.target.closest('[data-add-person]');
    if (addPerson) { openPerson(); return; }
    const addProject = e.target.closest('[data-add-project]');
    if (addProject) { openProject(); return; }
    const addMilestone = e.target.closest('[data-add-milestone]');
    if (addMilestone) { openMilestone(); return; }
    const editPerson = e.target.closest('[data-edit-person]');
    if (editPerson) { openPerson(editPerson.dataset.editPerson); return; }
    const editProject = e.target.closest('[data-edit-project]');
    if (editProject) { openProject(editProject.dataset.editProject); return; }
    const editMilestone = e.target.closest('[data-edit-milestone]');
    if (editMilestone) { openMilestone(editMilestone.dataset.editMilestone); return; }
  });

  $('resourceBody').addEventListener('dragstart', function (e) {
    if (isReadOnlyMode()) {
      e.preventDefault();
      return;
    }
    const item = e.target.closest('[data-drag-type]');
    if (item) setDrag(e, { type: item.dataset.dragType, id: item.dataset.dragId });
  });

  $('resourceBody').addEventListener('pointerdown', function (e) {
    if (isReadOnlyMode()) return;
    const handle = e.target.closest('[data-reorder]');
    if (handle) startReorder(e, handle.dataset.reorder, handle.dataset.reorderId);
  });

  // ── 事件委托：设置面板 ──
  // 只读模式下：切 Tab / 折叠团队 / 展开项目（纯查看操作）仍然允许；仅拦截增删改。
  $('settingsCard').addEventListener('click', function (e) {
    const settingsTabBtn = e.target.closest('[data-settings-tab]');
    if (settingsTabBtn) { setSettingsTab(settingsTabBtn.dataset.settingsTab); return; }

    // 切换团队 Tab（纯查看）
    const teamTabBtn = e.target.closest('[data-team-tab]');
    if (teamTabBtn) { setSettingsActiveTeam(teamTabBtn.dataset.teamTab); renderSettings(); return; }

    // 项目卡 ◆N 徽标 → 里程碑管理弹窗（纯查看入口；弹窗内增删改另作拦截）
    const msMgr = e.target.closest('[data-milestone-manager]');
    if (msMgr) { openMilestoneManager(msMgr.dataset.milestoneManager); return; }

    // 以下均为写操作：只读模式一律拦截
    if (isReadOnlyMode()) return;

    // 归档恢复（取消归档）
    const restorePerson = e.target.closest('[data-restore-person]');
    if (restorePerson) { restoreArchived('person', restorePerson.dataset.restorePerson); return; }
    const restoreProject = e.target.closest('[data-restore-project]');
    if (restoreProject) { restoreArchived('project', restoreProject.dataset.restoreProject); return; }
    const restoreLoan = e.target.closest('[data-restore-team-loan]');
    if (restoreLoan) { restoreArchived('team-loan', restoreLoan.dataset.restoreTeamLoan); return; }

    // Inline creations
    const btnInline = e.target.closest('.btn-inline-create');
    if (btnInline) {
      const personTeamId = btnInline.dataset.createPersonTeamId;
      const projectTeamIdAttr = btnInline.dataset.createProjectTeamId;
      if (personTeamId) {
        const row = btnInline.closest('.inline-creation-row');
        const nameInput = row.querySelector('.inline-person-name');
        const deptInput = row.querySelector('.inline-person-dept');
        const roleInput = row.querySelector('.inline-person-role');
        const name = nameInput.value.trim();
        const dept = deptInput.value.trim();
        const role = roleInput.value.trim();
        if (!name) { toast(t('toast.needInlineName')); return; }
        post('/api/people', { name, department: dept, role, dailyCapacity: 8, homeTeamId: personTeamId })
          .then(() => {
            nameInput.value = '';
            deptInput.value = '';
            roleInput.value = '';
            return load(renderAll);
          })
          .then(() => toast(t('toast.savedPerson')))
          .catch(err => toast(err.message));
      } else if (projectTeamIdAttr) {
        const row = btnInline.closest('.inline-creation-row');
        const nameInput = row.querySelector('.inline-project-name');
        const name = nameInput.value.trim();
        if (!name) { toast(t('toast.needInlineProjectName')); return; }
        post('/api/projects', { name, teamId: projectTeamIdAttr, priority: '中', color: '#7db7ff' })
          .then(() => {
            nameInput.value = '';
            return load(renderAll);
          })
          .then(() => toast(t('toast.savedProject')))
          .catch(err => toast(err.message));
      }
      return;
    }

    // 设置面板只渲染 *-to-team 变体（已绑定当前团队）；裸 data-add-person/project 属资源抽屉、
    // 由其专属 handler 处理。此处勿加裸分支：openPerson()/openProject() 无参会落到日历视图的
    // activeTeam 而非设置页当前团队，导致新建数据静默归属错误团队。
    const addPersonToTeam = e.target.closest('[data-add-person-to-team]');
    if (addPersonToTeam) { openPerson(null, addPersonToTeam.dataset.addPersonToTeam); return; }
    const addProjectToTeam = e.target.closest('[data-add-project-to-team]');
    if (addProjectToTeam) { openProject(null, addProjectToTeam.dataset.addProjectToTeam); return; }
    const addLoanToTeam = e.target.closest('[data-add-loan-to-team]');
    if (addLoanToTeam) { openTeamLoan(null, addLoanToTeam.dataset.addLoanToTeam); return; }
    const editTeamLoan = e.target.closest('[data-edit-team-loan]');
    if (editTeamLoan) { openTeamLoan(editTeamLoan.dataset.editTeamLoan); return; }
    const addMilestone = e.target.closest('[data-add-milestone]');
    if (addMilestone) { openMilestone(); return; }
    const addMilestoneToProj = e.target.closest('[data-add-milestone-to-project]');
    if (addMilestoneToProj) { openAddMilestone(addMilestoneToProj.dataset.addMilestoneToProject); return; }
    const editPerson = e.target.closest('[data-edit-person]');
    if (editPerson) { openPerson(editPerson.dataset.editPerson); return; }
    const deletePersonBtn = e.target.closest('[data-delete-person]');
    if (deletePersonBtn) { deletePerson(deletePersonBtn.dataset.deletePerson, false, renderAll); return; }
    const editProject = e.target.closest('[data-edit-project]');
    if (editProject) { openProject(editProject.dataset.editProject); return; }
    const deleteProjectBtn = e.target.closest('[data-delete-project]');
    if (deleteProjectBtn) { deleteProject(deleteProjectBtn.dataset.deleteProject, false, renderAll); return; }
    const editMilestone = e.target.closest('[data-edit-milestone]');
    if (editMilestone) { openMilestone(editMilestone.dataset.editMilestone); return; }
    const deleteMilestoneBtn = e.target.closest('[data-delete-milestone]');
    if (deleteMilestoneBtn) { deleteMilestone(deleteMilestoneBtn.dataset.deleteMilestone, false, renderAll); return; }
    const addTeam = e.target.closest('[data-add-team]');
    if (addTeam) { openTeam(); return; }
    const editTeam = e.target.closest('[data-edit-team]');
    if (editTeam) { openTeam(editTeam.dataset.editTeam); return; }
    const deleteTeamBtn = e.target.closest('[data-delete-team]');
    if (deleteTeamBtn) { deleteTeam(deleteTeamBtn.dataset.deleteTeam); return; }
    const exportCsv = e.target.closest('[data-export-csv]');
    if (exportCsv) {
      if (!postNativeAppAction('exportCsv')) location.href = '/api/export.csv';
      return;
    }
    const importCsvBtn = e.target.closest('[data-import-csv]');
    if (importCsvBtn) {
      if (!postNativeAppAction('importCsv')) $('csvFile').click();
      return;
    }
    const resetDataBtn = e.target.closest('[data-reset-data]');
    if (resetDataBtn) {
      resetData(postNativeAppAction);
      return;
    }
  });

  // Settings card drag and drop + reordering events
  $('settingsCard').addEventListener('pointerdown', function (e) {
    if (isReadOnlyMode()) return;
    const handle = e.target.closest('[data-reorder]');
    if (handle) startReorder(e, handle.dataset.reorder, handle.dataset.reorderId);
  });

  $('settingsCard').addEventListener('dragstart', function (e) {
    if (isReadOnlyMode()) {
      e.preventDefault();
      return;
    }
    const item = e.target.closest('[data-drag-type]');
    if (item) {
      const type = item.dataset.dragType;
      const id = item.dataset.dragId;

      const checkbox = item.querySelector(`.batch-select-${type}`);
      const isChecked = checkbox ? checkbox.checked : false;

      let ids = [id];
      if (isChecked) {
        const checkedBoxes = document.querySelectorAll(`.batch-select-${type}:checked`);
        ids = Array.from(checkedBoxes).map(cb => cb.value);
        if (!ids.includes(id)) {
          ids.push(id);
        }
      }
      setDrag(e, { type, ids, sourceId: id });

      const srcPanel = item.closest('[data-team-id]');
      const sourceTeamId = srcPanel ? srcPanel.dataset.teamId : null;
      showQuickDropPanel(type, sourceTeamId);
    }
  });

  $('settingsCard').addEventListener('dragover', function (e) {
    if (isReadOnlyMode()) return;

    // Auto-scroll logic for overflow settings-card
    const card = $('settingsCard');
    const rect = card.getBoundingClientRect();
    const mouseY = e.clientY;
    const threshold = 60; // scroll zone boundary
    const speed = 12;     // scroll speed

    clearInterval(dragScrollInterval);
    dragScrollInterval = null;

    if (mouseY < rect.top + threshold) {
      dragScrollInterval = setInterval(() => { card.scrollTop -= speed; }, 30);
    } else if (mouseY > rect.bottom - threshold) {
      dragScrollInterval = setInterval(() => { card.scrollTop += speed; }, 30);
    }

    // 跨队迁移落区：团队 Tab（右侧悬浮面板是另一套落区）
    const tab = e.target.closest('.team-tab[data-team-id]');
    if (tab) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.team-tab.drag-over-team').forEach(b => { if (b !== tab) b.classList.remove('drag-over-team'); });
      tab.classList.add('drag-over-team');
    }
  });

  $('settingsCard').addEventListener('dragleave', function (e) {
    const tab = e.target.closest('.team-tab[data-team-id]');
    if (tab && !tab.contains(e.relatedTarget)) tab.classList.remove('drag-over-team');
  });

  $('settingsCard').addEventListener('dragend', function () {
    clearInterval(dragScrollInterval);
    dragScrollInterval = null;
    hideQuickDropPanel();
  });

  $('settingsCard').addEventListener('drop', async function (e) {
    if (isReadOnlyMode()) return;
    e.preventDefault();
    clearInterval(dragScrollInterval);
    dragScrollInterval = null;
    document.querySelectorAll('.team-tab.drag-over-team').forEach(b => b.classList.remove('drag-over-team'));

    const tab = e.target.closest('.team-tab[data-team-id]');
    if (!tab) return;
    const destTeamId = tab.dataset.teamId;
    if (!destTeamId) return;

    const data = readDrop(e);
    if (!data.type || !data.ids || data.ids.length === 0) return;

    await executeMigration(destTeamId, data.type, data.ids);
  });

  // Change listener on settingsCard checkboxes to show/hide batch actions bar
  $('settingsCard').addEventListener('change', function (e) {
    if (e.target.matches('.batch-select-person, .batch-select-project')) {
      updateBatchActionBar();
    }
  });

  function updateBatchActionBar() {
    const checkedPeople = Array.from(document.querySelectorAll('.batch-select-person:checked')).map(cb => cb.value);
    const checkedProjects = Array.from(document.querySelectorAll('.batch-select-project:checked')).map(cb => cb.value);
    
    let bar = $('batchActionBar');
    if (checkedPeople.length === 0 && checkedProjects.length === 0) {
      if (bar) bar.remove();
      return;
    }
    
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'batchActionBar';
      bar.className = 'batch-actions-bar';
      document.body.appendChild(bar);
      
      bar.addEventListener('click', async function (evt) {
        if (isReadOnlyMode()) return;
        const btnDelete = evt.target.closest('.btn-batch-delete');
        const btnCancel = evt.target.closest('.btn-batch-cancel');
        
        if (btnCancel) {
          document.querySelectorAll('.batch-select-person, .batch-select-project').forEach(cb => cb.checked = false);
          bar.remove();
        } else if (btnDelete) {
          const currentCheckedPeople = Array.from(document.querySelectorAll('.batch-select-person:checked')).map(cb => cb.value);
          const currentCheckedProjects = Array.from(document.querySelectorAll('.batch-select-project:checked')).map(cb => cb.value);
          
          const pCount = currentCheckedPeople.length;
          const prCount = currentCheckedProjects.length;
          const confirmMsg = t('confirm.batchDelete', { p: pCount, pr: prCount });
          if (confirm(confirmMsg)) {
            const deletedPeople = [];
            const deletedProjects = [];
            
            for (const pid of currentCheckedPeople) {
              const p = person(pid);
              if (p) {
                const assigns = state.assignments.filter(a => a.personId === pid).map(a => ({ ...a }));
                const loans = (state.teamLoans || []).filter(l => l.personId === pid).map(l => ({ ...l }));
                deletedPeople.push({ id: pid, data: { name: p.name, department: p.department, role: p.role, dailyCapacity: p.dailyCapacity, color: p.color, homeTeamId: p.homeTeamId }, assigns, loans });
              }
            }
            
            for (const prid of currentCheckedProjects) {
              const pr = project(prid);
              if (pr) {
                const assigns = state.assignments.filter(a => a.projectId === prid).map(a => ({ ...a }));
                const mss = state.milestones.filter(m => m.projectId === prid).map(m => ({ ...m }));
                deletedProjects.push({ id: prid, data: { name: pr.name, ownerId: pr.ownerId, owner: pr.owner, priority: pr.priority, color: pr.color, startDate: pr.startDate, endDate: pr.endDate, teamId: pr.teamId }, assigns, mss });
              }
            }
            
            for (const pid of currentCheckedPeople) {
              await del('/api/people/' + pid);
            }
            for (const prid of currentCheckedProjects) {
              await del('/api/projects/' + prid);
            }
            
            pushUndo({
              label: t('undo.batchDeleted'),
              run: async () => {
                const oldToNewPersonId = {};
                const oldToNewProjectId = {};
                
                for (const p of deletedPeople) {
                  try {
                    const r = await post('/api/people', p.data);
                    if (r && r.id) {
                      oldToNewPersonId[p.id] = r.id;
                    }
                  } catch (_) {}
                }
                
                for (const pr of deletedProjects) {
                  try {
                    const r = await post('/api/projects', pr.data);
                    if (r && r.id) {
                      oldToNewProjectId[pr.id] = r.id;
                    }
                  } catch (_) {}
                }

                for (const p of deletedPeople) {
                  const newPid = oldToNewPersonId[p.id];
                  if (!newPid) continue;
                  for (const l of p.loans) {
                    try {
                      await post('/api/team-loans', { personId: newPid, targetTeamId: l.targetTeamId, startDate: l.startDate, endDate: l.endDate, note: l.note });
                    } catch (_) {}
                  }
                }
                
                const restoredAssigns = [];
                for (const p of deletedPeople) {
                  const newPid = oldToNewPersonId[p.id];
                  if (newPid) {
                    for (const a of p.assigns) {
                      const newPrid = oldToNewProjectId[a.projectId] || a.projectId;
                      restoredAssigns.push({ personId: newPid, projectId: newPrid, groupId: '', date: a.date, endDate: a.endDate, hours: a.hours, note: a.note });
                    }
                  }
                }
                for (const pr of deletedProjects) {
                  const newPrid = oldToNewProjectId[pr.id];
                  if (newPrid) {
                    for (const a of pr.assigns) {
                      if (!oldToNewPersonId[a.personId]) {
                        restoredAssigns.push({ personId: a.personId, projectId: newPrid, groupId: '', date: a.date, endDate: a.endDate, hours: a.hours, note: a.note });
                      }
                    }
                  }
                }
                
                for (const ra of restoredAssigns) {
                  try {
                    await post('/api/assignments', ra);
                  } catch (_) {}
                }
                
                for (const pr of deletedProjects) {
                  const newPrid = oldToNewProjectId[pr.id];
                  if (newPrid) {
                    for (const m of pr.mss) {
                      try {
                        const newOwnerId = oldToNewPersonId[m.ownerId] || m.ownerId;
                        await post('/api/milestones', {
                          name: m.name,
                          date: m.date,
                          projectId: newPrid,
                          level: m.level,
                          ownerId: newOwnerId,
                          owner: m.owner,
                          description: m.description
                        });
                      } catch (_) {}
                    }
                  }
                }
                
                await load(renderAll);
              }
            });
            
            await load(renderAll);
            bar.remove();
            undoToast(t('undo.batchDeleted'));
          }
        }
      });

      bar.addEventListener('change', async function (evt) {
        if (isReadOnlyMode()) return;
        const select = evt.target.closest('.select-batch-migrate-team');
        if (select) {
          const destTeamId = select.value;
          if (!destTeamId) return;
          
          const currentCheckedPeople = Array.from(document.querySelectorAll('.batch-select-person:checked')).map(cb => cb.value);
          const currentCheckedProjects = Array.from(document.querySelectorAll('.batch-select-project:checked')).map(cb => cb.value);
          
          const pCount = currentCheckedPeople.length;
          const prCount = currentCheckedProjects.length;
          
          if (pCount > 0) {
            const peopleToMove = currentCheckedPeople.filter(pid => {
              const p = person(pid);
              return p && p.homeTeamId !== destTeamId;
            });
            if (peopleToMove.length) openPersonTeamAction(destTeamId, peopleToMove);
          }
          
          if (prCount > 0) {
            const projectsToMigrate = currentCheckedProjects.filter(prid => {
              const pr = project(prid);
              return pr && pr.teamId !== destTeamId;
            });
            const promises = projectsToMigrate.map(prid => {
              const pr = project(prid);
              return put(`/api/projects/${prid}`, {
                name: pr.name,
                ownerId: pr.ownerId,
                owner: pr.owner,
                priority: pr.priority,
                color: pr.color,
                startDate: pr.startDate,
                endDate: pr.endDate,
                archived: pr.archived,
                teamId: destTeamId
              });
            });
            await Promise.allSettled(promises);
          }
          
          if (prCount > 0) await load(renderAll);
          bar.remove();
          if (prCount > 0) toast(t('toast.migrateSuccess', { n: prCount }));
        }
      });
    }
    
    const text = t('settings.batchSelected', { p: checkedPeople.length, pr: checkedProjects.length }) || `已选中 ${checkedPeople.length} 人 · ${checkedProjects.length} 项目`;
    const selectOptions = `<option value="" disabled selected>${esc(t('settings.moveToTeamSelect'))}</option>` +
      state.teams.filter(tm => !tm.archived).map(tm => `<option value="${tm.id}">${esc(tm.name)}</option>`).join('');
      
    bar.innerHTML = `
      <span class="batch-bar-text">${esc(text)}</span>
      <div class="batch-bar-buttons">
        <select class="mini select-batch-migrate-team" style="cursor:pointer; width:auto; max-width:160px; height:28px; font-size:11px; border-radius:6px; padding:0 8px; border:2px solid var(--line); font-weight:850; background:var(--control-bg); color:var(--ink); margin-right:8px;">
          ${selectOptions}
        </select>
        <button class="mini danger btn-batch-delete">${esc(t('settings.batchDelete'))}</button>
        <button class="mini btn-batch-cancel">${esc(t('btn.cancel'))}</button>
      </div>
    `;
  }

  // CSV file input change
  $('csvFile').addEventListener('change', function () { importCsv(this); });

  // ── modal 按钮（cancel 关闭；delete 由 showModal 动态设置） ──
  $('modalCancel').addEventListener('click', closeModal);
  const modalClose = $('modalClose');
  if (modalClose) modalClose.addEventListener('click', closeModal);

  // ── 事件委托：抽屉头部 ──
  $('drawerAdd').addEventListener('click', function (e) {
    if (e.target.closest('[data-add-person]')) { openPerson(); return; }
    if (e.target.closest('[data-add-project]')) { openProject(); return; }
    if (e.target.closest('[data-add-milestone]')) { openMilestone(); return; }
  });
  document.querySelector('.drawer-head button').addEventListener('click', closeDrawer);

  // ── 事件委托：资源 tab 切换 ──
  document.querySelector('.resource-tabs').addEventListener('click', function (e) {
    const btn = e.target.closest('[data-resource-tab]');
    if (btn) setResourceTab(btn.dataset.resourceTab);
  });

  // ── 全局 updatePerDayHint ──
  window._updatePerDayHint = function () {
    const { updatePerDayHint: fn } = window._panelsModule || {};
    if (fn) fn();
  };
}

// interactions.js — 拖拽（HTML5 drag + pointer move/resize）、键盘、右键菜单

import {
  $, state, esc,
  endOf,
  dayDiff, addDaysIso, shiftRange, workingDays,
  selectedBarId, selectedMilestoneId,
  setSelectedBarId, setSelectedMilestoneId,
  isReadOnlyMode,
  pushUndo, setConflictHighlight, conflictHighlight,
  setSearchQ, setFilter, clearFilters, filters, activeTab,
  canUndo, undoLast,
  isConflictCell, planReduceToCapacity, planSpreadToAdjacent,
  person, project, personColor, projectColor, fteOf, milestoneStatus
} from './state.js';
import { post, put, del, load, deletePerson, deleteProject, deleteAssignment, deleteMilestone } from './api.js';
import { dateFromContentX, barStyle } from './calendar.js';
import {
  toast, closeModal, closeDrawer, openPerson, openProject, openAssignment, openMilestone,
  openAddAssignment, openAddMilestone, setResourceTab, setSettingsTab, importCsv, resetData,
  undoToast, showBreakdown, closeBreakdown
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
    await post('/api/assignments', { personId: data.id, projectId, date, endDate: date, hours: 8, note: '' });
  } else if (data.type === 'project') {
    let personId = view === 'person' ? rowId : state.people[0]?.id;
    if (!personId) return toast(t('toast.needPerson'));
    const err = checkProjectRange(data.id, date, date);
    if (err) return toast(err);
    await post('/api/assignments', { personId, projectId: data.id, date, endDate: date, hours: 8, note: '' });
  } else if (data.type === 'assignment') {
    let a = { ...state.assignments.find(x => x.id === data.id) };
    if (!a.id) return;
    if (view === 'person') a.personId = rowId; else a.projectId = rowId;
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

  let html = `<div class="rc-tip-accent" style="background:${dot}"></div><div class="rc-tip-body">`;
  html += `<div class="rc-tip-title"><span class="rc-tip-dot" style="background:${dot}"></span><span class="rc-tip-name">${esc(primary)}</span>`;
  html += `<span class="rc-tip-badges"><span class="rc-tip-badge">${esc(t('tip.fte'))} ${fte}%</span>${over ? `<span class="rc-tip-badge over">${esc(t('tip.over'))}</span>` : ''}</span></div>`;
  if (secondary) html += `<div class="rc-tip-sub">${esc(secondary)}</div>`;
  html += `<div class="rc-tip-row"><b>${esc(a.date)}</b><span class="rc-tip-arrow">→</span><b>${esc(end)}</b><span class="rc-tip-wd">${esc(t('drag.workdays', { n: wd }))}</span></div>`;
  if (a.note) html += `<div class="rc-tip-note"><span class="rc-tip-note-k">${esc(t('tip.note'))}</span><span>${esc(a.note)}</span></div>`;
  html += `</div>`;
  return html;
}

function milestoneTipHTML(el, m) {
  const st = milestoneStatus(m.date);
  let badge = '';
  if (st.state === 'overdue') badge = `<span class="rc-tip-badge over">${esc(t('tip.msOverdue', { n: st.days }))}</span>`;
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
  if (targetRow) {
    if (targetRow.dataset.view === 'person') a.personId = targetRow.dataset.rowId;
    else a.projectId = targetRow.dataset.rowId;
  }
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

function startReorder(e, entity, id) {
  e.preventDefault();
  e.stopPropagation();
  const body = $('resourceBody');
  const el = body.querySelector(`.item[data-id="${id}"]`);
  if (!el) return;
  reordering = { entity, id, startY: e.clientY, active: false, el };
  window.addEventListener('pointermove', onReorderMove);
  window.addEventListener('pointerup', finishReorder, { once: true });
}

function onReorderMove(e) {
  if (!reordering) return;
  const dy = Math.abs(e.clientY - reordering.startY);
  if (!reordering.active && dy < 5) return;
  if (!reordering.active) { reordering.active = true; reordering.el.classList.add('dragging'); }
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (!hit) return;
  const targetItem = hit.closest('.item');
  if (!targetItem || targetItem === reordering.el) return;
  const rect = targetItem.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  if (e.clientY < mid) targetItem.before(reordering.el);
  else targetItem.after(reordering.el);
}

async function finishReorder(e) {
  window.removeEventListener('pointermove', onReorderMove);
  const r = reordering;
  reordering = null;
  if (!r) return;
  r.el.classList.remove('dragging');
  if (!r.active) return;
  const body = $('resourceBody');
  const items = [...body.querySelectorAll('.item')];
  const ids = items.map(el => el.dataset.id).filter(Boolean);
  if (!ids.length) return;
  try {
    await put('/api/sort', { table: r.entity, ids });
    await load(renderAll);
    toast(t('toast.sorted'));
  } catch (err) { toast(t('toast.sortFailed') + err.message); }
}

// ── 右键菜单 ──
function showCtxMenu(e, view, rowId, date) {
  e.preventDefault();
  e.stopPropagation();
  const menu = $('ctxMenu');
  let items = [];
  if (view === 'person') {
    // F2.5：右键冲突格提供解决动作（仅人员视图、仅当日超产能时）
    if (isConflictCell(rowId, date)) {
      items.push({ label: t('ctx.reduce'), action: () => resolveConflictReduce(rowId, date) });
      if (planSpreadToAdjacent(rowId, date)) {
        items.push({ label: t('ctx.spread'), action: () => resolveConflictSpread(rowId, date) });
      }
      items.push({ sep: true });
    }
    items.push({ label: t('ctx.addAssignProject'), action: () => openAddAssignment(rowId, null, date) });
    items.push({ label: t('ctx.addMilestone'), action: () => openAddMilestone(null, date) });
  } else {
    items.push({ label: t('ctx.addAssignPerson'), action: () => openAddAssignment(null, rowId, date) });
    items.push({ label: t('ctx.addMilestone'), action: () => openAddMilestone(rowId, date) });
  }
  menu.innerHTML = items.map((it, i) => it.sep ? '<div class="sep"></div>' : `<div data-idx="${i}">${it.label}</div>`).join('');
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  menu.onclick = function (ev) {
    const idx = ev.target.dataset.idx;
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
    for (const a of before) { try { await post('/api/assignments', { personId: a.personId, projectId: a.projectId, date: a.date, endDate: a.endDate, hours: a.hours, note: a.note }); } catch (_) { /* ignore */ } }
    await load(renderAll);
    throw err;
  }
  await load(renderAll);
  pushUndo({
    label,
    run: async () => {
      for (const id of createdIds) { try { await del('/api/assignments/' + id); } catch (_) { /* 可能已被其它操作删除 */ } }
      for (const a of before) { try { await post('/api/assignments', { personId: a.personId, projectId: a.projectId, date: a.date, endDate: a.endDate, hours: a.hours, note: a.note }); } catch (_) { /* 尽量恢复 */ } }
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
    if (selectedBarId) {
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
    if (selectedBarId || selectedMilestoneId) { e.preventDefault(); selectBar(null); selectMilestone(null); }
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
  });

  $('scheduler').addEventListener('dblclick', function (e) {
    if (isReadOnlyMode()) return;
    const barEl = e.target.closest('.assign.bar');
    if (barEl) { openAssignment(barEl.dataset.assignId); return; }
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
    const msEl = e.target.closest('.milestone');
    if (msEl) { startMoveMilestone(e, msEl.dataset.msId); return; }
    const barMain = e.target.closest('[data-bar-main]');
    if (barMain) { startMoveAssignment(e, barMain.dataset.assignId); return; }
    const handle = e.target.closest('.resize-handle');
    if (handle) { startResizeAssignment(e, handle.dataset.assignId, handle.dataset.resize); return; }
  });

  // milestone 拖拽已改为 pointer 事件，保留 HTML5 drag 用于资源抽屉拖入

  // cell 右键菜单、拖放
  $('scheduler').addEventListener('contextmenu', function (e) {
    if (isReadOnlyMode()) return;
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
  $('settingsCard').addEventListener('click', function (e) {
    if (isReadOnlyMode()) return;
    const settingsTabBtn = e.target.closest('[data-settings-tab]');
    if (settingsTabBtn) { setSettingsTab(settingsTabBtn.dataset.settingsTab); return; }
    const addPerson = e.target.closest('[data-add-person]');
    if (addPerson) { openPerson(); return; }
    const addProject = e.target.closest('[data-add-project]');
    if (addProject) { openProject(); return; }
    const addMilestone = e.target.closest('[data-add-milestone]');
    if (addMilestone) { openMilestone(); return; }
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

  // CSV file input change
  $('csvFile').addEventListener('change', function () { importCsv(this); });

  // ── modal 按钮（cancel 关闭；delete 由 showModal 动态设置） ──
  $('modalCancel').addEventListener('click', closeModal);

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

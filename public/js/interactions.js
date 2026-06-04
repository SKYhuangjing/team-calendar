// interactions.js — 拖拽（HTML5 drag + pointer move/resize）、键盘、右键菜单

import {
  $, state,
  endOf,
  dayDiff, addDaysIso, shiftRange, workingDays,
  selectedBarId, selectedMilestoneId,
  setSelectedBarId, setSelectedMilestoneId,
  isReadOnlyMode
} from './state.js';
import { post, put, load, deletePerson, deleteProject, deleteAssignment, deleteMilestone } from './api.js';
import { dateFromContentX, barStyle } from './calendar.js';
import {
  toast, closeModal, closeDrawer, openPerson, openProject, openAssignment, openMilestone,
  openAddAssignment, openAddMilestone, setResourceTab, setSettingsTab, importCsv
} from './panels.js';

// ── 项目日期范围检查 ──
export function checkProjectRange(projectId, sd, ed) {
  const proj = state.projects.find(x => x.id === projectId);
  if (proj && proj.startDate && sd < proj.startDate) return '排期开始日期不能早于 ' + proj.startDate;
  if (proj && proj.endDate && ed > proj.endDate) return '排期结束日期不能晚于 ' + proj.endDate;
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

function postNativeCsvAction(action) {
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
    if (!projectId) return toast('请先创建项目');
    const err = checkProjectRange(projectId, date, date);
    if (err) return toast(err);
    await post('/api/assignments', { personId: data.id, projectId, date, endDate: date, hours: 8, note: '' });
  } else if (data.type === 'project') {
    let personId = view === 'person' ? rowId : state.people[0]?.id;
    if (!personId) return toast('请先创建人员');
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
  showDragTip(`${ns.slice(5)} ~ ${ne.slice(5)}（${workingDays(ns, ne)}个工作日）`, e.clientX, e.clientY);

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
  await put('/api/assignments/' + a.id, a);
  await load(renderAll);
  toast('已移动任务');
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
  await put('/api/assignments/' + a.id, a);
  await load(renderAll);
  toast('已调整任务区间');
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
  await load(renderAll);
  toast('已移动里程碑');
}

// ── 选择 ──
export function selectBar(id) {
  document.querySelectorAll('.assign.bar.selected').forEach(el => el.classList.remove('selected'));
  setSelectedBarId(id);
  if (id) {
    setSelectedMilestoneId(null);
    document.querySelectorAll('.milestone.selected').forEach(el => el.classList.remove('selected'));
    const el = $('bar_' + id);
    if (el) el.classList.add('selected');
  }
}

export function selectMilestone(id) {
  document.querySelectorAll('.milestone.selected').forEach(el => el.classList.remove('selected'));
  setSelectedMilestoneId(id);
  if (id) {
    setSelectedBarId(null);
    document.querySelectorAll('.assign.bar.selected').forEach(el => el.classList.remove('selected'));
    const el = $('ms_' + id);
    if (el) el.classList.add('selected');
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
    toast('已更新排序');
  } catch (err) { toast('排序失败：' + err.message); }
}

// ── 右键菜单 ──
function showCtxMenu(e, view, rowId, date) {
  e.preventDefault();
  e.stopPropagation();
  const menu = $('ctxMenu');
  let items = [];
  if (view === 'person') {
    items.push({ label: '＋ 排期到项目', action: () => openAddAssignment(rowId, null, date) });
    items.push({ label: '＋ 里程碑', action: () => openAddMilestone(null, date) });
  } else {
    items.push({ label: '＋ 排期到人员', action: () => openAddAssignment(null, rowId, date) });
    items.push({ label: '＋ 里程碑', action: () => openAddMilestone(rowId, date) });
  }
  menu.innerHTML = items.map((it, i) => `<div data-idx="${i}">${it.label}</div>`).join('');
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  menu.onclick = function (ev) {
    const idx = ev.target.dataset.idx;
    if (idx !== undefined) { items[idx].action(); menu.style.display = 'none'; }
  };
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

  // 点击空白关闭右键菜单
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.ctx-menu')) $('ctxMenu').style.display = 'none';
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

  // bar-main / milestone pointer down → 移动
  $('scheduler').addEventListener('pointerdown', function (e) {
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
      if (!postNativeCsvAction('exportCsv')) location.href = '/api/export.csv';
      return;
    }
    const importCsvBtn = e.target.closest('[data-import-csv]');
    if (importCsvBtn) {
      if (!postNativeCsvAction('importCsv')) $('csvFile').click();
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

// panels.js — 模态框、资源抽屉、设置面板、统计栏、CSV 导入、toast

import {
  $, state, dates, esc, resourceTab, settingsTab,
  setResourceTab as setResourceTabState, setSettingsTab as setSettingsTabState,
  isDayOff, inRange, totalHours, endOf, iso, workingDays,
  project, person, team, personColor, projectColor, stableColor,
  rowMatches, filters, setFilter, clearFilters, hasActiveFilters,
  loadRate, milestoneStatus, conflictHighlight, setConflictHighlight,
  undoLast, pushUndo, clearUndo,
  assignmentMatches, milestoneMatches,
  activeTeam, projectTeamId, assignmentGroupsForProject, assignmentGroup,
  settingsActiveTeam, setSettingsActiveTeam, personEligibleForProject, personInTeam,
  isReadOnlyMode, ungroupedAssignmentsOf
} from './state.js';
import { post, put, del, load, api } from './api.js';
import { t } from './i18n.js';

// 显示用的本地化标签（数据值保持规范：优先级 高/中/低、级别 important/risk）
const PRI_LABEL = v => ({ '高': t('label.priorityHigh'), '中': t('label.priorityMid'), '低': t('label.priorityLow') })[v] || v;
const LEVEL_LABEL = v => v === 'risk' ? t('label.levelRisk') : t('label.levelImportant');

// 团队下拉选项（归档团队仅在自身被选中时显示）
function teamOptions(selectedId) {
  const opts = state.teams.filter(x => !x.archived || String(x.id) === String(selectedId));
  const placeholder = selectedId ? '' : `<option value="" selected>${t('label.selectTeam')}</option>`;
  return placeholder + opts.map(x => `<option value="${esc(x.id)}"${String(selectedId) === String(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
}
function peopleOptions(selectedId) {
  const opts = state.people.filter(x => !x.archived || String(x.id) === String(selectedId));
  return `<option value="">${t('label.unassigned')}</option>` +
         opts.map(x => `<option value="${esc(x.id)}"${String(selectedId) === String(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
}
// ── 需求选择器（自定义下拉，复用 .custom-select CSS；C1：modal 内独立开/关 + 单开限制）──
// 选择值约定（与统一表单配合）：
//   ''          → 未归组（groupId 留空）
//   <groupId>   → 既有需求
//   '__new__'   → ＋新建需求（表单内行内展开新建字段）
const REQ_NEW = '__new__';

// 当前打开的自定义下拉容器引用（C1：同时只允许一个 custom-select 打开）
let _openReqSelect = null;
function closeOpenReqSelect(except) {
  if (_openReqSelect && _openReqSelect !== except) {
    _openReqSelect.classList.remove('open');
    const t2 = _openReqSelect.querySelector('.custom-select-trigger');
    if (t2) t2.setAttribute('aria-expanded', 'false');
    const o = _openReqSelect.querySelector('.custom-select-options');
    if (o) o.classList.remove('show');
    _openReqSelect = null;
  }
}

// 统计某需求下参与人数（用于选择器角标「N 人」）
function requirementChildCount(groupId) {
  return new Set(
    state.assignments
      .filter(a => a.groupId === groupId && !a.archived)
      .map(a => a.personId)
      .filter(Boolean)
  ).size;
}

// 需求选择器触发器内容：色点 + 名称 +（有选择时）清除✕ + 箭头。clearable=可清除回「独立任务」。
function reqTriggerInnerHTML(label, dotColor, clearable) {
  const dot = dotColor ? `<span class="dot" style="background:${esc(dotColor)}"></span>` : '';
  const clear = clearable ? `<span class="custom-select-clear" role="button" aria-label="${esc(t('label.clear'))}" title="${esc(t('label.clear'))}">✕</span>` : '';
  return `${dot}<span class="custom-select-label">${esc(label)}</span>${clear}<span class="custom-select-arrow">▾</span>`;
}

// 渲染需求选择器（custom-select 结构）。selectedGroupId 为当前值；allowNew 控制是否显示「＋新建需求」。
export function requirementSelectHTML(projectId, selectedGroupId, { allowNew } = {}) {
  const groups = assignmentGroupsForProject(projectId, true)
    .filter(g => !g.archived || String(g.id) === String(selectedGroupId));
  const row = (value, dotColor, label, count) => {
    const sel = String(selectedGroupId || '') === String(value) ? ' selected' : '';
    const dot = dotColor ? `<span class="option-dot" style="background:${esc(dotColor)}"></span>` : '';
    const badge = (count === undefined || count === null) ? '' : `<span class="req-count">${esc(String(count))}${esc(t('label.reqCountUnit'))}</span>`;
    return `<li role="option" data-value="${esc(value)}" class="${sel.trim()}">${dot}<span class="custom-select-label">${esc(label)}</span>${badge}</li>`;
  };
  // 不再展示「未归组」选项：空值（不选）即代表「独立任务」
  const items = [
    ...groups.map(g => row(g.id, g.color || '#7db7ff', g.name, requirementChildCount(g.id))),
    ...(allowNew ? [row(REQ_NEW, '', t('option.newRequirement'))] : [])
  ].join('');
  // 当前选中项的展示文案/色点
  const cur = groups.find(g => String(g.id) === String(selectedGroupId));
  let curLabel, curColor;
  if (String(selectedGroupId || '') === REQ_NEW) { curLabel = t('option.newRequirement'); curColor = ''; }
  else if (cur) { curLabel = cur.name; curColor = cur.color || '#7db7ff'; }
  else { curLabel = t('label.independentTask'); curColor = ''; }
  const hasSelection = !!selectedGroupId;
  return `<div class="custom-select req-select" data-role="requirement-select">
    <button type="button" class="custom-select-trigger${hasSelection ? '' : ' is-empty'}" role="combobox" aria-expanded="false">${reqTriggerInnerHTML(curLabel, curColor, hasSelection)}</button>
    <ul class="custom-select-options">${items}</ul>
    <input type="hidden" id="f_group" value="${esc(selectedGroupId || '')}">
  </div>`;
}

// 绑定需求选择器交互（modal 打开后调用）。
// opts.onSelect(value) 选中回调；opts.isLocked() 返回 true 时禁止交互（锁定需求）。
export function bindRequirementSelect(projectId, opts = {}) {
  const container = document.querySelector('.req-select[data-role="requirement-select"]');
  if (!container) return;
  const trigger = container.querySelector('.custom-select-trigger');
  const optionsEl = container.querySelector('.custom-select-options');
  const input = container.querySelector('#f_group');
  if (!trigger || !optionsEl || !input) return;

  const locked = opts.isLocked && opts.isLocked();

  const resetFloatingPosition = () => {
    optionsEl.classList.remove('is-floating');
    optionsEl.style.removeProperty('--req-select-top');
    optionsEl.style.removeProperty('--req-select-left');
    optionsEl.style.removeProperty('--req-select-width');
  };
  const positionFloatingOptions = () => {
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(rect.width, 360);
    const left = Math.min(rect.left, window.innerWidth - width - 12);
    optionsEl.style.setProperty('--req-select-top', `${rect.bottom + 6}px`);
    optionsEl.style.setProperty('--req-select-left', `${Math.max(12, left)}px`);
    optionsEl.style.setProperty('--req-select-width', `${width}px`);
    optionsEl.classList.add('is-floating');
  };
  const close = () => {
    container.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    optionsEl.classList.remove('show');
    resetFloatingPosition();
    if (_openReqSelect === container) _openReqSelect = null;
  };
  const open = () => {
    if (locked) return;
    closeOpenReqSelect(container); // C1：先关掉其它打开的下拉
    positionFloatingOptions();
    container.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    optionsEl.classList.add('show');
    _openReqSelect = container;
  };
  const toggle = () => { container.classList.contains('open') ? close() : open(); };

  // 锁定态：禁用触发器，展示名称即可
  if (locked) {
    trigger.style.opacity = '.55';
    trigger.style.cursor = 'not-allowed';
    trigger.tabIndex = -1;
    const clr = trigger.querySelector('.custom-select-clear');
    if (clr) clr.style.display = 'none'; // 锁定态不可清除，隐藏 ✕
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (locked) return;
    // 点 ✕：清除选择 → 独立任务（不展开下拉）
    if (e.target.closest('.custom-select-clear')) {
      input.value = '';
      trigger.classList.add('is-empty');
      trigger.innerHTML = reqTriggerInnerHTML(t('label.independentTask'), '', false);
      optionsEl.querySelectorAll('li').forEach(x => x.classList.remove('selected'));
      close();
      if (opts.onSelect) opts.onSelect('');
      return;
    }
    toggle();
  });

  // 选项点击
  optionsEl.addEventListener('click', (e) => {
    const li = e.target.closest('li[role="option"]');
    if (!li) return;
    const value = li.dataset.value || '';
    input.value = value;
    // 更新触发器展示（有选择 → 可清除）
    const dot = li.querySelector('.option-dot');
    const label = li.querySelector('.custom-select-label') ? li.querySelector('.custom-select-label').textContent : '';
    const color = dot ? dot.style.background : '';
    trigger.classList.remove('is-empty');
    trigger.innerHTML = reqTriggerInnerHTML(label, color, true);
    // 选项选中态
    optionsEl.querySelectorAll('li').forEach(x => x.classList.toggle('selected', x === li));
    close();
    if (opts.onSelect) opts.onSelect(value);
  });

  // C1：modal 内独立管理 outside-click（点击容器外关闭）
  const onOutside = (e) => { if (!container.contains(e.target)) close(); };
  document.addEventListener('click', onOutside);

  // 键盘：Escape 关闭
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const onViewportChange = () => {
    if (container.classList.contains('open')) positionFloatingOptions();
  };
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);

  // 注册清理：modal 关闭时移除监听（closeModal 不发事件，靠下次 showModal 覆盖 innerHTML，
  // 监听挂在 document 上会在新弹窗里残留——用一个一次性哨兵在 modal 切换时清理）
  container._reqCleanup = () => {
    document.removeEventListener('click', onOutside);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('scroll', onViewportChange, true);
    resetFloatingPosition();
    if (_openReqSelect === container) _openReqSelect = null;
  };
}

// 切换需求选择器为某个项目的选项（C2：切项目时刷新选项并清空选择）
function refreshRequirementSelectOptions(projectId) {
  const container = document.querySelector('.req-select[data-role="requirement-select"]');
  if (!container) return;
  const input = container.querySelector('#f_group');
  const optionsEl = container.querySelector('.custom-select-options');
  const trigger = container.querySelector('.custom-select-trigger');
  if (!input || !optionsEl || !trigger) return;
  const groups = assignmentGroupsForProject(projectId, true).filter(g => !g.archived);
  const row = (value, dotColor, label, count) => {
    const dot = dotColor ? `<span class="option-dot" style="background:${esc(dotColor)}"></span>` : '';
    const badge = (count === undefined) ? '' : `<span class="req-count">${esc(String(count))}${esc(t('label.reqCountUnit'))}</span>`;
    return `<li role="option" data-value="${esc(value)}">${dot}<span class="custom-select-label">${esc(label)}</span>${badge}</li>`;
  };
  // allowNew 由触发器是否仍展示「＋新建」推断：保留原 allowNew 行为
  const allowNew = !!optionsEl.querySelector('li[data-value="' + REQ_NEW + '"]');
  optionsEl.innerHTML = [
    ...groups.map(g => row(g.id, g.color || '#7db7ff', g.name, requirementChildCount(g.id))),
    ...(allowNew ? [row(REQ_NEW, '', t('option.newRequirement'))] : [])
  ].join('');
  // C2：清空选择（groupId='' → 独立任务）
  input.value = '';
  trigger.classList.add('is-empty');
  trigger.innerHTML = reqTriggerInnerHTML(t('label.independentTask'), '', false);
}

// 内联新建需求字段块（选择「＋新建需求」时展开）
function requirementNewFieldsHTML() {
  return `<div class="req-new-fields" id="f_reqNewWrap" hidden>
    <div><label>${t('label.requirementName')} *</label><input id="f_reqName" value=""></div>
    <div><label>${t('label.requirementColor')}</label>${requirementColorSwatchesHTML('')}</div>
    <div><label>${t('label.requirementOwner')}</label><select id="f_reqOwner">${peopleOptions('')}</select></div>
    <div><label>${t('label.requirementDesc')}</label><textarea id="f_reqDesc"></textarea></div>
  </div>`;
}
function teamName(id) {
  const tm = team(id);
  return tm ? tm.name : '';
}

// ── toast ──
export function toast(msg) {
  let el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

// ── 模态框 ──
function cleanupRequirementSelects() {
  document.querySelectorAll('.req-select[data-role="requirement-select"]').forEach(el => {
    if (typeof el._reqCleanup === 'function') el._reqCleanup();
  });
  _openReqSelect = null;
}

export function closeModal() {
  cleanupRequirementSelects();
  $('modalMask').classList.remove('show');
  const modal = document.querySelector('#modalMask .modal');
  if (modal) modal.classList.remove('large');
}

export function showModal(title, body, onSave, onDelete) {
  cleanupRequirementSelects();
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalSave').onclick = onSave;
  $('modalSave').textContent = t('btn.save'); // 复位，避免打印框「开始打印」文案残留到后续弹窗
  $('modalSave').style.visibility = onSave ? 'visible' : 'hidden'; // 无保存动作的弹窗（如里程碑管理）隐藏保存键，并在每次打开时复位
  $('modalSave').style.opacity = '';
  $('modalSave').style.pointerEvents = '';
  $('modalDelete').style.visibility = onDelete ? 'visible' : 'hidden';
  $('modalDelete').onclick = onDelete || (() => {});
  $('modalMask').classList.add('show');
}

export function val(id) {
  const el = $(id);
  return el ? String(el.value || '').trim() : '';
}

function selectedValues(id) {
  const el = $(id);
  if (!el) return [];
  if (el.multiple) return Array.from(el.selectedOptions).map(o => o.value).filter(Boolean);
  return el.value ? [el.value] : [];
}

// ── 人员表单 ──
export function openPerson(id, prefilledTeamId) {
  let p = id ? person(id) : { name: '', department: '研发部', role: '', dailyCapacity: 8, archived: 0, color: '' };
  showModal(
    id ? t('title.editPerson') : t('title.addPerson'),
    `<div class="form"><div class="form-row"><div><label>${t('label.name')}</label><input id="f_name" value="${esc(p.name || '')}"></div><div><label>${t('label.capacity')}</label><input id="f_cap" type="number" value="${p.dailyCapacity || 8}"></div></div><div class="form-row"><div><label>${t('label.dept')}</label><input id="f_dept" value="${esc(p.department || '')}"></div><div><label>${t('label.role')}</label><input id="f_role" value="${esc(p.role || '')}"></div></div><div><label>${t('label.homeTeam')}</label><select id="f_team">${teamOptions(id ? p.homeTeamId : (prefilledTeamId || activeTeam || ''))}</select></div><div><label>${t('label.color')}</label><input id="f_color" type="color" value="${p.color || stableColor('person-' + (p.id || p.name))}"></div>${id ? `<div><label><input id="f_archived" type="checkbox" ${p.archived ? 'checked' : ''}> ${t('label.archived')}</label></div>` : ''}</div>`,
    async () => {
      let d = { name: val('f_name'), department: val('f_dept'), role: val('f_role'), dailyCapacity: Number(val('f_cap') || 8), color: val('f_color'), homeTeamId: val('f_team') };
      if (id) d.archived = $('f_archived').checked ? 1 : 0;
      if (!d.name) return toast(t('toast.needName'));
      if (!d.homeTeamId) return toast(t('toast.needTeam'));
      id ? await put('/api/people/' + id, d) : await post('/api/people', d);
      closeModal(); await reloadAll(); toast(t('toast.savedPerson'));
    },
    id ? async () => { await del('/api/people/' + id); closeModal(); await reloadAll(); toast(t('toast.deletedPerson')); } : null
  );
}

// ── 项目表单 ──
export function openProject(id, prefilledTeamId) {
  let p = id ? project(id) : { name: '', ownerId: '', priority: '中', color: '#7db7ff', startDate: '', endDate: '', archived: 0 };
  const priOpt = v => `<option value="${v}" ${p.priority === v ? 'selected' : ''}>${PRI_LABEL(v)}</option>`;
  showModal(
    id ? t('title.editProject') : t('title.addProject'),
    `<div class="form"><div><label>${t('label.projectName')}</label><input id="f_name" value="${esc(p.name || '')}"></div><div class="form-row"><div><label>${t('label.owner')}</label><select id="f_owner">${peopleOptions(p.ownerId)}</select></div><div><label>${t('label.priority')}</label><select id="f_pri">${priOpt('高')}${priOpt('中')}${priOpt('低')}</select></div></div><div><label>${t('label.team')}</label><select id="f_team">${teamOptions(id ? p.teamId : (prefilledTeamId || activeTeam || ''))}</select></div><div class="form-row"><div><label>${t('label.projectStart')}</label><input id="f_start" type="date" value="${p.startDate || ''}"></div><div><label>${t('label.projectEnd')}</label><input id="f_end" type="date" value="${p.endDate || ''}"></div></div><span class="form-hint">${t('label.projectRangeHint')}</span><div><label>${t('label.projectColor')}</label><input id="f_color" type="color" value="${p.color || '#7db7ff'}"></div>${id ? `<div><label><input id="f_archived" type="checkbox" ${p.archived ? 'checked' : ''}> ${t('label.archived')}</label></div>` : ''}</div>`,
    async () => {
      let d = { name: val('f_name'), ownerId: val('f_owner'), priority: val('f_pri'), color: val('f_color'), startDate: val('f_start'), endDate: val('f_end'), teamId: val('f_team') };
      if (id) d.archived = $('f_archived').checked ? 1 : 0;
      if (!d.name) return toast(t('toast.needProjectName'));
      if (!d.teamId) return toast(t('toast.needTeam'));
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
  const personIds = selectedValues('f_person');
  const personId = personIds[0] || '';
  const p = state.people.find(x => x.id === personId);
  const cap = Number((p && p.dailyCapacity) || 8);
  const fte = cap ? (perDay / cap) : 0;
  const el = $('f_perday');
  if (el) {
    el.textContent = personIds.length > 1
      ? t('label.perdayMulti', { d, perDay: perDay.toFixed(1), n: personIds.length })
      : t('label.perdayHint', { d, perDay: perDay.toFixed(1), n: Math.round(fte * 100) });
  }
}

function assignmentPeopleOptions(projectId, startDate, endDate, selectedId, preserveSelected = false) {
  const opts = state.people.filter(p => !p.archived && personEligibleForProject(p.id, projectId, startDate, endDate));
  const selectedIds = Array.isArray(selectedId)
    ? selectedId.map(String).filter(Boolean)
    : (selectedId ? [String(selectedId)] : []);
  if (preserveSelected) {
    selectedIds.forEach(id => {
      const selected = person(id);
      if (selected && !opts.some(p => p.id === selected.id)) opts.push(selected);
    });
  }
  return opts.map(p => {
    const borrowed = p.homeTeamId !== project(projectId)?.teamId;
    const historical = !personEligibleForProject(p.id, projectId, startDate, endDate);
    const suffix = historical ? ` · ${t('label.historicalAssignment')}` : borrowed ? ` · ${t('team.borrowed')}` : '';
    return `<option value="${p.id}" ${selectedIds.includes(String(p.id)) ? 'selected' : ''}>${esc(p.name + suffix)}</option>`;
  }).join('');
}

function bindAssignmentCandidateRefresh(preserveInitial = false) {
  const refresh = (preserve = false) => {
    const select = $('f_person');
    if (!select) return;
    const previous = selectedValues('f_person');
    select.innerHTML = assignmentPeopleOptions(val('f_project'), val('f_date'), val('f_end'), previous, preserve);
    if (!select.value && select.options.length && select.dataset.autoSelect === '1') select.selectedIndex = 0;
    updatePerDayHint();
  };
  refresh(preserveInitial);
  ['f_project', 'f_date', 'f_end'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', () => {
      // C2：切项目时重置需求选择器选项并清空 groupId（取代旧的 f_project→f_group 重置）。
      // 仅在统一表单挂载了需求选择器时生效；普通 f_group 已不存在。
      if (id === 'f_project') {
        const reqSelect = document.querySelector('.req-select[data-role="requirement-select"]');
        if (reqSelect) refreshRequirementSelectOptions(val('f_project'));
      }
      refresh(false);
    });
  });
  if ($('f_person')) $('f_person').addEventListener('change', updatePerDayHint);
}

// 名称去重建需求（§4.3「沿用现逻辑」）：同项目内同名（非归档）需求直接复用既有 id，否则新建。
// 返回 { id, created } —— created 区分「新建」与「命中既有」，回滚/undo 只能删 created=true 的群。
async function findOrCreateRequirement(projectId, fields) {
  const exist = assignmentGroupsForProject(projectId, true)
    .find(g => !g.archived && (g.name || '').trim() === (fields.name || '').trim());
  if (exist) return { id: exist.id, created: false };
  const r = await post('/api/assignment-groups', { projectId, ...fields });
  return { id: (r && r.id) || '', created: true };
}

// ── 统一排期/创建表单（W5，§7.1）──
// opts = { mode:'task'|'requirement', id?, personId?, projectId?, date?, groupId?, lockedGroupId? }
//   task 模式：仅做排期（行为等同旧 openAssignment/openAddAssignment），需求选择器隐藏。
//   requirement 模式：需求选择器置顶，可选「未归组/既有需求/＋新建需求」；lockedGroupId 锁定到既有需求。
export function openAssignmentForm(opts = {}) {
  const mode = opts.mode === 'requirement' ? 'requirement' : 'task';
  const editing = !!opts.id;
  const isReqMode = mode === 'requirement';
  const lockedGroupId = isReqMode ? (opts.lockedGroupId || '') : '';
  if (isReadOnlyMode()) { toast(t('toast.readonlyWrite')); return; }

  // ── 既有排期数据（编辑态）──
  let a = null;
  if (editing) {
    a = state.assignments.find(x => x.id === opts.id);
    if (!a) { toast(t('toast.notFound')); return; }
  }

  // ── 项目候选列表（含当前项目即使归档）──
  const curProjectId = editing ? a.projectId : (opts.projectId || '');
  const projectList = state.projects.filter(p => (!p.archived && (!activeTeam || p.teamId === activeTeam)) || p.id === curProjectId);
  const arc = p => p.archived ? ' ' + t('label.archivedSuffix') : '';

  // ── 默认值 ──
  let prId = curProjectId;
  if (!editing) {
    const activeProjects = projectList.filter(p => !p.archived);
    const d = opts.date || iso(new Date());
    if (!prId && opts.personId) {
      const eligible = activeProjects.find(p => personEligibleForProject(opts.personId, p.id, d, d));
      if (eligible) prId = eligible.id;
    }
    if (!prId) prId = activeProjects[0]?.id || '';
  }
  const initPersonId = editing ? a.personId : (opts.personId || '');
  const initDate = editing ? a.date : (opts.date || iso(new Date()));
  const initEnd = editing ? endOf(a) : (opts.date || iso(new Date()));
  const days = workingDays(initDate, initEnd);
  const totalH = editing ? Number((Number(a.hours || 0) * days).toFixed(1)) : 8;
  const perdayTxt = editing
    ? t('label.perdayShort', { d: days, perDay: (days > 0 ? (totalH / days) : 0).toFixed(1) })
    : t('label.perdayInit');
  // 需求预选：锁定优先 → opts.groupId → 既有排期的 groupId
  const initGroupId = lockedGroupId || (opts.groupId || (editing ? (a.groupId || '') : ''));

  // ── 字段渲染 ──
  // 锁定需求态（＋为此需求新增任务）：需求已绑定到固定项目，项目不可改。
  const projectLocked = !!lockedGroupId;
  const projectField = `<div><label>${t('label.project')}</label><select id="f_project"${projectLocked ? ' disabled' : ''}>${projectList.map(p => `<option value="${p.id}" ${p.id === prId ? 'selected' : ''}>${p.name}${arc(p)}</option>`).join('')}</select></div>`;
  // 需求下拉恒展示：新建/编辑、task/requirement 模式均可选/新建目标需求（锁定态除外）。
  const reqField = `<div><label>${t('label.requirement')}</label>${requirementSelectHTML(prId, initGroupId, { allowNew: !lockedGroupId })}</div>`;
  const dateRow = `<div class="form-row"><div><label>${t('label.startDate')}</label><input id="f_date" type="date" value="${initDate}"></div><div><label>${t('label.endDate')}</label><input id="f_end" type="date" value="${initEnd}"></div></div>`;
  const personSelectAttrs = editing ? '' : ' multiple size="4" data-auto-select="1"';
  const hoursRow = `<div class="form-row"><div><label>${editing ? t('label.totalHours') : t('label.totalHoursPerPerson')}</label><input id="f_total" type="number" value="${totalH}" min="0" oninput="window._updatePerDayHint()"><span id="f_perday" class="form-hint">${perdayTxt}</span></div><div><label>${editing ? t('label.person') : t('label.people')}</label><select id="f_person"${personSelectAttrs}></select><span class="form-hint">${editing ? '' : t('label.multiPeopleHint')}</span></div></div>`;
  const reqNewBlock = requirementNewFieldsHTML();
  const noteField = `<div><label>${t('label.note')}</label><textarea id="f_note">${esc(editing ? (a.note || '') : '')}</textarea></div>`;
  const initGroup = assignmentGroup(initGroupId);
  const initScheduleNote = initGroup ? (initGroup.name || '') : '';
  const scheduleRowsField = `<div><label>${t('label.assignmentRows')}</label>${requirementScheduleListHTML(prId, initDate, initEnd, '', initPersonId, initScheduleNote)}<span class="form-hint">${t('label.assignmentScheduleHint')}</span></div>`;
  const body = editing
    ? `<div class="form">${projectField}${reqField}${reqNewBlock}${dateRow}${hoursRow}${noteField}</div>`
    : `<div class="form">${projectField}${reqField}${reqNewBlock}${scheduleRowsField}</div>`;

  const title = editing
    ? t('title.editAssign')
    : (isReqMode ? t('title.addAssignRequirement') : t('title.addAssign'));

  showModal(title, body, save, editing ? onDeleteAssignment : null);

  // ── 表单初始化（showModal 注入 DOM 后）──
  if (editing) {
    $('f_person').dataset.initialPersonId = a.personId;
    $('f_person').innerHTML = assignmentPeopleOptions(prId, initDate, initEnd, initPersonId, true);
    bindAssignmentCandidateRefresh(true);
  } else {
    bindRequirementScheduleRows(() => val('f_project'), initDate, initEnd);
    setScheduleDefaultNote(initScheduleNote, true);
    const projectEl = $('f_project');
    if (projectEl) projectEl.addEventListener('change', () => {
      document.querySelectorAll('.req-schedule-row').forEach(row => {
        const select = row.querySelector('.req-row-person');
        const start = row.querySelector('.req-row-start')?.value || initDate;
        const end = row.querySelector('.req-row-end')?.value || start;
        const current = select ? select.value : '';
        if (select) select.innerHTML = assignmentPeopleOptions(val('f_project'), start, end, current, true);
      });
      setScheduleDefaultNote('', false);
      const reqSelect = document.querySelector('.req-select[data-role="requirement-select"]');
      if (reqSelect) refreshRequirementSelectOptions(val('f_project'));
    });
    const reqNameInput = $('f_reqName');
    if (reqNameInput) reqNameInput.addEventListener('input', () => {
      if (($('f_group')?.value || '') === REQ_NEW) setScheduleDefaultNote(reqNameInput.value.trim(), true);
    });
  }
  bindRequirementSelect(prId, {
    isLocked: () => !!lockedGroupId,
    onSelect: (value) => {
      // 选择「＋新建需求」→ 展开行内新建字段块
      const wrap = $('f_reqNewWrap');
      if (wrap) wrap.hidden = (value !== REQ_NEW);
      if (value === REQ_NEW) bindRequirementColorSwatches();
      if (!editing) {
        if (value === REQ_NEW) setScheduleDefaultNote(val('f_reqName'), true);
        else setScheduleDefaultNote(assignmentGroup(value)?.name || '', true);
      }
    }
  });
  // 若初始即锁定某需求，不展开新建块
  const wrap = $('f_reqNewWrap');
  if (wrap) wrap.hidden = true;

  // ── 保存（四路径）──
  async function save() {
    if (!editing) {
      const projectId = val('f_project');
      if (!projectId) return toast(t('toast.needProject'));
      const schedule = collectRequirementScheduleRows();
      if (schedule.error) return toast(schedule.error);
      const rows = schedule.rows || [];
      if (!rows.length) return toast(t('toast.personRequired'));

      const proj = state.projects.find(x => x.id === projectId);
      for (const row of rows) {
        if (proj && proj.startDate && row.date && row.date < proj.startDate) return toast(t('toast.assignStartBefore') + proj.startDate);
        if (proj && proj.endDate && row.endDate && row.endDate > proj.endDate) return toast(t('toast.assignEndAfter') + proj.endDate);
      }

      const gInp = $('f_group');
      const selection = gInp ? gInp.value : '';
      const isNew = selection === REQ_NEW;
      let groupId = isNew ? '' : (selection || '');
      let createdNew = false;
      const createdAssignmentIds = [];
      try {
        if (isNew) {
          const name = val('f_reqName');
          if (!name) return toast(t('toast.requirementNameRequired'));
          const startDate = rows.reduce((min, row) => !min || row.date < min ? row.date : min, '');
          const endDate = rows.reduce((max, row) => !max || row.endDate > max ? row.endDate : max, '');
          const res = await findOrCreateRequirement(projectId, {
            name,
            ownerId: val('f_reqOwner'),
            color: val('f_color'),
            description: val('f_reqDesc'),
            startDate,
            endDate
          });
          groupId = res.id;
          createdNew = res.created;
          if (!groupId) throw new Error(t('toast.savedRequirement'));
        }
        for (const row of rows) {
          const r = await post('/api/assignments', { ...row, projectId, groupId });
          if (r && r.id) createdAssignmentIds.push(r.id);
        }
        closeModal(); await reloadAll(); toast(t('toast.addedAssign'));
      } catch (err) {
        for (const id of createdAssignmentIds) { try { await del('/api/assignments/' + id); } catch (_) { /* 尽量回滚 */ } }
        if (createdNew && groupId) { try { await del('/api/assignment-groups/' + groupId); } catch (_) { /* 尽量回滚 */ } }
        toast(err.message);
      }
      return;
    }

    const sd = val('f_date'), ed = val('f_end');
    const projectId = val('f_project');
    const personIds = editing ? [val('f_person')].filter(Boolean) : selectedValues('f_person');
    const personId = personIds[0] || '';
    const tot = Number(val('f_total') || 0);
    const wd = workingDays(sd, ed);
    const hours = wd > 0 ? Math.round(tot / wd * 10) / 10 : 8;
    const note = val('f_note');

    // 基础校验
    if (!projectId) return toast(t('toast.needProject'));
    if (sd && ed && ed < sd) return toast(t('toast.dateRangeInvalid'));

    // 当前需求选择值：统一表单挂载了需求选择器（requirement 模式 / task 编辑态）时读取；否则 ''。
    const gInp = $('f_group');
    let selection = gInp ? gInp.value : '';
    const isNew = selection === REQ_NEW;

    // 人员规则（单一，§4.3）：仅 requirement + ＋新建 可不选人（=空需求）；其余必填
    const personOptional = isReqMode && isNew;
    if (!personOptional && !personIds.length) return toast(t('toast.personRequired'));

    // 项目范围校验（既有行为：未归组/既有需求路径沿用旧 toast）
    const proj = state.projects.find(x => x.id === projectId);
    if (proj && proj.startDate && sd && sd < proj.startDate) return toast(t('toast.assignStartBefore') + proj.startDate);
    if (proj && proj.endDate && ed && ed > proj.endDate) return toast(t('toast.assignEndAfter') + proj.endDate);

    // ── 路径 4：requirement + ＋新建 + 无人员 → 只建群（空需求），周期=日期范围 ──
    if (isNew && !personIds.length) {
      const name = val('f_reqName');
      if (!name) return toast(t('toast.requirementNameRequired'));
      const gPeriod = { startDate: sd, endDate: ed };
      try {
        await findOrCreateRequirement(projectId, { name, ownerId: val('f_reqOwner'), color: val('f_color'), description: val('f_reqDesc'), ...gPeriod });
        closeModal(); await reloadAll(); toast(t('toast.savedRequirement'));
      } catch (err) { toast(err.message); }
      return;
    }

    // ── 路径 3：＋新建 + 有人员 → 先校验项目范围（防 _validate_project_dates 400 孤儿），建群→建排期，失败回滚群 ──
    if (isNew && personIds.length) {
      const name = val('f_reqName');
      if (!name) return toast(t('toast.requirementNameRequired'));
      const gPeriod = { startDate: sd, endDate: ed };
      let newId = '', createdNew = false;
      try {
        const res = await findOrCreateRequirement(projectId, { name, ownerId: val('f_reqOwner'), color: val('f_color'), description: val('f_reqDesc'), ...gPeriod });
        newId = res.id; createdNew = res.created;
        if (!newId) throw new Error(t('toast.savedRequirement'));
      } catch (err) { toast(err.message); return; }
      // 建排期挂到该群；失败回滚——但仅当本轮真的新建了群（createdNew），避免误删去重命中的既有需求（M5/B-1）
      const createdAssignmentIds = [];
      try {
        if (editing) {
          await put('/api/assignments/' + opts.id, { personId, projectId, groupId: newId, date: sd, endDate: ed, hours, note });
        } else {
          for (const pid of personIds) {
            const r = await post('/api/assignments', { personId: pid, projectId, groupId: newId, date: sd, endDate: ed, hours, note });
            if (r && r.id) createdAssignmentIds.push(r.id);
          }
        }
        closeModal(); await reloadAll(); toast(editing ? t('toast.savedAssign') : t('toast.addedAssign'));
      } catch (err) {
        for (const id of createdAssignmentIds) { try { await del('/api/assignments/' + id); } catch (_) { /* 尽量回滚 */ } }
        // 回滚群：直接 del（不 pushUndo）；仅删本轮新建的群，不动去重命中的既有需求。
        if (createdNew && newId) { try { await del('/api/assignment-groups/' + newId); } catch (_) { /* 尽量回滚 */ } }
        toast(err.message);
      }
      return;
    }

    // ── 路径 1（未归组）/ 路径 2（既有需求）+ 人员 ──
    const groupId = selection === REQ_NEW ? '' : (selection || '');
    const payload = { personId, projectId, groupId, date: sd, endDate: ed, hours, note };
    try {
      if (editing) await put('/api/assignments/' + opts.id, payload);
      else {
        const createdAssignmentIds = [];
        try {
          for (const pid of personIds) {
            const r = await post('/api/assignments', { ...payload, personId: pid });
            if (r && r.id) createdAssignmentIds.push(r.id);
          }
        } catch (err) {
          for (const id of createdAssignmentIds) { try { await del('/api/assignments/' + id); } catch (_) { /* 尽量回滚 */ } }
          throw err;
        }
      }
      closeModal(); await reloadAll(); toast(editing ? t('toast.savedAssign') : t('toast.addedAssign'));
    } catch (err) { toast(err.message); }
  }

  async function onDeleteAssignment() {
    await del('/api/assignments/' + opts.id);
    closeModal(); await reloadAll(); toast(t('toast.deletedAssign'));
  }
}

// ── 旧入口 openAssignment/openAddAssignment 已移除：全部调用点直连统一表单 openAssignmentForm（DoD #11）──

// ── 里程碑表单 ──
export function openMilestone(id) {
  let m = id ? state.milestones.find(x => x.id === id) : { projectId: state.projects.filter(p => !p.archived)[0]?.id || '', name: '', date: iso(new Date()), level: 'important', ownerId: '', description: '' };
  const projectList = state.projects.filter(p => (!p.archived && (!activeTeam || p.teamId === activeTeam)) || p.id === m.projectId);
  const arc = p => p.archived ? ' ' + t('label.archivedSuffix') : '';

  showModal(
    id ? t('title.editMilestone') : t('title.addMilestone'),
    `<div class="form"><div class="form-row"><div><label>${t('label.milestoneName')}</label><input id="f_name" value="${esc(m.name || '')}"></div><div><label>${t('label.date')}</label><input id="f_date" type="date" value="${m.date || iso(new Date())}"></div></div><div class="form-row"><div><label>${t('label.project')}</label><select id="f_project">${projectList.map(p => `<option value="${p.id}" ${m.projectId === p.id ? 'selected' : ''}>${p.name}${arc(p)}</option>`).join('')}</select></div><div><label>${t('label.level')}</label><select id="f_level"><option value="important" ${m.level === 'important' ? 'selected' : ''}>${t('label.levelImportant')}</option><option value="risk" ${m.level === 'risk' ? 'selected' : ''}>${t('label.levelRisk')}</option></select></div></div><div><label>${t('label.assignee')}</label><select id="f_owner">${peopleOptions(m.ownerId)}</select></div><div><label>${t('label.desc')}</label><textarea id="f_desc">${esc(m.description || '')}</textarea></div></div>`,
    async () => {
      let d = { name: val('f_name'), date: val('f_date'), projectId: val('f_project'), level: val('f_level'), ownerId: val('f_owner'), description: val('f_desc') };
      if (!d.name) return toast(t('toast.needMilestoneName'));
      if (!d.projectId) return toast(t('toast.needProject'));
      id ? await put('/api/milestones/' + id, d) : await post('/api/milestones', d);
      closeModal(); await reloadAll(); toast(t('toast.savedMilestone'));
    },
    id ? async () => { await del('/api/milestones/' + id); closeModal(); await reloadAll(); toast(t('toast.deletedMilestone')); } : null
  );
}

// ── 需求编辑表单 + 色板（W4，§6.1/§7.2）──
// 色板：固定调色板行（独立于 custom-select，本波即可完成）。
const REQUIREMENT_PALETTE = [
  '#7db7ff', '#92d987', '#ffb84d', '#b69cff', '#ff9f9f', '#7ee0d6',
  '#ffd86b', '#c4a484', '#b8e986', '#f7a8d8', '#9ad1ff', '#d4b5ff'
];
// 渲染色板 HTML；selected 为当前色值。点击色块切换隐藏 input 的值。
export function requirementColorSwatchesHTML(selected) {
  const cur = selected || REQUIREMENT_PALETTE[0];
  const swatches = REQUIREMENT_PALETTE.map(c =>
    `<button type="button" class="color-swatch${c === cur ? ' selected' : ''}" data-color="${esc(c)}" style="background:${c}" aria-label="${esc(c)}"></button>`
  ).join('');
  return `<div class="color-swatches" data-role="requirement-color">${swatches}<input type="hidden" id="f_color" value="${esc(cur)}"></div>`;
}
// 绑定色板点击（modal 打开后调用）：更新隐藏 input 与选中态。
function bindRequirementColorSwatches() {
  const box = document.querySelector('.color-swatches[data-role="requirement-color"]');
  if (!box) return;
  const input = box.querySelector('#f_color');
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.color-swatch');
    if (!btn) return;
    if (input) input.value = btn.dataset.color || '';
    box.querySelectorAll('.color-swatch').forEach(b => b.classList.toggle('selected', b === btn));
  });
}

function requirementScheduleRowHTML(projectId, startDate, endDate, selectedPersonId = '', totalHours = '8', assignmentId = '', note = '') {
  const start = startDate || iso(new Date());
  const end = endDate || start;
  return `<div class="req-schedule-row" data-role="req-schedule-row">
    <input class="req-row-id" type="hidden" value="${esc(assignmentId)}">
    <select class="req-row-person">${assignmentPeopleOptions(projectId, start, end, selectedPersonId, true)}</select>
    <input class="req-row-start" type="date" value="${esc(start)}">
    <input class="req-row-end" type="date" value="${esc(end)}">
    <input class="req-row-hours" type="number" min="0" step="0.5" value="${esc(totalHours)}" placeholder="${esc(t('label.totalHoursH'))}">
    <input class="req-row-note" value="${esc(note)}" placeholder="${esc(t('label.note'))}">
    <button type="button" class="req-row-remove" title="${esc(t('label.remove'))}">×</button>
  </div>`;
}

function requirementAssignmentFormula(a) {
  const days = workingDays(a.date, endOf(a));
  return String(Math.round(Number(a.hours || 0) * days * 10) / 10);
}

function requirementScheduleListHTML(projectId, startDate, endDate, groupId = '', selectedPersonId = '', defaultNote = '') {
  const children = groupId
    ? state.assignments
      .filter(a => a.groupId === groupId)
      .sort((a, b) => a.date.localeCompare(b.date) || endOf(a).localeCompare(endOf(b)) || String(a.personId).localeCompare(String(b.personId)))
    : [];
  const rowHtml = children.length
    ? children.map(a => requirementScheduleRowHTML(projectId, a.date, endOf(a), a.personId, requirementAssignmentFormula(a), a.id, a.note || '')).join('')
    : requirementScheduleRowHTML(projectId, startDate, endDate, selectedPersonId, '8', '', defaultNote);
  return `<div class="req-schedule-list" data-role="req-schedule-list">
    <div class="req-schedule-head">
      <span>${esc(t('label.person'))}</span>
      <span>${esc(t('label.startDate'))}</span>
      <span>${esc(t('label.endDate'))}</span>
      <span>${esc(t('label.totalHoursH'))}</span>
      <span>${esc(t('label.note'))}</span>
      <span></span>
    </div>
    <div id="f_reqScheduleRows">${rowHtml}</div>
    <button type="button" class="req-add-row" id="f_reqAddRow">${esc(t('btn.addScheduleRow'))}</button>
  </div>`;
}

function evalHoursFormula(expr, days) {
  const normalized = String(expr || '')
    .trim()
    .replace(/[×x]/g, '*')
    .replace(/÷/g, '/')
    .replace(/\bd\b/gi, String(days));
  if (!normalized) return 0;
  if (!/^[0-9+\-*/().\s]+$/.test(normalized)) return NaN;
  try {
    const value = Function('"use strict"; return (' + normalized + ')')();
    return Number.isFinite(value) ? Number(value) : NaN;
  } catch (_) {
    return NaN;
  }
}

function bindRequirementScheduleRows(projectId, defaultStart = '', defaultEnd = '') {
  const rows = $('f_reqScheduleRows');
  if (!rows) return;
  const currentProjectId = () => (typeof projectId === 'function' ? projectId() : projectId);
  const refreshPersonOptions = (row) => {
    const select = row.querySelector('.req-row-person');
    const start = row.querySelector('.req-row-start')?.value || iso(new Date());
    const end = row.querySelector('.req-row-end')?.value || start;
    const current = select ? select.value : '';
    if (select) select.innerHTML = assignmentPeopleOptions(currentProjectId(), start, end, current, true);
  };
  rows.addEventListener('change', (e) => {
    const row = e.target.closest('.req-schedule-row');
    if (row && (e.target.classList.contains('req-row-start') || e.target.classList.contains('req-row-end'))) {
      refreshPersonOptions(row);
    }
  });
  rows.addEventListener('click', (e) => {
    const btn = e.target.closest('.req-row-remove');
    if (!btn) return;
    const row = btn.closest('.req-schedule-row');
    if (row) row.remove();
  });
  const add = $('f_reqAddRow');
  if (add) add.addEventListener('click', () => {
    const start = val('f_start') || val('f_date') || defaultStart || iso(new Date());
    const end = val('f_end') || defaultEnd || start;
    rows.insertAdjacentHTML('beforeend', requirementScheduleRowHTML(currentProjectId(), start, end, '', '8', '', rows.dataset.defaultNote || ''));
  });
}

function setScheduleDefaultNote(note, overwriteEmptyRows = false) {
  const rows = $('f_reqScheduleRows');
  if (!rows) return;
  rows.dataset.defaultNote = note || '';
  if (!overwriteEmptyRows) return;
  rows.querySelectorAll('.req-row-note').forEach(input => {
    if (!input.value) input.value = note || '';
  });
}

function collectRequirementScheduleRows(defaultNote = '') {
  const result = [];
  const rows = Array.from(document.querySelectorAll('.req-schedule-row'));
  for (const row of rows) {
    const personId = row.querySelector('.req-row-person')?.value || '';
    const assignmentId = row.querySelector('.req-row-id')?.value || '';
    const start = row.querySelector('.req-row-start')?.value || '';
    const end = row.querySelector('.req-row-end')?.value || '';
    const totalInput = row.querySelector('.req-row-hours')?.value || '';
    const note = row.querySelector('.req-row-note')?.value || defaultNote || '';
    const hasAny = personId || start || end || totalInput.trim() || note.trim();
    if (!hasAny) continue;
    if (!personId) return { error: t('toast.personRequired') };
    if (!start || !end || end < start) return { error: t('toast.dateRangeInvalid') };
    const days = workingDays(start, end);
    const total = Number(totalInput);
    if (!Number.isFinite(total) || total <= 0) return { error: t('toast.invalidTotalHours') };
    const hours = days > 0 ? Math.round(total / days * 10) / 10 : total;
    result.push({ id: assignmentId, personId, date: start, endDate: end, hours, note });
  }
  return { rows: result };
}

async function saveRequirementScheduleRows(projectId, groupId, requirementName) {
  const schedule = collectRequirementScheduleRows(requirementName);
  if (schedule.error) {
    toast(schedule.error);
    return false;
  }
  const scheduleRows = schedule.rows || [];
  const existingIds = state.assignments
    .filter(a => a.groupId === groupId)
    .map(a => a.id);
  const keptIds = new Set(scheduleRows.map(x => x.id).filter(Boolean));
  const removedIds = existingIds.filter(id => !keptIds.has(id));
  if (removedIds.length && !confirm(t('confirm.deleteScheduleRows', { n: removedIds.length }))) return false;

  const createdAssignmentIds = [];
  try {
    for (const id of removedIds) await del('/api/assignments/' + id);
    for (const item of scheduleRows) {
      if (item.id) {
        await put('/api/assignments/' + item.id, { ...item, projectId, groupId });
      } else {
        const r = await post('/api/assignments', { ...item, projectId, groupId });
        if (r && r.id) createdAssignmentIds.push(r.id);
      }
    }
    return true;
  } catch (err) {
    for (const id of createdAssignmentIds) { try { await del('/api/assignments/' + id); } catch (_) { /* 尽量回滚 */ } }
    toast(err.message);
    return false;
  }
}

// 新建/编辑需求自身字段（§7.2），并可选为多人追加排期。
// 需求的新建/编辑共用表单（§6.2）。groupId 为空 → 新建（POST）；否则编辑（PUT）。
// 新建与编辑字段完全一致（名称/颜色/负责人/说明/周期），仅标题、保存动作、删除按钮不同——保证两态视觉统一。
export function openRequirementEditor(groupId, projectId, opts = {}) {
  const isNew = !groupId;
  const g = isNew ? null : assignmentGroup(groupId);
  if (!isNew && !g) return;
  if (isReadOnlyMode()) { toast(t('toast.readonlyWrite')); return; }
  const prId = projectId || (g ? g.projectId : '');
  const projectList = state.projects.filter(p => (!p.archived && (!activeTeam || p.teamId === activeTeam)) || p.id === prId);
  const projectField = `<div><label>${t('label.project')}</label><select id="f_reqProject" disabled>${projectList.map(p => `<option value="${esc(p.id)}"${p.id === prId ? ' selected' : ''}>${esc(p.name || '')}${p.archived ? ' ' + esc(t('label.archivedSuffix')) : ''}</option>`).join('')}</select></div>`;
  const ownerSelect = `<select id="f_owner">${peopleOptions(g ? (g.ownerId || '') : '')}</select>`;
  const initStart = g ? (g.startDate || '') : (opts.date || '');
  const initEnd = g ? (g.endDate || '') : (opts.date || '');
  const body = `<div class="form">` +
    projectField +
    `<div><label>${t('label.requirementName')}</label><input id="f_name" value="${esc(g ? (g.name || '') : '')}"></div>` +
    `<div><label>${t('label.requirementColor')}</label>${requirementColorSwatchesHTML(g ? (g.color || '') : '')}</div>` +
    `<div><label>${t('label.requirementOwner')}</label>${ownerSelect}</div>` +
    `<div><label>${t('label.requirementDesc')}</label><textarea id="f_desc">${esc(g ? (g.description || '') : '')}</textarea></div>` +
    `<div class="form-row"><div><label>${t('label.requirementStart')}</label><input id="f_start" type="date" value="${initStart}"></div><div><label>${t('label.requirementEnd')}</label><input id="f_end" type="date" value="${initEnd}"></div></div>` +
    `<div><label>${t('label.scheduleRowsOptional')}</label>${requirementScheduleListHTML(prId, initStart, initEnd, groupId)}<span class="form-hint">${t('label.requirementScheduleHint')}</span></div>` +
    `</div>`;
  showModal(
    isNew ? t('title.addRequirement') : t('title.editRequirement'),
    body,
    async () => {
      const name = val('f_name');
      if (!name) return toast(t('toast.requirementNameRequired'));
      const sd = val('f_start'), ed = val('f_end');
      // B2 校验（§4.3/§7.2）：无子任务且周期被清空 → 阻止（避免孤儿不可见）。新建恒无子任务，周期由点击格日期预填。
      const hasChildren = !isNew && state.assignments.some(a => a.groupId === groupId);
      if (!hasChildren && !sd && !ed) return toast(t('toast.requirementPeriodRequired'));
      if (sd && ed && ed < sd) return toast(t('toast.dateRangeInvalid'));
      const d = { projectId: prId, name, ownerId: val('f_owner'), color: val('f_color'), description: val('f_desc'), startDate: sd, endDate: ed };
      let targetGroupId = groupId;
      const createdAssignmentIds = [];
      try {
        if (isNew) {
          const r = await post('/api/assignment-groups', d);
          targetGroupId = (r && r.id) || '';
        } else {
          await put('/api/assignment-groups/' + groupId, d);
        }
        const schedule = collectRequirementScheduleRows(name);
        if (schedule.error) throw new Error(schedule.error);
        for (const item of schedule.rows || []) {
          const r = item.id
            ? await put('/api/assignments/' + item.id, { ...item, projectId: prId, groupId: targetGroupId })
            : await post('/api/assignments', { ...item, projectId: prId, groupId: targetGroupId });
          if (!item.id && r && r.id) createdAssignmentIds.push(r.id);
        }
      } catch (err) {
        for (const id of createdAssignmentIds) { try { await del('/api/assignments/' + id); } catch (_) { /* 尽量回滚 */ } }
        if (isNew && targetGroupId) { try { await del('/api/assignment-groups/' + targetGroupId); } catch (_) { /* 尽量回滚 */ } }
        return toast(err.message);
      }
      closeModal(); await reloadAll(); toast(isNew ? t('toast.addedRequirement') : t('toast.savedRequirement'));
    },
    isNew ? null : async () => { closeModal(); await deleteRequirement(groupId); }
  );
  bindRequirementColorSwatches();
  bindRequirementScheduleRows(prId, initStart, initEnd);
  setScheduleDefaultNote(g ? (g.name || '') : '', true);
  const reqNameInput = $('f_name');
  if (reqNameInput) reqNameInput.addEventListener('input', () => setScheduleDefaultNote(reqNameInput.value.trim(), false));
}

export function openRequirementScheduleEditor(groupId, projectId, opts = {}) {
  const g = assignmentGroup(groupId);
  if (!g) return;
  if (isReadOnlyMode()) { toast(t('toast.readonlyWrite')); return; }
  const pr = project(projectId || g.projectId);
  const start = opts.date || g.startDate || iso(new Date());
  const end = g.endDate || start;
  const body = `<div class="form">
    <div class="regroup-summary">${esc(pr ? pr.name : '')} · ${esc(g.name || '')}</div>
    ${requirementScheduleListHTML(g.projectId, start, end, groupId)}
    <span class="form-hint">${t('label.requirementScheduleEditHint')}</span>
  </div>`;
  showModal(
    t('title.editRequirementSchedule'),
    body,
    async () => {
      const ok = await saveRequirementScheduleRows(g.projectId, groupId, g.name || '');
      if (!ok) return;
      closeModal(); await reloadAll(); toast(t('toast.savedAssign'));
    },
    null
  );
  bindRequirementScheduleRows(g.projectId, start, end);
  setScheduleDefaultNote(g.name || '', true);
}

// 删除需求（§6.1，删前快照 + PUT 回填归属；undo 用 PUT 而非 POST 重建）。
// DELETE 只清空子排期 group_id（不删行），故 undo 重建群取新 id 后逐条 PUT 回填。
export async function deleteRequirement(id) {
  const g = assignmentGroup(id);
  if (!g) return;
  if (isReadOnlyMode()) { toast(t('toast.readonlyWrite')); return; }
  const name = g.name;
  // 删前快照：仅需子排期 id 列表（归属用 undo 时重建群的新 id 回填）。
  const childIds = state.assignments.filter(a => a.groupId === id).map(a => a.id);
  // {name}/{n} 同源（B-5）：confirm 与快照同一次遍历的 childIds.length。
  const msg = childIds.length
    ? t('confirm.deleteRequirement', { name, n: childIds.length })
    : t('confirm.deleteRequirementEmpty', { name });
  if (!confirm(msg)) return;
  // 保存群字段（闭包捕获），undo 时忠实重建。
  const saved = {
    projectId: g.projectId, name: g.name, ownerId: g.ownerId || '',
    color: g.color || '', description: g.description || '',
    startDate: g.startDate || '', endDate: g.endDate || ''
  };
  await del('/api/assignment-groups/' + id);
  pushUndo({
    label: t('undo.deletedRequirement'),
    run: async () => {
      // 1) 重建群（POST）取新 id；2) 对每个 childId PUT 回填 groupId=新id（不重建排期行）。
      const r = await post('/api/assignment-groups', saved);
      const newId = (r && r.id) || '';
      if (newId) {
        for (const cid of childIds) {
          try { await put('/api/assignments/' + cid, { groupId: newId }); } catch (_) { /* 尽量恢复 */ }
        }
      }
      await reloadAll();
    }
  });
  await reloadAll();
  undoToast(t('undo.deletedRequirement'));
}

// ── 未归组「收件箱」归入（W7，§6.5 P0-D）──
// 未归组块右键 / 双击入口：勾选该项目的未归组子任务 → 归入现有需求或新建需求（批量改 groupId）。
// 目标群沿用同一 projectId（不跨项目）；新建目标群不走项目范围预校验（B-7：被移动排期日期/项目不变，仅 groupId 变）。
export function openRegroupPicker(projectId) {
  const pr = project(projectId);
  const prName = pr ? pr.name : '';

  // 只读模式：拦截写操作（查看放行，但无保存意义——此处直接拦截打开，提示后返回）
  if (isReadOnlyMode()) { toast(t('toast.readonlyWrite')); return; }

  // ── 候选清单：该项目的未归组排期（groupId=''）──
  const items = ungroupedAssignmentsOf(projectId);

  // 单行：☑ 人员名  日期范围  工时  备注
  const itemRow = (a) => {
    const p = person(a.personId);
    const name = p ? p.name : t('label.unassigned');
    const ed = endOf(a);
    const range = (a.date === ed) ? a.date : (a.date + ' ~ ' + ed);
    const hrs = Number(a.hours || 0);
    const hasNote = !!(a.note && String(a.note).trim());
    const note = hasNote ? esc(a.note) : esc(t('label.noNote'));
    const noteCls = 'regroup-note' + (hasNote ? '' : ' regroup-note--empty');
    return `<li class="regroup-item" data-id="${esc(a.id)}">
      <label class="regroup-check"><input type="checkbox" data-id="${esc(a.id)}" checked></label>
      <span class="regroup-name">${esc(name)}</span>
      <span class="regroup-meta">${esc(range)}</span>
      <span class="regroup-meta regroup-hours">${esc(String(hrs))}${esc(t('label.hoursUnit'))}</span>
      <span class="${noteCls}" title="${esc(a.note || '')}">${note}</span>
    </li>`;
  };

  // 空态 vs 清单
  const listHTML = items.length
    ? `<ul class="regroup-list">${items.map(itemRow).join('')}</ul>`
    : `<div class="regroup-empty">${esc(t('empty.ungrouped'))}</div>`;

  // 目标选择器：现有需求 ▾（含 ＋新建）。allowNew=true，无 lockedGroupId。
  // 复用 requirementSelectHTML/bindRequirementSelect（其内部按 #f_group 读写 hidden input，
  // 本 modal 无并行表单，沿用该约定即可）。
  const targetSelect = requirementSelectHTML(projectId, '', { allowNew: true });

  // ＋新建行内字段块（名称* + 颜色 + 负责人 + 说明）。不收集周期（B-7：被移动排期保留自身日期）。
  const newBlock = requirementNewFieldsHTML();

  const body = `<div class="form regroup-picker">
    <div class="regroup-section-title">${esc(t('label.regroupChildren'))}</div>
    ${listHTML}
    <div class="regroup-target">
      <label>${esc(t('label.regroupTarget'))}</label>
      ${targetSelect}
    </div>
    ${newBlock}
  </div>`;

  showModal(
    t('title.regroupChildren') + (prName ? ' · ' + prName : ''),
    body,
    save,
    null
  );

  // ── 表单初始化（DOM 注入后）──
  const hasItems = items.length > 0;
  // 清单全选/反选 + 行选中态联动
  const listEl = document.querySelector('.regroup-list');
  if (listEl) {
    listEl.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"][data-id]');
      if (!cb) return;
      const li = listEl.querySelector('.regroup-item[data-id="' + cb.dataset.id + '"]');
      if (li) li.classList.toggle('selected', cb.checked);
    });
    // 初始选中态（默认全勾选）
    listEl.querySelectorAll('.regroup-item').forEach(li => li.classList.add('selected'));
  }
  // 现有/新建目标选择器绑定
  bindRequirementSelect(projectId, {
    onSelect: (value) => {
      const wrap = $('f_reqNewWrap');
      if (wrap) wrap.hidden = (value !== REQ_NEW);
      if (value === REQ_NEW) bindRequirementColorSwatches();
    }
  });
  // 新建块默认隐藏（默认选「未归组」占位 → 切到 ＋新建 才展开）
  const wrap0 = $('f_reqNewWrap');
  if (wrap0) wrap0.hidden = true;

  // 无候选时禁用保存键
  if (!hasItems) {
    const saveBtn = $('modalSave');
    if (saveBtn) { saveBtn.style.opacity = '.5'; saveBtn.style.pointerEvents = 'none'; }
  }

  // ── 保存：批量 PUT groupId ──
  async function save() {
    // 1) 收集勾选项
    const checked = [];
    if (listEl) {
      listEl.querySelectorAll('input[type="checkbox"][data-id]').forEach(cb => {
        if (cb.checked) checked.push(cb.dataset.id);
      });
    }
    if (!checked.length) return toast(t('toast.selectAtLeastOne'));

    // 2) 解析目标 groupId
    const targetInput = $('f_group');
    const selection = targetInput ? targetInput.value : '';
    const isNew = selection === REQ_NEW;

    let targetId = '', createdNew = false;
    if (isNew) {
      // ＋新建：名称必填；调 findOrCreateRequirement（name 去重，返回既有或新建 id）。
      // B-7：不做项目范围预校验。
      const name = val('f_reqName');
      if (!name) return toast(t('toast.requirementNameRequired'));
      try {
        const res = await findOrCreateRequirement(projectId, {
          name,
          ownerId: val('f_reqOwner'),
          color: val('f_color'),
          description: val('f_reqDesc')
          // 不传 startDate/endDate：被移动排期保留自身日期；新群不设周期
        });
        targetId = res.id; createdNew = res.created;
      } catch (err) { toast(err.message); return; }
      if (!targetId) return toast(t('toast.requirementNameRequired'));
    } else {
      // 现有需求：必须有选中（空 = 未归组占位，无意义）
      targetId = selection || '';
      if (!targetId) return toast(t('toast.selectRequirement'));
    }

    // 3) 删前快照（忠实 undo）：每条记录 { id, before } —— before 为 ''（未归组）
    const snapshot = checked.map(id => {
      const a = state.assignments.find(x => x.id === id);
      return { id, before: a ? (a.groupId || '') : '' };
    });

    // 4) 应用：Promise.allSettled 逐条 PUT
    const results = await Promise.allSettled(
      snapshot.map(s => put('/api/assignments/' + s.id, { groupId: targetId }))
    );

    // 统计：成功 / 失败
    const applied = snapshot.filter((s, i) => results[i].status === 'fulfilled');
    const rejectedCount = results.length - applied.length;

    // 5) undo：仅还原「成功应用」的条目到各自 before groupId
    const appliedSnapshot = applied; // { id, before }
    if (appliedSnapshot.length) {
      pushUndo({
        label: t('undo.regrouped'),
        run: async () => {
          await Promise.allSettled(
            appliedSnapshot.map(s => put('/api/assignments/' + s.id, { groupId: s.before }))
          );
          await reloadAll();
        }
      });
    }

    await reloadAll();

    if (!appliedSnapshot.length) {
      // 全失败：不关弹窗、不提供 undo。若本轮新建了目标群（无人归入），回滚该孤儿空需求（与 M5/B-1 同源）。
      if (createdNew && targetId) { try { await del('/api/assignment-groups/' + targetId); } catch (_) { /* 尽量回滚 */ } }
      toast(t('toast.regroupSomeFailed', { ok: 0, fail: rejectedCount }));
      return;
    }

    closeModal();
    if (rejectedCount > 0) {
      // 部分失败：汇总 toast（成功数 / 失败数）；仍提供 undo（仅还原成功项）
      toast(t('toast.regroupSomeFailed', { ok: applied.length, fail: rejectedCount }));
    } else {
      toast(t('toast.regrouped', { n: applied.length }));
    }
    undoToast(t('undo.regrouped'));
  }
}

// ── 单条排期归属到需求（任务视图右键入口）──
// 与 openRegroupPicker（批量）同源的「目标选择器 + ＋新建」交互，但作用于单条排期：
// 选择已有需求 / 未归组 / ＋新建 → PUT groupId（保留自身日期/项目，B-7）+ 单步 undo。
export function openAssignToRequirement(id) {
  const a = state.assignments.find(x => x.id === id);
  if (!a) { toast(t('toast.notFound')); return; }
  if (isReadOnlyMode()) { toast(t('toast.readonlyWrite')); return; }

  const pr = project(a.projectId);
  const prName = pr ? pr.name : '';
  const p = person(a.personId);
  const name = p ? p.name : t('label.unassigned');
  const ed = endOf(a);
  const range = (a.date === ed) ? a.date : (a.date + ' ~ ' + ed);

  // 目标选择器：当前 groupId 预选；allowNew=true（可新建需求）。
  const targetSelect = requirementSelectHTML(a.projectId, a.groupId || '', { allowNew: true });
  const newBlock = requirementNewFieldsHTML();

  const body = `<div class="form regroup-picker">
    <div class="regroup-summary">${esc(name)} · ${esc(range)}</div>
    <div class="regroup-target">
      <label>${esc(t('label.regroupTarget'))}</label>
      ${targetSelect}
    </div>
    ${newBlock}
  </div>`;

  showModal(t('title.assignToRequirement') + (prName ? ' · ' + prName : ''), body, save, null);

  // ── 表单初始化（DOM 注入后）──
  bindRequirementSelect(a.projectId, {
    onSelect: (value) => {
      const wrap = $('f_reqNewWrap');
      if (wrap) wrap.hidden = (value !== REQ_NEW);
      if (value === REQ_NEW) bindRequirementColorSwatches();
    }
  });
  const wrap0 = $('f_reqNewWrap');
  if (wrap0) wrap0.hidden = true;

  // ── 保存：PUT groupId（单条）──
  async function save() {
    const targetInput = $('f_group');
    const selection = targetInput ? targetInput.value : '';
    const isNew = selection === REQ_NEW;

    let targetId = '', createdNew = false;
    if (isNew) {
      const newName = val('f_reqName');
      if (!newName) return toast(t('toast.requirementNameRequired'));
      try {
        const res = await findOrCreateRequirement(a.projectId, {
          name: newName,
          ownerId: val('f_reqOwner'),
          color: val('f_color'),
          description: val('f_reqDesc')
          // 不传周期：被移动排期保留自身日期（B-7）
        });
        targetId = res.id; createdNew = res.created;
      } catch (err) { toast(err.message); return; }
      if (!targetId) return toast(t('toast.requirementNameRequired'));
    } else {
      targetId = selection || ''; // 允许空 = 移回未归组
    }

    const before = a.groupId || '';
    try {
      await put('/api/assignments/' + id, { groupId: targetId });
    } catch (err) {
      // 失败回滚：仅删本轮新建的孤儿空需求（与 M5/B-1 同源）
      if (createdNew && targetId) { try { await del('/api/assignment-groups/' + targetId); } catch (_) { /* 尽量回滚 */ } }
      toast(err.message);
      return;
    }

    pushUndo({
      label: t('undo.assignedToRequirement'),
      run: async () => {
        try { await put('/api/assignments/' + id, { groupId: before }); } catch (_) { /* 尽量还原 */ }
        await reloadAll();
      }
    });

    closeModal();
    await reloadAll();
    toast(t('toast.assignedToRequirement'));
    undoToast(t('undo.assignedToRequirement'));
  }
}

// ── 快速新增里程碑 ──
export function openAddMilestone(projectId, date) {
  const activeProjects = state.projects.filter(p => !p.archived && (!activeTeam || p.teamId === activeTeam));
  const prId = projectId || activeProjects[0]?.id || '';
  const d = date || iso(new Date());

  showModal(
    t('title.addMilestone'),
    `<div class="form"><div class="form-row"><div><label>${t('label.milestoneName')}</label><input id="f_name" value=""></div><div><label>${t('label.date')}</label><input id="f_date" type="date" value="${d}"></div></div><div class="form-row"><div><label>${t('label.project')}</label><select id="f_project">${activeProjects.map(p => `<option value="${p.id}" ${p.id === prId ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div><div><label>${t('label.level')}</label><select id="f_level"><option value="important">${t('label.levelImportant')}</option><option value="risk">${t('label.levelRisk')}</option></select></div></div><div><label>${t('label.assignee')}</label><select id="f_owner">${peopleOptions('')}</select></div><div><label>${t('label.desc')}</label><textarea id="f_desc"></textarea></div></div>`,
    async () => {
      let dd = { name: val('f_name'), date: val('f_date'), projectId: val('f_project'), level: val('f_level'), ownerId: val('f_owner'), description: val('f_desc') };
      if (!dd.name) return toast(t('toast.needMilestoneName'));
      if (!dd.projectId) return toast(t('toast.needProject'));
      await post('/api/milestones', dd);
      closeModal(); await reloadAll(); toast(t('toast.addedMilestone'));
    },
    null
  );
}

// ── 团队表单（CRUD）──
export function openTeam(id) {
  let tm = id ? team(id) : { name: '', color: '#7db7ff', description: '', archived: 0 };
  const isDefault = id === 'tm_default';
  showModal(
    id ? t('title.editTeam') : t('title.addTeam'),
    `<div class="form"><div><label>${t('label.teamName')}</label><input id="f_name" value="${esc(tm.name || '')}"></div><div class="form-row"><div><label>${t('label.teamColor')}</label><input id="f_color" type="color" value="${tm.color || '#7db7ff'}"></div></div><div><label>${t('label.teamDesc')}</label><input id="f_desc" value="${esc(tm.description || '')}"></div>${id && !isDefault ? `<div><label><input id="f_archived" type="checkbox" ${tm.archived ? 'checked' : ''}> ${t('label.archived')}</label></div>` : ''}${isDefault ? `<span class="form-hint">${t('team.defaultHint')}</span>` : ''}</div>`,
    async () => {
      let d = { name: val('f_name'), color: val('f_color'), description: val('f_desc') };
      if (id && !isDefault && $('f_archived')) d.archived = $('f_archived').checked ? 1 : 0;
      if (!d.name) return toast(t('toast.needTeamName'));
      id ? await put('/api/teams/' + id, d) : await post('/api/teams', d);
      closeModal(); await reloadAll(); toast(t('toast.savedTeam'));
    },
    id && !isDefault ? async () => { await del('/api/teams/' + id); closeModal(); await reloadAll(); toast(t('toast.deletedTeam')); } : null
  );
}

export async function deleteTeam(id) {
  if (!confirm(t('confirm.deleteTeam'))) return;
  try {
    await del('/api/teams/' + id);
    await reloadAll();
    toast(t('toast.deletedTeam'));
  } catch (e) { toast(e.message); }
}

export function openTeamLoan(id, prefilledTeamId, prefilledPersonId) {
  const loan = id ? (state.teamLoans || []).find(x => x.id === id) : null;
  const targetTeamId = loan?.targetTeamId || prefilledTeamId || activeTeam || '';
  const startDate = loan?.startDate || iso(new Date());
  const endDate = loan?.endDate || dates[dates.length - 1] || startDate;
  const eligiblePeople = state.people.filter(p => !p.archived && p.homeTeamId !== targetTeamId);
  const selectedPersonId = loan?.personId || prefilledPersonId || eligiblePeople[0]?.id || '';
  const selectedPerson = person(selectedPersonId);
  if (selectedPerson && !eligiblePeople.some(p => p.id === selectedPerson.id)) {
    eligiblePeople.push(selectedPerson);
  }
  const isArchived = loan?.archived || 0;
  showModal(
    id ? t('title.editLoan') : t('title.addLoan'),
    `<div class="form"><div><label>${t('label.person')}</label><select id="f_loan_person">${eligiblePeople.map(p => `<option value="${p.id}" ${p.id === selectedPersonId ? 'selected' : ''}>${esc(p.name)} · ${esc(teamName(p.homeTeamId))}</option>`).join('')}</select></div><div><label>${t('label.borrowToTeam')}</label><select id="f_loan_team">${teamOptions(targetTeamId)}</select></div><div class="form-row"><div><label>${t('label.startDate')}</label><input id="f_loan_start" type="date" value="${startDate}"></div><div><label>${t('label.endDate')}</label><input id="f_loan_end" type="date" value="${endDate}"></div></div><div><label>${t('label.note')}</label><input id="f_loan_note" value="${esc(loan?.note || '')}"></div>${id ? `<div><label><input id="f_loan_archived" type="checkbox" ${isArchived ? 'checked' : ''}> ${t('label.archived')}</label></div>` : ''}</div>`,
    async () => {
      const d = { personId: val('f_loan_person'), targetTeamId: val('f_loan_team'), startDate: val('f_loan_start'), endDate: val('f_loan_end'), note: val('f_loan_note') };
      if (id) {
        d.archived = $('f_loan_archived').checked ? 1 : 0;
      }
      if (!d.personId) return toast(t('toast.needPerson'));
      if (!d.targetTeamId) return toast(t('toast.needTeam'));
      if (!d.startDate || !d.endDate || d.endDate < d.startDate) return toast(t('toast.dateRangeInvalid'));
      id ? await put('/api/team-loans/' + id, d) : await post('/api/team-loans', d);
      closeModal(); await reloadAll(); toast(t('toast.savedLoan'));
    },
    id ? async () => { await del('/api/team-loans/' + id); closeModal(); await reloadAll(); toast(t('toast.deletedLoan')); } : null
  );
}

export function openPersonTeamAction(destTeamId, ids) {
  const people = ids.map(person).filter(Boolean);
  const startDate = iso(new Date());
  const endDate = dates[dates.length - 1] || startDate;
  showModal(
    t('title.personTeamAction'),
    `<div class="form"><div class="form-hint">${esc(t('label.selectedPeople', { n: people.length }))}</div><label><input type="radio" name="f_team_action" value="loan" checked> ${esc(t('action.borrowToTeam'))}</label><label><input type="radio" name="f_team_action" value="home"> ${esc(t('action.changeHomeTeam'))}</label><div id="loanRange" class="form-row"><div><label>${t('label.startDate')}</label><input id="f_action_start" type="date" value="${startDate}"></div><div><label>${t('label.endDate')}</label><input id="f_action_end" type="date" value="${endDate}"></div></div></div>`,
    async () => {
      const action = document.querySelector('input[name="f_team_action"]:checked')?.value || 'loan';
      if (action === 'home') {
        await Promise.all(people.filter(p => p.homeTeamId !== destTeamId).map(p => put('/api/people/' + p.id, {
          name: p.name, department: p.department, role: p.role, dailyCapacity: p.dailyCapacity,
          color: p.color, archived: p.archived, homeTeamId: destTeamId
        })));
      } else {
        const start = val('f_action_start'), end = val('f_action_end');
        if (!start || !end || end < start) return toast(t('toast.dateRangeInvalid'));
        await Promise.all(people.filter(p => p.homeTeamId !== destTeamId).map(p => post('/api/team-loans', {
          personId: p.id, targetTeamId: destTeamId, startDate: start, endDate: end, note: ''
        })));
      }
      closeModal(); await reloadAll(); toast(action === 'home' ? t('toast.migrated') : t('toast.savedLoan'));
    }, null
  );
  document.querySelectorAll('input[name="f_team_action"]').forEach(el => el.addEventListener('change', () => {
    $('loanRange').style.display = el.checked && el.value === 'home' ? 'none' : '';
  }));
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
    $('resourceBody').innerHTML = state.people.filter(p => !p.archived && (!activeTeam || personInTeam(p, activeTeam))).map(p => {
      const teamMeta = !activeTeam ? ` · ${teamName(p.homeTeamId)}` : '';
      const borrowedBadge = activeTeam && p.homeTeamId !== activeTeam ? ` <span class="badge">${esc(t('team.borrowed'))}</span>` : '';
      return (
      `<div class="item person-card" data-id="${p.id}" draggable="true" data-drag-type="person" data-drag-id="${p.id}">` +
      `<span class="drag-handle" data-reorder="people" data-reorder-id="${p.id}">⠿</span>` +
      `<div class="item-main"><div class="item-title"><span class="dot" style="background:${personColor(p)}"></span><span class="item-name">${esc(p.name)}</span>${borrowedBadge}</div><small>${esc(t('resource.personMeta', { dept: p.department || '', role: p.role || '', cap: Number(p.dailyCapacity || 8) }) + teamMeta)}</small></div>` +
      `<div class="actions"><button class="mini" data-edit-person="${p.id}">${t('action.edit')}</button></div></div>`
      );
    }).join('') || `<div class="empty">${t('empty.people')}</div>`;
  } else if (resourceTab === 'projects') {
    $('resourceBody').innerHTML = state.projects.filter(p => !p.archived && (!activeTeam || p.teamId === activeTeam)).map(p => {
      const d = p.startDate ? ` · ${p.startDate.slice(5)}${p.endDate ? '~' + p.endDate.slice(5) : ''}` : '';
      const ownerName = person(p.ownerId)?.name || p.owner || '';
      const teamMeta = !activeTeam ? ` · ${teamName(p.teamId)}` : '';
      return `<div class="item" data-id="${p.id}" draggable="true" data-drag-type="project" data-drag-id="${p.id}">` +
        `<span class="drag-handle" data-reorder="projects" data-reorder-id="${p.id}">⠿</span>` +
        `<div class="item-main"><div class="item-title"><span class="dot" style="background:${projectColor(p)}"></span><span class="item-name">${esc(p.name)}</span></div><small>${ownerName ? t('resource.projectOwner') + esc(ownerName) + ' · ' : ''}${esc(PRI_LABEL(p.priority || '中'))}${d}${esc(teamMeta)}</small></div>` +
        `<div class="actions"><button class="mini" data-edit-project="${p.id}">${t('action.edit')}</button></div></div>`;
    }).join('') || `<div class="empty">${t('empty.projects')}</div>`;
  } else {
    $('resourceBody').innerHTML = state.milestones.filter(m => {
      const pr = project(m.projectId);
      return pr && !pr.archived && (!activeTeam || pr.teamId === activeTeam);
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
  // 行集合：团队视图用 personInTeam（home 或借调参与），全局用全部可见人员
  const people = state.people.filter(p => !p.archived && rowMatches(p, 'person'));
  const pids = new Set(people.map(p => p.id));
  // 团队视图 A 口径（5.1）：产能分母仅 home 成员；已分配分子为该团队项目排期工时（含借调贡献）。
  // 全局视图：分母=可见人员产能、分子=可见人员排期工时（人效/负载准确）。
  let capacity, used = 0;
  if (activeTeam) {
    const homeMembers = state.people.filter(p => !p.archived && p.homeTeamId === activeTeam && rowMatches(p, 'person'));
    capacity = homeMembers.reduce((s, p) => s + Number(p.dailyCapacity || 0) * workDays, 0);
    state.assignments.forEach(a => {
      if (projectTeamId(a.projectId) !== activeTeam) return;
      if (!assignmentMatches(a)) return;
      let wd = 0; dates.forEach(d => { if (inRange(a, d) && !isDayOff(d)) wd++; });
      used += Number(a.hours || 0) * wd;
    });
  } else {
    capacity = people.reduce((s, p) => s + Number(p.dailyCapacity || 0) * workDays, 0);
    state.assignments.forEach(a => {
      if (!pids.has(a.personId)) return;
      if (!assignmentMatches(a)) return;
      let wd = 0; dates.forEach(d => { if (inRange(a, d) && !isDayOff(d)) wd++; });
      used += Number(a.hours || 0) * wd;
    });
  }
  let conflicts = 0;
  // 冲突：可见人员的「全局」冲突（不变量——负载/冲突始终按全量排期算）
  people.forEach(p => dates.forEach(d => {
    if (!isDayOff(d) && totalHours(p.id, d) > Number(p.dailyCapacity || 8)) conflicts++;
  }));
  const ms = state.milestones.filter(m => dates.includes(m.date) && milestoneMatches(m)).length;
  const near = state.milestones.filter(m => {
    const st = milestoneStatus(m.date); return st.state === 'upcoming' && milestoneMatches(m);
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
  
  // 提取唯一的项目负责人ID和名称选项，支持兼容的筛选值
  const ownerOpts = [];
  const seenIds = new Set();
  const seenNames = new Set();
  state.projects.forEach(p => {
    if (p.ownerId) {
      if (!seenIds.has(p.ownerId)) {
        seenIds.add(p.ownerId);
        const name = person(p.ownerId)?.name || '';
        if (name) {
          ownerOpts.push({ id: p.ownerId, name });
          seenNames.add(name);
        }
      }
    } else if (p.owner) {
      const name = String(p.owner).trim();
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        ownerOpts.push({ id: name, name });
      }
    }
  });
  ownerOpts.sort((a, b) => a.name.localeCompare(b.name));

  const projects = state.projects.filter(p => !p.archived);
  fillMulti('filterDept', 'departments', depts, t('filter.dept'));
  fillMulti('filterRole', 'roles', roles, t('filter.role'));
  const fill = (id, opts, placeholder, current) => {
    const sel = $(id); if (!sel) return;
    sel.innerHTML = `<option value="">${placeholder}</option>` +
      opts.map(o => `<option value="${esc(String(o.id != null ? o.id : o))}"${String(current) === String(o.id != null ? o.id : o) ? ' selected' : ''}>${esc(o.name != null ? o.name : o)}</option>`).join('');
  };
  fill('filterProject', projects, t('filter.project'), filters.projectId);
  fill('filterOwner', ownerOpts, t('filter.owner'), filters.ownerId);
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
// 0.0.5 设置页形态：团队 Tab（一次一队）+ 卡片网格 + 独立归档子 Tab。
// 里程碑不再单独成 Tab，内嵌进项目卡（◆N 徽标 → 里程碑管理弹窗）；全局视图由「资源池」抽屉提供。
function settingsNav() {
  const tabs = [['teams', t('settings.navTeams')], ['archive', t('settings.navArchive')], ['data', t('settings.navData')]];
  return `<div class="settings-subtabs">${tabs.map(([key, label]) =>
    `<button class="${settingsTab === key ? 'active' : ''}" data-settings-tab="${key}">${label}</button>`
  ).join('')}</div>`;
}

export function setSettingsTab(tab) {
  setSettingsTabState(tab);
  renderSettings();
}

// ── 卡片构造（人员 / 项目；团队视图用活跃卡，归档视图用归档卡）──
function personCard(p) {
  const meta = [p.department, p.role, (p.dailyCapacity || 8) + 'h'].filter(Boolean).join(' · ');
  return `<div class="compact-row card person-card" data-id="${p.id}" draggable="true" data-drag-type="person" data-drag-id="${p.id}">
    <div class="card-top"><input type="checkbox" class="batch-select-person" value="${p.id}"><span class="drag-handle" data-reorder="people" data-reorder-id="${p.id}">⠿</span></div>
    <div class="card-body" data-edit-person="${p.id}"><span class="card-avatar" style="background:${personColor(p)}">${esc((p.name || '?').slice(0, 1))}</span><span class="card-name">${esc(p.name)}</span></div>
    <div class="card-meta">${esc(meta) || '&nbsp;'}</div>
  </div>`;
}
function projectCard(p) {
  const ownerName = person(p.ownerId)?.name || p.owner || '';
  const pMs = state.milestones.filter(m => m.projectId === p.id);
  const dateRange = p.startDate ? (p.startDate.slice(5) + (p.endDate ? '~' + p.endDate.slice(5) : '')) : '';
  const meta = [ownerName, esc(PRI_LABEL(p.priority || '中')), dateRange].filter(Boolean).join(' · ');
  const hasRisk = pMs.some(m => m.level === 'risk');
  const badge = pMs.length ? `<span class="ms-count-badge${hasRisk ? ' has-risk' : ''}" data-milestone-manager="${p.id}" title="${esc(t('settings.milestoneCountTip', { n: pMs.length }))}">◆ ${pMs.length}</span>` : '';
  return `<div class="compact-row card project-card" data-id="${p.id}" draggable="true" data-drag-type="project" data-drag-id="${p.id}">
    <div class="card-top"><input type="checkbox" class="batch-select-project" value="${p.id}"><div class="card-top-right">${badge}<span class="drag-handle" data-reorder="projects" data-reorder-id="${p.id}">⠿</span></div></div>
    <div class="card-body" data-edit-project="${p.id}"><span class="card-dot" style="background:${projectColor(p)}"></span><span class="card-name">${esc(p.name)}</span></div>
    <div class="card-meta">${meta || '&nbsp;'}</div>
  </div>`;
}
function loanCard(l) {
  const p = person(l.personId) || {};
  return `<div class="compact-row card person-card loan-card">
    <div class="card-body" data-edit-team-loan="${l.id}"><span class="card-avatar" style="background:${personColor(p)}">${esc((p.name || '?').slice(0, 1))}</span><span class="card-name">${esc(p.name || '')}</span><span class="badge">${esc(t('team.borrowed'))}</span></div>
    <div class="card-meta">${esc(teamName(p.homeTeamId))} · ${esc(l.startDate)} ~ ${esc(l.endDate)}</div>
  </div>`;
}
function archivedPersonCard(p) {
  const meta = [p.department, p.role, (p.dailyCapacity || 8) + 'h'].filter(Boolean).join(' · ');
  const tmName = team(p.homeTeamId)?.name || '';
  return `<div class="compact-row card person-card archived-card">
    <div class="card-body" data-restore-person="${p.id}"><span class="card-avatar" style="background:${personColor(p)}">${esc((p.name || '?').slice(0, 1))}</span><span class="card-name">${esc(p.name)}</span></div>
    <div class="card-meta">${esc(meta)}${tmName ? ' · ' + esc(tmName) : ''}</div>
    <div class="card-actions"><button class="mini" data-restore-person="${p.id}">${esc(t('action.restore'))}</button></div>
  </div>`;
}
function archivedProjectCard(p) {
  const ownerName = person(p.ownerId)?.name || p.owner || '';
  const tmName = team(p.teamId)?.name || '';
  const meta = [ownerName, esc(PRI_LABEL(p.priority || '中')), tmName].filter(Boolean).join(' · ');
  return `<div class="compact-row card project-card archived-card">
    <div class="card-body" data-restore-project="${p.id}"><span class="card-dot" style="background:${projectColor(p)}"></span><span class="card-name">${esc(p.name)}</span></div>
    <div class="card-meta">${meta || '&nbsp;'}</div>
    <div class="card-actions"><button class="mini" data-restore-project="${p.id}">${esc(t('action.restore'))}</button></div>
  </div>`;
}
function archivedLoanCard(l) {
  const p = person(l.personId) || {};
  return `<div class="compact-row card person-card archived-card loan-archived-card" data-restore-team-loan="${l.id}">
    <div class="card-body"><span class="card-avatar" style="background:${personColor(p)}">${esc((p.name || '?').slice(0, 1))}</span><span class="card-name">${esc(p.name || '')}</span><span class="badge">${esc(t('team.borrowed'))}</span></div>
    <div class="card-meta">${esc(teamName(p.homeTeamId))} → ${esc(teamName(l.targetTeamId))} · ${esc(l.startDate)} ~ ${esc(l.endDate)}</div>
    <div class="card-actions"><button class="mini" data-restore-team-loan="${l.id}">${esc(t('action.restore'))}</button></div>
  </div>`;
}
function inlineMemberCreate(teamId) {
  return `<div class="inline-creation-row">
    <input type="text" placeholder="${esc(t('settings.memberNamePlaceholder'))}" class="inline-name inline-person-name">
    <input type="text" placeholder="${esc(t('settings.memberDeptPlaceholder'))}" class="inline-dept inline-person-dept">
    <input type="text" placeholder="${esc(t('settings.memberRolePlaceholder'))}" class="inline-role inline-person-role">
    <button class="mini btn-inline-create" data-create-person-team-id="${teamId}">${esc(t('settings.inlineCreate'))}</button>
  </div>`;
}
function inlineProjectCreate(teamId) {
  return `<div class="inline-creation-row">
    <input type="text" placeholder="${esc(t('settings.projectNamePlaceholder'))}" class="inline-name inline-project-name">
    <button class="mini btn-inline-create" data-create-project-team-id="${teamId}">${esc(t('settings.inlineCreate'))}</button>
  </div>`;
}

// 项目卡 ◆N 徽标 → 里程碑管理弹窗（弹窗不在 settingsCard 内，需独立绑定 CRUD 委托）
export function openMilestoneManager(projectId) {
  const pr = project(projectId) || {};
  const ms = state.milestones.filter(m => m.projectId === projectId).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const rows = ms.map(m => {
    const assignee = person(m.ownerId)?.name || m.owner || t('label.unassigned');
    return `<div class="item mm-row"><span class="ms-dot ${m.level === 'risk' ? 'risk' : ''}"></span><div class="mm-info"><b>${esc(m.name)}</b><small>${esc(m.date || '')} · ${LEVEL_LABEL(m.level)} · ${esc(assignee)}</small></div><div class="actions"><button class="mini" data-edit-milestone="${m.id}">${esc(t('action.edit'))}</button><button class="mini danger" data-delete-milestone="${m.id}">${esc(t('action.deleteShort'))}</button></div></div>`;
  }).join('') || `<div class="empty">${esc(t('empty.milestones'))}</div>`;
  showModal(t('title.projectMilestones') + (pr.name ? ' · ' + pr.name : ''),
    `<div class="mm-wrap"><div class="mm-list">${rows}</div><div class="mm-add"><button class="mini" data-add-milestone-to-project="${projectId}">+ ${esc(t('settings.addMilestone'))}</button></div></div>`,
    null, null);
  const body = $('modalBody');
  const handler = async (e) => {
    const addBtn = e.target.closest('[data-add-milestone-to-project]');
    if (addBtn) { body.removeEventListener('click', handler); openAddMilestone(addBtn.dataset.addMilestoneToProject); return; }
    const editBtn = e.target.closest('[data-edit-milestone]');
    if (editBtn) { body.removeEventListener('click', handler); openMilestone(editBtn.dataset.editMilestone); return; }
    const delBtn = e.target.closest('[data-delete-milestone]');
    if (delBtn) { body.removeEventListener('click', handler); await del('/api/milestones/' + delBtn.dataset.deleteMilestone); await reloadAll(); openMilestoneManager(projectId); return; }
  };
  body.addEventListener('click', handler);
}

export function renderSettings() {
  const oldBar = $('batchActionBar');
  if (oldBar) oldBar.remove();
  let content = '';

  if (settingsTab === 'teams') {
    const activeTeams = state.teams.filter(tm => !tm.archived).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const allTeamIds = state.teams.map(x => x.id);
    // 解析当前团队 Tab；失效（被删/归档）时回退到第一个团队。
    // 回退分支里的 setSettingsActiveTeam 是 load-bearing：它把真实 activeId 写回 localStorage，
    // 否则失效 id 会残留、每次渲染都重跑回退。重构时勿删此调用。
    let activeTm = activeTeams.find(tm => tm.id === settingsActiveTeam);
    if (!activeTm && activeTeams.length) { activeTm = activeTeams[0]; setSettingsActiveTeam(activeTm.id); }
    const activeId = activeTm ? activeTm.id : '';
    const isDefault = activeId === 'tm_default';

    const tmPeople = activeTm ? state.people.filter(p => !p.archived && (p.homeTeamId === activeId || (isDefault && (!p.homeTeamId || !allTeamIds.includes(p.homeTeamId))))) : [];
    const tmProjects = activeTm ? state.projects.filter(p => !p.archived && (p.teamId === activeId || (isDefault && (!p.teamId || !allTeamIds.includes(p.teamId))))) : [];
    const tmLoans = activeTm ? (state.teamLoans || []).filter(l => l.targetTeamId === activeId && person(l.personId) && !person(l.personId).archived && !l.archived) : [];

    content = `<div class="teams-settings-container">
      <div class="team-tabs-row">
        <div class="team-tabs">
          ${activeTeams.map(tm => `<button class="team-tab${tm.id === activeId ? ' active' : ''}" data-team-tab="${tm.id}" data-team-id="${tm.id}" data-reorder="teams" data-reorder-id="${tm.id}" title="${esc(tm.name)}"><span class="dot" style="background:${tm.color || '#7db7ff'}"></span><span class="team-tab-name">${esc(tm.name)}</span></button>`).join('')}
          <button class="team-tab add-tab" data-add-team title="${esc(t('settings.addTeam'))}">＋</button>
        </div>
      </div>
      ${activeTm ? `
      <div class="active-team-panel" data-team-id="${activeId}">
        <div class="active-team-header">
          <div class="team-title-wrap">
            <span class="dot" style="background:${activeTm.color || '#7db7ff'}"></span>
            <span class="team-name">${esc(activeTm.name)}</span>
            ${isDefault ? `<span class="badge default-team-badge">${esc(t('team.default'))}</span>` : ''}
            <span class="team-stats-hint">${tmPeople.length} ${esc(t('settings.teamMembersCount'))} · ${tmProjects.length} ${esc(t('settings.teamProjectsCount'))}</span>
          </div>
          <div class="team-actions">
            <button class="mini" data-edit-team="${activeId}">${esc(t('action.edit'))}</button>
            ${!isDefault ? `<button class="mini danger" data-delete-team="${activeId}">${esc(t('action.deleteShort'))}</button>` : ''}
          </div>
        </div>
        <div class="team-sections">
          <div class="team-section-box">
            <div class="section-box-header"><h4>${esc(t('settings.navPeople'))}<span class="section-count">${tmPeople.length}</span></h4><button class="mini" data-add-person-to-team="${activeId}">${esc(t('settings.addPerson'))}</button></div>
            <div class="section-box-list" data-team-drop-person="${activeId}">
              <div class="card-grid member-grid">${tmPeople.map(personCard).join('') || `<div class="empty grid-empty">${esc(t('empty.people'))}</div>`}</div>
              ${inlineMemberCreate(activeId)}
            </div>
          </div>
          <div class="team-section-box">
            <div class="section-box-header"><h4>${esc(t('settings.borrowedPeople'))}<span class="section-count">${tmLoans.length}</span></h4><button class="mini" data-add-loan-to-team="${activeId}">${esc(t('settings.addLoan'))}</button></div>
            <div class="card-grid member-grid">${tmLoans.map(loanCard).join('') || `<div class="empty grid-empty">${esc(t('empty.loans'))}</div>`}</div>
          </div>
          <div class="team-section-box">
            <div class="section-box-header"><h4>${esc(t('settings.navProjects'))}<span class="section-count">${tmProjects.length}</span></h4><button class="mini" data-add-project-to-team="${activeId}">${esc(t('settings.addProject'))}</button></div>
            <div class="section-box-list" data-team-drop-project="${activeId}">
              <div class="card-grid project-grid">${tmProjects.map(projectCard).join('') || `<div class="empty grid-empty">${esc(t('empty.projects'))}</div>`}</div>
              ${inlineProjectCreate(activeId)}
            </div>
          </div>
        </div>
      </div>` : `<div class="empty">${esc(t('empty.teams'))}</div>`}
    </div>`;
  }

  if (settingsTab === 'archive') {
    const archPeople = state.people.filter(p => p.archived);
    const archProjects = state.projects.filter(p => p.archived);
    const archLoans = (state.teamLoans || []).filter(l => l.archived && person(l.personId));
    const emptyArchive = archPeople.length === 0 && archProjects.length === 0 && archLoans.length === 0;
    content = `<div class="teams-settings-container">
      <div class="archive-toolbar"><h3>${esc(t('settings.archiveTitle'))}</h3><span class="team-stats-hint">${archPeople.length} ${esc(t('settings.teamMembersCount'))} · ${archProjects.length} ${esc(t('settings.teamProjectsCount'))}${archLoans.length ? ' · ' + archLoans.length + ' ' + esc(t('settings.borrowedPeople')) : ''}</span></div>
      ${emptyArchive ? `<div class="empty">${esc(t('settings.emptyArchive'))}</div>` : `
      ${archPeople.length ? `<div class="team-section-box"><div class="section-box-header"><h4>${esc(t('settings.navPeople'))}<span class="section-count">${archPeople.length}</span></h4></div><div class="card-grid">${archPeople.map(archivedPersonCard).join('')}</div></div>` : ''}
      ${archLoans.length ? `<div class="team-section-box"><div class="section-box-header"><h4>${esc(t('settings.borrowedPeople'))}<span class="section-count">${archLoans.length}</span></h4></div><div class="card-grid">${archLoans.map(archivedLoanCard).join('')}</div></div>` : ''}
      ${archProjects.length ? `<div class="team-section-box"><div class="section-box-header"><h4>${esc(t('settings.navProjects'))}<span class="section-count">${archProjects.length}</span></h4></div><div class="card-grid">${archProjects.map(archivedProjectCard).join('')}</div></div>` : ''}
      `}
    </div>`;
  }

  if (settingsTab === 'data') {
    content = `<div class="settings-layout"><div class="panel"><h3>${esc(t('settings.data'))}</h3><div class="panel-actions"><button data-export-csv>${esc(t('btn.exportCsv'))}</button><button data-import-csv>${esc(t('btn.importCsv'))}</button><button class="danger" data-reset-data>${esc(t('btn.resetData'))}</button></div><p class="hint">${esc(t('data.hint'))}</p><div class="empty" style="margin-top:12px">${esc(t('data.strategy'))}</div></div></div>`;
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
    let msg = t('toast.importSummary', { a: data.createdAssignments, ma: data.mergedAssignments || 0, ms: data.createdMilestones || 0, mms: data.mergedMilestones || 0, l: data.createdLoans || 0, p: data.createdPeople, pr: data.createdProjects, s: data.skipped });
    if (data.unmatchedTeam > 0) msg += t('toast.importUnmatchedTeam', { n: data.unmatchedTeam });
    toast(msg);
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

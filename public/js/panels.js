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
  activeTeam, projectTeamId,
  settingsActiveTeam, setSettingsActiveTeam, personEligibleForProject, personInTeam
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
export function closeModal() {
  $('modalMask').classList.remove('show');
  const modal = document.querySelector('#modalMask .modal');
  if (modal) modal.classList.remove('large');
}

export function showModal(title, body, onSave, onDelete) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalSave').onclick = onSave;
  $('modalSave').textContent = t('btn.save'); // 复位，避免打印框「开始打印」文案残留到后续弹窗
  $('modalSave').style.visibility = onSave ? 'visible' : 'hidden'; // 无保存动作的弹窗（如里程碑管理）隐藏保存键，并在每次打开时复位
  $('modalDelete').style.visibility = onDelete ? 'visible' : 'hidden';
  $('modalDelete').onclick = onDelete || (() => {});
  $('modalMask').classList.add('show');
}

export function val(id) { return $(id).value.trim(); }

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
  const personId = val('f_person');
  const p = state.people.find(x => x.id === personId);
  const cap = Number((p && p.dailyCapacity) || 8);
  const fte = cap ? (perDay / cap) : 0;
  const el = $('f_perday');
  if (el) el.textContent = t('label.perdayHint', { d, perDay: perDay.toFixed(1), n: Math.round(fte * 100) });
}

function assignmentPeopleOptions(projectId, startDate, endDate, selectedId, preserveSelected = false) {
  const opts = state.people.filter(p => !p.archived && personEligibleForProject(p.id, projectId, startDate, endDate));
  const selected = person(selectedId);
  if (preserveSelected && selected && !opts.some(p => p.id === selected.id)) opts.push(selected);
  return opts.map(p => {
    const borrowed = p.homeTeamId !== project(projectId)?.teamId;
    const historical = !personEligibleForProject(p.id, projectId, startDate, endDate);
    const suffix = historical ? ` · ${t('label.historicalAssignment')}` : borrowed ? ` · ${t('team.borrowed')}` : '';
    return `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name + suffix)}</option>`;
  }).join('');
}

function bindAssignmentCandidateRefresh(preserveInitial = false) {
  const refresh = (preserve = false) => {
    const select = $('f_person');
    if (!select) return;
    const previous = select.value;
    select.innerHTML = assignmentPeopleOptions(val('f_project'), val('f_date'), val('f_end'), previous, preserve);
    if (!select.value && select.options.length) select.selectedIndex = 0;
    updatePerDayHint();
  };
  refresh(preserveInitial);
  ['f_project', 'f_date', 'f_end'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', () => refresh(false));
  });
  if ($('f_person')) $('f_person').addEventListener('change', updatePerDayHint);
}

export function openAssignment(id) {
  let a = state.assignments.find(x => x.id === id);
  const days = workingDays(a.date, endOf(a));
  const totalH = Number((Number(a.hours || 0) * days).toFixed(1));
  const projectList = state.projects.filter(p => (!p.archived && (!activeTeam || p.teamId === activeTeam)) || p.id === a.projectId);
  const arc = p => p.archived ? ' ' + t('label.archivedSuffix') : '';

  showModal(
    t('title.editAssign'),
    `<div class="form"><div class="form-row"><div><label>${t('label.person')}</label><select id="f_person"></select></div><div><label>${t('label.project')}</label><select id="f_project">${projectList.map(p => `<option value="${p.id}" ${a.projectId === p.id ? 'selected' : ''}>${p.name}${arc(p)}</option>`).join('')}</select></div></div><div class="form-row"><div><label>${t('label.startDate')}</label><input id="f_date" type="date" value="${a.date}"></div><div><label>${t('label.endDate')}</label><input id="f_end" type="date" value="${endOf(a)}"></div></div><div class="form-row"><div><label>${t('label.totalHours')}</label><input id="f_total" type="number" value="${totalH}" min="0" oninput="window._updatePerDayHint()"><span id="f_perday" class="form-hint">${t('label.perdayShort', { d: days, perDay: (days > 0 ? (totalH / days) : 0).toFixed(1) })}</span></div><div><label>${t('label.note')}</label><input id="f_note" value="${esc(a.note || '')}"></div></div></div>`,
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
  $('f_person').dataset.initialPersonId = a.personId;
  $('f_person').innerHTML = assignmentPeopleOptions(a.projectId, a.date, endOf(a), a.personId, true);
  bindAssignmentCandidateRefresh(true);
}

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

// ── 快速新增排期 ──
export function openAddAssignment(personId, projectId, date) {
  const activeProjects = state.projects.filter(p => !p.archived && (!activeTeam || p.teamId === activeTeam));
  const d = date || iso(new Date());
  let prId = projectId || '';

  if (!prId && personId) {
    const eligibleProject = activeProjects.find(p => personEligibleForProject(personId, p.id, d, d));
    if (eligibleProject) {
      prId = eligibleProject.id;
    }
  }
  if (!prId) {
    prId = activeProjects[0]?.id || '';
  }

  showModal(
    t('title.addAssign'),
    `<div class="form"><div class="form-row"><div><label>${t('label.person')}</label><select id="f_person"></select></div><div><label>${t('label.project')}</label><select id="f_project">${activeProjects.map(x => `<option value="${x.id}" ${x.id === prId ? 'selected' : ''}>${x.name}</option>`).join('')}</select></div></div><div class="form-row"><div><label>${t('label.startDate')}</label><input id="f_date" type="date" value="${d}"></div><div><label>${t('label.endDate')}</label><input id="f_end" type="date" value="${d}"></div></div><div class="form-row"><div><label>${t('label.totalHoursH')}</label><input id="f_total" type="number" value="8" min="0" oninput="window._updatePerDayHint()"><span id="f_perday" class="form-hint">${t('label.perdayInit')}</span></div><div><label>${t('label.note')}</label><input id="f_note" value=""></div></div></div>`,
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
  $('f_person').innerHTML = assignmentPeopleOptions(prId, d, d, personId || '', !!personId);
  bindAssignmentCandidateRefresh(!!personId);
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

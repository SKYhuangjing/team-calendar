// panels.js — 模态框、资源抽屉、设置面板、统计栏、CSV 导入、toast

import {
  $, state, dates, esc, activeTab, resourceTab, settingsTab,
  setResourceTab as setResourceTabState, setSettingsTab as setSettingsTabState,
  isDayOff, inRange, totalHours, endOf, iso, workingDays,
  project, person, team, personColor, projectColor, stableColor,
  rowMatches, filters, setFilter, clearFilters, hasActiveFilters,
  loadRate, milestoneStatus, conflictHighlight, setConflictHighlight,
  undoLast, pushUndo, clearUndo,
  assignmentMatches, milestoneMatches,
  activeTeam, projectTeamId,
  settingsActiveTeam, setSettingsActiveTeam,
  authEnabled, isAdmin, unlockedTeams, teamAuth, setAuthToken, setSession, isUnlockedTeam, isReadOnlyMode
} from './state.js';
import { post, put, del, load, api } from './api.js';
import { t } from './i18n.js';

// 显示用的本地化标签（数据值保持规范：优先级 高/中/低、级别 important/risk）
const PRI_LABEL = v => ({ '高': t('label.priorityHigh'), '中': t('label.priorityMid'), '低': t('label.priorityLow') })[v] || v;
const LEVEL_LABEL = v => v === 'risk' ? t('label.levelRisk') : t('label.levelImportant');

// 团队下拉选项（归档团队仅在自身被选中时显示）
function teamOptions(selectedId) {
  const opts = state.teams.filter(x => !x.archived || String(x.id) === String(selectedId));
  return opts.map(x => `<option value="${esc(x.id)}"${String(selectedId) === String(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
}
function peopleOptions(selectedId) {
  const opts = state.people.filter(x => !x.archived || String(x.id) === String(selectedId));
  return `<option value="">${t('label.unassigned')}</option>` +
         opts.map(x => `<option value="${esc(x.id)}"${String(selectedId) === String(x.id) ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
}
function defaultTeamId() {
  const t0 = state.teams.find(x => !x.archived);
  return (t0 && t0.id) || 'tm_default';
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

// ── 0.1.0 团队操作密码：解锁弹窗（独立 mask，避免与业务 modal 的 foot/取消语义冲突）──
// openUnlock(info)：info = {requireAdmin:true} 或 {requireUnlock:<teamId>, teamName}。
// 返回 Promise<boolean>：true=已解锁、重放原请求；false=用户取消。
let _unlockResolver = null;
let _unlockInFlight = null; // Promise | null：并发 403 共用同一次解锁，避免覆盖 resolver 丢 Promise
export function openUnlock(info) {
  // 并发写请求同时命中 403（如跨团队拖拽 Promise.allSettled 并行 put）：复用已在进行的解锁，
  // 让所有等待者拿到同一结果，而非第二个覆盖第一个的 resolver 导致请求永久 pending。
  if (_unlockInFlight) return _unlockInFlight;
  const p = new Promise((resolve) => {
    _unlockResolver = resolve;
    const mask = $('unlockMask');
    if (!mask) { resolve(false); return; }
    
    // 判断是否显示整站解锁控制台（Dashboard）
    const isDashboard = !info || (!info.requireAdmin && !info.requireUnlock);
    
    if (isDashboard) {
      mask.dataset.isDashboard = '1';
      $('unlockTitle').textContent = t('auth.unlockDashboardTitle') || '解锁控制台';
      renderUnlockDashboard();
      $('unlockOk').style.display = 'none';
      mask.style.display = 'flex';
    } else {
      mask.dataset.isDashboard = '0';
      $('unlockOk').style.display = 'inline-block';
      const isAdminUnlock = !!(info && info.requireAdmin);
      const teamId = (info && info.requireUnlock) || '';
      const tm = team(teamId) || {};
      const teamName = (info && info.teamName) || tm.name || '';
      
      $('unlockTitle').textContent = isAdminUnlock ? t('auth.adminUnlockTitle') : t('auth.teamUnlockTitle', { name: teamName });
      
      const bodyEl = document.querySelector('#unlockMask .modal-body');
      bodyEl.innerHTML = `
        <div class="form">
          <label id="unlockLabel">${isAdminUnlock ? t('auth.adminPassword') : t('auth.teamPassword')}</label>
          <input id="unlockPw" type="password">
        </div>
        <div id="unlockErr" class="form-hint" style="color:var(--red);min-height:16px;margin-top:4px"></div>
      `;
      
      $('unlockPw').value = '';
      $('unlockErr').textContent = '';
      mask.dataset.isAdmin = isAdminUnlock ? '1' : '0';
      mask.dataset.teamId = teamId;
      mask.style.display = 'flex';
      setTimeout(() => { try { $('unlockPw').focus(); } catch (_) { /* 忽略 */ } }, 30);
    }
  });
  _unlockInFlight = p;
  // 无论 resolve 与否都清 in-flight，避免下次解锁被旧 Promise 挡住
  p.then(() => { _unlockInFlight = null; }, () => { _unlockInFlight = null; });
  return p;
}

function renderUnlockDashboard() {
  const bodyEl = document.querySelector('#unlockMask .modal-body');
  if (!bodyEl) return;
  
  // 所有被设密的团队
  const lockedTeams = state.teams.filter(tm => !tm.archived && teamAuth[tm.id]);
  
  let html = `<div class="unlock-dashboard-list">`;
  
  if (lockedTeams.length === 0 && isAdmin) {
    html += `<div class="empty grid-empty" style="padding: 10px 0;">${t('auth.noTeamsNeedUnlock') || '暂无团队操作密码'}</div>`;
  } else {
    lockedTeams.forEach(tm => {
      const isUnlocked = isUnlockedTeam(tm.id);
      html += `
        <div class="unlock-dashboard-row" data-dash-team-id="${tm.id}">
          <div class="team-info">
            <span class="team-dot" style="background:${tm.color || '#7db7ff'}"></span>
            <span>${esc(tm.name)}</span>
          </div>
          ${isUnlocked ? `
            <span style="color:var(--green); font-size:12.5px; margin-left:auto; font-weight:800;">🔓 ${t('auth.pwdSet') || '已解锁'}</span>
          ` : `
            <input type="password" class="dash-team-pw" placeholder="${t('auth.teamPassword')}" data-dash-pw-id="${tm.id}">
            <button class="mini active btn-unlock-dash" data-unlock-dash-team-id="${tm.id}">${t('auth.unlock')}</button>
          `}
        </div>
      `;
    });
  }
  
  // 超管登录状态行
  if (!isAdmin) {
    html += `
      <div class="unlock-dashboard-row unlock-dashboard-admin-row">
        <div class="team-info">🔑 ${t('auth.admin')}</div>
        <input type="password" class="dash-admin-pw" placeholder="${t('auth.adminPassword')}" data-dash-pw-id="admin">
        <button class="mini active btn-unlock-dash" data-unlock-dash-admin="1">${t('auth.unlock')}</button>
      </div>
    `;
  } else {
    html += `
      <div class="unlock-dashboard-row unlock-dashboard-admin-row" style="justify-content:space-between;">
        <div class="team-info">🔑 ${t('auth.admin')}</div>
        <span style="color:var(--green); font-size:12.5px; font-weight:800;">🔓 ${t('auth.adminUnlocked') || '已超管解锁'}</span>
      </div>
    `;
  }
  
  html += `</div><div id="unlockErr" class="form-hint" style="color:var(--red);min-height:16px;margin-top:4px"></div>`;
  bodyEl.innerHTML = html;
  
  // 绑定弹窗内按钮的事件
  bodyEl.querySelectorAll('.btn-unlock-dash').forEach(btn => {
    btn.addEventListener('click', async () => {
      const teamId = btn.dataset.unlockDashTeamId;
      const isAdminUnlock = !!btn.dataset.unlockDashAdmin;
      
      let pw = '';
      if (isAdminUnlock) {
        pw = bodyEl.querySelector(`.dash-admin-pw`).value;
      } else {
        pw = bodyEl.querySelector(`.dash-team-pw[data-dash-pw-id="${teamId}"]`).value;
      }
      
      if (!pw) return;
      
      try {
        const payload = isAdminUnlock ? { password: pw } : { password: pw, teamId };
        const r = await post('/api/auth/unlock', payload);
        setAuthToken(r.token);
        setSession(r.isAdmin, r.teamIds || []);
        // 若有写请求被 403 挂起、正等本次解锁重放（dashboard 开启期间并发触发 403），
        // 这里放行重放；不关弹窗以便连续解锁多个团队。目标团队不匹配时会再次 403 自纠正。
        if (_unlockResolver) { const fn = _unlockResolver; _unlockResolver = null; _unlockInFlight = null; fn(true); }

        toast(isAdminUnlock || r.isAdmin ? t('auth.adminUnlocked') : t('auth.unlocked'));
        renderUnlockDashboard();
        if (_renderAll) _renderAll();
      } catch (err) {
        $('unlockErr').textContent = (err && err.message) || t('auth.wrongPassword');
      }
    });
  });
  
  // 绑定密码输入框的回车事件
  bodyEl.querySelectorAll('input[type="password"]').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = input.closest('.unlock-dashboard-row');
        const btn = row.querySelector('.btn-unlock-dash');
        if (btn) btn.click();
      }
    });
  });
}

export async function submitUnlock() {
  const pw = $('unlockPw').value;
  if (!pw) return;
  const isAdminUnlock = $('unlockMask').dataset.isAdmin === '1';
  const teamId = $('unlockMask').dataset.teamId || '';
  try {
    const payload = isAdminUnlock ? { password: pw } : { password: pw, teamId };
    const r = await post('/api/auth/unlock', payload);
    setAuthToken(r.token);
    setSession(r.isAdmin, r.teamIds || []);
    closeUnlock(true);
    toast(isAdminUnlock || r.isAdmin ? t('auth.adminUnlocked') : t('auth.unlocked'));
    if (_renderAll) _renderAll();
  } catch (e) {
    $('unlockErr').textContent = (e && e.message) || t('auth.wrongPassword');
    try { $('unlockPw').select(); } catch (_) { /* 忽略 */ }
  }
}

export function closeUnlock(retry) {
  const mask = $('unlockMask');
  if (mask) mask.style.display = 'none';
  if (_unlockResolver) { const r = _unlockResolver; _unlockResolver = null; _unlockInFlight = null; r(!!retry); }
}

export async function lockSession() {
  try { await post('/api/auth/lock', {}); } catch (_) { /* 忽略 */ }
  setAuthToken('');
  setSession(false, []);
  setSettingsTabState('teams');
  if (_renderAll) _renderAll();
  toast(t('auth.locked'));
}

export function updateLockedBanner() {
  const banner = $('lockedBanner');
  if (!banner) return;
  
  let targetTeamId = '';
  if (activeTab === 'settings') {
    if (settingsTab === 'teams') {
      targetTeamId = settingsActiveTeam;
    }
  } else {
    targetTeamId = activeTeam;
  }
  
  if (authEnabled && targetTeamId && teamAuth[targetTeamId] && !isUnlockedTeam(targetTeamId)) {
    const tm = team(targetTeamId) || {};
    const name = tm.name || '';
    banner.innerHTML = `
      <span>🔒 ${t('auth.bannerText', { name }) || `当前视图为只读模式（未解锁团队：${name}）`}</span>
      <a id="unlockBannerLink">${t('auth.bannerLink') || '点击解锁编辑'}</a>
    `;
    banner.querySelector('#unlockBannerLink').onclick = () => {
      openUnlock({ requireUnlock: targetTeamId, teamName: name });
    };
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

// ── 设置页：团队操作密码管理（仅超管可见）──
export function openTeamPassword(teamId) {
  const tm = team(teamId) || {};
  showModal(t('auth.setPwdTitle', { name: tm.name || '' }),
    `<div class="form"><label>${t('auth.teamPassword')}</label><input id="f_pwd" type="password" autofocus><label>${t('auth.teamPasswordAgain')}</label><input id="f_pwd2" type="password"></div>`,
    async () => {
      const p1 = val('f_pwd'), p2 = val('f_pwd2');
      if (!p1) return toast(t('auth.needPwd'));
      if (p1 !== p2) return toast(t('auth.pwdMismatch'));
      try {
        await post('/api/auth/team-password', { teamId, password: p1 });
        closeModal(); await reloadAll(); toast(t('auth.pwdSaved'));
      } catch (e) { toast(e.message); }
    }, null);
}
export async function clearTeamPassword(teamId) {
  if (!confirm(t('auth.confirmClear'))) return;
  try {
    await del('/api/auth/team-password?teamId=' + encodeURIComponent(teamId));
    await reloadAll();
    toast(t('auth.pwdCleared'));
  } catch (e) { toast(e.message); }
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
    `<div class="form"><div class="form-row"><div><label>${t('label.name')}</label><input id="f_name" value="${esc(p.name || '')}"></div><div><label>${t('label.capacity')}</label><input id="f_cap" type="number" value="${p.dailyCapacity || 8}"></div></div><div class="form-row"><div><label>${t('label.dept')}</label><input id="f_dept" value="${esc(p.department || '')}"></div><div><label>${t('label.role')}</label><input id="f_role" value="${esc(p.role || '')}"></div></div><div><label>${t('label.homeTeam')}</label><select id="f_team">${teamOptions(id ? p.homeTeamId : (prefilledTeamId || activeTeam || defaultTeamId()))}</select></div><div><label>${t('label.color')}</label><input id="f_color" type="color" value="${p.color || stableColor('person-' + (p.id || p.name))}"></div>${id ? `<div><label><input id="f_archived" type="checkbox" ${p.archived ? 'checked' : ''}> ${t('label.archived')}</label></div>` : ''}</div>`,
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
    `<div class="form"><div><label>${t('label.projectName')}</label><input id="f_name" value="${esc(p.name || '')}"></div><div class="form-row"><div><label>${t('label.owner')}</label><select id="f_owner">${peopleOptions(p.ownerId)}</select></div><div><label>${t('label.priority')}</label><select id="f_pri">${priOpt('高')}${priOpt('中')}${priOpt('低')}</select></div></div><div><label>${t('label.team')}</label><select id="f_team">${teamOptions(id ? p.teamId : (prefilledTeamId || activeTeam || defaultTeamId()))}</select></div><div class="form-row"><div><label>${t('label.projectStart')}</label><input id="f_start" type="date" value="${p.startDate || ''}"></div><div><label>${t('label.projectEnd')}</label><input id="f_end" type="date" value="${p.endDate || ''}"></div></div><span class="form-hint">${t('label.projectRangeHint')}</span><div><label>${t('label.projectColor')}</label><input id="f_color" type="color" value="${p.color || '#7db7ff'}"></div>${id ? `<div><label><input id="f_archived" type="checkbox" ${p.archived ? 'checked' : ''}> ${t('label.archived')}</label></div>` : ''}</div>`,
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
  let m = id ? state.milestones.find(x => x.id === id) : { projectId: state.projects.filter(p => !p.archived)[0]?.id || '', name: '', date: iso(new Date()), level: 'important', ownerId: '', description: '' };
  const projectList = state.projects.filter(p => !p.archived || p.id === m.projectId);
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

  const readOnly = isReadOnlyMode() || (authEnabled && activeTeam && !isUnlockedTeam(activeTeam));

  // 头部「＋」按钮
  if (readOnly) {
    $('drawerAdd').innerHTML = '';
  } else {
    const addBtn = { people: [t('resource.addPerson'), 'data-add-person'], projects: [t('resource.addProject'), 'data-add-project'], milestones: [t('resource.addMilestone'), 'data-add-milestone'] };
    const [label, attr] = addBtn[resourceTab] || addBtn.people;
    $('drawerAdd').innerHTML = `<button ${attr}>${label}</button>`;
  }

  if (resourceTab === 'people') {
    $('resourceBody').innerHTML = state.people.filter(p => !p.archived && (!activeTeam || p.homeTeamId === activeTeam)).map(p =>
      `<div class="item person-card" data-id="${p.id}" draggable="${!readOnly}" data-drag-type="person" data-drag-id="${p.id}">` +
      (readOnly ? '' : `<span class="drag-handle" data-reorder="people" data-reorder-id="${p.id}">⠿</span>`) +
      `<div class="item-main"><div class="item-title"><span class="dot" style="background:${personColor(p)}"></span><span class="item-name">${esc(p.name)}</span></div><small>${esc(t('resource.personMeta', { dept: p.department || '', role: p.role || '', cap: Number(p.dailyCapacity || 8) }))}</small></div>` +
      (readOnly ? '' : `<div class="actions"><button class="mini" data-edit-person="${p.id}">${t('action.edit')}</button></div>`) + `</div>`
    ).join('') || `<div class="empty">${t('empty.people')}</div>`;
  } else if (resourceTab === 'projects') {
    $('resourceBody').innerHTML = state.projects.filter(p => !p.archived && (!activeTeam || p.teamId === activeTeam)).map(p => {
      const d = p.startDate ? ` · ${p.startDate.slice(5)}${p.endDate ? '~' + p.endDate.slice(5) : ''}` : '';
      const ownerName = person(p.ownerId)?.name || p.owner || '';
      return `<div class="item" data-id="${p.id}" draggable="${!readOnly}" data-drag-type="project" data-drag-id="${p.id}">` +
        (readOnly ? '' : `<span class="drag-handle" data-reorder="projects" data-reorder-id="${p.id}">⠿</span>`) +
        `<div class="item-main"><div class="item-title"><span class="dot" style="background:${projectColor(p)}"></span><span class="item-name">${esc(p.name)}</span></div><small>${ownerName ? t('resource.projectOwner') + esc(ownerName) + ' · ' : ''}${esc(PRI_LABEL(p.priority || '中'))}${d}</small></div>` +
        (readOnly ? '' : `<div class="actions"><button class="mini" data-edit-project="${p.id}">${t('action.edit')}</button></div>`) + `</div>`;
    }).join('') || `<div class="empty">${t('empty.projects')}</div>`;
  } else {
    $('resourceBody').innerHTML = state.milestones.filter(m => {
      const pr = project(m.projectId);
      return pr && !pr.archived && (!activeTeam || pr.teamId === activeTeam);
    }).map(m => {
      const pr = project(m.projectId) || {};
      return `<div class="item" draggable="${!readOnly}" data-drag-type="milestone" data-drag-id="${m.id}">` +
        `<div class="item-main"><div class="item-title"><span class="dot" style="background:${projectColor(pr)}"></span><span class="item-name">${esc(m.name)}</span></div><small>${esc(m.date || '')} · ${esc(pr.name || t('resource.projDeleted'))} · ${LEVEL_LABEL(m.level)}</small></div>` +
        (readOnly ? '' : `<div class="actions"><button class="mini" data-edit-milestone="${m.id}">${t('action.edit')}</button></div>`) + `</div>`;
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
  const tabs = [['teams', t('settings.navTeams')]];
  if (authEnabled && isAdmin) {
    tabs.push(['passwords', t('settings.navPasswords') || '团队密码']);
  }
  tabs.push(['archive', t('settings.navArchive')]);
  if (!authEnabled || isAdmin) {
    tabs.push(['data', t('settings.navData')]);
  }
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
  const isLocked = authEnabled && p.homeTeamId && !isUnlockedTeam(p.homeTeamId);
  const readOnly = isReadOnlyMode() || isLocked;
  const meta = [p.department, p.role, (p.dailyCapacity || 8) + 'h'].filter(Boolean).join(' · ');
  return `<div class="compact-row card person-card" data-id="${p.id}" draggable="${!readOnly}" data-drag-type="person" data-drag-id="${p.id}">
    <div class="card-top">${readOnly ? '' : `<input type="checkbox" class="batch-select-person" value="${p.id}">${isAdmin ? `<span class="drag-handle" data-reorder="people" data-reorder-id="${p.id}">⠿</span>` : ''}`}</div>
    <div class="card-body" ${readOnly ? '' : `data-edit-person="${p.id}"`}><span class="card-avatar" style="background:${personColor(p)}">${esc((p.name || '?').slice(0, 1))}</span><span class="card-name">${esc(p.name)}</span></div>
    <div class="card-meta">${esc(meta) || '&nbsp;'}</div>
  </div>`;
}
function projectCard(p) {
  const isLocked = authEnabled && p.teamId && !isUnlockedTeam(p.teamId);
  const readOnly = isReadOnlyMode() || isLocked;
  const ownerName = person(p.ownerId)?.name || p.owner || '';
  const pMs = state.milestones.filter(m => m.projectId === p.id);
  const dateRange = p.startDate ? (p.startDate.slice(5) + (p.endDate ? '~' + p.endDate.slice(5) : '')) : '';
  const meta = [ownerName, esc(PRI_LABEL(p.priority || '中')), dateRange].filter(Boolean).join(' · ');
  const hasRisk = pMs.some(m => m.level === 'risk');
  const badge = pMs.length ? `<span class="ms-count-badge${hasRisk ? ' has-risk' : ''}" data-milestone-manager="${p.id}" title="${esc(t('settings.milestoneCountTip', { n: pMs.length }))}">◆ ${pMs.length}</span>` : '';
  return `<div class="compact-row card project-card" data-id="${p.id}" draggable="${!readOnly}" data-drag-type="project" data-drag-id="${p.id}">
    <div class="card-top">${readOnly ? '' : `<input type="checkbox" class="batch-select-project" value="${p.id}">`}<div class="card-top-right">${badge}${!readOnly && isAdmin ? `<span class="drag-handle" data-reorder="projects" data-reorder-id="${p.id}">⠿</span>` : ''}</div></div>
    <div class="card-body" ${readOnly ? '' : `data-edit-project="${p.id}"`}><span class="card-dot" style="background:${projectColor(p)}"></span><span class="card-name">${esc(p.name)}</span></div>
    <div class="card-meta">${meta || '&nbsp;'}</div>
  </div>`;
}
function archivedPersonCard(p) {
  const isLocked = authEnabled && p.homeTeamId && !isUnlockedTeam(p.homeTeamId);
  const readOnly = isReadOnlyMode() || isLocked;
  const meta = [p.department, p.role, (p.dailyCapacity || 8) + 'h'].filter(Boolean).join(' · ');
  const tmName = team(p.homeTeamId)?.name || '';
  return `<div class="compact-row card person-card archived-card">
    <div class="card-body" ${readOnly ? '' : `data-restore-person="${p.id}"`}><span class="card-avatar" style="background:${personColor(p)}">${esc((p.name || '?').slice(0, 1))}</span><span class="card-name">${esc(p.name)}</span></div>
    <div class="card-meta">${esc(meta)}${tmName ? ' · ' + esc(tmName) : ''}</div>
    ${readOnly ? '' : `<div class="card-actions"><button class="mini" data-restore-person="${p.id}">${esc(t('action.restore'))}</button></div>`}
  </div>`;
}
function archivedProjectCard(p) {
  const isLocked = authEnabled && p.teamId && !isUnlockedTeam(p.teamId);
  const readOnly = isReadOnlyMode() || isLocked;
  const ownerName = person(p.ownerId)?.name || p.owner || '';
  const tmName = team(p.teamId)?.name || '';
  const meta = [ownerName, esc(PRI_LABEL(p.priority || '中')), tmName].filter(Boolean).join(' · ');
  return `<div class="compact-row card project-card archived-card">
    <div class="card-body" ${readOnly ? '' : `data-restore-project="${p.id}"`}><span class="card-dot" style="background:${projectColor(p)}"></span><span class="card-name">${esc(p.name)}</span></div>
    <div class="card-meta">${meta || '&nbsp;'}</div>
    ${readOnly ? '' : `<div class="card-actions"><button class="mini" data-restore-project="${p.id}">${esc(t('action.restore'))}</button></div>`}
  </div>`;
}
function inlineMemberCreate(teamId) {
  const isLocked = authEnabled && teamId && !isUnlockedTeam(teamId);
  if (isReadOnlyMode() || isLocked) return '';
  return `<div class="inline-creation-row">
    <input type="text" placeholder="${esc(t('settings.memberNamePlaceholder'))}" class="inline-name inline-person-name">
    <input type="text" placeholder="${esc(t('settings.memberDeptPlaceholder'))}" class="inline-dept inline-person-dept">
    <input type="text" placeholder="${esc(t('settings.memberRolePlaceholder'))}" class="inline-role inline-person-role">
    <button class="mini btn-inline-create" data-create-person-team-id="${teamId}">${esc(t('settings.inlineCreate'))}</button>
  </div>`;
}
function inlineProjectCreate(teamId) {
  const isLocked = authEnabled && teamId && !isUnlockedTeam(teamId);
  if (isReadOnlyMode() || isLocked) return '';
  return `<div class="inline-creation-row">
    <input type="text" placeholder="${esc(t('settings.projectNamePlaceholder'))}" class="inline-name inline-project-name">
    <button class="mini btn-inline-create" data-create-project-team-id="${teamId}">${esc(t('settings.inlineCreate'))}</button>
  </div>`;
}

// 项目卡 ◆N 徽标 → 里程碑管理弹窗（弹窗不在 settingsCard 内，需独立绑定 CRUD 委托）
export function openMilestoneManager(projectId) {
  const pr = project(projectId) || {};
  const isLocked = authEnabled && pr.teamId && !isUnlockedTeam(pr.teamId);
  const readOnly = isReadOnlyMode() || isLocked;
  const ms = state.milestones.filter(m => m.projectId === projectId).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const rows = ms.map(m => {
    const assignee = person(m.ownerId)?.name || m.owner || t('label.unassigned');
    const actions = readOnly ? '' : `<div class="actions"><button class="mini" data-edit-milestone="${m.id}">${esc(t('action.edit'))}</button><button class="mini danger" data-delete-milestone="${m.id}">${esc(t('action.deleteShort'))}</button></div>`;
    return `<div class="item mm-row"><span class="ms-dot ${m.level === 'risk' ? 'risk' : ''}"></span><div class="mm-info"><b>${esc(m.name)}</b><small>${esc(m.date || '')} · ${LEVEL_LABEL(m.level)} · ${esc(assignee)}</small></div>${actions}</div>`;
  }).join('') || `<div class="empty">${esc(t('empty.milestones'))}</div>`;
  
  const addSection = readOnly ? '' : `<div class="mm-add"><button class="mini" data-add-milestone-to-project="${projectId}">+ ${esc(t('settings.addMilestone'))}</button></div>`;
  showModal(t('title.projectMilestones') + (pr.name ? ' · ' + pr.name : ''),
    `<div class="mm-wrap"><div class="mm-list">${rows}</div>${addSection}</div>`,
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

// 设置页「团队操作密码」区：仅超管可见。列出各团队已设密状态 + 设/改/清密码。
function teamPasswordSection() {
  const rows = state.teams.filter(tm => !tm.archived).map(tm => {
    const has = !!teamAuth[tm.id];
    return `<div class="tm-pwd-row">
      <span class="dot" style="background:${tm.color || '#7db7ff'}"></span>
      <span class="tm-pwd-name">${esc(tm.name)}</span>
      <span class="tm-pwd-state">${has ? '🔒 ' + esc(t('auth.pwdSet')) : '🔓 ' + esc(t('auth.pwdNone'))}</span>
      <span class="tm-pwd-actions">
        <button class="mini" data-set-team-pwd="${tm.id}">${esc(has ? t('auth.changePwd') : t('auth.setPwd'))}</button>
        ${has ? `<button class="mini" data-clear-team-pwd="${tm.id}">${esc(t('auth.clearPwd'))}</button>` : ''}
      </span>
    </div>`;
  }).join('');
  return `<div class="team-section-box tm-pwd-section">
    <div class="section-box-header"><h4>${esc(t('auth.teamPwdTitle'))}</h4></div>
    <div class="tm-pwd-list">${rows || `<div class="empty grid-empty">${esc(t('empty.teams'))}</div>`}</div>
    <p class="hint">${esc(t('auth.teamPwdHint'))}</p>
  </div>`;
}

export function renderSettings() {
  const oldBar = $('batchActionBar');
  if (oldBar) oldBar.remove();

  if (authEnabled && !isAdmin && (settingsTab === 'passwords' || settingsTab === 'data')) {
    setSettingsTabState('teams');
  }

  updateLockedBanner();

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

    const readOnly = isReadOnlyMode();
    // per-team 可写性（选项A）：当前团队对当前用户是否可操作。
    // 超管 / 已解锁该团队可写；未设密码团队仅超管可写（非超管只读）；auth 关则全可写。
    // 团队结构操作（增/改名/删除团队）仍为超管专属；成员/项目增改按此判定。
    const teamWritable = !readOnly && isUnlockedTeam(activeId);

    content = `<div class="teams-settings-container">
      <div class="team-tabs-row">
        <div class="team-tabs">
          ${activeTeams.map(tm => `<button class="team-tab${tm.id === activeId ? ' active' : ''}" data-team-tab="${tm.id}" data-team-id="${tm.id}"${!readOnly && isAdmin ? ` data-reorder="teams" data-reorder-id="${tm.id}"` : ''} title="${esc(tm.name)}"><span class="dot" style="background:${tm.color || '#7db7ff'}"></span><span class="team-tab-name">${esc(tm.name)}</span></button>`).join('')}
          ${(!readOnly && isAdmin) ? `<button class="team-tab add-tab" data-add-team title="${esc(t('settings.addTeam'))}">＋</button>` : ''}
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
            ${(!readOnly && isAdmin) ? `
              <button class="mini" data-edit-team="${activeId}">${esc(t('action.edit'))}</button>
              ${!isDefault ? `<button class="mini danger" data-delete-team="${activeId}">${esc(t('action.deleteShort'))}</button>` : ''}
            ` : ''}
          </div>
        </div>
        <div class="team-sections">
          <div class="team-section-box">
            <div class="section-box-header"><h4>${esc(t('settings.navPeople'))}<span class="section-count">${tmPeople.length}</span></h4>${teamWritable ? `<button class="mini" data-add-person-to-team="${activeId}">${esc(t('settings.addPerson'))}</button>` : ''}</div>
            <div class="section-box-list" data-team-drop-person="${activeId}">
              <div class="card-grid member-grid">${tmPeople.map(personCard).join('') || `<div class="empty grid-empty">${esc(t('empty.people'))}</div>`}</div>
              ${inlineMemberCreate(activeId)}
            </div>
          </div>
          <div class="team-section-box">
            <div class="section-box-header"><h4>${esc(t('settings.navProjects'))}<span class="section-count">${tmProjects.length}</span></h4>${teamWritable ? `<button class="mini" data-add-project-to-team="${activeId}">${esc(t('settings.addProject'))}</button>` : ''}</div>
            <div class="section-box-list" data-team-drop-project="${activeId}">
              <div class="card-grid project-grid">${tmProjects.map(projectCard).join('') || `<div class="empty grid-empty">${esc(t('empty.projects'))}</div>`}</div>
              ${inlineProjectCreate(activeId)}
            </div>
          </div>
        </div>
      </div>` : `<div class="empty">${esc(t('empty.teams'))}</div>`}
    </div>`;
  }

  if (settingsTab === 'passwords') {
    content = `<div class="teams-settings-container">
      ${teamPasswordSection()}
    </div>`;
  }

  if (settingsTab === 'archive') {
    const archPeople = state.people.filter(p => p.archived);
    const archProjects = state.projects.filter(p => p.archived);
    const emptyArchive = archPeople.length === 0 && archProjects.length === 0;
    content = `<div class="teams-settings-container">
      <div class="archive-toolbar"><h3>${esc(t('settings.archiveTitle'))}</h3><span class="team-stats-hint">${archPeople.length} ${esc(t('settings.teamMembersCount'))} · ${archProjects.length} ${esc(t('settings.teamProjectsCount'))}</span></div>
      ${emptyArchive ? `<div class="empty">${esc(t('settings.emptyArchive'))}</div>` : `
      ${archPeople.length ? `<div class="team-section-box"><div class="section-box-header"><h4>${esc(t('settings.navPeople'))}<span class="section-count">${archPeople.length}</span></h4></div><div class="card-grid">${archPeople.map(archivedPersonCard).join('')}</div></div>` : ''}
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
    let msg = t('toast.importSummary', { a: data.createdAssignments, ma: data.mergedAssignments || 0, ms: data.createdMilestones || 0, mms: data.mergedMilestones || 0, p: data.createdPeople, pr: data.createdProjects, s: data.skipped });
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

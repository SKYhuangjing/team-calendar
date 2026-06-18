// state.js — 全局状态、日期/颜色工具函数
import { getLang, t } from './i18n.js';

// ── 全局状态 ──
export let state = { teams: [], people: [], projects: [], assignments: [], milestones: [] };
export let activeTab = 'projects';
export let resourceTab = 'people';
export let settingsTab = 'teams';
export let dates = [];
export let holidayMap = {};
export let selectedBarId = null;
export let selectedMilestoneId = null;
export let readOnlyMode = false;

// ── 视图模式 / 焦点日期（F1.1 + F2.2）──
// viewMode: '30d'（32 天窗口，向后兼容）/ '45d' / '60d' / 'custom'（自定义天数）
// focusDate: ISO 日期字符串，作为当前窗口的锚点（默认今天）
export const VIEW_MODES = ['30d', '45d', '60d', 'custom'];
export const CUSTOM_DAYS_MIN = 1;
export const CUSTOM_DAYS_MAX = 180;

// localStorage 安全读写（Node 单测环境无 localStorage 时不抛错）
function lsGet(k) { try { return (typeof localStorage !== 'undefined') ? localStorage.getItem(k) : null; } catch (_) { return null; } }
function lsSet(k, v) { try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (_) { /* 忽略 */ } }

function clampCustomDays(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return 30;
  return Math.min(CUSTOM_DAYS_MAX, Math.max(CUSTOM_DAYS_MIN, v));
}

// ── 团队工作区（0.0.4）：activeTeam + per-team 视图偏好 ──
// activeTeam: '' = 全部团队（全局视图，人导向）；具体 id = 团队视图（项目向过滤）。
export let activeTeam = lsGet('rc_activeTeam') || '';
export function setActiveTeam(id) { activeTeam = id || ''; }
export function getActiveTeam() { return activeTeam; }
// 设置页当前选中的团队 Tab（团队 Tab 化后，一次只渲染一个团队）。'' 或失效时回退默认团队。
export let settingsActiveTeam = lsGet('rc_settingsActiveTeam') || '';
export function setSettingsActiveTeam(id) { settingsActiveTeam = id || ''; lsSet('rc_settingsActiveTeam', settingsActiveTeam); }
export function getSettingsActiveTeam() { return settingsActiveTeam; }
// per-team 偏好的 localStorage 命名空间：rc_<name>__<teamId>（'' = 全局档）
function prefKey(name) { return `rc_${name}__${activeTeam || ''}`; }

function loadStoredViewMode() {
  const v = lsGet(prefKey('viewMode'));
  return VIEW_MODES.includes(v) ? v : '30d';
}

export let viewMode = loadStoredViewMode();
// customDays：自定义视图天数（默认 30），per-team 持久化
export let customDays = clampCustomDays(lsGet(prefKey('customDays')));
export let focusDate = '';

export function setState(newState) {
  state = newState;
  if (activeTeam && !state.teams.some(t => t.id === activeTeam && !t.archived)) {
    activeTeam = '';
    try { localStorage.setItem('rc_activeTeam', ''); } catch (_) {}
  }
}
export function setActiveTab(tab) { activeTab = tab; }
export function setResourceTab(tab) { resourceTab = tab; }
export function setSettingsTab(tab) { settingsTab = tab; }
export function setDates(d) { dates = d; }
export function setHolidayMap(m) { holidayMap = m; }
export function setSelectedBarId(id) { selectedBarId = id; }
export function setSelectedMilestoneId(id) { selectedMilestoneId = id; }
export function setReadOnlyMode(value) { readOnlyMode = Boolean(value); }
export function setViewMode(mode) { if (VIEW_MODES.includes(mode)) { viewMode = mode; lsSet(prefKey('viewMode'), mode); } }
export function setCustomDays(n) {
  customDays = clampCustomDays(n);
  lsSet(prefKey('customDays'), String(customDays));
  return customDays;
}
export function setFocusDate(d) { if (d) focusDate = d; }

// 切换团队后按「当前 activeTeam」回填 viewMode/customDays（localStorage 命名空间；无值保留默认）
export function hydratePrefs() {
  const vm = lsGet(prefKey('viewMode'));
  viewMode = VIEW_MODES.includes(vm) ? vm : '30d';
  customDays = clampCustomDays(lsGet(prefKey('customDays')));
}

// 打印选项（上次确认的设置）：由 /api/bootstrap 回填，确认打印时写回 settings 表
export let printOptions = null;
export function setPrintOptions(v) { printOptions = v || null; }

// ── 筛选 / 搜索（F1.5 + F2.1）──
// filterDepts/filterRoles：选中的部门/角色数组（空 = 不限）；filterProjectId：限定项目；filterOwnerId：限定项目负责人ID；searchQ：名称模糊匹配
export let filters = { departments: [], roles: [], projectId: '', ownerId: '', archived: false };
export let searchQ = '';

export function setFilter(key, value) { filters[key] = value; }
export function toggleFilterMember(key, value) {
  const arr = filters[key] || [];
  const i = arr.indexOf(value);
  if (i === -1) arr.push(value); else arr.splice(i, 1);
  filters[key] = arr;
}
export function clearFilters() {
  filters = { departments: [], roles: [], projectId: '', ownerId: '', archived: false };
  searchQ = '';
}
export function setSearchQ(q) { searchQ = String(q || '').trim().toLowerCase(); }
export function hasActiveFilters() {
  return !!(filters.departments.length || filters.roles.length || filters.projectId || filters.ownerId || searchQ);
}

// 行是否命中筛选 + 搜索（view: 'person' | 'project'）—— calendar.js 渲染与 panels.js 统计共用
export function rowMatches(row, view) {
  if (!row) return false;

  // 团队工作区：项目向过滤（activeTeam 非空时收窄行集合；'' = 全部团队，不过滤）。
  // 项目视图：只看 team_id=X 的项目；人员视图：只看「属于 X 的人」（home=X 或在 X 项目有排期=借调）。
  // 注意：此处仅控制「显示哪些行」；行内负载/冲突颜色仍由 totalHours/loadRate/isConflictCell 全局计算（不变量）。
  if (activeTeam) {
    if (view === 'project') {
      if (String(row.teamId || '') !== activeTeam) return false;
    } else if (!personInTeam(row, activeTeam)) {
      return false;
    }
  }

  if (view === 'person') {
    // 1. 部门多选过滤
    if (filters.departments.length && !filters.departments.includes(row.department)) {
      return false;
    }
    // 2. 角色多选过滤
    if (filters.roles.length && !filters.roles.includes(row.role)) {
      return false;
    }
    // 3. 项目单选过滤：人员在此项目有排期
    if (filters.projectId) {
      const hasProj = state.assignments.some(a => String(a.personId) === String(row.id) && String(a.projectId) === String(filters.projectId));
      if (!hasProj) return false;
    }
    // 4. 项目负责人单选过滤：人员在此负责人名下的项目有排期
    if (filters.ownerId) {
      const hasOwner = state.assignments.some(a => {
        const pr = project(a.projectId);
        return pr && pr.ownerId === filters.ownerId && String(a.personId) === String(row.id);
      });
      if (!hasOwner) return false;
    }
    // 5. 模糊搜索
    if (searchQ) {
      // 自身属性匹配
      const direct = (row.name + ' ' + (row.department || '') + ' ' + (row.role || '')).toLowerCase().includes(searchQ);
      if (direct) return true;

      // 任务（排期）匹配
      const matchesAssign = state.assignments.some(a => {
        if (String(a.personId) !== String(row.id)) return false;
        return assignmentMatches(a);
      });
      if (matchesAssign) return true;

      // 里程碑匹配（属于此人参与的项目）
      const matchesMilestone = state.milestones.some(m => {
        if (!milestoneMatches(m)) return false;
        if (m.ownerId === row.id) return true;
        if (!m.ownerId) {
          return state.assignments.some(a => String(a.personId) === String(row.id) && String(a.projectId) === String(m.projectId));
        }
        return false;
      });
      if (matchesMilestone) return true;

      return false;
    }
  } else {
    // view === 'project'
    // 1. 项目单选过滤
    if (filters.projectId && String(row.id) !== String(filters.projectId)) {
      return false;
    }
    // 2. 项目负责人单选过滤
    if (filters.ownerId && row.ownerId !== filters.ownerId) {
      return false;
    }
    // 3. 部门多选过滤：项目下有该部门的人员排期，或有该部门人员负责的里程碑
    if (filters.departments.length) {
      const hasAssign = state.assignments.some(a => {
        if (String(a.projectId) !== String(row.id)) return false;
        const p = person(a.personId);
        return p && filters.departments.includes(p.department);
      });
      const hasMilestone = state.milestones.some(m => {
        if (String(m.projectId) !== String(row.id)) return false;
        if (!m.ownerId) return false;
        const p = person(m.ownerId);
        return p && filters.departments.includes(p.department);
      });
      if (!hasAssign && !hasMilestone) return false;
    }
    // 4. 角色多选过滤：项目下有该角色人员的排期，或该角色人员负责的里程碑
    if (filters.roles.length) {
      const hasAssign = state.assignments.some(a => {
        if (String(a.projectId) !== String(row.id)) return false;
        const p = person(a.personId);
        return p && filters.roles.includes(p.role);
      });
      const hasMilestone = state.milestones.some(m => {
        if (String(m.projectId) !== String(row.id)) return false;
        if (!m.ownerId) return false;
        const p = person(m.ownerId);
        return p && filters.roles.includes(p.role);
      });
      if (!hasAssign && !hasMilestone) return false;
    }
    // 5. 模糊搜索
    if (searchQ) {
      // 项目属性匹配
      const ownerName = person(row.ownerId)?.name || '';
      const direct = (row.name + ' ' + ownerName).toLowerCase().includes(searchQ);
      if (direct) return true;

      // 任务匹配
      const matchesAssign = state.assignments.some(a => {
        if (String(a.projectId) !== String(row.id)) return false;
        return assignmentMatches(a);
      });
      if (matchesAssign) return true;

      // 里程碑匹配
      const matchesMilestone = state.milestones.some(m => {
        if (String(m.projectId) !== String(row.id)) return false;
        return milestoneMatches(m);
      });
      if (matchesMilestone) return true;

      return false;
    }
  }

  return true;
}

// 任务是否命中当前筛选（部门、角色、项目、项目负责人、搜索词）
export function assignmentMatches(a) {
  if (!a) return false;
  const p = person(a.personId) || {};
  const pr = project(a.projectId) || {};
  
  if (filters.departments.length && !filters.departments.includes(p.department)) return false;
  if (filters.roles.length && !filters.roles.includes(p.role)) return false;
  if (filters.projectId && String(a.projectId) !== String(filters.projectId)) return false;
  if (filters.ownerId && pr.ownerId !== filters.ownerId) return false;
  
  if (searchQ) {
    const hay = (
      p.name + ' ' + 
      (p.department || '') + ' ' + 
      (p.role || '') + ' ' + 
      pr.name + ' ' + 
      (person(pr.ownerId)?.name || '') + ' ' + 
      (a.note || '')
    ).toLowerCase();
    if (!hay.includes(searchQ)) return false;
  }
  return true;
}

// 里程碑是否命中当前筛选
export function milestoneMatches(m) {
  if (!m) return false;
  const pr = project(m.projectId) || {};
  
  if (filters.projectId && String(m.projectId) !== String(filters.projectId)) return false;
  if (filters.ownerId && pr.ownerId !== filters.ownerId) return false;
  
  if (filters.departments.length || filters.roles.length) {
    if (m.ownerId) {
      const p = person(m.ownerId);
      if (p) {
        if (filters.departments.length && !filters.departments.includes(p.department)) return false;
        if (filters.roles.length && !filters.roles.includes(p.role)) return false;
      } else {
        return false;
      }
    } else {
      const hasMatchingAssignment = state.assignments.some(a => {
        if (a.projectId !== m.projectId) return false;
        const p = person(a.personId);
        if (!p) return false;
        if (filters.departments.length && !filters.departments.includes(p.department)) return false;
        if (filters.roles.length && !filters.roles.includes(p.role)) return false;
        return true;
      });
      if (!hasMatchingAssignment) return false;
    }
  }
  
  if (searchQ) {
    const hay = (
      m.name + ' ' + 
      (person(m.ownerId)?.name || '') + ' ' + 
      (m.description || '') + ' ' + 
      pr.name
    ).toLowerCase();
    
    let matchesPersonInProject = false;
    const matchingPeople = state.people.filter(p => p.name.toLowerCase().includes(searchQ));
    if (matchingPeople.length) {
      matchesPersonInProject = state.assignments.some(a => 
        a.projectId === m.projectId && matchingPeople.some(p => p.id === a.personId)
      );
    }
    
    if (!hay.includes(searchQ) && !matchesPersonInProject) return false;
  }
  return true;
}


// ── 撤销栈（F1.4）──
// 每项 entry = { label, run: async () => void }；run 执行反向操作并触发刷新
export const UNDO_LIMIT = 8;
export let undoStack = [];

export function pushUndo(entry) {
  if (isReadOnlyMode()) return;
  undoStack.push(entry);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  updateUndoBadge();
}
export function canUndo() { return undoStack.length > 0; }
export async function undoLast() {
  if (!undoStack.length) return false;
  const entry = undoStack.pop();
  updateUndoBadge();
  try { await entry.run(); } catch (_) { /* 撤销失败静默，不破坏数据 */ }
  return true;
}
export function clearUndo() { undoStack = []; updateUndoBadge(); }
export function updateUndoBadge() {
  if (typeof document === 'undefined') return;
  const el = $('undoBtn');
  if (el) el.classList.toggle('disabled', undoStack.length === 0);
}

// ── 视图开关（F1.2 冲突高亮 / F2.4 里程碑到期）──
export let conflictHighlight = false;
export function setConflictHighlight(v) { conflictHighlight = !!v; }
export const UPCOMING_DAYS = 7; // 里程碑「即将到期」窗口（天）
export function daysFromToday(dateIso) {
  return dayDiff(iso(todayDate()), dateIso);
}
export function milestoneStatus(dateIso) {
  const n = daysFromToday(dateIso);
  if (n < 0) return { state: 'overdue', days: -n };
  if (n <= UPCOMING_DAYS) return { state: 'upcoming', days: n };
  return { state: 'normal', days: n };
}

export function isReadOnlyMode() {
  return readOnlyMode;
}

// ── DOM 工具 ──
export const $ = id => document.getElementById(id);

export function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── 日期工具 ──
export function iso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function addDays(d, n) {
  let x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// ── 视图模式 / 焦点日期相关 ──

// 返回今天（00:00 本地）的 Date
export function todayDate() {
  let t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

// 根据 viewMode + focusDate 生成日期窗口（F1.1 + F2.2）
// 30d：focusDate-1 ~ focusDate+30（32 天，向后兼容原 today-1~today+30 视觉）
// custom：focusDate ~ focusDate+customDays-1（正好 customDays 列，今天为首列）
export function datesForView(mode, dateIso) {
  const anchor = dateIso || iso(todayDate());
  if (mode === 'custom') {
    const start = addDays(new Date(anchor + 'T00:00:00'), -1);
    return buildDateRange(iso(start), iso(addDays(start, customDays - 1)));
  }
  if (mode === '45d' || mode === '60d') {
    const days = mode === '45d' ? 45 : 60;
    const start = addDays(new Date(anchor + 'T00:00:00'), -1);
    const out = [];
    for (let i = 0; i <= days + 1; i++) out.push(iso(addDays(start, i)));
    return out;
  }
  // 默认 30d：窗口与原实现一致（focus-1 ~ focus+30，共 32 天）
  const start = addDays(new Date(anchor + 'T00:00:00'), -1);
  const out = [];
  for (let i = 0; i <= 31; i++) out.push(iso(addDays(start, i)));
  return out;
}

// 生成从 start 到 end（含两端）的连续 ISO 日期数组
export function buildDateRange(startIso, endIso) {
  let s = new Date(startIso + 'T00:00:00');
  let e = new Date(endIso + 'T00:00:00');
  let out = [];
  let cur = s;
  while (cur <= e) { out.push(iso(cur)); cur = addDays(cur, 1); }
  return out;
}

// 根据当前 viewMode + focusDate 重建 dates 并刷新 rangeTitle
// 首次调用（focusDate 为空）时锚定到今天；之后保留用户翻页/切换的焦点
export function buildDates() {
  if (!focusDate) focusDate = iso(todayDate());
  setDates(datesForView(viewMode, focusDate));
  renderRangeTitle();
}

// 渲染顶部日期范围标题
export function renderRangeTitle() {
  if (!dates.length) return;
  const el = $('rangeTitle');
  if (!el) return;
  const first = dates[0], last = dates[dates.length - 1];
  el.textContent = `${first} ~ ${last}`;
}

// 回到今天（F1.1）：把焦点日期重置为今天并重建窗口
export function resetFocusToToday() {
  focusDate = iso(todayDate());
}

const WD_ZH = '日一二三四五六';
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function weekday(d) {
  const i = new Date(d + 'T00:00:00').getDay();
  return getLang() === 'en' ? WD_EN[i] : WD_ZH[i];
}

export function isWeekend(d) {
  let x = new Date(d + 'T00:00:00').getDay();
  return x === 0 || x === 6;
}

export function isDayOff(d) {
  const h = holidayMap[d];
  if (h) return h.isOffDay;
  return isWeekend(d);
}

export function dayClass(d) {
  const h = holidayMap[d];
  if (h) return h.isOffDay ? 'holiday' : 'makeup';
  return isWeekend(d) ? 'weekend' : '';
}

export function dayLabel(d) {
  const h = holidayMap[d];
  if (h) return h.isOffDay ? h.name : (getLang() === 'en' ? 'Work' : '班');
  return '';
}

export function isPast(d) {
  return d < iso(new Date());
}

export function endOf(a) {
  return a.endDate || a.date;
}

export function inRange(a, d) {
  return a.date <= d && endOf(a) >= d;
}

export function rangeDays(start, end) {
  let s = new Date(start + 'T00:00:00'), e = new Date((end || start) + 'T00:00:00');
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

export function workingDays(start, end) {
  let count = 0;
  let d = new Date(start + 'T00:00:00'), e = new Date((end || start) + 'T00:00:00');
  while (d <= e) {
    if (!isDayOff(iso(d))) count++;
    d.setDate(d.getDate() + 1);
  }
  return Math.max(1, count);
}

export function shiftRange(a, newStart) {
  let days = rangeDays(a.date, endOf(a));
  let end = iso(addDays(new Date(newStart + 'T00:00:00'), days - 1));
  return { date: newStart, endDate: end };
}

export function overlapDays(a, ds) {
  return ds.filter(d => inRange(a, d)).length;
}

export function totalHours(pid, date) {
  return state.assignments
    .filter(a => a.personId === pid && inRange(a, date))
    .reduce((s, a) => s + Number(a.hours || 0), 0);
}

// 某人当日负载率 = 已分配工时 / 每日产能（F2.3 热力 / F2.5 冲突判定）
export function loadRate(pid, date) {
  const p = person(pid);
  const cap = Number((p && p.dailyCapacity) || 8);
  if (!cap) return 0;
  return totalHours(pid, date) / cap;
}

// 排期条对应人员的 FTE（占产能比例）—— X5
export function fteOf(assignment) {
  const p = person(assignment.personId);
  const cap = Number((p && p.dailyCapacity) || 8);
  if (!cap) return 0;
  return Number(assignment.hours || 0) / cap;
}

// ── 冲突解决（F2.5）── 纯计算，便于 Node 单测；不触碰 DOM / 不发请求 ──

// 某人某日覆盖到的排期（保留插入顺序）
export function assignmentsOn(pid, date) {
  return state.assignments.filter(a => a.personId === pid && inRange(a, date));
}

// 某人某日是否冲突（工作日且产能溢出）
export function isConflictCell(pid, date) {
  if (isDayOff(date)) return false;
  const p = person(pid);
  return totalHours(pid, date) > Number((p && p.dailyCapacity) || 8);
}

// 某人某日溢出工时（>0 即冲突）
export function overflowHours(pid, date) {
  const p = person(pid);
  const cap = Number((p && p.dailyCapacity) || 8);
  return Math.max(0, totalHours(pid, date) - cap);
}

// 把排期 a「仅在某一天 date」的工时调整为 newHoursOnDate，其余天保持不变（多日排期按天拆分）
// 返回替换 a 的分片数组（每片 {hours,date,endDate}）；若无需变化返回单元素原值
// 注：分片都是原区间 [sd,ed] 的子区间，故仍在原项目范围内（服务端 _validate_project_dates 不会拒绝）
export function splitPlanForDay(a, date, newHoursOnDate) {
  const sd = a.date, ed = endOf(a), h = Number(a.hours || 0);
  if (date < sd || date > ed) return [{ hours: h, date: sd, endDate: ed }];
  if (newHoursOnDate >= h) return [{ hours: h, date: sd, endDate: ed }];
  const pieces = [];
  if (sd < date) pieces.push({ hours: h, date: sd, endDate: addDaysIso(date, -1) });
  if (newHoursOnDate > 0) pieces.push({ hours: newHoursOnDate, date, endDate: date });
  if (ed > date) pieces.push({ hours: h, date: addDaysIso(date, 1), endDate: ed });
  return pieces;
}

// 「减少工时至产能上限」计划：从后往前削减当天工时，直到当日 total ≤ cap
// 返回 { ops: [{deleteId, create:[payload...]}], resolved }
//   - deleteId：要删除的原排期 id（被分片替代）；create：替代分片（完整 payload，含 personId/projectId/note）
export function planReduceToCapacity(pid, date) {
  const p = person(pid);
  const cap = Number((p && p.dailyCapacity) || 8);
  const list = assignmentsOn(pid, date).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  let total = list.reduce((s, a) => s + Number(a.hours || 0), 0);
  if (total <= cap) return { ops: [], resolved: true };
  const ops = [];
  for (let i = list.length - 1; i >= 0 && total > cap; i--) {
    const a = list[i];
    const h = Number(a.hours || 0);
    const excess = total - cap;        // 当天还需削掉的工时
    const absorb = Math.min(h, excess); // 该排期当天可贡献的削减量
    const remain = h - absorb;          // 当天剩下的工时
    const create = splitPlanForDay(a, date, remain)
      .map(pc => ({ personId: a.personId, projectId: a.projectId, hours: pc.hours, date: pc.date, endDate: pc.endDate, note: a.note || '' }));
    ops.push({ deleteId: a.id, create });
    total -= absorb;
  }
  return { ops, resolved: total <= cap };
}

// 在 date 之后查找第一个「能容纳 extra 小时且不越 bound」的工作日；找不到返回 ''
export function nextFreeWorkDay(pid, date, extra, bound, maxSearch = 21) {
  const cap = Number((person(pid) && person(pid).dailyCapacity) || 8);
  // 1) 优先找加入后仍不超载的工作日
  for (let i = 1; i <= maxSearch; i++) {
    const d = addDaysIso(date, i);
    if (isDayOff(d)) continue;
    if (bound && d > bound) break;
    if (totalHours(pid, d) + extra <= cap) return d;
  }
  // 2) 退而求其次：任意一个工作日（可能再次冲突，但仍合法/不越项目范围）
  for (let i = 1; i <= maxSearch; i++) {
    const d = addDaysIso(date, i);
    if (isDayOff(d)) continue;
    if (bound && d > bound) break;
    return d;
  }
  return '';
}

// 「平摊/转移到相邻工作日」计划：把溢出工时从当天移到下一个可容纳的工作日
// 返回 { ops, targetDate, movedHours } 或 null（无合法目标）
export function planSpreadToAdjacent(pid, date) {
  const p = person(pid);
  const cap = Number((p && p.dailyCapacity) || 8);
  const list = assignmentsOn(pid, date).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  let overflow = Math.max(0, list.reduce((s, a) => s + Number(a.hours || 0), 0) - cap);
  if (overflow <= 0) return null;
  // 目标日不能超过任何一个贡献排期所属项目的结束日（保证服务端范围校验通过）
  let bound = '';
  list.forEach(a => { const pr = project(a.projectId); if (pr && pr.endDate && (!bound || pr.endDate < bound)) bound = pr.endDate; });
  const target = nextFreeWorkDay(pid, date, overflow, bound);
  if (!target) return null;
  const ops = [];
  const buckets = []; // {projectId, hours}：在 target 上按项目合并的单日排期
  const addBucket = (prid, hrs) => {
    const f = buckets.find(b => String(b.projectId) === String(prid));
    if (f) f.hours += hrs; else buckets.push({ projectId: prid, hours: hrs });
  };
  for (let i = list.length - 1; i >= 0 && overflow > 0; i--) {
    const a = list[i];
    const h = Number(a.hours || 0);
    const absorb = Math.min(h, overflow);
    const remain = h - absorb;
    const create = splitPlanForDay(a, date, remain)
      .map(pc => ({ personId: a.personId, projectId: a.projectId, hours: pc.hours, date: pc.date, endDate: pc.endDate, note: a.note || '' }));
    ops.push({ deleteId: a.id, create });
    addBucket(a.projectId, absorb);
    overflow -= absorb;
  }
  buckets.forEach(b => {
    const hrs = Math.round(b.hours * 10) / 10;
    if (hrs > 0) ops.push({ deleteId: null, create: [{ personId: pid, projectId: b.projectId, hours: hrs, date: target, endDate: target, note: t('resolve.spreadNote') }] });
  });
  return { ops, targetDate: target, movedHours: buckets.reduce((s, b) => s + b.hours, 0) };
}

export function dayDiff(d1, d2) {
  return Math.round((new Date(d2 + 'T00:00:00') - new Date(d1 + 'T00:00:00')) / 86400000);
}

export function addDaysIso(dateStr, n) {
  return iso(addDays(new Date(dateStr + 'T00:00:00'), n));
}

// ── 颜色工具 ──
const PALETTE = ['#7db7ff','#92d987','#ffb84d','#b69cff','#ff9f9f','#7ee0d6','#ffd86b','#c4a484','#b8e986','#f7a8d8','#9ad1ff','#d4b5ff'];

export function stableColor(seed) {
  let h = 0;
  String(seed || '').split('').forEach(ch => h = (h * 31 + ch.charCodeAt(0)) >>> 0);
  return PALETTE[h % PALETTE.length];
}

export function personColor(p) {
  return p.color || stableColor('person-' + (p.id || p.name));
}

export function projectColor(pr) {
  return pr.color || stableColor('project-' + (pr.id || pr.name));
}

// ── 查找工具 ──
export function person(id) {
  return state.people.find(x => x.id === id);
}

export function project(id) {
  return state.projects.find(x => x.id === id);
}

export function team(id) {
  return state.teams.find(x => x.id === id);
}

// 项目的团队归属 id（实时推导）
export function projectTeamId(id) {
  const pr = state.projects.find(x => x.id === id);
  return pr ? pr.teamId : '';
}

// 某人是否属于团队 X（人向）：home_team_id===X，或在该团队项目上有排期（含借调）。
// teamId 为空（全局视图）时恒真。
export function personInTeam(p, teamId) {
  if (!teamId) return true;
  if (!p) return false;
  if (p.homeTeamId === teamId) return true;
  return state.assignments.some(a => a.personId === p.id && projectTeamId(a.projectId) === teamId);
}

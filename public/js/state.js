// state.js — 全局状态、日期/颜色工具函数

// ── 全局状态 ──
export let state = { people: [], projects: [], assignments: [], milestones: [] };
export let activeTab = 'projects';
export let resourceTab = 'people';
export let settingsTab = 'people';
export let dates = [];
export let holidayMap = {};
export let selectedBarId = null;
export let selectedMilestoneId = null;

export function setState(newState) { state = newState; }
export function setActiveTab(tab) { activeTab = tab; }
export function setResourceTab(tab) { resourceTab = tab; }
export function setSettingsTab(tab) { settingsTab = tab; }
export function setDates(d) { dates = d; }
export function setHolidayMap(m) { holidayMap = m; }
export function setSelectedBarId(id) { selectedBarId = id; }
export function setSelectedMilestoneId(id) { selectedMilestoneId = id; }

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

export function buildDates() {
  let today = new Date();
  today.setHours(0, 0, 0, 0);
  let d = [];
  for (let i = -1; i <= 30; i++) d.push(iso(addDays(today, i)));
  setDates(d);
  $('rangeTitle').textContent = `${dates[0]} ~ ${dates[dates.length - 1]}`;
}

export function weekday(d) {
  return '日一二三四五六'[new Date(d + 'T00:00:00').getDay()];
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
  if (h) return h.isOffDay ? h.name : '班';
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

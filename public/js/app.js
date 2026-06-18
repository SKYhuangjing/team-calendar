// app.js — 入口模块：启动、renderAll、setTab、事件绑定

import {
  $, activeTab, setActiveTab, setReadOnlyMode, isReadOnlyMode,
  viewMode, setViewMode, customDays, setCustomDays, resetFocusToToday, buildDates,
  setSearchQ, setFilter, clearFilters, toggleFilterMember, filters,
  state, esc, person, project, workingDays, endOf, assignmentMatches, milestoneMatches, rowMatches,
  dates, isDayOff, totalHours, milestoneStatus, setDates, addDaysIso, renderRangeTitle,
  printOptions, setPrintOptions,
  setActiveTeam, getActiveTeam, hydratePrefs
} from './state.js';
import { load, saveTeamSetting, fetchTeamSettings } from './api.js';
import { renderScheduler } from './calendar.js';
import {
  renderStats, renderSettings, renderResourceBody, setRenderAll as setPanelsRenderAll,
  openDrawer, toast, updatePerDayHint, renderFilters, showModal, closeModal
} from './panels.js';
import { bindEvents, setRenderAll } from './interactions.js';
import { initI18n, t, setLang, getLang, applyStaticText } from './i18n.js';

// ── 主题常量（X3）：必须在 applyStoredTheme() 首次调用前完成初始化 ──
const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: 'theme.auto', light: 'theme.light', dark: 'theme.dark' };

// ── 视图切换按钮高亮（F2.2） ──
function syncViewModeChrome() {
  document.querySelectorAll('.view-switch .seg').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.viewMode === viewMode);
  });
  // 自定义天数输入盒：仅在 custom 视图显示；回填当前 customDays（编辑中不覆盖）
  const box = $('customDaysBox');
  if (box) box.style.display = viewMode === 'custom' ? 'inline-flex' : 'none';
  const input = $('customDaysInput');
  if (input && document.activeElement !== input) input.value = customDays;
}

// ── 切换视图模式后重建日历（保留焦点日期，F1.1/F2.2 正交） ──
function changeViewMode(mode) {
  if (mode === viewMode) return;
  setViewMode(mode);
  syncViewModeChrome();
  rebuildCalendar();
  if (!isReadOnlyMode()) {
    saveTeamSetting('viewMode', mode).catch(err => console.error('Save viewMode failed:', err));
  }
}

// ── 团队切换器（0.0.4 升级为自定义下拉）：渲染自定义下拉 ──
function renderTeamSelect() {
  const container = $('customTeamSelect');
  const labelEl = $('teamSelectLabel');
  const dotEl = $('teamSelectDot');
  const optionsEl = $('teamSelectOptions');
  if (!container || !labelEl || !dotEl || !optionsEl) return;

  const activeId = getActiveTeam() || '';
  const activeTm = state.teams.find(t => t.id === activeId);

  // 1. 更新 Trigger 状态
  if (activeTm) {
    labelEl.textContent = activeTm.name;
    dotEl.style.backgroundColor = activeTm.color || 'transparent';
    dotEl.style.display = 'inline-block';
  } else {
    labelEl.textContent = t('team.all');
    dotEl.style.display = 'none';
  }

  // 2. 生成下拉选项列表 HTML
  const allOptionHtml = `<li role="option" data-value="" class="${!activeId ? 'selected' : ''}">
    ${esc(t('team.all'))}
  </li>`;

  const teamOptionsHtml = state.teams
    .filter(x => !x.archived)
    .map(tm => {
      const isSelected = tm.id === activeId;
      return `<li role="option" data-value="${esc(tm.id)}" class="${isSelected ? 'selected' : ''}">
        <span class="option-dot" style="background-color: ${esc(tm.color || '#ccc')}"></span>
        ${esc(tm.name)}
      </li>`;
    })
    .join('');

  optionsEl.innerHTML = allOptionHtml + teamOptionsHtml;
}

// 切换团队：持久化当前团队偏好 → 切 activeTeam → 回填目标团队偏好 → 重建日历
async function switchTeam(targetId) {
  if (targetId === getActiveTeam()) return;
  if (!isReadOnlyMode()) {
    try {
      await Promise.all([
        saveTeamSetting('viewMode', viewMode),
        saveTeamSetting('customDays', String(customDays)),
        printOptions ? saveTeamSetting('printOptions', JSON.stringify(printOptions)) : Promise.resolve(),
      ]);
    } catch (_) { /* 持久化失败不阻断切换 */ }
  }
  setActiveTeam(targetId);
  try { localStorage.setItem('rc_activeTeam', targetId || ''); } catch (_) { /* 忽略 */ }
  try {
    const s = await fetchTeamSettings(targetId);
    if (s.viewMode) setViewMode(s.viewMode);
    if (s.customDays) setCustomDays(parseInt(s.customDays, 10));
    setPrintOptions(s.printOptions ? JSON.parse(s.printOptions) : null);
  } catch (_) { hydratePrefs(); /* 服务端回填失败：用本地命名空间兜底 */ }
  syncViewModeChrome();
  buildDates();
  renderAll();
}

// ── 重建 dates 窗口并刷新日历/统计/标题（翻页、今天、视图切换共用） ──
function rebuildCalendar() {
  buildDates();
  renderMain();
  renderStats();
  const calWrap = document.querySelector('.calendar-wrap');
  if (calWrap) calWrap.scrollLeft = 0;
}

function syncReadOnlyUi() {
  const readOnly = isReadOnlyMode();
  document.body.classList.toggle('readonly-mode', readOnly);
  if (readOnly && activeTab === 'settings') setActiveTab('projects');
  updateTabChrome();
  const existingBadge = $('readonlyBadge');
  if (!readOnly) {
    existingBadge?.remove();
    return;
  }
  const primaryHeader = document.querySelector('.primary-header');
  if (primaryHeader && !existingBadge) {
    const badge = document.createElement('span');
    badge.id = 'readonlyBadge';
    badge.className = 'readonly-badge';
    badge.dataset.i18n = 'readonly.badge';
    badge.textContent = t('readonly.badge');
    primaryHeader.insertBefore(badge, $('undoBtn') || primaryHeader.lastElementChild);
  }
}

function updateTabChrome() {
  ['Projects', 'People', 'Settings'].forEach(n => $('tab' + n).classList.remove('active'));
  const tabName = activeTab === 'projects' ? 'Projects' : activeTab === 'people' ? 'People' : 'Settings';
  $('tab' + tabName).classList.add('active');
  $('calendarCard').style.display = activeTab === 'settings' ? 'none' : 'block';
  $('settingsCard').style.display = activeTab === 'settings' ? 'block' : 'none';
  
  // Settings 视图隐藏 controls-header 以保持干净
  const isSettings = activeTab === 'settings';
  const ctrlRow = $('calendarControlsRow');
  if (ctrlRow) {
    ctrlRow.style.display = isSettings ? 'none' : 'flex';
  }
}

function initReadOnlyMode() {
  const params = new URLSearchParams(window.location.search);
  const readOnly = params.get('readonly') === '1' || params.get('mode') === 'readonly';
  setReadOnlyMode(readOnly);
  syncReadOnlyUi();
}

// ── renderAll ──
async function renderAll() {
  syncReadOnlyUi();
  syncViewModeChrome();
  renderTeamSelect();
  renderStats();
  const calWrap = document.querySelector('.calendar-wrap');
  const scrollLeft = calWrap ? calWrap.scrollLeft : 0;
  renderMain();
  if (calWrap) calWrap.scrollLeft = scrollLeft;
  renderResourceBody();
  renderSettings();
  renderFilters();
}

// ── setTab ──
function setTab(tab) {
  if (isReadOnlyMode() && tab === 'settings') {
    toast(t('toast.readonlySettings'));
    return;
  }
  setActiveTab(tab);
  updateTabChrome();
  renderMain();
}

function renderMain() {
  if (activeTab === 'settings') { renderSettings(); return; }
  // 离开设置页时，清理批量操作浮动条与勾选状态，避免悬浮条残留
  const bar = document.getElementById('batchActionBar');
  if (bar) bar.remove();
  document.querySelectorAll('.batch-select-person, .batch-select-project').forEach(cb => cb.checked = false);
  renderScheduler(activeTab === 'people' ? 'person' : 'project');
}

// ── 注入全局引用 ──
setRenderAll(renderAll);
setPanelsRenderAll(renderAll);

// 暴露 updatePerDayHint 到 window（供 inline onchange 使用）
window._panelsModule = { updatePerDayHint };
// 撤销后的刷新回调（interactions/panels 的 toast 撤销链接调用）
window._undoRefresh = renderAll;

// ── 只读模式 ──
initReadOnlyMode();

// 视图切换按钮初始高亮（30 天为默认）
syncViewModeChrome();

// ── 主题（X3 暗色模式）── 初始应用
applyStoredTheme();

// ── 国际化（X4）── 初始应用
initI18n();
$('langSelect').value = getLang();
$('langSelect').addEventListener('change', function () {
  setLang(this.value);
  applyStaticText();
  applyStoredTheme(); // 主题按钮文案随语言刷新
  renderAll();
});

// ── 绑定事件 ──
bindEvents();

// ── 自定义天数输入（custom 视图）：改值后重建窗口（保留焦点日期） ──
$('customDaysInput').addEventListener('change', function () {
  setCustomDays(this.value);
  this.value = customDays; // 回填钳制后的值
  rebuildCalendar();
  if (!isReadOnlyMode()) {
    saveTeamSetting('customDays', String(customDays)).catch(err => console.error('Save customDays failed:', err));
  }
});

// ── 团队切换器：自定义下拉交互逻辑 ──
(function () {
  const container = $('customTeamSelect');
  const trigger = $('teamSelectTrigger');
  const optionsEl = $('teamSelectOptions');
  if (!container || !trigger || !optionsEl) return;

  // 点击触发器：切换展开/收起
  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    const isOpen = container.classList.toggle('open');
    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    optionsEl.classList.toggle('show', isOpen);
  });

  // 点击选项：切换团队
  optionsEl.addEventListener('click', function (e) {
    const li = e.target.closest('li[role="option"]');
    if (li) {
      const val = li.dataset.value;
      switchTeam(val);
      
      // 关闭下拉
      container.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      optionsEl.classList.remove('show');
    }
  });

  // 点击外部：收起下拉
  document.addEventListener('click', function (e) {
    if (!container.contains(e.target)) {
      container.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      optionsEl.classList.remove('show');
    }
  });
})();

// ── 日历左右滑动 / 滚动边界触发时间翻页 ──
(function () {
  let lastSwipeTime = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartTime = 0;
  let isDraggingForSwipe = false;

  let isShiftingDates = false;

  // 用遮罩包住一次同步重绘：双 rAF 确保 spinner 先绘制一帧，再执行 renderAll，结束后撤掉遮罩
  function renderWithOverlay(doRender) {
    const loader = $('calendarLoading');
    if (loader) loader.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        doRender();
      } finally {
        if (loader) loader.classList.remove('show');
        isShiftingDates = false;
      }
    }));
  }

  function loadMorePrev() {
    if (isShiftingDates) return;
    isShiftingDates = true;

    const count = viewMode === 'custom' ? Math.ceil(customDays / 2) : (viewMode === '45d' ? 22 : (viewMode === '60d' ? 30 : 16));
    const firstDateStr = dates[0];
    const newDates = [];
    for (let i = count; i >= 1; i--) {
      newDates.push(addDaysIso(firstDateStr, -i));
    }

    const addedWidth = newDates.reduce((sum, d) => sum + (isDayOff(d) ? 44 : 88), 0);
    const keepCount = Math.max(0, dates.length - count);
    const updatedDates = [...newDates, ...dates.slice(0, keepCount)];

    setDates(updatedDates);

    renderWithOverlay(() => {
      renderRangeTitle();
      renderAll();
      const calWrap = document.querySelector('.calendar-wrap');
      if (calWrap) {
        calWrap.scrollLeft = calWrap.scrollLeft + addedWidth;
      }
      toast(t('toast.dateRangeUpdated', { range: `${updatedDates[0]} ~ ${updatedDates[updatedDates.length - 1]}` }));
    });
  }

  function loadMoreNext() {
    if (isShiftingDates) return;
    isShiftingDates = true;

    const count = viewMode === 'custom' ? Math.ceil(customDays / 2) : (viewMode === '45d' ? 22 : (viewMode === '60d' ? 30 : 16));
    const lastDateStr = dates[dates.length - 1];
    const newDates = [];
    for (let i = 1; i <= count; i++) {
      newDates.push(addDaysIso(lastDateStr, i));
    }

    const removedDates = dates.slice(0, count);
    const removedWidth = removedDates.reduce((sum, d) => sum + (isDayOff(d) ? 44 : 88), 0);
    const updatedDates = [...dates.slice(count), ...newDates];

    setDates(updatedDates);

    renderWithOverlay(() => {
      renderRangeTitle();
      renderAll();
      const calWrap = document.querySelector('.calendar-wrap');
      if (calWrap) {
        calWrap.scrollLeft = Math.max(0, calWrap.scrollLeft - removedWidth);
      }
      toast(t('toast.dateRangeUpdated', { range: `${updatedDates[0]} ~ ${updatedDates[updatedDates.length - 1]}` }));
    });
  }

  window.addEventListener('load', () => {
    const calWrap = document.querySelector('.calendar-wrap');
    if (!calWrap) return;

    // 1) 触控板/滚轮横向滚动至边界检测
    calWrap.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaX) < 15) return;
      
      const now = Date.now();
      if (now - lastSwipeTime < 800) return;
      
      const scrollLeft = calWrap.scrollLeft;
      const maxScroll = calWrap.scrollWidth - calWrap.clientWidth;
      
      if (e.deltaX < -20 && scrollLeft <= 0) {
        lastSwipeTime = now;
        loadMorePrev();
      } else if (e.deltaX > 20 && scrollLeft >= maxScroll - 2) {
        lastSwipeTime = now;
        loadMoreNext();
      }
    }, { passive: true });

    // 2) 鼠标/触摸按住拖拽左右滑动检测 (Swipe)
    calWrap.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.bar') || e.target.closest('.milestone') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) {
        return;
      }
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartTime = Date.now();
      isDraggingForSwipe = true;
    });

    window.addEventListener('pointerup', function (e) {
      if (!isDraggingForSwipe) return;
      isDraggingForSwipe = false;

      const diffX = e.clientX - dragStartX;
      const diffY = e.clientY - dragStartY;
      const timeDiff = Date.now() - dragStartTime;

      if (Math.abs(diffX) > 100 && Math.abs(diffY) < 80 && timeDiff < 400) {
        if (diffX > 0) {
          loadMorePrev();
        } else {
          loadMoreNext();
        }
      }
    });
  });
})();

// ── 筛选 / 搜索（F1.5 + F2.1）──
function applyFilterAndRender() {
  renderMain();
  renderStats();
  renderFilters();
}
$('filterToggle').addEventListener('click', function () {
  const bar = $('filterBar');
  const open = bar.style.display === 'none';
  bar.style.display = open ? 'flex' : 'none';
  this.classList.toggle('active', open);
});
$('searchInput').addEventListener('input', function () { setSearchQ(this.value); applyFilterAndRender(); });
// F1.5：部门/角色为多选（复选下拉），项目/负责人为单选
function wireMulti(id) {
  const el = $(id);
  el.addEventListener('click', function (e) {
    if (e.target.closest('.ms-btn')) {
      el.classList.toggle('open');
      const btn = el.querySelector('.ms-btn');
      if (btn) btn.setAttribute('aria-expanded', el.classList.contains('open') ? 'true' : 'false');
    }
  });
  el.addEventListener('change', function (e) {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    const key = el.dataset.msKey;
    toggleFilterMember(key, cb.value);
    const sel = filters[key] || [];
    const btn = el.querySelector('.ms-btn');
    if (btn) btn.textContent = sel.length ? el.dataset.allLabel + ' · ' + sel.length : el.dataset.allLabel;
    renderMain();   // 仅重渲染日历/统计，不重建筛选栏（避免关闭已展开的下拉）
    renderStats();
  });
}
wireMulti('filterDept');
wireMulti('filterRole');
// 点击多选外部关闭下拉
document.addEventListener('click', function (e) {
  document.querySelectorAll('.ms.open').forEach(m => { if (!m.contains(e.target)) m.classList.remove('open'); });
});
$('filterProject').addEventListener('change', function () { setFilter('projectId', this.value); applyFilterAndRender(); });
$('filterOwner').addEventListener('change', function () { setFilter('ownerId', this.value); applyFilterAndRender(); });
$('filterClear').addEventListener('click', function () {
  clearFilters();
  $('searchInput').value = '';
  ['filterProject', 'filterOwner'].forEach(id => { const s = $(id); if (s) s.value = ''; });
  applyFilterAndRender();
});

// ── 主题切换（X3）：跟随系统 / 亮 / 暗 循环 ──
function applyStoredTheme() {
  let theme = localStorage.getItem('rc_theme') || 'auto';
  let resolved = theme;
  if (theme === 'auto') resolved = (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-pref', theme);
  const btn = $('themeBtn'); if (btn) btn.textContent = t(THEME_ICON[theme]);
}
$('themeBtn').addEventListener('click', function () {
  const cur = localStorage.getItem('rc_theme') || 'auto';
  const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
  localStorage.setItem('rc_theme', next);
  applyStoredTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyStoredTheme);

// ── 打印与报表功能（P2.2） ──
let printConfig = null;

const PRI = v => ({ '高': t('label.priorityHigh'), '中': t('label.priorityMid'), '低': t('label.priorityLow') })[v] || v;

function generateReportHTML(projIds, persIds, showProj, showPers) {
  if ((!showProj && !showPers) || (projIds.length === 0 && persIds.length === 0)) {
    return `<div class="print-empty">${esc(t('empty.noMatch'))}</div>`;
  }

  // 过滤出选中的项目和人员指派
  const filteredAssigns = state.assignments.filter(a =>
    projIds.includes(String(a.projectId)) &&
    persIds.includes(String(a.personId)) &&
    assignmentMatches(a)
  );

  // 计算全局汇总工时与数据
  let globalHours = 0;
  filteredAssigns.forEach(a => {
    const days = workingDays(a.date, endOf(a));
    globalHours += Number(a.hours || 0) * days;
  });

  const totalCoveredProjects = state.projects.filter(p => !p.archived && rowMatches(p, 'project') && projIds.includes(String(p.id))).length;
  const totalCoveredPeople = state.people.filter(p => !p.archived && rowMatches(p, 'person') && persIds.includes(String(p.id))).length;

  let html = `
    <div class="print-header">
      <h1>${esc(t('print.reportTitle'))}</h1>
      <div class="print-meta">${esc($('rangeTitle').textContent)}</div>
    </div>
    
    <div class="print-summary-card">
      <div class="print-summary-item">
        <b>${globalHours.toFixed(1)}h</b>
        <small>${esc(t('print.totalHours'))}</small>
      </div>
      <div class="print-summary-item">
        <b>${(globalHours / 8).toFixed(1)} ${esc(t('print.personDays'))}</b>
        <small>${esc(t('print.totalPersonDays'))}</small>
      </div>
      <div class="print-summary-item">
        <b>${totalCoveredProjects}</b>
        <small>${esc(t('print.projectsCount'))}</small>
      </div>
      <div class="print-summary-item">
        <b>${totalCoveredPeople}</b>
        <small>${esc(t('print.peopleCount'))}</small>
      </div>
    </div>
  `;

  // ── 项目维度 ──
  if (showProj && projIds.length > 0) {
    const visibleProjects = state.projects
      .filter(p => !p.archived && rowMatches(p, 'project') && projIds.includes(String(p.id)))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (visibleProjects.length > 0) {
      visibleProjects.forEach((p, idx) => {
        const projectAssigns = filteredAssigns.filter(a => a.projectId === p.id);

        // 按照人名排序，其次按照时间排序
        projectAssigns.sort((a, b) => {
          const persA = person(a.personId) || {};
          const persB = person(b.personId) || {};
          const nameA = persA.name || '';
          const nameB = persB.name || '';
          const comp = nameA.localeCompare(nameB);
          if (comp !== 0) return comp;
          return a.date.localeCompare(b.date);
        });

        const projectMilestones = state.milestones
          .filter(m => m.projectId === p.id && milestoneMatches(m))
          .sort((a, b) => a.date.localeCompare(b.date));

        let projHours = 0;
        const personHours = {};
        let minDate = '';
        let maxDate = '';

        projectAssigns.forEach(a => {
          const days = workingDays(a.date, endOf(a));
          const hrs = Number(a.hours || 0) * days;
          projHours += hrs;

          const pers = person(a.personId);
          if (pers && hrs > 0) {
            personHours[pers.name] = (personHours[pers.name] || 0) + hrs;
          }

          if (!minDate || a.date < minDate) minDate = a.date;
          const ed = endOf(a);
          if (!maxDate || ed > maxDate) maxDate = ed;
        });

        projectMilestones.forEach(m => {
          if (!minDate || m.date < minDate) minDate = m.date;
          if (!maxDate || m.date > maxDate) maxDate = m.date;
        });

        const durationStr = minDate && maxDate ? `${minDate} ~ ${maxDate}` : '-';
        const teamSize = new Set(projectAssigns.map(a => a.personId)).size;

        if (idx > 0) {
          html += `<div style="page-break-before:always; break-before:always;"></div>`;
        }
        html += `
          <div class="print-section">
            <div class="print-keep-together">
              <div class="print-section-header">
                <h2 class="print-section-title">${esc(p.name)}</h2>
                <span class="print-section-meta">
                  ${(person(p.ownerId)?.name || p.owner) ? esc(t('cal.projectOwner')) + esc(person(p.ownerId)?.name || p.owner) + ' · ' : ''}
                  ${esc(t('label.priority'))}: ${esc(PRI(p.priority || '中'))} · 
                  <b>${esc(t('label.totalHours'))}: ${projHours.toFixed(1)}h</b>
                </span>
              </div>
              
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:14px; background:#f8fafc; border:1px solid #e2e8f0; padding:12px; border-radius:8px;">
                <div style="font-size:12px; display:flex; flex-direction:column; gap:4px; color:#333;">
                  <div><b>${esc(t('print.projectRange'))}:</b> ${esc(durationStr)}</div>
                  <div><b>${esc(t('print.teamSize'))}:</b> ${teamSize}</div>
                  <div><b>${esc(t('print.totalPersonDays'))}:</b> ${(projHours / 8).toFixed(1)} ${esc(t('print.personDays'))}</div>
                  <div><b>${esc(t('print.milestonesSummary'))}:</b> ${projectMilestones.length}</div>
                </div>
                
                <div style="display:flex; flex-direction:column; gap:4px;">
                  <div style="font-weight:bold; font-size:11px; margin-bottom:4px; text-transform:uppercase; color:#555;">${esc(t('print.projectDistribution'))}</div>
                  ${Object.entries(personHours).sort((a, b) => b[1] - a[1]).map(([name, hrs]) => {
            const pct = projHours > 0 ? (hrs / projHours * 100) : 0;
            return `
                      <div class="stat-dist-item">
                        <span class="dist-name" title="${esc(name)}">${esc(name)}</span>
                        <span class="dist-bar-wrap">
                          <span class="dist-bar" style="width:${pct}%; background-color:#7db7ff;"></span>
                        </span>
                        <span class="dist-value">${hrs.toFixed(1)}h (${pct.toFixed(1)}%)</span>
                      </div>
                    `;
          }).join('') || `<div class="print-sub-empty" style="padding:0;">-</div>`}
                </div>
              </div>
            </div>
        `;

        if (projectMilestones.length) {
          html += `
            <div class="print-sub-section">
              <h3 class="print-sub-title">◆ ${esc(t('stat.milestone'))}</h3>
              <table class="print-table">
                <thead>
                  <tr>
                    <th>${esc(t('label.milestoneName'))}</th>
                    <th>${esc(t('label.date'))}</th>
                    <th>${esc(t('label.level'))}</th>
                    <th>${esc(t('label.assignee'))}</th>
                    <th>${esc(t('label.desc'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${projectMilestones.map(m => `
                    <tr>
                      <td><b>${esc(m.name)}</b></td>
                      <td>${esc(m.date)}</td>
                      <td>${m.level === 'risk' ? `<span class="print-badge risk">${esc(t('label.levelRisk'))}</span>` : esc(t('label.levelImportant'))}</td>
                      <td>${esc(person(m.ownerId)?.name || m.owner || t('label.unassigned'))}</td>
                      <td>${esc(m.description || '-')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `;
        }

        if (projectAssigns.length) {
          html += `
            <div class="print-sub-section">
              <h3 class="print-sub-title">■ ${esc(t('tab.people'))}</h3>
              <table class="print-table">
                <thead>
                  <tr>
                    <th>${esc(t('label.person'))}</th>
                    <th>${esc(t('label.startDate'))}</th>
                    <th>${esc(t('label.endDate'))}</th>
                    <th>${esc(t('label.totalHoursH'))}</th>
                    <th>${esc(t('label.note'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${projectAssigns.map(a => {
            const pers = person(a.personId) || {};
            const workDays = workingDays(a.date, endOf(a));
            const totalH = (Number(a.hours || 0) * workDays).toFixed(1);
            return `
                      <tr>
                        <td><b>${esc(pers.name || t('cal.unnamed'))}</b> <small>(${esc(pers.department || '')} · ${esc(pers.role || '')})</small></td>
                        <td>${esc(a.date)}</td>
                        <td>${esc(endOf(a))}</td>
                        <td>${totalH}h <small>(${a.hours}h/${t('view.customDayUnit')}, ${workDays} ${t('view.customDayUnit')})</small></td>
                        <td>${esc(a.note || '-')}</td>
                      </tr>
                    `;
          }).join('')}
                </tbody>
              </table>
            </div>
          `;
        }

        if (!projectMilestones.length && !projectAssigns.length) {
          html += `<div class="print-sub-empty">${esc(t('empty.bd'))}</div>`;
        }

        html += `</div>`;
      });
    }
  }

  // ── 人员维度 ──
  if (showPers && persIds.length > 0) {
    const visiblePeople = state.people
      .filter(p => !p.archived && rowMatches(p, 'person') && persIds.includes(String(p.id)))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (visiblePeople.length > 0) {
      if (showProj && projIds.length > 0) {
        html += `<div style="page-break-before:always; break-before:always;"></div>`;
      }

      html += `
        <div class="print-header">
          <h1>${esc(t('print.reportTitle'))} - ${esc(t('tab.people'))}</h1>
          <div class="print-meta">${esc($('rangeTitle').textContent)}</div>
        </div>
      `;

      visiblePeople.forEach((p, idx) => {
        const personAssigns = filteredAssigns.filter(a => a.personId === p.id);

        // 按照项目排序，其次按照时间排序
        personAssigns.sort((a, b) => {
          const projA = project(a.projectId) || {};
          const projB = project(b.projectId) || {};
          const nameA = projA.name || '';
          const nameB = projB.name || '';
          const comp = nameA.localeCompare(nameB);
          if (comp !== 0) return comp;
          return a.date.localeCompare(b.date);
        });

        let persHours = 0;
        const projectHours = {};
        let minDate = '';
        let maxDate = '';

        personAssigns.forEach(a => {
          const days = workingDays(a.date, endOf(a));
          const hrs = Number(a.hours || 0) * days;
          persHours += hrs;

          const proj = project(a.projectId);
          if (proj && hrs > 0) {
            projectHours[proj.name] = (projectHours[proj.name] || 0) + hrs;
          }

          if (!minDate || a.date < minDate) minDate = a.date;
          const ed = endOf(a);
          if (!maxDate || ed > maxDate) maxDate = ed;
        });

        const durationStr = minDate && maxDate ? `${minDate} ~ ${maxDate}` : '-';
        const projectCount = new Set(personAssigns.map(a => a.projectId)).size;

        if (idx > 0) {
          html += `<div style="page-break-before:always; break-before:always;"></div>`;
        }
        html += `
          <div class="print-section">
            <div class="print-keep-together">
              <div class="print-section-header">
                <h2 class="print-section-title">${esc(p.name)}</h2>
                <span class="print-section-meta">
                  ${esc(p.department || '')} · ${esc(p.role || '')} · ${p.dailyCapacity}h/${t('view.customDayUnit')} · 
                  <b>${esc(t('label.totalHours'))}: ${persHours.toFixed(1)}h</b>
                </span>
              </div>
              
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:14px; background:#f8fafc; border:1px solid #e2e8f0; padding:12px; border-radius:8px;">
                <div style="font-size:12px; display:flex; flex-direction:column; gap:4px; color:#333;">
                  <div><b>${esc(t('print.activeRange'))}:</b> ${esc(durationStr)}</div>
                  <div><b>${esc(t('print.activeProjects'))}:</b> ${projectCount}</div>
                  <div><b>${esc(t('print.totalPersonDays'))}:</b> ${(persHours / (p.dailyCapacity || 8)).toFixed(1)} ${esc(t('print.personDays'))}</div>
                </div>
                
                <div style="display:flex; flex-direction:column; gap:4px;">
                  <div style="font-weight:bold; font-size:11px; margin-bottom:4px; text-transform:uppercase; color:#555;">${esc(t('print.projectDistributionLabel'))}</div>
                  ${Object.entries(projectHours).sort((a, b) => b[1] - a[1]).map(([name, hrs]) => {
            const pct = persHours > 0 ? (hrs / persHours * 100) : 0;
            return `
                      <div class="stat-dist-item">
                        <span class="dist-name" title="${esc(name)}">${esc(name)}</span>
                        <span class="dist-bar-wrap">
                          <span class="dist-bar" style="width:${pct}%; background-color:#92d987;"></span>
                        </span>
                        <span class="dist-value">${hrs.toFixed(1)}h (${pct.toFixed(1)}%)</span>
                      </div>
                    `;
          }).join('') || `<div class="print-sub-empty" style="padding:0;">-</div>`}
                </div>
              </div>
            </div>
        `;

        if (personAssigns.length) {
          html += `
            <div class="print-sub-section">
              <table class="print-table">
                <thead>
                  <tr>
                    <th>${esc(t('label.projectName'))}</th>
                    <th>${esc(t('label.startDate'))}</th>
                    <th>${esc(t('label.endDate'))}</th>
                    <th>${esc(t('label.totalHoursH'))}</th>
                    <th>${esc(t('label.note'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${personAssigns.map(a => {
            const proj = project(a.projectId) || {};
            const workDays = workingDays(a.date, endOf(a));
            const totalH = (Number(a.hours || 0) * workDays).toFixed(1);
            const ownerName = person(proj.ownerId)?.name || proj.owner || '';
            return `
                      <tr>
                        <td><b>${esc(proj.name || t('cal.unnamed'))}</b> <small>${ownerName ? esc(t('cal.projectOwner')) + esc(ownerName) : ''}</small></td>
                        <td>${esc(a.date)}</td>
                        <td>${esc(endOf(a))}</td>
                        <td>${totalH}h <small>(${a.hours}h/${t('view.customDayUnit')}, 共 ${workDays} ${t('view.customDayUnit')})</small></td>
                        <td>${esc(a.note || '-')}</td>
                      </tr>
                    `;
          }).join('')}
                </tbody>
              </table>
            </div>
          `;
        } else {
          html += `<div class="print-sub-empty">${esc(t('empty.bd'))}</div>`;
        }

        html += `</div>`;
      });
    }
  }

  return html;
}

function openPrintSetup() {
  const modalEl = document.querySelector('#modalMask .modal');
  if (modalEl) modalEl.classList.add('large');

  const visibleProjects = state.projects.filter(p => !p.archived && rowMatches(p, 'project'));
  const visiblePeople = state.people.filter(p => !p.archived && rowMatches(p, 'person'));

  const visibleProjIds = new Set(visibleProjects.map(p => String(p.id)));
  const visiblePersIds = new Set(visiblePeople.map(p => String(p.id)));

  // 回显上次确认的设置：维度开关 + 已选项目/人员（按当前可见集合过滤失效 ID）
  const saved = printOptions;
  let showProj = saved ? !!saved.showProj : true;
  let showPers = saved ? !!saved.showPers : true;
  const checkedProjIds = new Set(saved && Array.isArray(saved.projIds)
    ? saved.projIds.filter(id => visibleProjIds.has(String(id)))
    : visibleProjects.map(p => String(p.id)));
  const checkedPersIds = new Set(saved && Array.isArray(saved.persIds)
    ? saved.persIds.filter(id => visiblePersIds.has(String(id)))
    : visiblePeople.map(p => String(p.id)));

  const body = `
    <div class="print-setup-container">
      <div class="print-setup-left">
        <div>
          <label style="margin-bottom:8px; display:block; font-size:13px; font-weight:bold;">${esc(t('print.options'))}</label>
          <div style="display:flex; flex-direction:column; gap:8px;">
            <label style="font-weight:normal; color:var(--ink); font-size:13px; display:flex; align-items:center; gap:8px; cursor:pointer; margin:0;">
              <input type="checkbox" id="print_show_projects" ${showProj ? 'checked' : ''} style="width:auto;">
              ${esc(t('print.includeProjects'))}
            </label>
            <label style="font-weight:normal; color:var(--ink); font-size:13px; display:flex; align-items:center; gap:8px; cursor:pointer; margin:0;">
              <input type="checkbox" id="print_show_people" ${showPers ? 'checked' : ''} style="width:auto;">
              ${esc(t('print.includePeople'))}
            </label>
          </div>
        </div>
        
        <div id="print_project_selector_section">
          <label style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span>${esc(t('tab.projects'))}</span>
            <div style="display:flex; gap:6px;">
              <a href="#" id="print_proj_all" style="font-size:11px; text-decoration:underline; color:var(--accent); font-weight:bold;">${esc(t('print.selectAllShort'))}</a>
              <a href="#" id="print_proj_none" style="font-size:11px; text-decoration:underline; color:var(--muted); font-weight:bold;">${esc(t('print.clear'))}</a>
            </div>
          </label>
          <div id="print_projects_box" class="print-checklist-box">
            ${visibleProjects.map(p => `
              <label class="print-checklist-label" title="${esc(p.name)}">
                <input type="checkbox" class="print-proj-cb" value="${p.id}" ${checkedProjIds.has(String(p.id)) ? 'checked' : ''}>
                ${esc(p.name)}
              </label>
            `).join('') || `<div class="empty" style="padding:6px; font-size:11px;">${esc(t('empty.bd'))}</div>`}
          </div>
        </div>
        
        <div id="print_person_selector_section">
          <label style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span>${esc(t('tab.people'))}</span>
            <div style="display:flex; gap:6px;">
              <a href="#" id="print_pers_all" style="font-size:11px; text-decoration:underline; color:var(--accent); font-weight:bold;">${esc(t('print.selectAllShort'))}</a>
              <a href="#" id="print_pers_none" style="font-size:11px; text-decoration:underline; color:var(--muted); font-weight:bold;">${esc(t('print.clear'))}</a>
            </div>
          </label>
          <div id="print_people_box" class="print-checklist-box">
            ${visiblePeople.map(p => `
              <label class="print-checklist-label" title="${esc(p.name)}">
                <input type="checkbox" class="print-pers-cb" value="${p.id}" ${checkedPersIds.has(String(p.id)) ? 'checked' : ''}>
                ${esc(p.name)}
              </label>
            `).join('') || `<div class="empty" style="padding:6px; font-size:11px;">${esc(t('empty.bd'))}</div>`}
          </div>
        </div>
      </div>
      
      <div class="print-setup-right" id="print_preview_pane">
      </div>
    </div>
  `;

  showModal(t('title.printSetup'), body, onConfirmPrint, null);

  const saveBtn = $('modalSave');
  if (saveBtn) saveBtn.textContent = t('print.confirm');

  const cbProj = $('print_show_projects');
  const cbPers = $('print_show_people');

  const updateDimensionVisibility = () => {
    showProj = cbProj.checked;
    showPers = cbPers.checked;
    $('print_project_selector_section').style.display = showProj ? 'block' : 'none';
    $('print_person_selector_section').style.display = showPers ? 'block' : 'none';
    updatePreview();
  };

  cbProj.addEventListener('change', updateDimensionVisibility);
  cbPers.addEventListener('change', updateDimensionVisibility);

  $('print_proj_all').onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('.print-proj-cb').forEach(cb => { cb.checked = true; checkedProjIds.add(cb.value); });
    updatePreview();
  };
  $('print_proj_none').onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('.print-proj-cb').forEach(cb => { cb.checked = false; checkedProjIds.delete(cb.value); });
    updatePreview();
  };

  $('print_pers_all').onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('.print-pers-cb').forEach(cb => { cb.checked = true; checkedPersIds.add(cb.value); });
    updatePreview();
  };
  $('print_pers_none').onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('.print-pers-cb').forEach(cb => { cb.checked = false; checkedPersIds.delete(cb.value); });
    updatePreview();
  };

  document.querySelectorAll('.print-proj-cb').forEach(cb => {
    cb.addEventListener('change', function () {
      if (this.checked) checkedProjIds.add(this.value);
      else checkedProjIds.delete(this.value);
      updatePreview();
    });
  });
  document.querySelectorAll('.print-pers-cb').forEach(cb => {
    cb.addEventListener('change', function () {
      if (this.checked) checkedPersIds.add(this.value);
      else checkedPersIds.delete(this.value);
      updatePreview();
    });
  });

  // 初始化：按回显的维度开关同步各选择区显隐，并渲染首屏预览
  updateDimensionVisibility();

  function updatePreview() {
    const pane = $('print_preview_pane');
    if (!pane) return;

    pane.innerHTML = generateReportHTML(
      Array.from(checkedProjIds),
      Array.from(checkedPersIds),
      showProj,
      showPers
    );
  }
}

async function onConfirmPrint() {
  const showProj = $('print_show_projects').checked;
  const showPers = $('print_show_people').checked;

  const checkedProjCbs = document.querySelectorAll('.print-proj-cb:checked');
  const checkedPersCbs = document.querySelectorAll('.print-pers-cb:checked');

  const checkedProjIds = Array.from(checkedProjCbs).map(cb => cb.value);
  const checkedPersIds = Array.from(checkedPersCbs).map(cb => cb.value);

  if ((showProj && !checkedProjIds.length) || (showPers && !checkedPersIds.length)) {
    toast(showProj && !checkedProjIds.length ? t('toast.needProject') : t('toast.needPerson'));
    return;
  }

  if (!showProj && !showPers) {
    toast(t('empty.noMatch'));
    return;
  }

  printConfig = {
    showProj,
    showPers,
    projIds: checkedProjIds,
    persIds: checkedPersIds
  };

  // 记录到数据库：下次打开对话框时回显本次确认的设置（只读模式跳过写入）
  const savedOptions = { showProj, showPers, projIds: checkedProjIds, persIds: checkedPersIds };
  setPrintOptions(savedOptions);
  if (!isReadOnlyMode()) {
    saveTeamSetting('printOptions', JSON.stringify(savedOptions))
      .catch(err => console.error('Save printOptions failed:', err));
  }

  closeModal();

  setTimeout(() => {
    const handler = window.webkit?.messageHandlers?.teamCalendar;
    if (handler) {
      window.dispatchEvent(new Event('beforeprint'));
      setTimeout(() => {
        handler.postMessage({ action: 'print' });
      }, 50);
    } else {
      window.print();
    }
  }, 150);
}

$('printBtn').addEventListener('click', function () {
  openPrintSetup();
});

let originalTitle = '';

window.addEventListener('beforeprint', function () {
  originalTitle = document.title;
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}-${String(d.getSeconds()).padStart(2, '0')}`;
  document.title = `项目人力排期-${dateStr}_${timeStr}.pdf`;

  const isNativeApp = !!window.webkit?.messageHandlers?.teamCalendar;
  if (isNativeApp) {
    document.body.classList.add('native-app-print');
  }

  const container = $('printList');
  if (container) {
    if (printConfig) {
      container.innerHTML = generateReportHTML(
        printConfig.projIds,
        printConfig.persIds,
        printConfig.showProj,
        printConfig.showPers
      );
    } else {
      const visibleProjects = state.projects.filter(p => !p.archived && rowMatches(p, 'project')).map(p => String(p.id));
      const visiblePeople = state.people.filter(p => !p.archived && rowMatches(p, 'person')).map(p => String(p.id));
      container.innerHTML = generateReportHTML(visibleProjects, visiblePeople, true, true);
    }
  }
});

window.addEventListener('afterprint', function () {
  document.body.classList.remove('native-app-print');
  const container = $('printList');
  if (container) {
    container.innerHTML = '';
  }
  if (originalTitle) {
    document.title = originalTitle;
  }
  printConfig = null;
});

// ── 工具栏事件委托：第一行 primary-header（tab 切换、资源池按钮） ──
const pHeader = document.querySelector('.primary-header');
if (pHeader) {
  pHeader.addEventListener('click', function (e) {
    const tabBtn = e.target.closest('.tab');
    if (tabBtn) {
      const tab = tabBtn.id === 'tabProjects' ? 'projects' : tabBtn.id === 'tabPeople' ? 'people' : 'settings';
      setTab(tab);
      return;
    }
    const drawerBtn = e.target.closest('button');
    if (drawerBtn && drawerBtn.dataset.pool) {
      if (isReadOnlyMode()) { toast(t('toast.readonlyResource')); return; }
      openDrawer('people');
    }
  });
}

// ── 工具栏事件委托：第二行 controls-header（视图切换、翻页） ──
const cHeader = document.querySelector('.controls-header');
if (cHeader) {
  cHeader.addEventListener('click', function (e) {
    // 视图切换（F2.2）：30 天 / 周 / 月
    const segBtn = e.target.closest('.view-switch .seg');
    if (segBtn) { changeViewMode(segBtn.dataset.viewMode); return; }
    // 日期翻页（F1.1）
    if (e.target.id === 'pageToday') { resetFocusToToday(); rebuildCalendar(); return; }
  });
}

// ── 启动 ──
load(renderAll).catch(e => toast(e.message));

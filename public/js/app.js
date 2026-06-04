// app.js — 入口模块：启动、renderAll、setTab、事件绑定

import { $, activeTab, setActiveTab, setReadOnlyMode, isReadOnlyMode } from './state.js';
import { load } from './api.js';
import { renderScheduler } from './calendar.js';
import {
  renderStats, renderSettings, renderResourceBody, setRenderAll as setPanelsRenderAll,
  openDrawer, toast, updatePerDayHint
} from './panels.js';
import { bindEvents, setRenderAll } from './interactions.js';

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
  const toolbar = document.querySelector('.toolbar-row');
  if (toolbar && !existingBadge) {
    const badge = document.createElement('span');
    badge.id = 'readonlyBadge';
    badge.className = 'readonly-badge';
    badge.textContent = 'Web 只读访问';
    toolbar.insertBefore(badge, $('stats'));
  }
}

function updateTabChrome() {
  ['Projects', 'People', 'Settings'].forEach(n => $('tab' + n).classList.remove('active'));
  const tabName = activeTab === 'projects' ? 'Projects' : activeTab === 'people' ? 'People' : 'Settings';
  $('tab' + tabName).classList.add('active');
  $('calendarCard').style.display = activeTab === 'settings' ? 'none' : 'block';
  $('settingsCard').style.display = activeTab === 'settings' ? 'block' : 'none';
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
  renderStats();
  renderMain();
  renderResourceBody();
  renderSettings();
}

// ── setTab ──
function setTab(tab) {
  if (isReadOnlyMode() && tab === 'settings') {
    toast('只读访问不开放设置');
    return;
  }
  setActiveTab(tab);
  updateTabChrome();
  renderMain();
}

function renderMain() {
  if (activeTab === 'settings') { renderSettings(); return; }
  renderScheduler(activeTab === 'people' ? 'person' : 'project');
}

// ── 注入全局引用 ──
setRenderAll(renderAll);
setPanelsRenderAll(renderAll);

// 暴露 updatePerDayHint 到 window（供 inline onchange 使用）
window._panelsModule = { updatePerDayHint };

// ── 只读模式 ──
initReadOnlyMode();

// ── 绑定事件 ──
bindEvents();

// ── 工具栏事件委托（tab 切换、资源池按钮） ──
document.querySelector('.toolbar-row').addEventListener('click', function (e) {
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) {
    const tab = tabBtn.id === 'tabProjects' ? 'projects' : tabBtn.id === 'tabPeople' ? 'people' : 'settings';
    setTab(tab);
    return;
  }
  const drawerBtn = e.target.closest('button');
  if (drawerBtn && drawerBtn.textContent.includes('资源池')) {
    if (isReadOnlyMode()) { toast('只读访问暂不开放资源编辑'); return; }
    openDrawer('people');
  }
});

// ── 启动 ──
load(renderAll).catch(e => toast(e.message));

// app.js — 入口模块：启动、renderAll、setTab、事件绑定

import { $, activeTab, setActiveTab } from './state.js';
import { load } from './api.js';
import { renderScheduler } from './calendar.js';
import {
  renderStats, renderSettings, renderResourceBody, setRenderAll as setPanelsRenderAll,
  openDrawer, toast, updatePerDayHint
} from './panels.js';
import { bindEvents, setRenderAll } from './interactions.js';

// ── renderAll ──
async function renderAll() {
  renderStats();
  renderMain();
  renderResourceBody();
  renderSettings();
}

// ── setTab ──
function setTab(tab) {
  setActiveTab(tab);
  ['Projects', 'People', 'Settings'].forEach(n => $('tab' + n).classList.remove('active'));
  $('tab' + (tab === 'projects' ? 'Projects' : tab === 'people' ? 'People' : 'Settings')).classList.add('active');
  $('calendarCard').style.display = tab === 'settings' ? 'none' : 'block';
  $('settingsCard').style.display = tab === 'settings' ? 'block' : 'none';
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
    openDrawer('people');
  }
});

// ── 启动 ──
load(renderAll).catch(e => toast(e.message));

// calendar.js — 日历渲染、日期列计算、lane 堆叠、bar 样式

import {
  $, state, dates, esc,
  isDayOff, isPast, iso, weekday, dayClass, dayLabel,
  person, project, personColor, projectColor,
  endOf, inRange, totalHours,
  rowMatches, searchQ, loadRate, fteOf, conflictHighlight, milestoneStatus,
  assignmentMatches, milestoneMatches,
  assignmentGroupsForProject, requirementIsVisible, requirementSpan, requirementMatches,
  activeTeam, projectTeamId, projectScheduleMode, assignmentGroup
} from './state.js';
import { t } from './i18n.js';

// 优先级数据值（高/中/低）→ 本地化显示
const PRI = v => ({ '高': t('label.priorityHigh'), '中': t('label.priorityMid'), '低': t('label.priorityLow') })[v] || v;

// ── 日期列计算 ──
export function dateIndex(d) { return dates.indexOf(d); }

export function dateWidth(d) { return isDayOff(d) ? 44 : 88; }

export function dateColumns() {
  return '180px ' + dates.map(d => dateWidth(d) + 'px').join(' ');
}

export function calendarWidth() {
  return 180 + dates.reduce((s, d) => s + dateWidth(d), 0);
}

export function clampedDateIndex(d) {
  if (d <= dates[0]) return 0;
  if (d >= dates[dates.length - 1]) return dates.length - 1;
  return Math.max(0, dates.indexOf(d));
}

export function offsetBeforeDate(d) {
  let idx = clampedDateIndex(d);
  let sum = 0;
  for (let i = 0; i < idx; i++) sum += dateWidth(dates[i]);
  return sum;
}

export function widthBetweenDates(start, end) {
  let s = clampedDateIndex(start), e = clampedDateIndex(end);
  if (e < s) { let t = s; s = e; e = t; }
  let sum = 0;
  for (let i = s; i <= e; i++) sum += dateWidth(dates[i]);
  return sum;
}

export function visibleStartOf(a) {
  return a.date < dates[0] ? dates[0] : a.date;
}

export function visibleEndOf(a) {
  return endOf(a) > dates[dates.length - 1] ? dates[dates.length - 1] : endOf(a);
}

export function dateFromContentX(x) {
  let pos = Math.max(0, x - 180), acc = 0;
  for (let i = 0; i < dates.length; i++) {
    let w = dateWidth(dates[i]);
    if (pos < acc + w) return dates[i];
    acc += w;
  }
  return dates[dates.length - 1];
}

export function rangeVisible(a) {
  return a.date <= dates[dates.length - 1] && endOf(a) >= dates[0];
}

// ── lane 堆叠算法 ──
export function computeAssignmentLanes(assignments) {
  const laneEnds = [];
  const laneById = {};
  assignments.forEach(a => {
    const start = visibleStartOf(a), end = visibleEndOf(a);
    let lane = laneEnds.findIndex(lastEnd => lastEnd < start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(end); }
    else laneEnds[lane] = end;
    laneById[a.id] = lane;
  });
  return { laneById, laneCount: Math.max(1, laneEnds.length) };
}

function buildAssignmentGroups(assignments, projectId) {
  const groups = new Map();
  // 1) 按现有逻辑聚合：把已过滤的排期按 groupId 收敛成 parent-task 条（含未归组虚拟条）。
  assignments.forEach(a => {
    const g = assignmentGroup(a.groupId);
    const key = g ? g.id : `${projectId}::__ungrouped`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: `ag_${key}`,
        type: 'parentTask',
        projectId,
        groupId: g ? g.id : '',
        parentName: g ? g.name : t('task.ungrouped'),
        color: g ? g.color : '',
        date: a.date,
        endDate: endOf(a),
        assignments: [],
        empty: false,
        ownerName: g ? (person(g.ownerId)?.name || '') : '',
      });
    }
    const item = groups.get(key);
    item.assignments.push(a);
    if (a.date < item.date) item.date = a.date;
    if (endOf(a) > item.endDate) item.endDate = endOf(a);
  });
  // 2) 补全空需求（虚影条）：遍历该项目全部需求，可见但尚无条（0 子任务 + 有周期）的补一条。
  //    有子任务的已在步骤 1 建条，这里只补空的，不重复。
  assignmentGroupsForProject(projectId).forEach(g => {
    if (!requirementIsVisible(g)) return;
    if (groups.has(g.id)) return; // 已有子任务聚合条，跳过
    groups.set(g.id, {
      id: `ag_${g.id}`,
      type: 'parentTask',
      projectId,
      groupId: g.id,
      parentName: g.name,
      color: g.color || '',
      date: g.startDate || '',
      endDate: g.endDate || '',
      assignments: [],
      empty: true,
      ownerName: person(g.ownerId)?.name || '',
    });
  });
  // 3) 周期优先级（§5）：需求条若有自身 startDate/endDate，覆盖子任务 min/max。
  //    （空需求自身周期即其条周期，已在上一步设置；此处保证有子任务的需求也能用自身周期。）
  groups.forEach(item => {
    if (!item.groupId) return; // 未归组虚拟条无周期概念
    const g = assignmentGroup(item.groupId);
    if (g && (g.startDate || g.endDate)) {
      item.date = g.startDate || item.date;
      item.endDate = g.endDate || item.endDate;
      if (!item.date) item.date = item.endDate;
      if (!item.endDate) item.endDate = item.date;
    }
  });
  // 4) 搜索过滤：需求条（命名+空）走 requirementMatches；未归组虚拟条的子任务已由上游 assignmentMatches 过滤。
  //    另按可见日期窗口求交（等价 rangeVisible）——空需求无 assignment 不经上游 rangeVisible，需在此补判，避免画到屏幕外。
  const firstDate = dates[0], lastDate = dates[dates.length - 1];
  const filtered = [...groups.values()].filter(item => {
    if (!firstDate) return true;
    // rangeVisible 等价：item.date <= 末日 且 endOf(item) >= 首日
    const start = item.date || '', end = endOf(item) || '';
    if (start && start > lastDate) return false;
    if (end && end < firstDate) return false;
    if (!start && !end) return false; // 无周期无子任务的不画（requirementIsVisible 已保证非空，兜底）
    if (!item.groupId) return true; // 未归组虚拟条始终参与（其子任务受上游搜索控制）
    const g = assignmentGroup(item.groupId);
    return requirementMatches(g, searchQ);
  });
  return filtered.sort((a, b) => {
    const da = a.date || '', db = b.date || '';
    const ea = endOf(a) || '', eb = endOf(b) || '';
    return da.localeCompare(db) || ea.localeCompare(eb) || a.parentName.localeCompare(b.parentName);
  });
}

// ── bar 样式计算 ──
export function barStyle(a, stackIndex) {
  const visibleStart = visibleStartOf(a);
  const visibleEnd = visibleEndOf(a);
  const left = 180 + offsetBeforeDate(visibleStart) + 5;
  const width = Math.max(26, widthBetweenDates(visibleStart, visibleEnd) - 10);
  const top = 4 + stackIndex * 36;
  return `left:${left}px;width:${width}px;top:${top}px`;
}

// ── 日历渲染 ──
export function renderScheduler(view) {
  let rows = (view === 'person' ? state.people : state.projects)
    .filter(r => !r.archived)
    .filter(r => rowMatches(r, view));
  const totalRows = (view === 'person' ? state.people : state.projects).filter(r => !r.archived).length;
  $('calendarHint').textContent = view === 'person'
    ? t('hint.person')
    : (projectScheduleMode === 'parentTasks' ? t('hint.parentTasks') : t('hint.project'));
  $('scheduler').style.minWidth = calendarWidth() + 'px';
  const cols = dateColumns();
  const today = iso(new Date());

  let html = `<div class="row header" style="grid-template-columns:${cols}"><div class="head-cell">${view === 'person' ? t('cal.personDate') : t('cal.projectDate')}</div>` +
    dates.map(d => {
      const lbl = dayLabel(d);
      return `<div class="head-cell ${d === today ? 'today' : ''} ${isPast(d) ? 'past' : ''} ${dayClass(d)}">${d.slice(5)}<br>${weekday(d)}${lbl ? '<br><small>' + esc(lbl) + '</small>' : ''}</div>`;
    }).join('') + '</div>';

  // F2.1：零命中空态（区分「无数据」与「筛选无结果」）
  if (!rows.length) {
    const msg = totalRows === 0
      ? (view === 'person' ? t('empty.noPeople') : t('empty.noProjects'))
      : t('empty.noMatch');
    html += `<div class="row" style="grid-template-columns:${cols}"><div class="empty" style="grid-column:1/-1;margin:20px;text-align:center">${esc(msg)}</div></div>`;
    $('scheduler').innerHTML = html;
    return;
  }

  rows.forEach(r => {
    const rowAssignments = state.assignments
      .filter(a => view === 'person' ? a.personId === r.id : a.projectId === r.id)
      .filter(a => rangeVisible(a) && assignmentMatches(a))
      .filter(a => {
        // 团队视图人员行：排期条只渲染本团队项目（聚焦当前团队工作）；负载/冲突颜色仍全局算（不变量）。
        if (view === 'person' && activeTeam && projectTeamId(a.projectId) !== activeTeam) return false;
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date) || endOf(a).localeCompare(endOf(b)));
    const rowAssigns = view === 'project' && projectScheduleMode === 'parentTasks'
      ? buildAssignmentGroups(rowAssignments, r.id)
      : rowAssignments;
    const laneLayout = computeAssignmentLanes(rowAssigns);
    const maxStack = laneLayout.laneCount;
    const barZone = 4 + maxStack * 36 + 4;
    const minHeight = Math.max(64, barZone + 28);

    // 每个日期实际占用的排期条层数
    const laneCountPerDate = {};
    dates.forEach(d => {
      let maxLane = -1;
      rowAssigns.forEach(a => {
        if (a.date <= d && endOf(a) >= d) {
          maxLane = Math.max(maxLane, laneLayout.laneById[a.id] || 0);
        }
      });
      laneCountPerDate[d] = maxLane + 1; // 0 表示无排期条
    });

    const qHit = !!(searchQ && r.name.toLowerCase().includes(searchQ));
    // 借调标记：人员视图下 home_team ≠ 当前团队的人（非本团队，但参与本团队项目）
    const borrowed = view === 'person' && activeTeam && r.homeTeamId && r.homeTeamId !== activeTeam;
    const projectOwnerName = person(r.ownerId)?.name || r.owner || '';
    html += `<div class="row${qHit ? ' search-hit' : ''}" data-view="${view}" data-row-id="${r.id}" style="min-height:${minHeight}px;grid-template-columns:${cols}">` +
      `<div class="name-cell">${esc(r.name)}${borrowed ? ` <span class="borrowed-tag" title="${esc(t('team.borrowedTip'))}">${esc(t('team.borrowed'))}</span>` : ''}<br><small>${view === 'person'
        ? esc(t('cal.personMeta', { dept: r.department || '', role: r.role || '', cap: r.dailyCapacity }))
        : ((projectOwnerName ? t('cal.projectOwner') + esc(projectOwnerName) + ' · ' : '') + esc(PRI(r.priority || '中')) + ((r.startDate || r.endDate) ? ' · ' + (r.startDate ? r.startDate.slice(5) : '') + '~' + (r.endDate ? r.endDate.slice(5) : '') : ''))
      }</small></div>`;

    dates.forEach(d => {
      let ms = (view === 'project'
        ? state.milestones.filter(m => m.projectId === r.id && m.date === d)
        : state.milestones.filter(m => m.date === d && (m.ownerId === r.id || (!m.ownerId && m.owner === r.name) || (!m.ownerId && !m.owner && state.assignments.some(a => a.personId === r.id && a.projectId === m.projectId && inRange(a, d))))))
        .filter(m => milestoneMatches(m));
      let outOfRange = view === 'project' && ((r.startDate && d < r.startDate) || (r.endDate && d > r.endDate));
      // 人员视图：按当日负载率上色（热力 F2.3），并支持冲突高亮（F1.2）
      let heatClass = '';
      if (view === 'person' && !outOfRange && !isDayOff(d)) {
        const rate = loadRate(r.id, d);
        if (rate > 1) heatClass = conflictHighlight ? 'heat-over conflict-on' : 'heat-over';
        else if (rate > 0.75) heatClass = 'heat-high';
        else if (rate > 0.4) heatClass = 'heat-mid';
        else if (rate > 0) heatClass = 'heat-low';
      }
      // 有排期条 → 按实际层数留空间，里程碑紧贴最后一条下方；无排期条 → 里程碑在最上方
      const lanes = laneCountPerDate[d];
      const pad = lanes > 0 ? (4 + lanes * 36 + 4) : 0;
      html += `<div class="cell ${d === today ? 'today' : ''} ${dayClass(d)}${outOfRange ? ' out-of-range' : ''}${heatClass ? ' ' + heatClass : ''}" style="padding-top:${pad}px" data-view="${view}" data-row-id="${r.id}" data-date="${d}">`;
      ms.forEach(m => {
        const st = milestoneStatus(m.date);
        const stClass = st.state === 'past' ? ' ms-past' : st.state === 'upcoming' ? ' ms-upcoming' : '';
        const suffix = st.state === 'past' ? t('cal.msPast', { n: st.days }) : (st.state === 'upcoming' ? (st.days === 0 ? t('cal.msToday') : t('cal.msLeft', { n: st.days })) : '');
        html += `<div id="ms_${m.id}" class="milestone ${m.level === 'risk' ? 'risk' : ''}${stClass}" data-ms-id="${m.id}" tabindex="0" role="button" aria-label="${esc(m.name)} ${esc(m.date)}${esc(suffix)}">◆ ${esc(m.name)}<small class="ms-cd">${esc(suffix)}</small></div>`;
      });
      html += '</div>';
    });

    rowAssigns.forEach(a => {
      if (a.type === 'parentTask') {
        const participants = [...new Set(a.assignments.map(x => person(x.personId)?.name).filter(Boolean))];
        const over = a.assignments.some(x => {
          const p = person(x.personId) || {};
          return dates.some(d => !isDayOff(d) && inRange(x, d) && totalHours(x.personId, d) > Number(p.dailyCapacity || 8));
        });
        const bg = a.color || projectColor(r);
        const isEmpty = !!a.empty; // 空需求虚影条：0 子任务 + 有周期
        const periodLabel = `${esc(a.date)} ~ ${esc(endOf(a))}`;
        const subLabel = isEmpty
          ? (a.ownerName ? esc(a.ownerName) + ' · ' : '') + periodLabel
          : esc(t('tip.children')) + ' ' + a.assignments.length;
        html += `<div id="bar_${a.id}" class="assign bar parent-task${isEmpty ? ' empty' : ''}${over ? ' over' : ''}${over && conflictHighlight ? ' conflict-on' : ''}" tabindex="0" role="button" aria-label="${esc(a.parentName)} ${periodLabel}" style="background:${bg};${barStyle(a, laneLayout.laneById[a.id] || 0)}" data-parent-task-id="${esc(a.id)}" data-project-id="${esc(r.id)}" data-group-id="${esc(a.groupId)}">` +
          `<div class="bar-main parent-task-main"><span>${esc(a.parentName)}${participants.length ? ' · ' + esc(participants.join('、')) : ''}</span><small class="fte">${subLabel}</small></div>` +
          `${isEmpty ? '' : `<span class="child-count">${a.assignments.length}</span>`}</div>`;
        return;
      }
      let p = person(a.personId) || {}, pr = project(a.projectId) || {};
      let over = dates.some(d => !isDayOff(d) && inRange(a, d) && totalHours(a.personId, d) > Number(p.dailyCapacity || 8));
      let bg = view === 'person' ? projectColor(pr) : personColor(p);
      const primary = view === 'person' ? pr.name : p.name;

      const pct = Math.round(fteOf(a) * 100);
      html += `<div id="bar_${a.id}" class="assign bar${over ? ' over' : ''}${over && conflictHighlight ? ' conflict-on' : ''}" tabindex="0" role="button" aria-label="${esc(primary)} ${esc(a.date)} ~ ${esc(endOf(a))}" style="background:${bg};${barStyle(a, laneLayout.laneById[a.id] || 0)}" data-assign-id="${a.id}">` +
        `<div class="resize-handle left" data-resize="left" data-assign-id="${a.id}">┃</div>` +
        `<div class="bar-main" data-bar-main data-assign-id="${a.id}"><span>${esc(primary || t('cal.unnamed'))}${a.note ? ' · ' + esc(a.note) : ''}</span><small class="fte">${pct}%</small></div>` +
        `<div class="resize-handle right" data-resize="right" data-assign-id="${a.id}">┃</div></div>`;
    });

    html += '</div>';
  });

  $('scheduler').innerHTML = html;
}

// calendar.js — 日历渲染、日期列计算、lane 堆叠、bar 样式

import {
  $, state, dates, esc,
  isDayOff, isPast, iso, weekday, dayClass, dayLabel,
  person, project, personColor, projectColor,
  endOf, inRange, totalHours,
  rowMatches, searchQ, loadRate, fteOf, conflictHighlight, milestoneStatus, isReadOnlyMode,
  assignmentMatches, milestoneMatches,
  activeTeam, projectTeamId
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
  const readOnly = isReadOnlyMode();
  let rows = (view === 'person' ? state.people : state.projects)
    .filter(r => !r.archived)
    .filter(r => rowMatches(r, view));
  const totalRows = (view === 'person' ? state.people : state.projects).filter(r => !r.archived).length;
  $('calendarHint').textContent = view === 'person' ? t('hint.person') : t('hint.project');
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
    const rowAssigns = state.assignments
      .filter(a => view === 'person' ? a.personId === r.id : a.projectId === r.id)
      .filter(a => rangeVisible(a) && assignmentMatches(a))
      .filter(a => {
        // 团队视图人员行：排期条只渲染本团队项目（聚焦当前团队工作）；负载/冲突颜色仍全局算（不变量）。
        if (view === 'person' && activeTeam && projectTeamId(a.projectId) !== activeTeam) return false;
        return true;
      })
      .sort((a, b) => a.date.localeCompare(b.date) || endOf(a).localeCompare(endOf(b)));
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
      html += `<div class="cell ${dayClass(d)}${outOfRange ? ' out-of-range' : ''}${heatClass ? ' ' + heatClass : ''}" style="padding-top:${pad}px" data-view="${view}" data-row-id="${r.id}" data-date="${d}">`;
      ms.forEach(m => {
        const st = milestoneStatus(m.date);
        const stClass = st.state === 'overdue' ? ' ms-overdue' : st.state === 'upcoming' ? ' ms-upcoming' : '';
        const suffix = st.state === 'overdue' ? t('cal.msOverdue', { n: st.days }) : (st.state === 'upcoming' ? (st.days === 0 ? t('cal.msToday') : t('cal.msLeft', { n: st.days })) : '');
        html += `<div id="ms_${m.id}" class="milestone ${m.level === 'risk' ? 'risk' : ''}${stClass}" data-ms-id="${m.id}" tabindex="0" role="button" aria-label="${esc(m.name)} ${esc(m.date)}${esc(suffix)}">◆ ${esc(m.name)}<small class="ms-cd">${esc(suffix)}</small></div>`;
      });
      html += '</div>';
    });

    rowAssigns.forEach(a => {
      let p = person(a.personId) || {}, pr = project(a.projectId) || {};
      let over = dates.some(d => !isDayOff(d) && inRange(a, d) && totalHours(a.personId, d) > Number(p.dailyCapacity || 8));
      let bg = view === 'person' ? projectColor(pr) : personColor(p);
      const primary = view === 'person' ? pr.name : p.name;

      const ftePct = Math.round(fteOf(a) * 100);
      html += `<div id="bar_${a.id}" class="assign bar${over ? ' over' : ''}${over && conflictHighlight ? ' conflict-on' : ''}" tabindex="0" role="button" aria-label="${esc(primary)} ${esc(a.date)} ~ ${esc(endOf(a))}" style="background:${bg};${barStyle(a, laneLayout.laneById[a.id] || 0)}" data-assign-id="${a.id}">` +
        (readOnly ? '' : `<div class="resize-handle left" data-resize="left" data-assign-id="${a.id}">┃</div>`) +
        `<div class="bar-main" data-bar-main data-assign-id="${a.id}"><span>${esc(primary || t('cal.unnamed'))}${a.note ? ' · ' + esc(a.note) : ''}</span><small class="fte">${ftePct}%</small></div>` +
        (readOnly ? '' : `<div class="resize-handle right" data-resize="right" data-assign-id="${a.id}">┃</div>`) + `</div>`;
    });

    html += '</div>';
  });

  $('scheduler').innerHTML = html;
}

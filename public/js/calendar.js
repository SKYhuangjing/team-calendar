// calendar.js — 日历渲染、日期列计算、lane 堆叠、bar 样式

import {
  $, state, dates, esc,
  isDayOff, isPast, iso, weekday, dayClass, dayLabel,
  person, project, personColor, projectColor,
  endOf, inRange, totalHours
} from './state.js';

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
  let rows = (view === 'person' ? state.people : state.projects).filter(r => !r.archived);
  $('calendarHint').textContent = view === 'person'
    ? '人员视图：拖任务条可移动；拖边缘可缩放；选中后按 Delete 删除；右键格子可新增。'
    : '项目视图：拖任务条可移动；拖边缘可缩放；选中后按 Delete 删除；右键格子可新增。';
  $('scheduler').style.minWidth = calendarWidth() + 'px';
  const cols = dateColumns();
  const today = iso(new Date());

  let html = `<div class="row header" style="grid-template-columns:${cols}"><div class="head-cell">${view === 'person' ? '人员 / 日期' : '项目 / 日期'}</div>` +
    dates.map(d => {
      const lbl = dayLabel(d);
      return `<div class="head-cell ${d === today ? 'today' : ''} ${isPast(d) ? 'past' : ''} ${dayClass(d)}">${d.slice(5)}<br>${weekday(d)}${lbl ? '<br><small>' + esc(lbl) + '</small>' : ''}</div>`;
    }).join('') + '</div>';

  rows.forEach(r => {
    const rowAssigns = state.assignments
      .filter(a => view === 'person' ? a.personId === r.id : a.projectId === r.id)
      .filter(a => rangeVisible(a))
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

    html += `<div class="row" data-view="${view}" data-row-id="${r.id}" style="min-height:${minHeight}px;grid-template-columns:${cols}">` +
      `<div class="name-cell">${r.name}<br><small>${view === 'person'
        ? (r.department + ' · ' + r.role + ' · ' + r.dailyCapacity + 'h/天')
        : ((r.owner ? '负责人：' + r.owner + ' · ' : '') + r.priority + ((r.startDate || r.endDate) ? ' · ' + (r.startDate ? r.startDate.slice(5) : '') + '~' + (r.endDate ? r.endDate.slice(5) : '') : ''))
      }</small></div>`;

    dates.forEach(d => {
      let ms = view === 'project'
        ? state.milestones.filter(m => m.projectId === r.id && m.date === d)
        : state.milestones.filter(m => m.date === d && (m.owner === r.name || (!m.owner && state.assignments.some(a => a.personId === r.id && a.projectId === m.projectId && inRange(a, d)))));
      let outOfRange = view === 'project' && ((r.startDate && d < r.startDate) || (r.endDate && d > r.endDate));
      // 有排期条 → 按实际层数留空间，里程碑紧贴最后一条下方；无排期条 → 里程碑在最上方
      const lanes = laneCountPerDate[d];
      const pad = lanes > 0 ? (4 + lanes * 36 + 4) : 0;
      html += `<div class="cell ${dayClass(d)}${outOfRange ? ' out-of-range' : ''}" style="padding-top:${pad}px" data-view="${view}" data-row-id="${r.id}" data-date="${d}">`;
      ms.forEach(m => {
        html += `<div id="ms_${m.id}" class="milestone ${m.level === 'risk' ? 'risk' : ''}" data-ms-id="${m.id}">◆ ${m.name}</div>`;
      });
      html += '</div>';
    });

    rowAssigns.forEach(a => {
      let p = person(a.personId) || {}, pr = project(a.projectId) || {};
      let over = dates.some(d => !isDayOff(d) && inRange(a, d) && totalHours(a.personId, d) > Number(p.dailyCapacity || 8));
      let bg = view === 'person' ? projectColor(pr) : personColor(p);
      const primary = view === 'person' ? pr.name : p.name;
      const secondary = view === 'person' ? p.name : pr.name;
      const title = `${primary} / ${secondary} / ${a.date} ~ ${endOf(a)} / ${a.note || '无备注'}`;

      html += `<div id="bar_${a.id}" class="assign bar${over ? ' over' : ''}" title="${esc(title)}" style="background:${bg};${barStyle(a, laneLayout.laneById[a.id] || 0)}" data-assign-id="${a.id}">` +
        `<div class="resize-handle left" data-resize="left" data-assign-id="${a.id}">┃</div>` +
        `<div class="bar-main" data-bar-main data-assign-id="${a.id}"><span>${esc(primary || '未命名')}${a.note ? ' · ' + esc(a.note) : ''}</span></div>` +
        `<div class="resize-handle right" data-resize="right" data-assign-id="${a.id}">┃</div></div>`;
    });

    html += '</div>';
  });

  $('scheduler').innerHTML = html;
}

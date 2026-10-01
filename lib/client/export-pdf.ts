/*
 * Print-ready report (Save as PDF from the print dialog). A self-contained HTML
 * document, printed from a hidden iframe so popup blockers never get in the way.
 */
import { fmtDay, linkHost, todayISO } from './util';
import { STATUS_NAMES, type Priority, type Task } from '../types';
import { columnsFor, describeFilters, groupTasks, summarize, type ColumnDef, type ExportContext, type ExportOptions, type Summary } from './export';
import { PRI_FG, PRI_GLYPH_X, STATUS_BG, STATUS_FG, STATUS_GLYPH } from './export-xlsx';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const nl = (s: string) => esc(s).replace(/\n/g, '<br>');
// For a CSS string inside <style>: keep letters, digits and plain punctuation only.
const cssText = (s: string) => s.replace(/[^\p{L}\p{N} .,:;()!?'_·-]/gu, '').slice(0, 80);
const PRI_NAME: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low' };
// These columns are shown under the task title instead of as narrow columns of their own.
const DETAIL = new Set(['description', 'remarks', 'blocked', 'links', 'tags']);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Compact dates for narrow table cells: "24 Sep", "24 Sep 2025", "24 Sep · 07:15". */
function short(d: Date, withTime: boolean): string {
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''}`;
  return withTime ? `${base} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : base;
}

function cell(c: ColumnDef, t: Task, ctx: ExportContext, today: string): string {
  const v = c.get(t, ctx);
  switch (c.key) {
    case 'status': return `<span class="pill" style="--fg:#${STATUS_FG[t.status]};--bg:#${STATUS_BG[t.status]}">${STATUS_GLYPH[t.status]} ${STATUS_NAMES[t.status]}</span>`;
    case 'priority': return `<span class="pri" style="color:#${PRI_FG[t.priority]}">${PRI_GLYPH_X[t.priority]} ${PRI_NAME[t.priority]}</span>`;
    case 'assignee': return t.assigneeId ? esc(String(v)) : '<span class="muted">Unassigned</span>';
    case 'due': {
      if (!t.dueDate) return '<span class="muted">—</span>';
      const cls = t.status !== 4 && t.dueDate < today ? 'due over' : t.status !== 4 && t.dueDate === today ? 'due today' : 'due';
      return `<span class="${cls}">${esc(short(v as Date, false))}</span>`;
    }
    case 'focus': return t.timeSpent >= 60 ? `${(t.timeSpent / 3600).toFixed(1)} h` : '<span class="muted">—</span>';
    case 'files': case 'comments': return v ? String(v) : '<span class="muted">—</span>';
    case 'cycle': return v == null ? '<span class="muted">—</span>' : `${v} d`;
    default:
      if (v instanceof Date) return `<span class="nowrap">${esc(short(v, c.kind === 'datetime'))}</span>`;
      return v ? esc(String(v)) : '<span class="muted">—</span>';
  }
}

function titleCell(t: Task, keys: Set<string>): string {
  const bits = [`<div class="t-title${t.status === 4 ? ' done' : ''}">${esc(t.title)}</div>`];
  if (keys.has('description') && t.description) bits.push(`<div class="t-desc">${nl(t.description)}</div>`);
  if (keys.has('blocked') && t.status === 2 && t.blockedReason) bits.push(`<div class="t-block">⊘ Blocked: ${esc(t.blockedReason)}</div>`);
  if (keys.has('remarks') && t.remarks) bits.push(`<div class="t-rem"><b>Remarks</b> ${nl(t.remarks)}</div>`);
  const chips: string[] = [];
  if (keys.has('tags')) t.tags.forEach((x) => chips.push(`<span class="tag">#${esc(x)}</span>`));
  if (keys.has('links')) t.links.forEach((l) => chips.push(`<a class="lnk" href="${esc(l.url)}">↗ ${esc(l.label || linkHost(l.url))}</a>`));
  if (chips.length) bits.push(`<div class="t-chips">${chips.join('')}</div>`);
  return bits.join('');
}

function ring(pct: number): string {
  const r = 34, c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="${r}" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="9"/><circle cx="42" cy="42" r="${r}" fill="none" stroke="#7CE3A0" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}" transform="rotate(-90 42 42)"/><text x="42" y="46" text-anchor="middle">${Math.round(pct * 100)}%</text></svg>`;
}

function overview(s: Summary): string {
  const done = s.byStatus[4];
  const kpi = (label: string, value: number, sub: string, fg: string, bg: string) =>
    `<div class="kpi" style="--fg:${fg};--bg:${bg}"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
  const pct = (n: number) => (s.total ? `${Math.round((n / s.total) * 100)}%` : '—');
  const kpis = [
    kpi('Total', s.total, s.focusHours ? `${s.focusHours} h focused` : 'in this report', '#1B2559', '#EEF1FA'),
    kpi('Open', s.total - done, s.dueToday ? `${s.dueToday} due today` : pct(s.total - done), '#4F6CFF', '#E8ECFF'),
    ...[1, 2, 3].map((i) => kpi(STATUS_NAMES[i], s.byStatus[i], pct(s.byStatus[i]), `#${STATUS_FG[i]}`, `#${STATUS_BG[i]}`)),
    kpi('Done', done, `${pct(done)} complete`, `#${STATUS_FG[4]}`, `#${STATUS_BG[4]}`),
    kpi('Overdue', s.overdue, s.overdue ? 'needs attention' : 'none', s.overdue ? '#B42318' : '#6B7391', s.overdue ? '#FDE8E6' : '#F1F3F9')
  ].join('');
  const seg = s.byStatus.map((n, i) => (n ? `<i style="flex:${n};background:#${STATUS_FG[i]}" title="${STATUS_NAMES[i]}"></i>` : '')).join('');
  const legend = s.byStatus.map((n, i) => `<span><i style="background:#${STATUS_FG[i]}"></i>${STATUS_NAMES[i]} <b>${n}</b></span>`).join('');
  const pri = (['high', 'medium', 'low'] as Priority[]).map((p) => {
    const n = s.byPriority[p], w = s.total ? (n / s.total) * 100 : 0;
    return `<div class="prow"><span style="color:#${PRI_FG[p]}">${PRI_GLYPH_X[p]} ${PRI_NAME[p]}</span><div class="ptrack"><i style="width:${w.toFixed(1)}%;background:#${PRI_FG[p]}"></i></div><b>${n}</b></div>`;
  }).join('');
  const people = s.people.length > 1 ? `
    <section class="card wide"><h3>Workload by person</h3>
      <table class="mini"><thead><tr><th>Person</th>${STATUS_NAMES.map((n) => `<th>${n}</th>`).join('')}<th>Total</th></tr></thead><tbody>
      ${s.people.map((p) => `<tr><td class="${p.name === 'Unassigned' ? 'muted' : ''}">${esc(p.name)}</td>${p.byStatus.map((n, i) => `<td class="${i === 2 && n ? 'hot' : ''}">${n || '<span class="muted">—</span>'}</td>`).join('')}<td><b>${p.total}</b></td></tr>`).join('')}
      </tbody></table></section>` : '';
  return `
    <div class="kpis">${kpis}</div>
    <div class="grid">
      <section class="card"><h3>Status</h3><div class="stack">${seg || '<i style="flex:1;background:#E3E6EF"></i>'}</div><div class="legend">${legend}</div></section>
      <section class="card"><h3>Priority</h3>${pri}</section>
      ${people}
    </div>`;
}

export function buildReportHtml(tasks: Task[], o: ExportOptions, ctx: ExportContext, docTitle: string): string {
  const s = summarize(tasks, ctx);
  const cols = columnsFor(o);
  const keys = new Set<string>(cols.map((c) => c.key));
  const tableCols = cols.filter((c) => c.key !== 'title' && !DETAIL.has(c.key));
  const today = todayISO();
  const groups = groupTasks(tasks, o.groupBy, ctx);
  const stamp = `${fmtDay(ctx.generatedAt, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} at ${ctx.generatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  const filters = describeFilters(o, ctx).filter(([k, v]) => !(v === 'All' || v === 'Any date' || v === 'Not included'));
  const head = `<tr><th class="c-title">Task</th>${tableCols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
  const body = groups.filter((g) => g.tasks.length).map((g) => {
    const fg = g.status !== undefined ? `#${STATUS_FG[g.status]}` : g.priority ? `#${PRI_FG[g.priority]}` : '#1B2559';
    const glyph = g.status !== undefined ? `${STATUS_GLYPH[g.status]} ` : g.priority ? `${PRI_GLYPH_X[g.priority]} ` : '';
    const rows = g.tasks.map((t) => `<tr><td class="c-title">${titleCell(t, keys)}</td>${tableCols.map((c) => `<td>${cell(c, t, ctx, today)}</td>`).join('')}</tr>`).join('');
    return `
      <section class="group">
        ${o.groupBy !== 'none' ? `<h2 class="g-head" style="--fg:${fg}">${glyph}${esc(g.label)}<span>${g.tasks.length} ${g.tasks.length === 1 ? 'task' : 'tasks'}</span></h2>` : ''}
        <table class="tasks"><thead>${head}</thead><tbody>${rows}</tbody></table>
      </section>`;
  }).join('') || '<p class="empty">No tasks match these filters.</p>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(docTitle)}</title><style>
  @page { size: A4 landscape; margin: 12mm 11mm 14mm; @bottom-left { content: "Dayflow · ${cssText(o.title)}"; font: 8pt "Segoe UI", system-ui, sans-serif; color: #6B7391; } @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt "Segoe UI", system-ui, sans-serif; color: #6B7391; } }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; background: #fff; }
  body { font: 9.5pt/1.45 "Segoe UI", "Inter", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; color: #1F2437; }
  .muted { color: #9097B1; }
  .cover { display: flex; align-items: center; gap: 18px; padding: 18px 22px; border-radius: 14px; color: #fff; background: linear-gradient(120deg, #1B2559 0%, #27347A 55%, #4F6CFF 140%); }
  .cover .brand { font-size: 8pt; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #C9D1F5; }
  .cover h1 { margin: 2px 0 4px; font-size: 22pt; letter-spacing: -.02em; line-height: 1.1; }
  .cover p { margin: 0; color: #DDE3FF; font-size: 9.5pt; }
  .cover .meta { flex: 1; min-width: 0; }
  .ring { width: 74px; height: 74px; flex: none; }
  .ring text { fill: #fff; font: 700 15px "Segoe UI", system-ui, sans-serif; }
  .ring-cap { font-size: 7.5pt; text-align: center; color: #C9D1F5; margin-top: 2px; letter-spacing: .06em; text-transform: uppercase; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 12px; }
  .filters span { padding: 3px 9px; border-radius: 999px; background: #F1F3F9; border: 1px solid #E3E6EF; font-size: 8pt; color: #444C6B; }
  .filters b { color: #1B2559; }
  .kpis { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-bottom: 10px; }
  .kpi { padding: 9px 11px; border-radius: 10px; background: var(--bg); border-top: 3px solid var(--fg); }
  .kpi span { display: block; font-size: 7pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--fg); }
  .kpi b { display: block; font-size: 19pt; line-height: 1.15; color: var(--fg); }
  .kpi small { font-size: 7.5pt; color: #444C6B; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
  .card { padding: 11px 13px; border-radius: 10px; border: 1px solid #E3E6EF; break-inside: avoid; }
  .card.wide { grid-column: 1 / -1; }
  .card h3 { margin: 0 0 8px; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; color: #6B7391; }
  .stack { display: flex; height: 12px; border-radius: 6px; overflow: hidden; gap: 2px; }
  .stack i { display: block; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 8.5pt; color: #444C6B; }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  .prow { display: grid; grid-template-columns: 70px 1fr 28px; gap: 10px; align-items: center; font-size: 8.5pt; font-weight: 700; margin: 3px 0; }
  .prow b { text-align: right; color: #1F2437; }
  .ptrack { height: 8px; border-radius: 4px; background: #F1F3F9; overflow: hidden; }
  .ptrack i { display: block; height: 100%; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; }
  table.mini th, table.mini td { padding: 4px 8px; text-align: center; font-size: 8.5pt; border-bottom: 1px solid #EEF1FA; }
  table.mini th:first-child, table.mini td:first-child { text-align: left; }
  table.mini th { font-size: 7.5pt; color: #6B7391; text-transform: uppercase; letter-spacing: .05em; }
  table.mini td.hot { color: #B42318; font-weight: 700; }
  .nowrap { white-space: nowrap; }
  /* Page 1 is the overview; the task list always starts on a fresh page. */
  .section-title { break-before: page; display: flex; align-items: baseline; gap: 10px; margin: 6px 0 8px; padding-bottom: 5px; border-bottom: 2px solid #4F6CFF; font-size: 12pt; color: #1B2559; }
  .section-title small { font-size: 8.5pt; color: #6B7391; font-weight: 600; }
  .group { margin-bottom: 12px; }
  .g-head { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; padding: 6px 10px; border-left: 4px solid var(--fg); border-radius: 4px 8px 8px 4px; background: #F7F8FC; font-size: 10.5pt; color: var(--fg); break-after: avoid; }
  .g-head span { font-size: 8pt; font-weight: 600; color: #6B7391; }
  table.tasks thead { display: table-header-group; }
  table.tasks th { padding: 6px 8px; text-align: left; font-size: 7.5pt; letter-spacing: .06em; text-transform: uppercase; color: #fff; background: #27347A; }
  table.tasks th:first-child { border-radius: 6px 0 0 0; } table.tasks th:last-child { border-radius: 0 6px 0 0; }
  table.tasks td { padding: 7px 8px; vertical-align: top; border-bottom: 1px solid #E3E6EF; font-size: 8.5pt; }
  table.tasks tr { break-inside: avoid; }
  table.tasks tbody tr:nth-child(even) td { background: #F9FAFD; }
  .c-title { width: 42%; }
  .t-title { font-weight: 700; font-size: 9.5pt; color: #1F2437; }
  .t-title.done { color: #6B7391; text-decoration: line-through; text-decoration-color: #137333; }
  .t-desc { margin-top: 2px; color: #444C6B; }
  .t-rem { margin-top: 4px; padding: 3px 7px; border-radius: 6px; background: #FFF8E6; color: #5C4A12; font-style: italic; }
  .t-rem b { font-style: normal; font-size: 7pt; letter-spacing: .06em; text-transform: uppercase; margin-right: 4px; color: #A16207; }
  .t-block { margin-top: 4px; color: #B42318; font-weight: 600; }
  .t-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .tag { padding: 1px 7px; border-radius: 999px; background: #E8ECFF; color: #3547C7; font-size: 7.5pt; font-weight: 600; }
  .lnk { padding: 1px 7px; border-radius: 999px; border: 1px solid #D5DBF5; color: #3547C7; font-size: 7.5pt; text-decoration: none; }
  .pill { display: inline-block; white-space: nowrap; padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 8pt; color: var(--fg); background: var(--bg); }
  .pri { white-space: nowrap; font-weight: 700; }
  .due { white-space: nowrap; }
  .due.over { color: #B42318; font-weight: 700; }
  .due.today { color: #A16207; font-weight: 700; }
  .empty { padding: 30px; text-align: center; color: #6B7391; border: 1px dashed #D5DBF5; border-radius: 10px; }
  .foot { margin-top: 14px; padding-top: 8px; border-top: 1px solid #E3E6EF; font-size: 7.5pt; color: #6B7391; display: flex; justify-content: space-between; }
  </style></head><body>
  <header class="cover">
    <div class="meta">
      <div class="brand">Dayflow · ${esc(ctx.orgName)}</div>
      <h1>${esc(o.title)}</h1>
      <p>${o.scope === 'mine' ? `Tasks of ${esc(ctx.meName)}` : 'Whole organization'} · ${s.total} ${s.total === 1 ? 'task' : 'tasks'} · Generated ${esc(stamp)}</p>
    </div>
    <div>${ring(s.total ? s.byStatus[4] / s.total : 0)}<div class="ring-cap">Complete</div></div>
  </header>
  ${filters.length ? `<div class="filters">${filters.map(([k, v]) => `<span>${esc(k)}: <b>${esc(v)}</b></span>`).join('')}</div>` : '<div style="height:12px"></div>'}
  ${overview(s)}
  <h2 class="section-title">Tasks <small>${s.total} ${s.total === 1 ? 'task' : 'tasks'}${o.groupBy !== 'none' ? ` · grouped by ${esc(o.groupBy === 'due' ? 'due date' : o.groupBy)}` : ''}</small></h2>
  ${body}
  <div class="foot"><span>Generated by Dayflow for ${esc(ctx.meName)}</span><span>${esc(stamp)}</span></div>
  </body></html>`;
}

/** Opens the browser's print dialog for the report (choose “Save as PDF”). */
export function printReport(html: string): void {
  document.querySelectorAll('iframe[data-export-print]').forEach((f) => f.remove());
  const frame = document.createElement('iframe');
  frame.setAttribute('data-export-print', '');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  // Give layout a beat before printing; keep the frame around while the dialog is open.
  setTimeout(() => { frame.contentWindow?.focus(); frame.contentWindow?.print(); }, 250);
  setTimeout(() => frame.remove(), 120000);
}

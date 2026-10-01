/*
 * Styled Excel workbook: Summary (KPI cards, breakdowns, report details),
 * Tasks (branded header, status pills, collapsible groups, frozen header,
 * filters, print setup) and Links (every link, clickable).
 * exceljs is loaded on demand so it never weighs on the board's first load.
 */
import type ExcelJS from 'exceljs';
import { fmtDay, todayISO } from './util';
import { STATUS_NAMES, type Priority, type Task } from '../types';
import {
  columnsFor, describeFilters, groupTasks, summarize,
  type ColumnDef, type ExportContext, type ExportOptions, type Group, type Summary
} from './export';

// ---------------------------------------------------------------- palette (hex without #)
const C = {
  navy: '1B2559', navy2: '27347A', accent: '4F6CFF', accentSoft: 'E8ECFF', ink: '1F2437', ink2: '444C6B', muted: '6B7391',
  line: 'E3E6EF', zebra: 'F7F8FC', soft: 'EEF1FA', head: 'F1F3F9', white: 'FFFFFF', onNavy: 'C9D1F5',
  red: 'B42318', redSoft: 'FDE8E6', amber: 'A16207', amberSoft: 'FEF3C7'
};
export const STATUS_FG = ['5B6275', '1D5FBF', 'B42318', '5B3FC4', '137333'];
export const STATUS_BG = ['EEF0F4', 'E3EEFC', 'FDE8E6', 'EEEAFC', 'E3F4E8'];
export const STATUS_GLYPH = ['○', '◐', '⊘', '◉', '✓'];
export const PRI_FG: Record<Priority, string> = { high: 'C2410C', medium: 'A16207', low: '6B7280' };
export const PRI_BG: Record<Priority, string> = { high: 'FFEDD5', medium: 'FEF3C7', low: 'F1F2F5' };
export const PRI_GLYPH_X: Record<Priority, string> = { high: '▲', medium: '◆', low: '▼' };

const FONT = 'Calibri';
const argb = (h: string) => ({ argb: `FF${h}` });
const solid = (h: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: argb(h) });
const font = (o: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size: 10, color: argb(C.ink), ...o });
const thin = (h = C.line): Partial<ExcelJS.Border> => ({ style: 'thin', color: argb(h) });

function band(ws: ExcelJS.Worksheet, row: number, from: number, to: number, color: string, height?: number) {
  for (let c = from; c <= to; c++) ws.getCell(row, c).fill = solid(color);
  if (height) ws.getRow(row).height = height;
}
function merged(ws: ExcelJS.Worksheet, row: number, from: number, to: number) {
  if (to > from) ws.mergeCells(row, from, row, to);
  return ws.getCell(row, from);
}
/**
 * Excel dates have no time zone and exceljs writes a Date's UTC value. Rebuild the local
 * wall-clock time as UTC so "30 Sep, 14:05" here is "30 Sep, 14:05" in the sheet
 * (otherwise a due date turns into the day before anywhere east of UTC).
 */
const excelDate = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
const stamp = (d: Date) => `${fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

// ---------------------------------------------------------------- workbook
export async function buildXlsx(tasks: Task[], o: ExportOptions, ctx: ExportContext): Promise<Blob> {
  const mod = await import('exceljs');
  const Excel = ((mod as unknown as { default?: typeof ExcelJS }).default ?? mod) as typeof ExcelJS;
  const wb = new Excel.Workbook();
  wb.creator = `Dayflow · ${ctx.meName}`;
  wb.title = o.title;
  wb.company = ctx.orgName;
  wb.created = ctx.generatedAt;

  const summary = summarize(tasks, ctx);
  const groups = groupTasks(tasks, o.groupBy, ctx);
  summarySheet(wb, summary, o, ctx);
  tasksSheet(wb, groups, columnsFor(o), o, ctx, summary);
  if (o.columns.includes('links') && tasks.some((t) => t.links.length)) linksSheet(wb, tasks, ctx);
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------------------------------------------------------------- Summary sheet
function summarySheet(wb: ExcelJS.Workbook, s: Summary, o: ExportOptions, ctx: ExportContext) {
  const ws = wb.addWorksheet('Summary', {
    views: [{ showGridLines: false, zoomScale: 100 }],
    properties: { tabColor: argb(C.accent), defaultRowHeight: 18 },
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.3 } },
    headerFooter: { oddFooter: `&L&"${FONT}"&8&K${C.muted}Dayflow · ${o.title.replace(/&/g, '&&')}&R&"${FONT}"&8&K${C.muted}Page &P of &N` }
  });
  ws.columns = [{ width: 3 }, { width: 26 }, ...Array.from({ length: 6 }, () => ({ width: 15 })), { width: 3 }];
  const L = 2, R = 8; // content spans B..H

  // Brand band
  band(ws, 1, 1, 9, C.navy, 10);
  band(ws, 2, 1, 9, C.navy, 34);
  band(ws, 3, 1, 9, C.navy, 20);
  band(ws, 4, 1, 9, C.navy, 10);
  band(ws, 5, 1, 9, C.accent, 4);
  const title = merged(ws, 2, L, R);
  title.value = o.title;
  title.font = font({ size: 20, bold: true, color: argb(C.white) });
  title.alignment = { vertical: 'middle' };
  const sub = merged(ws, 3, L, R);
  sub.value = `${ctx.orgName}  ·  ${o.scope === 'mine' ? `Tasks of ${ctx.meName}` : 'Whole organization'}  ·  Generated ${stamp(ctx.generatedAt)}`;
  sub.font = font({ size: 10, color: argb(C.onNavy) });
  sub.alignment = { vertical: 'middle' };

  // KPI cards
  const pct = (n: number) => (s.total ? `${Math.round((n / s.total) * 100)}% of tasks` : '—');
  const done = s.byStatus[4];
  const kpis: Array<{ label: string; value: number; sub: string; fg: string; bg: string }> = [
    { label: 'TOTAL', value: s.total, sub: s.focusHours ? `${s.focusHours} h focused` : 'in this report', fg: C.navy, bg: C.soft },
    { label: 'OPEN', value: s.total - done, sub: s.dueToday ? `${s.dueToday} due today` : pct(s.total - done), fg: C.accent, bg: C.accentSoft },
    { label: 'IN PROGRESS', value: s.byStatus[1], sub: pct(s.byStatus[1]), fg: STATUS_FG[1], bg: STATUS_BG[1] },
    { label: 'BLOCKED', value: s.byStatus[2], sub: pct(s.byStatus[2]), fg: STATUS_FG[2], bg: STATUS_BG[2] },
    { label: 'IN REVIEW', value: s.byStatus[3], sub: pct(s.byStatus[3]), fg: STATUS_FG[3], bg: STATUS_BG[3] },
    { label: 'DONE', value: done, sub: s.total ? `${Math.round((done / s.total) * 100)}% complete` : '—', fg: STATUS_FG[4], bg: STATUS_BG[4] }
  ];
  // Seven cards, one per column B..H.
  const top = 7;
  ws.getRow(top).height = 20;
  ws.getRow(top + 1).height = 34;
  ws.getRow(top + 2).height = 18;
  const cards = [...kpis, { label: 'OVERDUE', value: s.overdue, sub: s.overdue ? 'needs attention' : 'none', fg: s.overdue ? C.red : C.muted, bg: s.overdue ? C.redSoft : C.head }];
  cards.forEach((k, i) => {
    const c = L + i;
    const a = ws.getCell(top, c), b = ws.getCell(top + 1, c), d = ws.getCell(top + 2, c);
    [a, b, d].forEach((x) => { x.fill = solid(k.bg); x.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }; });
    a.value = k.label;
    a.font = font({ size: 8, bold: true, color: argb(k.fg) });
    a.border = { top: { style: 'thick', color: argb(k.fg) }, left: thin(C.white), right: thin(C.white) };
    b.value = k.value;
    b.numFmt = '0';
    b.font = font({ size: 22, bold: true, color: argb(k.fg) });
    b.border = { left: thin(C.white), right: thin(C.white) };
    d.value = k.sub;
    d.font = font({ size: 8, color: argb(C.ink2) });
    d.border = { bottom: thin(C.line), left: thin(C.white), right: thin(C.white) };
  });

  let r = top + 4;
  const section = (label: string) => {
    ws.getRow(r).height = 24;
    const cell = merged(ws, r, L, R);
    cell.value = label;
    cell.font = font({ size: 12, bold: true, color: argb(C.navy) });
    cell.alignment = { vertical: 'bottom' };
    cell.border = { bottom: { style: 'medium', color: argb(C.accent) } };
    r++;
  };
  const header = (labels: string[], mergeLastTo?: number) => {
    labels.forEach((t, i) => {
      const cell = ws.getCell(r, L + i);
      cell.value = t;
      cell.font = font({ size: 9, bold: true, color: argb(C.muted) });
      cell.fill = solid(C.head);
      cell.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle', indent: i === 0 ? 1 : 0 };
      cell.border = { bottom: thin() };
    });
    if (mergeLastTo) {
      for (let c = L + labels.length; c <= mergeLastTo; c++) { ws.getCell(r, c).fill = solid(C.head); ws.getCell(r, c).border = { bottom: thin() }; }
      ws.mergeCells(r, L + labels.length - 1, r, mergeLastTo);
    }
    ws.getRow(r).height = 20;
    r++;
  };
  const breakdown = (rows: Array<{ label: string; n: number; fg: string; bg: string }>) => {
    header([rows.length === 5 ? 'Status' : 'Priority', 'Tasks', 'Share', 'Distribution'], R);
    for (const x of rows) {
      const share = s.total ? x.n / s.total : 0;
      const name = ws.getCell(r, L);
      name.value = x.label;
      name.font = font({ bold: true, color: argb(x.fg) });
      name.fill = solid(x.bg);
      name.alignment = { vertical: 'middle', indent: 1 };
      const n = ws.getCell(r, L + 1);
      n.value = x.n;
      n.font = font({ bold: true });
      n.alignment = { horizontal: 'center', vertical: 'middle' };
      const p = ws.getCell(r, L + 2);
      p.value = share;
      p.numFmt = '0%';
      p.font = font({ color: argb(C.ink2) });
      p.alignment = { horizontal: 'center', vertical: 'middle' };
      const bar = merged(ws, r, L + 3, R);
      bar.value = x.n ? '█'.repeat(Math.max(1, Math.round(share * 44))) : '';
      bar.font = font({ size: 9, color: argb(x.fg) });
      bar.alignment = { vertical: 'middle' };
      for (let c = L; c <= R; c++) ws.getCell(r, c).border = { bottom: thin() };
      ws.getRow(r).height = 20;
      r++;
    }
    const t = ws.getCell(r, L);
    t.value = 'Total';
    t.font = font({ bold: true });
    t.alignment = { indent: 1 };
    const tn = ws.getCell(r, L + 1);
    tn.value = s.total;
    tn.font = font({ bold: true });
    tn.alignment = { horizontal: 'center' };
    r += 2;
  };

  section('Status breakdown');
  breakdown(STATUS_NAMES.map((n, i) => ({ label: `${STATUS_GLYPH[i]}  ${n}`, n: s.byStatus[i], fg: STATUS_FG[i], bg: STATUS_BG[i] })));
  section('Priority breakdown');
  breakdown((['high', 'medium', 'low'] as Priority[]).map((p) => ({ label: `${PRI_GLYPH_X[p]}  ${p[0].toUpperCase()}${p.slice(1)}`, n: s.byPriority[p], fg: PRI_FG[p], bg: PRI_BG[p] })));

  if (s.people.length) {
    section('Workload by person');
    header(['Person', 'Queued', 'In progress', 'Blocked', 'Review', 'Done', 'Total']);
    s.people.forEach((p, i) => {
      const vals: Array<string | number> = [p.name, ...p.byStatus, p.total];
      vals.forEach((v, j) => {
        const cell = ws.getCell(r, L + j);
        cell.value = v;
        cell.font = font({ bold: j === 0 || j === 6, color: argb(j === 3 && Number(v) > 0 ? C.red : j === 0 && p.name === 'Unassigned' ? C.muted : C.ink), italic: j === 0 && p.name === 'Unassigned' });
        cell.numFmt = j ? '0;;"—"' : '@';
        cell.alignment = { horizontal: j ? 'center' : 'left', vertical: 'middle', indent: j ? 0 : 1 };
        cell.border = { bottom: thin() };
        if (i % 2) cell.fill = solid(C.zebra);
      });
      ws.getRow(r).height = 20;
      r++;
    });
    r++;
  }

  section('Report details');
  for (const [k, v] of describeFilters(o, ctx)) {
    const a = ws.getCell(r, L);
    a.value = k;
    a.font = font({ bold: true, color: argb(C.muted) });
    a.alignment = { vertical: 'top', indent: 1 };
    const b = merged(ws, r, L + 1, R);
    b.value = v;
    b.font = font({ color: argb(C.ink) });
    b.alignment = { vertical: 'top', wrapText: true };
    for (let c = L; c <= R; c++) ws.getCell(r, c).border = { bottom: thin(C.soft) };
    ws.getRow(r).height = v.length > 90 ? 32 : 18;
    r++;
  }
  r++;
  const foot = merged(ws, r, L, R);
  foot.value = `Generated by Dayflow for ${ctx.meName} · ${stamp(ctx.generatedAt)} · See the “Tasks” sheet for every task.`;
  foot.font = font({ size: 8, italic: true, color: argb(C.muted) });
}

// ---------------------------------------------------------------- Tasks sheet
const HEAD = 5; // header row

function tasksSheet(wb: ExcelJS.Workbook, groups: Group[], cols: ColumnDef[], o: ExportOptions, ctx: ExportContext, s: Summary) {
  const n = cols.length;
  const grouped = o.groupBy !== 'none';
  // Many columns would print unreadably small on one page: go two pages wide and repeat the Task column.
  const wide = cols.reduce((a, c) => a + c.width, 0) > 260;
  const ws = wb.addWorksheet('Tasks', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: HEAD, showGridLines: false, zoomScale: 100 }],
    // No outlineProperties here: exceljs writes <outlinePr> after <pageSetUpPr>, which breaks Excel's
    // schema order and makes Excel refuse the file. Default outlines (button below each group) are fine.
    properties: { tabColor: argb(C.navy), defaultRowHeight: 18 },
    pageSetup: {
      paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: wide ? 2 : 1, fitToHeight: 0, horizontalCentered: !wide,
      printTitlesRow: `${HEAD}:${HEAD}`, ...(wide ? { printTitlesColumn: 'A:A' } : {}), margins: { left: 0.35, right: 0.35, top: 0.45, bottom: 0.6, header: 0.2, footer: 0.3 }
    },
    headerFooter: { oddFooter: `&L&"${FONT}"&8&K${C.muted}Dayflow · ${o.title.replace(/&/g, '&&')} · ${todayISO()}&R&"${FONT}"&8&K${C.muted}Page &P of &N` }
  });
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));

  // Title band
  band(ws, 1, 1, n, C.navy, 30);
  band(ws, 2, 1, n, C.navy, 18);
  band(ws, 3, 1, n, C.soft, 20);
  band(ws, 4, 1, n, C.white, 6);
  const t = merged(ws, 1, 1, n);
  t.value = o.title;
  t.font = font({ size: 16, bold: true, color: argb(C.white) });
  t.alignment = { vertical: 'middle', indent: 1 };
  const st = merged(ws, 2, 1, n);
  st.value = `${ctx.orgName} · ${o.scope === 'mine' ? ctx.meName : 'Whole organization'} · ${s.total} ${s.total === 1 ? 'task' : 'tasks'} · ${stamp(ctx.generatedAt)}`;
  st.font = font({ size: 9, color: argb(C.onNavy) });
  st.alignment = { vertical: 'top', indent: 1 };
  const fl = merged(ws, 3, 1, n);
  fl.value = describeFilters(o, ctx).filter(([k]) => !['Scope', 'Grouped by', 'Sorted by'].includes(k)).map(([k, v]) => `${k}: ${v}`).join('   ·   ');
  fl.font = font({ size: 9, color: argb(C.ink2) });
  fl.alignment = { vertical: 'middle', indent: 1 };

  // Header row
  const head = ws.getRow(HEAD);
  head.height = 26;
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.kind === 'hours' ? `${c.label}` : c.label;
    cell.font = font({ size: 10, bold: true, color: argb(C.white) });
    cell.fill = solid(C.navy2);
    cell.alignment = { vertical: 'middle', horizontal: i === 0 || c.wrap ? 'left' : 'center', indent: i === 0 || c.wrap ? 1 : 0, wrapText: true };
    cell.border = { bottom: { style: 'medium', color: argb(C.accent) }, right: thin(C.navy) };
  });

  let r = HEAD + 1;
  const today = todayISO();
  for (const g of groups) {
    if (grouped) {
      const fg = g.status !== undefined ? STATUS_FG[g.status] : g.priority ? PRI_FG[g.priority] : C.navy;
      const bg = g.status !== undefined ? STATUS_BG[g.status] : g.priority ? PRI_BG[g.priority] : C.soft;
      const cell = merged(ws, r, 1, n);
      const glyph = g.status !== undefined ? `${STATUS_GLYPH[g.status]}  ` : g.priority ? `${PRI_GLYPH_X[g.priority]}  ` : '';
      cell.value = { richText: [
        { text: `${glyph}${g.label}`, font: font({ size: 11, bold: true, color: argb(fg) }) },
        { text: `    ${g.tasks.length} ${g.tasks.length === 1 ? 'task' : 'tasks'}`, font: font({ size: 9, color: argb(C.ink2) }) }
      ] };
      cell.fill = solid(bg);
      cell.alignment = { vertical: 'middle', indent: 1 };
      cell.border = { left: { style: 'thick', color: argb(fg) }, top: thin(C.white), bottom: thin(C.line) };
      ws.getRow(r).height = 24;
      r++;
    }
    g.tasks.forEach((task, i) => { writeTask(ws, r, task, cols, ctx, i % 2 === 1, today); if (grouped) ws.getRow(r).outlineLevel = 1; r++; });
    if (grouped) { ws.getRow(r).height = 8; r++; }
  }
  if (!groups.some((g) => g.tasks.length)) {
    const e = merged(ws, r, 1, n);
    e.value = 'No tasks match these filters.';
    e.font = font({ italic: true, color: argb(C.muted) });
    e.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(r).height = 36;
    r++;
  }
  // Excel filters work on a plain table; grouped sheets get collapsible sections instead.
  if (!grouped && s.total) ws.autoFilter = { from: { row: HEAD, column: 1 }, to: { row: HEAD + s.total, column: n } };

  r++;
  const foot = merged(ws, r, 1, n);
  foot.value = `${s.total} ${s.total === 1 ? 'task' : 'tasks'} · Generated by Dayflow for ${ctx.meName} · ${stamp(ctx.generatedAt)}${grouped ? ' · Use the + / − buttons on the left to collapse groups.' : ''}`;
  foot.font = font({ size: 8, italic: true, color: argb(C.muted) });
}

function writeTask(ws: ExcelJS.Worksheet, r: number, t: Task, cols: ColumnDef[], ctx: ExportContext, zebra: boolean, today: string) {
  const row = ws.getRow(r);
  let lines = 1;
  const done = t.status === 4;
  cols.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    const v = c.get(t, ctx);
    cell.font = font();
    cell.alignment = { vertical: 'top', wrapText: !!c.wrap, horizontal: c.wrap || i === 0 ? 'left' : 'center', indent: i === 0 || c.wrap ? 1 : 0 };
    cell.border = { bottom: thin(), right: thin(C.soft) };
    if (zebra) cell.fill = solid(C.zebra);

    if (c.key === 'title') {
      cell.value = String(v);
      cell.font = font({ bold: true, color: argb(done ? C.muted : C.ink), strike: done });
    } else if (c.key === 'status') {
      cell.value = `${STATUS_GLYPH[t.status]}  ${v}`;
      cell.font = font({ bold: true, color: argb(STATUS_FG[t.status]) });
      cell.fill = solid(STATUS_BG[t.status]);
    } else if (c.key === 'priority') {
      cell.value = `${PRI_GLYPH_X[t.priority]}  ${v}`;
      cell.font = font({ bold: true, color: argb(PRI_FG[t.priority]) });
    } else if (c.key === 'links' && t.links.length) {
      const text = String(v);
      cell.value = t.links.length === 1 ? { text, hyperlink: t.links[0].url, tooltip: t.links[0].url } : text;
      cell.font = font({ color: argb(C.accent), underline: t.links.length === 1 });
    } else if (c.kind === 'date' || c.kind === 'datetime') {
      cell.value = v instanceof Date ? excelDate(v) : v;
      cell.numFmt = c.kind === 'date' ? 'dd mmm yyyy' : 'dd mmm yyyy, hh:mm';
      if (c.key === 'due' && t.dueDate && !done) {
        if (t.dueDate < today) { cell.font = font({ bold: true, color: argb(C.red) }); cell.fill = solid(C.redSoft); }
        else if (t.dueDate === today) { cell.font = font({ bold: true, color: argb(C.amber) }); cell.fill = solid(C.amberSoft); }
      }
    } else if (c.kind === 'number' || c.kind === 'hours' || c.kind === 'days') {
      cell.value = v;
      cell.numFmt = c.kind === 'hours' ? '0.0 "h";;"—"' : c.kind === 'days' ? '0.0 "d";;"—"' : '0;;"—"';
      cell.font = font({ color: argb(C.ink2) });
    } else {
      cell.value = v;
      if (c.key === 'assignee' && !t.assigneeId) cell.font = font({ italic: true, color: argb(C.muted) });
      if (c.key === 'blocked' && v) cell.font = font({ color: argb(C.red) });
      if (c.key === 'tags' || c.key === 'project') cell.font = font({ color: argb(c.key === 'tags' ? C.accent : C.ink2) });
      if (c.key === 'remarks' && v) cell.font = font({ italic: true, color: argb(C.ink2) });
    }
    if (c.wrap && typeof v === 'string' && v) {
      const perLine = Math.max(8, c.width * 1.05);
      lines = Math.max(lines, v.split('\n').reduce((a, p) => a + Math.max(1, Math.ceil(p.length / perLine)), 0));
    }
  });
  row.height = Math.min(150, Math.max(22, lines * 13.5 + 8));
}

// ---------------------------------------------------------------- Links sheet
function linksSheet(wb: ExcelJS.Workbook, tasks: Task[], ctx: ExportContext) {
  const ws = wb.addWorksheet('Links', {
    views: [{ state: 'frozen', ySplit: 3, showGridLines: false }],
    properties: { tabColor: argb(C.accent), defaultRowHeight: 18 },
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });
  ws.columns = [{ width: 40 }, { width: 16 }, { width: 28 }, { width: 60 }];
  band(ws, 1, 1, 4, C.navy, 28);
  const t = merged(ws, 1, 1, 4);
  t.value = 'Links';
  t.font = font({ size: 14, bold: true, color: argb(C.white) });
  t.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(2).height = 6;
  ['Task', 'Status', 'Link', 'Address'].forEach((h, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = h;
    cell.font = font({ bold: true, color: argb(C.white) });
    cell.fill = solid(C.navy2);
    cell.alignment = { vertical: 'middle', indent: 1 };
    cell.border = { bottom: { style: 'medium', color: argb(C.accent) } };
  });
  ws.getRow(3).height = 24;
  let r = 4;
  for (const task of tasks) {
    for (const l of task.links) {
      const zebra = (r - 4) % 2 === 1;
      const host = (() => { try { return new URL(l.url).hostname.replace(/^www\./, ''); } catch { return l.url; } })();
      const vals: ExcelJS.CellValue[] = [task.title, `${STATUS_GLYPH[task.status]}  ${STATUS_NAMES[task.status]}`, l.label || host, { text: l.url, hyperlink: l.url }];
      vals.forEach((v, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = v;
        cell.alignment = { vertical: 'middle', indent: 1 };
        cell.border = { bottom: thin() };
        cell.font = i === 1 ? font({ bold: true, color: argb(STATUS_FG[task.status]) }) : i === 3 ? font({ color: argb(C.accent), underline: true }) : font({ bold: i === 0 });
        if (i === 1) cell.fill = solid(STATUS_BG[task.status]);
        else if (zebra) cell.fill = solid(C.zebra);
      });
      ws.getRow(r).height = 20;
      r++;
    }
  }
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: Math.max(3, r - 1), column: 4 } };
  void ctx;
}

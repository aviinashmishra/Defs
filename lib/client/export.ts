/*
 * Task export: one set of filters/columns/grouping feeds three writers
 * (styled Excel workbook, print-ready PDF report, plain CSV).
 */
import type { State } from './store';
import { isMine } from './store';
import { DUE_BUCKETS, dueBucket, parseISO, PRI_LABEL, startOfToday, todayISO } from './util';
import { STATUS_NAMES, type Member, type Priority, type Status, type Task } from '../types';

export type ExportFormat = 'xlsx' | 'pdf' | 'csv';
export type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'month' | 'none' | 'custom';
export type GroupBy = 'none' | 'status' | 'priority' | 'assignee' | 'team' | 'project' | 'due';
export type SortBy = 'due' | 'priority' | 'status' | 'title' | 'created' | 'updated';
export type ColumnKey =
  | 'title' | 'status' | 'priority' | 'assignee' | 'team' | 'due' | 'project' | 'tags' | 'description' | 'remarks'
  | 'blocked' | 'links' | 'files' | 'comments' | 'focus' | 'creator' | 'created' | 'updated' | 'done' | 'cycle' | 'record';

export interface ExportOptions {
  scope: 'mine' | 'team';
  statuses: Status[]; // which statuses to include (all five = no filter)
  priorities: Priority[];
  due: DueFilter;
  from: string; // YYYY-MM-DD, custom range only
  to: string;
  assignees: string[]; // member ids, 'none' = unassigned; empty = anyone
  teams: string[]; // team ids, 'none' = shared with no team, 'personal' = private to you; empty = any
  projects: string[]; // '' = no project; empty = any
  tags: string[]; // any of; empty = any
  includeArchived: boolean; // cleared done tasks (last 70 days)
  query: string;
  columns: ColumnKey[];
  groupBy: GroupBy;
  sortBy: SortBy;
  format: ExportFormat;
  title: string;
  /** Replaces the generated filter summary (the History view describes its own filters). */
  notes?: Array<[string, string]>;
}

export const ALL_STATUSES: Status[] = [0, 1, 2, 3, 4];
export const ALL_PRIORITIES: Priority[] = ['high', 'medium', 'low'];
export const ESSENTIAL_COLUMNS: ColumnKey[] = ['title', 'status', 'priority', 'assignee', 'team', 'due', 'project', 'tags', 'description'];

export const DEFAULT_EXPORT: ExportOptions = {
  scope: 'mine',
  statuses: [...ALL_STATUSES],
  priorities: [...ALL_PRIORITIES],
  due: 'any',
  from: '',
  to: '',
  assignees: [],
  teams: [],
  projects: [],
  tags: [],
  includeArchived: false,
  query: '',
  columns: [...ESSENTIAL_COLUMNS, 'remarks', 'blocked', 'links', 'files', 'comments', 'created'],
  groupBy: 'status',
  sortBy: 'due',
  format: 'xlsx',
  title: 'Task report'
};

export const DUE_LABEL: Record<DueFilter, string> = {
  any: 'Any date', overdue: 'Overdue', today: 'Due today', week: 'Due in 7 days', month: 'Due in 30 days', none: 'No due date', custom: 'Custom range'
};
export const GROUP_LABEL: Record<GroupBy, string> = {
  none: 'No grouping', status: 'Status', priority: 'Priority', assignee: 'Assignee', team: 'Team', project: 'Project', due: 'Due date'
};
export const SORT_LABEL: Record<SortBy, string> = {
  due: 'Due date', priority: 'Priority', status: 'Status', title: 'Title (A–Z)', created: 'Newest first', updated: 'Recently updated'
};

// ---------------------------------------------------------------- selection
export interface ExportContext {
  orgName: string;
  meName: string;
  members: Map<string, string>;
  teams: Map<string, string>;
  generatedAt: Date;
}

export function exportContext(s: State): ExportContext {
  return {
    orgName: s.org.name, meName: s.me.name, members: new Map(s.members.map((m: Member) => [m.id, m.name])),
    teams: new Map(s.teams.map((t) => [t.id, t.name])), generatedAt: new Date()
  };
}

const PRI_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const plusDays = (n: number) => { const d = new Date(startOfToday()); d.setDate(d.getDate() + n); return todayISO(d); };

export function selectTasks(s: State, o: ExportOptions): Task[] {
  const today = todayISO();
  const pool = o.includeArchived ? s.tasks.concat(s.archived) : s.tasks;
  const tokens = o.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const name = (id: string | null) => (id ? s.members.find((m) => m.id === id)?.name || '' : '');
  const list = pool.filter((t) => {
    if (o.scope === 'mine' && !isMine(t, s.me.id)) return false;
    if (!o.statuses.includes(t.status)) return false;
    if (!o.priorities.includes(t.priority)) return false;
    if (o.assignees.length && !o.assignees.includes(t.assigneeId ?? 'none')) return false;
    if (o.teams?.length && !o.teams.includes(t.private ? 'personal' : t.teamId ?? 'none')) return false;
    if (o.projects.length && !o.projects.includes(t.project ?? '')) return false;
    if (o.tags.length && !t.tags.some((x) => o.tags.includes(x))) return false;
    const d = t.dueDate;
    switch (o.due) {
      case 'overdue': if (!(d && d < today && t.status !== 4)) return false; break;
      case 'today': if (d !== today) return false; break;
      case 'week': if (!(d && d >= today && d <= plusDays(7))) return false; break;
      case 'month': if (!(d && d >= today && d <= plusDays(30))) return false; break;
      case 'none': if (d) return false; break;
      case 'custom': if (!d || (o.from && d < o.from) || (o.to && d > o.to)) return false; break;
    }
    if (tokens.length) {
      const hay = [t.title, t.description, t.remarks, t.project, t.blockedReason, name(t.assigneeId), t.tags.join(' '), t.links.map((l) => `${l.label} ${l.url}`).join(' ')].join(' ').toLowerCase();
      if (!tokens.every((k) => hay.includes(k.replace(/^[#@]/, '')))) return false;
    }
    return true;
  });
  const byDue = (a: Task, b: Task) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
  const cmp: Record<SortBy, (a: Task, b: Task) => number> = {
    due: (a, b) => byDue(a, b) || PRI_RANK[a.priority] - PRI_RANK[b.priority],
    priority: (a, b) => PRI_RANK[a.priority] - PRI_RANK[b.priority] || byDue(a, b),
    status: (a, b) => a.status - b.status || byDue(a, b),
    title: (a, b) => a.title.localeCompare(b.title),
    created: (a, b) => b.createdAt - a.createdAt,
    updated: (a, b) => b.updatedAt - a.updatedAt
  };
  return list.sort(cmp[o.sortBy]);
}

export interface Group { key: string; label: string; status?: Status; priority?: Priority; tasks: Task[] }

export function groupTasks(tasks: Task[], by: GroupBy, ctx: ExportContext): Group[] {
  if (by === 'none') return [{ key: 'all', label: 'All tasks', tasks }];
  const map = new Map<string, Group>();
  const put = (key: string, label: string, t: Task, extra: Partial<Group> = {}) => {
    if (!map.has(key)) map.set(key, { key, label, tasks: [], ...extra });
    map.get(key)!.tasks.push(t);
  };
  for (const t of tasks) {
    if (by === 'status') put(`s${t.status}`, STATUS_NAMES[t.status], t, { status: t.status });
    else if (by === 'priority') put(`p${PRI_RANK[t.priority]}`, `${PRI_LABEL[t.priority]} priority`, t, { priority: t.priority });
    else if (by === 'assignee') put(t.assigneeId ? `a:${ctx.members.get(t.assigneeId) || 'Former member'}` : '~', t.assigneeId ? ctx.members.get(t.assigneeId) || 'Former member' : 'Unassigned', t);
    else if (by === 'team') { const n = t.private ? 'Personal' : t.teamId ? ctx.teams.get(t.teamId) || 'Former team' : ''; put(n ? `t:${n.toLowerCase()}` : '~', n || 'No team', t); }
    else if (by === 'project') put(t.project ? `p:${t.project.toLowerCase()}` : '~', t.project || 'No project', t);
    else { const b = t.status === 4 && dueBucket(t.dueDate) === 'Overdue' ? 'Done' : dueBucket(t.dueDate); put(`d${b === 'Done' ? 9 : DUE_BUCKETS.indexOf(b)}`, b, t); }
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------- columns
export type CellValue = string | number | Date | null;
export interface ColumnDef {
  key: ColumnKey;
  label: string;
  width: number; // Excel character width
  wrap?: boolean;
  kind?: 'text' | 'date' | 'datetime' | 'number' | 'hours' | 'days';
  get: (t: Task, ctx: ExportContext) => CellValue;
}

const who = (ctx: ExportContext, id: string | null) => (id ? ctx.members.get(id) || 'Former member' : '');
const date = (iso: string | null) => (iso ? parseISO(iso) : null);
const at = (ms: number | null) => (ms ? new Date(ms) : null);
/** Where the task is now: still on the board, cleared after it was done, or deleted. */
export const recordLabel = (t: Pick<Task, 'archivedAt' | 'deletedAt'>) => (t.deletedAt ? 'Deleted' : t.archivedAt ? 'Cleared' : 'On board');

export const COLUMNS: ColumnDef[] = [
  { key: 'title', label: 'Task', width: 38, wrap: true, get: (t) => t.title },
  { key: 'status', label: 'Status', width: 15, get: (t) => STATUS_NAMES[t.status] },
  { key: 'priority', label: 'Priority', width: 12, get: (t) => PRI_LABEL[t.priority] },
  { key: 'assignee', label: 'Assignee', width: 18, get: (t, c) => who(c, t.assigneeId) || 'Unassigned' },
  { key: 'team', label: 'Team', width: 16, get: (t, c) => (t.private ? 'Personal' : t.teamId ? c.teams.get(t.teamId) || 'Former team' : '') },
  { key: 'due', label: 'Due date', width: 14, kind: 'date', get: (t) => date(t.dueDate) },
  { key: 'project', label: 'Project', width: 16, get: (t) => t.project || '' },
  { key: 'tags', label: 'Tags', width: 18, wrap: true, get: (t) => t.tags.map((x) => `#${x}`).join(' ') },
  { key: 'description', label: 'Description', width: 48, wrap: true, get: (t) => t.description || '' },
  { key: 'remarks', label: 'Remarks', width: 34, wrap: true, get: (t) => t.remarks || '' },
  { key: 'blocked', label: 'Blocked reason', width: 28, wrap: true, get: (t) => (t.status === 2 ? t.blockedReason || '' : '') },
  { key: 'links', label: 'Links', width: 36, wrap: true, get: (t) => t.links.map((l) => (l.label ? `${l.label}: ${l.url}` : l.url)).join('\n') },
  { key: 'files', label: 'Files', width: 8, kind: 'number', get: (t) => t.attachmentCount },
  { key: 'comments', label: 'Comments', width: 11, kind: 'number', get: (t) => t.commentCount },
  { key: 'focus', label: 'Focus time', width: 12, kind: 'hours', get: (t) => Math.round((t.timeSpent / 3600) * 100) / 100 },
  { key: 'creator', label: 'Created by', width: 18, get: (t, c) => who(c, t.creatorId) },
  { key: 'created', label: 'Created', width: 18, kind: 'datetime', get: (t) => at(t.createdAt) },
  { key: 'updated', label: 'Last updated', width: 18, kind: 'datetime', get: (t) => at(t.updatedAt) },
  { key: 'done', label: 'Completed', width: 18, kind: 'datetime', get: (t) => at(t.doneAt) },
  { key: 'cycle', label: 'Cycle time', width: 12, kind: 'days', get: (t) => (t.doneAt ? Math.round(((t.doneAt - t.createdAt) / 86400000) * 10) / 10 : null) },
  { key: 'record', label: 'Record', width: 12, get: (t) => recordLabel(t) }
];

export function columnsFor(o: ExportOptions): ColumnDef[] {
  const keys = new Set<ColumnKey>(['title', ...o.columns]);
  return COLUMNS.filter((c) => keys.has(c.key));
}

// ---------------------------------------------------------------- summary numbers
export interface Summary {
  total: number;
  byStatus: number[]; // index = status
  byPriority: Record<Priority, number>;
  overdue: number;
  dueToday: number;
  focusHours: number;
  people: Array<{ name: string; byStatus: number[]; total: number }>;
}

export function summarize(tasks: Task[], ctx: ExportContext): Summary {
  const today = todayISO();
  const byStatus = [0, 0, 0, 0, 0];
  const byPriority: Record<Priority, number> = { high: 0, medium: 0, low: 0 };
  const people = new Map<string, number[]>();
  let overdue = 0, dueToday = 0, focus = 0;
  for (const t of tasks) {
    byStatus[t.status]++;
    byPriority[t.priority]++;
    if (t.status !== 4 && t.dueDate && t.dueDate < today) overdue++;
    if (t.status !== 4 && t.dueDate === today) dueToday++;
    focus += t.timeSpent;
    const n = who(ctx, t.assigneeId) || 'Unassigned';
    if (!people.has(n)) people.set(n, [0, 0, 0, 0, 0]);
    people.get(n)![t.status]++;
  }
  return {
    total: tasks.length, byStatus, byPriority, overdue, dueToday, focusHours: Math.round((focus / 3600) * 10) / 10,
    people: [...people.entries()].map(([name, s]) => ({ name, byStatus: s, total: s.reduce((a, b) => a + b, 0) }))
      .sort((a, b) => (a.name === 'Unassigned' ? 1 : b.name === 'Unassigned' ? -1 : b.total - a.total || a.name.localeCompare(b.name)))
  };
}

/** Human-readable list of the filters that narrow the export (shown in every format). */
export function describeFilters(o: ExportOptions, ctx: ExportContext): Array<[string, string]> {
  if (o.notes) return [...o.notes, ['Grouped by', GROUP_LABEL[o.groupBy]], ['Sorted by', SORT_LABEL[o.sortBy]]];
  const out: Array<[string, string]> = [['Scope', o.scope === 'mine' ? `My tasks (${ctx.meName})` : `Whole organization (${ctx.orgName})`]];
  out.push(['Status', o.statuses.length === 5 ? 'All' : o.statuses.map((s) => STATUS_NAMES[s]).join(', ') || 'None']);
  out.push(['Priority', o.priorities.length === 3 ? 'All' : o.priorities.map((p) => PRI_LABEL[p]).join(', ') || 'None']);
  out.push(['Due', o.due === 'custom' ? `${o.from || '…'} to ${o.to || '…'}` : DUE_LABEL[o.due]]);
  if (o.assignees.length) out.push(['People', o.assignees.map((id) => (id === 'none' ? 'Unassigned' : ctx.members.get(id) || 'Former member')).join(', ')]);
  if (o.teams?.length) out.push(['Teams', o.teams.map((id) => (id === 'none' ? 'No team' : id === 'personal' ? 'Personal' : ctx.teams.get(id) || 'Former team')).join(', ')]);
  if (o.projects.length) out.push(['Projects', o.projects.map((p) => p || 'No project').join(', ')]);
  if (o.tags.length) out.push(['Tags', o.tags.map((t) => `#${t}`).join(' ')]);
  if (o.query.trim()) out.push(['Search', `“${o.query.trim()}”`]);
  out.push(['Cleared done tasks', o.includeArchived ? 'Included' : 'Not included']);
  out.push(['Grouped by', GROUP_LABEL[o.groupBy]]);
  out.push(['Sorted by', SORT_LABEL[o.sortBy]]);
  return out;
}

export function exportFileName(o: ExportOptions, ext: string): string {
  const slug = (o.title || 'tasks').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tasks';
  return `dayflow-${slug}-${todayISO()}.${ext}`;
}

// ---------------------------------------------------------------- CSV
/** Cells that start with = + - @ could run as formulas in spreadsheet apps; prefix them. */
const safe = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const pad = (n: number) => String(n).padStart(2, '0');
function csvValue(v: CellValue, kind?: ColumnDef['kind']): string {
  if (v == null) return '';
  if (v instanceof Date) {
    const d = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    return kind === 'datetime' ? `${d} ${pad(v.getHours())}:${pad(v.getMinutes())}` : d;
  }
  return typeof v === 'number' ? String(v) : safe(v);
}

export function buildCsv(tasks: Task[], o: ExportOptions, ctx: ExportContext): Blob {
  const cols = columnsFor(o);
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [cols.map((c) => esc(c.kind === 'hours' ? `${c.label} (h)` : c.kind === 'days' ? `${c.label} (days)` : c.label)).join(',')];
  for (const t of tasks) lines.push(cols.map((c) => esc(csvValue(c.get(t, ctx), c.kind))).join(','));
  // BOM so Excel opens UTF-8 (names, ₹, emoji) correctly.
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

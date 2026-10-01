'use client';
/*
 * Task history: every task you can see (on the board, cleared after it was done, or
 * deleted) with filters, grouping, a weekly trend, per-task timelines, restore actions,
 * and exports; plus the organization-wide change log ("Activity").
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from '@/lib/client/bus';
import { canClear } from '@/lib/client/store';
import { canManageTask } from '@/lib/access';
import { buildCsv, DEFAULT_EXPORT, download, exportContext, exportFileName, type ColumnKey, type ExportFormat, type ExportOptions, type GroupBy as ExportGroup } from '@/lib/client/export';
import { fmtDay, fmtDuration, linkHost, parseISO, PRI_GLYPH, PRI_LABEL, relTime, startOfToday, todayISO } from '@/lib/client/util';
import { STATUS_NAMES, type HistoryEvent, type Priority, type Task } from '@/lib/types';
import { useDayflow, useStore, useUI } from './ctx';
import { Icon } from './Icons';
import { Avatar } from './TaskCard';
import { MenuButton, MultiSelect, Select, type SelectOption } from './Select';
import { memberOptions } from './pickers';
import './mytasks.css';
import './history.css';

// ---------------------------------------------------------------- filters
type Tab = 'all' | 'open' | 'done' | 'cleared' | 'deleted';
type DateField = 'created' | 'done' | 'updated' | 'due' | 'removed';
type Range = 'all' | 'today' | '7d' | '30d' | '90d' | 'year' | 'custom';
type Sort = 'newest' | 'oldest' | 'priority' | 'status' | 'title' | 'cycle';
type Group = 'month' | 'week' | 'day' | 'status' | 'assignee' | 'team' | 'none';
type Pane = 'tasks' | 'activity';

interface Filters {
  tab: Tab;
  q: string;
  statuses: string[];
  priorities: string[];
  assignees: string[];
  creators: string[];
  teams: string[];
  projects: string[];
  tags: string[];
  field: DateField;
  range: Range;
  from: string;
  to: string;
  sort: Sort;
  group: Group;
}

const DEFAULT_FILTERS: Filters = {
  tab: 'all', q: '', statuses: [], priorities: [], assignees: [], creators: [], teams: [], projects: [], tags: [],
  field: 'created', range: 'all', from: '', to: '', sort: 'newest', group: 'month'
};

const TABS: Array<{ key: Tab; label: string; icon: string; test: (t: Task) => boolean }> = [
  { key: 'all', label: 'All tasks', icon: 'i-list', test: () => true },
  { key: 'open', label: 'Open', icon: 's1', test: (t) => !t.deletedAt && !t.archivedAt && t.status !== 4 },
  { key: 'done', label: 'Completed', icon: 's4', test: (t) => !t.deletedAt && t.status === 4 },
  { key: 'cleared', label: 'Cleared', icon: 'i-check', test: (t) => !t.deletedAt && !!t.archivedAt },
  { key: 'deleted', label: 'Deleted', icon: 'i-trash', test: (t) => !!t.deletedAt }
];

const FIELD_LABEL: Record<DateField, string> = { created: 'Created', done: 'Completed', updated: 'Last updated', due: 'Due date', removed: 'Cleared or deleted' };
const FIELD_ICON: Record<DateField, string> = { created: 'i-plus', done: 's4', updated: 'i-history', due: 'i-cal', removed: 'i-trash' };
const RANGE_LABEL: Record<Range, string> = { all: 'Any time', today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', year: 'This year', custom: 'Custom range' };
const SORT_LABEL: Record<Sort, string> = { newest: 'Newest first', oldest: 'Oldest first', priority: 'Priority', status: 'Status', title: 'Title (A–Z)', cycle: 'Longest cycle time' };
const SORT_ICON: Record<Sort, string> = { newest: 'i-arrow', oldest: 'i-arrow', priority: 'i-flag', status: 's1', title: 'i-text', cycle: 'i-clock' };
const GROUP_LABEL: Record<Group, string> = { month: 'Month', week: 'Week', day: 'Day', status: 'Status', assignee: 'Assignee', team: 'Team', none: 'No grouping' };
const GROUP_ICON: Record<Group, string> = { month: 'i-cal', week: 'i-cal', day: 'i-cal', status: 's1', assignee: 'i-user', team: 'i-users', none: 'i-list' };
const PRI_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
const DAY = 86400000;
const PAGE = 60;
// Columns for exports from this page: when and how each task moved, not just what it is.
const HISTORY_COLUMNS: ColumnKey[] = ['title', 'record', 'status', 'priority', 'assignee', 'team', 'project', 'tags', 'creator', 'created', 'done', 'cycle', 'focus', 'updated', 'description', 'remarks'];

function fieldTime(t: Task, field: DateField): number | null {
  switch (field) {
    case 'created': return t.createdAt;
    case 'done': return t.doneAt;
    case 'updated': return t.updatedAt;
    case 'due': return t.dueDate ? parseISO(t.dueDate).getTime() : null;
    case 'removed': return t.deletedAt ?? t.archivedAt ?? null;
  }
}

/** [from, to) in ms for the chosen range; null = no date filter. */
function rangeBounds(f: Pick<Filters, 'range' | 'from' | 'to'>): [number, number] | null {
  const today = startOfToday();
  switch (f.range) {
    case 'all': return null;
    case 'today': return [today, today + DAY];
    case '7d': return [today - 6 * DAY, today + DAY];
    case '30d': return [today - 29 * DAY, today + DAY];
    case '90d': return [today - 89 * DAY, today + DAY];
    case 'year': return [new Date(new Date().getFullYear(), 0, 1).getTime(), Infinity];
    case 'custom': return [f.from ? parseISO(f.from).getTime() : -Infinity, f.to ? parseISO(f.to).getTime() + DAY : Infinity];
  }
}

function mondayOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

const shortDate = (ms: number) => fmtDay(ms, { day: 'numeric', month: 'short', ...(new Date(ms).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
const clockTime = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const cycleDays = (t: Task) => (t.doneAt && t.status === 4 ? Math.max(0, t.doneAt - t.createdAt) / DAY : null);
function cycleLabel(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${days < 10 ? days.toFixed(1).replace(/\.0$/, '') : Math.round(days)}d`;
}

function loadFilters(key: string): Filters {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}') as Partial<Filters>;
    const out = { ...DEFAULT_FILTERS };
    for (const k of Object.keys(DEFAULT_FILTERS) as Array<keyof Filters>) {
      if (k in raw && typeof raw[k] === typeof DEFAULT_FILTERS[k] && Array.isArray(raw[k]) === Array.isArray(DEFAULT_FILTERS[k])) (out as Record<string, unknown>)[k] = raw[k];
    }
    return out;
  } catch { return { ...DEFAULT_FILTERS }; }
}

// ---------------------------------------------------------------- data: server history merged with the live board
function useHistoryTasks() {
  const s = useDayflow();
  const store = useStore();
  const [remote, setRemote] = useState<Task[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [capped, setCapped] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await store.loadHistory();
      if (n !== seq.current) return;
      setRemote(r.tasks);
      setCapped(r.capped);
      setStatus('ready');
      setLoadedAt(Date.now());
    } catch {
      if (n === seq.current) setStatus((cur) => (cur === 'ready' ? 'ready' : 'offline'));
    }
  }, [store]);
  useEffect(() => { void load(); }, [load]);

  // Tasks added, deleted or cleared on the board: reload once the writes have reached the server.
  const sig = `${s.tasks.length}:${s.archived.length}`;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (s.pending) return;
    const t = setTimeout(() => void load(), 900);
    return () => clearTimeout(t);
  }, [sig, s.pending, load]);

  const tasks = useMemo(() => {
    const live = new Map(s.tasks.map((t) => [t.id, t]));
    const cleared = new Map(s.archived.map((t) => [t.id, t]));
    const out = new Map<string, Task>();
    for (const t of remote ?? []) {
      const l = live.get(t.id), c = cleared.get(t.id);
      if (l) out.set(t.id, { ...l, archivedAt: null, deletedAt: null });
      else if (c) out.set(t.id, { ...t, ...c, archivedAt: t.archivedAt ?? c.archivedAt ?? c.updatedAt, deletedAt: null });
      // Was on the board at the last load and is gone now: removed on this device, the next load confirms it.
      else if (!t.archivedAt && !t.deletedAt) out.set(t.id, { ...t, deletedAt: loadedAt || t.updatedAt });
      else out.set(t.id, t);
    }
    for (const t of s.tasks) if (!out.has(t.id)) out.set(t.id, t);
    for (const t of s.archived) if (!out.has(t.id)) out.set(t.id, { ...t, archivedAt: t.archivedAt ?? t.updatedAt });
    return [...out.values()];
  }, [remote, s.tasks, s.archived, loadedAt]);

  return { tasks, status, capped, reload: load };
}

// ---------------------------------------------------------------- page
export function History() {
  const s = useDayflow();
  const store = useStore();
  const ui = useUI();
  const prefsKey = `dayflow.history.${s.me.id}`;
  const [f, setF] = useState<Filters>(() => loadFilters(prefsKey));
  const [pane, setPane] = useState<Pane>('tasks');
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Activity filters (the date range is shared with the task list).
  const [actQ, setActQ] = useState('');
  const [actor, setActor] = useState('');
  const [focusTask, setFocusTask] = useState<{ id: string; title: string } | null>(null);
  const { tasks, status, capped, reload } = useHistoryTasks();

  const set = (patch: Partial<Filters>) => { setF((cur) => ({ ...cur, ...patch })); setLimit(PAGE); };
  useEffect(() => {
    try { localStorage.setItem(prefsKey, JSON.stringify(f)); } catch { /* storage blocked */ }
  }, [f, prefsKey]);

  const names = useMemo(() => new Map(s.members.map((m) => [m.id, m.name])), [s.members]);
  const teamById = useMemo(() => new Map(s.teams.map((t) => [t.id, t])), [s.teams]);
  const isTeamOrg = s.org.kind === 'team';

  // Everything except the tab, so each tab can show its own count.
  const matchAll = useMemo(() => {
    const bounds = rangeBounds(f);
    const tokens = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const who = (id: string | null) => (id ? names.get(id)?.toLowerCase() || '' : '');
    return (t: Task, ignoreRange = false) => {
      if (f.statuses.length && !f.statuses.includes(String(t.status))) return false;
      if (f.priorities.length && !f.priorities.includes(t.priority)) return false;
      if (f.assignees.length && !f.assignees.includes(t.assigneeId ?? 'none')) return false;
      if (f.creators.length && !f.creators.includes(t.creatorId ?? 'none')) return false;
      if (f.teams.length && !f.teams.includes(t.private ? 'personal' : t.teamId ?? 'none')) return false;
      if (f.projects.length && !f.projects.includes(t.project ?? '')) return false;
      if (f.tags.length && !t.tags.some((x) => f.tags.includes(x))) return false;
      const b = ignoreRange ? null : bounds;
      if (b) {
        const v = fieldTime(t, f.field);
        if (v == null || v < b[0] || v >= b[1]) return false;
      }
      if (tokens.length) {
        const hay = [t.title, t.description, t.remarks, t.project, t.blockedReason, who(t.assigneeId), who(t.creatorId), t.tags.map((x) => `#${x}`).join(' '), t.links.map((l) => `${l.label} ${l.url}`).join(' ')].join(' ').toLowerCase();
        return tokens.every((k) => (k.startsWith('@') ? who(t.assigneeId).startsWith(k.slice(1)) : hay.includes(k)));
      }
      return true;
    };
  }, [f, names]);

  const base = useMemo(() => tasks.filter((t) => matchAll(t)), [tasks, matchAll]);
  const tabTest = TABS.find((x) => x.key === f.tab)!.test;
  const rows = useMemo(() => {
    const list = base.filter(tabTest);
    const time = (t: Task) => fieldTime(t, f.field);
    const byTime = (dir: 1 | -1) => (a: Task, b: Task) => {
      const x = time(a), y = time(b);
      if (x == null || y == null) return x == null && y == null ? b.createdAt - a.createdAt : x == null ? 1 : -1;
      return (x - y) * dir;
    };
    const cmp: Record<Sort, (a: Task, b: Task) => number> = {
      newest: byTime(-1),
      oldest: byTime(1),
      priority: (a, b) => PRI_RANK[a.priority] - PRI_RANK[b.priority] || b.createdAt - a.createdAt,
      status: (a, b) => a.status - b.status || b.createdAt - a.createdAt,
      title: (a, b) => a.title.localeCompare(b.title),
      cycle: (a, b) => (cycleDays(b) ?? -1) - (cycleDays(a) ?? -1)
    };
    return list.sort(cmp[f.sort]);
  }, [base, tabTest, f.sort, f.field]);

  const groups = useMemo(() => groupRows(rows, f, names, teamById), [rows, f, names, teamById]);

  // Drop selections that are filtered out, so exports never include hidden rows.
  const visibleIds = useMemo(() => new Set(rows.map((t) => t.id)), [rows]);
  const picked = useMemo(() => rows.filter((t) => selected.has(t.id)), [rows, selected]);
  const allPicked = rows.length > 0 && picked.length === rows.length;

  // ---- option lists (from everything you can see, so a filter never empties its own list)
  const projects = useMemo(() => [...new Set(tasks.map((t) => t.project).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b)), [tasks]);
  const tagList = useMemo(() => {
    const n = new Map<string, number>();
    tasks.forEach((t) => t.tags.forEach((x) => n.set(x, (n.get(x) || 0) + 1)));
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [tasks]);
  const byAssignee = useMemo(() => countBy(tasks, (t) => t.assigneeId ?? 'none'), [tasks]);
  const byCreator = useMemo(() => countBy(tasks, (t) => t.creatorId ?? 'none'), [tasks]);
  const people = (counts: Map<string, number>, none: string): SelectOption[] => [
    ...memberOptions(s.members, s.me.id, { inactive: true, only: (m) => counts.has(m.id) || m.active }).map((o) => ({ ...o, count: counts.get(o.value) ?? 0 })),
    { value: 'none', label: none, icon: 'i-user', color: 'var(--muted)', count: counts.get('none') ?? 0 }
  ];

  // ---- summary numbers for what is shown
  const stats = useMemo(() => {
    const done = rows.filter((t) => t.status === 4);
    const cycles = done.map(cycleDays).filter((x): x is number => x != null).sort((a, b) => a - b);
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    const median = cycles.length ? cycles[Math.floor(cycles.length / 2)] : null;
    const focus = rows.reduce((a, t) => a + t.timeSpent, 0);
    return {
      total: rows.length, done: done.length, open: rows.filter((t) => t.status !== 4 && !t.deletedAt).length,
      rate: rows.length ? Math.round((done.length / rows.length) * 100) : 0, avg, median, focus,
      tracked: rows.filter((t) => t.timeSpent >= 60).length,
      removed: rows.filter((t) => t.deletedAt).length
    };
  }, [rows]);
  const trendBase = useMemo(() => tasks.filter((t) => matchAll(t, true) && !t.deletedAt), [tasks, matchAll]);

  // ---- active filter chips
  const chips: Array<{ key: string; label: ReactNode; clear: () => void }> = [];
  if (f.q.trim()) chips.push({ key: 'q', label: <>“{f.q.trim()}”</>, clear: () => set({ q: '' }) });
  if (f.range !== 'all') chips.push({ key: 'range', label: <>{FIELD_LABEL[f.field]}: {f.range === 'custom' ? `${f.from || '…'} → ${f.to || '…'}` : RANGE_LABEL[f.range]}</>, clear: () => set({ range: 'all', from: '', to: '' }) });
  const listChip = (key: keyof Filters, label: string, list: string[], name: (v: string) => string) => {
    if (list.length) chips.push({ key, label: <>{label}: {list.map(name).join(', ')}</>, clear: () => set({ [key]: [] } as Partial<Filters>) });
  };
  listChip('statuses', 'Status', f.statuses, (v) => STATUS_NAMES[Number(v)]);
  listChip('priorities', 'Priority', f.priorities, (v) => PRI_LABEL[v as Priority]);
  listChip('assignees', 'Assignee', f.assignees, (v) => (v === 'none' ? 'Unassigned' : names.get(v) || 'Former member'));
  listChip('creators', 'Created by', f.creators, (v) => (v === 'none' ? 'Unknown' : names.get(v) || 'Former member'));
  listChip('teams', 'Team', f.teams, (v) => (v === 'personal' ? 'Personal' : v === 'none' ? 'No team' : teamById.get(v)?.name || 'Former team'));
  listChip('projects', 'Project', f.projects, (v) => v || 'No project');
  listChip('tags', 'Tags', f.tags, (v) => `#${v}`);
  const clearAll = () => { setF((cur) => ({ ...DEFAULT_FILTERS, tab: cur.tab, sort: cur.sort, group: cur.group, field: cur.field })); setLimit(PAGE); };

  // ---- exports
  const describe = (n: number): Array<[string, string]> => {
    const out: Array<[string, string]> = [['View', TABS.find((x) => x.key === f.tab)!.label]];
    if (picked.length) out.push(['Selection', `${n} hand-picked ${n === 1 ? 'task' : 'tasks'}`]);
    for (const c of chips) out.push(['Filter', textOf(c.label)]);
    return out;
  };
  const exportTasks = async (format: ExportFormat) => {
    const list = picked.length ? picked : rows;
    if (!list.length) { toast('Nothing to export. Loosen a filter first.', { icon: 'i-x' }); return; }
    const groupBy: ExportGroup = f.group === 'status' || f.group === 'assignee' || f.group === 'team' ? f.group : 'none';
    const opts: ExportOptions = {
      ...DEFAULT_EXPORT, scope: 'team', format, title: 'Task history', columns: HISTORY_COLUMNS, groupBy, includeArchived: true,
      sortBy: f.sort === 'priority' ? 'priority' : f.sort === 'status' ? 'status' : f.sort === 'title' ? 'title' : 'created', notes: describe(list.length)
    };
    const ctx = exportContext(store.getState());
    setBusy(true);
    try {
      if (format === 'xlsx') {
        const { buildXlsx } = await import('@/lib/client/export-xlsx');
        download(await buildXlsx(list, opts, ctx), exportFileName(opts, 'xlsx'));
        toast(`Exported ${list.length} ${list.length === 1 ? 'task' : 'tasks'} to Excel`, { icon: 'i-download' });
      } else if (format === 'pdf') {
        const { buildReportHtml, printReport } = await import('@/lib/client/export-pdf');
        printReport(buildReportHtml(list, opts, ctx, exportFileName(opts, 'pdf').replace(/\.pdf$/, '')));
        toast('Report ready. Choose “Save as PDF” in the print dialog.', { icon: 'i-file', timeout: 7000 });
      } else {
        download(buildCsv(list, opts, ctx), exportFileName(opts, 'csv'));
        toast(`Exported ${list.length} ${list.length === 1 ? 'task' : 'tasks'} to CSV`, { icon: 'i-download' });
      }
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`, { icon: 'i-x', timeout: 7000 });
    } finally {
      setBusy(false);
    }
  };
  const actParams = () => {
    const b = rangeBounds(f);
    return {
      q: actQ.trim() || undefined, actor: actor || undefined, task: focusTask?.id,
      from: b && Number.isFinite(b[0]) ? b[0] : undefined, to: b && Number.isFinite(b[1]) ? b[1] : undefined
    };
  };
  const exportActivity = async () => {
    setBusy(true);
    try {
      const all: HistoryEvent[] = [];
      let before: number | undefined;
      // Up to 10,000 entries, 500 at a time.
      for (let i = 0; i < 20; i++) {
        const r = await store.loadHistoryEvents({ ...actParams(), before, limit: 500 });
        all.push(...r.entries);
        if (!r.more || !r.entries.length) break;
        before = r.entries[r.entries.length - 1].createdAt;
      }
      if (!all.length) { toast('No activity matches these filters', { icon: 'i-history' }); return; }
      download(activityCsv(all), `dayflow-activity-log-${todayISO()}.csv`);
      toast(`Exported ${all.length} activity ${all.length === 1 ? 'entry' : 'entries'}`, { icon: 'i-download' });
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`, { icon: 'i-x', timeout: 7000 });
    } finally {
      setBusy(false);
    }
  };

  // ---- restore actions
  const restore = async (list: Task[]) => {
    const deleted = list.filter((t) => t.deletedAt && canManageTask(s.me, t));
    const cleared = list.filter((t) => !t.deletedAt && t.archivedAt && canClear(s.me, t));
    if (!deleted.length && !cleared.length) { toast('You can only restore tasks you created, are assigned to, or lead the team of', { icon: 'i-lock' }); return; }
    setBusy(true);
    let back = 0;
    try {
      for (const t of deleted) { await store.restoreTask(t.id); back++; }
      if (cleared.length) back += (await store.unarchiveTasks(cleared)).length;
      const one = list.length === 1 ? list[0] : null;
      toast(one ? `“${one.title}” is back on the board` : `${back} ${back === 1 ? 'task is' : 'tasks are'} back on the board`, {
        icon: 'i-undo', actions: one && back ? [{ label: 'Open', fn: () => ui.openDetail(one.id) }] : []
      });
      setSelected(new Set());
      void reload();
    } catch (err) {
      toast(`Could not restore: ${(err as Error).message}`, { icon: 'i-x', timeout: 7000 });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => setSelected((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected(allPicked ? new Set() : new Set(rows.map((t) => t.id)));
  useEffect(() => { setSelected((cur) => (([...cur].every((id) => visibleIds.has(id))) ? cur : new Set([...cur].filter((id) => visibleIds.has(id))))); }, [visibleIds]);

  const exportItems = [
    { key: 'xlsx', label: 'Excel workbook', hint: 'Summary sheet, styled rows, filters', icon: 'i-grid', color: '#128a5f', onSelect: () => void exportTasks('xlsx') },
    { key: 'pdf', label: 'PDF report', hint: 'Print-ready, with charts', icon: 'i-file', color: '#d03b3b', onSelect: () => void exportTasks('pdf') },
    { key: 'csv', label: 'CSV data', hint: 'Plain rows for Sheets or BI', icon: 'i-text', color: 'var(--st1)', onSelect: () => void exportTasks('csv') },
    { key: 'log', label: 'Activity log (CSV)', hint: 'Every change, who and when', icon: 'i-history', color: 'var(--accent-2)', group: 'Change log', onSelect: () => void exportActivity() }
  ];

  const rangeOptions: SelectOption<Range>[] = (Object.keys(RANGE_LABEL) as Range[]).map((k) => ({ value: k, label: RANGE_LABEL[k], icon: k === 'all' ? 'i-history' : 'i-cal' }));
  const summary = status === 'loading' && !tasks.length ? 'Loading your task history…'
    : `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} on record · ${tasks.filter((t) => t.status === 4 && !t.deletedAt).length} completed · ${tasks.filter((t) => t.deletedAt).length} deleted`;

  let shownSoFar = 0;

  return (
    <section className="view view-history" aria-labelledby="histTitle">
      <header className="mine-hero">
        <div>
          <p className="eyebrow">Everything that happened · {s.org.name}</p>
          <h1 className="greet" id="histTitle">Task <span className="grad">history</span></h1>
          <p className="mine-sub">{summary}</p>
        </div>
        <div className="mine-actions h-actions-top">
          <button className="btn btn-ghost" onClick={() => { void reload(); toast('History refreshed', { icon: 'i-history', timeout: 2000 }); }}><Icon name="i-undo" /><span>Refresh</span></button>
          <MenuButton label="Export history" items={exportItems} className="btn btn-3d btn-primary btn-lg" disabled={busy}>
            <Icon name={busy ? 'i-clock' : 'i-download'} /><span>{busy ? 'Preparing…' : pane === 'tasks' && picked.length ? `Export ${picked.length} selected` : 'Export'}</span>
            <svg className="sel-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </MenuButton>
        </div>
      </header>

      {status === 'offline' && (
        <p className="h-banner" role="status"><Icon name="i-clock" />You&apos;re offline, so this shows what&apos;s on this device. Deleted tasks and older cleared ones appear once you reconnect.
          <button className="link-btn" onClick={() => void reload()}>Try again</button></p>
      )}
      {capped && <p className="h-banner" role="status"><Icon name="i-sparkle" />Showing the newest 5,000 tasks. Narrow the dates to look further back.</p>}

      <div className="h-top">
        <div className="h-stats">
          <Stat icon="i-list" tone="var(--accent)" label="Tasks shown" value={String(stats.total)} sub={`${stats.open} open · ${stats.done} done${stats.removed ? ` · ${stats.removed} deleted` : ''}`} />
          <Stat icon="s4" tone="var(--st4)" label="Completion" value={`${stats.rate}%`} sub={`${stats.done} of ${stats.total} finished`} bar={stats.rate} />
          <Stat icon="i-clock" tone="var(--st1)" label="Avg. cycle time" value={stats.avg == null ? '—' : cycleLabel(stats.avg)} sub={stats.median == null ? 'Created → done' : `Median ${cycleLabel(stats.median)}`} />
          <Stat icon="i-bolt" tone="var(--pri-medium)" label="Focus logged" value={stats.focus >= 60 ? fmtDuration(stats.focus) : '0m'} sub={`${stats.tracked} ${stats.tracked === 1 ? 'task' : 'tasks'} tracked`} />
        </div>
        <Trend tasks={trendBase} onPick={(start) => { set({ field: 'done', range: 'custom', from: todayISO(new Date(start)), to: todayISO(new Date(start + 6 * DAY)), tab: 'done' }); setPane('tasks'); }} />
      </div>

      <div className="h-panes mine-tabs" role="tablist" aria-label="History views">
        <button role="tab" aria-selected={pane === 'tasks'} onClick={() => setPane('tasks')}><Icon name="i-list" />Tasks<span className="n">{rows.length}</span></button>
        <button role="tab" aria-selected={pane === 'activity'} onClick={() => setPane('activity')}><Icon name="i-history" />Activity log</button>
      </div>

      {pane === 'tasks' ? (
        <>
          <div className="h-filters glass">
            <div className="h-filter-row">
              <div className="search h-search">
                <Icon name="i-search" />
                <label htmlFor="histSearch" className="sr-only">Search history</label>
                <input id="histSearch" type="search" placeholder="Search titles, notes, links, #tags, @people" value={f.q} onChange={(e) => set({ q: e.target.value })} />
              </div>
              <Select<DateField> label="Date" variant="pill" value={f.field} onChange={(field) => set({ field })} minWidth={230}
                options={(Object.keys(FIELD_LABEL) as DateField[]).map((k) => ({ value: k, label: FIELD_LABEL[k], icon: FIELD_ICON[k], hint: k === 'removed' ? 'When it left the board' : undefined }))} />
              <Select<Range> label="Date range" variant="pill" className={f.range !== 'all' ? 'has-value' : ''} value={f.range} onChange={(range) => set({ range })} options={rangeOptions} />
              {f.range === 'custom' && (
                <div className="h-range">
                  <label><span className="sr-only">From</span><input type="date" className="field" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} /></label>
                  <span aria-hidden="true">→</span>
                  <label><span className="sr-only">To</span><input type="date" className="field" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} /></label>
                </div>
              )}
            </div>
            <div className="h-filter-row">
              <MultiSelect label="Status" anyLabel="Any status" icon="s1" values={f.statuses} onChange={(statuses) => set({ statuses })}
                options={STATUS_NAMES.map((n, i) => ({ value: String(i), label: n, icon: `s${i}`, color: `var(--st${i})`, count: tasks.filter((t) => t.status === i).length }))} />
              <MultiSelect label="Priority" anyLabel="Any priority" icon="i-flag" values={f.priorities} onChange={(priorities) => set({ priorities })}
                options={(['high', 'medium', 'low'] as Priority[]).map((p) => ({ value: p, label: `${PRI_GLYPH[p]} ${PRI_LABEL[p]}`, color: `var(--pri-${p})`, count: tasks.filter((t) => t.priority === p).length }))} />
              {s.members.length > 1 && <>
                <MultiSelect label="Assignee" anyLabel="Anyone" icon="i-user" values={f.assignees} onChange={(assignees) => set({ assignees })} options={people(byAssignee, 'Unassigned')} />
                <MultiSelect label="Created by" anyLabel="Any creator" icon="i-edit" values={f.creators} onChange={(creators) => set({ creators })} options={people(byCreator, 'Unknown')} />
              </>}
              {isTeamOrg && (
                <MultiSelect label="Team" anyLabel="Any team" icon="i-users" values={f.teams} onChange={(teams) => set({ teams })} options={[
                  ...s.teams.map((t) => ({ value: t.id, label: t.name, color: t.color, count: tasks.filter((x) => x.teamId === t.id && !x.private).length })),
                  { value: 'personal', label: 'Personal', icon: 'i-lock', color: 'var(--accent-2)', count: tasks.filter((x) => x.private).length },
                  { value: 'none', label: 'No team', icon: 'i-users', color: 'var(--st0)', count: tasks.filter((x) => !x.teamId && !x.private).length }
                ]} />
              )}
              {projects.length > 0 && (
                <MultiSelect label="Project" anyLabel="Any project" icon="i-folder" values={f.projects} onChange={(p) => set({ projects: p })} options={[
                  ...projects.map((p) => ({ value: p, label: p, count: tasks.filter((t) => t.project === p).length })),
                  { value: '', label: 'No project', count: tasks.filter((t) => !t.project).length }
                ]} />
              )}
              {tagList.length > 0 && (
                <MultiSelect label="Tags" anyLabel="Any tag" icon="i-tag" values={f.tags} onChange={(tags) => set({ tags })}
                  options={tagList.map(([t, n]) => ({ value: t, label: `#${t}`, count: n }))} />
              )}
              <span className="h-spacer" />
              <Select<Sort> label="Sort" variant="pill" value={f.sort} onChange={(sort) => set({ sort })} align="end" icon={SORT_ICON[f.sort]}
                options={(Object.keys(SORT_LABEL) as Sort[]).map((k) => ({ value: k, label: SORT_LABEL[k], icon: SORT_ICON[k], hint: k === 'newest' || k === 'oldest' ? `By ${FIELD_LABEL[f.field].toLowerCase()}` : undefined }))} />
              <Select<Group> label="Group by" variant="pill" value={f.group} onChange={(group) => set({ group })} align="end" icon="i-grid"
                options={(Object.keys(GROUP_LABEL) as Group[]).map((k) => ({ value: k, label: GROUP_LABEL[k], icon: GROUP_ICON[k], hint: ['month', 'week', 'day'].includes(k) ? `By ${FIELD_LABEL[f.field].toLowerCase()}` : undefined }))} />
            </div>
            {chips.length > 0 && (
              <div className="h-chips" aria-label="Active filters">
                {chips.map((c) => (
                  <span key={c.key} className="h-chip">{c.label}<button type="button" aria-label={`Remove filter ${textOf(c.label)}`} onClick={c.clear}><Icon name="i-x" /></button></span>
                ))}
                <button type="button" className="link-btn" onClick={clearAll}>Clear all</button>
              </div>
            )}
          </div>

          <div className="h-tabs mine-tabs" role="tablist" aria-label="Which tasks">
            {TABS.map((x) => (
              <button key={x.key} role="tab" aria-selected={f.tab === x.key} onClick={() => set({ tab: x.key })}>
                <Icon name={x.icon} />{x.label}<span className="n">{base.filter(x.test).length}</span>
              </button>
            ))}
          </div>

          <div className={`h-listbar${picked.length ? ' picking' : ''}`}>
            <label className="h-check">
              <input type="checkbox" checked={allPicked} ref={(el) => { if (el) el.indeterminate = picked.length > 0 && !allPicked; }} onChange={toggleAll} disabled={!rows.length} aria-label="Select all shown tasks" />
              <span className="sel-box"><Icon name="i-check" /></span>
            </label>
            {picked.length ? (
              <>
                <b>{picked.length} selected</b>
                {picked.some((t) => t.deletedAt || t.archivedAt) && (
                  <button className="btn btn-ghost h-sm" disabled={busy} onClick={() => void restore(picked.filter((t) => t.deletedAt || t.archivedAt))}><Icon name="i-undo" />Restore to board</button>
                )}
                <button className="link-btn" onClick={() => setSelected(new Set())}>Clear selection</button>
              </>
            ) : (
              <span className="muted">{status === 'loading' && !tasks.length ? 'Loading…' : `Showing ${Math.min(limit, rows.length)} of ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`}</span>
            )}
          </div>

          {status === 'loading' && !tasks.length ? (
            <ul className="mine-list" aria-hidden="true">{[0, 1, 2, 3].map((i) => <li key={i} className="h-skel" />)}</ul>
          ) : rows.length === 0 ? (
            <div className="mine-empty glass">
              <span className="empty-art" aria-hidden="true"><Icon name={chips.length ? 'i-search' : 'i-history'} /></span>
              <h3>{chips.length ? 'No tasks match these filters' : f.tab === 'deleted' ? 'Nothing deleted' : f.tab === 'cleared' ? 'Nothing cleared yet' : 'No history yet'}</h3>
              <p className="muted">{chips.length ? 'Try a wider date range or remove a filter.' : 'Tasks show up here as soon as you add them, and stay after they are done, cleared or deleted.'}</p>
              {chips.length > 0 && <button className="btn btn-ghost" onClick={clearAll}><Icon name="i-x" />Clear filters</button>}
            </div>
          ) : (
            <>
              {groups.map((g) => {
                if (shownSoFar >= limit) return null;
                const items = g.items.slice(0, limit - shownSoFar);
                shownSoFar += items.length;
                const done = g.items.filter((t) => t.status === 4).length;
                return (
                  <section key={g.key} className="mine-group h-group" aria-label={g.label || 'Tasks'}>
                    {f.group !== 'none' && (
                      <h2 className="group-head h-group-head">
                        {g.color && <i className="h-gdot" style={{ background: g.color }} aria-hidden="true" />}
                        {g.label}<span>{g.items.length}</span>
                        {done > 0 && g.items.length > 1 && <small>{done} done</small>}
                      </h2>
                    )}
                    <ul className="mine-list">
                      {items.map((t) => (
                        <HistoryRow key={t.id} t={t} names={names} team={t.teamId ? teamById.get(t.teamId) : undefined} priv={isTeamOrg && t.private}
                          checked={selected.has(t.id)} onCheck={() => toggle(t.id)} open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? null : t.id)}
                          canRestore={t.deletedAt ? canManageTask(s.me, t) : t.archivedAt ? canClear(s.me, t) : false} busy={busy} onRestore={() => void restore([t])}
                          onFullLog={() => { setFocusTask({ id: t.id, title: t.title }); setPane('activity'); }} />
                      ))}
                    </ul>
                  </section>
                );
              })}
              {rows.length > limit && (
                <div className="h-more">
                  <button className="btn btn-ghost" onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more</button>
                  <button className="link-btn" onClick={() => setLimit(rows.length)}>Show all {rows.length}</button>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <ActivityLog
          q={actQ} setQ={setActQ} actor={actor} setActor={setActor} focusTask={focusTask} clearFocus={() => setFocusTask(null)}
          range={f.range} setRange={(range) => set({ range })} rangeOptions={rangeOptions} params={actParams()}
          tasks={tasks} onOpenTask={(id, title) => {
            if (s.tasks.some((t) => t.id === id)) ui.openDetail(id);
            else { setPane('tasks'); set({ tab: 'all', q: title }); setOpenId(id); }
          }}
        />
      )}
    </section>
  );
}

function countBy(tasks: Task[], key: (t: Task) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tasks) { const k = key(t); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

/** Plain text of a chip label (for aria labels and export notes). */
function textOf(n: ReactNode): string {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  const el = n as { props?: { children?: ReactNode } };
  return el.props ? textOf(el.props.children) : '';
}

// ---------------------------------------------------------------- grouping
interface RowGroup { key: string; label: string; color?: string; items: Task[] }

function groupRows(rows: Task[], f: Filters, names: Map<string, string>, teams: Map<string, { name: string; color: string }>): RowGroup[] {
  if (f.group === 'none') return [{ key: 'all', label: '', items: rows }];
  const map = new Map<string, RowGroup>();
  const put = (key: string, label: string, t: Task, color?: string) => {
    let g = map.get(key);
    if (!g) { g = { key, label, color, items: [] }; map.set(key, g); }
    g.items.push(t);
  };
  const now = new Date();
  const today = startOfToday();
  const thisWeek = mondayOf(Date.now());
  for (const t of rows) {
    if (f.group === 'status') { put(`s${t.status}`, STATUS_NAMES[t.status], t, `var(--st${t.status})`); continue; }
    if (f.group === 'assignee') { const n = t.assigneeId ? names.get(t.assigneeId) || 'Former member' : ''; put(n ? `a:${n}` : '~', n || 'Unassigned', t); continue; }
    if (f.group === 'team') {
      const tm = t.teamId ? teams.get(t.teamId) : undefined;
      const n = t.private ? 'Personal' : tm?.name || (t.teamId ? 'Former team' : '');
      put(n ? `t:${n}` : '~', n || 'No team', t, t.private ? 'var(--accent-2)' : tm?.color ?? 'var(--st0)');
      continue;
    }
    const ms = fieldTime(t, f.field);
    if (ms == null) { put('~', 'No date', t); continue; }
    const d = new Date(ms);
    if (f.group === 'month') {
      put(`m${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), t);
    } else if (f.group === 'week') {
      const w = mondayOf(ms);
      const label = w === thisWeek ? 'This week' : w === thisWeek - 7 * DAY ? 'Last week' : w === thisWeek + 7 * DAY ? 'Next week' : `Week of ${shortDate(w)}`;
      put(`w${todayISO(new Date(w))}`, label, t);
    } else {
      const day = new Date(d); day.setHours(0, 0, 0, 0);
      const k = day.getTime();
      const label = k === today ? 'Today' : k === today - DAY ? 'Yesterday' : k === today + DAY ? 'Tomorrow'
        : fmtDay(k, { weekday: 'long', day: 'numeric', month: 'long', ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
      put(`d${todayISO(day)}`, label, t);
    }
  }
  const list = [...map.values()];
  const timeGroup = ['month', 'week', 'day'].includes(f.group);
  const asc = f.sort === 'oldest';
  return list.sort((a, b) => {
    if (a.key === '~' || b.key === '~') return a.key === '~' ? 1 : -1;
    if (timeGroup) return asc ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key);
    if (f.group === 'team' && (a.label === 'Personal' || b.label === 'Personal')) return a.label === 'Personal' ? 1 : -1;
    return a.key.localeCompare(b.key, undefined, { numeric: true });
  });
}

// ---------------------------------------------------------------- pieces
function Stat({ icon, tone, label, value, sub, bar }: { icon: string; tone: string; label: string; value: string; sub: string; bar?: number }) {
  return (
    <div className="m-stat glass h-stat" style={{ ['--tone' as string]: tone }}>
      <span className="m-stat-ico"><Icon name={icon} /></span>
      <span className="m-stat-label">{label}</span>
      <b className="m-stat-val">{value}</b>
      <span className="m-stat-sub">{sub}</span>
      {bar !== undefined && <span className="h-stat-bar" aria-hidden="true"><i style={{ width: `${bar}%` }} /></span>}
    </div>
  );
}

/** Completed tasks per week, last 12 weeks. One series, so no legend: the title names it. Click a bar to see that week. */
function Trend({ tasks, onPick }: { tasks: Task[]; onPick: (weekStart: number) => void }) {
  const weeks = useMemo(() => {
    const first = mondayOf(Date.now()) - 11 * 7 * DAY;
    const out = Array.from({ length: 12 }, (_, i) => ({ start: first + i * 7 * DAY, n: 0 }));
    for (const t of tasks) {
      if (t.status !== 4 || !t.doneAt || t.doneAt < first) continue;
      const i = Math.floor((mondayOf(t.doneAt) - first) / (7 * DAY) + 0.01);
      if (out[i]) out[i].n++;
    }
    return out;
  }, [tasks]);
  const max = Math.max(1, ...weeks.map((w) => w.n));
  const total = weeks.reduce((a, w) => a + w.n, 0);
  const last = weeks[11].n, prev = weeks[10].n;
  return (
    <section className="h-trend glass" aria-labelledby="trendTitle">
      <header>
        <div>
          <h2 id="trendTitle">Completed per week</h2>
          <p className="muted">Last 12 weeks · {total} done{last || prev ? ` · this week ${last}${prev ? ` vs ${prev}` : ''}` : ''}</p>
        </div>
      </header>
      <div className="h-bars">
        <span className="h-grid" style={{ bottom: '50%' }} aria-hidden="true"><i>{Math.round(max / 2) || ''}</i></span>
        <span className="h-grid top" aria-hidden="true"><i>{max}</i></span>
        {weeks.map((w, i) => {
          const label = `Week of ${shortDate(w.start)}`;
          return (
            <button key={w.start} type="button" className={`h-bar${i === 11 ? ' now' : ''}${w.n ? '' : ' zero'}`} style={{ ['--h' as string]: w.n / max }}
              data-tip={`${label}|${w.n} completed`} aria-label={`${label}: ${w.n} completed. Show these tasks.`} onClick={() => onPick(w.start)}>
              <i />
            </button>
          );
        })}
      </div>
      <div className="h-axis" aria-hidden="true">
        <span>{shortDate(weeks[0].start)}</span><span>{shortDate(weeks[6].start)}</span><span>This week</span>
      </div>
    </section>
  );
}

function RecordBadge({ t }: { t: Task }) {
  if (t.deletedAt) return <span className="h-rec del" title={`Deleted ${shortDate(t.deletedAt)}`}><Icon name="i-trash" />Deleted</span>;
  if (t.archivedAt) return <span className="h-rec clr" title={`Cleared from the board ${shortDate(t.archivedAt)}`}><Icon name="i-check" />Cleared</span>;
  return null;
}

function HistoryRow({ t, names, team, priv, checked, onCheck, open, onToggle, canRestore, busy, onRestore, onFullLog }: {
  t: Task; names: Map<string, string>; team?: { name: string; color: string }; priv: boolean;
  checked: boolean; onCheck: () => void; open: boolean; onToggle: () => void; canRestore: boolean; busy: boolean; onRestore: () => void; onFullLog: () => void;
}) {
  const ui = useUI();
  const assignee = t.assigneeId ? names.get(t.assigneeId) || 'Former member' : null;
  const cyc = cycleDays(t);
  const live = !t.deletedAt && !t.archivedAt;
  return (
    <li className={`mine-row h-row s-${t.status} pri-${t.priority}${t.deletedAt ? ' is-deleted' : ''}${open ? ' open' : ''}${checked ? ' picked' : ''}`} style={{ ['--sc' as string]: `var(--st${t.status})` }}>
      <div className="h-row-top">
        <label className="h-check">
          <input type="checkbox" checked={checked} onChange={onCheck} aria-label={`Select “${t.title}”`} />
          <span className="sel-box"><Icon name="i-check" /></span>
        </label>
        <button className="row-main" aria-expanded={open} onClick={onToggle}>
          <span className="h-title-line"><span className="row-title">{t.title}</span><RecordBadge t={t} /></span>
          <span className="row-meta">
            <span className="st-pill"><Icon name={`s${t.status}`} />{STATUS_NAMES[t.status]}</span>
            <span className="pri"><i aria-hidden="true">{PRI_GLYPH[t.priority]}</i>{PRI_LABEL[t.priority]}</span>
            {assignee ? <span className="h-who"><Avatar name={assignee} cls="xs" />{assignee}</span> : <span className="h-who muted-chip">Unassigned</span>}
            {priv && <span className="team-chip private-chip"><Icon name="i-lock" />Private</span>}
            {team && <span className="team-chip"><i className="team-dot" style={{ background: team.color }} aria-hidden="true" />{team.name}</span>}
            {t.project && <span className="mini"><Icon name="i-folder" />{t.project}</span>}
            {t.tags.slice(0, 3).map((x) => <span key={x} className="tagc">#{x}</span>)}
          </span>
        </button>
        <dl className="h-when">
          <div><dt>Created</dt><dd>{shortDate(t.createdAt)}</dd></div>
          <div><dt>{t.status === 4 ? 'Done' : 'Updated'}</dt><dd>{t.status === 4 && t.doneAt ? shortDate(t.doneAt) : relTime(t.updatedAt)}</dd></div>
          <div><dt>Cycle</dt><dd>{cyc == null ? '—' : cycleLabel(cyc)}</dd></div>
        </dl>
        <div className="h-acts">
          {live ? (
            <button className="btn btn-ghost h-sm" onClick={() => ui.openDetail(t.id)}><Icon name="i-external" />Open</button>
          ) : canRestore ? (
            <button className="btn btn-ghost h-sm h-restore" disabled={busy} onClick={onRestore}><Icon name="i-undo" />{t.deletedAt ? 'Restore' : 'Back to board'}</button>
          ) : null}
          <button className="icon-btn sm h-chev" aria-label={open ? 'Hide details' : 'Show details and timeline'} aria-expanded={open} onClick={onToggle}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
      {open && <HistoryDetail t={t} names={names} onFullLog={onFullLog} />}
    </li>
  );
}

function HistoryDetail({ t, names, onFullLog }: { t: Task; names: Map<string, string>; onFullLog: () => void }) {
  const store = useStore();
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    let live = true;
    store.loadHistoryEvents({ task: t.id, limit: 30 })
      .then((r) => { if (live) { setEvents(r.entries); setMore(r.more); } })
      .catch(() => { if (live) setEvents([]); });
    return () => { live = false; };
  }, [store, t.id, t.updatedAt]);
  const who = (id: string | null) => (id ? names.get(id) || 'Former member' : '—');
  const facts: Array<[string, ReactNode]> = [
    ['Created by', who(t.creatorId)],
    ['Created', `${shortDate(t.createdAt)}, ${clockTime(t.createdAt)} · ${t.source === 'voice' ? 'by voice' : 'typed'}`],
    ...(t.doneAt && t.status === 4 ? [['Completed', `${shortDate(t.doneAt)}, ${clockTime(t.doneAt)}`] as [string, ReactNode]] : []),
    ...(t.archivedAt ? [['Cleared', `${shortDate(t.archivedAt)}, ${clockTime(t.archivedAt)}`] as [string, ReactNode]] : []),
    ...(t.deletedAt ? [['Deleted', `${shortDate(t.deletedAt)}, ${clockTime(t.deletedAt)}`] as [string, ReactNode]] : []),
    ...(t.dueDate ? [['Due', shortDate(parseISO(t.dueDate).getTime())] as [string, ReactNode]] : []),
    ...(t.reviewerId ? [['Reviewer', who(t.reviewerId)] as [string, ReactNode]] : []),
    ['Focus time', t.timeSpent >= 60 ? fmtDuration(t.timeSpent) : '—'],
    ['Comments · files', `${t.commentCount} · ${t.attachmentCount}`]
  ];
  return (
    <div className="h-detail">
      <div className="h-detail-main">
        {t.description ? <p className="h-desc">{t.description}</p> : <p className="muted">No description.</p>}
        {t.status === 2 && t.blockedReason && <p className="row-block"><Icon name="s2" />{t.blockedReason}</p>}
        {t.remarks && <p className="h-remarks"><b>Remarks</b>{t.remarks}</p>}
        {t.links.length > 0 && (
          <ul className="h-links">
            {t.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer"><Icon name="i-link" />{l.label || linkHost(l.url)}</a></li>)}
          </ul>
        )}
        <dl className="h-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
      <div className="h-detail-side">
        <div className="h-tl-head"><b>Timeline</b>{(more || (events?.length ?? 0) > 6) && <button className="link-btn" onClick={onFullLog}>Full log →</button>}</div>
        {events === null ? <p className="muted">Loading…</p> : events.length === 0 ? <p className="muted">No changes recorded.</p> : (
          <ol className="h-tl">
            {events.map((e) => {
              const k = eventKind(e.change);
              return (
                <li key={e.id} style={{ ['--ec' as string]: k.color }}>
                  <span className="h-tl-ico"><Icon name={k.icon} /></span>
                  <span><b>{e.actorName}</b> {lowerFirst(e.change)}<time dateTime={new Date(e.createdAt).toISOString()}>{shortDate(e.createdAt)}, {clockTime(e.createdAt)}</time></span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/** Icon and color for one log entry, from its wording (see the activity writers in app/api/tasks). */
function eventKind(change: string): { icon: string; color: string } {
  const st = /^Status: .* → (Queued|In progress|Blocked|Review|Done)/.exec(change);
  if (st) { const i = STATUS_NAMES.indexOf(st[1] as (typeof STATUS_NAMES)[number]); return { icon: `s${i}`, color: `var(--st${i})` }; }
  if (/^Created/.test(change)) return { icon: 'i-plus', color: 'var(--accent)' };
  if (/^Deleted/.test(change)) return { icon: 'i-trash', color: 'var(--danger)' };
  if (/^Restored/.test(change)) return { icon: 'i-undo', color: 'var(--st4)' };
  if (/^Focused/.test(change)) return { icon: 'i-bolt', color: 'var(--pri-medium)' };
  if (/^Comment/.test(change)) return { icon: 'i-comment', color: 'var(--accent-2)' };
  if (/^(Attached|Removed “)/.test(change)) return { icon: 'i-clip', color: 'var(--accent)' };
  if (/^Priority/.test(change)) return { icon: 'i-flag', color: 'var(--pri-high)' };
  if (/^(Assigned|Unassigned|Reviewer)/.test(change)) return { icon: 'i-user', color: 'var(--st1)' };
  if (/^Due date/.test(change)) return { icon: 'i-cal', color: 'var(--pri-medium)' };
  if (/^Tags/.test(change)) return { icon: 'i-tag', color: 'var(--accent)' };
  if (/^(Renamed|Description|Remarks)/.test(change)) return { icon: 'i-edit', color: 'var(--text-2)' };
  if (/link/i.test(change)) return { icon: 'i-link', color: 'var(--accent)' };
  if (/^Blocked reason/.test(change)) return { icon: 's2', color: 'var(--st2)' };
  if (/team|private|organization/i.test(change)) return { icon: 'i-users', color: 'var(--accent-2)' };
  if (/^Project/.test(change)) return { icon: 'i-folder', color: 'var(--text-2)' };
  return { icon: 'i-history', color: 'var(--muted)' };
}

// ---------------------------------------------------------------- activity log
function ActivityLog({ q, setQ, actor, setActor, focusTask, clearFocus, range, setRange, rangeOptions, params, tasks, onOpenTask }: {
  q: string; setQ: (v: string) => void; actor: string; setActor: (v: string) => void;
  focusTask: { id: string; title: string } | null; clearFocus: () => void;
  range: Range; setRange: (r: Range) => void; rangeOptions: SelectOption<Range>[];
  params: { q?: string; actor?: string; task?: string; from?: number; to?: number };
  tasks: Task[]; onOpenTask: (id: string, title: string) => void;
}) {
  const s = useDayflow();
  const store = useStore();
  const [entries, setEntries] = useState<HistoryEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const [dq, setDq] = useState(params.q);
  useEffect(() => { const t = setTimeout(() => setDq(params.q), 300); return () => clearTimeout(t); }, [params.q]);
  const key = JSON.stringify({ ...params, q: dq });
  const recordOf = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const fetchPage = useCallback(async (before?: number) => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await store.loadHistoryEvents({ ...(JSON.parse(key) as typeof params), before, limit: 100 });
      if (n !== seq.current) return;
      setEntries((cur) => (before && cur ? [...cur, ...r.entries] : r.entries));
      setMore(r.more);
    } catch (err) {
      if (n === seq.current) { setError((err as Error).message); setEntries((cur) => cur ?? []); }
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [store, key]);
  useEffect(() => { void fetchPage(); }, [fetchPage]);

  const days = useMemo(() => {
    const out: Array<{ key: string; label: string; items: HistoryEvent[] }> = [];
    const today = startOfToday();
    for (const e of entries ?? []) {
      const d = new Date(e.createdAt); d.setHours(0, 0, 0, 0);
      const k = todayISO(d);
      if (out[out.length - 1]?.key !== k) {
        const ms = d.getTime();
        out.push({ key: k, label: ms === today ? 'Today' : ms === today - DAY ? 'Yesterday' : fmtDay(ms, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }), items: [] });
      }
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [entries]);

  return (
    <>
      <div className="h-filters glass">
        <div className="h-filter-row">
          <div className="search h-search">
            <Icon name="i-search" />
            <label htmlFor="actSearch" className="sr-only">Search the activity log</label>
            <input id="actSearch" type="search" placeholder="Search changes, task titles, people" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {s.members.length > 1 && (
            <Select label="Person" variant="pill" className={actor ? 'has-value' : ''} value={actor} onChange={setActor} minWidth={260}
              options={memberOptions(s.members, s.me.id, { none: 'Anyone', inactive: true })} />
          )}
          <Select<Range> label="When" variant="pill" className={range !== 'all' ? 'has-value' : ''} value={range} onChange={setRange} options={rangeOptions} />
        </div>
        {focusTask && (
          <div className="h-chips">
            <span className="h-chip"><Icon name="i-list" />Only “{focusTask.title}”<button type="button" aria-label="Show every task" onClick={clearFocus}><Icon name="i-x" /></button></span>
          </div>
        )}
      </div>

      {error && <p className="h-banner" role="alert"><Icon name="i-x" />Could not load the log: {error}<button className="link-btn" onClick={() => void fetchPage()}>Try again</button></p>}

      {entries === null ? (
        <ul className="mine-list" aria-hidden="true">{[0, 1, 2].map((i) => <li key={i} className="h-skel" />)}</ul>
      ) : entries.length === 0 && !error ? (
        <div className="mine-empty glass">
          <span className="empty-art" aria-hidden="true"><Icon name="i-history" /></span>
          <h3>No activity found</h3>
          <p className="muted">{q || actor || focusTask || range !== 'all' ? 'Try a different search, person or time range.' : 'Changes to tasks will be listed here.'}</p>
        </div>
      ) : (
        <div className={`h-log${loading ? ' loading' : ''}`} aria-busy={loading}>
          {days.map((d) => (
            <section key={d.key} className="h-day">
              <h2 className="group-head">{d.label}<span>{d.items.length}</span></h2>
              <ol className="h-events glass">
                {d.items.map((e) => {
                  const k = eventKind(e.change);
                  const rec = recordOf.get(e.taskId);
                  return (
                    <li key={e.id} style={{ ['--ec' as string]: k.color }}>
                      <span className="h-ev-ico"><Icon name={k.icon} /></span>
                      <Avatar name={e.actorName} cls="xs" />
                      <span className="h-ev-text">
                        <b>{e.actorName}</b> {lowerFirst(e.change)}
                        <span className="h-ev-task"> on <button className="link-btn inline" onClick={() => onOpenTask(e.taskId, e.taskTitle)}>{e.taskTitle}</button>{rec && <RecordBadge t={rec} />}</span>
                      </span>
                      <time dateTime={new Date(e.createdAt).toISOString()} title={new Date(e.createdAt).toLocaleString('en-GB')}>{clockTime(e.createdAt)}</time>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {more && (
            <div className="h-more">
              <button className="btn btn-ghost" disabled={loading} onClick={() => void fetchPage(entries[entries.length - 1]?.createdAt)}>
                <Icon name={loading ? 'i-clock' : 'i-history'} />{loading ? 'Loading…' : 'Load older activity'}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- activity CSV
function activityCsv(list: HistoryEvent[]): Blob {
  // Cells that start with = + - @ could run as formulas in spreadsheet apps.
  const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  const esc = (v: string) => { const x = safe(v); return /[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const lines = ['Date,Time,Person,Task,Change'];
  for (const e of list) lines.push([todayISO(new Date(e.createdAt)), clockTime(e.createdAt), e.actorName, e.taskTitle, e.change].map(esc).join(','));
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

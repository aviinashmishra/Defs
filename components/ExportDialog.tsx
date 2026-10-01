'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from '@/lib/client/bus';
import { isMine } from '@/lib/client/store';
import {
  ALL_PRIORITIES, ALL_STATUSES, buildCsv, COLUMNS, DEFAULT_EXPORT, download, DUE_LABEL, ESSENTIAL_COLUMNS, exportContext, exportFileName,
  GROUP_LABEL, selectTasks, SORT_LABEL, type ColumnKey, type DueFilter, type ExportFormat, type ExportOptions, type GroupBy, type SortBy
} from '@/lib/client/export';
import { PRI_GLYPH, PRI_LABEL } from '@/lib/client/util';
import { STATUS_NAMES, type Priority, type Status } from '@/lib/types';
import { useDayflow, useStore } from './ctx';
import { Icon } from './Icons';
import { Modal } from './Overlays';
import { Select } from './Select';
import './mytasks.css';
import './export.css';

const PREFS_KEY = 'dayflow.export.prefs';
// Remembered between exports on this device: how the file looks, not what it filters.
const REMEMBER: Array<keyof ExportOptions> = ['format', 'columns', 'groupBy', 'sortBy', 'title', 'includeArchived'];

function loadPrefs(): Partial<ExportOptions> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<ExportOptions>;
    const out: Partial<ExportOptions> = {};
    for (const k of REMEMBER) if (k in raw) (out as Record<string, unknown>)[k] = raw[k];
    if (out.columns && !Array.isArray(out.columns)) delete out.columns;
    return out;
  } catch { return {}; }
}
function savePrefs(o: ExportOptions) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(Object.fromEntries(REMEMBER.map((k) => [k, o[k]])))); } catch { /* storage blocked */ }
}

const FORMATS: Array<{ key: ExportFormat; title: string; sub: string; icon: string; ext: string }> = [
  { key: 'xlsx', title: 'Excel workbook', sub: 'Summary dashboard, styled task sheet, filters, frozen header', icon: 'i-grid', ext: 'XLSX' },
  { key: 'pdf', title: 'PDF report', sub: 'Print-ready A4 report with charts, ready to share', icon: 'i-file', ext: 'PDF' },
  { key: 'csv', title: 'CSV data', sub: 'Plain rows for Sheets, BI tools or imports', icon: 'i-text', ext: 'CSV' }
];
const GROUP_ICON: Record<GroupBy, string> = { none: 'i-list', status: 's1', priority: 'i-flag', assignee: 'i-user', team: 'i-users', project: 'i-folder', due: 'i-cal' };
const SORT_ICON: Record<SortBy, string> = { due: 'i-cal', priority: 'i-flag', status: 's1', title: 'i-text', created: 'i-plus', updated: 'i-history' };
const DUE_KEYS: DueFilter[] =['any', 'overdue', 'today', 'week', 'month', 'none', 'custom'];

function Block({ icon, label, action, children }: { icon: string; label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="c-section">
      <div className="c-section-head">
        <span className="c-ico"><Icon name={icon} /></span>
        <span className="c-label">{label}</span>
        {action && <span className="c-hint">{action}</span>}
      </div>
      {children}
    </section>
  );
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function ExportDialog({ preset, onClose }: { preset: Partial<ExportOptions> | null; onClose: () => void }) {
  return (
    <Modal open={preset !== null} onClose={onClose} labelledBy="xpTitle" wide>
      {preset !== null && <ExportForm preset={preset} onClose={onClose} />}
    </Modal>
  );
}

function ExportForm({ preset, onClose }: { preset: Partial<ExportOptions>; onClose: () => void }) {
  const s = useDayflow();
  const store = useStore();
  const [o, setO] = useState<ExportOptions>(() => ({ ...DEFAULT_EXPORT, ...loadPrefs(), ...preset }));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ExportOptions>) => setO((cur) => ({ ...cur, ...patch }));

  const scoped = useMemo(() => {
    const pool = o.includeArchived ? s.tasks.concat(s.archived) : s.tasks;
    return o.scope === 'mine' ? pool.filter((t) => isMine(t, s.me.id)) : pool;
  }, [s.tasks, s.archived, s.me.id, o.scope, o.includeArchived]);
  const mineCount = useMemo(() => s.tasks.filter((t) => isMine(t, s.me.id)).length, [s.tasks, s.me.id]);
  const projects = useMemo(() => [...new Set(scoped.map((t) => t.project).filter(Boolean) as string[])].sort(), [scoped]);
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    scoped.forEach((t) => t.tags.forEach((x) => n.set(x, (n.get(x) || 0) + 1)));
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([t]) => t);
  }, [scoped]);
  const selected = useMemo(() => selectTasks(s, o), [s, o]);
  const byStatus = [0, 1, 2, 3, 4].map((i) => selected.filter((t) => t.status === i).length);
  const fmt = FORMATS.find((f) => f.key === o.format)!;

  const reset = () => setO((cur) => ({ ...DEFAULT_EXPORT, format: cur.format, columns: cur.columns, groupBy: cur.groupBy, sortBy: cur.sortBy, title: cur.title, scope: cur.scope }));

  const run = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    const opts = { ...o, title: o.title.trim() || 'Task report' };
    const ctx = exportContext(store.getState());
    const rows = selectTasks(store.getState(), opts);
    try {
      if (opts.format === 'xlsx') {
        const { buildXlsx } = await import('@/lib/client/export-xlsx');
        download(await buildXlsx(rows, opts, ctx), exportFileName(opts, 'xlsx'));
        toast(`Exported ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'} to Excel`, { icon: 'i-download' });
      } else if (opts.format === 'pdf') {
        const { buildReportHtml, printReport } = await import('@/lib/client/export-pdf');
        printReport(buildReportHtml(rows, opts, ctx, exportFileName(opts, 'pdf').replace(/\.pdf$/, '')));
        toast('Report ready. Choose “Save as PDF” in the print dialog.', { icon: 'i-file', timeout: 7000 });
      } else {
        download(buildCsv(rows, opts, ctx), exportFileName(opts, 'csv'));
        toast(`Exported ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'} to CSV`, { icon: 'i-download' });
      }
      savePrefs(opts);
      onClose();
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`, { icon: 'i-x', timeout: 7000 });
    } finally {
      setBusy(false);
    }
  };

  const others = s.members.filter((m) => m.id !== s.me.id);

  return (
    <div className="composer xp">
      <header className="composer-head">
        <span className="composer-badge xp-badge" aria-hidden="true"><Icon name="i-download" /></span>
        <div>
          <h2 id="xpTitle">Export tasks</h2>
          <p className="muted">Filter what goes in, choose the columns, and download a polished report.</p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="i-x" /></button>
      </header>

      <div className="composer-grid">
        <div className="composer-main">
          <div className="xp-scope" role="radiogroup" aria-label="Whose tasks">
            {([['mine', 'My tasks', `${mineCount} tasks assigned to you`, 'i-user'], ['team', 'Whole organization', `${s.tasks.length} tasks in ${s.org.name}`, 'i-org']] as const).map(([k, t, sub, icon]) => (
              <button key={k} type="button" role="radio" aria-checked={o.scope === k} onClick={() => set({ scope: k, assignees: k === 'mine' ? [] : o.assignees })}>
                <span className="xp-scope-ico"><Icon name={icon} /></span><span><b>{t}</b><small>{sub}</small></span>
              </button>
            ))}
          </div>

          <Block icon="s1" label="Status" action={<button type="button" className="link-btn" onClick={() => set({ statuses: o.statuses.length === 5 ? [] : [...ALL_STATUSES] })}>{o.statuses.length === 5 ? 'Clear' : 'All'}</button>}>
            <div className="xp-chips">
              {STATUS_NAMES.map((n, i) => (
                <button key={n} type="button" className="xp-chip" aria-pressed={o.statuses.includes(i as Status)} style={{ ['--sc' as string]: `var(--st${i})` }}
                  onClick={() => set({ statuses: toggle(o.statuses, i as Status).sort() })}>
                  <Icon name={`s${i}`} />{n}<span className="n">{scoped.filter((t) => t.status === i).length}</span>
                </button>
              ))}
            </div>
          </Block>

          <Block icon="i-flag" label="Priority">
            <div className="xp-chips">
              {ALL_PRIORITIES.map((p: Priority) => (
                <button key={p} type="button" className="xp-chip" data-pri={p} aria-pressed={o.priorities.includes(p)} onClick={() => set({ priorities: toggle(o.priorities, p) })}>
                  <i className="glyph">{PRI_GLYPH[p]}</i>{PRI_LABEL[p]}<span className="n">{scoped.filter((t) => t.priority === p).length}</span>
                </button>
              ))}
            </div>
          </Block>

          <Block icon="i-cal" label="Due date">
            <div className="xp-chips">
              {DUE_KEYS.map((k) => (
                <button key={k} type="button" className="xp-chip" aria-pressed={o.due === k} onClick={() => set({ due: k })}>{DUE_LABEL[k]}</button>
              ))}
            </div>
            {o.due === 'custom' && (
              <div className="xp-range">
                <label>From<input type="date" className="field" value={o.from} onChange={(e) => set({ from: e.target.value })} /></label>
                <span aria-hidden="true">→</span>
                <label>To<input type="date" className="field" value={o.to} min={o.from || undefined} onChange={(e) => set({ to: e.target.value })} /></label>
              </div>
            )}
          </Block>

          {o.scope === 'team' && others.length > 0 && (
            <Block icon="i-users" label="People" action={o.assignees.length ? <button type="button" className="link-btn" onClick={() => set({ assignees: [] })}>Anyone</button> : 'Anyone'}>
              <div className="xp-chips">
                {[...s.members.map((m) => ({ id: m.id, name: m.id === s.me.id ? `${m.name} (you)` : m.name })), { id: 'none', name: 'Unassigned' }].map((m) => (
                  <button key={m.id} type="button" className="xp-chip" aria-pressed={o.assignees.includes(m.id)} onClick={() => set({ assignees: toggle(o.assignees, m.id) })}>
                    {m.name}<span className="n">{scoped.filter((t) => (t.assigneeId ?? 'none') === m.id).length}</span>
                  </button>
                ))}
              </div>
            </Block>
          )}

          {o.scope === 'team' && s.teams.length > 0 && (
            <Block icon="i-org" label="Teams" action={o.teams.length ? <button type="button" className="link-btn" onClick={() => set({ teams: [] })}>Any</button> : 'Any'}>
              <div className="xp-chips">
                {[...s.teams.map((t) => ({ id: t.id, name: t.name, color: t.color })), { id: 'personal', name: 'Personal', color: 'var(--accent)' }, { id: 'none', name: 'No team', color: 'var(--st0)' }].map((t) => (
                  <button key={t.id} type="button" className="xp-chip" aria-pressed={o.teams.includes(t.id)} onClick={() => set({ teams: toggle(o.teams, t.id) })}>
                    <i className="team-dot" style={{ background: t.color, width: 9, height: 9 }} aria-hidden="true" />{t.name}<span className="n">{scoped.filter((x) => (x.private ? 'personal' : x.teamId ?? 'none') === t.id).length}</span>
                  </button>
                ))}
              </div>
            </Block>
          )}

          {projects.length > 0 && (
            <Block icon="i-folder" label="Projects" action={o.projects.length ? <button type="button" className="link-btn" onClick={() => set({ projects: [] })}>Any</button> : 'Any'}>
              <div className="xp-chips">
                {[...projects, ''].map((p) => (
                  <button key={p || '~none'} type="button" className="xp-chip" aria-pressed={o.projects.includes(p)} onClick={() => set({ projects: toggle(o.projects, p) })}>{p || 'No project'}</button>
                ))}
              </div>
            </Block>
          )}

          {tags.length > 0 && (
            <Block icon="i-tag" label="Tags" action={o.tags.length ? <button type="button" className="link-btn" onClick={() => set({ tags: [] })}>Any</button> : 'Any'}>
              <div className="xp-chips">
                {tags.map((t) => (
                  <button key={t} type="button" className="xp-chip tag" aria-pressed={o.tags.includes(t)} onClick={() => set({ tags: toggle(o.tags, t) })}>#{t}</button>
                ))}
              </div>
            </Block>
          )}

          <Block icon="i-search" label="Keyword">
            <input className="field" placeholder="Only tasks mentioning… (title, description, remarks, links)" value={o.query} onChange={(e) => set({ query: e.target.value })} aria-label="Keyword" />
          </Block>

          <label className="toggle-row xp-toggle">
            <span><b>Include cleared done tasks</b><span>Done tasks you cleared from the board in the last 70 days</span></span>
            <span className="switch"><input type="checkbox" checked={o.includeArchived} onChange={(e) => set({ includeArchived: e.target.checked })} /><i /></span>
          </label>
        </div>

        <aside className="composer-side xp-side">
          <div>
            <span className="field-label">Format</span>
            <div className="xp-formats" role="radiogroup" aria-label="Format">
              {FORMATS.map((f) => (
                <button key={f.key} type="button" role="radio" aria-checked={o.format === f.key} className={`xp-format f-${f.key}`} onClick={() => set({ format: f.key })}>
                  <span className="xp-fico"><Icon name={f.icon} /><i>{f.ext}</i></span>
                  <span><b>{f.title}</b><small>{f.sub}</small></span>
                </button>
              ))}
            </div>
          </div>

          {o.format !== 'csv' && (
            <div>
              <label className="field-label" htmlFor="xpName">Report title</label>
              <input id="xpName" className="field" maxLength={80} value={o.title} onChange={(e) => set({ title: e.target.value })} />
            </div>
          )}

          <div className="two">
            <div>
              <label className="field-label" htmlFor="xpGroup">Group by</label>
              <Select id="xpGroup" label="Group by" value={o.groupBy} disabled={o.format === 'csv'} onChange={(v) => set({ groupBy: v })}
                options={(Object.keys(GROUP_LABEL) as GroupBy[]).map((k) => ({ value: k, label: GROUP_LABEL[k], icon: GROUP_ICON[k] }))} />
            </div>
            <div>
              <label className="field-label" htmlFor="xpSort">Sort by</label>
              <Select id="xpSort" label="Sort by" value={o.sortBy} onChange={(v) => set({ sortBy: v })}
                options={(Object.keys(SORT_LABEL) as SortBy[]).map((k) => ({ value: k, label: SORT_LABEL[k], icon: SORT_ICON[k] }))} />
            </div>
          </div>
          {o.format === 'xlsx' && (
            <p className="xp-note"><Icon name="i-sparkle" />{o.groupBy === 'none' ? 'Excel filter buttons are on every column header.' : 'Groups can be collapsed in Excel. Pick “No grouping” to get column filter buttons instead.'}</p>
          )}

          <div>
            <div className="xp-cols-head">
              <span className="field-label">Columns · {o.columns.filter((c) => c !== 'title').length + 1}</span>
              <span>
                <button type="button" className="link-btn" onClick={() => set({ columns: [...ESSENTIAL_COLUMNS] })}>Essential</button>
                <button type="button" className="link-btn" onClick={() => set({ columns: COLUMNS.map((c) => c.key) })}>Everything</button>
              </span>
            </div>
            <div className="xp-cols">
              {COLUMNS.map((c) => {
                const on = c.key === 'title' || o.columns.includes(c.key);
                return (
                  <label key={c.key} className={`xp-col${on ? ' on' : ''}${c.key === 'title' ? ' locked' : ''}`}>
                    <input type="checkbox" checked={on} disabled={c.key === 'title'} onChange={() => set({ columns: toggle(o.columns, c.key as ColumnKey) })} />
                    <span className="box"><Icon name="i-check" /></span>{c.label}
                  </label>
                );
              })}
            </div>
          </div>

          <div className={`xp-preview${selected.length ? '' : ' empty'}`} aria-live="polite">
            <div className="xp-preview-top">
              <b>{selected.length}</b>
              <span>{selected.length === 1 ? 'task' : 'tasks'} will be exported</span>
            </div>
            <div className="xp-stack" aria-hidden="true">
              {byStatus.map((n, i) => (n ? <i key={i} style={{ flex: n, background: `var(--st${i})` }} /> : null))}
            </div>
            <div className="xp-legend">
              {byStatus.map((n, i) => (n ? <span key={i}><i style={{ background: `var(--st${i})` }} />{STATUS_NAMES[i]} {n}</span> : null))}
            </div>
            {selected.length > 0 ? (
              <ul className="xp-sample">
                {selected.slice(0, 4).map((t) => <li key={t.id}><Icon name={`s${t.status}`} style={{ color: `var(--st${t.status})` }} /><span>{t.title}</span></li>)}
                {selected.length > 4 && <li className="more">+ {selected.length - 4} more</li>}
              </ul>
            ) : <p className="muted">No tasks match. Loosen a filter to export.</p>}
          </div>
        </aside>
      </div>

      <footer className="composer-foot">
        <button type="button" className="link-btn" onClick={reset}><Icon name="i-undo" /> Reset filters</button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" id="xpRun" className="btn btn-3d btn-primary" disabled={!selected.length || busy} onClick={() => void run()}>
          <Icon name={busy ? 'i-clock' : 'i-download'} />{busy ? 'Preparing…' : o.format === 'pdf' ? 'Create PDF report' : `Download ${fmt.ext}`}
        </button>
      </footer>
    </div>
  );
}

'use client';
import { useMemo, useRef, useState } from 'react';
import { isMine } from '@/lib/client/store';
import { ageLabel, clock, daysSince, DUE_BUCKETS, dueBucket, dueInfo, fmtDuration, PRI_GLYPH, PRI_LABEL, startOfToday, todayISO } from '@/lib/client/util';
import { STATUS_NAMES, type Member, type OrgTeam, type Status, type Task } from '@/lib/types';
import { useDayflow, useStore, useUI } from './ctx';
import { useNow } from './hooks';
import { Icon } from './Icons';
import { Avatar } from './TaskCard';
import { Select } from './Select';

type Tab = 'open' | 'progress' | 'blocked' | 'review' | 'done';
type Sort = 'due' | 'priority' | 'recent';

const TABS: Array<{ key: Tab; label: string; test: (t: Task) => boolean }> = [
  { key: 'open', label: 'Open', test: (t) => t.status !== 4 },
  { key: 'progress', label: 'In progress', test: (t) => t.status === 1 },
  { key: 'blocked', label: 'Blocked', test: (t) => t.status === 2 },
  { key: 'review', label: 'Review', test: (t) => t.status === 3 },
  { key: 'done', label: 'Done', test: (t) => t.status === 4 }
];
const PRI_RANK = { high: 0, medium: 1, low: 2 } as const;
// The export dialog opens with the statuses of the tab you are looking at.
const TAB_STATUSES: Record<Tab, Status[]> = { open: [0, 1, 2, 3], progress: [1], blocked: [2], review: [3], done: [4] };

function startOfWeek(): number {
  const d = new Date(startOfToday());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  return d.getTime();
}


export function MyTasks() {
  const s = useDayflow();
  const ui = useUI();
  const [tab, setTab] = useState<Tab>('open');
  const [sort, setSort] = useState<Sort>('due');
  const [q, setQ] = useState('');

  const mine = useMemo(() => s.tasks.filter((t) => isMine(t, s.me.id)), [s.tasks, s.me.id]);
  const today = todayISO();
  const open = mine.filter((t) => t.status !== 4);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today).length;
  const dueToday = open.filter((t) => t.dueDate === today).length;
  const blocked = open.filter((t) => t.status === 2);
  const oldestBlock = blocked.reduce((a, t) => Math.max(a, daysSince(t.blockedAt)), 0);
  const week = startOfWeek();
  const doneWeek = mine.concat(s.archived.filter((t) => isMine(t, s.me.id))).filter((t) => t.status === 4 && t.doneAt && t.doneAt >= week).length;

  const shown = useMemo(() => {
    const test = TABS.find((x) => x.key === tab)!.test;
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = mine.filter((t) => test(t) && tokens.every((tok) =>
      [t.title, t.description, t.remarks, t.project, t.tags.join(' '), t.links.map((l) => l.label + ' ' + l.url).join(' ')].join(' ').toLowerCase().includes(tok.replace(/^#/, ''))));
    const byDue = (a: Task, b: Task) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || PRI_RANK[a.priority] - PRI_RANK[b.priority];
    if (tab === 'done') return list.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    if (sort === 'priority') return list.sort((a, b) => PRI_RANK[a.priority] - PRI_RANK[b.priority] || byDue(a, b));
    if (sort === 'recent') return list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list.sort(byDue);
  }, [mine, tab, sort, q]);

  const groups = useMemo(() => {
    if (sort !== 'due' || tab === 'done') return [{ label: '', items: shown }];
    return DUE_BUCKETS.map((label) => ({ label, items: shown.filter((t) => dueBucket(t.dueDate) === label) })).filter((g) => g.items.length);
  }, [shown, sort, tab]);

  const summary = !mine.length
    ? 'Nothing here yet. Add your first task with every detail your team needs.'
    : !open.length
      ? 'Everything is done. Nice work.'
      : [`${open.length} open`, dueToday && `${dueToday} due today`, overdue && `${overdue} overdue`, blocked.length && `${blocked.length} blocked`].filter(Boolean).join(' · ');

  return (
    <section className="view view-mine" aria-labelledby="mineTitle">
      <header className="mine-hero">
        <div>
          <p className="eyebrow">Your workspace · {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1 className="greet" id="mineTitle">My <span className="grad">tasks</span></h1>
          <p className="mine-sub">{summary}</p>
        </div>
        <div className="mine-actions">
          <button className="btn btn-ghost" onClick={ui.copyStandup}><Icon name="i-copy" /><span>Copy standup</span></button>
          <button className="btn btn-ghost" title="Export to Excel, PDF or CSV (E)"
            onClick={() => ui.openExport({ scope: 'mine', statuses: TAB_STATUSES[tab], query: q, due: 'any', priorities: ['high', 'medium', 'low'], assignees: [], projects: [], tags: [] })}>
            <Icon name="i-download" /><span>Export</span>
          </button>
          <button className="btn btn-3d btn-primary btn-lg" onClick={() => ui.openComposer()}><Icon name="i-plus" /><span>New task</span></button>
        </div>
      </header>

      <div className="mine-stats">
        <StatTile icon="s1" tone="var(--st1)" label="Open" value={open.length} sub={`${open.filter((t) => t.status === 1).length} in progress`} onClick={() => setTab('open')} />
        <StatTile icon="i-cal" tone="var(--pri-medium)" label="Due today" value={dueToday} sub={overdue ? `${overdue} overdue` : 'Nothing overdue'} warn={overdue > 0} onClick={() => { setTab('open'); setSort('due'); }} />
        <StatTile icon="s2" tone="var(--st2)" label="Blocked" value={blocked.length} sub={blocked.length ? `Oldest ${ageLabel(oldestBlock)}` : 'All clear'} warn={oldestBlock >= 2} onClick={() => setTab('blocked')} />
        <StatTile icon="s4" tone="var(--st4)" label="Done this week" value={doneWeek} sub={doneWeek ? 'Keep it going' : 'Finish one to start'} onClick={() => setTab('done')} />
      </div>

      <div className="mine-toolbar">
        <div className="mine-tabs" role="tablist" aria-label="Filter by status">
          {TABS.map((x) => {
            const n = mine.filter(x.test).length;
            return (
              <button key={x.key} role="tab" aria-selected={tab === x.key} onClick={() => setTab(x.key)}>
                {x.label}<span className="n">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="mine-tools">
          <div className="search glass">
            <Icon name="i-search" />
            <label htmlFor="mineSearch" className="sr-only">Search my tasks</label>
            <input id="mineSearch" type="search" placeholder="Search title, notes, links…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {tab !== 'done' && (
            <>
              <Select id="mineSort" label="Sort" variant="pill" className="sort-select" value={sort} onChange={setSort} align="end" options={[
                { value: 'due', label: 'By due date', hint: 'Grouped: overdue, today, this week…', icon: 'i-cal' },
                { value: 'priority', label: 'By priority', hint: 'High first', icon: 'i-flag' },
                { value: 'recent', label: 'Recently updated', hint: 'Latest changes first', icon: 'i-history' }
              ]} />
            </>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="mine-empty glass">
          <span className="empty-art" aria-hidden="true"><Icon name={q ? 'i-search' : tab === 'done' ? 's4' : 'i-list'} /></span>
          <h3>{q ? 'No matches' : tab === 'open' ? 'No open tasks' : `Nothing ${tab === 'done' ? 'done yet' : `in ${TABS.find((x) => x.key === tab)!.label.toLowerCase()}`}`}</h3>
          <p className="muted">{q ? 'Try a different word, or clear the search.' : 'Add a task with a description, remarks, links and files, all in one place.'}</p>
          {!q && <button className="btn btn-3d btn-primary" onClick={() => ui.openComposer()}><Icon name="i-plus" />New task</button>}
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.label || 'all'} className="mine-group" aria-label={g.label || 'Tasks'}>
            {g.label && <h2 className={`group-head${g.label === 'Overdue' ? ' warn' : ''}`}>{g.label}<span>{g.items.length}</span></h2>}
            <ul className="mine-list">
              {g.items.map((t) => <MineRow key={t.id} t={t} members={s.members} meId={s.me.id} timer={s.me.timer} team={s.teams.find((x) => x.id === t.teamId)} priv={s.org.kind === 'team' && t.private} />)}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}

function StatTile({ icon, tone, label, value, sub, warn, onClick }: { icon: string; tone: string; label: string; value: number; sub: string; warn?: boolean; onClick: () => void }) {
  return (
    <button className="m-stat glass" style={{ ['--tone' as string]: tone }} onClick={onClick}>
      <span className="m-stat-ico"><Icon name={icon} /></span>
      <span className="m-stat-label">{label}</span>
      <b className="m-stat-val">{value}</b>
      <span className={`m-stat-sub${warn ? ' warn' : ''}`}>{sub}</span>
    </button>
  );
}

function MineRow({ t, members, meId, timer, team, priv }: { t: Task; members: Member[]; meId: string; timer: { taskId: string; startedAt: number } | null; team?: OrgTeam; priv?: boolean }) {
  const ui = useUI();
  const store = useStore();
  const row = useRef<HTMLLIElement>(null);
  const timerOn = timer?.taskId === t.id;
  const now = useNow(1000, timerOn);
  const done = t.status === 4;
  const due = done ? null : dueInfo(t);
  const from = t.creatorId && t.creatorId !== meId ? members.find((m) => m.id === t.creatorId)?.name : null;
  const firstLine = t.description?.split('\n').find((l) => l.trim()) || '';
  // Phones keep rows compact: the focus button shows only while it runs (it is also in the detail sheet).
  const showTimer = !done && (!ui.phone || timerOn);

  return (
    <li ref={row} className={`mine-row s-${t.status} pri-${t.priority}${timerOn ? ' timing' : ''}`} style={{ ['--sc' as string]: `var(--st${t.status})` }}>
      <button className="check" aria-label={done ? `Reopen “${t.title}”` : `Mark “${t.title}” done`} aria-pressed={done}
        onClick={() => ui.changeStatus(t.id, (done ? 1 : 4) as Status, { el: row.current, toast: true })}>
        <Icon name="i-check" />
      </button>
      <button className="row-main" onClick={() => ui.openDetail(t.id)} aria-label={`Open “${t.title}”`}>
        <span className="row-title">{t.title}</span>
        {firstLine && <span className="row-desc">{firstLine}</span>}
        {t.status === 2 && t.blockedReason && <span className="row-block"><Icon name="s2" />{t.blockedReason}</span>}
        <span className="row-meta">
          <span className="st-pill"><Icon name={`s${t.status}`} />{STATUS_NAMES[t.status]}</span>
          <span className="pri"><i aria-hidden="true">{PRI_GLYPH[t.priority]}</i>{PRI_LABEL[t.priority]}</span>
          {due && <span className={`due ${due.cls}`}><Icon name="i-cal" />{due.label}</span>}
          {priv && <span className="team-chip private-chip" title="Private: only you can see this"><Icon name="i-lock" />Private</span>}
          {team && <span className="team-chip"><i className="team-dot" style={{ background: team.color }} aria-hidden="true" />{team.name}</span>}
          {t.project && <span className="mini"><Icon name="i-folder" />{t.project}</span>}
          {t.tags.slice(0, 3).map((x) => <span key={x} className="tagc">#{x}</span>)}
          <span className="row-counts">
            {t.remarks && <span title="Has remarks"><Icon name="i-note" /></span>}
            {t.links.length > 0 && <span title={`${t.links.length} links`}><Icon name="i-link" />{t.links.length}</span>}
            {t.attachmentCount > 0 && <span title={`${t.attachmentCount} files`}><Icon name="i-clip" />{t.attachmentCount}</span>}
            {t.commentCount > 0 && <span title={`${t.commentCount} comments`}><Icon name="i-comment" />{t.commentCount}</span>}
          </span>
        </span>
      </button>
      {(from || showTimer) && <div className="row-side">
        {from && <span className="from" title={`Added by ${from}`}><Avatar name={from} cls="xs" /><span>from {from.split(' ')[0]}</span></span>}
        {showTimer && (
          <button className={`timer-btn${timerOn ? ' on' : ''}`} onClick={() => store.toggleTimer(t.id)} aria-label={`${timerOn ? 'Pause' : 'Start'} focus timer`}>
            <Icon name={timerOn ? 'i-pause' : 'i-play'} />
            <span className="tt">{timerOn && timer ? clock((now - timer.startedAt) / 1000) : t.timeSpent >= 60 ? fmtDuration(t.timeSpent) : 'Focus'}</span>
          </button>
        )}
      </div>}
    </li>
  );
}

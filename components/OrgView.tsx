'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import { toast } from '@/lib/client/bus';
import { canManageTeam, deactivateError, isOrgAdmin, isOwner, roleChangeError } from '@/lib/access';
import { copyText, daysSince, fmtDay, relTime, startOfToday } from '@/lib/client/util';
import { STATUS_NAMES, type AuditEntry, type Member, type OrgRole, type OrgTeam, type Task, type TeamRole } from '@/lib/types';
import { useDayflow, useStore, useUI, type OrgTab } from './ctx';
import { Icon } from './Icons';
import { Avatar } from './TaskCard';
import { Insights } from './Insights';
import { Select } from './Select';
import { memberOptions, NO_TEAM_OPTION, teamOptions } from './pickers';
import './org.css';

export const TEAM_COLORS = ['#4f6cff', '#2a78d6', '#128a5f', '#0b7a0b', '#a86e00', '#d9541f', '#c93a3a', '#c23d72', '#5a49c4', '#6b7391'];
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including managing admins',
  admin: 'People, roles, teams, invites and the audit log',
  member: 'Adds and updates tasks'
};

/** Runs an async action with a busy flag and a toast for the outcome. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, { icon: 'i-check' });
      return true;
    } catch (e) {
      toast((e as Error).message, { icon: 'i-x', timeout: 7000 });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

export function TeamDot({ team, size = 10 }: { team: Pick<OrgTeam, 'color'> | undefined; size?: number }) {
  return <i className="team-dot" style={{ background: team?.color ?? 'var(--st0)', width: size, height: size }} aria-hidden="true" />;
}

/** A personal space has no organization to manage: just your insights and a way to bring people in. */
function PersonalSpace() {
  const s = useDayflow();
  const ui = useUI();
  const week = startOfToday() - 6 * 86400000;
  const open = s.tasks.filter((t) => t.status !== 4).length;
  const doneWeek = s.tasks.concat(s.archived).filter((t) => t.status === 4 && t.doneAt && t.doneAt >= week).length;
  return (
    <section className="view view-org" aria-labelledby="orgTitle">
      <header className="org-hero">
        <div>
          <p className="eyebrow">Personal space · only you can see it</p>
          <OrgName />
          <p className="org-sub">{open} open · {doneWeek} done in the last 7 days</p>
        </div>
      </header>
      <article className="teamup-cta glass">
        <div className="teamup-cta-art" aria-hidden="true"><span /><span /><span /><Icon name="i-users" /></div>
        <div className="teamup-cta-body">
          <h2>Bring people in</h2>
          <p className="muted">Create a team, choose which tasks it sees, and send one link. Everything else stays private to you.</p>
          <ol className="teamup-steps">
            <li><b>1</b>Name the team</li>
            <li><b>2</b>Pick tasks to share</li>
            <li><b>3</b>Send the invite link</li>
          </ol>
        </div>
        <button className="btn btn-3d btn-primary" onClick={ui.openTeamUp}><Icon name="i-users" /><span>Create a team</span></button>
      </article>
      <div className="scope-head"><h2>Pulse · your space</h2></div>
      <Insights teamId="all" label="Your space" embedded />
    </section>
  );
}

export function OrgView() {
  const s = useDayflow();
  if (s.org.kind === 'personal') return <PersonalSpace />;
  return <TeamOrgView />;
}

function TeamOrgView() {
  const s = useDayflow();
  const ui = useUI();
  const admin = isOrgAdmin(s.me);
  const tabs: Array<[OrgTab, string, string]> = [
    ['overview', 'Overview', 'i-chart'],
    ['teams', 'Teams', 'i-users'],
    ['people', 'People', 'i-user'],
    ...(admin ? [['audit', 'Audit log', 'i-history'] as [OrgTab, string, string]] : [])
  ];
  const tab = tabs.some(([k]) => k === ui.orgTab) ? ui.orgTab : 'overview';
  const active = s.members.filter((m) => m.active);

  return (
    <section className="view view-org" aria-labelledby="orgTitle">
      <header className="org-hero">
        <div>
          <p className="eyebrow">Organization · {s.me.role === 'owner' ? 'you are the owner' : admin ? 'you are an admin' : 'member'}</p>
          <OrgName />
          <p className="org-sub">{active.length} {active.length === 1 ? 'person' : 'people'} · {s.teams.length} {s.teams.length === 1 ? 'team' : 'teams'} · {s.tasks.filter((t) => t.status !== 4).length} open tasks</p>
        </div>
        {admin && s.org.inviteCode && <InviteButton code={s.org.inviteCode} />}
      </header>

      <nav className="org-tabs" role="tablist" aria-label="Organization sections">
        {tabs.map(([k, label, icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => ui.openOrg(k)}><Icon name={icon} /><span>{label}</span></button>
        ))}
      </nav>

      {tab === 'overview' && <Overview />}
      {tab === 'teams' && <TeamsTab />}
      {tab === 'people' && <PeopleTab />}
      {tab === 'audit' && admin && <AuditTab />}
    </section>
  );
}

function OrgName() {
  const s = useDayflow();
  const store = useStore();
  const { run } = useAction();
  const [edit, setEdit] = useState(false);
  if (!isOrgAdmin(s.me)) return <h1 className="greet" id="orgTitle">{s.org.name}</h1>;
  return edit ? (
    <form className="org-name-form" onSubmit={(e) => {
      e.preventDefault();
      const v = String(new FormData(e.currentTarget).get('name') || '').trim();
      if (!v || v === s.org.name) { setEdit(false); return; }
      void run(() => store.renameOrg(v), 'Organization renamed').then((ok) => ok && setEdit(false));
    }}>
      <label className="sr-only" htmlFor="orgName">Organization name</label>
      <input id="orgName" name="name" className="field title-field" defaultValue={s.org.name} maxLength={80} autoFocus />
      <button className="btn btn-3d btn-primary">Save</button>
      <button type="button" className="btn btn-ghost" onClick={() => setEdit(false)}>Cancel</button>
    </form>
  ) : (
    <h1 className="greet" id="orgTitle">
      {s.org.name}
      <button className="icon-btn inline-edit" aria-label="Rename organization" onClick={() => setEdit(true)}><Icon name="i-edit" /></button>
    </h1>
  );
}

function InviteButton({ code }: { code: string }) {
  const link = typeof window !== 'undefined' ? `${location.origin}/signup?invite=${code}` : '';
  return (
    <button className="btn btn-3d btn-primary" onClick={async () => toast((await copyText(link)) ? 'Invite link copied. Anyone with it can join.' : link, { icon: 'i-user-plus' })}>
      <Icon name="i-user-plus" /><span>Copy invite link</span>
    </button>
  );
}

// ---------------------------------------------------------------- overview (company dashboard)
interface TeamStats { open: number; blocked: number; stale: number; review: number; doneWeek: number; byStatus: number[] }

function statsFor(tasks: Task[], archived: Task[], test: (t: Task) => boolean): TeamStats {
  const week = startOfToday() - 6 * 86400000;
  const mine = tasks.filter(test);
  const byStatus = [0, 1, 2, 3, 4].map((st) => mine.filter((t) => t.status === st).length);
  return {
    open: mine.filter((t) => t.status !== 4).length,
    blocked: byStatus[2],
    stale: mine.filter((t) => t.status === 2 && daysSince(t.blockedAt) >= 2).length,
    review: byStatus[3],
    doneWeek: mine.concat(archived.filter(test)).filter((t) => t.status === 4 && t.doneAt && t.doneAt >= week).length,
    byStatus
  };
}

function Overview() {
  const s = useDayflow();
  const ui = useUI();
  const [scope, setScope] = useState<string>('all');
  const noTeam = (t: Task) => !t.teamId && !t.private;
  const cards = useMemo(() => s.teams.map((team) => ({
    team,
    stats: statsFor(s.tasks, s.archived, (t) => t.teamId === team.id),
    members: s.members.filter((m) => m.active && m.teams.some((x) => x.teamId === team.id)),
    leads: s.members.filter((m) => m.active && m.teams.some((x) => x.teamId === team.id && x.role === 'lead'))
  })), [s.teams, s.tasks, s.archived, s.members]);
  const loose = statsFor(s.tasks, s.archived, noTeam);
  const scopeName = scope === 'all' ? s.org.name : scope === 'none' ? 'Tasks without a team' : s.teams.find((t) => t.id === scope)?.name ?? s.org.name;

  return (
    <>
      <div className="team-grid">
        {cards.map(({ team, stats, members, leads }) => (
          <article key={team.id} className="team-card glass" style={{ ['--tc' as string]: team.color }}>
            <header>
              <TeamDot team={team} size={12} />
              <h2>{team.name}</h2>
              <span className="muted">{members.length} {members.length === 1 ? 'person' : 'people'}</span>
            </header>
            {team.description && <p className="team-desc">{team.description}</p>}
            <StatusBar counts={stats.byStatus} label={team.name} />
            <dl className="team-stats">
              <div><dt>Open</dt><dd>{stats.open}</dd></div>
              <div className={stats.stale ? 'warn' : ''}><dt>Blocked</dt><dd>{stats.blocked}{stats.stale ? <small> · {stats.stale} stale</small> : null}</dd></div>
              <div><dt>In review</dt><dd>{stats.review}</dd></div>
              <div><dt>Done · 7d</dt><dd>{stats.doneWeek}</dd></div>
            </dl>
            <footer>
              <span className="avatars" aria-label={`Leads: ${leads.map((l) => l.name).join(', ') || 'none'}`}>
                {leads.slice(0, 3).map((l) => <Avatar key={l.id} name={l.name} cls="xs" />)}
                <span className="muted">{leads.length ? `Lead${leads.length > 1 ? 's' : ''}: ${leads.map((l) => l.name.split(' ')[0]).join(', ')}` : 'No lead yet'}</span>
              </span>
              <button className="link-btn" onClick={() => { ui.setBoardTeam(team.id); ui.setView('board'); }}>Open board →</button>
            </footer>
          </article>
        ))}
        {loose.open + loose.doneWeek > 0 && (
          <article className="team-card glass is-loose">
            <header><TeamDot team={undefined} size={12} /><h2>No team</h2></header>
            <p className="team-desc">Tasks not filed under a team yet.</p>
            <StatusBar counts={loose.byStatus} label="No team" />
            <dl className="team-stats">
              <div><dt>Open</dt><dd>{loose.open}</dd></div>
              <div><dt>Blocked</dt><dd>{loose.blocked}</dd></div>
              <div><dt>In review</dt><dd>{loose.review}</dd></div>
              <div><dt>Done · 7d</dt><dd>{loose.doneWeek}</dd></div>
            </dl>
            <footer><span /><button className="link-btn" onClick={() => { ui.setBoardTeam('none'); ui.setView('board'); }}>Open board →</button></footer>
          </article>
        )}
      </div>

      <div className="scope-head">
        <h2>Pulse · {scopeName}</h2>
        <label className="sr-only" htmlFor="pulseScope">Show</label>
        <Select id="pulseScope" label="Show" variant="pill" value={scope} onChange={setScope} align="end" options={[
          { value: 'all', label: 'Whole organization', icon: 'i-org', color: 'var(--accent)' },
          ...teamOptions(s.teams),
          { ...NO_TEAM_OPTION, value: 'none' }
        ]} />
      </div>
      <Insights teamId={scope} label={scopeName} embedded />
    </>
  );
}

function StatusBar({ counts, label }: { counts: number[]; label: string }) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return <div className="team-bar empty" aria-label={`${label}: no tasks`}><span>No tasks yet</span></div>;
  return (
    <div className="team-bar" role="img" aria-label={`${label}: ${counts.map((n, i) => `${n} ${STATUS_NAMES[i]}`).join(', ')}`}>
      {counts.map((n, i) => n ? <i key={i} style={{ flexGrow: n, background: `var(--st${i})` }} data-tip={`${label}|${STATUS_NAMES[i]}: ${n}`} /> : null)}
    </div>
  );
}

// ---------------------------------------------------------------- teams
function TeamsTab() {
  const s = useDayflow();
  const admin = isOrgAdmin(s.me);
  return (
    <div className="teams-manage">
      {admin && <NewTeam />}
      {s.teams.length === 0 && <p className="muted empty-note">No teams yet.{admin ? ' Create the first one above.' : ''}</p>}
      {s.teams.map((t) => <TeamManage key={t.id} team={t} />)}
    </div>
  );
}

function ColorPick({ value, onChange, name }: { value: string; onChange: (c: string) => void; name: string }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={`${name} color`}>
      {TEAM_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className="swatch" style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

function NewTeam() {
  const store = useStore();
  const { busy, run } = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(TEAM_COLORS[1]);
  return (
    <form className="panel glass new-team" onSubmit={(e) => {
      e.preventDefault();
      if (!name.trim()) return;
      void run(() => store.createTeam({ name: name.trim(), description: description.trim() || null, color }), `Created the ${name.trim()} team`)
        .then((ok) => { if (ok) { setName(''); setDescription(''); } });
    }}>
      <h2>New team</h2>
      <div className="new-team-row">
        <div className="grow">
          <label className="field-label" htmlFor="ntName">Name</label>
          <input id="ntName" className="field" maxLength={60} placeholder="e.g. Design" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="grow">
          <label className="field-label" htmlFor="ntDesc">Description</label>
          <input id="ntDesc" className="field" maxLength={300} placeholder="What this team works on" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <div className="new-team-row">
        <div><span className="field-label">Color</span><ColorPick value={color} onChange={setColor} name="New team" /></div>
        <button className="btn btn-3d btn-primary" disabled={busy || !name.trim()}><Icon name="i-plus" />Create team</button>
      </div>
    </form>
  );
}

function TeamManage({ team }: { team: OrgTeam }) {
  const s = useDayflow();
  const store = useStore();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState('');
  const can = canManageTeam(s.me, team.id);
  const admin = isOrgAdmin(s.me);
  const roster = s.members.filter((m) => m.active && m.teams.some((x) => x.teamId === team.id))
    .sort((a, b) => Number(isLead(b, team.id)) - Number(isLead(a, team.id)) || a.name.localeCompare(b.name));
  const addable = s.members.filter((m) => m.active && !m.teams.some((x) => x.teamId === team.id));
  const openTasks = s.tasks.filter((t) => t.teamId === team.id && t.status !== 4).length;

  return (
    <article className="panel glass team-manage" style={{ ['--tc' as string]: team.color }}>
      {editing ? (
        <TeamEdit team={team} onDone={() => setEditing(false)} />
      ) : (
        <header className="panel-head">
          <div className="tm-title">
            <TeamDot team={team} size={14} />
            <div><h2>{team.name}</h2><p className="muted">{team.description || 'No description'} · {openTasks} open tasks</p></div>
          </div>
          {can && (
            <div className="row-gap">
              <button className="btn btn-ghost" onClick={() => setEditing(true)}><Icon name="i-edit" />Edit</button>
              {admin && (
                <button className="icon-btn danger" aria-label={`Delete the ${team.name} team`} disabled={busy}
                  onClick={() => { if (confirm(`Delete the ${team.name} team? Its ${openTasks} open tasks stay on the board without a team.`)) void run(() => store.deleteTeam(team.id), `Deleted ${team.name}`); }}>
                  <Icon name="i-trash" />
                </button>
              )}
            </div>
          )}
        </header>
      )}

      <ul className="roster">
        {roster.map((m) => {
          const lead = isLead(m, team.id);
          const self = m.id === s.me.id;
          return (
            <li key={m.id}>
              <Avatar name={m.name} />
              <div className="m-name">{m.name}{self ? ' (you)' : ''}<small>{m.title || m.email}</small></div>
              {can ? (
                <Select<TeamRole> variant="sm" label={`${m.name}'s role in ${team.name}`} value={lead ? 'lead' : 'member'} disabled={busy} align="end"
                  options={[
                    { value: 'member', label: 'Member', hint: 'Works on the team’s tasks', icon: 'i-user' },
                    { value: 'lead', label: 'Lead', hint: 'Manages members and tasks', icon: 'i-flag' }
                  ]}
                  onChange={(r) => void run(() => store.setTeamMember(team.id, m.id, r), `${m.name} is now ${r === 'lead' ? 'a lead' : 'a member'} of ${team.name}`)} />
              ) : <span className={`role-badge${lead ? ' lead' : ''}`}>{lead ? 'Lead' : 'Member'}</span>}
              {(can || self) && (
                <button className="icon-btn" aria-label={self ? `Leave ${team.name}` : `Remove ${m.name} from ${team.name}`} title={self ? 'Leave team' : 'Remove from team'} disabled={busy}
                  onClick={() => { if (confirm(self ? `Leave ${team.name}?` : `Remove ${m.name} from ${team.name}?`)) void run(() => store.removeTeamMember(team.id, m.id), self ? `You left ${team.name}` : `Removed ${m.name}`); }}>
                  <Icon name={self ? 'i-logout' : 'i-x'} />
                </button>
              )}
            </li>
          );
        })}
        {!roster.length && <li className="muted">Nobody in this team yet.</li>}
      </ul>

      {can && addable.length > 0 && (
        <form className="add-member" onSubmit={(e) => {
          e.preventDefault();
          const who = s.members.find((m) => m.id === adding);
          if (!who) return;
          void run(() => store.setTeamMember(team.id, who.id, 'member'), `Added ${who.name} to ${team.name}`).then((ok) => ok && setAdding(''));
        }}>
          <label className="sr-only" htmlFor={`add-${team.id}`}>Add someone to {team.name}</label>
          <Select id={`add-${team.id}`} label={`Add someone to ${team.name}`} value={adding} onChange={setAdding} placeholder="Add someone…"
            options={memberOptions(addable, s.me.id)} />
          <button className="btn btn-ghost" disabled={!adding || busy}><Icon name="i-user-plus" />Add</button>
        </form>
      )}
    </article>
  );
}

const isLead = (m: Member, teamId: string) => m.teams.some((x) => x.teamId === teamId && x.role === 'lead');

function TeamEdit({ team, onDone }: { team: OrgTeam; onDone: () => void }) {
  const store = useStore();
  const { busy, run } = useAction();
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description || '');
  const [color, setColor] = useState(team.color);
  return (
    <form className="team-edit" onSubmit={(e) => {
      e.preventDefault();
      void run(() => store.updateTeam(team.id, { name: name.trim(), description: description.trim() || null, color }), 'Team saved').then((ok) => ok && onDone());
    }}>
      <div className="new-team-row">
        <div className="grow"><label className="field-label" htmlFor={`en-${team.id}`}>Name</label><input id={`en-${team.id}`} className="field" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} required /></div>
        <div className="grow"><label className="field-label" htmlFor={`ed-${team.id}`}>Description</label><input id={`ed-${team.id}`} className="field" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </div>
      <div className="new-team-row">
        <div><span className="field-label">Color</span><ColorPick value={color} onChange={setColor} name={team.name} /></div>
        <div className="row-gap">
          <button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button>
          <button className="btn btn-3d btn-primary" disabled={busy || !name.trim()}>Save</button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- people
function PeopleTab() {
  const s = useDayflow();
  const store = useStore();
  const { busy, run } = useAction();
  const admin = isOrgAdmin(s.me);
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'active' | 'inactive'>('active');
  const teamOf = (id: string) => s.teams.find((t) => t.id === id);
  const load = useMemo(() => {
    const m = new Map<string, { open: number; blocked: number }>();
    for (const t of s.tasks) {
      if (!t.assigneeId || t.status === 4) continue;
      const cur = m.get(t.assigneeId) || { open: 0, blocked: 0 };
      cur.open++;
      if (t.status === 2) cur.blocked++;
      m.set(t.assigneeId, cur);
    }
    return m;
  }, [s.tasks]);
  const inactive = s.members.filter((m) => !m.active).length;
  const list = s.members.filter((m) => (show === 'active' ? m.active : !m.active))
    .filter((m) => !q.trim() || [m.name, m.email, m.title, ...m.teams.map((x) => teamOf(x.teamId)?.name)].join(' ').toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      {admin && s.org.inviteCode && <InvitePanel code={s.org.inviteCode} />}
      <div className="people-tools">
        <div className="search glass">
          <Icon name="i-search" />
          <label htmlFor="peopleSearch" className="sr-only">Search people</label>
          <input id="peopleSearch" type="search" placeholder="Search by name, email, title or team" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {inactive > 0 && (
          <div className="seg" role="group" aria-label="Show">
            <button aria-pressed={show === 'active'} onClick={() => setShow('active')}>Active</button>
            <button aria-pressed={show === 'inactive'} onClick={() => setShow('inactive')}>Deactivated · {inactive}</button>
          </div>
        )}
      </div>
      <ul className="people-list">
        {list.map((m) => {
          const self = m.id === s.me.id;
          const w = load.get(m.id);
          const roleBlock = (r: OrgRole) => roleChangeError(s.me, m, r);
          // Admins change anyone but themselves; only the owner touches another owner.
          const canRole = admin && !self && (m.role !== 'owner' || isOwner(s.me));
          const offWhy = deactivateError(s.me, m);
          return (
            <li key={m.id} className={`person glass${m.active ? '' : ' inactive'}`}>
              <Avatar name={m.name} cls="lg" />
              <div className="p-main">
                <b>{m.name}{self ? ' (you)' : ''}</b>
                {admin && !self && m.active ? (
                  <input className="field p-title" aria-label={`${m.name}'s job title`} placeholder="Add a job title" defaultValue={m.title || ''} maxLength={80} key={m.title || ''}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== (m.title || '')) void run(() => store.setPersonTitle(m.id, v), 'Title saved'); }} />
                ) : <span className="muted">{m.title || (self ? 'Add your job title in Settings' : '')}</span>}
                <span className="p-email">{m.email}</span>
                <span className="p-teams">
                  {m.teams.map((x) => { const t = teamOf(x.teamId); return t ? <span key={x.teamId} className="team-chip"><TeamDot team={t} />{t.name}{x.role === 'lead' ? ' · lead' : ''}</span> : null; })}
                  {!m.teams.length && m.active && <span className="muted">No team</span>}
                </span>
              </div>
              <div className="p-side">
                {m.active && <span className="p-load" title="Open tasks assigned">{w?.open ?? 0} open{w?.blocked ? <b className="warn"> · {w.blocked} blocked</b> : null}</span>}
                {canRole && m.active ? (
                  <Select<OrgRole> variant="sm" label={`${m.name}'s organization role`} value={m.role} disabled={busy} align="end" minWidth={260}
                    options={(['member', 'admin', ...(isOwner(s.me) ? ['owner' as const] : [])] as OrgRole[]).map((r) => ({
                      value: r, label: ROLE_LABEL[r], hint: ROLE_HELP[r], icon: r === 'member' ? 'i-user' : r === 'admin' ? 'i-gear' : 'i-sparkle'
                    }))}
                    onChange={(r) => {
                      const why = roleBlock(r);
                      if (why) { toast(why, { icon: 'i-x' }); return; }
                      void run(() => store.setOrgRole(m.id, r), `${m.name} is now ${ROLE_LABEL[r].toLowerCase()}`);
                    }} />
                ) : <span className={`role-badge role-${m.role}`} title={ROLE_HELP[m.role]}>{ROLE_LABEL[m.role] ?? m.role}</span>}
                {admin && !self && !offWhy && (m.active ? (
                  <button className="btn btn-ghost danger-text" disabled={busy}
                    onClick={() => { if (confirm(`Deactivate ${m.name}? They can no longer sign in. Their tasks and history stay.`)) void run(() => store.deactivate(m.id), `${m.name} deactivated`); }}>
                    Deactivate
                  </button>
                ) : (
                  <button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => store.reactivate(m.id), `${m.name} can sign in again`)}>Reactivate</button>
                ))}
              </div>
            </li>
          );
        })}
        {!list.length && <li className="muted empty-note">Nobody matches.</li>}
      </ul>
    </>
  );
}

function InvitePanel({ code }: { code: string }) {
  const s = useDayflow();
  const store = useStore();
  const { busy, run } = useAction();
  const [team, setTeam] = useState(s.teams[0]?.id ?? '');
  const base = typeof window !== 'undefined' ? `${location.origin}/signup?invite=${code}` : '';
  const link = team ? `${base}&team=${team}` : base;
  return (
    <article className="panel glass invite-panel">
      <header className="panel-head">
        <div><h2>Invite people</h2><p className="muted">They create an account and land straight in the team you pick.</p></div>
      </header>
      <div className="invite-row">
        <div className="invite-box"><code aria-label="Invite code">{code}</code></div>
        <label className="sr-only" htmlFor="inviteTeam">Team</label>
        <Select id="inviteTeam" label="Team" className="invite-team" value={team} onChange={setTeam} options={[
          { value: '', label: 'Any team', hint: 'They join the first one', icon: 'i-users', color: 'var(--accent)' },
          ...teamOptions(s.teams, (t) => `Join ${t.name}`)
        ]} />
        <button className="btn btn-3d btn-primary" onClick={async () => toast((await copyText(link)) ? 'Invite link copied' : link, { icon: 'i-user-plus' })}><Icon name="i-copy" />Copy link</button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => { if (confirm('Issue a new code? The current link and code stop working.')) void run(() => store.regenerateInvite(), 'New invite code ready'); }}>
          <Icon name="i-undo" />New code
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------- audit log
const AUDIT_ICON = (e: AuditEntry) => (e.source === 'task' ? 'i-board' : e.action.startsWith('team') ? 'i-users' : e.action.startsWith('invite') ? 'i-link' : e.action.startsWith('org') ? 'i-org' : 'i-user');

function AuditTab() {
  const s = useDayflow();
  const ui = useUI();
  const [kind, setKind] = useState<'all' | 'org' | 'task'>('all');
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (before?: number) => {
    setLoading(true);
    try {
      const r = await api<{ entries: AuditEntry[]; more: boolean }>('GET', `/api/audit?kind=${kind}&limit=60${before ? `&before=${before}` : ''}`);
      setItems((cur) => (before ? [...cur, ...r.entries] : r.entries));
      setMore(r.more);
    } catch (e) {
      toast(`Couldn't load the audit log: ${(e as Error).message}`, { icon: 'i-x' });
    } finally {
      setLoading(false);
    }
  }, [kind]);
  useEffect(() => { void load(); }, [load]);

  let lastDay = '';
  return (
    <article className="panel glass audit">
      <header className="panel-head">
        <div><h2>Audit log</h2><p className="muted">Who changed what, across people, teams and every task.</p></div>
        <div className="seg" role="group" aria-label="Show">
          {(['all', 'org', 'task'] as const).map((k) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === 'all' ? 'Everything' : k === 'org' ? 'People & teams' : 'Tasks'}</button>)}
        </div>
      </header>
      <ol className="audit-list">
        {items.map((e) => {
          const day = fmtDay(e.createdAt, { weekday: 'long', day: 'numeric', month: 'long' });
          const head = day !== lastDay ? (lastDay = day) : null;
          const onBoard = e.taskId && s.tasks.some((t) => t.id === e.taskId);
          return (
            <li key={e.id}>
              {head && <h3 className="audit-day">{head}</h3>}
              <div className="audit-row">
                <span className="audit-ico"><Icon name={AUDIT_ICON(e)} /></span>
                <div>
                  <b>{e.actorName}</b> · {e.detail}
                  {e.taskTitle && <> on {onBoard ? <button className="link-btn inline" onClick={() => ui.openDetail(e.taskId!)}>“{e.taskTitle}”</button> : <i>“{e.taskTitle}”</i>}</>}
                  <time dateTime={new Date(e.createdAt).toISOString()}>{relTime(e.createdAt)}</time>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {!loading && !items.length && <p className="muted empty-note">Nothing recorded yet.</p>}
      {loading && <p className="muted empty-note">Loading…</p>}
      {more && !loading && <button className="btn btn-ghost load-more" onClick={() => void load(items[items.length - 1]?.createdAt)}>Load older entries</button>}
    </article>
  );
}

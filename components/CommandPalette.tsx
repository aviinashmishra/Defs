'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseInput } from '@/lib/parser';
import { copyText } from '@/lib/client/util';
import { toast } from '@/lib/client/bus';
import { isOrgAdmin } from '@/lib/access';
import { STATUS_NAMES } from '@/lib/types';
import { useDayflow, useStore, useUI } from './ctx';
import { Icon } from './Icons';
import { useEscape, useRestoreFocus } from './Overlays';
import './wow.css';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: string;
  iconColor?: string;
  keys?: string;
  /** Extra words that should find this item. */
  words?: string;
  run: () => void;
}

/** How well `q` matches `text`: substring beats word-start beats scattered letters; -1 is no match. */
function score(q: string, text: string): number {
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return (/\s|[-#@(“]/.test(t[i - 1]) ? 90 : 70) - Math.min(i, 30) / 3;
  let pos = -1, gaps = 0;
  for (const ch of q) {
    const n = t.indexOf(ch, pos + 1);
    if (n < 0) return -1;
    gaps += n - pos - 1;
    pos = n;
  }
  return Math.max(1, 50 - gaps);
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  useRestoreFocus(open);
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="pal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <Palette onClose={onClose} />
    </div>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const s = useDayflow();
  const store = useStore();
  const ui = useUI();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const personal = s.org.kind === 'personal';
  const actions = useMemo((): Item[] => {
    const go = (fn: () => void) => () => { onClose(); fn(); };
    const a: Item[] = [
      { id: 'new', group: 'Create', label: 'New task with details', icon: 'i-plus', keys: 'T', words: 'add create form description files', run: go(() => ui.openComposer({})) },
      { id: 'voice', group: 'Create', label: 'Add tasks by voice', icon: 'i-mic', keys: 'V', words: 'speak microphone dictate', run: go(() => { ui.setView('board'); ui.voice.start(); }) },
      { id: 'team-up', group: 'Create', label: personal ? 'Create a team and invite people' : 'Create a team', icon: 'i-users', words: 'team invite share people organization upgrade', run: go(ui.openTeamUp) },
      { id: 'v-board', group: 'Go to', label: 'Board', icon: 'i-board', words: 'kanban columns', run: go(() => ui.setView('board')) },
      { id: 'v-mine', group: 'Go to', label: 'My tasks', icon: 'i-list', keys: 'M', words: 'list assigned', run: go(() => ui.setView('mine')) },
      { id: 'v-history', group: 'Go to', label: 'Task history', icon: 'i-history', keys: 'H', words: 'archive log activity past completed deleted cleared restore audit export', run: go(() => ui.setView('history')) },
      { id: 'v-org', group: 'Go to', label: personal ? 'Insights' : 'Organization dashboard', icon: personal ? 'i-chart' : 'i-org', keys: 'O', words: 'insights pulse stats chart company', run: go(() => ui.openOrg('overview')) },
      ...(!personal ? [
        { id: 'v-teams', group: 'Go to', label: 'Teams', icon: 'i-users', words: 'organization members', run: go(() => ui.openOrg('teams')) },
        { id: 'v-people', group: 'Go to', label: 'People', icon: 'i-user', words: 'organization members roles', run: go(() => ui.openOrg('people')) }
      ] : []),
      { id: 'notes', group: 'Go to', label: 'Notifications', icon: 'i-bell', hint: s.unread ? `${s.unread} unread` : undefined, words: 'bell inbox mentions', run: go(ui.openNotifications) },
      { id: 'settings', group: 'Go to', label: 'Settings', icon: 'i-gear', words: 'preferences account profile', run: go(ui.openSettings) },
      { id: 'standup', group: 'Actions', label: 'Copy my standup', icon: 'i-copy', keys: 'S', words: 'report daily update slack', run: go(ui.copyStandup) },
      { id: 'standup-p', group: 'Actions', label: 'Preview standup', icon: 'i-note', words: 'report daily', run: go(ui.openStandup) },
      { id: 'export', group: 'Actions', label: 'Export to Excel, PDF or CSV', icon: 'i-download', keys: 'E', words: 'download xlsx report print', run: go(() => ui.openExport({ scope: 'mine' })) },
      { id: 'clear', group: 'Actions', label: 'Clear done tasks', icon: 's4', words: 'archive finished', run: go(ui.clearDone) },
      { id: 'undo', group: 'Actions', label: 'Undo last change', icon: 'i-undo', keys: 'Ctrl Z', words: 'revert', run: go(ui.doUndo) },
      ...(s.me.timer ? [{ id: 'pause', group: 'Actions', label: 'Pause focus timer', icon: 'i-pause', words: 'stop timer', run: go(() => store.stopTimer()) }] : []),
      { id: 'theme', group: 'Actions', label: ui.dark ? 'Switch to light theme' : 'Switch to dark theme', icon: ui.dark ? 'i-sun' : 'i-moon', words: 'theme dark light mode appearance', run: go(() => store.updateSettings({ theme: ui.dark ? 'light' : 'dark' })) },
      { id: 'fx', group: 'Actions', label: s.me.settings.effects3d ? 'Turn 3D effects off' : 'Turn 3D effects on', icon: 'i-sparkle', words: 'animation motion orb tilt', run: go(() => store.updateSettings({ effects3d: !s.me.settings.effects3d })) },
      { id: 'help', group: 'Actions', label: 'Keyboard shortcuts and voice tips', icon: 'i-help', keys: '?', words: 'help keys', run: go(ui.openHelp) }
    ];
    if (!personal && s.org.inviteCode) {
      const link = `${location.origin}/signup?invite=${s.org.inviteCode}`;
      a.splice(3, 0, { id: 'invite', group: 'Create', label: 'Copy invite link', icon: 'i-user-plus', words: 'invite join people add member', run: go(async () => toast((await copyText(link)) ? 'Invite link copied. Anyone with it can join.' : link, { icon: 'i-user-plus' })) });
    }
    // Board scopes: jump straight to one team, your private tasks, or everything.
    if (!personal) {
      const scope = (key: string, label: string, icon: string, color?: string, words = '') => ({
        id: `scope-${key}`, group: 'Show on board', label, icon, iconColor: color, words: `board filter switch ${words}`,
        hint: ui.boardTeam === key ? 'showing' : undefined,
        run: go(() => { ui.setBoardTeam(key); ui.setView('board'); })
      });
      a.push(scope('all', 'All teams', 'i-board', undefined, 'everything organization'));
      a.push(scope('personal', 'Personal (only you)', 'i-lock', undefined, 'private mine'));
      s.teams.forEach((t) => a.push(scope(t.id, `${t.name} team`, 'i-users', t.color, t.description || '')));
    }
    return a;
  }, [s.org, s.teams, s.unread, s.me.timer, s.me.settings.effects3d, personal, ui, store, onClose]);

  const tasks = useMemo((): Item[] => {
    const name = (id: string | null) => (id ? s.members.find((m) => m.id === id)?.name ?? '' : '');
    const team = (id: string | null) => (id ? s.teams.find((t) => t.id === id) : undefined);
    return [...s.tasks].sort((a, b) => Number(a.status === 4) - Number(b.status === 4) || b.updatedAt - a.updatedAt).map((t) => ({
      id: `t-${t.id}`,
      group: 'Tasks',
      label: t.title,
      hint: [STATUS_NAMES[t.status], t.private && !personal ? 'private' : team(t.teamId)?.name, name(t.assigneeId) && `@${name(t.assigneeId).split(' ')[0]}`].filter(Boolean).join(' · '),
      icon: `s${t.status}`,
      iconColor: `var(--st${t.status})`,
      words: [t.tags.map((x) => `#${x}`).join(' '), t.project, name(t.assigneeId) && `@${name(t.assigneeId)}`, t.description].filter(Boolean).join(' '),
      run: () => { onClose(); ui.openDetail(t.id); }
    }));
  }, [s.tasks, s.members, s.teams, personal, ui, onClose]);

  const items = useMemo((): Item[] => {
    const query = q.trim().toLowerCase();
    const actionsOnly = query.startsWith('>');
    const needle = actionsOnly ? query.slice(1).trim() : query;
    if (!needle) return actionsOnly ? actions : [...actions.filter((x) => x.group !== 'Show on board').slice(0, 8), ...tasks.slice(0, 6)];
    const rank = (x: Item) => Math.max(score(needle, x.label), x.words ? score(needle, x.words) - 15 : -1, x.hint ? score(needle, x.hint) - 25 : -1);
    const ranked = (actionsOnly ? actions : [...actions, ...tasks])
      .map((x) => ({ x, r: rank(x) }))
      // Scattered-letter matches only count when the letters sit close together.
      .filter((h) => h.r > 25)
      .sort((a, b) => b.r - a.r)
      .slice(0, 30);
    // Keep each group together, groups ordered by their best match.
    const byGroup = new Map<string, Item[]>();
    for (const { x } of ranked) byGroup.set(x.group, [...(byGroup.get(x.group) ?? []), x]);
    const groups = [...byGroup.values()];
    const hits = groups.flat();
    if (actionsOnly) return hits;
    // Anything else you type can become a task (or several: "… next task …").
    const parsed = parseInput(q.trim(), { team: s.members.filter((m) => m.active).map((m) => m.name), now: new Date() });
    if (!parsed.length) return hits;
    const add: Item = {
      id: 'quick-add', group: 'Create', icon: 'i-sparkle',
      label: parsed.length > 1 ? `Add ${parsed.length} tasks: ${parsed.map((p) => p.title).join(' · ')}` : `Add task “${parsed[0].title}”`,
      hint: personal ? 'private' : ui.boardTeam === 'personal' ? 'private' : undefined,
      keys: '↵',
      run: () => { if (ui.capture.commit(q, 'typed')) onClose(); }
    };
    // A strong match stays on top; otherwise adding what you typed is the first suggestion.
    const strong = ranked.length > 0 && ranked[0].r >= 85;
    if (!strong) return [add, ...hits];
    const create = byGroup.get('Create');
    if (create) return groups.flatMap((g) => (g === create ? [...g, add] : g));
    return [...groups[0], add, ...groups.slice(1).flat()];
  }, [q, actions, tasks, s.members, personal, ui.boardTeam, ui.capture, onClose]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run(); }
  };

  let lastGroup = '';
  return (
    <div className="pal glass" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="pal-input">
        <Icon name="i-search" />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder={isOrgAdmin(s.me) && !personal ? 'Search tasks, teams, actions… or type a new task' : 'Search tasks and actions… or type a new task'}
          role="combobox"
          aria-expanded="true"
          aria-controls="palList"
          aria-activedescendant={items[active] ? `pal-${items[active].id}` : undefined}
          aria-autocomplete="list"
          spellCheck={false}
        />
        <kbd>esc</kbd>
      </div>
      <div className="pal-list" id="palList" role="listbox" ref={list} aria-label="Results">
        {items.length === 0 && <p className="pal-empty">Nothing matches. Keep typing to add it as a task.</p>}
        {items.map((x, i) => {
          const head = x.group !== lastGroup ? <div className="pal-group" role="presentation">{x.group}</div> : null;
          lastGroup = x.group;
          return (
            <div key={x.id} style={{ display: 'contents' }}>
              {head}
              <div
                id={`pal-${x.id}`}
                data-i={i}
                role="option"
                aria-selected={i === active}
                className={`pal-item${i === active ? ' on' : ''}${x.id === 'quick-add' ? ' add' : ''}`}
                onMouseMove={() => { if (i !== active) setActive(i); }}
                onClick={() => x.run()}
              >
                <span className="pal-ico" style={x.iconColor ? { color: x.iconColor } : undefined}><Icon name={x.icon} /></span>
                <span className="pal-label">{x.label}</span>
                {x.hint && <span className="pal-hint">{x.hint}</span>}
                {x.keys && <kbd>{x.keys}</kbd>}
              </div>
            </div>
          );
        })}
      </div>
      <footer className="pal-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>&gt;</kbd> actions only</span>
        <span className="pal-foot-r">Type a sentence to add it as a task</span>
      </footer>
    </div>
  );
}

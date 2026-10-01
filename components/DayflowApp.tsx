'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { iso, parseCommand, parseInput } from '@/lib/parser';
import { looksLikeStory, type StoryTask } from '@/lib/voice';
import { api, ApiError } from '@/lib/client/api';
import { DayflowStore, todaysSet, type TaskChanges } from '@/lib/client/store';
import { announce, askBlockedReason, confetti, toast } from '@/lib/client/bus';
import { standupText } from '@/lib/client/standup';
import { copyText, fmtDay, haptic, parseISO, PRI_LABEL } from '@/lib/client/util';
import { STATUS_NAMES, type BoardData, type Source, type Status, type Task } from '@/lib/types';
import { StoreCtx, UICtx, useDayflow, type BoardTeam, type ComposerPreset, type OrgTab, type UI, type View } from './ctx';
import { canManageTask, isOrgAdmin } from '@/lib/access';
import { useMedia, useVoice } from './hooks';
import { Announcer, BlockedModal, Confetti, overlayOpen, Toasts, Tooltip } from './Overlays';
import { BottomNav, FocusDock, TopBar } from './Chrome';
import { Hero } from './Hero';
import { BoardView } from './Board';
import { OrgView } from './OrgView';
import { NotificationsSheet } from './Notifications';
import { DetailSheet } from './DetailSheet';
import { SettingsSheet } from './SettingsSheet';
import { HelpModal, StandupModal } from './Modals';
import { MyTasks } from './MyTasks';
import { History } from './History';
import { Composer } from './Composer';
import { ExportDialog } from './ExportDialog';
import { CommandPalette } from './CommandPalette';
import { TeamUp } from './TeamUp';
import type { ExportOptions } from '@/lib/client/export';

export default function DayflowApp({ initial }: { initial: BoardData }) {
  const [store] = useState(() => new DayflowStore(initial));
  useEffect(() => store.startSync(), [store]);
  return (
    <StoreCtx.Provider value={store}>
      <Shell store={store} />
    </StoreCtx.Provider>
  );
}

function Shell({ store }: { store: DayflowStore }) {
  const s = useDayflow();
  const settings = s.me.settings;
  const phone = useMedia('(max-width: 760px)');
  const reduceMotion = useMedia('(prefers-reduced-motion: reduce)');
  const osDark = useMedia('(prefers-color-scheme: dark)');
  // Hands-free "Hey Dayflow" is for mouse/trackpad devices: phones beep on every restart and drain the battery.
  const finePointer = useMedia('(pointer: fine)');
  const flat = reduceMotion || !settings.effects3d;
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && osDark);

  const [view, setViewState] = useState<View>(() => {
    const h = typeof location === 'undefined' ? '' : location.hash;
    return h.startsWith('#org') || h === '#insights' ? 'org' : h === '#mine' ? 'mine' : h === '#history' ? 'history' : 'board';
  });
  const [orgTab, setOrgTab] = useState<OrgTab>(() => {
    const t = typeof location === 'undefined' ? '' : location.hash.split('/')[1];
    return (['overview', 'teams', 'people', 'audit'] as const).find((x) => x === t) ?? 'overview';
  });
  // Which team the board shows. Remembered per person on this device.
  const teamKey = `dayflow.boardTeam.${s.me.id}`;
  const [boardTeam, setBoardTeamState] = useState<BoardTeam>(() => {
    try { return localStorage.getItem(teamKey) || 'all'; } catch { return 'all'; }
  });
  const [notifOpen, setNotifOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('all');
  const [mobileCol, setMobileCol] = useState(() => (initial(store).some((t) => t.status === 1) ? 1 : 0));
  const [bumped, setBumped] = useState({ status: -1, n: 0 });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerPreset | null>(null);
  const [exporting, setExporting] = useState<Partial<ExportOptions> | null>(null);
  const [standupOpen, setStandupOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [teamUpOpen, setTeamUpOpen] = useState(false);
  const [text, setText] = useState('');
  const pendingFocus = useRef<string | null>(null);

  // ---- theme and effects
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
    try { localStorage.setItem('dayflow.theme', settings.theme); } catch { /* ignore */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0e1f' : '#eef1f8');
  }, [settings.theme, dark]);
  useEffect(() => { document.documentElement.classList.toggle('flat', flat); }, [flat]);

  const setView = useCallback((v: View, tab?: OrgTab) => {
    setViewState(v);
    const hash = v === 'board' ? '' : v === 'org' ? `#org${tab && tab !== 'overview' ? `/${tab}` : ''}` : `#${v}`;
    try { history.replaceState(null, '', hash || location.pathname + location.search); } catch { /* ignore */ }
    window.scrollTo({ top: 0, behavior: flat ? 'auto' : 'smooth' });
  }, [flat]);
  const openOrg = useCallback((tab: OrgTab = 'overview') => { setOrgTab(tab); setDetailId(null); setView('org', tab); }, [setView]);
  // A personal space gets the team-up wizard; an organization adds teams on its Teams tab.
  const openTeamUp = useCallback(() => {
    const st = store.getState();
    setDetailId(null);
    setSettingsOpen(false);
    if (st.org.kind === 'personal') setTeamUpOpen(true);
    else if (isOrgAdmin(st.me)) openOrg('teams');
    else toast('Only admins can create teams. Ask one in your organization.', { icon: 'i-users' });
  }, [store, openOrg]);

  const setBoardTeam = useCallback((t: BoardTeam) => {
    setBoardTeamState(t);
    try { localStorage.setItem(teamKey, t); } catch { /* ignore */ }
  }, [teamKey]);
  // A team that was deleted (or that you left) falls back to all teams.
  useEffect(() => {
    if (!['all', 'none', 'personal'].includes(boardTeam) && !s.teams.some((t) => t.id === boardTeam)) setBoardTeam('all');
  }, [boardTeam, s.teams, setBoardTeam]);
  // New tasks go to the team on screen; on "all teams" they go to your first team; on "Personal" they are private.
  useEffect(() => {
    store.defaultPrivate = boardTeam === 'personal';
    store.defaultTeamId = boardTeam === 'none' || boardTeam === 'personal' ? null : boardTeam !== 'all' ? boardTeam : s.me.teams[0]?.teamId ?? null;
  }, [store, boardTeam, s.me.teams]);

  const selectCol = useCallback((i: number) => setMobileCol(i), []);

  // ---- feedback after a status change
  const feedback = useCallback((t: Task, status: Status, rect: DOMRect | null, withToast = false) => {
    const st = store.getState();
    haptic(st.me.settings.haptics, status === 4 ? [12, 40, 18] : 8);
    announce(`${t.title}: ${STATUS_NAMES[status]}`);
    if (status === 4 && rect) confetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
    setBumped((b) => ({ status, n: b.n + 1 }));
    if (withToast) toast(`“${t.title}” → ${STATUS_NAMES[status]}`, { icon: `s${status}`, undo: () => doUndoRef.current() });
    if (status === 4) {
      const set = todaysSet(store.getState());
      if (set.length >= 3 && set.every((x) => x.status === 4)) {
        setTimeout(() => {
          confetti(innerWidth / 2, innerHeight / 3, 160);
          toast('Everything done today. Copy your standup?', { icon: 'i-sparkle', actions: [{ label: 'Copy', fn: () => copyStandupRef.current() }] });
        }, 400);
      }
    }
  }, [store]);

  const changeStatus = useCallback<UI['changeStatus']>(async (id, status, opts = {}) => {
    const t = store.get(id);
    if (!t || t.status === status) return false;
    const changes: TaskChanges = { status };
    if (status === 2) {
      if (opts.reason) changes.blockedReason = opts.reason;
      else if (store.getState().me.settings.requireBlockedReason) {
        const r = await askBlockedReason(t);
        if (r == null) return false;
        changes.blockedReason = r;
      }
    }
    const el = opts.el ?? document.querySelector(`.card[data-id="${id}"]`);
    const rect = el ? el.getBoundingClientRect() : null;
    store.updateTask(id, changes, { label: `Move to ${STATUS_NAMES[status]}` });
    feedback(t, status, rect, opts.toast);
    return true;
  }, [store, feedback]);

  const doUndo = useCallback(() => {
    const label = store.undo();
    toast(label ? `Undone: ${label}` : 'Nothing to undo', { icon: 'i-undo' });
  }, [store]);
  const doUndoRef = useRef(doUndo);
  doUndoRef.current = doUndo;

  const clearDone = useCallback(() => {
    const n = store.clearDone();
    toast(n ? `Cleared ${n} done ${n > 1 ? 'tasks' : 'task'}. They stay in reports.` : 'No done tasks of yours to clear', { icon: 's4', undo: n ? doUndo : undefined });
  }, [store, doUndo]);

  const deleteTask = useCallback((id: string) => {
    const t = store.get(id);
    if (!t) return;
    const st = store.getState();
    if (!canManageTask(st.me, t)) {
      toast('Only the creator, the assignee, a team lead or an admin can delete this task', { icon: 'i-x' });
      return;
    }
    store.removeTask(id);
    toast(`Deleted “${t.title}”`, { icon: 'i-trash', undo: doUndo });
  }, [store, doUndo]);

  const openStandup = useCallback(() => setStandupOpen(true), []);
  const copyStandup = useCallback(async () => {
    const st = store.getState();
    const ok = await copyText(standupText(st, st.me.settings.standupFormat));
    const doneN = st.tasks.filter((t) => t.status === 4).length;
    const actions = [{ label: 'Preview', fn: () => setStandupOpen(true) }];
    if (doneN) actions.push({ label: 'Clear done', fn: clearDone });
    toast(ok ? 'Standup copied. Paste it in team chat.' : 'Copy blocked by the browser — opening preview.', { icon: 'i-copy', actions, timeout: 7000 });
    if (!ok) setStandupOpen(true);
  }, [store, clearDone]);
  const copyStandupRef = useRef(copyStandup);
  copyStandupRef.current = copyStandup;

  // ---- feedback after new tasks land (typed, spoken, or sorted from a story)
  const showAdded = useCallback((created: Task[], unknown: string[], source: Source, story = false, updated: Task[] = []) => {
    const st = store.getState();
    haptic(st.me.settings.haptics, 10);
    const all = [...created, ...updated];
    const n = created.length;
    if (story) {
      // "Added 2 and updated 2 from your story: 2 done, 1 in progress, 1 queued"
      const counts = ([4, 1, 3, 2, 0] as Status[]).map((k) => [k, all.filter((c) => c.status === k).length] as const).filter(([, c]) => c);
      const split = counts.map(([k, c]) => `${c} ${STATUS_NAMES[k].toLowerCase()}`).join(', ');
      const what = n && updated.length ? `Added ${n} and updated ${updated.length}` : n ? `Added ${n} tasks` : `Updated ${updated.length} tasks`;
      const one = all[0];
      const msg = all.length > 1 ? `${what} from your story: ${split}`
        : updated.length ? `Moved “${one.title}” to ${STATUS_NAMES[one.status]}` : `Added “${one.title}” (${STATUS_NAMES[one.status].toLowerCase()})`;
      announce(msg);
      toast(msg, { icon: 'i-sparkle', undo: doUndo, timeout: 7000 });
    } else {
      announce(n > 1 ? `Added ${n} tasks` : `Added ${created[0].title}`);
      toast(n > 1 ? `Added ${n} tasks${source === 'voice' ? ' by voice' : ''}` : `Added “${created[0].title}”`, { icon: source === 'voice' ? 'i-mic' : 'i-plus', undo: doUndo });
    }
    if (unknown.length) {
      if (st.org.kind === 'personal') toast(`It's just you here so far, so “${unknown.join(', ')}” was left out. Create a team to hand work to people.`, { icon: 'i-users', timeout: 8000, actions: [{ label: 'Create a team', fn: openTeamUp }] });
      else toast(`No teammate named ${unknown.join(', ')}, so it was left unassigned. Invite them from Organization → People.`, { icon: 'i-users', timeout: 7000 });
    }
    if (phone) setMobileCol(all[0].status);
    setViewState('board');
    const doneOne = all.find((c) => c.status === 4);
    if (doneOne) {
      setTimeout(() => {
        const r = document.querySelector(`.card[data-id="${doneOne.id}"]`)?.getBoundingClientRect();
        if (r) confetti(r.left + r.width / 2, r.top + r.height / 2);
      }, 120);
    }
  }, [store, doUndo, phone, openTeamUp]);

  // ---- capture: typed or spoken text → new tasks or a command
  const commit = useCallback((raw: string, source: Source): boolean => {
    const t = raw.trim();
    if (!t) return false;
    if (/^(undo|scratch that|cancel that|oops)$/i.test(t)) { doUndo(); setText(''); return true; }
    const st = store.getState();
    const opts = { team: st.members.filter((m) => m.active).map((m) => m.name), now: new Date() };

    const cmd = parseCommand(t, st.tasks, opts);
    if (cmd) {
      setText('');
      void (async () => {
        if (!cmd.taskId) {
          if (store.getState().me.timer) { store.stopTimer(); toast('Focus timer paused', { icon: 'i-pause' }); } else toast('No timer is running', { icon: 'i-clock' });
          return;
        }
        const task = store.get(cmd.taskId);
        if (!task) return;
        if (cmd.timer === 'pause') { store.stopTimer(); toast(`Paused “${task.title}”`, { icon: 'i-pause' }); return; }
        const changes: TaskChanges = {};
        if (cmd.changes.priority) changes.priority = cmd.changes.priority;
        if (cmd.changes.due) changes.dueDate = cmd.changes.due;
        if (cmd.changes.tags) changes.tags = [...new Set([...task.tags, ...cmd.changes.tags])];
        if (cmd.changes.assignee) {
          const m = store.getState().members.find((x) => x.active && x.name.toLowerCase().startsWith(cmd.changes.assignee!.toLowerCase().split(' ')[0]));
          if (m) changes.assigneeId = m.id; else toast(`No teammate named ${cmd.changes.assignee}`, { icon: 'i-users' });
        }
        if (Object.keys(changes).length) store.updateTask(task.id, changes, { label: 'Voice update' });
        if (cmd.changes.status !== undefined && cmd.changes.status !== task.status && cmd.timer !== 'start') {
          await changeStatus(task.id, cmd.changes.status, { reason: cmd.changes.blockedReason });
          if (phone) setMobileCol(cmd.changes.status);
        }
        if (cmd.timer === 'start') { store.startTimer(task.id); if (phone) setMobileCol(1); }
        const bits = [
          cmd.changes.status !== undefined ? STATUS_NAMES[cmd.changes.status] : '',
          changes.priority ? `${PRI_LABEL[changes.priority]} priority` : '',
          changes.dueDate ? `due ${fmtDay(parseISO(changes.dueDate))}` : '',
          changes.assigneeId ? `@${store.getState().members.find((m) => m.id === changes.assigneeId)?.name}` : ''
        ].filter(Boolean).join(', ');
        toast(`Updated “${task.title}”${bits ? ` → ${bits}` : ''}${cmd.timer === 'start' ? ' · focus started' : ''}`, { icon: 'i-sparkle', undo: doUndo });
      })();
      return true;
    }

    const parsed = parseInput(t, opts);
    if (!parsed.length) return false;
    const { created, unknown } = store.addTasks(parsed, source);
    setText('');
    showAdded(created, unknown, source);
    return true;
  }, [store, doUndo, changeStatus, phone, showAdded]);

  // ---- spoken story → Gemini splits it into tasks and sorts each by status
  const aiOff = useRef(false);
  // A story Gemini could not sort. Pressing Enter on it again adds it with the local parser instead of retrying.
  const skipAi = useRef<string | null>(null);
  const sorting = useRef(false);
  const noteRef = useRef<(msg: string | null, error?: boolean) => void>(() => {});
  const tellStory = useCallback(async (story: string, source: Source) => {
    if (sorting.current) return;
    sorting.current = true;
    const st = store.getState();
    const now = new Date();
    const team = st.members.filter((m) => m.active).map((m) => m.name);
    // Your open work, newest first, so "I finished the login fix" moves that card instead of adding a copy.
    const open = st.tasks
      .filter((t) => t.status !== 4 && (t.assigneeId === st.me.id || (!t.assigneeId && t.creatorId === st.me.id)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 80)
      .map((t) => ({ id: t.id, title: t.title, status: t.status }));
    noteRef.current('Sorting your story into tasks…');
    try {
      const { tasks } = await api<{ tasks: StoryTask[] }>('POST', '/api/voice/classify', {
        text: story, today: iso(now), weekday: now.toLocaleDateString('en-US', { weekday: 'long' }), team, open
      });
      noteRef.current(null);
      if (!tasks.length) {
        skipAi.current = story.trim();
        setText(story);
        toast('Didn’t hear any work in that. Edit it and press Enter to add it anyway.', { icon: 'i-mic', timeout: 7000 });
        return;
      }
      const me = store.getState().me;
      const updated: Task[] = [];
      const fresh: StoryTask[] = [];
      let added: { created: Task[]; unknown: string[] } = { created: [], unknown: [] };
      store.undoGroup('Story', () => {
        for (const x of tasks) {
          const t = x.existingId ? store.get(x.existingId) : undefined;
          if (!t || !canManageTask(me, t)) { if (!x.existingId || !t) fresh.push(x); continue; }
          if (t.status === x.status) continue;
          const changes: TaskChanges = { status: x.status };
          if (x.status === 2 && x.blockedReason) changes.blockedReason = x.blockedReason;
          const next = store.updateTask(t.id, changes, { label: `Move to ${STATUS_NAMES[x.status]}` });
          if (next) { updated.push(next); feedback(t, x.status, document.querySelector(`.card[data-id="${t.id}"]`)?.getBoundingClientRect() ?? null); }
        }
        if (fresh.length) added = store.addTasks(fresh.map((x) => ({ ...x, project: null, raw: story })), source);
      });
      setText((cur) => (cur.trim() === story.trim() ? '' : cur));
      if (added.created.length || updated.length) showAdded(added.created, added.unknown, source, true, updated);
      else toast('Your board already matches that story. Nothing to change.', { icon: 'i-sparkle', timeout: 6000 });
    } catch (err) {
      noteRef.current(null);
      if (err instanceof ApiError && err.status === 503) {
        // Story mode isn't set up on this server: fall back to the instant parser from now on.
        aiOff.current = true;
        if (!commit(story, source)) toast(`Couldn't find a task in “${story}”. Edit it and press Enter.`, { icon: 'i-mic', timeout: 7000 });
        return;
      }
      skipAi.current = story.trim();
      setText(story);
      toast(err instanceof Error ? err.message : 'Could not sort that story. Press Enter to add it as typed.', { icon: 'i-mic', timeout: 8000 });
      setTimeout(() => document.getElementById('captureInput')?.focus(), 0);
    } finally {
      sorting.current = false;
    }
  }, [store, showAdded, commit, feedback]);

  // Typed or spoken: a story goes to Gemini, everything else to the instant parser.
  const capture = useCallback((raw: string, source: Source): boolean => {
    const t = raw.trim();
    if (sorting.current) return true;
    if (t && !aiOff.current && t !== skipAi.current && looksLikeStory(t)) { void tellStory(t, source); return true; }
    if (t === skipAi.current) skipAi.current = null;
    return commit(raw, source);
  }, [commit, tellStory]);

  const voice = useVoice(settings.lang, setText, (final) => {
    if (!capture(final, 'voice')) {
      toast(`Couldn't find a task in “${final}”. Edit it and press Enter.`, { icon: 'i-mic', timeout: 7000 });
      setTimeout(() => document.getElementById('captureInput')?.focus(), 0);
    }
  }, () => {
    setViewState('board');
    if (phone) window.scrollTo({ top: 0, behavior: flat ? 'auto' : 'smooth' });
  }, settings.wakeWord && finePointer);
  noteRef.current = voice.note;

  // ---- global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = !!target.closest?.('input, textarea, select, [contenteditable="true"]');
      // Ctrl/⌘ K opens the command palette from anywhere, even while typing.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (paletteOpen) setPaletteOpen(false);
        else if (!overlayOpen()) setPaletteOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        if (voice.listening) voice.stop();
        else if (typing) target.blur();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && !overlayOpen()) { e.preventDefault(); doUndo(); return; }
      if (typing || overlayOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target.closest?.('.card') && /^([1-5 ]|Arrow.*|Enter|Delete|Backspace)$/.test(e.key)) return;
      const k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); setView('board'); setTimeout(() => document.getElementById('captureInput')?.focus(), 0); }
      else if (k === 'v') { e.preventDefault(); voice.toggle(); }
      else if (k === '/') { e.preventDefault(); setView('board'); setTimeout(() => document.getElementById('search')?.focus(), 0); }
      else if (k === 's') { e.preventDefault(); void copyStandup(); }
      else if (k === '?') { e.preventDefault(); setHelpOpen(true); }
      else if (k === 'i') { if (view === 'org' && orgTab === 'overview') setView('board'); else openOrg('overview'); }
      else if (k === 'o') { if (view === 'org') setView('board'); else openOrg(orgTab); }
      else if (k === 'm') { setView(view === 'mine' ? 'board' : 'mine'); }
      else if (k === 'h') { setView(view === 'history' ? 'board' : 'history'); }
      else if (k === 't') { e.preventDefault(); setComposer({}); }
      else if (k === 'e') { e.preventDefault(); setExporting({ scope: view === 'board' ? 'team' : 'mine' }); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [voice, doUndo, copyStandup, setView, view, orgTab, openOrg, paletteOpen]);

  // ---- offline shell + notification permission when focus sessions start
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  const timerOn = !!s.me.timer;
  useEffect(() => {
    if (timerOn && settings.pomodoro && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }, [timerOn, settings.pomodoro]);

  const closeDetail = useCallback(() => setDetailId(null), []);
  const ui: UI = useMemo(() => ({
    view, setView, search, setSearch, chip, setChip, mobileCol, selectCol, bumped, phone, flat, dark,
    openDetail: (id: string) => { setSettingsOpen(false); setDetailId(id); },
    openSettings: () => { setDetailId(null); setSettingsOpen(true); },
    openComposer: (preset: ComposerPreset = {}) => { setDetailId(null); setSettingsOpen(false); setComposer(preset); },
    orgTab, openOrg, boardTeam, setBoardTeam,
    openNotifications: () => { setDetailId(null); setSettingsOpen(false); setNotifOpen(true); },
    openPalette: () => setPaletteOpen(true),
    openTeamUp,
    openExport: (preset: Partial<ExportOptions> = {}) => { setDetailId(null); setSettingsOpen(false); setExporting(preset); },
    openStandup, openHelp: () => setHelpOpen(true), copyStandup: () => void copyStandup(),
    clearDone, deleteTask, doUndo, feedback, changeStatus,
    capture: { text, setText, commit: capture },
    voice,
    focusAfterRender: (id: string) => { pendingFocus.current = id; },
    takePendingFocus: () => { const f = pendingFocus.current; pendingFocus.current = null; return f; }
  }), [view, setView, orgTab, openOrg, openTeamUp, boardTeam, setBoardTeam, search, chip, mobileCol, selectCol, bumped, phone, flat, dark, openStandup, copyStandup, clearDone, deleteTask, doUndo, feedback, changeStatus, text, capture, voice]);

  return (
    <UICtx.Provider value={ui}>
      <a className="skip" href="#board">Skip to board</a>
      <TopBar />
      <main id="main">
        <section className="view view-board" aria-label="Board" hidden={view !== 'board'}>
          <Hero />
          <BoardView />
        </section>
        {view === 'mine' && <MyTasks />}
        {view === 'history' && <History />}
        {view === 'org' && <OrgView />}
      </main>
      <FocusDock />
      <BottomNav />
      <DetailSheet id={detailId} onClose={closeDetail} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <NotificationsSheet open={notifOpen} onClose={() => setNotifOpen(false)} />
      <StandupModal open={standupOpen} onClose={() => setStandupOpen(false)} />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <TeamUp open={teamUpOpen} onClose={() => setTeamUpOpen(false)} />
      <Composer preset={composer} onClose={() => setComposer(null)} />
      <ExportDialog preset={exporting} onClose={() => setExporting(null)} />
      <BlockedModal />
      <Toasts />
      <Announcer />
      <Tooltip />
      <Confetti disabled={flat} />
    </UICtx.Provider>
  );
}

function initial(store: DayflowStore) {
  return store.getState().tasks;
}

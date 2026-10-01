/*
 * Client store: optimistic state + a persistent outbox of API writes.
 * Every change shows instantly, is queued in localStorage, and is replayed in
 * order. Network failures pause the queue and retry (offline capture); a
 * rejected write is dropped, reported, and the board re-synced from the server.
 */
import { api, ApiError } from './api';
import { toast } from './bus';
import { fileToBase64, findMember, startOfToday, todayISO, uuid } from './util';
import { PRIORITY_WEIGHT, STATUS_WEIGHT, statusFields } from '../status';
import type { ParsedTask } from '../parser';
import { ATTACH_MAX_BYTES } from '../types';
import { isOrgAdmin, leadsTeam } from '../access';
import type {
  AppNotification, Attachment, BoardData, Comment, FocusEntry, HistoryEvent, Me, Member, Organization, OrgRole, OrgTeam, Settings, Source, Status, Task,
  TaskDetail, TaskLink, TeamRole, Timer
} from '../types';

export interface State {
  me: Me;
  org: Organization;
  teams: OrgTeam[];
  members: Member[];
  tasks: Task[];
  archived: Task[];
  focus: FocusEntry[];
  notifications: AppNotification[];
  unread: number;
  pending: number;
  online: boolean;
}

type EditableKey = 'teamId' | 'private' | 'title' | 'description' | 'remarks' | 'links' | 'status' | 'priority' | 'assigneeId' | 'reviewerId' | 'dueDate' | 'tags' | 'project' | 'blockedReason' | 'position';
export type TaskChanges = Partial<Pick<Task, EditableKey>>;
const EDITABLE: EditableKey[] = ['teamId', 'private', 'title', 'description', 'remarks', 'links', 'status', 'priority', 'assigneeId', 'reviewerId', 'dueDate', 'tags', 'project', 'blockedReason', 'position'];

interface Op { key: string; method: 'POST' | 'PATCH' | 'DELETE'; url: string; body?: unknown; label: string; tries?: number }

/** Extra fields a task can be created with from the full task form. */
export interface TaskExtras {
  description?: string | null;
  remarks?: string | null;
  links?: TaskLink[];
  assigneeId?: string | null; // wins over the parsed assignee name when given
  teamId?: string | null; // wins over the board's current team when given
  private?: boolean; // wins over the board's current scope when given
}

export const isMine = (t: Task, meId: string) => t.assigneeId === meId || (!t.assigneeId && t.creatorId === meId);

/** Whether the current person may clear this done task: their own, their team's (leads), or anyone's (admins). */
export const canClear = (me: Me, t: Task) => isOrgAdmin(me) || isMine(t, me.id) || leadsTeam(me, t.teamId);

export class DayflowStore {
  state: State;
  private listeners = new Set<() => void>();
  private undoStack: Array<{ label: string; run: () => void }> = [];
  private outbox: Op[] = [];
  private flushing = false;
  private retryDelay = 1500;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private skew = 0; // server clock minus client clock
  private readonly outboxKey: string;
  private seenNotes = new Set<string>();
  /** Whether new tasks are private when nothing else is said: the board is on "Personal" (set by the UI). */
  defaultPrivate = false;
  /** Team new tasks go to when none is given: the board's current team (set by the UI). */
  defaultTeamId: string | null = null;

  constructor(data: BoardData) {
    this.skew = data.serverTime - Date.now();
    this.outboxKey = `dayflow.outbox.${data.me.id}`;
    if (typeof window !== 'undefined') {
      try { this.outbox = JSON.parse(localStorage.getItem(this.outboxKey) || '[]'); } catch { this.outbox = []; }
    }
    this.state = { ...this.fromServer(data), pending: this.outbox.length, online: true };
    data.notifications.forEach((n) => this.seenNotes.add(n.id));
    this.defaultTeamId = data.me.teams[0]?.teamId ?? null;
    if (this.outbox.length) void this.flush();
  }

  // ---------- subscription ----------
  getState = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((f) => f());
  }
  get(id: string) { return this.state.tasks.find((t) => t.id === id); }

  private fromServer(d: BoardData) {
    const timer = d.me.timer ? { ...d.me.timer, startedAt: d.me.timer.startedAt - this.skew } : null;
    return {
      me: { ...d.me, timer }, org: d.org, teams: d.teams, members: d.members, tasks: d.tasks, archived: d.archived, focus: d.focus,
      notifications: d.notifications, unread: d.unread
    };
  }

  /** Toasts notifications that arrived since the last sync (not ones that were already there). */
  private announceNew(list: AppNotification[]) {
    const fresh = list.filter((n) => !n.read && !this.seenNotes.has(n.id));
    list.forEach((n) => this.seenNotes.add(n.id));
    if (!fresh.length) return;
    const [first] = fresh;
    toast(fresh.length > 1 ? `${first.text} · and ${fresh.length - 1} more` : first.text, { icon: 'i-bell', timeout: 6000 });
  }

  // ---------- sync ----------
  private persistOutbox() {
    try { localStorage.setItem(this.outboxKey, JSON.stringify(this.outbox)); } catch { /* storage blocked: keep in memory */ }
    if (this.state.pending !== this.outbox.length) this.set({ pending: this.outbox.length });
  }

  private enqueue(op: Omit<Op, 'key'>) {
    this.outbox.push({ ...op, key: uuid() });
    this.persistOutbox();
    void this.flush();
  }

  private pendingFor(id: string) {
    return this.outbox.some((o) => o.url.includes(id) || JSON.stringify(o.body ?? '').includes(id));
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try {
      while (this.outbox.length) {
        const op = this.outbox[0];
        try {
          const res = await api<Record<string, unknown>>(op.method, op.url, op.body);
          this.outbox.shift();
          this.persistOutbox();
          this.retryDelay = 1500;
          if (!this.state.online) this.set({ online: true });
          this.applyResult(res);
        } catch (err) {
          const e = err as ApiError;
          if (e.status === 401) { window.location.assign('/login'); return; }
          const transient = e.network || e.status >= 500 || e.status === 429;
          op.tries = (op.tries || 0) + 1;
          if (transient && (e.network || op.tries < 5)) {
            if (e.network && this.state.online) this.set({ online: false });
            this.persistOutbox();
            this.retryTimer = setTimeout(() => void this.flush(), this.retryDelay);
            this.retryDelay = Math.min(this.retryDelay * 2, 30000);
            return;
          }
          // Rejected by the server: drop it, say so, and re-sync.
          this.outbox.shift();
          this.persistOutbox();
          toast(`Couldn't save “${op.label}”: ${e.message}`, { icon: 'i-x', timeout: 7000 });
          this.flushing = false;
          await this.refresh();
          this.flushing = true;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private applyResult(res: Record<string, unknown> | null) {
    if (!res) return;
    const incoming: Task[] = [];
    if (res.task) incoming.push(res.task as Task);
    if (Array.isArray(res.tasks)) incoming.push(...(res.tasks as Task[]));
    let tasks = this.state.tasks;
    for (const t of incoming) {
      if (this.pendingFor(t.id)) continue;
      tasks = tasks.map((x) => (x.id === t.id ? t : x));
    }
    const patch: Partial<State> = { tasks };
    if ('timer' in res && !this.outbox.some((o) => o.url === '/api/timer')) {
      const timer = res.timer as Timer | null;
      patch.me = { ...this.state.me, timer: timer ? { ...timer, startedAt: timer.startedAt - this.skew } : null };
    }
    if (res.me && !this.outbox.some((o) => o.url === '/api/me')) {
      const me = res.me as Me;
      patch.me = { ...me, timer: (patch.me || this.state.me).timer };
    }
    this.set(patch);
  }

  /** Pull the latest board. Skipped while local writes are pending so they are never overwritten. */
  async refresh(): Promise<void> {
    if (this.outbox.length || this.flushing) return;
    try {
      const d = await api<BoardData>('GET', '/api/board');
      if (this.outbox.length || this.flushing) return;
      this.skew = d.serverTime - Date.now();
      this.set({ ...this.fromServer(d), online: true });
      this.announceNew(d.notifications);
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 401) window.location.assign('/login');
      else if (e.network) this.set({ online: false });
    }
  }

  /** Poll for teammates' changes while the tab is visible. Returns a cleanup function. */
  startSync(): () => void {
    const tick = () => { if (document.visibilityState === 'visible') void this.refresh(); };
    const iv = setInterval(tick, 15000);
    const onOnline = () => { this.set({ online: true }); void this.flush().then(() => this.refresh()); };
    const onOffline = () => this.set({ online: false });
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(iv);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }

  // ---------- undo ----------
  private undoBatch: Array<{ label: string; run: () => void }> | null = null;
  private pushUndo(label: string, run: () => void) {
    if (this.undoBatch) { this.undoBatch.push({ label, run }); return; }
    this.undoStack.push({ label, run });
    if (this.undoStack.length > 40) this.undoStack.shift();
  }
  /** Runs `fn` and folds every undo step it records into one, so a whole spoken story undoes at once. */
  undoGroup<T>(label: string, fn: () => T): T {
    if (this.undoBatch) return fn();
    const steps: Array<{ label: string; run: () => void }> = [];
    this.undoBatch = steps;
    try {
      return fn();
    } finally {
      this.undoBatch = null;
      if (steps.length === 1) this.pushUndo(steps[0].label, steps[0].run);
      else if (steps.length) this.pushUndo(label, () => [...steps].reverse().forEach((s) => s.run()));
    }
  }
  undo(): string | null {
    const u = this.undoStack.pop();
    if (!u) return null;
    u.run();
    return u.label;
  }

  // ---------- tasks ----------
  private minPos(status: Status, tasks = this.state.tasks) {
    const col = tasks.filter((t) => t.status === status);
    return col.length ? Math.min(...col.map((t) => t.position)) : 0;
  }

  addTasks(parsed: Array<ParsedTask & { source?: Source } & TaskExtras>, source: Source): { created: Task[]; unknown: string[] } {
    const now = Date.now();
    const unknown: string[] = [];
    const mins = [0, 1, 2, 3, 4].map((s) => this.minPos(s as Status));
    const created = parsed.map((p, i): Task => {
      const status = (p.status ?? 0) as Status;
      const member = p.assignee ? findMember(this.state.members.filter((m) => m.active), p.assignee) : null;
      if (p.assignee && !member) unknown.push(p.assignee);
      const assigneeId = p.assigneeId !== undefined ? p.assigneeId : member?.id ?? null;
      const teamId = p.teamId !== undefined ? p.teamId : this.defaultTeamId;
      // Personal spaces keep everything private. Elsewhere a task is private when asked (or on the
      // Personal board), unless it is filed under a team or handed to someone else.
      const priv = this.state.org.kind === 'personal'
        || ((p.private ?? (p.teamId === undefined && this.defaultPrivate)) && !(p.teamId) && (!assigneeId || assigneeId === this.state.me.id));
      return {
        id: uuid(),
        teamId: priv ? null : teamId,
        private: priv,
        title: p.title.slice(0, 300),
        description: p.description?.trim() || null,
        remarks: p.remarks?.trim() || null,
        links: (p.links ?? []).slice(0, 20),
        status,
        priority: p.priority ?? 'medium',
        assigneeId,
        creatorId: this.state.me.id,
        reviewerId: null,
        dueDate: p.due,
        tags: [...new Set(p.tags)].slice(0, 20),
        project: p.project,
        blockedReason: status === 2 ? p.blockedReason : null,
        blockedAt: status === 2 ? now : null,
        timeSpent: 0,
        position: mins[status] - parsed.length + i,
        source: p.source || source,
        createdAt: now,
        updatedAt: now,
        statusChangedAt: now,
        doneAt: status === 4 ? now : null,
        commentCount: 0,
        attachmentCount: 0
      };
    });
    this.set({ tasks: [...created, ...this.state.tasks] });
    for (let i = 0; i < created.length; i += 50) {
      const chunk = created.slice(i, i + 50);
      this.enqueue({
        method: 'POST',
        url: '/api/tasks',
        label: chunk.length > 1 ? `Add ${chunk.length} tasks` : `Add “${chunk[0].title}”`,
        body: {
          tasks: chunk.map((t) => ({
            id: t.id, teamId: t.teamId, private: t.private, title: t.title, description: t.description, remarks: t.remarks, links: t.links, status: t.status,
            priority: t.priority, assigneeId: t.assigneeId, dueDate: t.dueDate,
            tags: t.tags, project: t.project, blockedReason: t.blockedReason, position: t.position, source: t.source
          }))
        }
      });
    }
    const ids = created.map((t) => t.id);
    this.pushUndo(created.length > 1 ? `Add ${created.length} tasks` : 'Add task', () => ids.forEach((id) => this.removeTask(id, { undoable: false })));
    return { created, unknown };
  }

  updateTask(id: string, changes: TaskChanges, opts: { undoable?: boolean; label?: string } = {}): Task | undefined {
    const cur = this.get(id);
    if (!cur) return;
    // Same rule as the server: filing a private task under a team shares it.
    if (cur.private && changes.teamId && changes.private === undefined) changes = { ...changes, private: false };
    const now = Date.now();
    const next: Task = { ...cur, ...changes, updatedAt: now };
    const statusChanged = changes.status !== undefined && changes.status !== cur.status;
    if (statusChanged) {
      Object.assign(next, statusFields(cur, changes.status as Status, now));
      if (changes.position === undefined) next.position = this.minPos(changes.status as Status) - 1;
    }
    const payload: Record<string, unknown> = {};
    for (const k of EDITABLE) {
      if (k in changes || (statusChanged && k === 'position')) payload[k] = next[k];
    }
    if (!Object.keys(payload).length) return cur;

    let me = this.state.me;
    let focus = this.state.focus;
    // Finishing the task you are focusing on stops the timer (the server does the same).
    if (statusChanged && next.status === 4 && me.timer?.taskId === id) {
      const secs = this.timerElapsed();
      next.timeSpent += secs;
      focus = [...focus, { taskId: id, startedAt: me.timer.startedAt, seconds: secs }];
      me = { ...me, timer: null };
    }
    this.set({ tasks: this.state.tasks.map((t) => (t.id === id ? next : t)), me, focus });
    const label = opts.label || (statusChanged ? 'Move task' : 'Edit task');
    this.enqueue({ method: 'PATCH', url: `/api/tasks/${id}`, body: payload, label });
    if (opts.undoable !== false) {
      const prev: Record<string, unknown> = {};
      for (const k of Object.keys(payload)) prev[k] = cur[k as EditableKey];
      this.pushUndo(label, () => this.updateTask(id, prev as TaskChanges, { undoable: false }));
    }
    return next;
  }

  move(id: string, status: Status, beforeId: string | null) {
    const col = this.state.tasks.filter((x) => x.status === status && x.id !== id).sort((a, b) => a.position - b.position);
    let idx = beforeId ? col.findIndex((x) => x.id === beforeId) : col.length;
    if (idx < 0) idx = col.length;
    const before = col[idx - 1], after = col[idx];
    const position = !before && !after ? 0 : !before ? after.position - 1 : !after ? before.position + 1 : (before.position + after.position) / 2;
    return this.updateTask(id, { status, position }, { label: 'Move task' });
  }

  removeTask(id: string, opts: { undoable?: boolean } = {}) {
    const cur = this.get(id);
    if (!cur) return;
    const me = this.state.me.timer?.taskId === id ? { ...this.state.me, timer: null } : this.state.me;
    this.set({ tasks: this.state.tasks.filter((t) => t.id !== id), me });
    this.enqueue({ method: 'DELETE', url: `/api/tasks/${id}`, label: `Delete “${cur.title}”` });
    if (opts.undoable !== false) {
      this.pushUndo(`Delete “${cur.title}”`, () => {
        this.set({ tasks: [cur, ...this.state.tasks.filter((t) => t.id !== id)] });
        this.enqueue({ method: 'POST', url: `/api/tasks/${id}/restore`, label: `Restore “${cur.title}”` });
      });
    }
  }

  duplicate(id: string) {
    const t = this.get(id);
    if (!t) return;
    const assignee = this.state.members.find((m) => m.id === t.assigneeId)?.name ?? null;
    return this.addTasks([{
      title: `${t.title} (copy)`, status: 0, priority: t.priority, due: t.dueDate, assignee, tags: t.tags, project: t.project, blockedReason: null, raw: '',
      description: t.description, remarks: t.remarks, links: t.links, teamId: t.teamId, private: t.private
    }], t.source).created[0];
  }

  /** Archive done tasks you may clear (yours, your team's as a lead, anyone's as an admin). They still count in reports. */
  clearDone(): number {
    const me = this.state.me;
    const moved = this.state.tasks.filter((t) => t.status === 4 && canClear(me, t));
    if (!moved.length) return 0;
    const ids = moved.map((t) => t.id);
    const at = Date.now();
    this.set({ tasks: this.state.tasks.filter((t) => !ids.includes(t.id)), archived: [...moved.map((t) => ({ ...t, archivedAt: at })), ...this.state.archived] });
    this.enqueue({ method: 'POST', url: '/api/tasks/archive', body: { ids }, label: 'Clear done' });
    this.pushUndo(`Clear ${ids.length} done`, () => {
      this.set({ tasks: [...moved, ...this.state.tasks], archived: this.state.archived.filter((t) => !ids.includes(t.id)) });
      this.enqueue({ method: 'POST', url: '/api/tasks/unarchive', body: { ids }, label: 'Undo clear' });
    });
    return ids.length;
  }

  // ---------- history ----------
  /** Every task you can see, including cleared and deleted ones. */
  loadHistory() {
    return api<{ tasks: Task[]; capped: boolean }>('GET', '/api/history');
  }

  /** One page of the task change log, newest first. `before` is the createdAt of the last entry already shown. */
  loadHistoryEvents(params: { before?: number; from?: number; to?: number; task?: string; actor?: string; q?: string; limit?: number }) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== null) qs.set(k, String(v));
    return api<{ entries: HistoryEvent[]; more: boolean }>('GET', `/api/history/activity?${qs}`);
  }

  /** Brings a deleted task back. Online only: the server decides whether you may. */
  async restoreTask(id: string): Promise<Task> {
    const { task } = await api<{ task: Task }>('POST', `/api/tasks/${id}/restore`);
    const others = { tasks: this.state.tasks.filter((t) => t.id !== id), archived: this.state.archived.filter((t) => t.id !== id) };
    this.set(task.archivedAt ? { ...others, archived: [task, ...others.archived] } : { ...others, tasks: [task, ...others.tasks] });
    return task;
  }

  /** Puts cleared done tasks back on the board. Returns the ones the server let you bring back. */
  async unarchiveTasks(list: Task[]): Promise<Task[]> {
    const { ids } = await api<{ ids: string[] }>('POST', '/api/tasks/unarchive', { ids: list.map((t) => t.id) });
    const back = list.filter((t) => ids.includes(t.id)).map((t) => ({ ...t, archivedAt: null, updatedAt: Date.now() }));
    this.set({
      tasks: [...back, ...this.state.tasks.filter((t) => !ids.includes(t.id))],
      archived: this.state.archived.filter((t) => !ids.includes(t.id))
    });
    return back;
  }

  async addComment(id: string, text: string): Promise<Comment> {
    const { comment } = await api<{ comment: Comment }>('POST', `/api/tasks/${id}/comments`, { text });
    this.bumpCount(id, 'commentCount', 1);
    return comment;
  }

  loadDetail(id: string) {
    return api<TaskDetail>('GET', `/api/tasks/${id}`);
  }

  /** Waits until queued writes for this task (e.g. its creation) have reached the server. */
  async whenSaved(id: string, timeoutMs = 30000): Promise<void> {
    const t0 = Date.now();
    while (this.pendingFor(id)) {
      if (Date.now() - t0 > timeoutMs) throw new Error('you seem to be offline. Try again once you are back online');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /** Uploads a file once the task exists on the server. Files are not queued offline (they can be large). */
  async uploadAttachment(id: string, file: File): Promise<Attachment> {
    if (file.size > ATTACH_MAX_BYTES) throw new Error(`“${file.name}” is over ${ATTACH_MAX_BYTES / 1024 / 1024} MB`);
    await this.whenSaved(id);
    const data = await fileToBase64(file);
    const { attachment } = await api<{ attachment: Attachment }>('POST', `/api/tasks/${id}/attachments`, { name: file.name, type: file.type, data });
    this.bumpCount(id, 'attachmentCount', 1);
    return attachment;
  }

  async deleteAttachment(id: string, attachmentId: string): Promise<void> {
    await api('DELETE', `/api/tasks/${id}/attachments/${attachmentId}`);
    this.bumpCount(id, 'attachmentCount', -1);
  }

  /** Posts a comment once the task exists on the server (used by the new-task form). */
  async addCommentWhenSaved(id: string, text: string): Promise<Comment> {
    await this.whenSaved(id);
    return this.addComment(id, text);
  }

  private bumpCount(id: string, key: 'attachmentCount' | 'commentCount', by: number) {
    this.set({ tasks: this.state.tasks.map((t) => (t.id === id ? { ...t, [key]: Math.max(0, t[key] + by) } : t)) });
  }

  // ---------- focus timer (one per person) ----------
  timerElapsed(): number {
    const t = this.state.me.timer;
    return t ? Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000)) : 0;
  }

  private bookRunningTimer(tasks: Task[], focus: FocusEntry[]) {
    const timer = this.state.me.timer;
    if (!timer) return { tasks, focus };
    const secs = this.timerElapsed();
    return {
      tasks: tasks.map((x) => (x.id === timer.taskId ? { ...x, timeSpent: x.timeSpent + secs } : x)),
      focus: [...focus, { taskId: timer.taskId, startedAt: timer.startedAt, seconds: secs }]
    };
  }

  startTimer(id: string) {
    const t = this.get(id);
    if (!t || this.state.me.timer?.taskId === id) return;
    const now = Date.now();
    let { tasks, focus } = this.bookRunningTimer(this.state.tasks, this.state.focus);
    if (t.status !== 1) {
      const position = this.minPos(1, tasks) - 1;
      tasks = tasks.map((x) => (x.id === id ? { ...x, ...statusFields(x, 1, now), position, updatedAt: now } : x));
    }
    this.set({ tasks, focus, me: { ...this.state.me, timer: { taskId: id, startedAt: now } } });
    this.enqueue({ method: 'POST', url: '/api/timer', body: { action: 'start', taskId: id }, label: 'Start focus' });
  }

  stopTimer() {
    if (!this.state.me.timer) return;
    const { tasks, focus } = this.bookRunningTimer(this.state.tasks, this.state.focus);
    this.set({ tasks, focus, me: { ...this.state.me, timer: null } });
    this.enqueue({ method: 'POST', url: '/api/timer', body: { action: 'stop' }, label: 'Pause focus' });
  }

  toggleTimer(id: string) {
    if (this.state.me.timer?.taskId === id) this.stopTimer();
    else this.startTimer(id);
  }

  // ---------- profile & team ----------
  updateSettings(patch: Partial<Settings>) {
    this.set({ me: { ...this.state.me, settings: { ...this.state.me.settings, ...patch } } });
    this.enqueue({ method: 'PATCH', url: '/api/me', body: { settings: patch }, label: 'Save settings' });
  }

  updateName(name: string) {
    const me = { ...this.state.me, name };
    this.set({ me, members: this.state.members.map((m) => (m.id === me.id ? { ...m, name } : m)) });
    this.enqueue({ method: 'PATCH', url: '/api/me', body: { name }, label: 'Save name' });
  }

  updateTitle(title: string) {
    const clean = title.trim() || null;
    this.set({ me: { ...this.state.me, title: clean }, members: this.state.members.map((m) => (m.id === this.state.me.id ? { ...m, title: clean } : m)) });
    this.enqueue({ method: 'PATCH', url: '/api/me', body: { title: title.trim() }, label: 'Save job title' });
  }

  /** Makes a task private (only you see it) or shares it with the organization. Private tasks lose their team and other assignees. */
  setPrivate(id: string, priv: boolean) {
    const t = this.get(id);
    if (!t || t.private === priv) return;
    const me = this.state.me.id;
    const changes: TaskChanges = priv
      ? { private: true, teamId: null, assigneeId: t.assigneeId === me ? me : null, reviewerId: t.reviewerId === me ? me : null }
      : { private: false, teamId: this.defaultTeamId ?? this.state.me.teams[0]?.teamId ?? null };
    this.updateTask(id, changes, { label: priv ? 'Make private' : 'Share task' });
  }

  /**
   * Personal space → team workspace: names it, creates the first team (you lead it) and shares
   * the chosen tasks with that team. Returns the invite code for the next step.
   */
  async teamUp(input: { orgName: string; team: { name: string; description?: string | null; color?: string }; taskIds: string[] }) {
    await this.flush();
    const res = await api<{ team: OrgTeam; inviteCode: string; moved: number }>('POST', '/api/org/team-up', input);
    const { team } = res;
    const moved = new Set(input.taskIds);
    const lead = <T extends Member>(m: T): T => (m.id === this.state.me.id ? { ...m, teams: [...m.teams, { teamId: team.id, role: 'lead' as TeamRole }] } : m);
    this.set({
      org: { ...this.state.org, kind: 'team', name: input.orgName, inviteCode: res.inviteCode },
      teams: [team],
      me: lead(this.state.me),
      members: this.state.members.map(lead),
      tasks: this.state.tasks.map((t) => (moved.has(t.id) ? { ...t, private: false, teamId: team.id } : t)),
      archived: this.state.archived.map((t) => (moved.has(t.id) ? { ...t, private: false, teamId: team.id } : t))
    });
    this.defaultTeamId = team.id;
    void this.refresh();
    return res;
  }

  // ---------- organization (admins & leads; direct calls) ----------
  async renameOrg(name: string) {
    await api('PATCH', '/api/org', { name });
    this.set({ org: { ...this.state.org, name } });
  }

  async regenerateInvite() {
    const { inviteCode } = await api<{ inviteCode: string }>('POST', '/api/org/invite');
    this.set({ org: { ...this.state.org, inviteCode } });
  }

  async createTeam(fields: { name: string; description?: string | null; color?: string }) {
    const { team } = await api<{ team: OrgTeam }>('POST', '/api/teams', fields);
    this.set({ teams: [...this.state.teams, team].sort((a, b) => a.name.localeCompare(b.name)) });
    return team;
  }

  async updateTeam(id: string, fields: { name?: string; description?: string | null; color?: string }) {
    const { team } = await api<{ team: OrgTeam }>('PATCH', `/api/teams/${id}`, fields);
    this.set({ teams: this.state.teams.map((t) => (t.id === id ? team : t)).sort((a, b) => a.name.localeCompare(b.name)) });
  }

  async deleteTeam(id: string) {
    await api('DELETE', `/api/teams/${id}`);
    const strip = <T extends Member>(m: T): T => ({ ...m, teams: m.teams.filter((x) => x.teamId !== id) });
    this.set({
      teams: this.state.teams.filter((t) => t.id !== id),
      tasks: this.state.tasks.map((t) => (t.teamId === id ? { ...t, teamId: null } : t)),
      members: this.state.members.map(strip),
      me: strip(this.state.me)
    });
    if (this.defaultTeamId === id) this.defaultTeamId = this.state.me.teams[0]?.teamId ?? null;
  }

  async setTeamMember(teamId: string, userId: string, role: TeamRole) {
    await api('PUT', `/api/teams/${teamId}/members/${userId}`, { role });
    const put = <T extends Member>(m: T): T => (m.id !== userId ? m : { ...m, teams: [...m.teams.filter((x) => x.teamId !== teamId), { teamId, role }] });
    this.set({ members: this.state.members.map(put), me: put(this.state.me) });
  }

  async removeTeamMember(teamId: string, userId: string) {
    await api('DELETE', `/api/teams/${teamId}/members/${userId}`);
    const drop = <T extends Member>(m: T): T => (m.id !== userId ? m : { ...m, teams: m.teams.filter((x) => x.teamId !== teamId) });
    this.set({ members: this.state.members.map(drop), me: drop(this.state.me) });
  }

  async setOrgRole(userId: string, role: OrgRole) {
    await api('PATCH', `/api/people/${userId}`, { role });
    this.set({ members: this.state.members.map((m) => (m.id === userId ? { ...m, role } : m)) });
  }

  async setPersonTitle(userId: string, title: string) {
    await api('PATCH', `/api/people/${userId}`, { title });
    this.set({ members: this.state.members.map((m) => (m.id === userId ? { ...m, title: title.trim() || null } : m)) });
  }

  async deactivate(userId: string) {
    await api('DELETE', `/api/people/${userId}`);
    this.set({ members: this.state.members.map((m) => (m.id === userId ? { ...m, active: false, teams: [] } : m)) });
  }

  async reactivate(userId: string) {
    await api('POST', `/api/people/${userId}/reactivate`);
    this.set({ members: this.state.members.map((m) => (m.id === userId ? { ...m, active: true } : m)) });
  }

  // ---------- notifications ----------
  /** Marks the given notifications (or all) read: locally at once, then on the server. */
  async markRead(ids?: string[]) {
    const hit = (n: AppNotification) => !ids || ids.includes(n.id);
    const newlyRead = this.state.notifications.filter((n) => !n.read && hit(n)).length;
    this.set({
      notifications: this.state.notifications.map((n) => (hit(n) ? { ...n, read: true } : n)),
      unread: ids ? Math.max(0, this.state.unread - newlyRead) : 0
    });
    try { await api('POST', '/api/notifications/read', ids ? { ids } : {}); } catch { /* the next sync corrects the count */ }
  }

  /** Import tasks exported from the single-user prototype (Settings → Export JSON). */
  importPrototype(text: string): number {
    const data = JSON.parse(text) as { tasks?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.tasks)) throw new Error('Not a Dayflow export');
    const parsed = data.tasks
      .filter((t) => typeof t.title === 'string' && t.title.trim())
      .map((t) => ({
        title: String(t.title).trim(),
        status: ([0, 1, 2, 3, 4].includes(Number(t.status)) ? Number(t.status) : 0) as Status,
        priority: (['high', 'medium', 'low'].includes(String(t.priority)) ? t.priority : 'medium') as Task['priority'],
        due: typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : null,
        assignee: typeof t.assignee === 'string' ? t.assignee : null,
        tags: Array.isArray(t.tags) ? (t.tags as unknown[]).map(String).filter(Boolean) : [],
        project: typeof t.project === 'string' ? t.project : null,
        blockedReason: typeof t.blockedReason === 'string' ? t.blockedReason : null,
        raw: '',
        source: (t.source === 'voice' ? 'voice' : 'typed') as Source
      }));
    if (!parsed.length) return 0;
    this.addTasks(parsed, 'typed');
    return parsed.length;
  }

  exportJSON(): string {
    const { me, org, teams, members, tasks, archived } = this.state;
    return JSON.stringify({ exportedAt: new Date().toISOString(), me: { name: me.name, email: me.email }, organization: { name: org.name }, teams, members, tasks, archived }, null, 2);
  }
}

// ---------- derived data ----------
export function todaysSet(s: State): Task[] {
  const start = startOfToday();
  return s.tasks.filter((t) => isMine(t, s.me.id)).concat(s.archived.filter((t) => isMine(t, s.me.id) && t.doneAt && t.doneAt >= start));
}

export function progress(s: State): number {
  const set = todaysSet(s);
  if (!set.length) return 0;
  let num = 0, den = 0;
  for (const t of set) {
    const w = s.me.settings.weightByPriority ? PRIORITY_WEIGHT[t.priority] : 1;
    num += STATUS_WEIGHT[t.status] * w;
    den += w;
  }
  return den ? num / den : 0;
}

export function streak(s: State): number {
  const days = new Set(s.tasks.concat(s.archived).filter((t) => t.doneAt && isMine(t, s.me.id)).map((t) => todayISO(new Date(t.doneAt!))));
  let d = new Date();
  let n = 0;
  if (!days.has(todayISO(d))) d = new Date(Date.now() - 86400000);
  while (days.has(todayISO(d))) { n++; d = new Date(d.getTime() - 86400000); }
  return n;
}

export function focusSince(s: State, fromMs: number, running: number): number {
  return s.focus.filter((f) => f.startedAt >= fromMs).reduce((a, f) => a + f.seconds, 0) + running;
}

// Shared types used by the API and the client.

export type Status = 0 | 1 | 2 | 3 | 4;
export type Priority = 'high' | 'medium' | 'low';
/** Organization-wide role. The owner can do everything, including managing admins. */
export type OrgRole = 'owner' | 'admin' | 'member';
export type Role = OrgRole;
/** Role inside one team. Leads manage their team's members and tasks. */
export type TeamRole = 'lead' | 'member';
export type Source = 'typed' | 'voice';

export const STATUS_NAMES = ['Queued', 'In progress', 'Blocked', 'Review', 'Done'] as const;

export interface TaskLink {
  url: string; // http(s) only
  label: string; // may be empty: the host name is shown instead
}

export interface Task {
  id: string;
  /** The team (department) the task belongs to; null means "no team". */
  teamId: string | null;
  /** Only the creator can see a private task. Private tasks have no team and no other assignee. */
  private: boolean;
  title: string;
  description: string | null;
  remarks: string | null;
  links: TaskLink[];
  status: Status;
  priority: Priority;
  assigneeId: string | null;
  creatorId: string | null;
  reviewerId: string | null;
  dueDate: string | null; // YYYY-MM-DD
  tags: string[];
  project: string | null;
  blockedReason: string | null;
  blockedAt: number | null;
  timeSpent: number; // seconds
  position: number;
  source: Source;
  createdAt: number;
  updatedAt: number;
  statusChangedAt: number;
  doneAt: number | null;
  commentCount: number;
  attachmentCount: number;
  /** Set once the task was cleared from the board ("Clear done"). */
  archivedAt?: number | null;
  /** Set once the task was deleted (it can still be restored). History only. */
  deletedAt?: number | null;
}

export interface TeamMembership {
  teamId: string;
  role: TeamRole;
}

export interface Member {
  id: string;
  name: string;
  role: Role;
  email: string;
  title: string | null;
  /** False once an admin deactivates the account. Kept so history stays attributed. */
  active: boolean;
  teams: TeamMembership[];
}

/** A team (department) inside the organization. */
export interface OrgTeam {
  id: string;
  name: string;
  description: string | null;
  color: string;
}

/** 'personal': one person's own space. 'team': an organization with teams. */
export type OrgKind = 'personal' | 'team';

export interface Organization {
  id: string;
  name: string;
  kind: OrgKind;
  /** Only admins and the owner receive the invite code. */
  inviteCode: string | null;
}

export type NotificationKind = 'assigned' | 'review' | 'comment' | 'mention' | 'blocked' | 'status' | 'team';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  text: string;
  taskId: string | null;
  actorName: string | null;
  createdAt: number;
  read: boolean;
}

export interface AuditEntry {
  id: string;
  source: 'org' | 'task';
  action: string;
  detail: string;
  actorName: string;
  taskId: string | null;
  taskTitle: string | null;
  createdAt: number;
}

export interface Settings {
  lang: string;
  theme: 'auto' | 'dark' | 'light';
  effects3d: boolean;
  weightByPriority: boolean;
  requireBlockedReason: boolean;
  shareFocusInStandup: boolean;
  pomodoro: number;
  standupFormat: 'status' | 'ytb' | 'slack';
  haptics: boolean;
  /** Hands-free capture: say “Hey Dayflow” once the microphone is allowed (desktop browsers). */
  wakeWord: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'en-IN',
  theme: 'auto',
  effects3d: true,
  weightByPriority: true,
  requireBlockedReason: true,
  shareFocusInStandup: false,
  pomodoro: 25,
  standupFormat: 'status',
  haptics: true,
  wakeWord: true
};

export interface Timer {
  taskId: string;
  startedAt: number;
}

export interface Me extends Member {
  orgId: string;
  settings: Settings;
  timer: Timer | null;
}

export interface FocusEntry {
  taskId: string | null;
  startedAt: number;
  seconds: number;
}

export interface BoardData {
  me: Me;
  org: Organization;
  teams: OrgTeam[];
  notifications: AppNotification[];
  unread: number;
  members: Member[];
  tasks: Task[];
  archived: Task[];
  focus: FocusEntry[];
  serverTime: number;
}

export interface Comment {
  id: string;
  authorId: string | null;
  authorName: string;
  text: string;
  createdAt: number;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number; // bytes
  uploaderId: string | null;
  uploaderName: string;
  createdAt: number;
}

/** Upload limits, shared so the client can refuse early with a clear message. */
export const ATTACH_MAX_BYTES = 3 * 1024 * 1024;
export const ATTACH_MAX_PER_TASK = 20;

/** One entry of the organization-wide task log (History → Activity). */
export interface HistoryEvent {
  id: string;
  taskId: string;
  taskTitle: string;
  actorId: string | null;
  actorName: string;
  change: string;
  createdAt: number;
}

export interface ActivityItem {
  id: string;
  actorName: string;
  change: string;
  createdAt: number;
}

export interface TaskDetail {
  task: Task;
  comments: Comment[];
  attachments: Attachment[];
  activity: ActivityItem[];
}

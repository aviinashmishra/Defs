import 'server-only';
import { z } from 'zod';
import { db, ms, type Row } from './db';
import { HttpError } from './http';
import type { SessionUser } from './auth';
import { isAdmin, toMe } from './auth';
import { mapMember, mapNotification, mapTeam, membersQuery, notificationsQuery, teamsQuery, unreadQuery } from './org';
import type { Attachment, BoardData, Status, Task } from '../types';
import { STATUS_NAMES } from '../types';

// ---------- validation ----------
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const tags = z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20);
const status = z.number().int().min(0).max(4);
const priority = z.enum(['high', 'medium', 'low']);
const longText = (max: number) => z.string().trim().max(max).transform((v) => v || null).nullable();
// Only http(s) links: anything else (javascript:, data:) could run script when clicked.
const link = z.object({
  url: z.string().trim().max(2000).refine((v) => {
    try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; }
  }, 'Links must start with http:// or https://'),
  label: z.string().trim().max(120).default('')
});
const links = z.array(link).max(20);

export const createTaskSchema = z.object({
  id: z.uuid(),
  teamId: z.uuid().nullable().default(null),
  private: z.boolean().default(false),
  title: z.string().trim().min(1).max(300),
  description: longText(5000).default(null),
  remarks: longText(2000).default(null),
  links: links.default([]),
  status: status.default(0),
  priority: priority.default('medium'),
  assigneeId: z.uuid().nullable().default(null),
  dueDate: dateStr.nullable().default(null),
  tags: tags.default([]),
  project: z.string().trim().max(80).nullable().default(null),
  blockedReason: z.string().trim().max(200).nullable().default(null),
  position: z.number().finite().default(0),
  source: z.enum(['typed', 'voice']).default('typed')
});
export type CreateTask = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  teamId: z.uuid().nullable().optional(),
  private: z.boolean().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  description: longText(5000).optional(),
  remarks: longText(2000).optional(),
  links: links.optional(),
  status: status.optional(),
  priority: priority.optional(),
  assigneeId: z.uuid().nullable().optional(),
  reviewerId: z.uuid().nullable().optional(),
  dueDate: dateStr.nullable().optional(),
  tags: tags.optional(),
  project: z.string().trim().max(80).nullable().optional(),
  blockedReason: z.string().trim().max(200).nullable().optional(),
  position: z.number().finite().optional()
});
export type UpdateTask = z.infer<typeof updateTaskSchema>;

export const idList = z.object({ ids: z.array(z.uuid()).min(1).max(500) });

/** Private tasks stay with their creator: no team, and nobody else assigned or reviewing. */
export function assertPrivateFits(u: SessionUser, t: { teamId?: string | null; assigneeId?: string | null; reviewerId?: string | null }) {
  if (t.teamId) throw new HttpError(400, 'A private task cannot belong to a team. Share it with the team instead.');
  if ((t.assigneeId && t.assigneeId !== u.id) || (t.reviewerId && t.reviewerId !== u.id)) {
    throw new HttpError(400, 'Private tasks can only be assigned to you. Share the task to hand it to someone else.');
  }
}

// ---------- mapping ----------
export function mapTask(r: Row): Task {
  return {
    id: String(r.id),
    teamId: (r.team_id as string) ?? null,
    private: !!r.private,
    title: String(r.title),
    description: (r.description as string) ?? null,
    remarks: (r.remarks as string) ?? null,
    links: Array.isArray(r.links) ? (r.links as Task['links']) : [],
    status: Number(r.status) as Status,
    priority: r.priority as Task['priority'],
    assigneeId: (r.assignee_id as string) ?? null,
    creatorId: (r.creator_id as string) ?? null,
    reviewerId: (r.reviewer_id as string) ?? null,
    dueDate: (r.due as string) ?? null,
    tags: (r.tags as string[]) ?? [],
    project: (r.project as string) ?? null,
    blockedReason: (r.blocked_reason as string) ?? null,
    blockedAt: ms(r.blocked_at),
    timeSpent: Number(r.time_spent_seconds) || 0,
    position: Number(r.position) || 0,
    source: (r.source as Task['source']) || 'typed',
    createdAt: ms(r.created_at) ?? Date.now(),
    updatedAt: ms(r.updated_at) ?? Date.now(),
    statusChangedAt: ms(r.status_changed_at) ?? Date.now(),
    doneAt: ms(r.done_at),
    commentCount: Number(r.comment_count) || 0,
    attachmentCount: Number(r.attachment_count) || 0,
    archivedAt: ms(r.archived_at),
    deletedAt: ms(r.deleted_at)
  };
}

/** Attachment metadata (never the file bytes). Expects `uploader_name` from a join. */
export function mapAttachment(r: Row): Attachment {
  return {
    id: String(r.id),
    name: String(r.name),
    mime: String(r.mime),
    size: Number(r.size) || 0,
    uploaderId: (r.uploader_id as string) ?? null,
    uploaderName: String(r.uploader_name ?? 'Former member'),
    createdAt: ms(r.created_at) ?? Date.now()
  };
}

// ---------- queries ----------
export async function loadBoard(u: SessionUser): Promise<BoardData> {
  const sql = db();
  const [org, teams, members, tasks, archived, focus, notes, unread] = await sql.transaction(
    [
      sql`SELECT id, name, kind, invite_code FROM organizations WHERE id = ${u.orgId}`,
      teamsQuery(u.orgId),
      membersQuery(u.orgId),
      sql`SELECT * FROM task_view WHERE org_id = ${u.orgId} AND deleted_at IS NULL AND archived_at IS NULL AND (NOT private OR creator_id = ${u.id}) ORDER BY position`,
      sql`SELECT * FROM task_view WHERE org_id = ${u.orgId} AND deleted_at IS NULL AND archived_at IS NOT NULL AND done_at > now() - interval '70 days' AND (NOT private OR creator_id = ${u.id})`,
      sql`SELECT task_id, started_at, seconds FROM focus_sessions WHERE user_id = ${u.id} AND started_at > now() - interval '70 days'`,
      notificationsQuery(u.id),
      unreadQuery(u.id)
    ],
    { readOnly: true }
  );
  const o = org[0];
  if (!o) throw new HttpError(404, 'Organization not found');
  const invite = isAdmin(u) ? String(o.invite_code) : null;
  return {
    me: toMe(u),
    org: { id: String(o.id), name: String(o.name), kind: o.kind === 'personal' ? 'personal' : 'team', inviteCode: invite },
    teams: teams.map(mapTeam),
    members: members.map(mapMember),
    tasks: tasks.map(mapTask),
    archived: archived.map(mapTask),
    focus: focus.map((f) => ({ taskId: (f.task_id as string) ?? null, startedAt: ms(f.started_at)!, seconds: Number(f.seconds) })),
    notifications: notes.map(mapNotification),
    unread: Number(unread[0]?.n) || 0,
    serverTime: Date.now()
  };
}

export async function getTask(u: SessionUser, id: string): Promise<Task> {
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, 'Task not found');
  // Someone else's private task does not exist, as far as this person can tell.
  const rows = await db()`SELECT * FROM task_view WHERE id = ${id} AND org_id = ${u.orgId} AND deleted_at IS NULL AND (NOT private OR creator_id = ${u.id})`;
  if (!rows[0]) throw new HttpError(404, 'Task not found');
  return mapTask(rows[0]);
}

/**
 * Stops running focus timers and books the time on the task. Filter by user,
 * by task, or both. Returned as a query so callers can batch it in a transaction.
 */
export function stopTimersQuery(orgId: string, opts: { userId?: string | null; taskId?: string | null }) {
  const userId = opts.userId ?? null;
  const taskId = opts.taskId ?? null;
  return db()`
    WITH old AS (
      SELECT id, timer_task_id, timer_started_at FROM users
      WHERE org_id = ${orgId} AND timer_task_id IS NOT NULL
        AND (${userId}::uuid IS NULL OR id = ${userId}::uuid)
        AND (${taskId}::uuid IS NULL OR timer_task_id = ${taskId}::uuid)
    ), cleared AS (
      UPDATE users u SET timer_task_id = NULL, timer_started_at = NULL FROM old WHERE u.id = old.id RETURNING u.id
    ), ins AS (
      INSERT INTO focus_sessions (user_id, org_id, task_id, started_at, ended_at, seconds)
      SELECT old.id, ${orgId}, t.id, old.timer_started_at, now(), GREATEST(0, EXTRACT(EPOCH FROM now() - old.timer_started_at))::int
      FROM old LEFT JOIN tasks t ON t.id = old.timer_task_id
      RETURNING user_id, task_id, seconds
    ), act AS (
      INSERT INTO activity (task_id, actor_id, change)
      SELECT task_id, user_id, 'Focused ' || CASE WHEN seconds >= 3600 THEN (seconds / 3600) || 'h ' || ((seconds % 3600) / 60) || 'm' ELSE (seconds / 60) || 'm' END
      FROM ins WHERE task_id IS NOT NULL AND seconds >= 60
    )
    UPDATE tasks t SET time_spent_seconds = t.time_spent_seconds + s.total
    FROM (SELECT task_id, sum(seconds)::int AS total FROM ins WHERE task_id IS NOT NULL GROUP BY task_id) s
    WHERE t.id = s.task_id`;
}

export function activityQuery(taskId: string, actorId: string, changes: string[]) {
  return db()`INSERT INTO activity (task_id, actor_id, change) SELECT ${taskId}::uuid, ${actorId}::uuid, unnest(${changes}::text[])`;
}

export const statusName = (s: number) => STATUS_NAMES[s] ?? String(s);

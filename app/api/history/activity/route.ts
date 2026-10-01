import { z } from 'zod';
import { db, ms } from '@/lib/server/db';
import { json, route } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import type { HistoryEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive().optional(),
  task: z.uuid().optional(),
  actor: z.uuid().optional(),
  q: z.string().trim().max(120).optional()
});

// The change log of every task this person can see, newest first, one page at a time (`before` = cursor).
export const GET = route(async (req) => {
  const u = await requireUser();
  const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  const iso = (n?: number) => (n ? new Date(n).toISOString() : null);
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db()`
    SELECT c.id, c.task_id, c.actor_id, c.change, c.created_at, t.title AS task_title, coalesce(p.name, 'Someone') AS actor_name
    FROM activity c
    JOIN tasks t ON t.id = c.task_id
    LEFT JOIN users p ON p.id = c.actor_id
    WHERE t.org_id = ${u.orgId} AND (NOT t.private OR t.creator_id = ${u.id})
      AND (${iso(q.before)}::timestamptz IS NULL OR c.created_at < ${iso(q.before)}::timestamptz)
      AND (${iso(q.from)}::timestamptz IS NULL OR c.created_at >= ${iso(q.from)}::timestamptz)
      AND (${iso(q.to)}::timestamptz IS NULL OR c.created_at < ${iso(q.to)}::timestamptz)
      AND (${q.task ?? null}::uuid IS NULL OR c.task_id = ${q.task ?? null}::uuid)
      AND (${q.actor ?? null}::uuid IS NULL OR c.actor_id = ${q.actor ?? null}::uuid)
      AND (${like}::text IS NULL OR c.change ILIKE ${like} OR t.title ILIKE ${like} OR p.name ILIKE ${like})
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${q.limit}`;
  const entries: HistoryEvent[] = rows.map((r) => ({
    id: String(r.id),
    taskId: String(r.task_id),
    taskTitle: String(r.task_title),
    actorId: (r.actor_id as string) ?? null,
    actorName: String(r.actor_name),
    change: String(r.change),
    createdAt: ms(r.created_at)!
  }));
  return json({ entries, more: entries.length === q.limit }, { headers: { 'Cache-Control': 'no-store' } });
});

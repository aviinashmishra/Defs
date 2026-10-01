import { db } from '@/lib/server/db';
import { json, route } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { mapTask } from '@/lib/server/tasks';

export const dynamic = 'force-dynamic';

/** Upper bound so one huge organization cannot stall the page; the newest tasks win. */
const MAX_TASKS = 5000;

// Every task this person can see, whatever happened to it: on the board, cleared ("archived") or deleted.
export const GET = route(async () => {
  const u = await requireUser();
  const rows = await db()`
    SELECT * FROM task_view
    WHERE org_id = ${u.orgId} AND (NOT private OR creator_id = ${u.id})
    ORDER BY created_at DESC
    LIMIT ${MAX_TASKS}`;
  return json({ tasks: rows.map(mapTask), capped: rows.length === MAX_TASKS }, { headers: { 'Cache-Control': 'no-store' } });
});

'use client';
import { useEffect, useState } from 'react';
import { toast } from '@/lib/client/bus';
import { ageLabel, daysSince, fmtDuration, PRI_GLYPH, PRI_LABEL, relTime } from '@/lib/client/util';
import { ATTACH_MAX_PER_TASK, STATUS_NAMES, type ActivityItem, type Attachment, type Comment, type Priority, type Status } from '@/lib/types';
import { useDayflow, useStore, useUI } from './ctx';
import { useNow } from './hooks';
import { Icon } from './Icons';
import { Sheet } from './Overlays';
import { Avatar } from './TaskCard';
import { AttachmentList, FileDrop, LinksEditor } from './Attachments';
import { canManageTask } from '@/lib/access';
import { Select } from './Select';
import { memberOptions, NO_TEAM_OPTION, PERSONAL_OPTION, teamOptions } from './pickers';

export function DetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const s = useDayflow();
  const store = useStore();
  const ui = useUI();
  const t = id ? s.tasks.find((x) => x.id === id) : undefined;
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const [uploading, setUploading] = useState(0);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const timerOn = !!t && s.me.timer?.taskId === t.id;
  useNow(1000, timerOn);

  // Load comments, files and history; reload when the task changes (after the save lands)
  // or when files/comments are added elsewhere (e.g. uploads still running from the new-task form).
  const updatedAt = t?.updatedAt;
  const counts = t ? `${t.attachmentCount}:${t.commentCount}` : '';
  useEffect(() => {
    if (!id) return;
    let live = true;
    const load = () => store.loadDetail(id).then((d) => { if (live) { setComments(d.comments); setActivity(d.activity); setFiles(d.attachments); } }).catch(() => { if (live) { setComments((c) => c ?? []); setFiles((f) => f ?? []); } });
    const timer = setTimeout(load, s.pending ? 900 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [id, updatedAt, counts, store, s.pending]);
  useEffect(() => { setComments(null); setActivity([]); setFiles(null); setDraft(''); }, [id]);

  // Closed if the task disappears (deleted here or by a teammate).
  useEffect(() => { if (id && !t) onClose(); }, [id, t, onClose]);

  if (!id || !t) return null;
  const canDelete = canManageTask(s.me, t);
  const save = (changes: Parameters<typeof store.updateTask>[1], label?: string) => store.updateTask(t.id, changes, { label });

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      const c = await store.addComment(t.id, text);
      setComments((list) => [...(list || []), c]);
      setDraft('');
    } catch (err) {
      toast(`Comment not posted: ${(err as Error).message}`, { icon: 'i-x' });
    } finally {
      setPosting(false);
    }
  };

  const upload = async (picked: File[]) => {
    const room = ATTACH_MAX_PER_TASK - (files?.length ?? t.attachmentCount);
    if (picked.length > room) toast(`A task can hold up to ${ATTACH_MAX_PER_TASK} files`, { icon: 'i-clip' });
    const list = picked.slice(0, Math.max(0, room));
    setUploading((n) => n + list.length);
    for (const f of list) {
      try {
        const a = await store.uploadAttachment(t.id, f);
        setFiles((cur) => [...(cur || []), a]);
      } catch (err) {
        toast(`Couldn't attach “${f.name}”: ${(err as Error).message}`, { icon: 'i-x', timeout: 7000 });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const removeFile = async (a: Attachment) => {
    if (!window.confirm(`Remove “${a.name}” from this task?`)) return;
    try {
      await store.deleteAttachment(t.id, a.id);
      setFiles((cur) => (cur || []).filter((x) => x.id !== a.id));
      toast(`Removed “${a.name}”`, { icon: 'i-trash' });
    } catch (err) {
      toast(`Couldn't remove it: ${(err as Error).message}`, { icon: 'i-x' });
    }
  };

  const head = (
    <>
      <span className="eyebrow" id="dTitleLabel">{t.source === 'voice' ? 'Voice' : 'Typed'} task · {STATUS_NAMES[t.status]}</span>
      <div className="row-gap">
        <button className="icon-btn" aria-label="Duplicate task" onClick={() => { store.duplicate(t.id); toast('Duplicated to Queued', { icon: 'i-copy', undo: ui.doUndo }); }}><Icon name="i-copy" /></button>
        {canDelete && <button className="icon-btn danger" aria-label="Delete task" onClick={() => { onClose(); ui.deleteTask(t.id); }}><Icon name="i-trash" /></button>}
        <button className="icon-btn" data-close aria-label="Close" onClick={onClose}><Icon name="i-x" /></button>
      </div>
    </>
  );

  // Only active people can be picked; someone already set stays visible even if deactivated.
  // Private tasks can only be yours, so the pickers offer just you.
  const optionsFor = (current: string | null, none: string) => memberOptions(s.members, s.me.id, { none, keep: current, only: (m) => !t.private || m.id === s.me.id });
  const creator = s.members.find((m) => m.id === t.creatorId)?.name;

  return (
    <Sheet open onClose={onClose} labelledBy="dTitleLabel" head={head}>
      <div>
        <label className="sr-only" htmlFor="dTitle">Title</label>
        <textarea
          key={`${t.id}-${t.title}`}
          id="dTitle"
          className="field title-field"
          rows={2}
          defaultValue={t.title}
          maxLength={300}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.title) save({ title: v }, 'Rename'); }}
        />
        <label className="sr-only" htmlFor="dDesc">Description</label>
        <textarea
          key={`${t.id}-d-${t.description ?? ''}`}
          id="dDesc"
          className="field desc-field"
          rows={t.description ? Math.min(10, Math.max(3, t.description.split('\n').length + 1)) : 2}
          maxLength={5000}
          defaultValue={t.description || ''}
          placeholder="Add a description: what has to happen, and what done looks like"
          onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== t.description) save({ description: v }, 'Description'); }}
        />
      </div>

      <div>
        <span className="field-label">Status level</span>
        <div className="seg status-seg" role="group" aria-label="Status">
          {STATUS_NAMES.map((n, i) => (
            <button key={n} style={{ ['--sc' as string]: `var(--st${i})` }} aria-pressed={i === t.status} onClick={() => ui.changeStatus(t.id, i as Status)}>
              <Icon name={`s${i}`} />{n}
            </button>
          ))}
        </div>
      </div>

      {t.status === 2 && (
        <div>
          <label className="field-label" htmlFor="dReason">Blocked reason</label>
          <input key={t.blockedReason || ''} id="dReason" className="field" maxLength={200} defaultValue={t.blockedReason || ''} placeholder="What is needed to move forward?"
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.blockedReason) save({ blockedReason: v }, 'Blocked reason'); }} />
          <p className="muted" style={{ marginTop: 6 }}>Blocked for {ageLabel(daysSince(t.blockedAt))}. Visible on the team&apos;s blocked list.</p>
        </div>
      )}

      {t.status === 3 && (
        <div>
          <label className="field-label" htmlFor="dReviewer">Reviewer</label>
          <Select id="dReviewer" label="Reviewer" value={t.reviewerId || ''} options={optionsFor(t.reviewerId, 'No reviewer')} onChange={(v) => save({ reviewerId: v || null }, 'Reviewer')} />
        </div>
      )}

      {s.org.kind === 'personal' ? (
        <p className="private-note"><Icon name="i-lock" />Private to you.<button className="link-btn" onClick={ui.openTeamUp}>Create a team to share work</button></p>
      ) : (
        <div>
          <label className="field-label" htmlFor="dTeam">Team</label>
          <Select id="dTeam" label="Team" value={t.private ? 'personal' : t.teamId || ''}
            options={[...(t.private || t.creatorId === s.me.id ? [PERSONAL_OPTION] : []), NO_TEAM_OPTION, ...teamOptions(s.teams)]}
            onChange={(v) => {
              if (v === 'personal') store.setPrivate(t.id, true);
              else save(t.private ? { private: false, teamId: v || null } : { teamId: v || null }, t.private ? 'Share task' : 'Team');
            }} />
          {t.private && <p className="muted" style={{ marginTop: 6 }}>Only you can see this task. Pick a team to share it.</p>}
        </div>
      )}

      <div>
        <span className="field-label">Priority</span>
        <div className="seg" role="group" aria-label="Priority">
          {(['high', 'medium', 'low'] as Priority[]).map((p) => (
            <button key={p} data-pri={p} aria-pressed={t.priority === p} onClick={() => save({ priority: p }, 'Priority')}>{PRI_GLYPH[p]} {PRI_LABEL[p]}</button>
          ))}
        </div>
      </div>

      <div className="two">
        <div>
          <label className="field-label" htmlFor="dAssignee">Assignee</label>
          <Select id="dAssignee" label="Assignee" value={t.assigneeId || ''} options={optionsFor(t.assigneeId, 'Unassigned')} onChange={(v) => save({ assigneeId: v || null }, 'Assign')} />
        </div>
        <div>
          <label className="field-label" htmlFor="dDue">Due date</label>
          <input id="dDue" type="date" className="field" value={t.dueDate || ''} onChange={(e) => save({ dueDate: e.target.value || null }, 'Due date')} />
        </div>
      </div>

      <div className="two">
        <div>
          <label className="field-label" htmlFor="dTags">Tags</label>
          <input key={t.tags.join(',')} id="dTags" className="field" defaultValue={t.tags.join(', ')} placeholder="design, backend"
            onBlur={(e) => {
              const tags = [...new Set(e.target.value.split(/[,\s]+/).map((x) => x.replace(/^#/, '').toLowerCase()).filter(Boolean))];
              if (tags.join(',') !== t.tags.join(',')) save({ tags }, 'Tags');
            }} />
        </div>
        <div>
          <label className="field-label" htmlFor="dProject">Project</label>
          <input key={t.project || ''} id="dProject" className="field" maxLength={80} defaultValue={t.project || ''} placeholder="None"
            onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== t.project) save({ project: v }, 'Project'); }} />
        </div>
      </div>

      <div>
        <label className="field-label with-ico" htmlFor="dRemarks"><Icon name="i-note" />Remarks</label>
        <textarea key={`${t.id}-r-${t.remarks ?? ''}`} id="dRemarks" className="field" rows={2} maxLength={2000} defaultValue={t.remarks || ''}
          placeholder="Context, caveats, or anything to keep in mind"
          onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== t.remarks) save({ remarks: v }, 'Remarks'); }} />
      </div>

      <section>
        <span className="field-label with-ico"><Icon name="i-link" />Links{t.links.length ? ` · ${t.links.length}` : ''}</span>
        <LinksEditor links={t.links} onChange={(links) => save({ links }, 'Links')} idPrefix="dLink" />
      </section>

      <section>
        <span className="field-label with-ico"><Icon name="i-clip" />Attachments · {files ? files.length : t.attachmentCount}</span>
        {files === null && t.attachmentCount > 0 && <p className="muted">Loading…</p>}
        <AttachmentList taskId={t.id} items={files || []} onRemove={removeFile}
          canRemove={(a) => a.uploaderId === s.me.id || canDelete} />
        <div style={{ marginTop: (files?.length ?? 0) ? 10 : 0 }}>
          <FileDrop compact busy={uploading > 0} onFiles={(f) => void upload(f)} />
        </div>
      </section>

      <div className="row-gap" style={{ flexWrap: 'wrap', gap: 14 }}>
        {t.status !== 4 && (
          <button className="btn btn-3d btn-primary" onClick={() => store.toggleTimer(t.id)}>
            <Icon name={timerOn ? 'i-pause' : 'i-play'} />{timerOn ? 'Pause focus' : 'Start focus'}
          </button>
        )}
        <div className="stat-line">
          <span>Focus <b>{fmtDuration(t.timeSpent + (timerOn ? store.timerElapsed() : 0))}</b></span>
          <span>Added <b>{relTime(t.createdAt)}</b>{creator ? ` by ${creator}` : ''}</span>
        </div>
      </div>

      <section>
        <span className="field-label with-ico"><Icon name="i-comment" />Comments · {comments ? comments.length : t.commentCount}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
          {comments === null && t.commentCount > 0 && <p className="muted">Loading…</p>}
          {(comments || []).map((c) => (
            <div key={c.id} className="comment">
              <Avatar name={c.authorName} />
              <div className="bubble"><small><b>{c.authorName}</b> · {relTime(c.createdAt)}</small>{c.text}</div>
            </div>
          ))}
        </div>
        <form className="comment-form" id="commentForm" onSubmit={post}>
          <label className="sr-only" htmlFor="commentInput">Comment</label>
          <input className="field" id="commentInput" placeholder="Add a comment…" autoComplete="off" maxLength={2000} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn btn-3d btn-primary" aria-label="Post comment" disabled={posting}><Icon name="i-send" /></button>
        </form>
      </section>

      <section>
        <span className="field-label">Activity</span>
        <ul className="timeline">
          {activity.slice(0, 30).map((a) => (
            <li key={a.id}><div><b>{a.actorName}</b> · {a.change}<time>{relTime(a.createdAt)}</time></div></li>
          ))}
          {!activity.length && <li><div className="muted">History appears here once changes are saved.</div></li>}
        </ul>
      </section>
    </Sheet>
  );
}

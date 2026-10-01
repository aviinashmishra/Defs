'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { announce, toast } from '@/lib/client/bus';
import { PRI_GLYPH, PRI_LABEL, todayISO } from '@/lib/client/util';
import { ATTACH_MAX_BYTES, ATTACH_MAX_PER_TASK, STATUS_NAMES, type Priority, type Status, type TaskLink } from '@/lib/types';
import { useDayflow, useStore, useUI, type ComposerPreset } from './ctx';
import { FileDrop, LinksEditor, PendingFiles } from './Attachments';
import { Icon } from './Icons';
import { Modal } from './Overlays';
import { Select } from './Select';
import { memberOptions, NO_TEAM_OPTION, PERSONAL_OPTION, teamOptions } from './pickers';

const STATUS_HINT = ['Not started yet', 'Working on it now', 'Waiting on something', 'Ready for a check', 'Already finished'];

function Section({ icon, label, count, hint, htmlFor, children }: { icon: string; label: string; count?: number; hint?: string; htmlFor?: string; children: ReactNode }) {
  const Title = htmlFor ? 'label' : 'span';
  return (
    <section className="c-section">
      <div className="c-section-head">
        <span className="c-ico"><Icon name={icon} /></span>
        <Title className="c-label" {...(htmlFor ? { htmlFor } : {})}>{label}</Title>
        {!!count && <span className="c-count">{count}</span>}
        {hint && <span className="c-hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function TagInput({ tags, onChange, suggestions }: { tags: string[]; onChange: (t: string[]) => void; suggestions: string[] }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const next = raw.split(/[,\s]+/).map((x) => x.replace(/^#/, '').toLowerCase().trim().slice(0, 40)).filter(Boolean);
    if (next.length) onChange([...new Set([...tags, ...next])].slice(0, 20));
    setDraft('');
  };
  const rest = suggestions.filter((s) => !tags.includes(s)).slice(0, 5);
  return (
    <>
      <div className="tag-input field" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
        {tags.map((t) => (
          <span key={t} className="tagc">#{t}<button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}><Icon name="i-x" /></button></span>
        ))}
        <input id="cTags" value={draft} placeholder={tags.length ? '' : 'design, backend…'} onChange={(e) => { const v = e.target.value; if (/[,\s]$/.test(v)) add(v); else setDraft(v); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); add(draft); }
            else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={() => draft && add(draft)} />
      </div>
      {rest.length > 0 && (
        <div className="suggest">{rest.map((s) => <button key={s} type="button" className="chip xs" onClick={() => add(s)}>#{s}</button>)}</div>
      )}
    </>
  );
}

const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return todayISO(d); };
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return todayISO(d); };

export function Composer({ preset, onClose }: { preset: ComposerPreset | null; onClose: () => void }) {
  const open = preset !== null;
  // Esc and backdrop clicks go through the form's guarded close (asks before discarding).
  const guard = useRef<(() => void) | null>(null);
  return (
    <Modal open={open} onClose={() => (guard.current ? guard.current() : onClose())} labelledBy="cmpTitle" wide>
      {open && <ComposerForm preset={preset} onClose={onClose} guard={guard} />}
    </Modal>
  );
}

function ComposerForm({ preset, onClose, guard }: { preset: ComposerPreset; onClose: () => void; guard: { current: (() => void) | null } }) {
  const s = useDayflow();
  const store = useStore();
  const ui = useUI();
  const [title, setTitle] = useState(preset.title || '');
  const [description, setDescription] = useState('');
  const [remarks, setRemarks] = useState('');
  const [status, setStatus] = useState<Status>(preset.status ?? 0);
  const [blockedReason, setBlockedReason] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [due, setDue] = useState('');
  const [assigneeId, setAssigneeId] = useState<string>(s.me.id);
  // Starts on the team the board is showing (or your first team, or Personal).
  const [teamId, setTeamId] = useState<string>(store.defaultPrivate ? 'personal' : store.defaultTeamId ?? '');
  const personalSpace = s.org.kind === 'personal';
  const priv = personalSpace || teamId === 'personal';
  const [project, setProject] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const projects = useMemo(() => [...new Set(s.tasks.map((t) => t.project).filter(Boolean) as string[])].slice(0, 12), [s.tasks]);
  const knownTags = useMemo(() => {
    const n = new Map<string, number>();
    s.tasks.forEach((t) => t.tags.forEach((x) => n.set(x, (n.get(x) || 0) + 1)));
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [s.tasks]);

  const dirty = !!(description || remarks || links.length || files.length || comment || (title && title !== preset.title));
  // Closing with unsaved details asks first, so a long description is never lost to a stray Esc.
  const close = () => { if (!dirty || window.confirm('Discard this task? What you typed will be lost.')) onClose(); };
  guard.current = close;
  useEffect(() => () => { guard.current = null; }, [guard]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); document.getElementById('cmpSubmit')?.click(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const addFiles = (list: File[]) => {
    const room = ATTACH_MAX_PER_TASK - files.length;
    if (list.length > room) toast(`Up to ${ATTACH_MAX_PER_TASK} files per task`, { icon: 'i-clip' });
    setFiles([...files, ...list.slice(0, Math.max(0, room))]);
  };
  const tooBig = files.filter((f) => f.size > ATTACH_MAX_BYTES);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const name = title.trim();
    if (!name) { setError('Give the task a title.'); titleRef.current?.focus(); return; }
    if (status === 2 && s.me.settings.requireBlockedReason && !blockedReason.trim()) { setError('Say what is blocking it.'); reasonRef.current?.focus(); return; }
    if (tooBig.length) { setError(`Remove files over ${ATTACH_MAX_BYTES / 1024 / 1024} MB first.`); return; }

    const { created } = store.addTasks([{
      title: name, status, priority, due: due || null, assignee: null, assigneeId: assigneeId || null, teamId: priv ? null : teamId || null, private: priv, tags, project: project.trim() || null,
      blockedReason: status === 2 ? blockedReason.trim() || null : null, raw: '',
      description, remarks, links
    }], 'typed');
    const t = created[0];
    onClose();
    announce(`Added ${t.title}`);
    toast(`Created “${t.title}”`, { icon: 'i-plus', undo: ui.doUndo, actions: [{ label: 'Open', fn: () => ui.openDetail(t.id) }] });

    // Comments and files need the task to exist on the server; they follow once it is saved.
    const text = comment.trim();
    const queued = [...files];
    if (!text && !queued.length) return;
    void (async () => {
      if (text) {
        try { await store.addCommentWhenSaved(t.id, text); } catch (err) { toast(`Comment not posted: ${(err as Error).message}`, { icon: 'i-x', timeout: 7000 }); }
      }
      if (!queued.length) return;
      toast(`Uploading ${queued.length} ${queued.length > 1 ? 'files' : 'file'}…`, { icon: 'i-upload' });
      const failed: string[] = [];
      for (const f of queued) {
        try { await store.uploadAttachment(t.id, f); } catch (err) { failed.push(`${f.name}: ${(err as Error).message}`); }
      }
      const ok = queued.length - failed.length;
      if (!failed.length) toast(`Attached ${ok} ${ok > 1 ? 'files' : 'file'} to “${t.title}”`, { icon: 'i-clip', actions: [{ label: 'Open', fn: () => ui.openDetail(t.id) }] });
      else toast(`${ok} of ${queued.length} files attached. ${failed[0]}`, { icon: 'i-x', timeout: 9000 });
    })();
  };

  return (
    <form className="composer" onSubmit={submit} noValidate>
      <header className="composer-head">
        <span className="composer-badge" aria-hidden="true"><Icon name="i-plus" /></span>
        <div>
          <h2 id="cmpTitle">New task</h2>
          <p className="muted">Everything a teammate needs to pick it up.</p>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}><Icon name="i-x" /></button>
      </header>

      <div className="composer-grid">
        <div className="composer-main">
          <label className="sr-only" htmlFor="cTitle">Title</label>
          <input id="cTitle" ref={titleRef} data-autofocus className="field title-input" maxLength={300} placeholder="What needs doing?" value={title}
            onChange={(e) => { setTitle(e.target.value); setError(''); }} autoComplete="off" />

          <Section icon="i-text" label="Description" htmlFor="cDesc" hint={description.length > 4000 ? `${5000 - description.length} left` : undefined}>
            <textarea id="cDesc" className="field" rows={4} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="What has to happen, and what does done look like?" />
          </Section>

          <Section icon="i-note" label="Remarks" htmlFor="cRemarks">
            <textarea id="cRemarks" className="field" rows={2} maxLength={2000} value={remarks} onChange={(e) => setRemarks(e.target.value)}
              placeholder="Context, caveats, or anything to keep in mind" />
          </Section>

          <Section icon="i-link" label="Links" count={links.length}>
            <LinksEditor links={links} onChange={setLinks} idPrefix="cLink" />
          </Section>

          <Section icon="i-clip" label="Attachments" count={files.length}>
            <FileDrop onFiles={addFiles} />
            <PendingFiles files={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
          </Section>

          <Section icon="i-comment" label="First comment" htmlFor="cComment">
            <textarea id="cComment" className="field" rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="Kick off the conversation (optional)" />
          </Section>
        </div>

        <aside className="composer-side">
          <div>
            <span className="field-label">Status</span>
            <div className="status-pick" role="radiogroup" aria-label="Status">
              {STATUS_NAMES.map((n, i) => (
                <button key={n} type="button" role="radio" aria-checked={status === i} style={{ ['--sc' as string]: `var(--st${i})` }}
                  onClick={() => { setStatus(i as Status); if (i === 2) setTimeout(() => reasonRef.current?.focus(), 0); }}>
                  <Icon name={`s${i}`} /><span><b>{n}</b><small>{STATUS_HINT[i]}</small></span>
                </button>
              ))}
            </div>
            {status === 2 && (
              <input ref={reasonRef} className="field reason-in" maxLength={200} placeholder="What is blocking it?" aria-label="Blocked reason"
                value={blockedReason} onChange={(e) => { setBlockedReason(e.target.value); setError(''); }} />
            )}
          </div>

          <div>
            <span className="field-label">Priority</span>
            <div className="seg seg-fill" role="group" aria-label="Priority">
              {(['high', 'medium', 'low'] as Priority[]).map((p) => (
                <button key={p} type="button" data-pri={p} aria-pressed={priority === p} onClick={() => setPriority(p)}>{PRI_GLYPH[p]} {PRI_LABEL[p]}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="cDue">Due date</label>
            <input id="cDue" type="date" className="field" value={due} onChange={(e) => setDue(e.target.value)} />
            <div className="suggest">
              {[['Today', todayISO()], ['Tomorrow', addDays(1)], ['Next week', nextMonday()]].map(([l, v]) => (
                <button key={l} type="button" className="chip xs" aria-pressed={due === v} onClick={() => setDue(due === v ? '' : v)}>{l}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="cAssignee">Assignee</label>
            <Select id="cAssignee" value={assigneeId} onChange={setAssigneeId} label="Assignee"
              options={memberOptions(s.members, s.me.id, { none: 'Unassigned', only: (m) => !priv || m.id === s.me.id })} />
          </div>

          {personalSpace ? (
            <p className="private-note"><Icon name="i-lock" />Private to you. Create a team when you want to share.</p>
          ) : (
            <div>
              <label className="field-label" htmlFor="cTeam">Team</label>
              <Select id="cTeam" value={teamId} label="Team" onChange={(v) => { setTeamId(v); if (v === 'personal' && assigneeId) setAssigneeId(s.me.id); }}
                options={[PERSONAL_OPTION, NO_TEAM_OPTION, ...teamOptions(s.teams)]} />
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="cProject">Project</label>
            <input id="cProject" className="field" list="cProjects" maxLength={80} placeholder="None" value={project} onChange={(e) => setProject(e.target.value)} />
            <datalist id="cProjects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
          </div>

          <div>
            <label className="field-label" htmlFor="cTags">Tags</label>
            <TagInput tags={tags} onChange={setTags} suggestions={knownTags} />
          </div>
        </aside>
      </div>

      <footer className="composer-foot">
        {error ? <p className="field-error" role="alert">{error}</p> : <span className="muted foot-hint"><kbd>Ctrl</kbd> <kbd>Enter</kbd> to create</span>}
        <button type="button" className="btn btn-ghost" onClick={close}>Cancel</button>
        <button type="submit" id="cmpSubmit" className="btn btn-3d btn-primary"><Icon name="i-check" />Create task</button>
      </footer>
    </form>
  );
}

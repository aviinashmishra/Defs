'use client';
import { useRef } from 'react';
import { api } from '@/lib/client/api';
import { toast } from '@/lib/client/bus';
import { isOrgAdmin } from '@/lib/access';
import type { Settings } from '@/lib/types';
import { useDayflow, useStore, useUI } from './ctx';
import { Icon } from './Icons';
import { Sheet } from './Overlays';
import { Select } from './Select';

function Switch({ k, title, sub }: { k: keyof Settings; title: string; sub: string }) {
  const s = useDayflow();
  const store = useStore();
  return (
    <div className="toggle-row">
      <div><b>{title}</b><span>{sub}</span></div>
      <label className="switch">
        <input type="checkbox" checked={!!s.me.settings[k]} aria-label={title} onChange={(e) => store.updateSettings({ [k]: e.target.checked })} />
        <i />
      </label>
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useDayflow();
  const store = useStore();
  const ui = useUI();
  const file = useRef<HTMLInputElement>(null);
  const admin = isOrgAdmin(s.me);
  const myTeams = s.me.teams.map((m) => ({ ...m, team: s.teams.find((t) => t.id === m.teamId) })).filter((m) => m.team);

  const signOut = async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* cookie cleared below anyway */ }
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('dayflow.outbox.')).forEach((k) => localStorage.removeItem(k));
      if ('caches' in window) (await caches.keys()).forEach((k) => caches.delete(k));
    } catch { /* ignore */ }
    window.location.assign('/login');
  };

  return (
    <Sheet open={open} onClose={onClose} labelledBy="setTitle" head={<><h2 id="setTitle">Settings</h2><button className="icon-btn" data-close aria-label="Close" onClick={onClose}><Icon name="i-x" /></button></>}>
      <div className="set-group">
        <h3>You</h3>
        <label className="field-label" htmlFor="sName">Your name</label>
        <input key={s.me.name} id="sName" className="field" maxLength={80} defaultValue={s.me.name}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.me.name) store.updateName(v); }} />
        <label className="field-label" htmlFor="sTitle" style={{ marginTop: 12 }}>Job title</label>
        <input key={s.me.title || ''} id="sTitle" className="field" maxLength={80} defaultValue={s.me.title || ''} placeholder="e.g. Product designer"
          onBlur={(e) => { const v = e.target.value.trim(); if (v !== (s.me.title || '')) store.updateTitle(v); }} />
        <p className="muted" style={{ marginTop: 6 }}>{s.me.email} · {ROLE_LABEL[s.me.role] ?? s.me.role} of {s.org.name}</p>
      </div>

      {s.org.kind === 'personal' ? (
        <div className="set-group">
          <h3>Your space</h3>
          <div className="org-summary">
            <Icon name="i-lock" />
            <div>
              <b>{s.org.name}</b>
              <span className="muted">Just you. Every task here is private.</span>
            </div>
          </div>
          <button className="btn btn-3d btn-primary" style={{ width: '100%', marginTop: 10 }} onClick={() => { onClose(); ui.openTeamUp(); }}>
            <Icon name="i-users" />Create a team and invite people
          </button>
          <p className="muted" style={{ marginTop: 6 }}>Your tasks stay private. You choose which ones the team sees.</p>
        </div>
      ) : (
      <div className="set-group">
        <h3>Organization</h3>
        <div className="org-summary">
          <Icon name="i-org" />
          <div>
            <b>{s.org.name}</b>
            <span className="muted">
              {myTeams.length ? <>Your teams: {myTeams.map((m) => `${m.team!.name}${m.role === 'lead' ? ' (lead)' : ''}`).join(', ')}</> : 'You are not in a team yet'}
            </span>
          </div>
        </div>
        <button className="btn btn-ghost" style={{ width: '100%', marginTop: 10 }} onClick={() => { onClose(); ui.openOrg(admin ? 'people' : 'teams'); }}>
          <Icon name={admin ? 'i-user-plus' : 'i-users'} />{admin ? 'Manage people, teams and invites' : 'See teams and people'}
        </button>
      </div>
      )}

      <div className="set-group">
        <h3>Voice</h3>
        <label className="field-label" htmlFor="sLang">Speech language</label>
        <Select id="sLang" label="Speech language" value={s.me.settings.lang} onChange={(lang) => store.updateSettings({ lang })} options={[
          { value: 'en-IN', label: 'English (India)', hint: 'Works with Hinglish', icon: 'i-mic' },
          { value: 'hi-IN', label: 'Hindi', hint: 'हिन्दी', icon: 'i-mic' },
          { value: 'en-US', label: 'English (US)', icon: 'i-mic' },
          { value: 'en-GB', label: 'English (UK)', icon: 'i-mic' }
        ]} />
        <div className="toggle-row" style={{ marginTop: 8 }}>
          <div>
            <b>Hands-free “Hey Dayflow”</b>
            <span>{ui.voice.wake === 'blocked' ? 'The microphone is blocked. Allow it from the lock icon in the address bar.'
              : ui.voice.wake === 'waiting' ? 'Turns on once you allow the microphone'
              : 'While this tab is open, say “Hey Dayflow” and then a task or your day’s story. Computers only.'}</span>
          </div>
          <label className="switch">
            <input type="checkbox" checked={s.me.settings.wakeWord} aria-label="Hands-free Hey Dayflow"
              onChange={(e) => { store.updateSettings({ wakeWord: e.target.checked }); if (e.target.checked && matchMedia('(pointer: fine)').matches) ui.voice.armWake(); }} />
            <i />
          </label>
        </div>
        <p className="muted" style={{ marginTop: 6 }}>Your browser&apos;s speech service turns audio into text. Dayflow stores only the text, never recordings. Longer stories are sorted into tasks by Google Gemini, which receives only the text.</p>
      </div>

      <div className="set-group">
        <h3>Board</h3>
        <Switch k="requireBlockedReason" title="Ask why when blocked" sub="A short note goes to the team blocked list" />
        <Switch k="weightByPriority" title="Weight progress by priority" sub="High counts 3×, medium 2×, low 1×" />
        <Switch k="shareFocusInStandup" title="Show focus time in standup" sub="Off by default. The timer is for you." />
        <div className="toggle-row">
          <div><b>Focus session length</b><span>Chime and nudge for a break</span></div>
          <Select variant="sm" label="Focus session length" value={String(s.me.settings.pomodoro)} align="end" minWidth={180}
            onChange={(v) => store.updateSettings({ pomodoro: Number(v) })}
            options={[0, 15, 25, 45, 50].map((m) => ({ value: String(m), label: m ? `${m} min` : 'Off', icon: m ? 'i-clock' : 'i-x' }))} />
        </div>
      </div>

      <div className="set-group">
        <h3>Look and feel</h3>
        <div className="seg" role="group" aria-label="Theme">
          {(['auto', 'dark', 'light'] as const).map((v) => (
            <button key={v} aria-pressed={s.me.settings.theme === v} onClick={() => store.updateSettings({ theme: v })}>{v[0].toUpperCase() + v.slice(1)}</button>
          ))}
        </div>
        <Switch k="effects3d" title="Motion effects" sub="Card animations and background glow. Turns off automatically with reduced motion." />
        <Switch k="haptics" title="Haptic feedback" sub="Small vibrations on phones" />
      </div>

      <div className="set-group">
        <h3>Data</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Your team&apos;s board is saved in the cloud. Export a copy any time, or bring in tasks from the earlier single-user prototype.</p>
        <div className="row-gap" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={() => {
            const blob = new Blob([store.exportJSON()], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `dayflow-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}>Export JSON</button>
          <button className="btn btn-ghost" onClick={() => file.current?.click()}>Import prototype JSON</button>
          <input ref={file} type="file" accept="application/json,.json" className="sr-only" aria-label="Import file" onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            f.text().then((txt) => {
              try {
                const n = store.importPrototype(txt);
                toast(n ? `Imported ${n} tasks` : 'No tasks found in that file', { icon: 'i-sparkle', undo: n ? ui.doUndo : undefined });
              } catch (err) { toast(`Import failed: ${(err as Error).message}`, { icon: 'i-x' }); }
            });
            e.target.value = '';
          }} />
        </div>
      </div>

      <div className="set-group">
        <button className="btn btn-ghost" style={{ width: '100%', marginBottom: 10 }} onClick={() => { onClose(); ui.openHelp(); }}><Icon name="i-help" />Shortcuts and voice tips</button>
        <button className="btn btn-ghost" style={{ width: '100%' }} onClick={signOut}><Icon name="i-logout" />Sign out</button>
      </div>
    </Sheet>
  );
}

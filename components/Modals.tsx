'use client';
import { toast } from '@/lib/client/bus';
import { standupText } from '@/lib/client/standup';
import { copyText } from '@/lib/client/util';
import type { Settings } from '@/lib/types';
import { useDayflow, useStore, useUI } from './ctx';
import { Icon } from './Icons';
import { Modal } from './Overlays';

export function StandupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useDayflow();
  const store = useStore();
  const ui = useUI();
  const fmt = s.me.settings.standupFormat;
  const text = open ? standupText(s, fmt) : '';
  const formats: Array<[Settings['standupFormat'], string]> = [['status', 'By status'], ['ytb', 'Yesterday · Today · Blockers'], ['slack', 'Slack markdown']];
  return (
    <Modal open={open} onClose={onClose} labelledBy="suTitle" wide>
      <header className="panel-head">
        <h2 id="suTitle">Your standup</h2>
        <button className="icon-btn" data-cancel aria-label="Close" onClick={onClose}><Icon name="i-x" /></button>
      </header>
      <div className="seg" role="group" aria-label="Format">
        {formats.map(([k, label]) => (
          <button key={k} aria-pressed={fmt === k} onClick={() => store.updateSettings({ standupFormat: k })}>{label}</button>
        ))}
      </div>
      <pre className="report" id="suText">{text}</pre>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={ui.clearDone}>Clear done column</button>
        <button className="btn btn-3d btn-primary" onClick={async () => toast((await copyText(text)) ? 'Standup copied' : 'Select the text and copy it manually', { icon: 'i-copy' })}>
          <Icon name="i-copy" /><span>Copy</span>
        </button>
      </div>
    </Modal>
  );
}

export function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="helpTitle" wide>
      <header className="panel-head">
        <h2 id="helpTitle">Speak or type naturally</h2>
        <button className="icon-btn" data-cancel aria-label="Close" onClick={onClose}><Icon name="i-x" /></button>
      </header>
      <div className="help-grid">
        <section>
          <h3>Voice &amp; typing keywords</h3>
          <dl className="kw">
            <dt>Status</dt><dd>in progress, working on, blocked, stuck, waiting, review, done · <i>chal raha, atka, ho gaya</i></dd>
            <dt>Priority</dt><dd>urgent, important, high priority, low priority · <i>zaroori</i></dd>
            <dt>Due</dt><dd>today, tomorrow, by Friday, next week, 15th Oct, in 3 days · <i>kal tak</i></dd>
            <dt>People</dt><dd>assign to Priya, @rahul (teammates by name)</dd>
            <dt>Tags</dt><dd>#backend, tag design, project Apollo</dd>
            <dt>Blocker</dt><dd>blocked by legal approval → saves the reason</dd>
            <dt>Many tasks</dt><dd>say “next task” between them · <i>agla task</i></dd>
            <dt>Update</dt><dd>“mark checkout bug as done”, “start invoice call”, “pause timer”, “undo”</dd>
          </dl>
        </section>
        <section>
          <h3>Keyboard</h3>
          <dl className="kw keys">
            <dt><kbd>Ctrl</kbd> <kbd>K</kbd></dt><dd>Command palette: find any task, team or action, or type a new task</dd>
            <dt><kbd>N</kbd></dt><dd>Quick add (type or speak)</dd>
            <dt><kbd>T</kbd></dt><dd>New task with details, links &amp; files</dd>
            <dt><kbd>M</kbd></dt><dd>My tasks</dd>
            <dt><kbd>H</kbd></dt><dd>Task history: every task, filter and export</dd>
            <dt><kbd>E</kbd></dt><dd>Export to Excel, PDF or CSV</dd>
            <dt><kbd>V</kbd></dt><dd>Voice capture</dd>
            <dt><kbd>/</kbd></dt><dd>Search</dd>
            <dt><kbd>S</kbd></dt><dd>Copy standup</dd>
            <dt><kbd>O</kbd></dt><dd>Organization (or Insights in a personal space)</dd>
            <dt><kbd>I</kbd></dt><dd>Company dashboard</dd>
            <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Move focused card down / up a level</dd>
            <dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>Set level of focused card</dd>
            <dt><kbd>Space</kbd></dt><dd>Start / pause focus timer</dd>
            <dt><kbd>Enter</kbd></dt><dd>Open details</dd>
            <dt><kbd>Del</kbd></dt><dd>Delete (undo available)</dd>
            <dt><kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo</dd>
          </dl>
        </section>
      </div>
    </Modal>
  );
}

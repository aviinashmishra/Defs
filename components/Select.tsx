'use client';
/*
 * Themed replacements for <select>: Select (one value), MultiSelect (filters) and
 * MenuButton (actions). The list renders in a portal above modals and sheets, so it is
 * never clipped by a scrolling parent; it opens upward when there is no room below,
 * keeps to the screen edges, and becomes a bottom sheet on phones. Keyboard: arrows,
 * Home/End, Enter/Space, type-to-jump, Esc (closes only the list, not the dialog under it).
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';
import { useEscape } from './Overlays';
import './select.css';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** Second, smaller line under the label. */
  hint?: string;
  /** Sprite id such as 's1' or 'i-users'. */
  icon?: string;
  /** Tints the icon; without an icon, shows a dot in this color. */
  color?: string;
  /** Custom leading visual, e.g. an avatar. */
  lead?: ReactNode;
  count?: number;
  /** Heading shown above the first option of each run of options with the same group. */
  group?: string;
  disabled?: boolean;
}

type Variant = 'field' | 'pill' | 'sm';
type Mode = 'single' | 'multi' | 'menu';

// ---------------------------------------------------------------- shared popover list
interface PickerProps<V extends string> {
  anchor: HTMLElement;
  listId: string;
  title?: string;
  options: SelectOption<V>[];
  mode: Mode;
  isOn: (v: V) => boolean;
  onPick: (v: V) => void;
  onClose: (refocus: boolean) => void;
  searchable: boolean;
  minWidth?: number;
  align?: 'start' | 'end';
  footer?: ReactNode;
}

const SHEET_QUERY = '(max-width: 560px)';
const GAP = 6;
const EDGE = 8;

function Picker<V extends string>({ anchor, listId, title, options, mode, isOn, onPick, onClose, searchable, minWidth = 220, align = 'start', footer }: PickerProps<V>) {
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [sheet] = useState(() => matchMedia(SHEET_QUERY).matches);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  const typed = useRef({ text: '', at: 0 });

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(k)) : options;
  }, [options, q]);
  const enabled = (i: number) => !!shown[i] && !shown[i].disabled;
  const [active, setActive] = useState(() => {
    const i = options.findIndex((o) => isOn(o.value) && !o.disabled);
    return i >= 0 ? i : options.findIndex((o) => !o.disabled);
  });
  // Typing in the search box highlights the first match (re-renders of the parent leave the highlight alone).
  const firstQ = useRef(true);
  useEffect(() => {
    if (firstQ.current) { firstQ.current = false; return; }
    setActive(shown.findIndex((o) => !o.disabled));
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  // Place next to the trigger: below if it fits, otherwise wherever there is more room.
  useLayoutEffect(() => {
    if (sheet) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) { onClose(false); return; }
      const below = innerHeight - r.bottom - EDGE - GAP, above = r.top - EDGE - GAP;
      const up = below < 260 && above > below;
      const maxWidth = innerWidth - EDGE * 2;
      const width = pop.current?.offsetWidth ?? Math.max(r.width, minWidth);
      let left = align === 'end' ? r.right - width : r.left;
      left = Math.max(EDGE, Math.min(left, innerWidth - EDGE - width));
      setPos({
        left, minWidth: Math.min(maxWidth, Math.max(r.width, minWidth)), maxWidth,
        maxHeight: Math.max(150, Math.min(440, up ? above : below)),
        ...(up ? { bottom: innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
        transformOrigin: up ? '50% 100%' : '50% 0'
      });
    };
    place();
    // Second pass once the real width is known.
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, sheet, minWidth, align, onClose]);

  // Click anywhere else closes (without stealing focus from what was clicked).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      // The phone scrim closes on its own click, so the tap does not land on what is under it.
      if (pop.current?.contains(t) || anchor.contains(t) || (t as Element).classList?.contains('sel-scrim')) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [anchor, onClose]);

  useEffect(() => {
    const t = setTimeout(() => (search.current ?? list.current)?.focus({ preventScroll: true }), 10);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (enabled(i)) return i;
    return from;
  };
  const choose = (i: number) => { if (enabled(i)) onPick(shown[i].value); };

  const onKey = (e: React.KeyboardEvent) => {
    // The list lives in a portal; keep its keys away from forms and dialogs it was opened from.
    e.stopPropagation();
    const inSearch = e.target === search.current;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => step(a, 1)); break;
      case 'ArrowUp': e.preventDefault(); setActive((a) => step(a, -1)); break;
      case 'Home': if (!inSearch) { e.preventDefault(); setActive(step(-1, 1)); } break;
      case 'End': if (!inSearch) { e.preventDefault(); setActive(step(shown.length, -1)); } break;
      case 'PageDown': e.preventDefault(); setActive((a) => { let n = a; for (let k = 0; k < 8; k++) n = step(n, 1); return n; }); break;
      case 'PageUp': e.preventDefault(); setActive((a) => { let n = a; for (let k = 0; k < 8; k++) n = step(n, -1); return n; }); break;
      case 'Enter': e.preventDefault(); choose(active); break;
      case ' ': if (!inSearch) { e.preventDefault(); choose(active); } break;
      case 'Tab': e.preventDefault(); onClose(true); break;
      default:
        // Type to jump (when there is no search box to type into).
        if (!inSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
          const i = shown.findIndex((o, n) => !o.disabled && n !== active && o.label.toLowerCase().startsWith(typed.current.text));
          const j = i >= 0 ? i : shown.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
          if (j >= 0) setActive(j);
        }
    }
  };

  const withLead = options.some((o) => o.lead || o.icon || o.color);
  const optId = (i: number) => `${listId}-o${i}`;
  let lastGroup: string | undefined;

  const body = (
    <div
      ref={pop}
      className={`sel-pop${sheet ? ' sel-sheet' : ''}${mode === 'menu' ? ' sel-menu' : ''}`}
      style={sheet ? undefined : pos}
      onKeyDown={onKey}
      onClick={(e) => e.stopPropagation()}
    >
      {sheet && (
        <div className="sel-sheet-head">
          <div className="sel-grab" aria-hidden="true" />
          <b>{title || 'Choose'}</b>
          <button type="button" className="icon-btn sm" aria-label="Close" onClick={() => onClose(true)}><Icon name="i-x" /></button>
        </div>
      )}
      {searchable && (
        <div className="sel-search">
          <Icon name="i-search" />
          <input ref={search} type="search" placeholder="Search…" value={q} aria-label="Filter options"
            aria-controls={listId} aria-activedescendant={active >= 0 ? optId(active) : undefined} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div
        ref={list}
        id={listId}
        className="sel-list"
        role={mode === 'menu' ? 'menu' : 'listbox'}
        aria-label={title}
        aria-multiselectable={mode === 'multi' || undefined}
        aria-activedescendant={active >= 0 ? optId(active) : undefined}
        tabIndex={-1}
      >
        {shown.map((o, i) => {
          const on = mode !== 'menu' && isOn(o.value);
          const head = o.group && o.group !== lastGroup ? <div className="sel-group" role="presentation">{o.group}</div> : null;
          lastGroup = o.group;
          return (
            <div key={o.value} style={{ display: 'contents' }}>
              {head}
              <div
                id={optId(i)}
                data-i={i}
                role={mode === 'menu' ? 'menuitem' : 'option'}
                aria-selected={mode === 'menu' ? undefined : on}
                aria-disabled={o.disabled || undefined}
                className={`sel-opt${i === active ? ' active' : ''}${on ? ' on' : ''}${o.disabled ? ' disabled' : ''}`}
                onPointerMove={() => { if (!o.disabled && i !== active) setActive(i); }}
                onClick={() => choose(i)}
              >
                {withLead && (
                  <span className="sel-lead" style={o.color ? { ['--oc' as string]: o.color } : undefined}>
                    {o.lead ?? (o.icon ? <Icon name={o.icon} /> : o.color ? <i className="sel-dot" /> : null)}
                  </span>
                )}
                <span className="sel-text"><span className="sel-label">{o.label}</span>{o.hint && <small>{o.hint}</small>}</span>
                {o.count !== undefined && <span className="sel-count">{o.count}</span>}
                {mode === 'multi' ? <span className="sel-box" aria-hidden="true"><Icon name="i-check" /></span>
                  : mode === 'single' ? <span className="sel-tick" aria-hidden="true">{on && <Icon name="i-check" />}</span> : null}
              </div>
            </div>
          );
        })}
        {!shown.length && <p className="sel-empty">No matches for “{q}”</p>}
      </div>
      {footer && <div className="sel-foot">{footer}</div>}
    </div>
  );

  return createPortal(sheet ? <><div className="sel-scrim" onClick={() => onClose(false)} />{body}</> : body, document.body);
}

/** Open/close state shared by the three triggers. Esc closes only the list. */
function useOpen() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef((refocus: boolean) => {
    setOpen(false);
    if (refocus) setTimeout(() => trigger.current?.focus({ preventScroll: true }), 0);
  }).current;
  useEscape(open, () => close(true));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setOpen(true); }
  };
  return { open, setOpen, trigger, close, onKeyDown };
}

const Chevron = () => <svg className="sel-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;

function Lead({ o }: { o?: SelectOption<string> }) {
  if (!o) return null;
  if (o.lead) return <span className="sel-lead">{o.lead}</span>;
  if (o.icon) return <span className="sel-lead" style={o.color ? { ['--oc' as string]: o.color } : undefined}><Icon name={o.icon} /></span>;
  if (o.color) return <span className="sel-lead" style={{ ['--oc' as string]: o.color }}><i className="sel-dot" /></span>;
  return null;
}

// ---------------------------------------------------------------- Select
export interface SelectProps<V extends string> {
  value: V;
  options: SelectOption<V>[];
  onChange: (v: V) => void;
  id?: string;
  /** Accessible name when no <label htmlFor> points at this control; also the phone sheet title. */
  label?: string;
  variant?: Variant;
  /** Icon shown at the start of the trigger, before the chosen option. */
  icon?: string;
  disabled?: boolean;
  className?: string;
  /** Text shown when the value matches no option. */
  placeholder?: string;
  searchable?: boolean;
  minWidth?: number;
  align?: 'start' | 'end';
  /** Show the chosen option's count in the trigger. */
  showCount?: boolean;
  title?: string;
}

export function Select<V extends string>({
  value, options, onChange, id, label, variant = 'field', icon, disabled, className = '', placeholder = 'Choose…', searchable, minWidth, align, showCount, title
}: SelectProps<V>) {
  const { open, setOpen, trigger, close, onKeyDown } = useOpen();
  const listId = useId();
  const cur = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={id}
        className={`sel sel-${variant}${open ? ' open' : ''} ${className}`.trim()}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label ? `${label}: ${cur ? cur.label : placeholder}` : undefined}
        title={title}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
      >
        {icon ? <span className="sel-lead"><Icon name={icon} /></span> : <Lead o={cur} />}
        <span className={`sel-value${cur ? '' : ' empty'}`}>{cur ? cur.label : placeholder}</span>
        {showCount && cur?.count !== undefined && <span className="sel-count">{cur.count}</span>}
        <Chevron />
      </button>
      {open && trigger.current && (
        <Picker
          anchor={trigger.current} listId={listId} title={label || cur?.label} options={options} mode="single"
          isOn={(v) => v === value} onPick={(v) => { if (v !== value) onChange(v); close(true); }} onClose={close}
          searchable={searchable ?? options.length > 9} minWidth={minWidth} align={align}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- MultiSelect
export interface MultiSelectProps<V extends string> {
  /** Empty means "any": nothing filtered out. */
  values: V[];
  options: SelectOption<V>[];
  onChange: (v: V[]) => void;
  label: string;
  /** Trigger text when nothing is picked, e.g. "Any status". */
  anyLabel: string;
  icon?: string;
  variant?: Variant;
  id?: string;
  searchable?: boolean;
  minWidth?: number;
  align?: 'start' | 'end';
  className?: string;
}

export function MultiSelect<V extends string>({ values, options, onChange, label, anyLabel, icon, variant = 'pill', id, searchable, minWidth = 240, align, className = '' }: MultiSelectProps<V>) {
  const { open, setOpen, trigger, close, onKeyDown } = useOpen();
  const listId = useId();
  const picked = options.filter((o) => values.includes(o.value));
  const text = !picked.length ? anyLabel : picked.length === 1 ? picked[0].label : `${picked[0].label} +${picked.length - 1}`;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={id}
        className={`sel sel-${variant}${open ? ' open' : ''}${picked.length ? ' has-value' : ''} ${className}`.trim()}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${text}`}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
      >
        {icon && <span className="sel-lead"><Icon name={icon} /></span>}
        <span className="sel-value">{text}</span>
        {picked.length > 1 && <span className="sel-badge">{picked.length}</span>}
        <Chevron />
      </button>
      {open && trigger.current && (
        <Picker
          anchor={trigger.current} listId={listId} title={label} options={options} mode="multi"
          isOn={(v) => values.includes(v)}
          onPick={(v) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])}
          onClose={close} searchable={searchable ?? options.length > 9} minWidth={minWidth} align={align}
          footer={
            <>
              <button type="button" className="link-btn" disabled={!values.length} onClick={() => onChange([])}>Clear</button>
              <span className="sel-foot-n">{values.length ? `${values.length} selected` : anyLabel}</span>
              <button type="button" className="btn btn-primary sel-done" onClick={() => close(true)}>Done</button>
            </>
          }
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- MenuButton
export interface MenuItem extends Omit<SelectOption<string>, 'value'> {
  key: string;
  onSelect: () => void;
}

export function MenuButton({ items, children, className = 'btn btn-ghost', label, align = 'end', minWidth = 260, disabled }: {
  items: MenuItem[]; children: ReactNode; className?: string; label: string; align?: 'start' | 'end'; minWidth?: number; disabled?: boolean;
}) {
  const { open, setOpen, trigger, close, onKeyDown } = useOpen();
  const listId = useId();
  const opts = items.map(({ key, onSelect: _run, ...o }) => ({ ...o, value: key }));
  return (
    <>
      <button ref={trigger} type="button" className={`${className}${open ? ' open' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-label={label} disabled={disabled} onClick={() => setOpen(!open)} onKeyDown={onKeyDown}>
        {children}
      </button>
      {open && trigger.current && (
        <Picker anchor={trigger.current} listId={listId} title={label} options={opts} mode="menu" isOn={() => false}
          onPick={(k) => { close(true); items.find((i) => i.key === k)?.onSelect(); }} onClose={close} searchable={false} minWidth={minWidth} align={align} />
      )}
    </>
  );
}

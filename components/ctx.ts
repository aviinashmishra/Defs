'use client';
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { DayflowStore, State } from '@/lib/client/store';
import type { Source, Status, Task } from '@/lib/types';
import type { ExportOptions } from '@/lib/client/export';

export const StoreCtx = createContext<DayflowStore | null>(null);

export function useStore(): DayflowStore {
  const s = useContext(StoreCtx);
  if (!s) throw new Error('StoreCtx missing');
  return s;
}

export function useDayflow(): State {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, s.getState, s.getState);
}

export type View = 'board' | 'mine' | 'history' | 'org';
export type OrgTab = 'overview' | 'teams' | 'people' | 'audit';
/** Which tasks the board shows: 'all', 'personal' (private to you), 'none' (shared, no team) or a team id. */
export type BoardTeam = string;

/** Values the full task form can open with. */
export interface ComposerPreset { title?: string; status?: Status }

/**
 * Hands-free "Hey Dayflow": off (setting off, phone, or no speech support), waiting (the
 * microphone has not been allowed yet), blocked (it was denied) or on.
 */
export type WakeState = 'off' | 'waiting' | 'blocked' | 'on';

export interface VoiceApi {
  supported: boolean;
  /** True while a task is being captured (mic tapped, or after "Hey Dayflow"). */
  listening: boolean;
  status: { msg: string; error: boolean } | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  wake: WakeState;
  /** Starts hands-free listening from a tap, asking for the microphone if needed. */
  armWake: () => void;
  /** Shows (or clears) a line in the voice status area. */
  note: (msg: string | null, error?: boolean) => void;
}

export interface UI {
  view: View;
  setView: (v: View) => void;
  search: string;
  setSearch: (v: string) => void;
  chip: string;
  setChip: (v: string) => void;
  mobileCol: number;
  selectCol: (i: number) => void;
  bumped: { status: number; n: number };
  phone: boolean;
  flat: boolean;
  dark: boolean;
  openDetail: (id: string) => void;
  openSettings: () => void;
  openComposer: (preset?: ComposerPreset) => void;
  orgTab: OrgTab;
  openOrg: (tab?: OrgTab) => void;
  boardTeam: BoardTeam;
  setBoardTeam: (t: BoardTeam) => void;
  openNotifications: () => void;
  /** Command palette (Ctrl/⌘ K). */
  openPalette: () => void;
  /** Personal space → team workspace wizard (or the Teams tab when teams already exist). */
  openTeamUp: () => void;
  openExport: (preset?: Partial<ExportOptions>) => void;
  openStandup: () => void;
  openHelp: () => void;
  copyStandup: () => void;
  clearDone: () => void;
  deleteTask: (id: string) => void;
  doUndo: () => void;
  feedback: (t: Task, status: Status, rect: DOMRect | null, withToast?: boolean) => void;
  changeStatus: (id: string, status: Status, opts?: { el?: Element | null; toast?: boolean; reason?: string }) => Promise<boolean>;
  capture: { text: string; setText: (v: string) => void; commit: (text: string, source: Source) => boolean };
  voice: VoiceApi;
  focusAfterRender: (id: string) => void;
  takePendingFocus: () => string | null;
}

export const UICtx = createContext<UI | null>(null);

export function useUI(): UI {
  const ui = useContext(UICtx);
  if (!ui) throw new Error('UICtx missing');
  return ui;
}

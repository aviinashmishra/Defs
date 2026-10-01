'use client';
// Option lists shared by every people / team picker, so they look the same everywhere.
import type { Member, OrgTeam } from '@/lib/types';
import type { SelectOption } from './Select';
import { Avatar } from './TaskCard';

/** Teammates with avatars. `none` adds a first option for "nobody" (value ''). */
export function memberOptions(members: Member[], meId: string, opts: { none?: string; keep?: string | null; inactive?: boolean; only?: (m: Member) => boolean } = {}): SelectOption[] {
  const list = members.filter((m) => (m.active || opts.inactive || m.id === opts.keep) && (!opts.only || opts.only(m)));
  // You first, then everyone else by name.
  list.sort((a, b) => Number(b.id === meId) - Number(a.id === meId) || a.name.localeCompare(b.name));
  const out: SelectOption[] = list.map((m) => ({
    value: m.id, label: m.id === meId ? `${m.name} (you)` : m.name, hint: m.active ? m.title || m.email : 'Deactivated', lead: <Avatar name={m.name} cls="xs" />
  }));
  if (opts.none !== undefined) out.unshift({ value: '', label: opts.none, icon: 'i-user', color: 'var(--muted)' });
  return out;
}

/** Teams with their color dot. */
export function teamOptions(teams: OrgTeam[], label: (t: OrgTeam) => string = (t) => t.name): SelectOption[] {
  return teams.map((t) => ({ value: t.id, label: label(t), hint: t.description || undefined, color: t.color }));
}

export const PERSONAL_OPTION: SelectOption = { value: 'personal', label: 'Personal', hint: 'Private, only you can see it', icon: 'i-lock', color: 'var(--accent-2)' };
export const NO_TEAM_OPTION: SelectOption = { value: '', label: 'No team', hint: 'Shared with the organization', icon: 'i-users', color: 'var(--st0)' };

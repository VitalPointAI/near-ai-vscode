// Who is attending a staff project now (research note 11, 4.5; owner decision Q5, 2026-11-18: standing watches run only in attended runs until Phase 74
// run contracts exist). A person's staff run in the chat and an open Staff Room each hold the project's attendance while they last; standing watches
// are evaluated only while at least one holder is there, and nothing evaluates them in the background. No vscode, no I/O.
import * as path from 'node:path';

/** What holds attendance: a person's staff run (by its run id) or the Staff Room panel. */
export type AttendanceHolder = { readonly kind: 'run'; readonly id: string } | { readonly kind: 'staff-room'; readonly id: string };

export interface AttendanceChange {
  readonly root: string;
  readonly attended: boolean;
  /** The holder that came or went. */
  readonly holder: AttendanceHolder;
  readonly change: 'start' | 'end';
}

const holders = new Map<string, Map<string, AttendanceHolder>>();
const listeners = new Set<(change: AttendanceChange) => void>();

const keyOf = (root: string): string => path.resolve(root);
const holderKey = (holder: AttendanceHolder): string => `${holder.kind}:${holder.id}`;

/** Whether a person is attending the project now. */
export function isAttended(root: string): boolean {
  return (holders.get(keyOf(root))?.size ?? 0) > 0;
}

/** The holders now, for the Staff Room and the tests. */
export function attendanceHolders(root: string): AttendanceHolder[] {
  return [...(holders.get(keyOf(root))?.values() ?? [])];
}

/** Holds attendance until the returned function is called (once; later calls do nothing). */
export function attend(root: string, holder: AttendanceHolder): () => void {
  const key = keyOf(root);
  const set = holders.get(key) ?? new Map<string, AttendanceHolder>();
  holders.set(key, set);
  const id = holderKey(holder);
  const fresh = !set.has(id);
  set.set(id, holder);
  if (fresh) notify({ root: key, attended: true, holder, change: 'start' });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = holders.get(key);
    if (!current?.delete(id)) return;
    if (current.size === 0) holders.delete(key);
    notify({ root: key, attended: isAttended(key), holder, change: 'end' });
  };
}

/** Called on every start and end of attendance. Returns the function that stops it. */
export function onAttendance(listener: (change: AttendanceChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(change: AttendanceChange): void {
  for (const listener of listeners) { try { listener(change); } catch { /* a listener never stops attendance */ } }
}

/** For tests: forget every holder and listener. */
export function resetAttendance(): void {
  holders.clear();
  listeners.clear();
}

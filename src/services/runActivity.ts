// Whether an agent run is in progress anywhere in this window, so Update Team never rewrites a team
// while a run is using it, and can be offered again when the last run ends.

let active = 0;
const idle = new Set<() => void>();

/** Marks a run as started; call the returned function when it ends (in a finally). */
export function beginRun(): () => void {
  active += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active = Math.max(0, active - 1);
    if (active === 0) for (const listener of [...idle]) { idle.delete(listener); listener(); }
  };
}

export function runInProgress(): boolean { return active > 0; }

/** Calls `listener` once, as soon as no run is in progress (now, if none is). */
export function whenIdle(listener: () => void): void {
  if (active === 0) listener(); else idle.add(listener);
}

// The sync connection machine of one shared project on one device (DESIGN 15.3, Phase 33 D-09). Pure: events in, state out, with the time passed
// in; no I/O, no clock, no timers, no Yjs and no imports, so the hub's own tests can bundle it. The live replicator (src/staff/replica) owns the
// timers and turns each exchange report into an event.
//
// States (D-09: exactly the eight of DESIGN 15.3, plus needs-update from D-06):
//   single-machine   not shared through your organization's server
//   connecting       opening TLS to the server and checking its pin
//   authenticating   the signed challenge
//   catching-up      exchanging what each side lacks
//   live             pushing and receiving
//   offline          working on this computer only
//   refused          the server does not accept this device
//   attention        a person must act
//   needs-update     the project needs a newer version of the extension
//
// The happy path: start with a server --> connecting --connected--> authenticating --session-ok--> catching-up --caught-up--> live, and a synced
// exchange keeps live. Start without a server stays single-machine; stop from any state ends in single-machine.

export const SYNC_STATES = ['single-machine', 'connecting', 'authenticating', 'catching-up', 'live', 'offline', 'refused', 'attention', 'needs-update'] as const;
export type SyncState = typeof SYNC_STATES[number];

/** How one exchange ended: the end states of syncOnce, plus needs-update (D-06, D-07). */
export type ExchangeOutcome = 'synced' | 'offline' | 'refused' | 'attention' | 'needs-update';

export type SyncEvent =
  | { kind: 'start'; hasHub: boolean }
  | { kind: 'connected' }
  | { kind: 'session-ok' }
  | { kind: 'caught-up' }
  | { kind: 'exchange'; outcome: ExchangeOutcome; reason?: string; findings?: readonly string[]; retryAfterMs?: number }
  | { kind: 'timeout' }
  | { kind: 'lost' }
  | { kind: 'retry' }
  | { kind: 'sync-now' }
  | { kind: 'network-change' }
  | { kind: 'lead-acted' }
  | { kind: 'updated' }
  | { kind: 'stop' };
export type SyncEventKind = SyncEvent['kind'];
export const SYNC_EVENT_KINDS: readonly SyncEventKind[] = ['start', 'connected', 'session-ok', 'caught-up', 'exchange', 'timeout', 'lost', 'retry', 'sync-now', 'network-change', 'lead-acted', 'updated', 'stop'];

export interface SyncMachineState {
  state: SyncState;
  /** When this state was entered, in milliseconds since the epoch. */
  since: number;
  /** Connection tries that failed in a row since the last time the project was live. */
  attempt: number;
  /** In offline: when the next try is due. */
  retryAt?: number;
  /** Why the state was entered, as an id (a transport failure, a refusal reason or a finding). */
  reason?: string;
  /** The witness finding ids of the last exchange (33-09 turns them into sentences). */
  findings: string[];
}

/** DESIGN 15.3: connecting gives up to offline after 10 seconds. */
export const CONNECT_GIVE_UP_MS = 10_000;
/** DESIGN 15.3: offline retries with back-off to 5 minutes. */
export const MAX_BACKOFF_MS = 300_000;
const FIRST_BACKOFF_MS = 1000;

/** The wait before the next try after `attempt` failed tries: 1 s, doubling, capped at 5 minutes. */
export function backoffMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt <= 0) return FIRST_BACKOFF_MS;
  if (attempt >= 19) return MAX_BACKOFF_MS;
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** attempt);
}

export function initialSyncState(now: number): SyncMachineState {
  return { state: 'single-machine', since: now, attempt: 0, findings: [] };
}

function enter(state: SyncState, now: number, attempt: number, extra: { retryAt?: number; reason?: string; findings?: readonly string[] } = {}): SyncMachineState {
  const next: SyncMachineState = { state, since: now, attempt, findings: [...(extra.findings ?? [])] };
  if (extra.retryAt !== undefined) next.retryAt = extra.retryAt;
  if (extra.reason !== undefined) next.reason = extra.reason;
  return next;
}

/** The next state. An event a state has no row for leaves it unchanged (the same object is returned). */
export function transition(current: SyncMachineState, event: SyncEvent, now: number): SyncMachineState {
  if (event.kind === 'stop') return enter('single-machine', now, 0);
  switch (current.state) {
    case 'single-machine':
      if (event.kind === 'start') return event.hasHub ? enter('connecting', now, 0) : current;
      return current;
    case 'connecting':
      if (event.kind === 'connected') return enter('authenticating', now, current.attempt);
      return current;
    case 'authenticating':
      if (event.kind === 'session-ok') return enter('catching-up', now, current.attempt);
      return current;
    case 'catching-up':
      if (event.kind === 'caught-up' || (event.kind === 'exchange' && event.outcome === 'synced')) return enter('live', now, 0, { findings: event.kind === 'exchange' ? event.findings : [] });
      return current;
    case 'live':
      if (event.kind === 'exchange' && event.outcome === 'synced') return { ...current, findings: [...(event.findings ?? [])] };
      return current;
    default:
      return current;
  }
}

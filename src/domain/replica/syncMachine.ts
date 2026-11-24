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
// No state waits silently (DESIGN 15.3): connecting and authenticating give up to offline after CONNECT_GIVE_UP_MS, offline retries on its own
// back-off timer up to MAX_BACKOFF_MS and at once on Sync Now or a network change, refused and attention wait for the lead, and needs-update waits
// for an update of the extension. syncTimerOf names the one timer a state runs; the transition rows are listed above transition().

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

/** Offline after a failed try: the try counts, and the next one is due after the back-off (or the server's own wait, when longer). */
function wentOffline(current: SyncMachineState, now: number, reason: string, retryAfterMs = 0): SyncMachineState {
  const wait = Math.max(backoffMs(current.attempt), Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_BACKOFF_MS) : 0);
  return enter('offline', now, current.attempt + 1, { retryAt: now + wait, reason });
}

/** Where an exchange outcome leads from a state that is trying to connect or is live. */
function afterExchange(current: SyncMachineState, event: Extract<SyncEvent, { kind: 'exchange' }>, now: number): SyncMachineState {
  const findings = event.findings ?? [];
  switch (event.outcome) {
    case 'synced':
      if (current.state === 'live') return { ...current, findings: [...findings] };
      return enter('live', now, 0, { findings });
    case 'offline':
      return wentOffline(current, now, event.reason ?? 'unreachable', event.retryAfterMs);
    case 'refused':
      return enter('refused', now, 0, { reason: event.reason ?? 'session-refused', findings });
    case 'attention':
      return enter('attention', now, 0, { reason: event.reason ?? findings[0] ?? 'attention', findings });
    case 'needs-update':
      return enter('needs-update', now, 0, { reason: event.reason ?? 'needs-update' });
    default:
      return current;
  }
}

/**
 * The next state. An event a state has no row for leaves it unchanged, and the same object is returned. The rows:
 *   any             --stop--> single-machine
 *   single-machine  --start with a server--> connecting
 *   connecting      --connected--> authenticating
 *   authenticating  --session-ok--> catching-up
 *   catching-up     --caught-up--> live
 *   connecting, authenticating, catching-up, live: an exchange outcome leads to live (synced), offline, refused, attention or needs-update;
 *                   lost leads to offline; connecting and authenticating give up to offline on timeout
 *   offline         --retry (the back-off timer), sync-now or network-change--> connecting (sync-now and network-change reset the attempts)
 *   refused, attention --lead-acted--> connecting
 *   needs-update    --updated--> connecting (nothing else but stop leaves it)
 */
export function transition(current: SyncMachineState, event: SyncEvent, now: number): SyncMachineState {
  if (event.kind === 'stop') return enter('single-machine', now, 0);
  const state = current.state;
  switch (state) {
    case 'single-machine':
      return event.kind === 'start' && event.hasHub ? enter('connecting', now, 0) : current;
    case 'connecting':
    case 'authenticating':
    case 'catching-up':
    case 'live':
      if (event.kind === 'exchange') return afterExchange(current, event, now);
      if (event.kind === 'lost') return wentOffline(current, now, 'lost');
      if (event.kind === 'timeout' && (state === 'connecting' || state === 'authenticating')) return wentOffline(current, now, 'timeout');
      if (state === 'connecting' && event.kind === 'connected') return enter('authenticating', now, current.attempt);
      if (state === 'authenticating' && event.kind === 'session-ok') return enter('catching-up', now, current.attempt);
      if (state === 'catching-up' && event.kind === 'caught-up') return enter('live', now, 0);
      return current;
    case 'offline':
      if (event.kind === 'retry') return enter('connecting', now, current.attempt);
      if (event.kind === 'sync-now' || event.kind === 'network-change') return enter('connecting', now, 0);
      return current;
    case 'refused':
    case 'attention':
      return event.kind === 'lead-acted' ? enter('connecting', now, 0) : current;
    case 'needs-update':
      return event.kind === 'updated' ? enter('connecting', now, 0) : current;
    default:
      return current;
  }
}

/** The one timer a state runs, when it has one: connecting and authenticating give up after giveUpMs; offline retries at retryAt. */
export function syncTimerOf(current: SyncMachineState, giveUpMs: number = CONNECT_GIVE_UP_MS): { event: 'timeout' | 'retry'; at: number } | undefined {
  if (current.state === 'connecting' || current.state === 'authenticating') return { event: 'timeout', at: current.since + giveUpMs };
  if (current.state === 'offline' && current.retryAt !== undefined) return { event: 'retry', at: current.retryAt };
  return undefined;
}

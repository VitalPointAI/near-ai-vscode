// The sync connection machine (DESIGN 15.3, Phase 33 D-09): every (state, event) pair has an expected next state, written out here as a table that
// does not reuse the machine's code, and the test walks the whole product of SYNC_STATES and the event list, so a state or an event added without
// a row fails. Then one test per state, the give-up and back-off timings, and the rule that no state waits without a timer or a way out.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECT_GIVE_UP_MS, MAX_BACKOFF_MS, SYNC_EVENT_KINDS, SYNC_STATES, backoffMs, initialSyncState, syncTimerOf, transition } from '../domain/replica/syncMachine';
import type { SyncEvent, SyncMachineState, SyncState } from '../domain/replica/syncMachine';

const T0 = Date.parse('2026-11-21T09:00:00.000Z');

/** Every event the table covers, by a short name; the exchange event once per outcome and start once with and once without a server. */
const EVENTS: Record<string, SyncEvent> = {
  'start-hub': { kind: 'start', hasHub: true },
  'start-alone': { kind: 'start', hasHub: false },
  connected: { kind: 'connected' },
  'session-ok': { kind: 'session-ok' },
  'caught-up': { kind: 'caught-up' },
  'ex-synced': { kind: 'exchange', outcome: 'synced', findings: [] },
  'ex-offline': { kind: 'exchange', outcome: 'offline', reason: 'unreachable' },
  'ex-refused': { kind: 'exchange', outcome: 'refused', reason: 'not-admitted' },
  'ex-attention': { kind: 'exchange', outcome: 'attention', reason: 'rolled-back', findings: ['rolled-back'] },
  'ex-needs-update': { kind: 'exchange', outcome: 'needs-update', reason: 'needs-update' },
  timeout: { kind: 'timeout' },
  lost: { kind: 'lost' },
  retry: { kind: 'retry' },
  'sync-now': { kind: 'sync-now' },
  'network-change': { kind: 'network-change' },
  'lead-acted': { kind: 'lead-acted' },
  updated: { kind: 'updated' },
  stop: { kind: 'stop' }
};

const EXCHANGES = { 'ex-synced': 'live', 'ex-offline': 'offline', 'ex-refused': 'refused', 'ex-attention': 'attention', 'ex-needs-update': 'needs-update' } as const;
const ACTIVE_EXCHANGES = EXCHANGES as Record<string, SyncState>;

/** The expected next state of every pair. A state not named for an event stays where it is. */
const TABLE: Record<SyncState, Record<string, SyncState>> = {
  'single-machine': { 'start-hub': 'connecting' },
  connecting: { connected: 'authenticating', ...ACTIVE_EXCHANGES, timeout: 'offline', lost: 'offline' },
  authenticating: { 'session-ok': 'catching-up', ...ACTIVE_EXCHANGES, timeout: 'offline', lost: 'offline' },
  'catching-up': { 'caught-up': 'live', ...ACTIVE_EXCHANGES, lost: 'offline' },
  live: { ...ACTIVE_EXCHANGES, lost: 'offline' },
  offline: { retry: 'connecting', 'sync-now': 'connecting', 'network-change': 'connecting' },
  refused: { 'lead-acted': 'connecting' },
  attention: { 'lead-acted': 'connecting' },
  'needs-update': { updated: 'connecting' }
};

/** A machine in the given state, entered at T0 by the shortest path the machine itself allows. */
function inState(state: SyncState): SyncMachineState {
  const paths: Record<SyncState, string[]> = {
    'single-machine': [],
    connecting: ['start-hub'],
    authenticating: ['start-hub', 'connected'],
    'catching-up': ['start-hub', 'connected', 'session-ok'],
    live: ['start-hub', 'connected', 'session-ok', 'caught-up'],
    offline: ['start-hub', 'timeout'],
    refused: ['start-hub', 'ex-refused'],
    attention: ['start-hub', 'ex-attention'],
    'needs-update': ['start-hub', 'ex-needs-update']
  };
  let machine = initialSyncState(T0);
  for (const name of paths[state]) machine = transition(machine, EVENTS[name] as SyncEvent, T0);
  assert.equal(machine.state, state, `the path into ${state}`);
  return machine;
}

const step = (from: SyncState, event: string, now = T0 + 1000): SyncMachineState => transition(inState(from), EVENTS[event] as SyncEvent, now);

test('the table: every state and every event has an expected next state, and the lists are exactly the nine states and thirteen event kinds', () => {
  assert.deepEqual([...SYNC_STATES], ['single-machine', 'connecting', 'authenticating', 'catching-up', 'live', 'offline', 'refused', 'attention', 'needs-update']);
  assert.deepEqual([...SYNC_EVENT_KINDS].sort(), [...new Set(Object.values(EVENTS).map((event) => event.kind))].sort(), 'every event kind has a row');
  assert.deepEqual(Object.keys(TABLE).sort(), [...SYNC_STATES].sort(), 'every state has a row');
  let pairs = 0;
  for (const state of SYNC_STATES) {
    for (const name of Object.keys(EVENTS)) {
      const expected = name === 'stop' ? 'single-machine' : TABLE[state][name] ?? state;
      assert.equal(step(state, name).state, expected, `${state} --${name}-->`);
      pairs += 1;
    }
  }
  assert.equal(pairs, SYNC_STATES.length * Object.keys(EVENTS).length);
});

test('single-machine: start with a server goes to connecting, start without one stays, and nothing else moves it', () => {
  assert.equal(step('single-machine', 'start-hub').state, 'connecting');
  const alone = inState('single-machine');
  assert.equal(transition(alone, EVENTS['start-alone'] as SyncEvent, T0 + 5), alone, 'unchanged is the same object');
  for (const name of ['retry', 'sync-now', 'lead-acted', 'ex-synced']) assert.equal(step('single-machine', name).state, 'single-machine');
});

test('connecting: connected goes to authenticating, the give-up after 10 seconds goes offline, a pin mismatch to attention', () => {
  assert.equal(CONNECT_GIVE_UP_MS, 10_000);
  const connecting = inState('connecting');
  assert.deepEqual(syncTimerOf(connecting), { event: 'timeout', at: T0 + CONNECT_GIVE_UP_MS });
  assert.deepEqual(syncTimerOf(connecting, 3000), { event: 'timeout', at: T0 + 3000 });
  const gaveUp = transition(connecting, { kind: 'timeout' }, T0 + CONNECT_GIVE_UP_MS);
  assert.equal(gaveUp.state, 'offline');
  assert.equal(gaveUp.reason, 'timeout');
  assert.equal(gaveUp.attempt, 1);
  assert.equal(gaveUp.retryAt, T0 + CONNECT_GIVE_UP_MS + 1000);
  const pin = transition(connecting, { kind: 'exchange', outcome: 'attention', reason: 'pin-mismatch' }, T0 + 20);
  assert.equal(pin.state, 'attention');
  assert.equal(pin.reason, 'pin-mismatch');
  assert.equal(step('connecting', 'connected').state, 'authenticating');
});

test('authenticating: session-ok goes to catching-up, a refused device to refused with the reason, the give-up still applies', () => {
  assert.equal(step('authenticating', 'session-ok').state, 'catching-up');
  const refused = step('authenticating', 'ex-refused');
  assert.equal(refused.state, 'refused');
  assert.equal(refused.reason, 'not-admitted');
  const authenticating = inState('authenticating');
  assert.deepEqual(syncTimerOf(authenticating), { event: 'timeout', at: T0 + CONNECT_GIVE_UP_MS });
  assert.equal(step('authenticating', 'timeout').state, 'offline');
});

test('catching-up: caught-up or a synced exchange goes live with the attempts reset; a lost link goes offline; no give-up while exchanging', () => {
  const live = step('catching-up', 'caught-up');
  assert.equal(live.state, 'live');
  assert.equal(live.attempt, 0);
  assert.equal(step('catching-up', 'ex-synced').state, 'live');
  assert.equal(step('catching-up', 'lost').state, 'offline');
  assert.equal(syncTimerOf(inState('catching-up')), undefined);
  assert.equal(step('catching-up', 'timeout').state, 'catching-up');
});

test('live: a synced exchange stays live and keeps its findings as detail; offline, refused, attention and needs-update follow the exchange', () => {
  const live = inState('live');
  const delayed = transition(live, { kind: 'exchange', outcome: 'synced', findings: ['delayed'] }, T0 + 50);
  assert.equal(delayed.state, 'live');
  assert.deepEqual(delayed.findings, ['delayed']);
  assert.equal(delayed.since, live.since, 'still the same stay in live');
  const attention = transition(live, { kind: 'exchange', outcome: 'attention', reason: 'forked-view', findings: ['forked-view', 'withheld'] }, T0 + 60);
  assert.equal(attention.state, 'attention');
  assert.deepEqual(attention.findings, ['forked-view', 'withheld']);
  assert.equal(attention.reason, 'forked-view');
  assert.equal(step('live', 'ex-offline').state, 'offline');
  assert.equal(step('live', 'ex-offline').reason, 'unreachable');
  assert.equal(step('live', 'ex-needs-update').state, 'needs-update');
  assert.equal(step('live', 'sync-now').state, 'live', 'Sync Now while live runs an exchange and stays live');
});

test('offline: retries at the back-off time, at once on Sync Now or a network change with the attempts reset, and a server wait is honoured', () => {
  const offline = inState('offline');
  assert.deepEqual(syncTimerOf(offline), { event: 'retry', at: offline.retryAt as number });
  const retried = transition(offline, { kind: 'retry' }, offline.retryAt as number);
  assert.equal(retried.state, 'connecting');
  assert.equal(retried.attempt, 1, 'a timed retry keeps the count');
  for (const name of ['sync-now', 'network-change']) {
    const now = step('offline', name);
    assert.equal(now.state, 'connecting');
    assert.equal(now.attempt, 0, `${name} resets the attempts`);
    assert.equal(now.retryAt, undefined);
  }
  const waited = transition(inState('live'), { kind: 'exchange', outcome: 'offline', reason: 'rate-limited', retryAfterMs: 30_000 }, T0 + 100);
  assert.equal(waited.retryAt, T0 + 100 + 30_000, 'the server asked for 30 seconds');
  for (const name of ['ex-synced', 'connected', 'lead-acted', 'updated', 'lost', 'timeout']) assert.equal(step('offline', name).state, 'offline', name);
});

test('the back-off: 1 s, doubling, capped at 5 minutes, over repeated failed tries; Sync Now starts it again at 1 s', () => {
  assert.equal(MAX_BACKOFF_MS, 300_000);
  assert.deepEqual([0, 1, 2, 3, 4, 8, 9, 10, 40, 1e9].map(backoffMs), [1000, 2000, 4000, 8000, 16_000, 256_000, 300_000, 300_000, 300_000, 300_000]);
  let machine = inState('connecting');
  let now = T0;
  const waits: number[] = [];
  for (let index = 0; index < 11; index += 1) {
    now += CONNECT_GIVE_UP_MS;
    machine = transition(machine, { kind: 'timeout' }, now);
    assert.equal(machine.state, 'offline');
    waits.push((machine.retryAt as number) - now);
    now = machine.retryAt as number;
    machine = transition(machine, { kind: 'retry' }, now);
    assert.equal(machine.state, 'connecting');
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
  machine = transition(transition(machine, { kind: 'timeout' }, now + 10), { kind: 'sync-now' }, now + 20);
  machine = transition(machine, { kind: 'lost' }, now + 30);
  assert.equal((machine.retryAt as number) - (now + 30), 1000, 'after Sync Now the next wait is 1 s again');
  machine = transition(transition(transition(transition(machine, { kind: 'retry' }, now + 40), { kind: 'connected' }, now + 41), { kind: 'session-ok' }, now + 42), { kind: 'caught-up' }, now + 43);
  assert.equal(machine.state, 'live');
  assert.equal(transition(machine, { kind: 'lost' }, now + 50).retryAt, now + 50 + 1000, 'being live resets the attempts');
});

test('refused: only the lead acting moves it, to connecting, and the reason is cleared', () => {
  const refused = inState('refused');
  for (const name of ['retry', 'sync-now', 'network-change', 'ex-synced', 'updated', 'timeout']) assert.equal(step('refused', name).state, 'refused', name);
  const acted = transition(refused, { kind: 'lead-acted' }, T0 + 10);
  assert.equal(acted.state, 'connecting');
  assert.equal(acted.reason, undefined);
  assert.equal(acted.attempt, 0);
});

test('attention: only the lead acting (a new pin, or re-admitting the server) moves it, to connecting, and the findings are cleared', () => {
  const attention = inState('attention');
  assert.deepEqual(attention.findings, ['rolled-back']);
  for (const name of ['retry', 'sync-now', 'network-change', 'ex-synced', 'updated', 'lost']) assert.equal(step('attention', name).state, 'attention', name);
  const acted = transition(attention, { kind: 'lead-acted' }, T0 + 10);
  assert.equal(acted.state, 'connecting');
  assert.deepEqual(acted.findings, []);
});

test('needs-update: only an update leaves it (stop aside), to connecting', () => {
  for (const name of Object.keys(EVENTS)) {
    const next = step('needs-update', name);
    if (name === 'updated') assert.equal(next.state, 'connecting');
    else if (name === 'stop') assert.equal(next.state, 'single-machine');
    else assert.equal(next.state, 'needs-update', `${name} must not leave needs-update`);
  }
});

test('stop: from every state the machine ends in single-machine with nothing pending', () => {
  for (const state of SYNC_STATES) {
    const stopped = step(state, 'stop', T0 + 99);
    assert.equal(stopped.state, 'single-machine', state);
    assert.equal(stopped.attempt, 0);
    assert.equal(stopped.retryAt, undefined);
    assert.equal(stopped.since, T0 + 99);
    assert.equal(syncTimerOf(stopped), undefined);
  }
});

test('no state waits silently: each has a timer, or an event other than stop that leaves it', () => {
  for (const state of SYNC_STATES) {
    const machine = inState(state);
    const timer = syncTimerOf(machine);
    const ways = Object.keys(EVENTS).filter((name) => name !== 'stop' && transition(machine, EVENTS[name] as SyncEvent, T0 + 1).state !== state);
    assert.ok(timer !== undefined || ways.length > 0, `${state} waits with no timer and no way out`);
    if (state === 'connecting' || state === 'authenticating') assert.equal(timer?.event, 'timeout', `${state} gives up`);
    if (state === 'offline') assert.equal(timer?.event, 'retry', 'offline retries by itself');
  }
});

test('the domain file is pure: no editor API, no timers, no imports', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const text = readFileSync(path.join(__dirname, '..', '..', 'src', 'domain', 'replica', 'syncMachine.ts'), 'utf8');
  assert.doesNotMatch(text, /from 'vscode'|setTimeout\(|setInterval\(|Date\.now\(|new Date\(/);
  assert.doesNotMatch(text, /^import /m);
});

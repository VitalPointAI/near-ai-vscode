// The policy status bar refreshes by itself (owner-confirmed 2026-11-16, PR #70 review): it schedules one timer to the next moment its words change, the start
// of the policy's renewal window or its end, and on firing reads the host's state again, shows it, and arms the next. Timers are injected, so no test waits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RENEW_WINDOW_DAYS, failedClosed } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const statusBar = require('../services/gateStatusBar') as typeof import('../services/gateStatusBar');
test.after(() => { uninstall(); });

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-16T12:00:00.000Z');

function validState(expiresAt: number, overrides: Partial<Extract<BundleState, { state: 'valid' }>> = {}): BundleState {
  return { state: 'valid', bundle: {} as never, hash: 'h'.repeat(64), signer: { fingerprint: 'fp', publicKey: 'pk' } as never, expiresAt: new Date(expiresAt).toISOString(), renewDue: false, ...overrides };
}

/** A clock and a timer queue that move together: advancing fires every due timer in order, at its own moment, as a real clock would. */
class FakeTimers {
  public now = T0;
  public readonly delays: number[] = [];
  private readonly queue = new Map<number, { at: number; callback: () => void }>();
  private next = 1;
  public readonly timers = {
    set: (callback: () => void, delayMs: number): unknown => { const id = this.next++; this.delays.push(delayMs); this.queue.set(id, { at: this.now + delayMs, callback }); return id; },
    clear: (handle: unknown): void => { this.queue.delete(handle as number); }
  };
  public get pending(): number { return this.queue.size; }
  public advanceTo(target: number): void {
    for (;;) {
      const due = [...this.queue.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.queue.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

function itemOf(index: number): (typeof stub.statusBarItems)[number] {
  return stub.statusBarItems[index] as (typeof stub.statusBarItems)[number];
}

/** What the host gives: a valid state that reads as expired once the clock passes its end, the way GateHost.bundleState does. */
function hostReading(clock: FakeTimers, state: BundleState): () => { state: BundleState; now: number } {
  return () => ({ state: state.state === 'valid' && Date.parse(state.expiresAt) <= clock.now ? failedClosed('expired') : state, now: clock.now });
}

test('nextStatusChange: the start of the renewal window, then the end, then nothing', () => {
  const expires = T0 + 100 * DAY;
  const state = validState(expires);
  assert.equal(RENEW_WINDOW_DAYS, 30);
  assert.equal(statusBar.nextStatusChange(state, T0), expires - 30 * DAY);
  assert.equal(statusBar.nextStatusChange(state, expires - 30 * DAY - 1), expires - 30 * DAY);
  assert.equal(statusBar.nextStatusChange(state, expires - 30 * DAY), expires, 'inside the window the next change is the end');
  assert.equal(statusBar.nextStatusChange(state, expires - 1), expires);
  assert.equal(statusBar.nextStatusChange(state, expires), undefined, 'at and after the end nothing more changes');
  assert.equal(statusBar.nextStatusChange(state, expires + DAY), undefined);
  assert.equal(statusBar.nextStatusChange(failedClosed('expired'), T0), undefined);
  assert.equal(statusBar.nextStatusChange(undefined, T0), undefined);
  assert.equal(statusBar.nextStatusChange(validState(expires, { expiresAt: 'not a time' }), T0), undefined);
});

test('gateStatusText: a policy inside its renewal window reads renewing even when the state was read before the window began', () => {
  const expires = T0 + 100 * DAY;
  const stale = validState(expires, { renewDue: false });
  assert.equal(statusBar.gateStatusText(stale, expires - 31 * DAY).text, 'Standing Orders');
  assert.equal(statusBar.gateStatusText(stale, expires - 30 * DAY).text, 'Standing Orders: renewing');
  assert.equal(statusBar.gateStatusText(stale, expires - 1).text, 'Standing Orders: renewing');
  assert.equal(statusBar.gateStatusText(stale, expires).text, 'Standing Orders: reading only');
});

test('a policy already in its last days says renewing, and when its end passes the bar says reading only with no other trigger', () => {
  const clock = new FakeTimers();
  const expires = T0 + 10 * DAY;
  const bar = statusBar.createGateStatusBar({ read: hostReading(clock, validState(expires)), timers: clock.timers });
  const item = itemOf(stub.statusBarItems.length - 1);
  bar.update(validState(expires), clock.now);
  assert.equal(item.text, 'Standing Orders: renewing');
  assert.deepEqual(clock.delays, [10 * DAY], 'one timer, to the end');
  clock.advanceTo(expires - 1);
  assert.equal(item.text, 'Standing Orders: renewing');
  clock.advanceTo(expires);
  assert.equal(item.text, 'Standing Orders: reading only');
  assert.ok(item.backgroundColor !== undefined, 'the warning background shows');
  assert.equal(clock.pending, 0, 'nothing more is scheduled once it has ended');
  bar.dispose();
});

test('a host that still hands back the old valid state after the end is shown as ended, because the bar reads the time as well', () => {
  const clock = new FakeTimers();
  const expires = T0 + 40 * DAY;
  const stale = validState(expires);
  const bar = statusBar.createGateStatusBar({ read: () => ({ state: stale, now: clock.now }), timers: clock.timers });
  const item = itemOf(stub.statusBarItems.length - 1);
  bar.update(stale, clock.now);
  assert.equal(item.text, 'Standing Orders');
  clock.advanceTo(expires);
  assert.equal(item.text, 'Standing Orders: reading only');
  bar.dispose();
});

test('the renewal window start changes the words to "Standing Orders: renewing", then the end to "reading only", each at its own moment', () => {
  const clock = new FakeTimers();
  const expires = T0 + 100 * DAY;
  const bar = statusBar.createGateStatusBar({ read: hostReading(clock, validState(expires)), timers: clock.timers });
  const item = itemOf(stub.statusBarItems.length - 1);
  bar.update(validState(expires), clock.now);
  assert.equal(item.text, 'Standing Orders');
  clock.advanceTo(expires - 30 * DAY - 1);
  assert.equal(item.text, 'Standing Orders');
  clock.advanceTo(expires - 30 * DAY);
  assert.equal(item.text, 'Standing Orders: renewing');
  assert.equal(item.backgroundColor, undefined, 'renewing does not warn');
  clock.advanceTo(expires - 1);
  assert.equal(item.text, 'Standing Orders: renewing');
  clock.advanceTo(expires);
  assert.equal(item.text, 'Standing Orders: reading only');
  bar.dispose();
});

test('a delay longer than a timer can hold is cut and re-armed until the moment arrives', () => {
  const clock = new FakeTimers();
  const expires = T0 + 200 * DAY;
  const bar = statusBar.createGateStatusBar({ read: hostReading(clock, validState(expires)), timers: clock.timers });
  const item = itemOf(stub.statusBarItems.length - 1);
  bar.update(validState(expires), clock.now);
  assert.equal(clock.delays[0], statusBar.MAX_TIMER_DELAY_MS, 'the first wait is cut to the most a timer can hold (about 24.8 days)');
  assert.ok(statusBar.MAX_TIMER_DELAY_MS < 25 * DAY);
  clock.advanceTo(T0 + 100 * DAY);
  assert.equal(item.text, 'Standing Orders', 'a cut wait ended with nothing to show yet');
  assert.ok(clock.delays.length > 3, 'it armed again each time');
  assert.ok(clock.delays.every((delay) => delay >= 1 && delay <= statusBar.MAX_TIMER_DELAY_MS), 'every wait is a real positive delay a timer accepts');
  clock.advanceTo(expires - 30 * DAY);
  assert.equal(item.text, 'Standing Orders: renewing');
  clock.advanceTo(expires);
  assert.equal(item.text, 'Standing Orders: reading only');
  assert.equal(clock.pending, 0);
  bar.dispose();
});

test('a host change replaces the timer, and a state with nothing ahead leaves none', () => {
  const clock = new FakeTimers();
  const expires = T0 + 100 * DAY;
  const bar = statusBar.createGateStatusBar({ read: hostReading(clock, validState(expires)), timers: clock.timers });
  bar.update(validState(expires), clock.now);
  bar.update(validState(expires + 50 * DAY), clock.now);
  assert.equal(clock.pending, 1, 'one timer, never two');
  bar.update(failedClosed('bad-signature'), clock.now);
  assert.equal(clock.pending, 0, 'a failed-closed policy has nothing to wait for');
  bar.update(undefined, clock.now);
  assert.equal(clock.pending, 0, 'a check that has not finished has nothing to wait for');
  bar.update(validState(expires), clock.now);
  assert.equal(clock.pending, 1);
  bar.dispose();
});

test('dispose clears the timer, and a timer that fires after it changes nothing', () => {
  const clock = new FakeTimers();
  const expires = T0 + 100 * DAY;
  const bar = statusBar.createGateStatusBar({ read: hostReading(clock, validState(expires)), timers: clock.timers });
  const item = itemOf(stub.statusBarItems.length - 1);
  bar.update(validState(expires), clock.now);
  assert.equal(clock.pending, 1);
  bar.dispose();
  assert.equal(clock.pending, 0);
  assert.equal(item.disposed, true);
  bar.update(validState(expires), clock.now);
  assert.equal(clock.pending, 0, 'an update after dispose arms nothing');
  clock.advanceTo(expires + DAY);
  assert.equal(item.text, 'Standing Orders');
});

test('a read that throws never breaks the bar: it keeps what it shows and reads again a minute later', () => {
  const clock = new FakeTimers();
  const expires = T0 + 100 * DAY;
  let broken = true;
  const bar = statusBar.createGateStatusBar({ read: () => { if (broken) throw new Error('the host is gone'); return { state: validState(expires), now: clock.now }; }, timers: clock.timers });
  const item = itemOf(stub.statusBarItems.length - 1);
  bar.update(validState(expires), clock.now);
  assert.doesNotThrow(() => clock.advanceTo(expires - 30 * DAY));
  assert.equal(item.text, 'Standing Orders', 'nothing to show from a host that cannot be read');
  assert.equal(clock.pending, 1, 'it will try again');
  assert.equal(clock.delays.at(-1), statusBar.READ_RETRY_MS);
  broken = false;
  clock.advanceTo(clock.now + statusBar.READ_RETRY_MS);
  assert.equal(item.text, 'Standing Orders: renewing');
  bar.dispose();
  assert.equal(clock.pending, 0);
});

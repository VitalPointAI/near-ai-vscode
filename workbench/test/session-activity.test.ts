// Phase 46 verification W2: the answer to Theia Cloud 1.2.0's activity tracker. The operator's GET lastActivity and POST popup are answered only
// with the exact session secret; the last use moves only when the person uses the page; the popup turns the state to idle-warned until the next
// use; every other /monitor path is 404, and nothing is answered outside the tracker or outside /monitor. An answer is a number or one word.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionActivity } from '../extension/src/node/session-activity.ts';

const SECRET = 'a-session-secret-0123456789';
const TRACKED = { THEIACLOUD_SESSION_SECRET: SECRET, THEIACLOUD_MONITOR_ENABLE_ACTIVITY_TRACKER: 'true', THEIACLOUD_SESSION_USER: 'person@site.example' };
const LAST = '/monitor/activity/lastActivity';
const POPUP = '/monitor/activity/popup';
const BEARER = `Bearer ${SECRET}`;

function clock(start: number): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

test('the tracker gets the session start, then the time of the last use, as epoch milliseconds', () => {
  const time = clock(1_800_000_000_000);
  const activity = createSessionActivity(TRACKED, time.now);
  assert.deepEqual(activity.answer('GET', LAST, BEARER), { status: 200, body: '1800000000000' });
  time.advance(90_000);
  assert.deepEqual(activity.answer('GET', LAST, BEARER), { status: 200, body: '1800000000000' }, 'asking and waiting are not use');
  assert.equal(activity.report(), 'active');
  assert.deepEqual(activity.answer('GET', LAST, BEARER), { status: 200, body: '1800000090000' });
});

test('only exactly "Bearer <session secret>" is answered; anything else is 401 with one word', () => {
  const activity = createSessionActivity(TRACKED);
  for (const header of [undefined, '', SECRET, `Bearer ${SECRET}x`, `Bearer  ${SECRET}`, `Basic ${SECRET}`, `Bearer ${SECRET} extra`, 'Bearer ']) {
    assert.deepEqual(activity.answer('GET', LAST, header), { status: 401, body: 'Unauthorized' }, String(header));
    assert.deepEqual(activity.answer('POST', POPUP, header), { status: 401, body: 'Unauthorized' }, String(header));
  }
  assert.equal(activity.state(), 'active', 'a refused popup warns nobody');
});

test('the popup turns the state to idle-warned until the person next uses the page', () => {
  const activity = createSessionActivity(TRACKED);
  assert.equal(activity.state(), 'active');
  assert.deepEqual(activity.answer('POST', POPUP, BEARER), { status: 200, body: 'ok' });
  assert.equal(activity.state(), 'idle-warned');
  assert.equal(activity.report(), 'active');
  assert.equal(activity.state(), 'active');
});

test('every other /monitor path and method is 404, the operator\'s free-text message included; other paths are not answered at all', () => {
  const activity = createSessionActivity(TRACKED);
  for (const [method, path] of [['POST', '/monitor/message'], ['POST', LAST], ['GET', POPUP], ['GET', '/monitor'], ['GET', '/monitor/activity']]) {
    assert.deepEqual(activity.answer(method, path, BEARER), { status: 404, body: 'Not found' }, `${method} ${path}`);
  }
  for (const path of ['/', '/healthz', '/monitoring', '/services/sterling-session-activity']) assert.equal(activity.answer('GET', path, BEARER), undefined, path);
});

test('without the session secret or with the tracker off the state is off, use is ignored, and /monitor is 404 for everyone', () => {
  for (const env of [{}, { THEIACLOUD_MONITOR_ENABLE_ACTIVITY_TRACKER: 'true' }, { THEIACLOUD_SESSION_SECRET: SECRET }, { ...TRACKED, THEIACLOUD_MONITOR_ENABLE_ACTIVITY_TRACKER: 'false' }]) {
    const activity = createSessionActivity(env);
    assert.equal(activity.state(), 'off');
    assert.equal(activity.report(), 'off');
    assert.deepEqual(activity.answer('GET', LAST, BEARER), { status: 404, body: 'Not found' });
    assert.deepEqual(activity.answer('POST', POPUP, BEARER), { status: 404, body: 'Not found' });
    assert.equal(activity.state(), 'off');
  }
});

test('no answer carries anything about the person or the secret', () => {
  const activity = createSessionActivity(TRACKED);
  activity.report();
  const bodies = [activity.answer('GET', LAST, BEARER), activity.answer('POST', POPUP, BEARER), activity.answer('GET', LAST, 'Bearer wrong'),
    activity.answer('POST', '/monitor/message', BEARER)].map((answer) => answer?.body ?? '');
  for (const body of bodies) {
    assert.ok(/^(?:[0-9]{13}|ok|Unauthorized|Not found)$/.test(body), body);
    assert.ok(!body.includes('person') && !body.includes(SECRET), body);
  }
});

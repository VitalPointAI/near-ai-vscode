// Phase 46 verification W2: the answer to Theia Cloud 1.2.0's activity tracker. The operator's GET lastActivity and POST popup are answered only
// with the exact session secret; the last use moves only when the person uses the page; the popup turns the state to idle-warned until the next
// use; every other /monitor path is 404, and nothing is answered outside the tracker or outside /monitor. An answer is a number or one word.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createSessionActivity, createTrackerServer, trackerAddress } from '../extension/src/node/session-activity.ts';

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

// Phase 47's lab (47-15, spike S7): the operator calls the app port on the pod IP, not through the sidecar. A pod IP in STERLING_LISTEN_HOST
// in hosted mode opens only the tracker there; Theia stays on loopback (bin/start.mjs).
const HOSTED = { STERLING_OPENBAO_ADDR: 'https://openbao.site.example' };

test('the tracker address is a pod IP in hosted mode only; loopback, a wildcard or unset is none, and a name stops the backend', () => {
  assert.equal(trackerAddress({ ...HOSTED, STERLING_LISTEN_HOST: '10.42.0.82' }), '10.42.0.82');
  assert.equal(trackerAddress({ ...HOSTED, STERLING_LISTEN_HOST: ' fd00::12 ' }), 'fd00::12');
  for (const host of [undefined, '', '127.0.0.1', '::1', 'localhost', '0.0.0.0', '::']) {
    assert.equal(trackerAddress({ ...HOSTED, STERLING_LISTEN_HOST: host }), undefined, String(host));
  }
  assert.equal(trackerAddress({ STERLING_LISTEN_HOST: '10.42.0.82' }), undefined, 'local mode keeps STERLING_LISTEN_HOST as Theia\'s own bind');
  for (const host of ['session.example', '10.42.0.82:3000', '10.42.0.0/24', '[fd00::12]', '10.42.0.82,10.42.0.83']) {
    assert.throws(() => trackerAddress({ ...HOSTED, STERLING_LISTEN_HOST: host }), /STERLING_LISTEN_HOST must be 127\.0\.0\.1, 0\.0\.0\.0 or the pod's IP address/, host);
  }
});

test('the listener on the tracker address answers the tracker and 404s everything else, the workbench\'s own paths included', async (t) => {
  const activity = createSessionActivity(TRACKED, () => 1_800_000_000_000);
  const server = createTrackerServer(activity);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const ask = async (method: string, path: string, authorization?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: authorization ? { authorization } : {} });
    return { status: response.status, body: await response.text(), cookie: response.headers.get('set-cookie') };
  };
  assert.deepEqual(await ask('GET', LAST, BEARER), { status: 200, body: '1800000000000', cookie: null });
  assert.deepEqual(await ask('GET', `${LAST}?x=1`, BEARER), { status: 200, body: '1800000000000', cookie: null });
  assert.deepEqual(await ask('GET', LAST), { status: 401, body: 'Unauthorized', cookie: null });
  for (const path of ['/', '/healthz', '/bundle.js', '/services/sterling-session-activity', '/monitor/message', '/x/monitor/activity/lastActivity']) {
    assert.deepEqual(await ask('GET', path, BEARER), { status: 404, body: 'Not found', cookie: null }, path);
  }
  assert.deepEqual(await ask('POST', POPUP, BEARER), { status: 200, body: 'ok', cookie: null });
  assert.equal(activity.state(), 'idle-warned');
});

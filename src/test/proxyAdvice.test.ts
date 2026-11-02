import assert from 'node:assert/strict';
import test from 'node:test';
import { DONT_ASK_AGAIN, NOT_NOW, offerProxyAdvice, PROXY_ADVICE_KEY, PROXY_ADVICE_SNOOZE_MS, proxyAdviceApplies, ProxyAdviceHost, proxyAdviceText, RELOAD_WINDOW, TURN_OFF_PROXY_SUPPORT } from '../domain/proxyAdvice';

// 0.4.11: in code-server and remote windows, VS Code's proxy support can stall runs while the tab
// is in the background; the extension suggests turning it off when no proxy is used.

function proxyHost({ answer, reloadChoice, ...overrides }: Partial<ProxyAdviceHost> & { answer?: string; reloadChoice?: string } = {}) {
  const values = new Map<string, unknown>();
  const calls = { asked: [] as string[], told: [] as string[], turnedOff: 0, reloaded: 0 };
  const host: ProxyAdviceHost = {
    web: true, env: {},
    state: { get: (key) => values.get(key), update: async (key, value) => { values.set(key, value); } },
    ask: async (text, ...items) => { calls.asked.push(text); assert.deepEqual(items, [TURN_OFF_PROXY_SUPPORT, NOT_NOW, DONT_ASK_AGAIN]); return answer; },
    turnOff: async () => { calls.turnedOff += 1; },
    tell: async (text) => { calls.told.push(text); return reloadChoice; },
    reload: () => { calls.reloaded += 1; },
    now: () => 1_000,
    ...overrides
  };
  return { host, values, calls };
}

test('proxy advice applies only in a browser or remote host, with proxy support on and no proxy set', () => {
  assert.equal(proxyAdviceApplies({ web: true, env: {} }), true, 'code-server with defaults');
  assert.equal(proxyAdviceApplies({ web: false, remoteName: 'ssh-remote', proxySupport: 'override', env: {} }), true);
  assert.equal(proxyAdviceApplies({ web: false, env: {} }), false, 'desktop VS Code');
  assert.equal(proxyAdviceApplies({ web: true, proxySupport: 'off', env: {} }), false, 'already off');
  assert.equal(proxyAdviceApplies({ web: true, proxy: 'http://proxy:3128', env: {} }), false, 'a proxy is configured');
  assert.equal(proxyAdviceApplies({ web: true, env: { HTTPS_PROXY: 'http://proxy:3128' } }), false);
  assert.equal(proxyAdviceApplies({ web: true, env: { http_proxy: 'http://proxy:3128' } }), false);
  assert.match(proxyAdviceText(true), /browser tab/);
  assert.match(proxyAdviceText(false), /this window/);
  for (const web of [true, false]) assert.doesNotMatch(proxyAdviceText(web), /—/);
});

test('proxy advice: the setting changes only after the click, and a dismissal is remembered', async () => {
  const off = proxyHost({ answer: TURN_OFF_PROXY_SUPPORT, reloadChoice: RELOAD_WINDOW });
  assert.equal(await offerProxyAdvice(off.host), 'turned-off');
  assert.equal(off.calls.turnedOff, 1);
  assert.equal(off.calls.reloaded, 1, 'reloads only because the user chose Reload Window');
  assert.match(off.calls.told[0], /Reload the window/);

  const later = proxyHost({ answer: NOT_NOW });
  assert.equal(await offerProxyAdvice(later.host), 'snoozed');
  assert.equal(later.calls.turnedOff, 0);
  assert.equal(await offerProxyAdvice(later.host), 'not-asked', 'not asked again soon');
  assert.equal(later.calls.asked.length, 1);
  assert.equal(await offerProxyAdvice({ ...later.host, now: () => 1_000 + PROXY_ADVICE_SNOOZE_MS + 1 }), 'snoozed', 'asked again after the snooze');

  const closed = proxyHost({ answer: undefined });
  assert.equal(await offerProxyAdvice(closed.host), 'snoozed', 'closing the message is "not now"');
  assert.equal(closed.calls.turnedOff, 0);

  const never = proxyHost({ answer: DONT_ASK_AGAIN });
  assert.equal(await offerProxyAdvice(never.host), 'never');
  assert.deepEqual(never.values.get(PROXY_ADVICE_KEY), { never: true });
  assert.equal(await offerProxyAdvice({ ...never.host, now: () => Number.MAX_SAFE_INTEGER }), 'not-asked');
  assert.equal(never.calls.asked.length, 1);

  const desktop = proxyHost({ web: false, answer: TURN_OFF_PROXY_SUPPORT });
  assert.equal(await offerProxyAdvice(desktop.host), 'not-needed');
  assert.equal(desktop.calls.asked.length, 0);

  const failing = proxyHost({ answer: TURN_OFF_PROXY_SUPPORT, turnOff: async () => { throw new Error('read-only settings'); } });
  assert.equal(await offerProxyAdvice(failing.host), 'failed');
  assert.match(failing.calls.told[0], /could not be turned off: read-only settings/);
});

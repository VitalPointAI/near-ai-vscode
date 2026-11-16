// The route decision (CLAS-05, CLAS-06, D-30, D-36, D-37, D-47): which tier a mark needs, and whether one client, endpoint and model satisfy it, from
// local facts only. No network, no clock, no key.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LOOPBACK_HOSTS } from '../domain/config';
import { raiseMark } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import {
  DEFAULT_ROUTING, ROUTE_REFUSALS, ROUTE_RULES, TIER_ORDER, decideRoute, isLocalRouteHost, parseRouting, tierForLabel, tierForMark
} from '../domain/gate/routing';
import type { RouteFacts, RoutingTable } from '../domain/gate/routing';

function label(scale: string, level: string, extra: Partial<Label> = {}): Label {
  return { scale, level, compartments: [], releasability: [], handling: [], ...extra };
}

const org = (level: string, extra: Partial<Label> = {}): Label => label('org', level, extra);
const markOf = (...labels: Label[]): Mark => labels;

const NEAR_TEE: RouteFacts = {
  clientRoute: 'near', host: 'https://cloud-api.near.ai/v1', nearEndpoint: true, model: { id: 'tee-model', privacyBoundary: 'tee' }, attestationFailed: false
};
const NEAR_CLOUD: RouteFacts = { ...NEAR_TEE, model: { id: 'cloud-model', privacyBoundary: 'cloud' } };
const LOCAL_OK: RouteFacts = {
  clientRoute: 'local', host: 'http://127.0.0.1:11434', nearEndpoint: false, model: { id: 'local-model', privacyBoundary: 'local' }, attestationFailed: false
};
const LOCAL_REMOTE: RouteFacts = { ...LOCAL_OK, host: 'https://models.example.org' };

function withLocalHosts(...hosts: string[]): RoutingTable {
  const parsed = parseRouting({ levels: { ...DEFAULT_ROUTING.levels }, handling: { ...DEFAULT_ROUTING.handling }, compartments: {}, localHosts: hosts }, SCALE_PRESETS);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

test('tracer: a mark goes to a tier and the client, endpoint and model are judged against it, allowed or refused with a plain reason', () => {
  const open = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD);
  assert.deepEqual({ allowed: open.allowed, tier: open.tier, rule: open.rule }, { allowed: true, tier: 'any-cloud', rule: 'route.any-cloud' });
  assert.equal(open.reason, undefined);

  assert.equal(decideRoute(markOf(org('Confidential')), DEFAULT_ROUTING, NEAR_TEE).allowed, true);
  const notTee = decideRoute(markOf(org('Confidential')), DEFAULT_ROUTING, NEAR_CLOUD);
  assert.equal(notTee.allowed, false);
  assert.equal(notTee.rule, 'route.not-tee');
  assert.equal(notTee.tier, 'attested-cloud');

  const noLocal = decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, NEAR_TEE);
  assert.equal(noLocal.allowed, false);
  assert.equal(noLocal.rule, 'route.no-local-model');
  assert.match(noLocal.reason ?? '', /^Nothing was sent\./);

  const local = decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, LOCAL_OK);
  assert.deepEqual({ allowed: local.allowed, rule: local.rule }, { allowed: true, rule: 'route.local-only' });

  const remote = decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, LOCAL_REMOTE);
  assert.equal(remote.allowed, false);
  assert.equal(remote.rule, 'route.local-host-not-local');
  // Once the organization names the host, the same request is allowed.
  assert.equal(decideRoute(markOf(org('Restricted')), withLocalHosts('models.example.org'), LOCAL_REMOTE).allowed, true);
});

test('every rule id can be reached, and every refusing rule has one plain sentence that says nothing was sent', () => {
  const reached = new Set<string>();
  const cases: Array<[Mark, RoutingTable, RouteFacts]> = [
    [markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD],
    [markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE],
    [markOf(org('Restricted')), DEFAULT_ROUTING, LOCAL_OK],
    [markOf(org('Restricted', { handling: ['local-only'] })), withDenyRestricted(), LOCAL_OK],
    [markOf(org('Restricted')), DEFAULT_ROUTING, NEAR_TEE],
    [markOf(org('Restricted')), DEFAULT_ROUTING, LOCAL_REMOTE],
    [markOf(org('Internal')), DEFAULT_ROUTING, NEAR_CLOUD],
    [markOf(org('Internal')), DEFAULT_ROUTING, { ...NEAR_TEE, attestationFailed: true }],
    [markOf(org('Internal')), DEFAULT_ROUTING, { ...NEAR_TEE, clientRoute: undefined }]
  ];
  for (const [mark, routing, facts] of cases) reached.add(decideRoute(mark, routing, facts).rule);
  assert.deepEqual([...reached].sort(), [...ROUTE_RULES].sort());
  assert.deepEqual(Object.keys(ROUTE_REFUSALS).sort(), ROUTE_RULES.filter((rule) => !['route.any-cloud', 'route.attested-cloud', 'route.local-only'].includes(rule)).sort());
  for (const sentence of Object.values(ROUTE_REFUSALS)) {
    assert.match(sentence, /^Nothing was sent\. /);
    assert.ok(!sentence.includes(String.fromCharCode(0x2014)), 'no em-dash');
    assert.ok(!/NEAR organization/i.test(sentence), 'say your organization');
    assert.ok(sentence.length < 400);
  }
});

function withDenyRestricted(): RoutingTable {
  const parsed = parseRouting({ levels: { ...DEFAULT_ROUTING.levels, 'org/Restricted': 'deny' }, handling: {}, compartments: {}, localHosts: [] }, SCALE_PRESETS);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

test('deny refuses even a local model on a local host', () => {
  const decision = decideRoute(markOf(org('Restricted')), withDenyRestricted(), LOCAL_OK);
  assert.deepEqual({ allowed: decision.allowed, tier: decision.tier, rule: decision.rule }, { allowed: false, tier: 'deny', rule: 'route.deny' });
});

test('a local model on a local host satisfies every tier except deny (a stricter destination satisfies a looser tier)', () => {
  for (const level of ['Public', 'Internal', 'Confidential', 'Restricted']) {
    assert.equal(decideRoute(markOf(org(level)), DEFAULT_ROUTING, LOCAL_OK).allowed, true, level);
  }
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, LOCAL_OK).rule, 'route.attested-cloud');
});

test('an unknown model, or a catalog not loaded yet, counts as not private for every tier above any-cloud (D-36)', () => {
  const unknown: RouteFacts = { ...NEAR_TEE, model: undefined };
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, unknown).allowed, true);
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, unknown).rule, 'route.not-tee');
  assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, { ...LOCAL_OK, model: undefined }).rule, 'route.no-local-model');
  for (const boundary of ['cloud', 'hybrid', 'unknown', '', 'TEE', 'Local']) {
    const odd: RouteFacts = { ...NEAR_TEE, model: { id: 'm', privacyBoundary: boundary } };
    assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, odd).allowed, false, boundary);
  }
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...NEAR_TEE, model: { id: 'm' } }).allowed, false);
});

test('attested-cloud needs NEAR AI Cloud\'s own endpoint and no failed attestation in the session (D-36)', () => {
  const forwarded = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...NEAR_TEE, nearEndpoint: false, host: 'https://proxy.example.org/v1' });
  assert.equal(forwarded.rule, 'route.not-tee');
  const failed = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...NEAR_TEE, attestationFailed: true });
  assert.equal(failed.rule, 'route.attestation-failed');
  assert.equal(failed.allowed, false);
  // A failed attestation does not matter to a local model, which needs none.
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...LOCAL_OK, attestationFailed: true }).allowed, true);
  // A local runtime on a remote host cannot satisfy attested-cloud either, and a cloud model behind a local runtime is not a TEE model.
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, LOCAL_REMOTE).rule, 'route.local-host-not-local');
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...LOCAL_OK, model: { id: 'm', privacyBoundary: 'tee' } }).rule, 'route.not-tee');
});

test('a request that did not say its route is refused above any-cloud and allowed at any-cloud', () => {
  const nameless: RouteFacts = { ...NEAR_TEE, clientRoute: undefined };
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, nameless).allowed, true);
  assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, nameless).rule, 'route.no-session');
});

test('CLAS-06: a configured local runtime on a host that is neither loopback nor named is never local-only', () => {
  for (const host of ['https://models.example.org', 'http://192.168.1.20:11434', 'http://10.0.0.5', 'https://localhost.example.org', 'http://127.0.0.1.example.org']) {
    const decision = decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, { ...LOCAL_OK, host });
    assert.equal(decision.allowed, false, host);
    assert.equal(decision.rule, 'route.local-host-not-local', host);
  }
  for (const host of ['http://localhost:11434', 'http://127.0.0.1', 'http://[::1]:8080', 'localhost', 'localhost:11434', 'HTTP://LOCALHOST:1']) {
    assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, { ...LOCAL_OK, host }).allowed, true, host);
  }
});

test('isLocalRouteHost: loopback, exact names and subdomain wildcards, and nothing unreadable', () => {
  assert.deepEqual([...LOOPBACK_HOSTS].sort(), ['127.0.0.1', '[::1]', 'localhost']);
  assert.equal(isLocalRouteHost('http://localhost:1234', []), true);
  assert.equal(isLocalRouteHost('https://box.lan.example.com', ['box.lan.example.com']), true);
  assert.equal(isLocalRouteHost('https://other.lan.example.com', ['box.lan.example.com']), false);
  assert.equal(isLocalRouteHost('https://a.lan.example.com', ['*.lan.example.com']), true);
  assert.equal(isLocalRouteHost('https://a.b.lan.example.com', ['*.lan.example.com']), true);
  assert.equal(isLocalRouteHost('https://lan.example.com', ['*.lan.example.com']), false);
  assert.equal(isLocalRouteHost('https://evillan.example.com', ['*.lan.example.com']), false);
  assert.equal(isLocalRouteHost('https://BOX.lan.example.com', ['box.lan.example.com']), true);
  assert.equal(isLocalRouteHost('', ['box.lan.example.com']), false);
  assert.equal(isLocalRouteHost('http://', ['*.example.com']), false);
  assert.equal(isLocalRouteHost('not a host', ['*.example.com']), false);
});

test('tierForMark takes the strictest of every label, compartment and handling flag, in the order deny, local-only, attested-cloud, any-cloud (edge CLAS-05 ordering)', () => {
  const routing = withCompartment('SIGINT', 'local-only');
  assert.equal(tierForLabel(org('Public'), routing), 'any-cloud');
  assert.equal(tierForLabel(org('Public', { compartments: ['SIGINT'] }), routing), 'local-only');
  assert.equal(tierForLabel(org('Public', { compartments: ['OTHER'] }), routing), 'any-cloud');
  assert.equal(tierForLabel(org('Public', { handling: ['local-only'] }), routing), 'local-only');
  // A flag that is not a routing key never changes the tier (D-47).
  assert.equal(tierForLabel(org('Public', { handling: ['no-agent-tools'] }), routing), 'any-cloud');
  // A compartment cannot relax a level.
  assert.equal(tierForLabel(org('Restricted', { compartments: ['RELAXED'] }), withCompartment('RELAXED', 'any-cloud')), 'local-only');

  const labels = [org('Internal'), org('Public', { compartments: ['SIGINT'] }), label('nato', 'NATO Unclassified'), label('ca-protected', 'Protected B')];
  const expected = tierForMark(labels, routing);
  assert.equal(expected, 'local-only');
  for (const shuffled of permutations(labels)) assert.equal(tierForMark(shuffled, routing), expected);
  assert.equal(tierForMark(markOf(org('Public'), label('ca-protected', 'Protected A')), DEFAULT_ROUTING), 'attested-cloud');
  assert.ok(TIER_ORDER['deny'] > TIER_ORDER['local-only']);
});

test('an empty mark takes the supplied default label, and with none is denied, and an unlisted level is denied (fail closed)', () => {
  assert.equal(tierForMark([], DEFAULT_ROUTING, org('Internal')), 'attested-cloud');
  assert.equal(tierForMark([], DEFAULT_ROUTING), 'deny');
  assert.equal(tierForLabel(label('org', 'Unlisted'), DEFAULT_ROUTING), 'deny');
  assert.equal(tierForLabel(label('__proto__', 'Public'), DEFAULT_ROUTING), 'deny');
});

test('a mark raised by reading a higher file routes to the stricter tier', () => {
  const raised = raiseMark(markOf(org('Public')), org('Restricted'), SCALE_PRESETS);
  assert.equal(tierForMark(raised, DEFAULT_ROUTING), 'local-only');
  assert.equal(decideRoute(raised, DEFAULT_ROUTING, NEAR_TEE).rule, 'route.no-local-model');
});

function withCompartment(token: string, tier: 'any-cloud' | 'attested-cloud' | 'local-only' | 'deny'): RoutingTable {
  const parsed = parseRouting({ levels: { ...DEFAULT_ROUTING.levels }, handling: { ...DEFAULT_ROUTING.handling }, compartments: { [token]: tier }, localHosts: [] }, SCALE_PRESETS);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, index) => {
    for (const rest of permutations([...items.slice(0, index), ...items.slice(index + 1)])) out.push([item, ...rest]);
  });
  return out;
}

test('neighbouring levels route as the defaults say (edge CLAS-05 adjacency)', () => {
  const tierOf = (scale: string, level: string): string => tierForLabel(label(scale, level), DEFAULT_ROUTING);
  assert.equal(tierOf('org', 'Internal'), 'attested-cloud');
  assert.equal(tierOf('org', 'Restricted'), 'local-only');
  assert.equal(tierOf('nato', 'NATO Unclassified'), 'attested-cloud');
  assert.equal(tierOf('nato', 'NATO Restricted'), 'local-only');
  assert.equal(tierOf('ca-protected', 'Protected A'), 'attested-cloud');
  assert.equal(tierOf('ca-protected', 'Protected B'), 'local-only');
  // The same level name on two scales is two different keys.
  assert.equal(tierOf('org', 'Confidential'), 'attested-cloud');
  assert.equal(tierOf('ca-classified', 'Confidential'), 'local-only');
});

test('routing keys are scale/level with the exact level names, spaces kept and case-sensitive; any other spelling is refused (edge CLAS-05 encoding)', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(DEFAULT_ROUTING.levels, 'ca-protected/Protected B'));
  const misspelled = ['ca-protected/protected b', 'ca-protected/Protected_B', 'ca-protected/ProtectedB', 'ca-protected/Protected B ', 'CA-PROTECTED/Protected B', 'Protected B'];
  for (const key of misspelled) {
    const levels = { ...DEFAULT_ROUTING.levels, [key]: 'any-cloud' };
    assert.equal(parseRouting({ levels, handling: {}, compartments: {}, localHosts: [] }, SCALE_PRESETS).ok, false, key);
    const swapped: Record<string, string> = { ...DEFAULT_ROUTING.levels };
    delete swapped['ca-protected/Protected B'];
    swapped[key] = 'any-cloud';
    assert.equal(parseRouting({ levels: swapped, handling: {}, compartments: {}, localHosts: [] }, SCALE_PRESETS).ok, false, key);
  }
  // A label whose level is spelled another way has no entry in a valid table, so it is denied, never routed as another level.
  assert.equal(tierForLabel(label('ca-protected', 'protected b'), DEFAULT_ROUTING), 'deny');
  assert.equal(tierForLabel(label('ca-protected', 'Protected B'), DEFAULT_ROUTING), 'local-only');
});

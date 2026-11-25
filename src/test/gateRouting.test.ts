// The route decision (CLAS-05, CLAS-06, D-30, D-36, D-37, D-47): which tier a mark needs, and whether one client, endpoint and model satisfy it, from
// local facts only. No network, no clock, no key.
// Phase 41 (D-36): on a request those checks allowed, decideRoute's policy steps then run in this order: allowed models (route.model-not-allowed), the
// place (route.endpoint-unknown), its ceiling (route.endpoint-ceiling), a pin or binding (route.endpoint-pin), an authorization
// (route.authorization-missing), an accredited device (route.accredited-device, reported unless your organization turns refusal on), residency
// (route.residency), the passport (route.passport, reported only) and clearance (route.clearance). gateDecideRoute.test.ts holds their behaviour.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as config from '../domain/config';
import { isLoopbackHost, isSecureEndpoint } from '../domain/config';
import { raiseMark } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { parseEndpoints } from '../domain/gate/endpoints';
import type { PolicyEndpoint } from '../domain/gate/endpoints';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import {
  BINDING_MAX_AGE_MS, BINDING_REFUSALS, CONNECTION_BINDING_STATES, DEFAULT_ROUTING, ROUTE_EVENT_IDS, ROUTE_REFUSALS, ROUTE_RULES, TIER_ORDER, decideRoute,
  isBindingFresh, isLocalRouteHost, localHostMatch, localHostPatternNotice, parseRouting, patternLocalHosts, routingWhileFailedClosed, tierForLabel, tierForMark,
  usesHttps
} from '../domain/gate/routing';
import type { ConnectionBindingFact, RouteFacts, RoutePolicy, RoutingTable } from '../domain/gate/routing';
import { ROUTE_RULES_NAMED_AHEAD } from '../domain/gate/routing';
import { FIXED_NOW, issuerKey, policyDocumentFor } from './helpers/policyFixtures';

function label(scale: string, level: string, extra: Partial<Label> = {}): Label {
  return { scale, level, compartments: [], releasability: [], handling: [], ...extra };
}

const org = (level: string, extra: Partial<Label> = {}): Label => label('org', level, extra);
const markOf = (...labels: Label[]): Mark => labels;

const NEAR_TEE: RouteFacts = {
  clientRoute: 'near', host: 'https://cloud-api.near.ai/v1', nearEndpoint: true, model: { id: 'tee-model', privacyBoundary: 'tee' }, attestationFailed: false
};
const NEAR_CLOUD: RouteFacts = { ...NEAR_TEE, model: { id: 'cloud-model', privacyBoundary: 'cloud' } };
// D-50: an attested-cloud request through a NEAR client goes only with a fresh bound connection fact for its host. No NEAR client has a source before plan
// 25, so a case that expects NEAR AI Cloud to be allowed at attested-cloud gives the fact here, and a twin without it expects the refusal.
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const BOUND: ConnectionBindingFact = { state: 'bound', host: 'https://cloud-api.near.ai/v1', checkedAt: NOW - 60_000, fingerprint: 'f'.repeat(64) };
const NEAR_TEE_BOUND: RouteFacts = { ...NEAR_TEE, binding: BOUND, now: NOW };
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

  assert.equal(decideRoute(markOf(org('Confidential')), DEFAULT_ROUTING, NEAR_TEE_BOUND).allowed, true);
  // The twin without a binding fact (D-50): refused, and with no local model available the refusal names the missing local model.
  const unbound = decideRoute(markOf(org('Confidential')), DEFAULT_ROUTING, NEAR_TEE);
  assert.deepEqual({ allowed: unbound.allowed, tier: unbound.tier, rule: unbound.rule }, { allowed: false, tier: 'attested-cloud', rule: 'route.no-local-model' });
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

/** A v2 policy for decideRoute's sixth argument: these places, nothing else (no authorization, residency, passport or roster). */
function policyOf(...entries: Array<Record<string, unknown>>): RoutePolicy {
  const parsed = parseEndpoints(entries, SCALE_PRESETS);
  if (!parsed.ok) throw new Error(`endpoints: ${parsed.reason} ${parsed.path}`);
  const endpoints: readonly PolicyEndpoint[] = parsed.value;
  return { endpoints, authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: false, requireAccreditedDevice: false, now: NOW };
}

const MODELS_INTERNAL = { id: 'models', class: 'org-plain', host: 'models.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Internal'] };
const MODELS_PROTECTED_B = { ...MODELS_INTERNAL, maxLabel: ['ca-protected/Protected B', 'org/Restricted'] };
const ORG_PUBLIC_CLEARANCE = { scale: 'org', level: 'Public', compartments: [], releasability: [] };
/** A TLS pin's shape (SHA-256 hex), made at test time from a word. */
const TEST_PIN = createHash('sha256').update('routing-test-pin', 'utf8').digest('hex');

test('every rule id can be reached, and every refusing rule has one plain sentence that says nothing was sent', () => {
  const reached = new Set<string>();
  const cases: Array<[Mark, RoutingTable, RouteFacts, RoutePolicy?]> = [
    [markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD],
    [markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE_BOUND],
    [markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE],
    [markOf(org('Internal')), DEFAULT_ROUTING, { ...NEAR_TEE, localModelAvailable: true }],
    [markOf(org('Public')), DEFAULT_ROUTING, { ...NEAR_CLOUD, sessionless: true }],
    [markOf(org('Restricted')), DEFAULT_ROUTING, LOCAL_OK],
    [markOf(org('Restricted', { handling: ['local-only'] })), withDenyRestricted(), LOCAL_OK],
    [markOf(org('Restricted')), DEFAULT_ROUTING, NEAR_TEE],
    [markOf(org('Restricted')), DEFAULT_ROUTING, LOCAL_REMOTE],
    [markOf(org('Internal')), DEFAULT_ROUTING, NEAR_CLOUD],
    [markOf(org('Internal')), DEFAULT_ROUTING, { ...NEAR_TEE, attestationFailed: true }],
    [markOf(org('Internal')), DEFAULT_ROUTING, { ...NEAR_TEE, clientRoute: undefined }],
    // Coherence review S1: a local-only level on a host only a *. pattern names, and a classified level on any host but this computer.
    [markOf(org('Restricted')), withLocalHosts('*.example.org'), LOCAL_REMOTE],
    [markOf(label('ca-classified', 'Secret')), withLocalHosts('models.example.org'), LOCAL_REMOTE],
    // Phase 41 (D-36, D-37): the policy steps, each reached by a request the checks above allowed.
    [markOf(org('Public')), DEFAULT_ROUTING, { ...NEAR_CLOUD, allowedModels: ['example/other-model'] }],
    [markOf(org('Restricted')), withLocalHosts('models.example.org'), LOCAL_REMOTE, policyOf()],
    [markOf(org('Restricted')), withLocalHosts('models.example.org'), LOCAL_REMOTE, policyOf(MODELS_INTERNAL)],
    [markOf(label('ca-protected', 'Protected B')), withLocalHosts('models.example.org'), LOCAL_REMOTE, policyOf(MODELS_PROTECTED_B)],
    [markOf(label('ca-protected', 'Protected B')), withLocalHosts('models.example.org'), LOCAL_REMOTE, policyOf({ ...MODELS_PROTECTED_B, tlsPins: [TEST_PIN] })],
    [markOf(label('ca-classified', 'Secret')), DEFAULT_ROUTING, LOCAL_OK, { ...policyOf(), organization: true, requireAccreditedDevice: true }],
    [markOf(org('Internal')), withLocalHosts('models.example.org'), LOCAL_REMOTE, { ...policyOf(MODELS_INTERNAL), residency: { v: 1, required: ['EU'] } }],
    [markOf(org('Internal')), DEFAULT_ROUTING, LOCAL_OK, { ...policyOf(), clearances: [ORG_PUBLIC_CLEARANCE], rosterClearances: [ORG_PUBLIC_CLEARANCE] }],
    // Phase 74.1 (D-11): under models.mode enforce, a model with no passport at chat you review is refused.
    [markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD, { ...policyOf(), models: { v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] } }]
  ];
  for (const [mark, routing, facts, policy] of cases) reached.add(decideRoute(mark, routing, facts, undefined, undefined, policy).rule);
  assert.deepEqual([...reached].sort(), [...ROUTE_RULES].sort());
  assert.deepEqual(Object.keys(ROUTE_REFUSALS).sort(), ROUTE_RULES.filter((rule) => !['route.any-cloud', 'route.attested-cloud', 'route.local-only', 'route.default-session'].includes(rule)).sort());
  for (const sentence of Object.values(ROUTE_REFUSALS)) {
    assert.match(sentence, /^Nothing was sent\. /);
    assert.ok(!sentence.includes(String.fromCharCode(0x2014)), 'no em-dash');
    assert.ok(!/NEAR organization/i.test(sentence), 'say your organization');
    assert.ok(sentence.length < 400);
  }
  // PR #81 review: before 4c a chat has no label of its own, so a new chat changes nothing about this refusal; the sentence offers only what helps.
  assert.ok(!/new chat/.test(ROUTE_REFUSALS['route.connection-not-bound']), 'no new chat advised before a chat carries a label');
  assert.match(ROUTE_REFUSALS['route.connection-not-bound'], /stays on this computer/);
  assert.match(ROUTE_REFUSALS['route.connection-not-bound'], /local model/);
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

test('the loopback host list is not exported as a live collection: only a predicate is, and nothing a caller does can widen it', () => {
  assert.equal('LOOPBACK_HOSTS' in config, false, 'no mutable list is exported');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['', 'LOCALHOST', 'localhost.', '0.0.0.0', '127.0.0.2', '::1', 'evil.example.com', 'constructor', '__proto__', 'has', 'size']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
  // The predicate and the endpoint check agree, and both are unchanged by anything a caller tries on the module's exports.
  assert.equal(isSecureEndpoint('http://localhost:11434/v1'), true);
  assert.equal(isSecureEndpoint('http://127.0.0.1:8080'), true);
  assert.equal(isSecureEndpoint('http://[::1]:8080'), true);
  assert.equal(isSecureEndpoint('http://evil.example.com/v1'), false);
  assert.equal(isSecureEndpoint('https://cloud-api.near.ai/v1'), true);
  assert.equal(isSecureEndpoint('http://localhost.evil.example.com'), false);
});

test('isLocalRouteHost: loopback, exact names and subdomain wildcards, and nothing unreadable', () => {
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) assert.equal(isLoopbackHost(host), true, host);
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

// ---- D-50: attested-cloud needs a fresh bound connection fact; D-53: a failed-closed policy routes labelled content local-only ----

test('a binding is fresh only when bound, both times are known, and it is younger than ten minutes', () => {
  assert.deepEqual([...CONNECTION_BINDING_STATES], ['bound', 'not-bound', 'unavailable', 'unknown']);
  assert.equal(BINDING_MAX_AGE_MS, 600_000);
  assert.equal(isBindingFresh(BOUND, NOW), true);
  assert.equal(isBindingFresh({ ...BOUND, checkedAt: NOW }, NOW), true, 'checked this instant');
  assert.equal(isBindingFresh({ ...BOUND, checkedAt: NOW - BINDING_MAX_AGE_MS + 1 }, NOW), true, 'one millisecond short of the limit');
  assert.equal(isBindingFresh({ ...BOUND, checkedAt: NOW - BINDING_MAX_AGE_MS }, NOW), false, 'at the limit it is stale');
  assert.equal(isBindingFresh({ ...BOUND, checkedAt: NOW + 1 }, NOW), false, 'a check from the future is not trusted');
  assert.equal(isBindingFresh(undefined, NOW), false, 'no fact');
  assert.equal(isBindingFresh(BOUND, undefined), false, 'no clock');
  assert.equal(isBindingFresh({ state: 'bound', host: BOUND.host }, NOW), false, 'no time of check');
  assert.equal(isBindingFresh({ ...BOUND, checkedAt: Number.NaN }, NOW), false);
  for (const state of ['not-bound', 'unavailable', 'unknown'] as const) assert.equal(isBindingFresh({ ...BOUND, state }, NOW), false, state);
});

test('CLAS-05 (D-50): a NEAR client at attested-cloud is refused without a fresh bound fact for its own host, naming the cause first', () => {
  const internal = markOf(org('Internal'));
  const cases: Array<[string, RouteFacts, keyof typeof BINDING_REFUSALS]> = [
    ['no fact', NEAR_TEE, 'unknown'],
    ['no clock', { ...NEAR_TEE, binding: BOUND }, 'unknown'],
    ['stale', { ...NEAR_TEE_BOUND, binding: { ...BOUND, checkedAt: NOW - BINDING_MAX_AGE_MS - 1 } }, 'unknown'],
    ['unknown', { ...NEAR_TEE_BOUND, binding: { state: 'unknown', host: BOUND.host } }, 'unknown'],
    ['another host', { ...NEAR_TEE_BOUND, binding: { ...BOUND, host: 'https://other.example.org' } }, 'unknown'],
    ['not bound', { ...NEAR_TEE_BOUND, binding: { state: 'not-bound', host: BOUND.host, checkedAt: NOW } }, 'not-bound'],
    ['unavailable', { ...NEAR_TEE_BOUND, binding: { state: 'unavailable', host: BOUND.host, checkedAt: NOW } }, 'unavailable']
  ];
  for (const [name, facts, cause] of cases) {
    const alone = decideRoute(internal, DEFAULT_ROUTING, facts);
    assert.equal(alone.allowed, false, name);
    assert.equal(alone.rule, 'route.no-local-model', name);
    assert.ok(alone.reason?.startsWith(BINDING_REFUSALS[cause]), `${name}: ${alone.reason ?? ''}`);
    const withLocal = decideRoute(internal, DEFAULT_ROUTING, { ...facts, localModelAvailable: true });
    assert.equal(withLocal.rule, 'route.connection-not-bound', name);
    assert.ok(withLocal.reason?.startsWith(BINDING_REFUSALS[cause]), name);
    assert.equal((withLocal.reason?.match(/Nothing was sent\./g) ?? []).length, 1, 'said once');
  }
  // The earlier rules still come first: a model that is not TEE, another endpoint, and a failed attestation are refused for that reason, bound or not.
  assert.equal(decideRoute(internal, DEFAULT_ROUTING, { ...NEAR_TEE_BOUND, model: { id: 'c', privacyBoundary: 'cloud' } }).rule, 'route.not-tee');
  assert.equal(decideRoute(internal, DEFAULT_ROUTING, { ...NEAR_TEE_BOUND, attestationFailed: true }).rule, 'route.attestation-failed');
  // A local model on this computer needs no binding; any-cloud, local-only and deny never read the fact.
  assert.equal(decideRoute(internal, DEFAULT_ROUTING, LOCAL_OK).allowed, true);
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD).allowed, true);
  assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, NEAR_TEE_BOUND).rule, 'route.no-local-model');
  assert.equal(decideRoute(markOf(org('Restricted')), withDenyRestricted(), NEAR_TEE_BOUND).rule, 'route.deny');
  for (const sentence of Object.values(BINDING_REFUSALS)) {
    assert.match(sentence, /^Nothing was sent\. /);
    assert.match(sentence, /stays on this computer\.$/);
    assert.ok(!sentence.includes(String.fromCharCode(0x2014)), 'no em-dash');
  }
  // Plan 25 (PR 4d) built the background check, so the unknown sentence now says it runs and to try again; the others promise no check.
  assert.match(BINDING_REFUSALS.unknown, /SovAI checks the connection in the background, so try again in a moment/);
  assert.ok(!/background|later check/i.test(BINDING_REFUSALS['not-bound']) && !/background|later check/i.test(BINDING_REFUSALS.unavailable));
});

test('an allowed request decided outside any session is route.default-session; a refused one keeps its refusing rule', () => {
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, { ...NEAR_CLOUD, sessionless: true }).rule, 'route.default-session');
  assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, { ...LOCAL_OK, sessionless: true }).rule, 'route.default-session');
  assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, { ...NEAR_TEE, sessionless: true }).rule, 'route.no-local-model');
  assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, { ...NEAR_TEE, clientRoute: undefined, sessionless: true }).rule, 'route.no-session');
  assert.deepEqual([...ROUTE_EVENT_IDS], ['route.attestation-checked', 'route.attestation-cleared', 'route.not-accredited', 'route.passport-triggered']);
  for (const event of ROUTE_EVENT_IDS) assert.ok(!(ROUTE_RULES as readonly string[]).includes(event), `${event} is an event, not a rule`);
});

test('D-53: while the policy is failed closed every tier above any-cloud is at least local-only and no host is named local', () => {
  const closed = routingWhileFailedClosed();
  assert.deepEqual(closed.localHosts, []);
  for (const key of Object.keys(DEFAULT_ROUTING.levels)) {
    const shipped = DEFAULT_ROUTING.levels[key]!;
    const now = closed.levels[key]!;
    if (shipped === 'any-cloud') assert.equal(now, 'any-cloud', key);
    else assert.ok(TIER_ORDER[now] >= TIER_ORDER['local-only'] && TIER_ORDER[now] >= TIER_ORDER[shipped], key);
  }
  assert.equal(closed.levels['org/Internal'], 'local-only');
  assert.equal(closed.handling['local-only'], 'local-only');
  assert.ok(Object.isFrozen(closed) && Object.isFrozen(closed.levels));
  // The default label still goes where it goes today; labelled content never leaves this computer, even on a host the policy would have named.
  assert.equal(decideRoute(markOf(org('Public')), closed, NEAR_CLOUD).allowed, true);
  assert.equal(decideRoute(markOf(org('Internal')), closed, NEAR_TEE_BOUND).rule, 'route.no-local-model');
  assert.equal(decideRoute(markOf(org('Internal')), closed, LOCAL_OK).rule, 'route.local-only');
  assert.equal(decideRoute(markOf(org('Restricted')), closed, LOCAL_REMOTE).rule, 'route.local-host-not-local');
});

// ---- Coherence review S1: local hosts for local-only and classified levels ----

const classified = (level: string): Label => label('ca-classified', level);
const PROTECTED_B = label('ca-protected', 'Protected B');

test('S1: a local-only level goes to a named host only through an exact entry over https; a *. pattern or plain http is refused with a sentence saying what changed', () => {
  const exact = withLocalHosts('models.example.org');
  const pattern = withLocalHosts('*.example.org');
  // Allowed: an exact entry over https, and this computer whatever the scheme.
  assert.equal(decideRoute(markOf(PROTECTED_B), exact, LOCAL_REMOTE).rule, 'route.local-only');
  assert.equal(decideRoute(markOf(org('Restricted')), exact, LOCAL_REMOTE).rule, 'route.local-only');
  assert.equal(decideRoute(markOf(PROTECTED_B), pattern, LOCAL_OK).rule, 'route.local-only');
  // Refused: a pattern match, plain http to the exact host, and a bare host that says nothing about its scheme.
  const byPattern = decideRoute(markOf(PROTECTED_B), pattern, LOCAL_REMOTE);
  assert.deepEqual({ allowed: byPattern.allowed, rule: byPattern.rule }, { allowed: false, rule: 'route.local-host-not-exact' });
  assert.match(byPattern.reason ?? '', /^Nothing was sent\. From this version, .*exact host, not a \*\. pattern, and the runtime uses https/);
  assert.equal(decideRoute(markOf(PROTECTED_B), exact, { ...LOCAL_REMOTE, host: 'http://models.example.org:11434' }).rule, 'route.local-host-not-exact');
  assert.equal(decideRoute(markOf(PROTECTED_B), exact, { ...LOCAL_REMOTE, host: 'models.example.org' }).rule, 'route.local-host-not-exact');
  // An exact entry wins over a pattern that also matches; a host named by neither is still not local.
  assert.equal(decideRoute(markOf(PROTECTED_B), withLocalHosts('*.example.org', 'models.example.org'), LOCAL_REMOTE).rule, 'route.local-only');
  assert.equal(decideRoute(markOf(PROTECTED_B), exact, { ...LOCAL_REMOTE, host: 'https://other.example.org' }).rule, 'route.local-host-not-local');
  // The default label decides an empty mark the same way.
  assert.equal(decideRoute([], pattern, LOCAL_REMOTE, PROTECTED_B).rule, 'route.local-host-not-exact');
});

test('S1: attested-cloud levels keep today\'s looser rule: a *. pattern or plain http still counts as local for them', () => {
  const pattern = withLocalHosts('*.example.org');
  assert.equal(decideRoute(markOf(org('Internal')), pattern, LOCAL_REMOTE).rule, 'route.attested-cloud');
  assert.equal(decideRoute(markOf(label('ca-protected', 'Protected A')), withLocalHosts('models.example.org'), { ...LOCAL_REMOTE, host: 'http://models.example.org' }).rule, 'route.attested-cloud');
  // org Public is any-cloud: no host check at all.
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, LOCAL_REMOTE).rule, 'route.any-cloud');
});

test('S1: Protected C, classified and NATO Confidential and above never leave this computer, even for an exact named host over https', () => {
  const exact = withLocalHosts('models.example.org');
  for (const held of [label('ca-protected', 'Protected C'), classified('Confidential'), classified('Secret'), classified('Top Secret'), label('nato', 'NATO Confidential'), label('nato', 'NATO Secret'), label('nato', 'Cosmic Top Secret')]) {
    const named = decideRoute(markOf(held), exact, LOCAL_REMOTE);
    assert.deepEqual({ allowed: named.allowed, rule: named.rule }, { allowed: false, rule: 'route.this-computer-only' }, `${held.scale}/${held.level}`);
    assert.match(named.reason ?? '', /^Nothing was sent\. .*never leaves this computer/);
    // An unnamed host gets the same sentence, never advice to name it.
    assert.equal(decideRoute(markOf(held), DEFAULT_ROUTING, LOCAL_REMOTE).rule, 'route.this-computer-only');
    // This computer is unchanged: allowed.
    assert.equal(decideRoute(markOf(held), exact, LOCAL_OK).rule, 'route.local-only', `${held.scale}/${held.level} on this computer`);
  }
  // A classified label anywhere in the mark decides, whatever else it holds.
  assert.equal(decideRoute(markOf(org('Restricted'), classified('Secret')), exact, LOCAL_REMOTE).rule, 'route.this-computer-only');
  // NATO Restricted and Protected B are local-only but not this-computer-only: an exact https host still serves them.
  assert.equal(decideRoute(markOf(label('nato', 'NATO Restricted')), exact, LOCAL_REMOTE).rule, 'route.local-only');
});

test('S1: the notice for a policy with a *. pattern names the entry, what changed and how to fix it; plain words', () => {
  const routing = { patternLocalHosts, localHostPatternNotice, localHostMatch, usesHttps };
  const pattern = withLocalHosts('*.example.org', 'models.example.org');
  assert.deepEqual([...routing.patternLocalHosts(pattern)], ['*.example.org']);
  assert.deepEqual([...routing.patternLocalHosts(withLocalHosts('models.example.org'))], []);
  const text = routing.localHostPatternNotice(['*.example.org']);
  assert.match(text, /\*\.example\.org/);
  assert.match(text, /exact name/);
  assert.match(text, /https/);
  assert.match(text, /in SovAI: Policy, choose Edit my rules/);
  assert.ok(!text.includes(String.fromCharCode(0x2014)) && !/NEAR organization/i.test(text));
  assert.equal(routing.localHostMatch('https://a.example.org', ['*.example.org']), 'pattern');
  assert.equal(routing.localHostMatch('https://a.example.org', ['a.example.org']), 'exact');
  assert.equal(routing.localHostMatch('http://127.0.0.1:1', []), 'loopback');
  assert.equal(routing.localHostMatch('https://b.example.com', ['*.example.org']), 'none');
  assert.equal(routing.usesHttps('https://a.example.org/v1'), true);
  assert.equal(routing.usesHttps('HTTPS://a.example.org'), true);
  assert.equal(routing.usesHttps('http://a.example.org'), false);
  assert.equal(routing.usesHttps('a.example.org'), false);
  assert.equal(routing.usesHttps('https://'), false);
});

// ---- Coherence review S4: the private floor ----

test('S4: a private floor raises any-cloud to attested-cloud, so a private model counts only with a fresh bound connection; it never lowers a tier', () => {
  // Without the floor, org Public goes to any model.
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD).allowed, true);
  // With it: a forwarded model is refused, a TEE model with no fresh proof is refused, and one with a fresh proof goes.
  const forwarded = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD, undefined, 'attested-cloud');
  assert.deepEqual({ allowed: forwarded.allowed, tier: forwarded.tier, rule: forwarded.rule }, { allowed: false, tier: 'attested-cloud', rule: 'route.not-tee' });
  assert.match(forwarded.reason ?? '', /^Nothing was sent\. This run may use only verified private hardware or this computer/);
  const stale = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, { ...NEAR_TEE_BOUND, now: NOW + BINDING_MAX_AGE_MS }, undefined, 'attested-cloud');
  assert.equal(stale.allowed, false);
  assert.match(stale.reason ?? '', /^Nothing was sent\. This run may use only verified private hardware/);
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_TEE, undefined, 'attested-cloud').allowed, false);
  const fresh = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_TEE_BOUND, undefined, 'attested-cloud');
  assert.deepEqual({ allowed: fresh.allowed, rule: fresh.rule }, { allowed: true, rule: 'route.attested-cloud' });
  // A model on this computer always counts.
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, LOCAL_OK, undefined, 'attested-cloud').allowed, true);
  // The floor never lowers: Restricted stays local-only, and its own refusal keeps its own words.
  const restricted = decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, NEAR_TEE_BOUND, undefined, 'attested-cloud');
  assert.deepEqual({ tier: restricted.tier, rule: restricted.rule }, { tier: 'local-only', rule: 'route.no-local-model' });
  assert.equal(restricted.reason, ROUTE_REFUSALS['route.no-local-model']);
  // A floor below the mark's tier changes nothing.
  assert.deepEqual(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE, undefined, 'any-cloud'), decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE));
});

// ---- PR #143 review: the class behind S1 and S4, closed ----

function routingWith(levels: Record<string, string>, ...hosts: string[]): RoutingTable {
  const parsed = parseRouting({ levels: { ...DEFAULT_ROUTING.levels, ...levels }, handling: { ...DEFAULT_ROUTING.handling }, compartments: {}, localHosts: hosts }, SCALE_PRESETS);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

test('PR #143 review: under the private floor a named local host counts only as an exact https entry; a *. pattern or plain http is refused, loopback and exact https go', () => {
  const floor = 'attested-cloud' as const;
  const pattern = withLocalHosts('*.example.org');
  const exact = withLocalHosts('models.example.org');
  const viaPattern = decideRoute(markOf(org('Public')), pattern, LOCAL_REMOTE, undefined, floor);
  assert.deepEqual({ allowed: viaPattern.allowed, rule: viaPattern.rule }, { allowed: false, rule: 'route.local-host-not-exact' });
  assert.match(viaPattern.reason ?? '', /^Nothing was sent\. This run may use only verified private hardware/);
  assert.equal(decideRoute(markOf(org('Public')), exact, { ...LOCAL_REMOTE, host: 'http://models.example.org' }, undefined, floor).rule, 'route.local-host-not-exact');
  assert.equal(decideRoute(markOf(org('Internal')), pattern, LOCAL_REMOTE, undefined, floor).rule, 'route.local-host-not-exact', 'an attested mark under the floor too');
  assert.equal(decideRoute(markOf(org('Public')), exact, LOCAL_REMOTE, undefined, floor).rule, 'route.attested-cloud');
  assert.equal(decideRoute(markOf(org('Public')), pattern, LOCAL_OK, undefined, floor).rule, 'route.attested-cloud');
  // Without the floor nothing changes for attested-cloud levels: a pattern still counts as local there.
  assert.equal(decideRoute(markOf(org('Internal')), pattern, LOCAL_REMOTE).rule, 'route.attested-cloud');
});

test('PR #143 review: a policy that routes a this-computer-only level to a cloud still keeps it on this computer, on every path; unclassified levels are unchanged', () => {
  const lax = routingWith({ 'ca-classified/Secret': 'any-cloud', 'ca-protected/Protected C': 'attested-cloud', 'nato/NATO Secret': 'any-cloud' });
  for (const held of [label('ca-classified', 'Secret'), label('ca-protected', 'Protected C'), label('nato', 'NATO Secret')]) {
    assert.equal(tierForLabel(held, lax), 'local-only', `${held.scale}/${held.level}`);
    for (const facts of [NEAR_CLOUD, NEAR_TEE, NEAR_TEE_BOUND]) {
      const sent = decideRoute(markOf(held), lax, facts);
      assert.deepEqual({ allowed: sent.allowed, rule: sent.rule }, { allowed: false, rule: 'route.this-computer-only' }, `${held.scale}/${held.level}`);
      assert.match(sent.reason ?? '', /never leaves this computer: no cloud and no other host is accredited for it/);
    }
    assert.equal(decideRoute(markOf(held), lax, LOCAL_REMOTE).rule, 'route.this-computer-only');
    assert.equal(decideRoute(markOf(held), lax, LOCAL_OK).rule, 'route.local-only', 'this computer still works');
    // As the default label of an empty mark too.
    assert.equal(decideRoute([], lax, NEAR_CLOUD, held).rule, 'route.this-computer-only');
  }
  // Nothing else moves: org Public goes anywhere, Internal and Protected A still go to a proven private cloud, Protected B keeps its policy tier.
  assert.equal(decideRoute(markOf(org('Public')), lax, NEAR_CLOUD).rule, 'route.any-cloud');
  assert.equal(decideRoute(markOf(org('Internal')), lax, NEAR_TEE_BOUND).rule, 'route.attested-cloud');
  assert.equal(decideRoute(markOf(label('ca-protected', 'Protected A')), lax, NEAR_TEE_BOUND).rule, 'route.attested-cloud');
  assert.equal(decideRoute(markOf(label('ca-protected', 'Protected B')), routingWith({ 'ca-protected/Protected B': 'attested-cloud' }), NEAR_TEE_BOUND).rule, 'route.attested-cloud');
  // With the shipped table (already local-only) the refusal keeps its own words.
  assert.equal(decideRoute(markOf(label('ca-classified', 'Secret')), DEFAULT_ROUTING, NEAR_TEE).rule, 'route.no-local-model');
});

// ---- Phase 41 FND-02: the starting rules as a v2 document route exactly as v1 does; D-62, D-63: export-controlled content stays on this computer ----

/** The RoutePolicy of the starting rules read as a v2 document (documentFromBundle): its places, the people section's clearances, no residency, no models. */
function defaultRoutePolicy(): { policy: RoutePolicy; defaultLabel: Label } {
  const doc = policyDocumentFor({ key: issuerKey() });
  assert.equal(doc.residency, undefined);
  assert.equal(doc.models, undefined);
  const policy: RoutePolicy = {
    endpoints: doc.endpoints ?? [], authorizations: [], scales: doc.labels.scales, mappings: doc.labels.mappings, clearances: doc.people?.clearances ?? [],
    organization: false, requireAccreditedDevice: doc.agents.requireAccreditedDevice, now: FIXED_NOW
  };
  return { policy, defaultLabel: doc.labels.defaultLabel };
}

/** Every preset label, client route, host, binding and model of the routing table, with and without the private floor. */
function routingCases(): Array<{ mark: Mark; facts: RouteFacts; floor?: 'attested-cloud' }> {
  const labels: Label[] = [];
  for (const scale of Object.keys(SCALE_PRESETS)) for (const level of SCALE_PRESETS[scale]!.levels) labels.push(label(scale, level));
  const hosts = ['http://127.0.0.1:11434', 'https://cloud-api.near.ai/v1', 'https://models.example.org'];
  const bindings: Array<ConnectionBindingFact | undefined> = [undefined];
  const cases: Array<{ mark: Mark; facts: RouteFacts; floor?: 'attested-cloud' }> = [];
  for (const held of labels) {
    for (const clientRoute of ['near', 'local', undefined] as const) {
      for (const host of hosts) {
        const freshness = [
          undefined,
          { state: 'bound' as const, host, checkedAt: FIXED_NOW - 60_000 },
          { state: 'bound' as const, host, checkedAt: FIXED_NOW - BINDING_MAX_AGE_MS - 1 }
        ];
        for (const binding of [...bindings, ...freshness.slice(1)]) {
          for (const privacyBoundary of ['tee', 'local', 'cloud', undefined]) {
            const facts: RouteFacts = {
              clientRoute, host, nearEndpoint: host.includes('cloud-api.near.ai'), attestationFailed: false, now: FIXED_NOW,
              model: privacyBoundary === undefined ? undefined : { id: `example/${privacyBoundary}-model`, privacyBoundary }, ...(binding === undefined ? {} : { binding })
            };
            for (const floor of [undefined, 'attested-cloud' as const]) cases.push(floor === undefined ? { mark: markOf(held), facts } : { mark: markOf(held), facts, floor });
          }
        }
      }
    }
  }
  return cases;
}

test('FND-02: the default policy read as v2 decides every routing case as v1 does', () => {
  const { policy, defaultLabel } = defaultRoutePolicy();
  const cases = routingCases();
  assert.ok(cases.length >= 1000, `${String(cases.length)} cases`);
  let allowed = 0;
  for (const { mark, facts, floor } of cases) {
    const v1 = decideRoute(mark, DEFAULT_ROUTING, facts, defaultLabel, floor);
    const v2 = decideRoute(mark, DEFAULT_ROUTING, facts, defaultLabel, floor, policy);
    const name = `${mark[0]!.scale}/${mark[0]!.level} ${String(facts.clientRoute)} ${facts.host} ${facts.binding === undefined ? 'no binding' : String(facts.binding.checkedAt)} ${String(facts.model?.privacyBoundary)} ${String(floor)}`;
    assert.deepEqual({ allowed: v2.allowed, tier: v2.tier, rule: v2.rule }, { allowed: v1.allowed, tier: v1.tier, rule: v1.rule }, name);
    assert.equal(v2.reason, v1.reason, name);
    assert.notEqual(v2.rule, 'route.export-control', name);
    if (v1.allowed) allowed += 1;
  }
  assert.ok(allowed > 100 && allowed < cases.length, `${String(allowed)} allowed: both sides are exercised`);
});

test('D-62, D-63: ITAR, CGP and EAR keep content on this computer under the default policy; route.export-control is never returned and stays named ahead', () => {
  const { policy, defaultLabel } = defaultRoutePolicy();
  const nearBound: RouteFacts = { ...NEAR_TEE, binding: { state: 'bound', host: NEAR_TEE.host, checkedAt: FIXED_NOW - 60_000 }, now: FIXED_NOW };
  for (const token of ['ITAR', 'CGP', 'EAR']) {
    const marked = org('Internal', { compartments: [token] });
    assert.equal(tierForLabel(marked, DEFAULT_ROUTING), 'local-only', token);
    const cloud = decideRoute(markOf(marked), DEFAULT_ROUTING, nearBound, defaultLabel, undefined, policy);
    assert.deepEqual({ allowed: cloud.allowed, tier: cloud.tier }, { allowed: false, tier: 'local-only' }, token);
    assert.notEqual(cloud.rule, 'route.export-control');
    const here = decideRoute(markOf(marked), DEFAULT_ROUTING, { ...LOCAL_OK, now: FIXED_NOW }, defaultLabel, undefined, policy);
    assert.deepEqual({ allowed: here.allowed, rule: here.rule }, { allowed: true, rule: 'route.local-only' }, token);
    // The same label without the marking still goes where it does today.
    assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, nearBound, defaultLabel, undefined, policy).allowed, true);
  }
  assert.deepEqual([...ROUTE_RULES_NAMED_AHEAD], ['route.export-control'], 'route.passport moved into ROUTE_RULES in Phase 74.1 (D-11)');
  assert.equal((ROUTE_RULES as readonly string[]).includes('route.export-control'), false);
});

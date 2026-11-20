// decideRoute over a v2 policy (FND-03 to FND-06, Phase 41 D-24 to D-27, D-33 to D-37, D-42, D-51 to D-54): after the safety patch's tier, local and
// attested checks allowed a request, the policy's steps run in one fixed order, each with one rule and one sentence: allowed models, the place (endpoint),
// its ceiling, a pin or binding, an authorization, an accredited device (reported unless your organization turns refusal on), residency, the model's
// passport (reported only) and clearance. Report mode never refuses. No network, no clock, no key: authorizations arrive already verified.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseEndpoints } from '../domain/gate/endpoints';
import type { PolicyEndpoint } from '../domain/gate/endpoints';
import type { Mark } from '../domain/gate/dominance';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { DEFAULT_ROUTING, PRIVATE_FLOOR_TEXT, ROUTE_REFUSALS, decideRoute, endpointOf, parseRouting } from '../domain/gate/routing';
import type { RouteFacts, RoutePolicy, RoutingTable } from '../domain/gate/routing';
import { FIXED_NOW } from './helpers/policyFixtures';

function label(scale: string, level: string, extra: Partial<Label> = {}): Label {
  return { scale, level, compartments: [], releasability: [], handling: [], ...extra };
}
const org = (level: string, extra: Partial<Label> = {}): Label => label('org', level, extra);
const markOf = (...labels: Label[]): Mark => labels;

const NOW = FIXED_NOW;
const NEAR_HOST = 'https://cloud-api.near.ai/v1';
const NEAR_TEE: RouteFacts = { clientRoute: 'near', host: NEAR_HOST, nearEndpoint: true, model: { id: 'tee-model', privacyBoundary: 'tee' }, attestationFailed: false, now: NOW };
const NEAR_TEE_BOUND: RouteFacts = { ...NEAR_TEE, binding: { state: 'bound', host: NEAR_HOST, checkedAt: NOW - 60_000 } };
const NEAR_CLOUD: RouteFacts = { ...NEAR_TEE, model: { id: 'cloud-model', privacyBoundary: 'cloud' } };
const LOCAL_OK: RouteFacts = { clientRoute: 'local', host: 'http://127.0.0.1:11434', nearEndpoint: false, model: { id: 'local-model', privacyBoundary: 'local' }, attestationFailed: false, now: NOW };
const LOCAL_REMOTE: RouteFacts = { ...LOCAL_OK, host: 'https://models.example.org' };

function routingWith(levels: Record<string, string>, ...hosts: string[]): RoutingTable {
  const parsed = parseRouting({ levels: { ...DEFAULT_ROUTING.levels, ...levels }, handling: { ...DEFAULT_ROUTING.handling }, compartments: { ...DEFAULT_ROUTING.compartments }, localHosts: hosts }, SCALE_PRESETS);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

function endpoints(...entries: Array<Record<string, unknown>>): readonly PolicyEndpoint[] {
  const sorted = [...entries].sort((a, b) => (String(a['id']) < String(b['id']) ? -1 : 1));
  const parsed = parseEndpoints(sorted, SCALE_PRESETS);
  assert.equal(parsed.ok, true, parsed.ok ? '' : `${parsed.reason} ${parsed.path}`);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

function policyWith(overrides: Partial<RoutePolicy> = {}): RoutePolicy {
  return { endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: false, requireAccreditedDevice: false, now: NOW, ...overrides };
}

/** A SHA-256 hex made at test time from a word, the shape of a TLS pin; never a written key. */
function pin(word: string): string {
  return createHash('sha256').update(word, 'utf8').digest('hex');
}

const MODELS_CA = { id: 'models-ca', class: 'org-plain', host: 'models.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Internal'] };

// ---- Task 1: the policy argument, the place of a request, the endpoint and ceiling steps, allowed models ----

test('tracer: an org-plain place your rules list carries org Internal and refuses content above its ceiling', () => {
  const routing = routingWith({}, 'models.example.org');
  const policy = policyWith({ endpoints: endpoints(MODELS_CA) });
  const internal = decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, policy);
  assert.deepEqual({ allowed: internal.allowed, tier: internal.tier, rule: internal.rule }, { allowed: true, tier: 'attested-cloud', rule: 'route.attested-cloud' });
  const place = internal.endpoint;
  assert.deepEqual(place === undefined ? undefined : { id: place.id, class: place.class, region: place.region, implicit: place.implicit }, { id: 'models-ca', class: 'org-plain', region: 'CA', implicit: false });
  assert.deepEqual(internal.allowedBy, [{ kind: 'routing', label: 'org/Internal' }]);
  const sensitive = decideRoute(markOf(org('Confidential')), routing, LOCAL_REMOTE, undefined, undefined, policy);
  assert.deepEqual({ allowed: sensitive.allowed, tier: sensitive.tier, rule: sensitive.rule }, { allowed: false, tier: 'attested-cloud', rule: 'route.endpoint-ceiling' });
  assert.equal(sensitive.reason, ROUTE_REFUSALS['route.endpoint-ceiling']);
  // A mark of two labels: every label must fit the ceiling.
  assert.equal(decideRoute(markOf(org('Public'), org('Confidential')), routing, LOCAL_REMOTE, undefined, undefined, policy).rule, 'route.endpoint-ceiling');
  // Without the policy the same request goes as the safety patch decided it.
  assert.equal(decideRoute(markOf(org('Confidential')), routing, LOCAL_REMOTE).allowed, true);
});

test('a host your routing names as local but your list of places does not name is refused above any-cloud (route.endpoint-unknown)', () => {
  const routing = routingWith({}, 'other.example.org');
  const facts: RouteFacts = { ...LOCAL_OK, host: 'https://other.example.org' };
  assert.equal(decideRoute(markOf(org('Restricted')), routing, facts).allowed, true, 'the patch allows it');
  const refused = decideRoute(markOf(org('Restricted')), routing, facts, undefined, undefined, policyWith({ endpoints: endpoints(MODELS_CA) }));
  assert.deepEqual({ allowed: refused.allowed, rule: refused.rule, reason: refused.reason }, { allowed: false, rule: 'route.endpoint-unknown', reason: ROUTE_REFUSALS['route.endpoint-unknown'] });
  // At any-cloud an unlisted host is allowed with no place on the decision.
  const open = decideRoute(markOf(org('Public')), routing, facts, undefined, undefined, policyWith());
  assert.deepEqual({ allowed: open.allowed, rule: open.rule, endpoint: open.endpoint }, { allowed: true, rule: 'route.any-cloud', endpoint: undefined });
});

test('the place of a request: loopback is this computer, NEAR AI Cloud\'s endpoint with no entry is its private hardware or forwarded, a listed entry wins', () => {
  assert.deepEqual(endpointOf(LOCAL_OK, []), { class: 'local', region: 'unstated', implicit: true, tlsPins: [] });
  assert.deepEqual(endpointOf({ ...LOCAL_OK, host: 'http://[::1]:8080' }, []), { class: 'local', region: 'unstated', implicit: true, tlsPins: [] });
  assert.deepEqual(endpointOf(NEAR_TEE, []), { class: 'nearai-tee', region: 'unstated', implicit: true, tlsPins: [] });
  assert.deepEqual(endpointOf(NEAR_CLOUD, []), { class: 'forwarded', region: 'unstated', implicit: true, tlsPins: [] });
  assert.equal(endpointOf({ ...NEAR_TEE, model: undefined }, [])?.class, 'forwarded', 'an unknown model is not private');
  const listed = endpoints({ id: 'near', class: 'nearai-tee', host: 'cloud-api.near.ai', scheme: 'https', tlsPins: [], region: 'US', maxLabel: ['org/Confidential'], provider: 'nearai' });
  assert.deepEqual(endpointOf(NEAR_CLOUD, listed), { id: 'near', class: 'nearai-tee', region: 'US', provider: 'nearai', implicit: false, tlsPins: [] });
  assert.equal(endpointOf(LOCAL_REMOTE, []), undefined);
  assert.equal(endpointOf({ ...LOCAL_REMOTE, host: 'not a host' }, listed), undefined);
  // Through decideRoute: a loopback model and NEAR AI Cloud's private hardware carry their implicit place.
  assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith()).endpoint?.class, 'local');
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE_BOUND, undefined, undefined, policyWith()).endpoint?.class, 'nearai-tee');
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD, undefined, undefined, policyWith()).endpoint?.class, 'forwarded');
  // An implicit place adds no ceiling: org Internal reaches NEAR AI Cloud's private hardware with no entry.
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE_BOUND, undefined, undefined, policyWith()).allowed, true);
  // A listed entry's ceiling does apply to the NEAR host.
  const capped = endpoints({ id: 'near', class: 'nearai-tee', host: 'cloud-api.near.ai', scheme: 'https', tlsPins: [], region: 'US', maxLabel: ['org/Public'] });
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE_BOUND, undefined, undefined, policyWith({ endpoints: capped })).rule, 'route.endpoint-ceiling');
});

test('D-37: a model outside the allowed list is refused (route.model-not-allowed), with or without a policy; a listed one goes', () => {
  const facts: RouteFacts = { ...NEAR_CLOUD, model: { id: 'example/chat-b', privacyBoundary: 'cloud' }, allowedModels: ['example/chat-a'] };
  for (const policy of [undefined, policyWith()]) {
    const refused = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, facts, undefined, undefined, policy);
    assert.deepEqual({ allowed: refused.allowed, rule: refused.rule, reason: refused.reason }, { allowed: false, rule: 'route.model-not-allowed', reason: ROUTE_REFUSALS['route.model-not-allowed'] });
    const listed = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, { ...facts, model: { id: 'example/chat-a' } }, undefined, undefined, policy);
    assert.equal(listed.allowed, true);
    // An unknown model is not on any list.
    assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, { ...facts, model: undefined }, undefined, undefined, policy).rule, 'route.model-not-allowed');
  }
  // An empty list allows no model; a refusal the patch made keeps its own rule.
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, { ...facts, allowedModels: [] }).rule, 'route.model-not-allowed');
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, facts).rule, 'route.not-tee');
});

test('FND-02: with neither a policy nor an allowed list decideRoute decides as the safety patch did, with no new keys', () => {
  const marks = [markOf(org('Public')), markOf(org('Internal')), markOf(org('Restricted')), markOf(label('ca-classified', 'Secret')), markOf(label('ca-protected', 'Protected B'))];
  const factsList = [NEAR_TEE, NEAR_TEE_BOUND, NEAR_CLOUD, LOCAL_OK, LOCAL_REMOTE, { ...NEAR_TEE, sessionless: true }];
  for (const mark of marks) {
    for (const facts of factsList) {
      for (const floor of [undefined, 'attested-cloud' as const]) {
        const decision = decideRoute(mark, DEFAULT_ROUTING, facts, undefined, floor);
        assert.deepEqual(decideRoute(mark, DEFAULT_ROUTING, facts, undefined, floor, undefined), decision);
        for (const key of Object.keys(decision)) assert.ok(['allowed', 'tier', 'rule', 'reason'].includes(key), key);
      }
    }
  }
});

test('a request the safety patch refused is returned unchanged with a policy, the private floor\'s words included', () => {
  const policy = policyWith({ endpoints: endpoints(MODELS_CA) });
  for (const [mark, facts, floor] of [
    [markOf(org('Restricted')), NEAR_TEE, undefined],
    [markOf(org('Public')), NEAR_CLOUD, 'attested-cloud'],
    [markOf(org('Internal')), LOCAL_REMOTE, undefined]
  ] as const) {
    const without = decideRoute(mark, DEFAULT_ROUTING, facts, undefined, floor);
    assert.equal(without.allowed, false);
    assert.deepEqual(decideRoute(mark, DEFAULT_ROUTING, facts, undefined, floor, policy), without);
  }
  const floored = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD, undefined, 'attested-cloud', policy);
  assert.ok(floored.reason?.includes(PRIVATE_FLOOR_TEXT));
});

test('allowedBy starts with the routing record of the strictest label, or of the default label for an empty mark', () => {
  const policy = policyWith();
  const decision = decideRoute(markOf(org('Public'), org('Restricted')), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policy);
  assert.deepEqual(decision.allowedBy, [{ kind: 'routing', label: 'org/Restricted' }]);
  const empty = decideRoute([], DEFAULT_ROUTING, LOCAL_OK, org('Internal'), undefined, policy);
  assert.deepEqual(empty.allowedBy, [{ kind: 'routing', label: 'org/Internal' }]);
  assert.equal(decision.wouldRefuse, undefined);
  assert.equal(decision.pinTo, undefined);
});

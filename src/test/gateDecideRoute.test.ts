// decideRoute over a v2 policy (FND-03 to FND-06, Phase 41 D-24 to D-27, D-33 to D-37, D-42, D-51 to D-54): after the safety patch's tier, local and
// attested checks allowed a request, the policy's steps run in one fixed order, each with one rule and one sentence: allowed models, the place (endpoint),
// its ceiling, a pin or binding, an authorization, an accredited device (reported unless your organization turns refusal on), residency, the model's
// passport (reported only) and clearance. Report mode never refuses. No network, no clock, no key: authorizations arrive already verified.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { migrateLocalHosts, parseEndpoints } from '../domain/gate/endpoints';
import type { PolicyEndpoint } from '../domain/gate/endpoints';
import type { Mark } from '../domain/gate/dominance';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import {
  DEFAULT_ROUTING, ENDPOINT_SCHEME_TEXT, PRIVATE_FLOOR_TEXT, ROUTE_REFUSALS, ROUTE_RULES, ROUTE_RULES_NAMED_AHEAD, decideRoute as decideRouteOnce, effectiveClearances, endpointOf, parseRouting
} from '../domain/gate/routing';
import { PASSPORT_GAP_TEXT, whoToAsk } from '../domain/gate/passportStep';
import type { RouteDecision, RouteFacts, RoutePolicy, RoutingTable } from '../domain/gate/routing';
import type { AuthorizationBody } from '../domain/gate/authorizations';
import type { VerifiedAuthorization } from '../domain/gate/routing';
import { DAY_MS, FIXED_NOW, authorizationFor, evaluatedModels } from './helpers/policyFixtures';

/** Every rule a decision in this file returned, with or without a policy: the last test checks none is route.export-control (D-63). */
const RULES_SEEN = new Set<string>();

/** decideRoute itself, recording the rule of every decision this file makes. */
function decideRoute(...args: Parameters<typeof decideRouteOnce>): RouteDecision {
  const decision = decideRouteOnce(...args);
  RULES_SEEN.add(decision.rule);
  return decision;
}

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
  assert.deepEqual(endpointOf(NEAR_TEE, listed), { id: 'near', class: 'nearai-tee', region: 'US', provider: 'nearai', implicit: false, tlsPins: [] });
  // CR-02: the entry is NEAR AI's private hardware, so a model NEAR AI forwards elsewhere is forwarded, with no region and no id, even on that host.
  assert.deepEqual(endpointOf(NEAR_CLOUD, listed), { class: 'forwarded', region: 'unstated', implicit: true, tlsPins: [] });
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
  // 74.1 D-12: with no models section the passport step reports with the shipped passports; local-model has none.
  assert.deepEqual(decision.wouldRefuse, ['route.passport']);
  assert.equal(decision.pinTo, undefined);
});

// ---- Task 2: a pin or binding, an authorization, an accredited device and residency (D-26, D-27, D-33, D-34, D-52, D-54) ----

const PROTECTED_B = label('ca-protected', 'Protected B');
const NATO_RESTRICTED = label('nato', 'NATO Restricted');
const SECRET = label('ca-classified', 'Secret');
const PINS = [pin('models-ca-one'), pin('models-ca-two')].sort();
const MODELS_CA_PB = { ...MODELS_CA, maxLabel: ['ca-protected/Protected B', 'nato/NATO Restricted', 'org/Restricted'] };
const PB_ROUTING = routingWith({}, 'models.example.org');

function verified(body: AuthorizationBody, selfSigned = false): VerifiedAuthorization {
  return { body, selfSigned };
}

function pbFor(endpoint: string, extra: Partial<Parameters<typeof authorizationFor>[0]> = {}): VerifiedAuthorization {
  return verified(authorizationFor({ kind: 'protected-b', id: `pb-${endpoint}`, subject: { endpoint }, ...extra }));
}

test('Protected B on your organization\'s plain server: no pin is route.endpoint-pin, a pin and no authorization is route.authorization-missing, both go with pinTo', () => {
  const noPins = decideRoute(markOf(PROTECTED_B), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: endpoints(MODELS_CA_PB), authorizations: [pbFor('models-ca')] }));
  assert.deepEqual({ allowed: noPins.allowed, rule: noPins.rule, reason: noPins.reason }, { allowed: false, rule: 'route.endpoint-pin', reason: ROUTE_REFUSALS['route.endpoint-pin'] });
  const pinned = endpoints({ ...MODELS_CA_PB, tlsPins: PINS });
  const noAuthorization = decideRoute(markOf(PROTECTED_B), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: pinned }));
  assert.deepEqual({ allowed: noAuthorization.allowed, rule: noAuthorization.rule, reason: noAuthorization.reason }, { allowed: false, rule: 'route.authorization-missing', reason: ROUTE_REFUSALS['route.authorization-missing'] });
  const authorization = pbFor('models-ca', { id: 'pb-007', scope: { labels: ['ca-protected/Protected B'] } });
  const allowed = decideRoute(markOf(PROTECTED_B), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: pinned, authorizations: [authorization] }));
  assert.deepEqual({ allowed: allowed.allowed, rule: allowed.rule }, { allowed: true, rule: 'route.local-only' });
  assert.deepEqual(allowed.pinTo, PINS);
  assert.deepEqual(allowed.allowedBy, [
    { kind: 'routing', label: 'ca-protected/Protected B' },
    { kind: 'authorization', authorizationKind: 'protected-b', id: 'pb-007', name: 'Alex Example', expiresAt: authorization.body.expiresAt, selfSigned: false, label: 'ca-protected/Protected B' }
  ]);
});

test('T-41-102: an authorization naming another place, an expired or revoked one, one scoped to another project, label or use, or another kind refuses', () => {
  const pinned = endpoints({ ...MODELS_CA_PB, tlsPins: PINS });
  const refusedWith = (authorization: VerifiedAuthorization, extra: Partial<RoutePolicy> = {}, facts: RouteFacts = LOCAL_REMOTE): void => {
    const decision = decideRoute(markOf(PROTECTED_B), PB_ROUTING, facts, undefined, undefined, policyWith({ endpoints: pinned, authorizations: [authorization], ...extra }));
    assert.equal(decision.rule, 'route.authorization-missing', authorization.body.id);
  };
  refusedWith(pbFor('models-other'));
  refusedWith(pbFor('models-ca', { id: 'expired', issuedAt: new Date(NOW - 400 * DAY_MS).toISOString(), days: 365 }));
  refusedWith(pbFor('models-ca', { id: 'revoked', revokedBy: 'pb-008' }));
  refusedWith(pbFor('models-ca', { id: 'other-project', scope: { projects: ['project-beta'] } }), { project: 'project-alpha' });
  // D-54: no project is known in this phase, so a record scoped to projects covers nothing yet.
  refusedWith(pbFor('models-ca', { id: 'scoped', scope: { projects: ['project-alpha'] } }));
  refusedWith(pbFor('models-ca', { id: 'other-label', scope: { labels: ['nato/NATO Restricted'] } }));
  refusedWith(pbFor('models-ca', { id: 'no-use', scope: { uses: ['t1'] } }));
  refusedWith(pbFor('models-ca', { id: 'other-use', scope: { uses: ['t2'] } }), {}, { ...LOCAL_REMOTE, use: 'T1' });
  refusedWith(verified(authorizationFor({ kind: 'residency-exception', id: 'other-kind', subject: { endpoint: 'models-ca' } })));
  // The allowed side of each: the right project, and the use in lowercase.
  const scoped = decideRoute(markOf(PROTECTED_B), PB_ROUTING, { ...LOCAL_REMOTE, use: 'T1' }, undefined, undefined, policyWith({
    endpoints: pinned, project: 'project-alpha', authorizations: [pbFor('models-ca', { scope: { projects: ['project-alpha'], uses: ['t1'] } })]
  }));
  assert.equal(scoped.allowed, true);
});

test('D-52: org Restricted on that server needs neither a pin nor an authorization; NATO Restricted needs both', () => {
  const unpinned = policyWith({ endpoints: endpoints(MODELS_CA_PB) });
  const restricted = decideRoute(markOf(org('Restricted')), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, unpinned);
  assert.deepEqual({ allowed: restricted.allowed, rule: restricted.rule, pinTo: restricted.pinTo }, { allowed: true, rule: 'route.local-only', pinTo: undefined });
  assert.equal(decideRoute(markOf(NATO_RESTRICTED), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, unpinned).rule, 'route.endpoint-pin');
  const pinned = endpoints({ ...MODELS_CA_PB, tlsPins: PINS });
  assert.equal(decideRoute(markOf(NATO_RESTRICTED), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: pinned })).rule, 'route.authorization-missing');
  const nato = decideRoute(markOf(NATO_RESTRICTED), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: pinned, authorizations: [pbFor('models-ca')] }));
  assert.deepEqual({ allowed: nato.allowed, pinTo: nato.pinTo }, { allowed: true, pinTo: PINS });
  // A pin on the entry is carried only when a level needs it.
  assert.equal(decideRoute(markOf(org('Restricted')), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: pinned })).pinTo, undefined);
  // This computer needs neither, for any level.
  assert.equal(decideRoute(markOf(PROTECTED_B), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith()).allowed, true);
});

test('Protected B routed any-cloud: NEAR AI Cloud listed as private hardware needs a fresh bound connection and the authorization', () => {
  const routing = routingWith({ 'ca-protected/Protected B': 'any-cloud' });
  const near = endpoints({ id: 'near', class: 'nearai-tee', host: 'cloud-api.near.ai', scheme: 'https', tlsPins: [], region: 'US', maxLabel: ['ca-protected/Protected B'], provider: 'nearai' });
  const policy = policyWith({ endpoints: near, authorizations: [pbFor('near')] });
  assert.equal(decideRoute(markOf(PROTECTED_B), routing, NEAR_TEE).allowed, true, 'the routing table alone sends it');
  const bound = decideRoute(markOf(PROTECTED_B), routing, NEAR_TEE_BOUND, undefined, undefined, policy);
  assert.deepEqual({ allowed: bound.allowed, rule: bound.rule, pinTo: bound.pinTo }, { allowed: true, rule: 'route.any-cloud', pinTo: undefined });
  for (const facts of [NEAR_TEE, { ...NEAR_TEE_BOUND, now: NOW + 3_600_000 }, { ...NEAR_TEE_BOUND, binding: { ...NEAR_TEE_BOUND.binding!, host: 'https://other.example.org' } }]) {
    assert.equal(decideRoute(markOf(PROTECTED_B), routing, facts, undefined, undefined, policy).rule, 'route.endpoint-pin');
  }
  assert.equal(decideRoute(markOf(PROTECTED_B), routing, NEAR_TEE_BOUND, undefined, undefined, policyWith({ endpoints: near })).rule, 'route.authorization-missing');
});

test('Protected B routed any-cloud: a vendor region with ceiling and authorization goes (no pin rule); the implicit NEAR place cannot be named; an unnamed host is unknown', () => {
  const routing = routingWith({ 'ca-protected/Protected B': 'any-cloud' });
  const vendor = endpoints({ id: 'vendor-ca', class: 'vendor-region', host: 'ca.example.net', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['ca-protected/Protected B'], provider: 'example' });
  const facts: RouteFacts = { clientRoute: 'near', host: 'https://ca.example.net/v1', nearEndpoint: false, model: { id: 'example/chat', privacyBoundary: 'cloud' }, attestationFailed: false, now: NOW };
  const allowed = decideRoute(markOf(PROTECTED_B), routing, facts, undefined, undefined, policyWith({ endpoints: vendor, authorizations: [pbFor('vendor-ca')] }));
  assert.deepEqual({ allowed: allowed.allowed, pinTo: allowed.pinTo, place: allowed.endpoint?.id }, { allowed: true, pinTo: undefined, place: 'vendor-ca' });
  assert.equal(decideRoute(markOf(PROTECTED_B), routing, facts, undefined, undefined, policyWith({ endpoints: vendor })).rule, 'route.authorization-missing');
  // NEAR AI Cloud with no entry: the binding passes, but a place with no id cannot be named by an authorization.
  assert.equal(decideRoute(markOf(PROTECTED_B), routing, NEAR_TEE_BOUND, undefined, undefined, policyWith({ authorizations: [pbFor('near')] })).rule, 'route.authorization-missing');
  assert.equal(decideRoute(markOf(PROTECTED_B), routing, NEAR_TEE, undefined, undefined, policyWith()).rule, 'route.endpoint-pin');
  // A host no entry names: unknown for a level that needs an authorization, allowed at any-cloud for one that does not.
  const unnamed: RouteFacts = { ...facts, host: 'https://unlisted.example.net' };
  assert.equal(decideRoute(markOf(PROTECTED_B), routing, unnamed, undefined, undefined, policyWith({ endpoints: vendor })).rule, 'route.endpoint-unknown');
  assert.equal(decideRoute(markOf(org('Public')), routing, unnamed, undefined, undefined, policyWith({ endpoints: vendor })).allowed, true);
});

test('D-34: Secret on this computer with no accredited-device authorization is allowed and reported, naming the label', () => {
  const decision = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ deviceId: 'device-1' }));
  // 74.1 D-12: local-model has no passport, so the passport report stands beside the accredited-device one.
  assert.deepEqual({ allowed: decision.allowed, rule: decision.rule, wouldRefuse: decision.wouldRefuse }, { allowed: true, rule: 'route.local-only', wouldRefuse: ['route.accredited-device', 'route.passport'] });
  assert.deepEqual(decision.notAccredited, SECRET);
  // The first such label of the mark is the one named.
  assert.deepEqual(decideRoute(markOf(org('Restricted'), label('nato', 'NATO Secret'), SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith()).notAccredited, label('nato', 'NATO Secret'));
  // Protected B and org Restricted on this computer are not this-computer-only levels: no accredited-device report (only the passport's, D-12).
  const protectedB = decideRoute(markOf(PROTECTED_B), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith());
  assert.deepEqual({ wouldRefuse: protectedB.wouldRefuse, notAccredited: protectedB.notAccredited }, { wouldRefuse: ['route.passport'], notAccredited: undefined });
});

test('D-34: an accredited-device authorization for this device clears the report and is recorded; one for another device does not', () => {
  const covering = verified(authorizationFor({ kind: 'accredited-device', id: 'accredited-device-3', subject: { device: 'device-1' } }), true);
  const decision = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ deviceId: 'device-1', authorizations: [covering] }));
  // Only the passport report of D-12 is left (local-model has no passport).
  assert.deepEqual({ allowed: decision.allowed, wouldRefuse: decision.wouldRefuse, notAccredited: decision.notAccredited }, { allowed: true, wouldRefuse: ['route.passport'], notAccredited: undefined });
  assert.deepEqual(decision.allowedBy?.[1], { kind: 'authorization', authorizationKind: 'accredited-device', id: 'accredited-device-3', name: 'Alex Example', expiresAt: covering.body.expiresAt, selfSigned: true, label: 'ca-classified/Secret' });
  for (const policy of [policyWith({ deviceId: 'device-2', authorizations: [covering] }), policyWith({ authorizations: [covering] })]) {
    assert.deepEqual(decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policy).wouldRefuse, ['route.accredited-device', 'route.passport']);
  }
});

test('D-34: requireAccreditedDevice refuses only with an organization layer present; without one it still only reports', () => {
  const required = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ organization: true, requireAccreditedDevice: true, deviceId: 'device-1' }));
  assert.deepEqual({ allowed: required.allowed, rule: required.rule, reason: required.reason }, { allowed: false, rule: 'route.accredited-device', reason: ROUTE_REFUSALS['route.accredited-device'] });
  for (const [organization, requireAccreditedDevice] of [[false, true], [true, false], [false, false]] as const) {
    const reported = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ organization, requireAccreditedDevice, deviceId: 'device-1' }));
    assert.deepEqual({ allowed: reported.allowed, wouldRefuse: reported.wouldRefuse }, { allowed: true, wouldRefuse: ['route.accredited-device', 'route.passport'] }, `${String(organization)} ${String(requireAccreditedDevice)}`);
  }
  // A covering authorization lets it go under the switch too.
  const covering = verified(authorizationFor({ kind: 'accredited-device', subject: { device: 'device-1' } }));
  assert.equal(decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ organization: true, requireAccreditedDevice: true, deviceId: 'device-1', authorizations: [covering] })).allowed, true);
});

test('D-33: route.residency refuses a place outside the regions your rules name; a place inside them, this computer and no residency section go', () => {
  const routing = routingWith({}, 'models.example.org');
  const us = endpoints({ ...MODELS_CA, region: 'US' });
  const residency = { v: 1 as const, required: ['CA' as const] };
  const refused = decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: us, residency }));
  assert.deepEqual({ allowed: refused.allowed, rule: refused.rule, reason: refused.reason }, { allowed: false, rule: 'route.residency', reason: ROUTE_REFUSALS['route.residency'] });
  assert.equal(decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: endpoints(MODELS_CA), residency })).allowed, true);
  assert.equal(decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: us })).allowed, true, 'no residency section');
  assert.equal(decideRoute(markOf(org('Internal')), routing, LOCAL_OK, undefined, undefined, policyWith({ endpoints: us, residency })).allowed, true, 'this computer');
  // NEAR AI Cloud's implicit place states no region, so it never satisfies a residency rule.
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE_BOUND, undefined, undefined, policyWith({ residency })).rule, 'route.residency');
  // At any-cloud a host no entry names counts as unstated.
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, { ...LOCAL_REMOTE, clientRoute: 'near' }, undefined, undefined, policyWith({ residency })).rule, 'route.residency');
  // byLevel holds only the labels it names.
  const byLevel = { v: 1 as const, byLevel: { 'org/Internal': ['CA' as const] } };
  assert.equal(decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: us, residency: byLevel })).rule, 'route.residency');
  assert.equal(decideRoute(markOf(org('Public')), routing, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: us, residency: byLevel })).allowed, true);
});

test('D-33: a residency exception covering the place lets it go and is recorded as what allowed it', () => {
  const routing = routingWith({}, 'models.example.org');
  const us = endpoints({ ...MODELS_CA, region: 'US' });
  const exception = verified(authorizationFor({ kind: 'residency-exception', id: 'residency-exception-2', subject: { endpoint: 'models-ca' }, scope: { labels: ['org/Internal'] } }));
  const decision = decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: us, residency: { v: 1, required: ['CA'] }, authorizations: [exception] }));
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.allowedBy?.[1], { kind: 'authorization', authorizationKind: 'residency-exception', id: 'residency-exception-2', name: 'Alex Example', expiresAt: exception.body.expiresAt, selfSigned: false });
});

test('D-36 order: the ceiling is decided before residency, and a pin before residency', () => {
  const routing = routingWith({}, 'models.example.org');
  const residency = { v: 1 as const, required: ['EU' as const] };
  assert.equal(decideRoute(markOf(org('Confidential')), routing, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: endpoints(MODELS_CA), residency })).rule, 'route.endpoint-ceiling');
  assert.equal(decideRoute(markOf(PROTECTED_B), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: endpoints(MODELS_CA_PB), residency, authorizations: [pbFor('models-ca')] })).rule, 'route.endpoint-pin');
  assert.equal(decideRoute(markOf(PROTECTED_B), PB_ROUTING, LOCAL_REMOTE, undefined, undefined, policyWith({ endpoints: endpoints({ ...MODELS_CA_PB, tlsPins: PINS }), residency })).rule, 'route.authorization-missing');
});

// ---- Task 3: the passport in report mode, clearance, the step order and the private floor (D-35, D-36, D-42, D-53) ----

const DEEPSEEK: RouteFacts = { ...NEAR_TEE_BOUND, model: { id: 'deepseek-ai/DeepSeek-V3.1', privacyBoundary: 'tee' } };
const ENFORCE = { v: 1 as const, mode: 'enforce' as const, unknownMaxTier: 'T0' as const, passports: [] };
const SHIPPED_EXPIRY = '2027-11-20T00:00:00.000Z';

test('D-42, 74.1 D-11: a T0 model on NEAR AI private hardware at use T1 is reported as route.passport under report and refused under enforce', () => {
  const reported = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...DEEPSEEK, use: 'T1' }, undefined, undefined, policyWith({ models: { ...ENFORCE, mode: 'report' } }));
  assert.deepEqual({ allowed: reported.allowed, rule: reported.rule, wouldRefuse: reported.wouldRefuse, passportGap: reported.passportGap },
    { allowed: true, rule: 'route.attested-cloud', wouldRefuse: ['route.passport'], passportGap: 'acceptance-missing' });
  assert.equal(reported.allowedBy?.some((record) => record.kind === 'model-approval'), false);
  const enforced = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...DEEPSEEK, use: 'T1' }, undefined, undefined, policyWith({ models: ENFORCE }));
  assert.deepEqual({ allowed: enforced.allowed, rule: enforced.rule, reason: enforced.reason, passportGap: enforced.passportGap },
    { allowed: false, rule: 'route.passport', reason: PASSPORT_GAP_TEXT['acceptance-missing']({ model: 'deepseek-ai/DeepSeek-V3.1', use: 'T1', whoToAsk: whoToAsk(undefined, false) }), passportGap: 'acceptance-missing' });
});

test('D-42: a t1-risk authorization covering the model clears the report and is recorded with the model approval', () => {
  const risk = verified(authorizationFor({ kind: 't1-risk', id: 't1-risk-4', subject: { model: 'deepseek-ai/deepseek' }, scope: { uses: ['t1'], labels: ['org/Internal'] } }));
  const decision = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...DEEPSEEK, use: 'T1' }, undefined, undefined, policyWith({ models: ENFORCE, authorizations: [risk] }));
  assert.equal(decision.wouldRefuse, undefined);
  assert.deepEqual(decision.allowedBy, [
    { kind: 'routing', label: 'org/Internal' },
    { kind: 'model-approval', passport: 'deepseek-ai/deepseek', maxTier: 'T0', expiresAt: SHIPPED_EXPIRY },
    // 74.1-06 (D-16): its assessment reference stands in for your organization's evaluation, so it is recorded with it.
    { kind: 'authorization', authorizationKind: 't1-risk', id: 't1-risk-4', name: 'Alex Example', expiresAt: risk.body.expiresAt, selfSigned: false, evidence: risk.body.evidence }
  ]);
  // One for another model, or for another label, does not: under enforce the request is refused with acceptance-missing.
  const other = verified(authorizationFor({ kind: 't1-risk', subject: { model: 'moonshotai/kimi' } }));
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...DEEPSEEK, use: 'T1' }, undefined, undefined, policyWith({ models: ENFORCE, authorizations: [other] })).passportGap, 'acceptance-missing');
  const otherLabel = verified(authorizationFor({ kind: 't1-risk', subject: { model: 'deepseek-ai/deepseek' }, scope: { labels: ['org/Public'] } }));
  const refused = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...DEEPSEEK, use: 'T1' }, undefined, undefined, policyWith({ models: ENFORCE, authorizations: [otherLabel] }));
  assert.deepEqual({ allowed: refused.allowed, rule: refused.rule, passportGap: refused.passportGap }, { allowed: false, rule: 'route.passport', passportGap: 'acceptance-missing' });
});

test('D-42, 74.1 D-11: a passport below the use or not listing the place\'s class is refused under enforce; one that covers both records the approval', () => {
  const gptOss: RouteFacts = { ...NEAR_TEE_BOUND, model: { id: 'openai/gpt-oss-120b', privacyBoundary: 'tee' } };
  const above = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...gptOss, use: 'T3' }, undefined, undefined, policyWith({ models: ENFORCE }));
  assert.deepEqual({ allowed: above.allowed, rule: above.rule, passportGap: above.passportGap }, { allowed: false, rule: 'route.passport', passportGap: 'tier-exceeded' });
  const aboveReported = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...gptOss, use: 'T3' }, undefined, undefined, policyWith({ models: { ...ENFORCE, mode: 'report' } }));
  assert.deepEqual({ allowed: aboveReported.allowed, wouldRefuse: aboveReported.wouldRefuse }, { allowed: true, wouldRefuse: ['route.passport'] });
  // 74.1-06 (D-16): under enforce agent work also needs your organization's evaluation, which the shipped row lacks and its own passport carries.
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...gptOss, use: 'T2' }, undefined, undefined, policyWith({ models: ENFORCE })).passportGap, 'not-evaluated');
  const covered = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...gptOss, use: 'T2' }, undefined, undefined, policyWith({ models: evaluatedModels('enforce', ['openai/gpt-oss']) }));
  assert.equal(covered.allowed, true);
  assert.equal(covered.wouldRefuse, undefined);
  assert.deepEqual(covered.allowedBy?.[1], { kind: 'model-approval', passport: 'openai/gpt-oss', maxTier: 'T2', expiresAt: SHIPPED_EXPIRY });
  // A closed model NEAR AI forwards: its passport lists only closed APIs, so a forwarded place is refused (hosting-mismatch).
  const claude: RouteFacts = { ...NEAR_CLOUD, model: { id: 'anthropic/claude-example', privacyBoundary: 'cloud' } };
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, claude, undefined, undefined, policyWith({ models: ENFORCE })).passportGap, 'hosting-mismatch');
  // An unknown model at T1 is refused (unknown); at T0 it is covered and nothing is recorded.
  const unknown: RouteFacts = { ...NEAR_CLOUD, model: { id: 'example/unlisted-model', privacyBoundary: 'cloud' } };
  const unknownRefused = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, unknown, undefined, undefined, policyWith({ models: ENFORCE }));
  assert.deepEqual({ rule: unknownRefused.rule, passportGap: unknownRefused.passportGap }, { rule: 'route.passport', passportGap: 'unknown' });
  const t0 = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, { ...unknown, use: 'T0' }, undefined, undefined, policyWith({ models: ENFORCE }));
  assert.deepEqual({ wouldRefuse: t0.wouldRefuse, allowedBy: t0.allowedBy }, { wouldRefuse: undefined, allowedBy: [{ kind: 'routing', label: 'org/Public' }] });
});

test('74.1 D-12: no models section reports with the shipped passports and never refuses; no use is checked as T1', () => {
  const noSection = decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...DEEPSEEK, use: 'T3' }, undefined, undefined, policyWith());
  assert.deepEqual({ allowed: noSection.allowed, wouldRefuse: noSection.wouldRefuse, passportGap: noSection.passportGap }, { allowed: true, wouldRefuse: ['route.passport'], passportGap: 'tier-exceeded' });
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...DEEPSEEK, use: 'T0' }, undefined, undefined, policyWith()).wouldRefuse, undefined);
  // No use is checked as T1: a T0 passport then needs a risk acceptance.
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, DEEPSEEK, undefined, undefined, policyWith({ models: ENFORCE })).passportGap, 'acceptance-missing');
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, { ...DEEPSEEK, use: 'T0' }, undefined, undefined, policyWith({ models: ENFORCE })).allowed, true);
  // Both reports together, sorted (report mode).
  const both = decideRoute(markOf(label('ca-classified', 'Secret')), DEFAULT_ROUTING, { ...LOCAL_OK, use: 'T1' }, undefined, undefined, policyWith({ models: { ...ENFORCE, mode: 'report' } }));
  assert.deepEqual(both.wouldRefuse, ['route.accredited-device', 'route.passport']);
});

const clearance = (scale: string, level: string): { scale: string; level: string; compartments: string[]; releasability: string[] } => ({ scale, level, compartments: [], releasability: [] });

test('D-35, D-53: with a roster clearance, a mark the meet of personal and roster clearances does not dominate is refused route.clearance', () => {
  const policy = policyWith({ clearances: [clearance('org', 'Restricted')], rosterClearances: [clearance('org', 'Internal')] });
  const refused = decideRoute(markOf(org('Confidential')), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policy);
  assert.deepEqual({ allowed: refused.allowed, rule: refused.rule, reason: refused.reason }, { allowed: false, rule: 'route.clearance', reason: ROUTE_REFUSALS['route.clearance'] });
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policy).allowed, true);
  // The roster can only narrow: a wider roster leaves the personal clearance in force.
  const wider = policyWith({ clearances: [clearance('org', 'Internal')], rosterClearances: [clearance('org', 'Restricted')] });
  assert.equal(decideRoute(markOf(org('Confidential')), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, wider).rule, 'route.clearance');
  // A roster on a scale the personal clearance cannot meet leaves no clearance at all.
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ clearances: [clearance('org', 'Restricted')], rosterClearances: [clearance('nato', 'NATO Secret')] })).rule, 'route.clearance');
});

test('D-53: without a roster clearance the clearance step does nothing, so today\'s routing is unchanged', () => {
  const policy = policyWith({ clearances: [clearance('org', 'Public')] });
  assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policy).allowed, true);
  assert.equal(decideRoute(markOf(label('ca-protected', 'Protected B')), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith()).allowed, true);
});

test('effectiveClearances: the personal clearances alone without a roster, otherwise every defined meet of a personal and a roster clearance', () => {
  const personal = [clearance('org', 'Restricted'), clearance('ca-protected', 'Protected B')];
  assert.deepEqual(effectiveClearances(personal, undefined, SCALE_PRESETS, []), personal);
  const met = effectiveClearances(personal, [clearance('org', 'Internal'), clearance('ca-protected', 'Protected A')], SCALE_PRESETS, []);
  assert.deepEqual(met.map((entry) => `${entry.scale}/${entry.level}`).sort(), ['ca-protected/Protected A', 'org/Internal']);
  assert.deepEqual(effectiveClearances(personal, [], SCALE_PRESETS, []), []);
});

test('D-36 order: model, place, ceiling, pin, authorization, residency and clearance refuse in that order; a report never hides a later refusal', () => {
  const routing = routingWith({}, 'models.example.org');
  const everything = policyWith({
    endpoints: endpoints({ ...MODELS_CA, region: 'US' }), residency: { v: 1, required: ['CA'] }, models: { ...ENFORCE, mode: 'report' },
    clearances: [clearance('org', 'Public')], rosterClearances: [clearance('org', 'Public')]
  });
  assert.equal(decideRoute(markOf(org('Confidential')), routing, { ...LOCAL_REMOTE, allowedModels: [] }, undefined, undefined, everything).rule, 'route.model-not-allowed');
  assert.equal(decideRoute(markOf(org('Confidential')), routing, LOCAL_REMOTE, undefined, undefined, { ...everything, endpoints: [] }).rule, 'route.endpoint-unknown');
  assert.equal(decideRoute(markOf(org('Confidential')), routing, LOCAL_REMOTE, undefined, undefined, everything).rule, 'route.endpoint-ceiling');
  assert.equal(decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, everything).rule, 'route.residency');
  assert.equal(decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, { ...everything, residency: undefined }).rule, 'route.clearance');
  // 74.1 D-11: under enforce the passport (step 7) refuses before clearance (step 8), and after residency.
  assert.equal(decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, { ...everything, models: ENFORCE }).rule, 'route.residency');
  assert.equal(decideRoute(markOf(org('Internal')), routing, LOCAL_REMOTE, undefined, undefined, { ...everything, residency: undefined, models: ENFORCE }).rule, 'route.passport');
  // On this computer: the accredited-device and passport reports stand, and the clearance refusal still decides.
  const secret = markOf(label('ca-classified', 'Secret'));
  const reported = policyWith({ models: { ...ENFORCE, mode: 'report' } });
  assert.deepEqual(decideRoute(secret, DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, reported).wouldRefuse, ['route.accredited-device', 'route.passport']);
  const narrowed = decideRoute(secret, DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, { ...reported, clearances: [clearance('org', 'Public')], rosterClearances: [clearance('org', 'Public')] });
  assert.deepEqual({ allowed: narrowed.allowed, rule: narrowed.rule }, { allowed: false, rule: 'route.clearance' });
});

test('S4 floor: the patch\'s floor refusal keeps PRIVATE_FLOOR_TEXT with a policy; a policy step refusing a floored request never adds it', () => {
  const policy = policyWith({ residency: { v: 1, required: ['CA'] } });
  const floored = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD, undefined, 'attested-cloud', policy);
  assert.equal(floored.rule, 'route.not-tee');
  assert.ok(floored.reason?.startsWith(`Nothing was sent. ${PRIVATE_FLOOR_TEXT}`));
  const residency = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_TEE_BOUND, undefined, 'attested-cloud', policy);
  assert.deepEqual({ rule: residency.rule, tier: residency.tier, reason: residency.reason }, { rule: 'route.residency', tier: 'attested-cloud', reason: ROUTE_REFUSALS['route.residency'] });
  assert.ok(!(residency.reason ?? '').includes(PRIVATE_FLOOR_TEXT));
});

test('D-63: no decision in this file returned route.export-control; it stays named ahead and off ROUTE_RULES', () => {
  assert.ok(RULES_SEEN.size >= 15, `${String(RULES_SEEN.size)} rules seen`);
  assert.equal(RULES_SEEN.has('route.export-control'), false);
  assert.ok((ROUTE_RULES_NAMED_AHEAD as readonly string[]).includes('route.export-control'));
  assert.equal((ROUTE_RULES as readonly string[]).includes('route.export-control'), false);
});

// ---- Code review fixes (41-REVIEW CR-02, WR-03, WR-05) ----

/** NEAR AI Cloud's own host, listed as its private hardware in Canada (the shape D-24 gives NEAR AI Cloud). */
const NEAR_CA = { id: 'near-ca', class: 'nearai-tee', host: 'cloud-api.near.ai', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Confidential'] };

test('CR-02: a model NEAR AI forwards, on NEAR AI Cloud\'s host listed as its private hardware in Canada, is forwarded with no region, so a Canada residency rule refuses it', () => {
  const policy = policyWith({ endpoints: endpoints(NEAR_CA), residency: { v: 1, required: ['CA'] } });
  const forwarded = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD, undefined, undefined, policy);
  assert.deepEqual({ allowed: forwarded.allowed, rule: forwarded.rule, reason: forwarded.reason }, { allowed: false, rule: 'route.residency', reason: ROUTE_REFUSALS['route.residency'] });
  assert.deepEqual(endpointOf(NEAR_CLOUD, endpoints(NEAR_CA)), { class: 'forwarded', region: 'unstated', implicit: true, tlsPins: [] });
  // A model the catalog does not know is not private either.
  assert.equal(decideRoute(markOf(org('Public')), DEFAULT_ROUTING, { ...NEAR_TEE, model: undefined }, undefined, undefined, policy).rule, 'route.residency');
  // The allowed side: a TEE model runs in the listed private hardware in Canada, at any-cloud and at an attested-cloud level.
  const tee = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_TEE, undefined, undefined, policy);
  assert.deepEqual({ allowed: tee.allowed, rule: tee.rule, endpoint: tee.endpoint }, { allowed: true, rule: 'route.any-cloud', endpoint: { id: 'near-ca', class: 'nearai-tee', region: 'CA', implicit: false, tlsPins: [] } });
  assert.equal(decideRoute(markOf(org('Internal')), DEFAULT_ROUTING, NEAR_TEE_BOUND, undefined, undefined, policy).allowed, true);
  // With no residency rule the forwarded model still goes at any-cloud, and its place says forwarded, with no region and no id.
  const open = decideRoute(markOf(org('Public')), DEFAULT_ROUTING, NEAR_CLOUD, undefined, undefined, policyWith({ endpoints: endpoints(NEAR_CA) }));
  assert.deepEqual({ allowed: open.allowed, endpoint: open.endpoint }, { allowed: true, endpoint: { class: 'forwarded', region: 'unstated', implicit: true, tlsPins: [] } });
});

test('CR-02: a forwarded model on a listed private-hardware entry keeps the entry\'s ceiling, takes the limits of a forwarding service, and no authorization naming the entry covers it', () => {
  // A routing table your organization relaxed, so the table itself sends org Restricted and Protected B to any cloud.
  const relaxed = routingWith({ 'org/Restricted': 'any-cloud', 'ca-protected/Protected B': 'any-cloud' });
  const wide = endpoints({ ...NEAR_CA, maxLabel: ['ca-protected/Protected B', 'org/Restricted'] });
  const restricted = decideRoute(markOf(org('Restricted')), relaxed, NEAR_CLOUD, undefined, undefined, policyWith({ endpoints: wide }));
  assert.deepEqual({ allowed: restricted.allowed, rule: restricted.rule, reason: restricted.reason }, { allowed: false, rule: 'route.endpoint-ceiling', reason: ROUTE_REFUSALS['route.endpoint-ceiling'] });
  assert.equal(decideRoute(markOf(org('Restricted')), relaxed, NEAR_TEE, undefined, undefined, policyWith({ endpoints: wide })).allowed, true);
  // The entry's own ceiling still holds for the forwarded model.
  const capped = endpoints({ ...NEAR_CA, maxLabel: ['org/Public'] });
  assert.equal(decideRoute(markOf(org('Internal')), routingWith({ 'org/Internal': 'any-cloud' }), NEAR_CLOUD, undefined, undefined, policyWith({ endpoints: capped })).rule, 'route.endpoint-ceiling');
  // Protected B: the authorization names the entry for its private hardware, so it never covers a model NEAR AI forwards, even over a proven connection.
  const policy = policyWith({ endpoints: wide, authorizations: [pbFor('near-ca', { scope: { labels: ['ca-protected/Protected B'] } })] });
  const forwarded = decideRoute(markOf(PROTECTED_B), relaxed, { ...NEAR_CLOUD, binding: NEAR_TEE_BOUND.binding }, undefined, undefined, policy);
  assert.deepEqual({ allowed: forwarded.allowed, rule: forwarded.rule }, { allowed: false, rule: 'route.authorization-missing' });
  const tee = decideRoute(markOf(PROTECTED_B), relaxed, NEAR_TEE_BOUND, undefined, undefined, policy);
  assert.deepEqual({ allowed: tee.allowed, rule: tee.rule, id: tee.endpoint?.id }, { allowed: true, rule: 'route.any-cloud', id: 'near-ca' });
});

/** Your organization's plain server, listed over https. */
const LLM = { id: 'llm', class: 'org-plain', host: 'llm.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Confidential'] };
const LLM_HTTP: RouteFacts = { ...LOCAL_OK, host: 'http://llm.example.org:8080/v1' };
const LLM_HTTPS: RouteFacts = { ...LOCAL_OK, host: 'https://llm.example.org/v1' };

test('WR-03: a place your rules list over https refuses a plain http connection at every level (route.endpoint-pin); over https it goes', () => {
  const routing = routingWith({}, 'llm.example.org');
  const policy = policyWith({ endpoints: endpoints(LLM) });
  assert.ok(ENDPOINT_SCHEME_TEXT.startsWith('Nothing was sent. '));
  for (const level of ['Public', 'Internal', 'Confidential']) {
    const refused = decideRoute(markOf(org(level)), routing, LLM_HTTP, undefined, undefined, policy);
    assert.deepEqual({ allowed: refused.allowed, rule: refused.rule, reason: refused.reason }, { allowed: false, rule: 'route.endpoint-pin', reason: ENDPOINT_SCHEME_TEXT }, level);
    assert.equal(decideRoute(markOf(org(level)), routing, LLM_HTTPS, undefined, undefined, policy).allowed, true, level);
  }
  // Without a policy the safety patch decides as before.
  assert.equal(decideRoute(markOf(org('Internal')), routing, LLM_HTTP).allowed, true);
  // A host your list does not name declared no scheme: content at any-cloud still goes to it over http.
  assert.equal(decideRoute(markOf(org('Public')), routing, { ...LOCAL_OK, host: 'http://other.example.org:8080/v1' }, undefined, undefined, policy).allowed, true);
  // This computer is not on the network: a local entry declared https still takes plain http on loopback.
  const laptop = endpoints({ id: 'laptop', class: 'local', host: '127.0.0.1', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Restricted'] });
  assert.equal(decideRoute(markOf(org('Restricted')), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ endpoints: laptop })).allowed, true);
});

test('WR-03: a localHosts host migrated to your list is listed over https, so a runtime reached over plain http is refused from this version; over https it goes', () => {
  const routing = routingWith({}, 'llm.example.org');
  const migrated = migrateLocalHosts(routing, SCALE_PRESETS).endpoints;
  assert.equal(migrated[0]?.scheme, 'https');
  const policy = policyWith({ endpoints: migrated });
  const refused = decideRoute(markOf(org('Internal')), routing, LLM_HTTP, undefined, undefined, policy);
  assert.deepEqual({ allowed: refused.allowed, rule: refused.rule, reason: refused.reason }, { allowed: false, rule: 'route.endpoint-pin', reason: ENDPOINT_SCHEME_TEXT });
  assert.equal(decideRoute(markOf(org('Internal')), routing, LLM_HTTPS, undefined, undefined, policy).allowed, true);
});

/** A value whose every read throws: a section or record the step cannot read. */
function unreadable<T>(): T {
  const fail = (): never => { throw new Error('unreadable'); };
  return new Proxy({}, { get: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail }) as T;
}

test('WR-05: a passport step that throws is recorded as route.passport and never refuses', () => {
  const policy = policyWith({ models: unreadable() });
  for (const [mark, facts] of [[markOf(org('Internal')), NEAR_TEE_BOUND], [markOf(org('Public')), NEAR_CLOUD], [markOf(SECRET), LOCAL_OK]] as const) {
    const decision = decideRoute(mark, DEFAULT_ROUTING, facts, undefined, undefined, policy);
    assert.equal(decision.allowed, true, decision.rule);
    assert.ok(decision.wouldRefuse?.includes('route.passport'), decision.rule);
    assert.equal(decision.allowedBy?.some((record) => record.kind === 'model-approval'), false);
  }
});

test('WR-05: an accredited-device check that throws covers nothing: only reported unless your organization turns refusal on, and a readable authorization still covers', () => {
  const broken: VerifiedAuthorization = { get body(): AuthorizationBody { throw new Error('unreadable'); }, selfSigned: false };
  const reported = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ deviceId: 'device-1', authorizations: [broken] }));
  // 74.1 D-12: local-model has no passport, so the passport report stands beside it.
  assert.deepEqual({ allowed: reported.allowed, wouldRefuse: reported.wouldRefuse, notAccredited: reported.notAccredited }, { allowed: true, wouldRefuse: ['route.accredited-device', 'route.passport'], notAccredited: SECRET });
  const enforced = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ deviceId: 'device-1', authorizations: [broken], organization: true, requireAccreditedDevice: true }));
  assert.deepEqual({ allowed: enforced.allowed, rule: enforced.rule }, { allowed: false, rule: 'route.accredited-device' });
  const good = verified(authorizationFor({ kind: 'accredited-device', id: 'accredited-device-9', subject: { device: 'device-1' } }));
  const covered = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ deviceId: 'device-1', authorizations: [broken, good], organization: true, requireAccreditedDevice: true }));
  assert.deepEqual({ allowed: covered.allowed, wouldRefuse: covered.wouldRefuse }, { allowed: true, wouldRefuse: ['route.passport'] });
  // A device id that cannot be read: the same, reported or refused, never thrown.
  const noDevice = (extra: Partial<RoutePolicy>): RoutePolicy => Object.defineProperty({ ...policyWith(extra) }, 'deviceId', { get(): string { throw new Error('unreadable'); } }) as RoutePolicy;
  assert.deepEqual(decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, noDevice({})).wouldRefuse, ['route.accredited-device', 'route.passport']);
  assert.equal(decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, noDevice({ organization: true, requireAccreditedDevice: true })).rule, 'route.accredited-device');
});

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
import type { AuthorizationBody } from '../domain/gate/authorizations';
import type { VerifiedAuthorization } from '../domain/gate/routing';
import { DAY_MS, FIXED_NOW, authorizationFor } from './helpers/policyFixtures';

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
  assert.deepEqual({ allowed: decision.allowed, rule: decision.rule, wouldRefuse: decision.wouldRefuse }, { allowed: true, rule: 'route.local-only', wouldRefuse: ['route.accredited-device'] });
  assert.deepEqual(decision.notAccredited, SECRET);
  // The first such label of the mark is the one named.
  assert.deepEqual(decideRoute(markOf(org('Restricted'), label('nato', 'NATO Secret'), SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith()).notAccredited, label('nato', 'NATO Secret'));
  // Protected B and org Restricted on this computer are not this-computer-only levels: nothing is reported.
  const protectedB = decideRoute(markOf(PROTECTED_B), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith());
  assert.deepEqual({ wouldRefuse: protectedB.wouldRefuse, notAccredited: protectedB.notAccredited }, { wouldRefuse: undefined, notAccredited: undefined });
});

test('D-34: an accredited-device authorization for this device clears the report and is recorded; one for another device does not', () => {
  const covering = verified(authorizationFor({ kind: 'accredited-device', id: 'accredited-device-3', subject: { device: 'device-1' } }), true);
  const decision = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ deviceId: 'device-1', authorizations: [covering] }));
  assert.deepEqual({ allowed: decision.allowed, wouldRefuse: decision.wouldRefuse, notAccredited: decision.notAccredited }, { allowed: true, wouldRefuse: undefined, notAccredited: undefined });
  assert.deepEqual(decision.allowedBy?.[1], { kind: 'authorization', authorizationKind: 'accredited-device', id: 'accredited-device-3', name: 'Alex Example', expiresAt: covering.body.expiresAt, selfSigned: true, label: 'ca-classified/Secret' });
  for (const policy of [policyWith({ deviceId: 'device-2', authorizations: [covering] }), policyWith({ authorizations: [covering] })]) {
    assert.deepEqual(decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policy).wouldRefuse, ['route.accredited-device']);
  }
});

test('D-34: requireAccreditedDevice refuses only with an organization layer present; without one it still only reports', () => {
  const required = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ organization: true, requireAccreditedDevice: true, deviceId: 'device-1' }));
  assert.deepEqual({ allowed: required.allowed, rule: required.rule, reason: required.reason }, { allowed: false, rule: 'route.accredited-device', reason: ROUTE_REFUSALS['route.accredited-device'] });
  for (const [organization, requireAccreditedDevice] of [[false, true], [true, false], [false, false]] as const) {
    const reported = decideRoute(markOf(SECRET), DEFAULT_ROUTING, LOCAL_OK, undefined, undefined, policyWith({ organization, requireAccreditedDevice, deviceId: 'device-1' }));
    assert.deepEqual({ allowed: reported.allowed, wouldRefuse: reported.wouldRefuse }, { allowed: true, wouldRefuse: ['route.accredited-device'] }, `${String(organization)} ${String(requireAccreditedDevice)}`);
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

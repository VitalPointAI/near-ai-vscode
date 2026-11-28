// TrustFacts and the trust line (FND-06, Phase 41 D-38, D-23, D-62): one record of what a decision allowed (where it runs, what was checked, what let it
// go), and one three-part line in the glossary's words: "Runs on ... · {verified} · Allowed ...". Pure: no I/O, no clock, no vscode.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SELF_SIGNED_TEXT } from '../domain/gate/authorizations';
import { parseEndpoints } from '../domain/gate/endpoints';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { DEFAULT_ROUTING, decideRoute, parseRouting } from '../domain/gate/routing';
import type { AllowingRecord, RouteDecision, RouteFacts, RoutePolicy } from '../domain/gate/routing';
import { TRUST_LINE_TEXT, TRUST_VERIFICATION_LEVELS, dateShown, trustFactsFor, trustLine } from '../domain/gate/trust';
import type { TrustFacts, TrustPlace } from '../domain/gate/trust';
import { TRUST_BADGE_STATES } from '../domain/gate/trustBadge';
import { passportHash, resolvePassport } from '../domain/gate/models';
import { FIXED_NOW, authorizationFor, evaluatedModels } from './helpers/policyFixtures';

function label(scale: string, level: string, extra: Partial<Label> = {}): Label {
  return { scale, level, compartments: [], releasability: [], handling: [], ...extra };
}
const org = (level: string, extra: Partial<Label> = {}): Label => label('org', level, extra);

const NEAR_HOST = 'https://cloud-api.near.ai/v1';
const NEAR_TEE_BOUND: RouteFacts = {
  clientRoute: 'near', host: NEAR_HOST, nearEndpoint: true, model: { id: 'tee-model', privacyBoundary: 'tee' }, attestationFailed: false, now: FIXED_NOW,
  binding: { state: 'bound', host: NEAR_HOST, checkedAt: FIXED_NOW - 60_000 }, use: 'T2'
};
const LOCAL_OK: RouteFacts = { clientRoute: 'local', host: 'http://127.0.0.1:11434', nearEndpoint: false, model: { id: 'local-model', privacyBoundary: 'local' }, attestationFailed: false, now: FIXED_NOW };

function policyWith(overrides: Partial<RoutePolicy> = {}): RoutePolicy {
  return { endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: false, requireAccreditedDevice: false, now: FIXED_NOW, ...overrides };
}

function facts(place: TrustPlace, extra: Partial<TrustFacts> = {}): TrustFacts {
  return { place, verification: 'verified-private', allowedBy: [{ kind: 'routing', label: 'org/Internal' }], label: org('Internal'), wouldRefuse: [], ...extra };
}

const runsOn = (place: TrustPlace): string => trustLine(facts(place), SCALE_PRESETS).runsOn;

test('tracer: an allowed NEAR AI private hardware request becomes one TrustFacts record and one three-part line', () => {
  const mark = [org('Internal')];
  const decision = decideRoute(mark, DEFAULT_ROUTING, NEAR_TEE_BOUND);
  const trust = trustFactsFor(decision, NEAR_TEE_BOUND, { mark, routing: DEFAULT_ROUTING });
  assert.deepEqual(trust, {
    place: { class: 'nearai-tee', region: 'unstated' }, verification: 'not-checked', allowedBy: [{ kind: 'routing', label: 'org/Internal' }], label: org('Internal'), use: 'T2', wouldRefuse: []
  });
  const line = trustLine(trust, SCALE_PRESETS);
  assert.deepEqual(line, {
    runsOn: 'Runs on NEAR AI private hardware', verified: 'Not checked yet', allowed: 'Allowed for Organization: Internal',
    text: 'Runs on NEAR AI private hardware · Not checked yet · Allowed for Organization: Internal'
  });
});

test('trustFactsFor copies a policy decision\'s place, allowing records and reports, and takes the badge\'s verification when given', () => {
  const endpoints = parseEndpoints([{ id: 'vault-ca', class: 'vendor-region', host: 'ca.example.net', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Internal'], provider: 'cohere-vault' }], SCALE_PRESETS);
  assert.equal(endpoints.ok, true);
  if (!endpoints.ok) return;
  const request: RouteFacts = { clientRoute: 'near', host: 'https://ca.example.net', nearEndpoint: false, model: { id: 'deepseek-ai/DeepSeek-V3', privacyBoundary: 'cloud' }, attestationFailed: false, now: FIXED_NOW };
  const mark = [org('Public')];
  const decision = decideRoute(mark, DEFAULT_ROUTING, request, undefined, undefined, policyWith({ endpoints: endpoints.value, models: { v: 1, mode: 'report', unknownMaxTier: 'T0', passports: [] } }));
  assert.equal(decision.allowed, true);
  const trust = trustFactsFor(decision, request, { mark, routing: DEFAULT_ROUTING }, { verification: 'not-verified' });
  assert.deepEqual(trust.place, { class: 'vendor-region', region: 'CA', provider: 'cohere-vault', endpointId: 'vault-ca' });
  assert.deepEqual(trust.wouldRefuse, ['route.passport']);
  assert.deepEqual(trust.allowedBy, decision.allowedBy);
  assert.equal(trust.verification, 'not-verified');
  assert.equal(trustLine(trust, SCALE_PRESETS).text, 'Runs on Cohere vault in Canada · Not verified · Allowed for Organization: Public');
});

test('with no place on the decision, the place comes from the client: this computer, a host your rules name, NEAR AI Cloud, or unknown', () => {
  const mark = [org('Public')];
  const placeOf = (request: RouteFacts, extra?: { forwardedTo?: string }, routing = DEFAULT_ROUTING): TrustPlace => trustFactsFor(decideRoute(mark, routing, request), request, { mark, routing }, extra).place;
  assert.deepEqual(placeOf(LOCAL_OK), { class: 'local', region: 'unstated' });
  const named = parseRouting({ ...DEFAULT_ROUTING, localHosts: ['models.example.org'] }, SCALE_PRESETS);
  assert.equal(named.ok, true);
  if (!named.ok) return;
  assert.deepEqual(placeOf({ ...LOCAL_OK, host: 'https://models.example.org' }, undefined, named.value), { class: 'org-plain', region: 'unstated' });
  assert.deepEqual(placeOf(NEAR_TEE_BOUND), { class: 'nearai-tee', region: 'unstated' });
  const cloud: RouteFacts = { ...NEAR_TEE_BOUND, model: { id: 'example/forwarded', privacyBoundary: 'cloud' } };
  assert.deepEqual(placeOf(cloud, { forwardedTo: 'example-host.example' }), { class: 'forwarded', region: 'unstated', forwardedTo: 'example-host.example' });
  assert.deepEqual(placeOf({ ...LOCAL_OK, clientRoute: 'near', host: 'https://unlisted.example.net' }), { class: 'unknown', region: 'unstated' });
  // A refused decision has nothing that allowed it.
  const refused = decideRoute([org('Restricted')], DEFAULT_ROUTING, NEAR_TEE_BOUND);
  assert.deepEqual(trustFactsFor(refused, NEAR_TEE_BOUND, { mark: [org('Restricted')], routing: DEFAULT_ROUTING }).allowedBy, []);
  // An empty mark is the default label's.
  const fromDefault = trustFactsFor(decideRoute([], DEFAULT_ROUTING, LOCAL_OK, org('Internal')), LOCAL_OK, { mark: [], routing: DEFAULT_ROUTING, defaultLabel: org('Internal') });
  assert.deepEqual({ label: fromDefault.label, allowedBy: fromDefault.allowedBy }, { label: org('Internal'), allowedBy: [{ kind: 'routing', label: 'org/Internal' }] });
});

test('CR-02: on NEAR AI Cloud\'s host listed as its private hardware in Canada, a forwarded model\'s line says an outside provider, not private hardware; a TEE model\'s place is the entry in Canada', () => {
  const listed = parseEndpoints([{ id: 'near-ca', class: 'nearai-tee', host: 'cloud-api.near.ai', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Confidential'] }], SCALE_PRESETS);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const mark = [org('Public')];
  const policy = policyWith({ endpoints: listed.value });
  const cloud: RouteFacts = { ...NEAR_TEE_BOUND, model: { id: 'example/forwarded', privacyBoundary: 'cloud' } };
  const forwarded = trustFactsFor(decideRoute(mark, DEFAULT_ROUTING, cloud, undefined, undefined, policy), cloud, { mark, routing: DEFAULT_ROUTING }, { forwardedTo: 'example-host.example' });
  assert.deepEqual(forwarded.place, { class: 'forwarded', region: 'unstated', forwardedTo: 'example-host.example' });
  const forwardedLine = trustLine(forwarded, SCALE_PRESETS).runsOn;
  assert.equal(forwardedLine, 'Runs on outside provider (example-host.example)');
  assert.ok(!forwardedLine.includes('private hardware') && !forwardedLine.includes('Canada'), forwardedLine);
  const tee = trustFactsFor(decideRoute(mark, DEFAULT_ROUTING, NEAR_TEE_BOUND, undefined, undefined, policy), NEAR_TEE_BOUND, { mark, routing: DEFAULT_ROUTING });
  assert.deepEqual(tee.place, { class: 'nearai-tee', region: 'CA', endpointId: 'near-ca' });
  assert.equal(trustLine(tee, SCALE_PRESETS).runsOn, 'Runs on NEAR AI private hardware');
});

test('Runs on: this computer', () => {
  assert.equal(runsOn({ class: 'local', region: 'CA' }), 'Runs on this computer');
});

test('Runs on: your organization\'s server', () => {
  assert.equal(runsOn({ class: 'org-plain', region: 'CA', endpointId: 'models-ca' }), 'Runs on your organization\'s server');
});

test('Runs on: your organization\'s server (private hardware)', () => {
  assert.equal(runsOn({ class: 'org-tee', region: 'CA' }), 'Runs on your organization\'s server (private hardware)');
});

test('Runs on: NEAR AI private hardware', () => {
  assert.equal(runsOn({ class: 'nearai-tee', region: 'unstated' }), 'Runs on NEAR AI private hardware');
});

test('Runs on: Cohere vault in Canada, for a vendor place whose provider is Cohere\'s', () => {
  assert.equal(runsOn({ class: 'vendor-tee', region: 'CA', provider: 'cohere' }), 'Runs on Cohere vault in Canada');
  assert.equal(runsOn({ class: 'vendor-region', region: 'CA', provider: 'cohere-north' }), 'Runs on Cohere vault in Canada');
  assert.equal(runsOn({ class: 'vendor-region', region: 'EU', provider: 'cohere' }), 'Runs on Cohere vault in the European Union');
  assert.equal(runsOn({ class: 'vendor-region', region: 'unstated', provider: 'cohere' }), 'Runs on Cohere vault');
  assert.equal(runsOn({ class: 'vendor-region', region: 'US', provider: 'example' }), 'Runs on outside provider (example) in the United States');
});

test('Runs on: outside provider, named by where NEAR AI forwards the model', () => {
  assert.equal(runsOn({ class: 'forwarded', region: 'unstated', forwardedTo: 'example-host.example' }), 'Runs on outside provider (example-host.example)');
  assert.equal(runsOn({ class: 'forwarded', region: 'unstated' }), 'Runs on an outside provider');
});

test('Runs on: outside provider, named by the closed API', () => {
  assert.equal(runsOn({ class: 'closed-api', region: 'US', provider: 'example-api' }), 'Runs on outside provider (example-api)');
});

test('Runs on: a place your rules do not name', () => {
  assert.equal(runsOn({ class: 'unknown', region: 'unstated' }), 'Runs on a place your rules do not name');
});

test('Verified: the three shipped proof levels and the state before a check', () => {
  assert.deepEqual([...TRUST_VERIFICATION_LEVELS], [...TRUST_BADGE_STATES, 'not-checked']);
  const words = TRUST_VERIFICATION_LEVELS.map((verification) => trustLine(facts({ class: 'nearai-tee', region: 'unstated' }, { verification }), SCALE_PRESETS).verified);
  assert.deepEqual(words, ['Verified', 'Model verified, connection not proven', 'Not verified', 'Not checked yet']);
});

test('Allowed by the routing table: the label as a person reads it (S8: org Confidential reads Sensitive)', () => {
  const line = trustLine(facts({ class: 'local', region: 'unstated' }, { label: org('Confidential'), allowedBy: [{ kind: 'routing', label: 'org/Confidential' }] }), SCALE_PRESETS);
  assert.equal(line.allowed, 'Allowed for Organization: Sensitive');
  assert.ok(!line.text.includes('org/Confidential'), 'never a raw key');
});

test('D-62: an export marking is shown after the level, and TrustFacts keeps the label\'s compartments exactly as decided', () => {
  const marked = org('Internal', { compartments: ['ITAR'] });
  const decision = decideRoute([marked], DEFAULT_ROUTING, LOCAL_OK);
  assert.equal(decision.allowed, true);
  const trust = trustFactsFor(decision, LOCAL_OK, { mark: [marked], routing: DEFAULT_ROUTING });
  assert.deepEqual(trust.label?.compartments, ['ITAR']);
  assert.deepEqual(trust.allowedBy, [{ kind: 'routing', label: 'org/Internal' }]);
  assert.equal(trustLine(trust, SCALE_PRESETS).allowed, 'Allowed for Organization: Internal · ITAR');
  const both = trustLine(facts({ class: 'local', region: 'unstated' }, { label: label('ca-protected', 'Protected B', { compartments: ['ITAR', 'CGP', 'OTHER'] }), allowedBy: [{ kind: 'routing', label: 'ca-protected/Protected B' }] }), SCALE_PRESETS);
  assert.equal(both.allowed, 'Allowed for Canada, Protected: Protected B · Controlled goods (Canada) · ITAR');
});

const PB_RECORD: AllowingRecord = {
  kind: 'authorization', authorizationKind: 'protected-b', id: 'pb-007', name: 'A. Example', expiresAt: '2027-12-01T00:00:00.000Z', selfSigned: false, label: 'ca-protected/Protected B'
};

test('Allowed by an authorization: the label, the person, the record and its end; a self-signed one says so (D-23)', () => {
  const pb = label('ca-protected', 'Protected B');
  const signed = trustLine(facts({ class: 'org-plain', region: 'CA' }, { label: pb, allowedBy: [{ kind: 'routing', label: 'ca-protected/Protected B' }, PB_RECORD] }), SCALE_PRESETS);
  assert.equal(signed.allowed, 'Allowed for Canada, Protected: Protected B by A. Example\'s authorization pb-007 until 1 Dec 2027');
  const self = trustLine(facts({ class: 'org-plain', region: 'CA' }, { label: pb, allowedBy: [{ ...PB_RECORD, selfSigned: true }] }), SCALE_PRESETS);
  assert.equal(self.allowed, `Allowed for Canada, Protected: Protected B by A. Example's authorization pb-007 until 1 Dec 2027 (${SELF_SIGNED_TEXT})`);
  // A record checked for the whole request (a residency exception) names no label.
  const exception: AllowingRecord = { kind: 'authorization', authorizationKind: 'residency-exception', id: 're-2', name: 'A. Example', expiresAt: '2027-02-18T00:00:00.000Z', selfSigned: false };
  assert.equal(trustLine(facts({ class: 'vendor-region', region: 'US', provider: 'example' }, { allowedBy: [{ kind: 'routing', label: 'org/Internal' }, exception] }), SCALE_PRESETS).allowed,
    'Allowed for Organization: Internal; Allowed by A. Example\'s authorization re-2 until 18 Feb 2027');
});

test('Allowed through a real decision: Protected B on a pinned server with a named person\'s authorization', () => {
  const pins = [createHash('sha256').update('trust-line-pin', 'utf8').digest('hex')];
  const endpoints = parseEndpoints([{ id: 'models-ca', class: 'org-plain', host: 'models.example.org', scheme: 'https', tlsPins: pins, region: 'CA', maxLabel: ['ca-protected/Protected B'] }], SCALE_PRESETS);
  const routing = parseRouting({ ...DEFAULT_ROUTING, localHosts: ['models.example.org'] }, SCALE_PRESETS);
  assert.ok(endpoints.ok && routing.ok);
  if (!endpoints.ok || !routing.ok) return;
  const body = authorizationFor({ kind: 'protected-b', id: 'pb-007', subject: { endpoint: 'models-ca' }, namedPerson: { name: 'A. Example', role: 'Security officer' } });
  const request: RouteFacts = { ...LOCAL_OK, host: 'https://models.example.org' };
  const mark = [label('ca-protected', 'Protected B')];
  const decision: RouteDecision = decideRoute(mark, routing.value, request, undefined, undefined, policyWith({ endpoints: endpoints.value, authorizations: [{ body, selfSigned: true }] }));
  assert.equal(decision.allowed, true);
  const line = trustLine(trustFactsFor(decision, request, { mark, routing: routing.value }), SCALE_PRESETS);
  assert.equal(line.text, `Runs on your organization's server · Not checked yet · Allowed for Canada, Protected: Protected B by A. Example's authorization pb-007 until 20 Nov 2027 (${SELF_SIGNED_TEXT})`);
});

test('Approved by a model approval: the use words and the passport\'s end', () => {
  const approval: AllowingRecord = { kind: 'model-approval', passport: 'openai/gpt-oss', maxTier: 'T2', expiresAt: '2027-11-20T00:00:00.000Z' };
  const line = trustLine(facts({ class: 'nearai-tee', region: 'unstated' }, { allowedBy: [{ kind: 'routing', label: 'org/Internal' }, approval] }), SCALE_PRESETS);
  assert.equal(line.allowed, 'Allowed for Organization: Internal; Approved for agent work until 20 Nov 2027');
  assert.equal(line.text, 'Runs on NEAR AI private hardware · Verified · Allowed for Organization: Internal; Approved for agent work until 20 Nov 2027');
});

test('the fixed words hold no em-dash and none of the words people never see; dates read "1 Dec 2027" in UTC', () => {
  const words: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') words.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(TRUST_LINE_TEXT);
  assert.ok(words.length >= 20, `${String(words.length)} words`);
  for (const word of words) {
    assert.ok(!word.includes(String.fromCharCode(0x2014)), word);
    for (const forbidden of [/TEE/, /\btier/i, /attested/i, /endpoint/i, /residency/i, /passport/i, /Team Mode/, /NEAR organization/]) assert.ok(!forbidden.test(word), `${word} says ${String(forbidden)}`);
  }
  assert.ok(Object.isFrozen(TRUST_LINE_TEXT));
  assert.equal(dateShown('2027-12-01T00:00:00.000Z'), '1 Dec 2027');
  assert.equal(dateShown('2027-01-31T23:59:59.000Z'), '31 Jan 2027');
  assert.equal(dateShown('2027-03-01T02:00:00.000+05:00'), '28 Feb 2027', 'UTC, not the local day');
  assert.equal(dateShown('not a date'), 'not a date');
});

test('74.1 D-23: TrustFacts of an allowed request carry the passport hash beside its model-approval record and the use the step checked', () => {
  const request: RouteFacts = { ...NEAR_TEE_BOUND, model: { id: 'openai/gpt-oss-120b', privacyBoundary: 'tee' }, use: 'T2' };
  const mark = [org('Internal')];
  // 74.1-06 (D-16): under enforce, agent work needs your organization's evaluation of the model, carried by its own passport.
  const models = evaluatedModels('enforce', ['openai/gpt-oss']);
  const decision = decideRoute(mark, DEFAULT_ROUTING, request, undefined, undefined, policyWith({ models }));
  assert.equal(decision.allowed, true);
  const resolved = resolvePassport(models, 'openai/gpt-oss-120b', FIXED_NOW);
  assert.ok(resolved);
  const trust = trustFactsFor(decision, request, { mark, routing: DEFAULT_ROUTING });
  assert.equal(trust.passportHash, passportHash(resolved.passport));
  assert.ok(trust.allowedBy.some((record) => record.kind === 'model-approval' && record.passport === 'openai/gpt-oss'));
  assert.equal(trust.use, 'T2');
  // Without a policy no passport decided the request, so none is named.
  assert.equal(trustFactsFor(decideRoute(mark, DEFAULT_ROUTING, request), request, { mark, routing: DEFAULT_ROUTING }).passportHash, undefined);
});

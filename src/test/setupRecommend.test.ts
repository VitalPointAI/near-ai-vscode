import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyAuthorization } from '../domain/gate/authorizations';
import { parseEndpoints } from '../domain/gate/endpoints';
import { labelKey, SCALE_PRESETS, type Label } from '../domain/gate/labels';
import { decideRoute, DEFAULT_ROUTING, ROUTE_REFUSALS, type RouteFacts, type RoutePolicy, type RoutingTable } from '../domain/gate/routing';
import { SHIPPED_PASSPORTS } from '../domain/gate/shippedPassports';
import { fillSlots } from '../domain/setup/answers';
import type { OptionKind } from '../domain/setup/ids';
import { proposeLabel } from '../domain/setup/map';
import { recommend, type OptionInput } from '../domain/setup/recommend';
import { NO_LOCAL_SERVER_TEXT, type ViabilityResult } from '../domain/setup/viability';
import * as words from '../domain/setup/words';
import { authorizationFor, deviceKey, FIXED_NOW, signAuthorization } from './helpers/policyFixtures';

const now = FIXED_NOW;
const host = 'https://near.example.org/v1';
const nearFacts: RouteFacts = {
  clientRoute: 'near', host, nearEndpoint: true, model: { id: 'private-model', privacyBoundary: 'tee' },
  attestationFailed: false, binding: { state: 'bound', host, checkedAt: now - 60_000 }, now, use: 'T2',
};
const localFacts: RouteFacts = {
  clientRoute: 'local', host: 'http://127.0.0.1:11434', nearEndpoint: false, model: { id: 'local-model', privacyBoundary: 'local' },
  attestationFailed: false, now, use: 'T2',
};
const policy: RoutePolicy = {
  endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [],
  organization: false, requireAccreditedDevice: false, now,
};
const routing = DEFAULT_ROUTING;
const defaultLabel: Label = { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] };

function option(kind: OptionKind, facts: RouteFacts, state: ViabilityResult['state'] = 'viable', answeredAt = now): OptionInput {
  const viability: ViabilityResult = {
    optionId: kind, kind, hostKind: 'desktop', state, answeredAt, models: [],
    sentence: state === 'not-detected' ? NO_LOCAL_SERVER_TEXT : undefined,
  };
  return { kind, optionId: kind, viability, facts };
}

function internalInput(answeredAt = now) {
  const { proposed } = proposeLabel({ kindOfWork: 'software', data: ['internal'], canada: 'no' }, {
    scales: policy.scales, routing,
  });
  const options = [option('this-computer', localFacts, 'not-detected'), option('near-private', nearFacts, 'viable', answeredAt)];
  return { proposed, mark: [proposed], routing, defaultLabel, policy, options, use: 'T2' as const, now, contact: 'the security officer' };
}

test('SC1 (pure): internal work, no local AI', () => {
  const input = internalInput();
  const result = recommend(input);
  assert.equal(result.recommendedId, 'near-private');
  assert.deepEqual(input.proposed, { ...defaultLabel, level: 'Internal' });
  assert.equal(result.state, 'recommended');
  assert.equal(result.reasonId, 'larger-models');
  assert.equal(result.reason, words.RECOMMEND_REASON_TEXT['larger-models']);
  assert.equal(result.options[0].outcome, 'not-available');
});

test("D-11: the outcome is the gate's", () => {
  const input = internalInput();
  const result = recommend(input);
  assert.deepEqual(result.options[1].decision, decideRoute(input.mark, routing, nearFacts, defaultLabel, undefined, policy));
});

test('a stale result is not available', () => {
  const result = recommend(internalInput(now - 600_000));
  assert.equal(result.options[1].outcome, 'not-available');
  assert.equal(result.state, 'none');
  assert.equal(result.reasonId, 'no-option');
});

const local = option('this-computer', localFacts);
const near = option('near-private', nearFacts);
const protectedB = proposeLabel({ data: ['personal'], personalSensitive: 'yes' }, { scales: policy.scales, routing }).proposed;
const canadianPolicy: RoutePolicy = { ...policy, residency: { v: 1, required: ['CA'] } };

test('GUIDE 5.4 row 1 (R5): a small local model stays available and NEAR AI is recommended', () => {
  const result = recommend({ ...internalInput(), options: [{ ...local, fitsWork: false }, near] });
  assert.equal(result.recommendedId, 'near-private');
  assert.equal(result.reasonId, 'larger-models');
  assert.equal(result.options[0].outcome, 'available');
  assert.equal(result.options[0].note, 'Smaller local models: slower and weaker on long agent runs.');
});

test('R5: an available model that does not fit stays selectable without a recommendation', () => {
  const result = recommend({ ...internalInput(), options: [{ ...local, fitsWork: false }] });
  assert.equal(result.state, 'none');
  assert.equal(result.options[0].outcome, 'available');
  assert.match(result.reason, /None of the available options fits this work/);
});

test('GUIDE 5.4 row 2 and SC4 (R3): the gate supplies the Canada refusal', () => {
  const result = recommend({ ...internalInput(), policy: canadianPolicy, options: [local, near] });
  assert.equal(result.recommendedId, 'this-computer');
  assert.equal(result.reasonId, 'stays-in-canada');
  assert.equal(result.options[1].outcome, 'ruled-out');
  assert.equal(result.options[1].refusal, ROUTE_REFUSALS['route.residency']);
});

test('SC2 and GUIDE 5.4 row 4 (R2): the starting rules keep Protected B on this computer', () => {
  const mark = [protectedB];
  const result = recommend({ ...internalInput(), mark, options: [local, near] });
  const refused = decideRoute(mark, routing, nearFacts, defaultLabel, undefined, policy);
  assert.equal(result.reasonId, 'keeps-on-controlled-machines');
  assert.equal(result.recommendedId, 'this-computer');
  assert.deepEqual(result.options[1].decision, refused);
  assert.equal(result.options[1].outcome, 'ruled-out');
  assert.equal(result.options[1].refusal, refused.reason);
});

test('R9: a scoped, verified Protected B authorization lets a named Canadian service remain available', () => {
  const endpoint = 'vendor-ca';
  const gateRouting: RoutingTable = { ...routing, levels: { ...routing.levels, [labelKey(protectedB)]: 'any-cloud' } };
  const parsed = parseEndpoints([{
    id: endpoint, class: 'vendor-region', host: 'ca.example.org', scheme: 'https', tlsPins: [],
    region: 'CA', maxLabel: [labelKey(protectedB)], provider: 'example',
  }], policy.scales);
  assert.ok(parsed.ok);
  const service = option('vendor-region', {
    clientRoute: 'near', host: 'https://ca.example.org/v1', nearEndpoint: false,
    model: { id: 'example/chat', privacyBoundary: 'cloud' }, attestationFailed: false, now,
  });
  const key = deviceKey();
  const signed = signAuthorization(authorizationFor({
    kind: 'protected-b', id: 'pb-vendor', subject: { endpoint }, scope: { uses: ['t2'] },
  }), key);
  const verified = verifyAuthorization(signed, { thisDevice: key, now });
  assert.ok(verified.ok);
  const input = {
    ...internalInput(), mark: [protectedB], routing: gateRouting, options: [local, service],
    policy: { ...canadianPolicy, endpoints: parsed.value },
  };
  const allowed = recommend({ ...input, policy: { ...input.policy, authorizations: [verified] } }).options[1];
  assert.equal(allowed.outcome, 'available');
  assert.ok(allowed.decision?.allowedBy?.some((record) => record.kind === 'authorization' && record.id === 'pb-vendor' && record.selfSigned));
  const refused = recommend(input).options[1];
  assert.equal(refused.outcome, 'ruled-out');
  assert.equal(refused.refusal, ROUTE_REFUSALS['route.authorization-missing']);
});

test('GUIDE 5.4 row 5 (R8): when no option can hold Protected B the reason names the label and contact', () => {
  const input = { ...internalInput(), mark: [protectedB], options: [near] };
  const result = recommend(input);
  assert.equal(result.state, 'none');
  assert.equal(result.reasonId, 'no-option');
  assert.match(result.reason, /Canada, Protected: Protected B/);
  assert.match(result.reason, /Ask the security officer/);
  assert.equal(result.options[0].outcome, 'ruled-out');
});

test('D-36: an approval report adds a note and does not change ranking', () => {
  const options = [local, option('near-private', { ...nearFacts, model: { id: 'openai/gpt-oss-120b', privacyBoundary: 'tee' } })];
  const input = {
    ...internalInput(), options, policy: { ...policy, models: {
      v: 1 as const, mode: 'enforce' as const, unknownMaxTier: 'T0' as const, passports: SHIPPED_PASSPORTS,
    } },
  };
  const result = recommend(input);
  assert.equal(result.recommendedId, 'this-computer');
  assert.deepEqual(result.options[0].decision?.wouldRefuse, ['route.passport']);
  assert.equal(result.options[0].note, 'No approval on record for this model yet');
  assert.equal(result.options[1].outcome, 'available');
  assert.equal(result.options[1].decision?.wouldRefuse, undefined);
});

test('SC3: a classified stop leaves no option selectable, including viable local AI', () => {
  const input = { ...internalInput(), options: [local, option('near-private', nearFacts, 'not-configured')] };
  const result = recommend({ ...input, stopped: 'classified' });
  assert.equal(result.state, 'stopped');
  assert.equal(result.reason, fillSlots(words.STOP_CLASSIFIED_TEXT, { contact: input.contact }));
  assert.equal(result.options[0].outcome, 'ruled-out');
  assert.equal(result.options[0].refusal, result.reason);
  assert.equal(result.options[1].outcome, 'not-available');
});

test('R6: the supplied order changes the winner while both options remain allowed', () => {
  const result = recommend({ ...internalInput(), options: [local, near], order: ['near-private', 'this-computer'] });
  assert.equal(result.recommendedId, 'near-private');
  assert.equal(result.reasonId, 'order');
  assert.equal(result.options[0].outcome, 'available');
});

test('D-11: 200 generated viability choices get exactly the gate decision', () => {
  const labels = Object.entries(policy.scales).flatMap(([scale, { levels }]) =>
    levels.map((level) => ({ ...defaultLabel, scale, level })));
  const options = [
    local, near,
    option('near-all', { ...nearFacts, model: { id: 'forwarded-model', privacyBoundary: 'cloud' } }),
    option('org-server', { ...localFacts, host: 'https://models.example.org' }),
    option('org-tee', { ...localFacts, host: 'https://private.example.org' }),
    option('vendor-tee', { ...nearFacts, host: 'https://vendor.example.org', nearEndpoint: false }),
    option('vendor-region', { ...nearFacts, host: 'https://ca.example.org', nearEndpoint: false }),
  ];
  const cases = labels.flatMap((label) => options.flatMap((choice) =>
    [policy, canadianPolicy].map((routePolicy) => ({ label, choice, routePolicy }))));
  let seed = 32_102;
  for (let index = cases.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const other = seed % (index + 1);
    [cases[index], cases[other]] = [cases[other], cases[index]];
  }
  assert.ok(cases.length >= 200);
  for (const { label, choice, routePolicy } of cases.slice(0, 200)) {
    const mark = [label];
    const actual = recommend({ ...internalInput(), mark, policy: routePolicy, options: [choice] }).options[0];
    const expected = decideRoute(mark, routing, choice.facts, defaultLabel, undefined, routePolicy);
    assert.equal(actual.outcome === 'ruled-out', !expected.allowed, `${labelKey(label)} with ${choice.kind}`);
    assert.deepEqual(actual.decision, expected);
    assert.equal(actual.refusal, expected.reason);
  }
});

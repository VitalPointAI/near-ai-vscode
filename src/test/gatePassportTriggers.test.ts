// Phase 74.1-06 Task 2 (D-15): a re-evaluation trigger seen on a model's place is kept once per passport hash in global storage and recorded once as
// route.passport-triggered; it is still there after a restart; a new passport hash starts clean; a file that cannot be read is reported once and never
// allows more than the passport would. Fictional models and places; the log lives in the run's own temporary folder.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ActorRef } from '../domain/gate/decide';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { parseModelsSection, resolvePassport } from '../domain/gate/models';
import type { ModelsSection } from '../domain/gate/models';
import type { DecisionRecord, PolicyRecordVersion } from '../domain/gate/record';
import { ROUTE_EVENT_IDS } from '../domain/gate/routing';
import type { RoutePolicy } from '../domain/gate/routing';
import { PASSPORT_TRIGGER_FILE, PASSPORT_TRIGGER_PROBLEM_TEXT, createPassportTriggerLog, setPassportTriggerLog } from '../gate/passportTriggers';
import { withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { routeFactsFor } from '../services/privateRoute';
import type { RouteFactsInput } from '../services/privateRoute';
import { testBundleState } from './helpers/gatedRuns';

const NEAR = 'https://cloud-api.near.ai/v1';
const MODEL = 'example/Western-Chat-8B';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 'session-test', agentId: 'main-1', agentLabel: 'agent' };

const logFile = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'passport-triggers-')), 'gate', PASSPORT_TRIGGER_FILE);

function modelsWith(expiresAt = '2027-06-01T00:00:00.000Z'): ModelsSection {
  const parsed = parseModelsSection({
    v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [{
      id: 'example/western-chat', match: ['example/Western-Chat-*'], developer: 'Example Labs', origin: 'CA',
      lineage: { family: 'example', base: 'Western Chat', teachers: [], method: 'pretrain' }, licence: { id: 'Apache-2.0', obligations: [], inherited: [] },
      legal: { coveredByUsLaw: false, entityList: false, removalOrders: [] }, hosting: ['closed-api', 'nearai-tee'], maxTier: 'T2',
      issuedAt: '2026-11-01T00:00:00.000Z', expiresAt, reevaluateOn: ['hosting-change']
    }]
  }, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : `${parsed.reason} ${parsed.path}`);
  return parsed.ok ? parsed.value : (undefined as never);
}

function routeWith(models: ModelsSection, records: DecisionRecord[]): SessionRoute {
  const state = testBundleState();
  const policy = (): RoutePolicy & { readonly policyVersion: PolicyRecordVersion } => ({
    endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: Date.now(), policyVersion: 'bundle-2', models
  });
  return { markOf: () => [], bundleState: () => state, actor: ACTOR, attestation: { failed: false }, clock: () => Date.now(), sink: { record: (record) => { records.push(record); } }, routePolicy: policy };
}

function input(place: { privacyBoundary?: 'tee' | 'cloud'; forwardedTo?: string }): RouteFactsInput {
  return {
    clientRoute: 'near', host: NEAR, info: { id: MODEL, ...place }, attestation: 'unproven', fact: { state: 'unknown', host: NEAR },
    now: Date.now(), localModelAvailable: false, sessionless: false
  };
}

const triggered = (records: readonly DecisionRecord[]): DecisionRecord[] => records.filter((record) => record.authorizations[0]?.policy.name === 'route.passport-triggered');

test('D-15: route.passport-triggered is a route event, not a rule', () => {
  assert.ok((ROUTE_EVENT_IDS as readonly string[]).includes('route.passport-triggered'));
});

test('D-15: the first place seen is kept per passport hash; a trigger fires once and is listed', () => {
  const log = createPassportTriggerLog({ file: logFile() });
  assert.deepEqual(log.seen(HASH_A, { privacyBoundary: 'tee' }), { privacyBoundary: 'tee' });
  assert.deepEqual(log.seen(HASH_A, { privacyBoundary: 'cloud', forwardedTo: 'example.com' }), { privacyBoundary: 'tee' }, 'the first place stays first');
  assert.deepEqual(log.fired(HASH_A), []);
  assert.equal(log.fire(HASH_A, 'hosting-change'), true);
  assert.equal(log.fire(HASH_A, 'hosting-change'), false, 'kept once');
  assert.deepEqual(log.fired(HASH_A), ['hosting-change']);
});

test('D-15: after a restart the first place and the fired trigger are still there; another passport hash starts clean', () => {
  const file = logFile();
  const before = createPassportTriggerLog({ file });
  before.seen(HASH_A, { privacyBoundary: 'tee' });
  before.fire(HASH_A, 'hosting-change');
  const after = createPassportTriggerLog({ file });
  assert.deepEqual(after.fired(HASH_A), ['hosting-change']);
  assert.deepEqual(after.seen(HASH_A, { privacyBoundary: 'cloud' }), { privacyBoundary: 'tee' });
  assert.deepEqual(after.fired(HASH_B), [], 'a new signed passport (a new hash) starts clean');
  assert.equal(after.fire(HASH_A, 'hosting-change'), false, 'no second record after a restart');
});

test('D-15: a file that cannot be read counts as nothing seen and nothing fired, is reported once, and is kept aside at the next write', () => {
  const file = logFile();
  createPassportTriggerLog({ file }).seen(HASH_A, { privacyBoundary: 'tee' });
  writeFileSync(file, '{ not json');
  const told: string[] = [];
  const log = createPassportTriggerLog({ file, onProblem: (text) => { told.push(text); } });
  assert.deepEqual(log.fired(HASH_A), []);
  assert.deepEqual(log.seen(HASH_A, { privacyBoundary: 'cloud' }), { privacyBoundary: 'cloud' });
  log.fired(HASH_B);
  assert.deepEqual(told, [PASSPORT_TRIGGER_PROBLEM_TEXT], 'reported once');
  assert.ok(readdirSync(path.dirname(file)).some((name) => name.startsWith(`${PASSPORT_TRIGGER_FILE}.unreadable-`)), 'the unreadable file is kept, not overwritten');
  assert.deepEqual(createPassportTriggerLog({ file }).seen(HASH_A, { privacyBoundary: 'tee' }), { privacyBoundary: 'cloud' }, 'the log is written again');
});

test('D-15: through routeFactsFor, a change of place fires hosting-change once: one route.passport-triggered record, kept in the facts', () => {
  const file = logFile();
  const restore = setPassportTriggerLog(createPassportTriggerLog({ file }));
  try {
    const records: DecisionRecord[] = [];
    const models = modelsWith();
    const route = routeWith(models, records);
    const resolved = resolvePassport(models, MODEL, Date.now());
    assert.ok(resolved);
    const first = withSessionRoute(route, () => routeFactsFor(input({ privacyBoundary: 'tee' })));
    assert.deepEqual(first.observed, { passportHash: resolved.hash, firstSeen: { privacyBoundary: 'tee' }, current: { privacyBoundary: 'tee' }, fired: [] });
    assert.equal(triggered(records).length, 0);
    const moved = withSessionRoute(route, () => routeFactsFor(input({ privacyBoundary: 'cloud', forwardedTo: 'example.com' })));
    assert.deepEqual(moved.observed?.fired, ['hosting-change']);
    const again = withSessionRoute(route, () => routeFactsFor(input({ privacyBoundary: 'tee' })));
    assert.deepEqual(again.observed?.fired, ['hosting-change'], 'a fired trigger stays fired even when the place comes back');
    const events = triggered(records);
    assert.equal(events.length, 1, 'recorded once');
    const fields = events[0]?.unmapped.nearAi as unknown as Record<string, unknown>;
    assert.deepEqual({ passport: fields['passport'], passportHash: fields['passportHash'], passportGap: fields['passportGap'] }, { passport: 'example/western-chat', passportHash: resolved.hash, passportGap: 'expired' });
    assert.match(String(events[0]?.authorizations[0]?.policy.name), /^route\.passport-triggered$/);
    // A new signed passport (here a new end date, so a new hash) starts clean.
    const renewed = withSessionRoute(routeWith(modelsWith('2027-07-01T00:00:00.000Z'), records), () => routeFactsFor(input({ privacyBoundary: 'cloud', forwardedTo: 'example.com' })));
    assert.deepEqual(renewed.observed?.fired, []);
    assert.equal(triggered(records).length, 1);
  } finally {
    restore();
  }
});

test('D-15: with no trigger log, no route policy or no passport, nothing is observed and no file is written', () => {
  const file = logFile();
  const records: DecisionRecord[] = [];
  assert.equal(withSessionRoute(routeWith(modelsWith(), records), () => routeFactsFor(input({ privacyBoundary: 'tee' }))).observed, undefined, 'no log set');
  const restore = setPassportTriggerLog(createPassportTriggerLog({ file }));
  try {
    const noPolicy: SessionRoute = { ...routeWith(modelsWith(), records), routePolicy: () => undefined };
    assert.equal(withSessionRoute(noPolicy, () => routeFactsFor(input({ privacyBoundary: 'tee' }))).observed, undefined, 'no route policy');
    const unknown = withSessionRoute(routeWith(modelsWith(), records), () => routeFactsFor({ ...input({ privacyBoundary: 'tee' }), info: { id: 'example/unlisted-7b', privacyBoundary: 'tee' } }));
    assert.equal(unknown.observed, undefined, 'a model with no passport');
    assert.equal(existsSync(file), false);
    assert.equal(records.length, 0);
  } finally {
    restore();
  }
});

test('D-15: a catalogue that has not said where the model runs keeps and compares no place, so a late privacy list fires nothing', () => {
  const restore = setPassportTriggerLog(createPassportTriggerLog({ file: logFile() }));
  try {
    const records: DecisionRecord[] = [];
    const route = routeWith(modelsWith(), records);
    const unsaid = withSessionRoute(route, () => routeFactsFor(input({})));
    assert.deepEqual({ firstSeen: unsaid.observed?.firstSeen, current: unsaid.observed?.current, fired: unsaid.observed?.fired }, { firstSeen: undefined, current: undefined, fired: [] });
    const said = withSessionRoute(route, () => routeFactsFor(input({ privacyBoundary: 'tee' })));
    assert.deepEqual({ firstSeen: said.observed?.firstSeen, fired: said.observed?.fired }, { firstSeen: { privacyBoundary: 'tee' }, fired: [] });
    assert.equal(triggered(records).length, 0);
  } finally {
    restore();
  }
});

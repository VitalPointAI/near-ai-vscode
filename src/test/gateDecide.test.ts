// decide() tests (GATE-04, GATE-05, GATE-06, D-08, D-10, D-19, D-43): the layers, in order, over a stubbed settings layer. No key, token or real path is written here.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActionPolicy } from '../domain/policy';
import { bundleHash, defaultBundlePayload } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { decide } from '../domain/gate/decide';
import type { ActorRef, GateRequest, SettingsAnswer, SettingsLayer } from '../domain/gate/decide';
import { buildDecisionRecord, validateDecisionRecord } from '../domain/gate/record';
import type { Capability } from '../domain/gate/vocabulary';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const PERSON: ActorRef = { kind: 'person', deviceFingerprint: 'dev-00000000000000000000000000000000', sessionId: 'session-1' };

function validBundleState(): BundleState {
  const payload = defaultBundlePayload({ issuer: { fingerprint: PERSON.deviceFingerprint, publicKey: 'A'.repeat(43) }, now: NOW });
  return {
    state: 'valid', bundle: payload, hash: bundleHash(payload), signer: { fingerprint: PERSON.deviceFingerprint, publicKey: 'A'.repeat(43) },
    expiresAt: payload.expiresAt, renewDue: false
  };
}

const policyOf = (mode: ActionPolicy['mode']): ActionPolicy => ({ mode, emergencyStop: false });

const write = (paths: string[]): Capability => ({ verb: 'workspaceWrite', paths });

function requestFor(effects: Capability[], overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    actor: PERSON, tool: 'Write', callId: 'call-1', effects, context: 'interactive', presence: 'person', policy: policyOf('fully-autonomous'), ...overrides
  };
}

const allows: SettingsLayer = async (): Promise<SettingsAnswer> => ({ decision: 'allow', rule: 'settings.mode.fully-autonomous' });

test('tracer: a protected write in fully-autonomous goes through decide() to an ask with no grant, and comes out as a valid decision record', async () => {
  const state = validBundleState();
  const request = requestFor([write(['.git/hooks/pre-commit'])]);
  const decided = await decide(request, state, allows);
  assert.equal(decided.outcome, 'ask');
  assert.equal(decided.rule, 'floor.protected-write');
  assert.equal(decided.floor, true);
  assert.equal(decided.offerAlwaysAllow, false);
  assert.equal(decided.allowGrant, false);
  const record = buildDecisionRecord({
    recordId: 'rec-1', sequence: 0, time: NOW, productVersion: '0.0.0', actor: PERSON, callId: request.callId, capability: write(['.git/hooks/pre-commit']),
    resource: { name: '.git/hooks/pre-commit', type: 'file' }, outcome: 'asked', rule: decided.rule, bundleHash: state.state === 'valid' ? state.hash : ''
  });
  const checked = validateDecisionRecord(record);
  assert.equal(checked.ok, true);
  assert.equal(record.class_uid, 6003);
  assert.equal(record.status_detail, 'waiting for a person');
  assert.equal(record.authorizations[0]?.policy.name, 'floor.protected-write');
});

test('tracer: the same protected write with nobody present is denied, and the floor decided it', async () => {
  const decided = await decide(requestFor([write(['.git/hooks/pre-commit'])], { presence: 'none' }), validBundleState(), allows);
  assert.equal(decided.outcome, 'deny');
  assert.equal(decided.rule, 'floor.protected-write');
  assert.equal(decided.floor, true);
  assert.match(decided.reason ?? '', /^Nobody is here to approve this, and it always needs a person: /);
  assert.equal(decided.offerAlwaysAllow, false);
  assert.equal(decided.allowGrant, false);
});

test('a plain edit with no floor fact is decided by the settings layer alone', async () => {
  const decided = await decide(requestFor([write(['src/app.ts'])]), validBundleState(), allows);
  assert.equal(decided.outcome, 'allow');
  assert.equal(decided.rule, 'settings.mode.fully-autonomous');
  assert.equal(decided.floor, false);
});

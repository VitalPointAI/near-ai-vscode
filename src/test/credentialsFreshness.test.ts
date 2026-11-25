// Freshness at the enforcement points and the gate's clearance from credentials (Phase 71 plan 07 Task 3; D-11, D-19, O6, O11, VCRD-07).
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { CredentialsSection } from '../domain/gate/credentialsSection';
import { FRESHNESS_REFUSALS, checkFreshness } from '../domain/credentials/freshness';
import { clearanceFromCredentials, declaredClearanceCounts } from '../domain/credentials/clearance';
import { factsFrom } from '../domain/credentials/mayRelease';
import type { CheckedCredential, CredentialFacts } from '../domain/credentials/mayRelease';
import type { EvidenceCitation } from '../domain/credentials/evidence';
import type { VerifiedCredential } from '../domain/credentials/profile';

const LIST = 'https://hq.example.org/v1/trust/status/revocation-1';
const HOUR = 3600 * 1000;
const POLICY = { statusTtl: 900, maxOfflineAge: { 'ca-protected/Protected A': 7 * 24 * 3600, 'ca-protected/Protected B': 72 * 3600, 'ca-classified/Secret': 24 * 3600 } } as unknown as CredentialsSection;
const FROM = '2026-11-20T00:00:00Z';
const FROM_MS = Date.parse(FROM);

function citing(validFrom = FROM): EvidenceCitation {
  return { evidence: ['a'.repeat(64)], status: [{ list: LIST, hash: 'b'.repeat(64), validFrom }] };
}

function reason(result: ReturnType<typeof checkFreshness>): string {
  return result.ok ? 'ok' : result.reason;
}

test('the newest known list, fetched within the time to live, is fresh at a connected site', () => {
  assert.equal(reason(checkFreshness(citing(), { [LIST]: { validFrom: FROM, fetchedAt: FROM_MS + 10 * 60 * 1000 } }, 'ca-classified/Secret', POLICY, FROM_MS + 20 * 60 * 1000, 'connected')), 'ok');
});

test('a list older than the newest known by more than the grace is superseded; within the grace it passes', () => {
  const newer = '2026-11-20T00:20:00Z';
  const refused = checkFreshness(citing(), { [LIST]: { validFrom: newer, fetchedAt: FROM_MS + 21 * 60 * 1000 } }, undefined, POLICY, FROM_MS + 25 * 60 * 1000, 'connected');
  assert.equal(reason(refused), 'superseded');
  if (!refused.ok) assert.equal(refused.action, 'retry');
  const withinGrace = '2026-11-20T00:10:00Z';
  assert.equal(reason(checkFreshness(citing(), { [LIST]: { validFrom: withinGrace, fetchedAt: FROM_MS + 11 * 60 * 1000 } }, undefined, POLICY, FROM_MS + 12 * 60 * 1000, 'connected')), 'ok');
});

test('the grace can be set by the caller (the hub\'s setting), in seconds', () => {
  const newer = '2026-11-20T00:20:00Z';
  assert.equal(reason(checkFreshness(citing(), { [LIST]: { validFrom: newer, fetchedAt: FROM_MS + 21 * 60 * 1000 } }, undefined, POLICY, FROM_MS + 22 * 60 * 1000, 'connected', { graceSeconds: 3600 })), 'ok');
});

test('at a connected site, lists held longer than the time to live must be fetched again', () => {
  const refused = checkFreshness(citing(), { [LIST]: { validFrom: FROM, fetchedAt: FROM_MS } }, 'ca-classified/Secret', POLICY, FROM_MS + 16 * 60 * 1000, 'connected');
  assert.equal(reason(refused), 'past-ttl');
  assert.equal(reason(checkFreshness(citing(), {}, undefined, POLICY, FROM_MS + 16 * 60 * 1000, 'connected')), 'past-ttl', 'with no record of a fetch, the list\'s own time counts');
});

test('at an edge, a list older than the level\'s maximum offline age is refused: Protected B allows 72 hours, Secret 24', () => {
  const after = (hours: number) => FROM_MS + hours * HOUR;
  assert.equal(reason(checkFreshness(citing(), {}, 'ca-protected/Protected B', POLICY, after(71), 'edge')), 'ok');
  const refused = checkFreshness(citing(), {}, 'ca-protected/Protected B', POLICY, after(73), 'edge');
  assert.equal(reason(refused), 'offline-too-long');
  if (!refused.ok) {
    assert.equal(refused.action, 'connect');
    assert.match(refused.message, /Connect to your organization's server/);
  }
  assert.equal(reason(checkFreshness(citing(), {}, 'ca-classified/Secret', POLICY, after(25), 'edge')), 'offline-too-long');
  assert.equal(reason(checkFreshness(citing(), {}, 'ca-protected/Protected A', POLICY, after(7 * 24 - 1), 'edge')), 'ok');
});

test('a level the policy gives no offline age has none at an edge; unmarked data keeps only the superseded rule there', () => {
  assert.equal(reason(checkFreshness(citing(), {}, 'ca-classified/Top Secret', POLICY, FROM_MS + HOUR, 'edge')), 'offline-too-long');
  assert.equal(reason(checkFreshness(citing(), {}, undefined, POLICY, FROM_MS + 30 * 24 * HOUR, 'edge')), 'ok');
});

test('every refusal carries one sentence and an action; unreadable times are refused', () => {
  for (const [name, refusal] of Object.entries(FRESHNESS_REFUSALS)) {
    assert.match(refusal.text, /\.$/, name);
    assert.ok(refusal.action === 'retry' || refusal.action === 'connect', name);
  }
  assert.equal(reason(checkFreshness(citing('yesterday'), {}, undefined, POLICY, FROM_MS, 'edge')), 'unreadable');
  assert.equal(reason(checkFreshness(citing(), {}, undefined, POLICY, Number.NaN, 'edge')), 'unreadable');
});

function held(type: string, claims: Record<string, unknown>, validUntil = '2027-06-01T00:00:00Z'): CheckedCredential {
  const credential = { type, issuer: 'did:webvh:QmIssuer:example.org:people:officer', validFrom: '2026-01-01T00:00:00Z', validUntil, claims: { id: 'did:webvh:QmMember:example.org:people:sam', ...claims }, status: [], suite: 'eddsa-jcs-2022', verificationMethod: 'x#y', credential: {} };
  return { credential: credential as unknown as VerifiedCredential, status: 'clear' };
}

test('clearanceFromCredentials gives the highest threshold per scale, the compartments and the tokens, and expires with the earliest credential', () => {
  const facts = factsFrom([
    held('ClearanceCredential', { scale: 'ca-classified', atLeast: 'Confidential' }), held('ClearanceCredential', { scale: 'ca-classified', atLeast: 'Secret' }, '2027-01-01T00:00:00Z'),
    held('CompartmentCredential', { compartment: 'C1' }), held('NationalityCredential', { nationality: 'CAN' })
  ]);
  const clearances = clearanceFromCredentials(facts, SCALE_PRESETS);
  assert.equal(clearances.length, 1);
  assert.deepEqual({ ...clearances[0], compartments: [...(clearances[0]?.compartments ?? [])], releasability: [...(clearances[0]?.releasability ?? [])] }, {
    scale: 'ca-classified', level: 'Secret', compartments: ['C1'], releasability: ['CAN'], expiresAt: '2027-01-01T00:00:00.000Z'
  });
});

test('clearanceFromCredentials gives nothing for an item without a check result or for facts not made from checked credentials', () => {
  const unchecked = { ...held('ClearanceCredential', { scale: 'ca-classified', atLeast: 'Secret' }), status: undefined } as unknown as CheckedCredential;
  assert.deepEqual(clearanceFromCredentials(factsFrom([unchecked]), SCALE_PRESETS), []);
  const forged = { thresholds: [{ scale: 'ca-classified', level: 'Top Secret' }], compartments: [], tokens: [], regimes: [], agreements: [], serves: [], types: [], until: Infinity } as unknown as CredentialFacts;
  assert.deepEqual(clearanceFromCredentials(forged, SCALE_PRESETS), []);
});

test('declaredClearanceCounts: with credentials required, a declared clearance counts only for unmarked data and a scale\'s lowest level', () => {
  const policy = { scales: SCALE_PRESETS };
  const at = (scale: string, level: string) => ({ scale, level, compartments: [], releasability: [], handling: [] });
  assert.equal(declaredClearanceCounts(undefined, policy, true), true);
  assert.equal(declaredClearanceCounts(at('org', 'Public'), policy, true), true);
  assert.equal(declaredClearanceCounts(at('ca-protected', 'Protected A'), policy, true), true);
  assert.equal(declaredClearanceCounts(at('ca-protected', 'Protected B'), policy, true), false);
  assert.equal(declaredClearanceCounts(at('ca-classified', 'Secret'), policy, true), false);
  assert.equal(declaredClearanceCounts(at('ca-classified', 'Secret'), policy, false), true, 'nothing changes until credentials are required');
});

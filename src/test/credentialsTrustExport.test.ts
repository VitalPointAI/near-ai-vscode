// The trust export (Phase 71 plan 11 Task 1; D-17): one .near-trust-export file of objects that each verify on their own. An edge takes only what
// verifies and is newer than what it holds, and names everything it refused. Fictional Example Organization only; every key is made at run time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrganizationLayer } from '../domain/gate/enrolment';
import { TRUST_EXPORT_EXTENSION, TRUST_EXPORT_FORMAT, buildTrustExport, didHostPath, readTrustExport } from '../domain/credentials/trustExport';
import type { HeldTrust } from '../domain/credentials/trustExport';
import { REVOCATIONS, SUSPENSIONS, list, makeWorld } from './helpers/credentialWorld';
import type { World } from './helpers/credentialWorld';
import { issuerKey, policyDocumentFor } from './helpers/policyFixtures';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const DAY = 86_400_000;

interface Setup { w: World; layer: unknown; issuer: string; held: HeldTrust }

async function setup(): Promise<Setup> {
  const w = await makeWorld();
  const signer = issuerKey();
  const doc = policyDocumentFor({ key: signer });
  const layer = buildOrganizationLayer(signer, { labels: doc.labels, agents: doc.agents, credentials: JSON.parse(JSON.stringify(w.section)) }, { now: NOW - DAY, days: 90 });
  return { w, layer, issuer: signer.publicKey, held: { issuerPublicKey: signer.publicKey, lists: {}, logs: {} } };
}

const logOf = (w: World, who: 'root' | 'officer' | 'member') => ({ path: didHostPath(w[who].did) as string, log: w[who].log });

test('tracer: an export with Alex\'s log, one status list and the policy layer reads back at an empty edge with all three taken', async () => {
  const s = await setup();
  const revocations = await list(s.w.revocationKey, REVOCATIONS, 'revocation', [3]);
  const text = buildTrustExport({ policyLayer: s.layer, logs: [logOf(s.w, 'officer')], lists: [revocations.credential], exportedAt: '2026-11-24T11:00:00Z' });
  assert.equal(JSON.parse(text).format, TRUST_EXPORT_FORMAT);
  assert.equal(TRUST_EXPORT_EXTENSION, '.near-trust-export');
  const read = readTrustExport(text, s.held, NOW);
  assert.deepEqual(read.refused, []);
  assert.ok(read.take.policyLayer !== undefined);
  assert.deepEqual(read.take.logs.map((item) => item.did), [s.w.officer.did]);
  assert.deepEqual(read.take.lists.map((item) => [item.id, item.hash]), [[REVOCATIONS, revocations.hash]]);
});

test('at an edge holding a newer list version, the older one in the file is refused as older and the rest is taken', async () => {
  const s = await setup();
  const v1 = await list(s.w.revocationKey, REVOCATIONS, 'revocation', [], { version: 1, validFrom: '2026-11-20T00:00:00Z' });
  const v2 = await list(s.w.revocationKey, REVOCATIONS, 'revocation', [9], { version: 2, validFrom: '2026-11-21T00:00:00Z' });
  const held = readTrustExport(buildTrustExport({ policyLayer: s.layer, logs: [], lists: [v2.credential], exportedAt: 'x' }), s.held, NOW).take.lists[0];
  assert.ok(held !== undefined);
  const suspensions = await list(s.w.suspensionKey, SUSPENSIONS, 'suspension', []);
  const text = buildTrustExport({ policyLayer: s.layer, logs: [logOf(s.w, 'member')], lists: [v1.credential, suspensions.credential], exportedAt: 'x' });
  const read = readTrustExport(text, { ...s.held, lists: { [REVOCATIONS]: held.state } }, NOW);
  assert.deepEqual(read.refused.map((item) => [item.kind, item.reason]), [['status-list', 'older']]);
  assert.deepEqual(read.take.lists.map((item) => item.id), [SUSPENSIONS]);
  assert.equal(read.take.logs.length, 1);
});

test('a newer list that clears a revocation the edge holds is refused', async () => {
  const s = await setup();
  const v1 = await list(s.w.revocationKey, REVOCATIONS, 'revocation', [4], { version: 1, validFrom: '2026-11-20T00:00:00Z' });
  const v2 = await list(s.w.revocationKey, REVOCATIONS, 'revocation', [], { version: 2, validFrom: '2026-11-21T00:00:00Z' });
  const held = readTrustExport(buildTrustExport({ policyLayer: s.layer, logs: [], lists: [v1.credential], exportedAt: 'x' }), s.held, NOW).take.lists[0];
  assert.ok(held !== undefined);
  const read = readTrustExport(buildTrustExport({ policyLayer: s.layer, logs: [], lists: [v2.credential], exportedAt: 'x' }), { ...s.held, lists: { [REVOCATIONS]: held.state } }, NOW);
  assert.deepEqual(read.refused.map((item) => item.reason), ['revocation-cleared']);
});

test('a tampered log or list is refused with its reason, and the other objects are taken', async () => {
  const s = await setup();
  const revocations = await list(s.w.revocationKey, REVOCATIONS, 'revocation', [3]);
  const forged = JSON.parse(JSON.stringify(revocations.credential)) as Record<string, any>;
  forged.validUntil = '2026-12-30T00:00:00Z';
  const signedByOther = await list(s.w.revocationKey, SUSPENSIONS, 'suspension', []);
  const officer = logOf(s.w, 'officer');
  const tamperedLog = { ...logOf(s.w, 'member'), log: s.w.member.log.replace('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z') };
  const text = buildTrustExport({ policyLayer: s.layer, logs: [officer, tamperedLog], lists: [forged, signedByOther.credential], exportedAt: 'x' });
  const read = readTrustExport(text, s.held, NOW);
  assert.deepEqual(read.refused.map((item) => [item.kind, item.reason === 'list-invalid' || item.kind === 'did-log']).sort(), [['did-log', true], ['status-list', true], ['status-list', true]]);
  assert.deepEqual(read.take.logs.map((item) => item.path), [officer.path]);
  assert.ok(read.take.policyLayer !== undefined);
  for (const item of read.refused) assert.ok(!item.message.includes('did:') && !item.message.includes('z6Mk'), 'a refusal names no DID or key');
});

test('an unknown object kind is refused and named in the report, not ignored', async () => {
  const s = await setup();
  const text = buildTrustExport({ policyLayer: s.layer, logs: [], lists: [], exportedAt: 'x' });
  const file = JSON.parse(text) as { objects: unknown[] };
  file.objects.push({ kind: 'user-export', people: [] }, 'not an object');
  const read = readTrustExport(JSON.stringify(file), s.held, NOW);
  assert.deepEqual(read.refused.map((item) => [item.index, item.kind, item.reason]), [[1, 'user-export', 'unknown-kind'], [2, 'unknown', 'unknown-kind']]);
});

test('rules signed by another key, or older than the edge\'s, are refused; lists are then checked against the edge\'s own rules', async () => {
  const s = await setup();
  const other = issuerKey('another-organization');
  const doc = policyDocumentFor({ key: other });
  const foreign = buildOrganizationLayer(other, { labels: doc.labels, agents: doc.agents, credentials: JSON.parse(JSON.stringify(s.w.section)) }, { now: NOW - DAY, days: 90 });
  const revocations = await list(s.w.revocationKey, REVOCATIONS, 'revocation', []);
  const noPolicy = readTrustExport(buildTrustExport({ policyLayer: foreign, logs: [], lists: [revocations.credential], exportedAt: 'x' }), s.held, NOW);
  assert.deepEqual(noPolicy.refused.map((item) => item.reason), ['policy-invalid', 'no-policy']);
  const withHeld = readTrustExport(buildTrustExport({ policyLayer: s.layer, logs: [], lists: [revocations.credential], exportedAt: 'x' }), { ...s.held, policy: { section: s.w.section, issuedAt: '2026-11-24T00:00:00.000Z' } }, NOW);
  assert.deepEqual(withHeld.refused.map((item) => item.reason), ['policy-older']);
  assert.equal(withHeld.take.lists.length, 1, 'the list is checked against the rules the edge already holds');
});

test('a file that is not a trust export is refused as a whole, in one sentence', () => {
  const read = readTrustExport('{"format":"near-user-export/1","objects":[]}', { issuerPublicKey: 'A'.repeat(43), lists: {}, logs: {} }, NOW);
  assert.deepEqual(read.refused.map((item) => item.reason), ['unreadable']);
  assert.equal(readTrustExport('not json', { issuerPublicKey: 'A'.repeat(43), lists: {}, logs: {} }, NOW).refused[0]?.reason, 'unreadable');
});

test('a log that does not continue the edge\'s log for that address is refused; the same log again is taken once only', async () => {
  const s = await setup();
  const member = logOf(s.w, 'member');
  const held = { ...s.held, logs: { [member.path]: { log: s.w.member.log, scid: s.w.member.state.scid } } };
  const same = readTrustExport(buildTrustExport({ policyLayer: s.layer, logs: [member], lists: [], exportedAt: 'x' }), held, NOW);
  assert.deepEqual(same.refused, []);
  assert.equal(same.take.logs.length, 0, 'nothing new');
  const impostor = { path: member.path, log: s.w.other.log };
  const moved = readTrustExport(buildTrustExport({ policyLayer: s.layer, logs: [impostor], lists: [], exportedAt: 'x' }), held, NOW);
  assert.deepEqual(moved.refused.map((item) => item.reason), ['wrong-path']);
});

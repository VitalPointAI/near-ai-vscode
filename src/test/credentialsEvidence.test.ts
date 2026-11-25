// Evidence by hash (Phase 71 plan 07 Task 1; D-09, D-14, DCAC-02): an entry's cited evidence is checked from cited data only, at the entry's signed
// time, so every replica agrees; a list not signed by the key the cited policy names never clears a revocation. Fictional Example Organization only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialClock } from '../domain/credentials/clock';
import { EVIDENCE_REFUSALS, checkEvidence } from '../domain/credentials/evidence';
import type { EvidenceCitation, EvidenceContext } from '../domain/credentials/evidence';
import { REVOCATIONS, SUSPENSIONS, bindingWithPlaces, issue, list, makeWorld, newKey, withComputers } from './helpers/credentialWorld';
import type { Issued, SignedList, World } from './helpers/credentialWorld';
import { mulberry32 } from './helpers/teamEvents';

const ENTRY_TIME = Date.UTC(2026, 10, 21);

interface Setup {
  w: World; role: Issued; clearance: Issued; revocations: SignedList; suspensions: SignedList;
  citation: EvidenceCitation; context: EvidenceContext;
}

async function setup(options: { revoked?: number[]; suspended?: number[] } = {}): Promise<Setup> {
  const w = await makeWorld();
  const role = await issue(w.root.signer, w.root.did, 'IssuerRoleCredential', { id: w.officer.did, credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Secret' });
  const clearance = await issue(w.officer.signer, w.officer.did, 'ClearanceCredential', { id: w.member.did, scale: 'ca-classified', atLeast: 'Secret' });
  const revocations = await list(w.revocationKey, REVOCATIONS, 'revocation', options.revoked ?? []);
  const suspensions = await list(w.suspensionKey, SUSPENSIONS, 'suspension', options.suspended ?? []);
  const citation: EvidenceCitation = {
    evidence: [clearance.hash, role.hash],
    status: [{ list: REVOCATIONS, hash: revocations.hash, validFrom: revocations.validFrom }, { list: SUSPENSIONS, hash: suspensions.hash, validFrom: suspensions.validFrom }]
  };
  const context: EvidenceContext = {
    credentials: { [clearance.hash]: clearance.credential, [role.hash]: role.credential },
    lists: { [revocations.hash]: revocations.credential, [suspensions.hash]: suspensions.credential },
    policy: w.policy, didState: w.didState, member: w.member.did, signedAt: ENTRY_TIME, level: 'ca-classified/Secret'
  };
  return { w, role, clearance, revocations, suspensions, citation, context };
}

function reason(result: ReturnType<typeof checkEvidence>): string {
  return result.ok ? 'ok' : result.reason;
}

test('tracer: a ClearanceCredential cited with its issuer\'s role and both lists passes at the entry\'s time and gives the member\'s facts', async () => {
  const s = await setup();
  const result = checkEvidence(s.citation, s.context);
  assert.equal(reason(result), 'ok');
  if (!result.ok) return;
  assert.equal(result.facts.subject, s.w.member.did);
  assert.deepEqual(result.facts.thresholds.map((entry) => `${entry.scale}/${entry.level}`), ['ca-classified/Secret']);
  assert.deepEqual(result.credentials.map((credential) => credential.type), ['ClearanceCredential'], 'role credentials are evidence, not the member\'s facts');
  assert.ok(Object.isFrozen(result.facts));
});

test('a blob or list that is not the one its citation names is refused', async () => {
  const s = await setup();
  const other = await issue(s.w.officer.signer, s.w.officer.did, 'ClearanceCredential', { id: s.w.member.did, scale: 'ca-classified', atLeast: 'Confidential' });
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, credentials: { ...s.context.credentials, [s.clearance.hash]: other.credential } })), 'credential-hash');
  const newer = await list(s.w.revocationKey, REVOCATIONS, 'revocation', [], { version: 2, validFrom: '2026-11-20T06:00:00Z' });
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, lists: { ...s.context.lists, [s.revocations.hash]: newer.credential } })), 'list-hash');
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, credentials: { [s.role.hash]: s.role.credential } })), 'credential-missing');
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, lists: { [s.suspensions.hash]: s.suspensions.credential } })), 'list-missing');
});

test('a credential revoked or suspended in the cited list is refused, and so is a role credential revoked there', async () => {
  const probe = await setup();
  const revoked = await setup({ revoked: [] });
  // Indexes are allocated as credentials are issued, so each setup's own indexes are set through a second list signed by the same key.
  for (const [s, purpose] of [[probe, 'revocation'], [revoked, 'suspension']] as const) {
    const index = purpose === 'revocation' ? s.clearance.revocationIndex : s.clearance.suspensionIndex;
    const key = purpose === 'revocation' ? s.w.revocationKey : s.w.suspensionKey;
    const id = purpose === 'revocation' ? REVOCATIONS : SUSPENSIONS;
    const set = await list(key, id, purpose, [index]);
    const citation = { ...s.citation, status: s.citation.status.map((entry) => (entry.list === id ? { list: id, hash: set.hash, validFrom: set.validFrom } : entry)) };
    assert.equal(reason(checkEvidence(citation, { ...s.context, lists: { ...s.context.lists, [set.hash]: set.credential } })), purpose === 'revocation' ? 'revoked' : 'suspended');
  }
  const roleRevoked = await list(probe.w.revocationKey, REVOCATIONS, 'revocation', [probe.role.revocationIndex]);
  const citation = { ...probe.citation, status: [{ list: REVOCATIONS, hash: roleRevoked.hash, validFrom: roleRevoked.validFrom }, probe.citation.status[1]!] };
  assert.equal(reason(checkEvidence(citation, { ...probe.context, lists: { ...probe.context.lists, [roleRevoked.hash]: roleRevoked.credential } })), 'revoked');
});

test('a credential not valid at the entry\'s time, or whose list was not valid then, is refused', async () => {
  const s = await setup();
  const ended = await issue(s.w.officer.signer, s.w.officer.did, 'ClearanceCredential', { id: s.w.member.did, scale: 'ca-classified', atLeast: 'Secret' }, { validUntil: '2026-11-20T12:00:00Z' });
  const citation = { ...s.citation, evidence: [ended.hash, s.role.hash] };
  assert.equal(reason(checkEvidence(citation, { ...s.context, credentials: { ...s.context.credentials, [ended.hash]: ended.credential } })), 'credential-expired');
  const notYet = await issue(s.w.officer.signer, s.w.officer.did, 'ClearanceCredential', { id: s.w.member.did, scale: 'ca-classified', atLeast: 'Secret' }, { validFrom: '2026-11-22T00:00:00Z' });
  const early = { ...s.citation, evidence: [notYet.hash, s.role.hash] };
  assert.equal(reason(checkEvidence(early, { ...s.context, credentials: { ...s.context.credentials, [notYet.hash]: notYet.credential } })), 'credential-expired');
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, signedAt: Date.UTC(2026, 10, 19), level: undefined })), 'list-out-of-date');
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, signedAt: Number.NaN })), 'credential-expired');
});

test('an issuer with no role under the cited policy is refused: a role that is not cited does not count', async () => {
  const s = await setup();
  const citation = { ...s.citation, evidence: [s.clearance.hash] };
  assert.equal(reason(checkEvidence(citation, s.context)), 'issuer-authority');
  const ceiling = await issue(s.w.officer.signer, s.w.officer.did, 'ClearanceCredential', { id: s.w.member.did, scale: 'ca-classified', atLeast: 'Top Secret' });
  const above = { ...s.citation, evidence: [ceiling.hash, s.role.hash] };
  assert.equal(reason(checkEvidence(above, { ...s.context, credentials: { ...s.context.credentials, [ceiling.hash]: ceiling.credential } })), 'issuer-authority');
});

test('a cited credential about someone else is refused', async () => {
  const s = await setup();
  const kims = await issue(s.w.officer.signer, s.w.officer.did, 'ClearanceCredential', { id: s.w.other.did, scale: 'ca-classified', atLeast: 'Secret' });
  const citation = { ...s.citation, evidence: [s.clearance.hash, kims.hash, s.role.hash] };
  assert.equal(reason(checkEvidence(citation, { ...s.context, credentials: { ...s.context.credentials, [kims.hash]: kims.credential } })), 'subject-mismatch');
  assert.equal(reason(checkEvidence({ ...s.citation, evidence: [s.role.hash] }, s.context)), 'no-evidence');
});

test('the entry must be signed with a key that was the member\'s then: a DID key, or a device the member bound with a cited binding', async () => {
  const s = await setup();
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, memberKey: s.w.member.issuing.multikey })), 'ok');
  const laptop = newKey();
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, memberKey: laptop.multikey })), 'member-key');
  // The member lists the laptop in one of their computer slots (D-25), so its binding counts.
  const member = await withComputers(s.w.member, [{ slot: 1, device: laptop.did, revocation: 100_001, suspension: 100_002 }]);
  const binding = await bindingWithPlaces(member, laptop.did, 100_001, 100_002);
  const citation = { ...s.citation, evidence: [...s.citation.evidence, binding.hash] };
  const context = {
    ...s.context, credentials: { ...s.context.credentials, [binding.hash]: binding.credential }, memberKey: laptop.multikey,
    didState: { ...s.context.didState, states: { ...s.context.didState.states, [member.did]: member.state } }
  };
  assert.equal(reason(checkEvidence(citation, context)), 'ok');
});

test('an issuer whose signing key is bound to a device by a cited binding is refused (devices never issue)', async () => {
  const s = await setup();
  const binding = await issue(s.w.officer.signer, s.w.officer.did, 'DeviceBindingCredential', { id: s.w.officer.issuing.did, device: `dev-${'c3'.repeat(16)}`, class: 'managed' });
  const citation = { ...s.citation, evidence: [...s.citation.evidence, binding.hash] };
  assert.equal(reason(checkEvidence(citation, { ...s.context, credentials: { ...s.context.credentials, [binding.hash]: binding.credential } })), 'issuer-authority');
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, didState: { ...s.context.didState, deviceBindings: [] } })), 'ok');
});

test('a cited list older than the level\'s maximum offline age at the entry\'s time is refused', async () => {
  const s = await setup();
  const late = Date.UTC(2026, 10, 21, 1);
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, signedAt: late })), 'list-too-old', 'Secret allows 24 hours');
  assert.equal(reason(checkEvidence(s.citation, { ...s.context, signedAt: late, level: 'ca-protected/Protected B' })), 'ok', 'Protected B allows 72 hours');
});

test('a list signed by any key but the one the cited policy names for it is refused status-list-signer, even with the member\'s bit cleared', async () => {
  const s = await setup();
  const signers = [newKey(), s.w.member.issuing, s.w.officer.issuing, s.w.suspensionKey];
  for (const signer of signers) {
    const forged = await list(signer, REVOCATIONS, 'revocation', [], { version: 9, validFrom: '2026-11-20T00:00:00Z' });
    const citation = { ...s.citation, status: [{ list: REVOCATIONS, hash: forged.hash, validFrom: forged.validFrom }, s.citation.status[1]!] };
    assert.equal(reason(checkEvidence(citation, { ...s.context, lists: { ...s.context.lists, [forged.hash]: forged.credential } })), 'status-list-signer');
  }
});

test('a list the cited policy does not name, and a credential whose list is not cited, are refused', async () => {
  const s = await setup();
  const stray = await list(s.w.revocationKey, 'https://hq.example.org/v1/trust/status/revocation-9', 'revocation');
  const citation = { ...s.citation, status: [...s.citation.status, { list: stray.id, hash: stray.hash, validFrom: stray.validFrom }] };
  assert.equal(reason(checkEvidence(citation, { ...s.context, lists: { ...s.context.lists, [stray.hash]: stray.credential } })), 'list-not-in-policy');
  assert.equal(reason(checkEvidence({ ...s.citation, status: [s.citation.status[0]!] }, s.context)), 'status-not-cited');
  for (const sentence of Object.values(EVIDENCE_REFUSALS)) assert.doesNotMatch(sentence, /did:|z6Mk|[0-9a-f]{64}/);
});

test('property: 1,000 replicas holding different newer and forged lists and folding in random orders give identical answers for every citation', async () => {
  const s = await setup();
  const w = s.w;
  const expired = await issue(w.officer.signer, w.officer.did, 'ClearanceCredential', { id: w.member.did, scale: 'ca-classified', atLeast: 'Confidential' }, { validUntil: '2026-11-01T00:00:00Z' });
  const unauthorized = await issue(w.other.signer, w.other.did, 'ClearanceCredential', { id: w.member.did, scale: 'ca-classified', atLeast: 'Secret' });
  const revokedOne = await issue(w.officer.signer, w.officer.did, 'ClearanceCredential', { id: w.member.did, scale: 'ca-classified', atLeast: 'Confidential' });
  const revokedList = await list(w.revocationKey, REVOCATIONS, 'revocation', [revokedOne.revocationIndex], { version: 2, validFrom: '2026-11-20T01:00:00Z' });
  // Newer lists a replica may hold but nobody cited, and forgeries that clear the revoked bit, signed by keys that are not the policy's.
  const newer = await Promise.all([3, 4, 5].map((version) => list(w.revocationKey, REVOCATIONS, 'revocation', [s.clearance.revocationIndex], { version, validFrom: `2026-11-2${String(version - 2)}T00:00:00Z` })));
  const forged = await Promise.all(Array.from({ length: 4 }, () => list(newKey(), REVOCATIONS, 'revocation', [], { version: 7, validFrom: '2026-11-20T02:00:00Z' })));
  const credentials = { ...s.context.credentials, [expired.hash]: expired.credential, [unauthorized.hash]: unauthorized.credential, [revokedOne.hash]: revokedOne.credential };
  const sus = s.citation.status[1]!;
  const cited = (hash: string, rev: SignedList): EvidenceCitation => ({ evidence: [hash, s.role.hash], status: [{ list: REVOCATIONS, hash: rev.hash, validFrom: rev.validFrom }, sus] });
  const citations: Array<{ name: string; citation: EvidenceCitation; expect: string }> = [
    { name: 'valid', citation: s.citation, expect: 'ok' },
    { name: 'expired', citation: cited(expired.hash, s.revocations), expect: 'credential-expired' },
    { name: 'unauthorized', citation: cited(unauthorized.hash, s.revocations), expect: 'issuer-authority' },
    { name: 'revoked', citation: cited(revokedOne.hash, revokedList), expect: 'revoked' },
    ...forged.map((list, index) => ({ name: `forged ${String(index)}`, citation: cited(revokedOne.hash, list), expect: 'status-list-signer' }))
  ];
  const random = mulberry32(71_07);
  let cases = 0;
  for (let index = 0; index < 1000; index += 1) {
    cases += 1;
    const held: Record<string, unknown> = { ...s.context.lists, [revokedList.hash]: revokedList.credential };
    for (const extra of [...newer, ...forged]) if (random() < 0.5) held[extra.hash] = extra.credential;
    for (const f of forged) held[f.hash] = f.credential;
    const order = [...citations].sort(() => random() - 0.5);
    for (const entry of order) {
      const result = checkEvidence(entry.citation, { ...s.context, credentials, lists: held });
      assert.equal(reason(result), entry.expect, `case ${String(index)}: ${entry.name}`);
    }
  }
  assert.equal(cases, 1000);
});

test('credentialClock: the entry\'s time, never later than the hub saw it; offline never earlier than the last bundle; the counter orders ties', () => {
  assert.deepEqual(credentialClock(1000), { at: 1000, source: 'entry' });
  assert.deepEqual(credentialClock(1000, 900), { at: 900, source: 'witness' });
  assert.deepEqual(credentialClock(1000, 1200), { at: 1000, source: 'entry' });
  assert.deepEqual(credentialClock(1000, undefined, 1500, 7), { at: 1500, source: 'bundle', counter: 7 });
  assert.deepEqual(credentialClock(2000, undefined, 1500), { at: 2000, source: 'entry' });
  assert.ok(Number.isNaN(credentialClock(Number.NaN, 900).at));
});

// D-25 and G467: a computer binding counts only when its places are in the computer part of the lists and the person's own DID document lists it in
// one of at most five computer slots, so every verifier enforces the cap and an officer can always see, and revoke, every bound computer.
async function laptopSetup(slots: (laptop: string) => Array<{ slot: number; device: string; revocation: number; suspension: number }>, places = { revocation: 100_001, suspension: 100_002 }) {
  const s = await setup();
  const laptop = newKey();
  const member = await withComputers(s.w.member, slots(laptop.did));
  const binding = await bindingWithPlaces(member, laptop.did, places.revocation, places.suspension);
  const citation = { ...s.citation, evidence: [...s.citation.evidence, binding.hash] };
  const context: EvidenceContext = {
    ...s.context, credentials: { ...s.context.credentials, [binding.hash]: binding.credential }, memberKey: laptop.multikey,
    didState: { ...s.context.didState, states: { ...s.context.didState.states, [member.did]: member.state } }
  };
  return { s, laptop, binding, citation, context };
}

test('G467: a computer binding the person signed with no computer slot in their DID document is refused', async () => {
  const listed = await laptopSetup((laptop) => [{ slot: 1, device: laptop, revocation: 100_001, suspension: 100_002 }]);
  assert.equal(reason(checkEvidence(listed.citation, listed.context)), 'ok', 'listed in slot 1: it counts');
  const unlisted = await laptopSetup(() => []);
  assert.equal(reason(checkEvidence(unlisted.citation, unlisted.context)), 'binding-not-in-slots');
  // Listed with other places, or for another computer, is not this binding.
  const otherPlaces = await laptopSetup((laptop) => [{ slot: 1, device: laptop, revocation: 100_005, suspension: 100_002 }]);
  assert.equal(reason(checkEvidence(otherPlaces.citation, otherPlaces.context)), 'binding-not-in-slots');
  const otherComputer = await laptopSetup(() => [{ slot: 1, device: newKey().did, revocation: 100_001, suspension: 100_002 }]);
  assert.equal(reason(checkEvidence(otherComputer.citation, otherComputer.context)), 'binding-not-in-slots');
});

test('G467: a computer binding whose places are below 98,304 is refused, even when the person\'s DID document lists them', async () => {
  const low = await laptopSetup((laptop) => [{ slot: 1, device: laptop, revocation: 4_000, suspension: 100_002 }], { revocation: 4_000, suspension: 100_002 });
  assert.equal(reason(checkEvidence(low.citation, low.context)), 'binding-outside-computer-range');
  const edge = await laptopSetup((laptop) => [{ slot: 1, device: laptop, revocation: 98_303, suspension: 98_304 }], { revocation: 98_303, suspension: 98_304 });
  assert.equal(reason(checkEvidence(edge.citation, edge.context)), 'binding-outside-computer-range');
});

test('G467: a DID document with more than five computer slots counts none of them', async () => {
  const many = await laptopSetup((laptop) => [1, 2, 3, 4, 5, 6].map((slot) => ({ slot, device: slot === 1 ? laptop : newKey().did, revocation: 100_000 + slot * 2 - 1, suspension: 100_000 + slot * 2 })));
  assert.equal(reason(checkEvidence(many.citation, many.context)), 'binding-not-in-slots');
  // A known binding (not cited) never makes a key the member's without a slot either.
  const known = await laptopSetup(() => []);
  const read = { ...known.context, credentials: known.s.context.credentials, didState: { ...known.context.didState, deviceBindings: [] } };
  assert.equal(reason(checkEvidence(known.s.citation, read)), 'member-key');
});

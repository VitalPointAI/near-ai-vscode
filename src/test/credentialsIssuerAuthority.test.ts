// Issuer authority (Phase 71 plan 06 Task 2; D-07, D-12, DCAC-01): only people holding a role credential from your organization's root issue, within
// their ceiling, and agents and devices never issue, whatever the policy says. Fictional Example Organization people, devices and agents; keys made at
// run time. issuerAuthority decides authority only, so the credentials here are verified-credential records built directly (proofs are 71-03's).
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import type { CredentialsSection } from '../domain/gate/credentialsSection';
import type { CredentialSigner } from '../domain/credentials/dataIntegrity';
import { encodePublicKeyMultibase } from '../domain/credentials/multibase';
import type { VerifiedCredential } from '../domain/credentials/profile';
import { ISSUER_REFUSALS, isPersonIssuer, issuerAuthority } from '../domain/credentials/issuerAuthority';
import type { IssuerDidState, IssuerPolicy, RoleEvidence } from '../domain/credentials/issuerAuthority';
import { buildGenesisEntry, buildUpdateEntry, verifyWebvhLog } from '../domain/did/didWebvh';
import type { WebvhState } from '../domain/did/didWebvh';
import { deviceKey, policyDocumentFor } from './helpers/policyFixtures';
import { mulberry32 } from './helpers/teamEvents';

interface Key { multikey: string; did: string; signer: CredentialSigner }

function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const multikey = encodePublicKeyMultibase('Ed25519', new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
  const did = `did:key:${multikey}`;
  return { multikey, did, signer: { verificationMethod: `${did}#${multikey}`, suite: 'eddsa-jcs-2022', sign: async (bytes) => new Uint8Array(cryptoSign(null, bytes, privateKey)) } };
}

interface Person { did: string; issuing: Key; method: string; state: WebvhState; update: Key; line: string }

function document(assertionKey: string): (did: string) => Record<string, unknown> {
  return (did) => ({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: did, controller: did,
    verificationMethod: [{ id: `${did}#issuing`, type: 'Multikey', controller: did, publicKeyMultibase: assertionKey }],
    authentication: [`${did}#issuing`], assertionMethod: [`${did}#issuing`]
  });
}

async function person(path: string[], versionTime = '2026-01-01T00:00:00Z', issuing = newKey()): Promise<Person> {
  const update = newKey();
  const genesis = await buildGenesisEntry({ domain: 'hq.example.org', path, updateKeys: [update.multikey], portable: true, versionTime, document: document(issuing.multikey) }, update.signer);
  const result = verifyWebvhLog(genesis.line, { now: Date.UTC(2026, 10, 24) });
  assert.ok(result.ok);
  return { did: genesis.did, issuing, method: `${genesis.did}#issuing`, state: result.state, update, line: genesis.line };
}

interface World { root: Person; alex: Person; sam: Person; bound: Person; laptop: Key; agent: Key; policy: IssuerPolicy; didState: IssuerDidState; section: CredentialsSection }

let worldMade: Promise<World> | undefined;
function world(): Promise<World> {
  worldMade ??= (async () => {
    const root = await person(['org']);
    const alex = await person(['people', 'alex']);
    const sam = await person(['people', 'sam']);
    const laptop = newKey();
    const agent = newKey();
    // A person whose signing key is also bound to their laptop: the key is a device key, so it never issues (D-07).
    const bound = await person(['people', 'casey'], '2026-01-01T00:00:00Z', laptop);
    const doc = JSON.parse(JSON.stringify(policyDocumentFor({ key: deviceKey() }))) as Record<string, any>;
    doc.credentials = {
      v: 1, root: { did: root.did, scid: root.state.scid },
      issuance: {
        ClearanceCredential: { role: 'IssuerRoleCredential', ceiling: { scale: 'ca-classified', upTo: 'Secret' } },
        NationalityCredential: { role: 'SecurityContactCredential' },
        CompartmentCredential: { role: 'IssuerRoleCredential' }
      },
      suites: ['ecdsa-jcs-2019', 'eddsa-jcs-2022'], didMethods: ['did:key', 'did:webvh'], statusLists: [], statusTtl: 900, maxOfflineAge: {}, requiredBySensitivity: {}
    };
    doc.requires = [...doc.requires, 'credentials@1'].sort();
    const parsed = parsePolicyDocument(doc);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    const section = (parsed.ok ? parsed.value.credentials : undefined) as CredentialsSection;
    const states: Record<string, WebvhState> = { [root.did]: root.state, [alex.did]: alex.state, [sam.did]: sam.state, [bound.did]: bound.state };
    const binding = verified({ type: 'DeviceBindingCredential', issuer: bound.did, method: bound.method, claims: { id: laptop.did, device: `dev-${'a1'.repeat(16)}`, class: 'managed' } });
    return { root, alex, sam, bound, laptop, agent, section, policy: { section, scales: SCALE_PRESETS }, didState: { states, deviceBindings: [binding], delegatedKeys: [agent.did] } };
  })();
  return worldMade;
}

interface Draft { type: string; issuer: string; method: string; claims: Record<string, unknown>; validFrom?: string; validUntil?: string; suite?: string }

function verified(draft: Draft): VerifiedCredential {
  return Object.freeze({
    type: draft.type, issuer: draft.issuer, validFrom: draft.validFrom ?? '2026-06-01T00:00:00Z', validUntil: draft.validUntil ?? '2027-06-01T00:00:00Z',
    claims: Object.freeze(draft.claims), status: Object.freeze([]), suite: draft.suite ?? 'eddsa-jcs-2022', verificationMethod: draft.method, credential: Object.freeze({})
  }) as unknown as VerifiedCredential;
}

function issuerRole(w: World, subject: string, claims: Record<string, unknown>, extra: Partial<Draft> = {}): RoleEvidence {
  return { credential: verified({ type: 'IssuerRoleCredential', issuer: w.root.did, method: w.root.method, claims: { id: subject, ...claims }, validFrom: '2026-02-01T00:00:00Z', ...extra }), statusClear: true };
}

function clearance(issuer: { did: string; method: string }, atLeast: string, subject = 'did:webvh:QmExampleScidOnlyForTestsQmExampleScidOnlyForT:example.org:people:sam'): VerifiedCredential {
  return verified({ type: 'ClearanceCredential', issuer: issuer.did, method: issuer.method, claims: { id: subject, scale: 'ca-classified', atLeast } });
}

function reason(result: ReturnType<typeof issuerAuthority>): string {
  return result.ok ? 'ok' : result.reason;
}

test('a ClearanceCredential up to Secret from a person holding the root\'s IssuerRoleCredential up to Secret is allowed; Top Secret is above the ceiling', async () => {
  const w = await world();
  const role = issuerRole(w, w.alex.did, { credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Secret' });
  const allowed = issuerAuthority(clearance(w.alex, 'Secret'), [role], w.policy, w.didState);
  assert.equal(reason(allowed), 'ok');
  if (allowed.ok) assert.equal(allowed.role, role.credential);
  assert.equal(reason(issuerAuthority(clearance(w.alex, 'Top Secret'), [role], w.policy, w.didState)), 'above-ceiling');
  const wideRole = issuerRole(w, w.alex.did, { credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Top Secret' });
  assert.equal(reason(issuerAuthority(clearance(w.alex, 'Top Secret'), [wideRole], w.policy, w.didState)), 'above-ceiling', 'the policy\'s ceiling holds even when the role names a higher one');
});

test('a role credential issued by anyone but the pinned root, or revoked in its cited list, gives no authority', async () => {
  const w = await world();
  const fromSam = { credential: verified({ type: 'IssuerRoleCredential', issuer: w.sam.did, method: w.sam.method, claims: { id: w.alex.did, credentialType: 'ClearanceCredential' } }), statusClear: true };
  assert.equal(reason(issuerAuthority(fromSam.credential, [], w.policy, w.didState)), 'role-not-from-root');
  assert.equal(reason(issuerAuthority(clearance(w.alex, 'Secret'), [fromSam], w.policy, w.didState)), 'no-role');
  const revoked = { ...issuerRole(w, w.alex.did, { credentialType: 'ClearanceCredential' }), statusClear: false };
  assert.equal(reason(issuerAuthority(clearance(w.alex, 'Secret'), [revoked], w.policy, w.didState)), 'no-role');
  const otherType = issuerRole(w, w.alex.did, { credentialType: 'CompartmentCredential' });
  assert.equal(reason(issuerAuthority(clearance(w.alex, 'Secret'), [otherType], w.policy, w.didState)), 'no-role', 'a role for another type');
  const forSam = issuerRole(w, w.sam.did, { credentialType: 'ClearanceCredential' });
  assert.equal(reason(issuerAuthority(clearance(w.alex, 'Secret'), [forSam], w.policy, w.didState)), 'no-role', 'someone else\'s role');
  const expired = issuerRole(w, w.alex.did, { credentialType: 'ClearanceCredential' }, { validUntil: '2026-05-01T00:00:00Z' });
  assert.equal(reason(issuerAuthority(clearance(w.alex, 'Secret'), [expired], w.policy, w.didState)), 'no-role', 'a role ended before the credential starts');
});

test('agents and devices never issue: a did:key issuer is refused even when the policy names its role; so is a person whose key is bound to a device', async () => {
  const w = await world();
  for (const key of [w.laptop, w.agent]) {
    const role = issuerRole(w, key.did, { credentialType: 'ClearanceCredential' });
    const result = issuerAuthority(clearance({ did: key.did, method: key.signer.verificationMethod }, 'Confidential'), [role], w.policy, w.didState);
    assert.equal(reason(result), 'device-or-agent-issuer');
    if (!result.ok) assert.equal(result.message, ISSUER_REFUSALS['device-or-agent-issuer']);
  }
  const role = issuerRole(w, w.bound.did, { credentialType: 'ClearanceCredential' });
  assert.equal(reason(issuerAuthority(clearance(w.bound, 'Confidential'), [role], w.policy, w.didState)), 'device-or-agent-issuer');
  assert.equal(isPersonIssuer(w.alex.did, w.didState, w.section), true);
  assert.equal(isPersonIssuer(w.bound.did, w.didState, w.section), false);
  assert.equal(isPersonIssuer(w.laptop.did, w.didState, w.section), false);
});

test('a role credential naming a did:key subject is refused, and so is one naming a person whose key is a device key', async () => {
  const w = await world();
  for (const subject of [w.laptop.did, w.agent.did, w.bound.did, 'did:web:example.org']) {
    const role = verified({ type: 'RoleCredential', issuer: w.root.did, method: w.root.method, claims: { id: subject, role: 'enrolment-officer', scope: 'organization' } });
    assert.equal(reason(issuerAuthority(role, [], w.policy, w.didState)), 'role-subject-not-person', subject.slice(0, 12));
  }
});

test('ClassificationAuthorityCredential is a role credential: only the root issues it, and the root issues nothing but roles', async () => {
  const w = await world();
  const claims = { id: w.alex.did, scale: 'ca-classified', upTo: 'Secret', scope: 'own-items' };
  assert.equal(reason(issuerAuthority(verified({ type: 'ClassificationAuthorityCredential', issuer: w.root.did, method: w.root.method, claims }), [], w.policy, w.didState)), 'ok');
  const role = issuerRole(w, w.sam.did, { credentialType: 'ClearanceCredential' });
  assert.equal(reason(issuerAuthority(verified({ type: 'ClassificationAuthorityCredential', issuer: w.sam.did, method: w.sam.method, claims }), [role], w.policy, w.didState)), 'role-not-from-root');
  assert.equal(reason(issuerAuthority(clearance(w.root, 'Secret'), [], w.policy, w.didState)), 'root-issues-roles-only');
});

test('an issuer key not in force at the credential\'s validFrom is refused, and a credential signed before a rotation still checks at its own time', async () => {
  const w = await world();
  const next = newKey();
  const rotated = await buildUpdateEntry(w.sam.state, { parameters: {}, versionTime: '2026-07-01T00:00:00Z', document: document(next.multikey) }, w.sam.update.signer);
  // Sam's state after the rotation: the old key is in force before 1 July, the new one after.
  const fullLog = verifyWebvhLog(`${w.sam.line}\n${rotated.line}\n`, { now: Date.UTC(2026, 10, 24), cached: w.sam.state });
  assert.ok(fullLog.ok, fullLog.ok ? '' : fullLog.reason);
  const didState: IssuerDidState = { ...w.didState, states: { ...w.didState.states, [w.sam.did]: fullLog.ok ? fullLog.state : w.sam.state } };
  const role = issuerRole(w, w.sam.did, { credentialType: 'ClearanceCredential' });
  const before = verified({ type: 'ClearanceCredential', issuer: w.sam.did, method: w.sam.method, claims: { id: w.alex.did, scale: 'ca-classified', atLeast: 'Secret' }, validFrom: '2026-06-15T00:00:00Z' });
  assert.equal(reason(issuerAuthority(before, [role], w.policy, didState)), 'ok', 'checked against the key in force on 15 June');
  const unknownMethod = verified({ type: 'ClearanceCredential', issuer: w.sam.did, method: `${w.sam.did}#other`, claims: { id: w.alex.did, scale: 'ca-classified', atLeast: 'Secret' } });
  assert.equal(reason(issuerAuthority(unknownMethod, [role], w.policy, didState)), 'key-not-in-force');
  const beforeCreation = verified({ type: 'ClearanceCredential', issuer: w.sam.did, method: w.sam.method, claims: { id: w.alex.did, scale: 'ca-classified', atLeast: 'Secret' }, validFrom: '2025-12-01T00:00:00Z' });
  assert.equal(reason(issuerAuthority(beforeCreation, [role], w.policy, didState)), 'key-not-in-force', 'no key was in force before the DID existed');
  const unknownIssuer = verified({ type: 'ClearanceCredential', issuer: 'did:webvh:QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ:example.org', method: 'did:webvh:QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ:example.org#issuing', claims: { id: w.alex.did, scale: 'ca-classified', atLeast: 'Secret' } });
  assert.equal(reason(issuerAuthority(unknownIssuer, [role], w.policy, didState)), 'unknown-issuer');
});

test('the policy decides what a role may issue: a type with no issuance rule is not issuable, and a suite the policy leaves out is refused', async () => {
  const w = await world();
  const role = issuerRole(w, w.alex.did, { credentialType: 'MembershipCredential' });
  const membership = verified({ type: 'MembershipCredential', issuer: w.alex.did, method: w.alex.method, claims: { id: w.sam.did, organization: 'Example Organization' } });
  assert.equal(reason(issuerAuthority(membership, [role], w.policy, w.didState)), 'not-issuable');
  const onlyEcdsa: IssuerPolicy = { ...w.policy, section: { ...w.section, suites: ['ecdsa-jcs-2019'] } };
  const clearanceRole = issuerRole(w, w.alex.did, { credentialType: 'ClearanceCredential' });
  assert.equal(reason(issuerAuthority(clearance(w.alex, 'Secret'), [clearanceRole], onlyEcdsa, w.didState)), 'suite-not-allowed');
  const compartmentRole = issuerRole(w, w.alex.did, { credentialType: 'CompartmentCredential', compartments: ['ALPHA'] });
  const bravo = verified({ type: 'CompartmentCredential', issuer: w.alex.did, method: w.alex.method, claims: { id: w.sam.did, compartment: 'BRAVO' } });
  assert.equal(reason(issuerAuthority(bravo, [compartmentRole], w.policy, w.didState)), 'above-ceiling', 'a compartment the role does not list');
});

test('the role type is the policy\'s: a NationalityCredential needs the SecurityContactCredential the policy names, and an IssuerRoleCredential does not stand in', async () => {
  const w = await world();
  const nationality = verified({ type: 'NationalityCredential', issuer: w.alex.did, method: w.alex.method, claims: { id: w.sam.did, nationality: 'CAN' } });
  const contact = { credential: verified({ type: 'SecurityContactCredential', issuer: w.root.did, method: w.root.method, claims: { id: w.alex.did, scope: 'organization' }, validFrom: '2026-02-01T00:00:00Z' }), statusClear: true };
  const result = issuerAuthority(nationality, [contact], w.policy, w.didState);
  assert.equal(reason(result), 'ok');
  if (result.ok) assert.equal(result.role?.type, 'SecurityContactCredential');
  const issuerRoleOnly = issuerRole(w, w.alex.did, { credentialType: 'NationalityCredential' });
  assert.equal(reason(issuerAuthority(nationality, [issuerRoleOnly], w.policy, w.didState)), 'no-role');
});

test('fallbackPersonKey: under the fallback a named officer did:key issues; while did:webvh is allowed the same key is a device key', async () => {
  const w = await world();
  const officer = newKey();
  const fallback: CredentialsSection = { ...w.section, didMethods: ['did:key'], root: { did: w.root.issuing.did }, fallbackPersonKeys: [officer.did] };
  const policy: IssuerPolicy = { ...w.policy, section: fallback };
  const role = { credential: verified({ type: 'IssuerRoleCredential', issuer: w.root.issuing.did, method: w.root.issuing.signer.verificationMethod, claims: { id: officer.did, credentialType: 'ClearanceCredential' }, validFrom: '2026-02-01T00:00:00Z' }), statusClear: true };
  const issued = clearance({ did: officer.did, method: officer.signer.verificationMethod }, 'Secret');
  assert.equal(reason(issuerAuthority(issued, [role], policy, w.didState)), 'ok');
  assert.equal(reason(issuerAuthority(issued, [role], w.policy, w.didState)), 'device-or-agent-issuer', 'the branch is unreachable while did:webvh is allowed');
  const unnamed = newKey();
  assert.equal(reason(issuerAuthority(clearance({ did: unnamed.did, method: unnamed.signer.verificationMethod }, 'Secret'), [role], policy, w.didState)), 'device-or-agent-issuer');
  assert.equal(reason(issuerAuthority(clearance({ did: w.laptop.did, method: w.laptop.signer.verificationMethod }, 'Secret'), [role], { ...policy, section: { ...fallback, fallbackPersonKeys: [officer.did, w.laptop.did].sort() } }, w.didState)), 'device-or-agent-issuer', 'a key bound to a device stays a device key even if named');
});

test('property: 2,000 random chains of roots, people, devices and agents never allow a credential whose chain holds a device or agent key', async () => {
  const w = await world();
  const random = mulberry32(71_06);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const actors = [
    { did: w.root.did, method: w.root.method, kind: 'root' }, { did: w.alex.did, method: w.alex.method, kind: 'person' }, { did: w.sam.did, method: w.sam.method, kind: 'person' },
    { did: w.bound.did, method: w.bound.method, kind: 'device' }, { did: w.laptop.did, method: w.laptop.signer.verificationMethod, kind: 'device' },
    { did: w.agent.did, method: w.agent.signer.verificationMethod, kind: 'agent' }
  ] as const;
  const kindOf = (did: string): string => actors.find((actor) => actor.did === did)?.kind ?? 'other';
  let allowed = 0;
  let cases = 0;
  for (let index = 0; index < 2000; index += 1) {
    cases += 1;
    const issuer = pick(actors);
    const roles: RoleEvidence[] = Array.from({ length: Math.floor(random() * 3) }, () => {
      const roleIssuer = pick(actors);
      const subject = random() < 0.7 ? issuer : pick(actors);
      return {
        credential: verified({ type: pick(['IssuerRoleCredential', 'SecurityContactCredential']), issuer: roleIssuer.did, method: roleIssuer.method, claims: { id: subject.did, credentialType: pick(['ClearanceCredential', 'CompartmentCredential']) }, validFrom: '2026-02-01T00:00:00Z' }),
        statusClear: random() < 0.9
      };
    });
    const type = pick(['ClearanceCredential', 'NationalityCredential', 'RoleCredential', 'IssuerRoleCredential', 'ClassificationAuthorityCredential']);
    const claims: Record<string, unknown> = type === 'ClearanceCredential' ? { id: pick(actors).did, scale: 'ca-classified', atLeast: pick(['Confidential', 'Secret', 'Top Secret']) }
      : type === 'NationalityCredential' ? { id: pick(actors).did, nationality: 'CAN' } : { id: pick(actors).did, role: 'officer', scope: 'organization', credentialType: 'ClearanceCredential' };
    const result = issuerAuthority(verified({ type, issuer: issuer.did, method: issuer.method, claims }), roles, w.policy, w.didState);
    if (!result.ok) continue;
    allowed += 1;
    const chain = [issuer.did, ...(result.role === undefined ? [] : [result.role.issuer, result.role.claims.id])];
    for (const did of chain) assert.ok(!['device', 'agent'].includes(kindOf(did)), `case ${String(index)}: a ${kindOf(did)} key is in an allowed chain`);
    if (result.role === undefined) {
      assert.equal(issuer.kind, 'root', `case ${String(index)}: only the root issues without a role`);
      assert.ok(!['device', 'agent'].includes(kindOf(claims.id as string)), `case ${String(index)}: a role was given to a device or agent`);
    } else {
      assert.equal(result.role.issuer, w.root.did, `case ${String(index)}: the role came from the root`);
    }
  }
  assert.equal(cases, 2000);
  assert.ok(allowed > 50, `the property is not vacuous: ${String(allowed)} chains were allowed`);
});

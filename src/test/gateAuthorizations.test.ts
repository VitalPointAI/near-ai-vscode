// One exception record (FND-04, Phase 41 D-10, D-15, D-23, D-29 to D-32, D-61) and the v2 layer reader (D-09, D-15, D-49): authorizations signed by a
// named person and checked against exactly one key source, their maximum lengths, what they cover, and verifyPolicyLayer's purposes and size caps.
// Keys are made at test time; names are fictional.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import test from 'node:test';
import {
  AUTHORIZATION_KINDS, AUTHORIZATION_REFUSALS, MAX_AUTHORIZATIONS, MAX_DAYS_BY_KIND, SELF_SIGNED_TEXT, SUBJECT_FOR_KIND, authorizationCovers, parseAuthorizationBody,
  parseAuthorizations, parsePolicySigners, verifyAuthorization
} from '../domain/gate/authorizations';
import type { AuthorizationBody, AuthorizationRefusal, PolicySigner } from '../domain/gate/authorizations';
import { defaultBundlePayload, verifyBundleEnvelope } from '../domain/gate/bundle';
import { MAX_ORGANIZATION_LAYER_BYTES, parsePolicyDocument, verifyPolicyLayer } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { fingerprintOf } from '../domain/team/canonical';
import { MAX_PAYLOAD_BYTES, PayloadError, signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../domain/team/signedPayload';
import {
  DAY_MS, FIXED_NOW, NAMED_PERSON, activeKeys, authorizationFor, deviceKey, enrolmentFileFor, fullDocumentFor, issuerKey, policyDocumentFor, signAuthorization,
  signOrganizationLayer, signPersonalLayer, signerEntry
} from './helpers/policyFixtures';

type Loose = any; // an envelope or body under edit

const EM_DASH = String.fromCharCode(0x2014);

function plain<T>(value: T): Loose {
  return JSON.parse(JSON.stringify(value)) as Loose;
}

function randomKey(): PayloadSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { fingerprint: fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
}

function signerOf(key: PayloadSigner, name = NAMED_PERSON.name, role = NAMED_PERSON.role): PolicySigner {
  return { name, role, publicKey: key.publicKey, fingerprint: key.fingerprint };
}

function reasonOf(verdict: ReturnType<typeof verifyAuthorization>): AuthorizationRefusal | 'ok' {
  return verdict.ok ? 'ok' : verdict.reason;
}

const self = (key: PayloadSigner): { fingerprint: string; publicKey: string } => ({ fingerprint: key.fingerprint, publicKey: key.publicKey });

test('tracer (D-29, D-31): with no organization layer, this device\'s own protected-b record verifies and is self-signed on this computer', () => {
  const device = deviceKey();
  const envelope = signAuthorization(authorizationFor({ kind: 'protected-b' }), device);
  assert.equal(envelope.purpose, 'policy-authorization');
  const verdict = verifyAuthorization(envelope, { thisDevice: self(device), now: FIXED_NOW });
  assert.equal(reasonOf(verdict), 'ok');
  if (verdict.ok) {
    assert.equal(verdict.selfSigned, true);
    assert.equal(verdict.body.kind, 'protected-b');
    assert.deepEqual(verdict.body.subject, { endpoint: 'models-example-org' });
  }
  assert.equal(SELF_SIGNED_TEXT, 'self-signed on this computer');
  // Any other key is not this device, and nothing else counts without an organization layer.
  const other = signAuthorization(authorizationFor({ kind: 'protected-b' }), issuerKey('someone-else'));
  assert.equal(reasonOf(verifyAuthorization(other, { thisDevice: self(device), now: FIXED_NOW })), 'unknown-signer');
  assert.equal(reasonOf(verifyAuthorization(envelope, { now: FIXED_NOW })), 'unknown-signer', 'no key source at all counts nothing');
});

test('D-15, D-31: with your organization\'s signers only they count; this device counts only when listed, and the two sources are never merged', () => {
  const officer = issuerKey('security-officer');
  const device = deviceKey();
  const byOfficer = signAuthorization(authorizationFor({ kind: 't1-risk' }), officer);
  const byDevice = signAuthorization(authorizationFor({ kind: 't1-risk' }), device);
  const listed = verifyAuthorization(byOfficer, { signers: [signerOf(officer)], thisDevice: self(device), now: FIXED_NOW });
  assert.equal(reasonOf(listed), 'ok');
  if (listed.ok) assert.equal(listed.selfSigned, false);
  assert.equal(reasonOf(verifyAuthorization(byDevice, { signers: [signerOf(officer)], thisDevice: self(device), now: FIXED_NOW })), 'unknown-signer');
  const deviceListed = verifyAuthorization(byDevice, { signers: [signerOf(officer), signerOf(device)].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1)), thisDevice: self(device), now: FIXED_NOW });
  assert.equal(reasonOf(deviceListed), 'ok');
  if (deviceListed.ok) assert.equal(deviceListed.selfSigned, true);
  // An organization layer with no signers lets nothing count, not even this device.
  assert.equal(reasonOf(verifyAuthorization(byDevice, { signers: [], thisDevice: self(device), now: FIXED_NOW })), 'unknown-signer');
  // A listed key under another person's name does not vouch for the person the record names.
  assert.equal(reasonOf(verifyAuthorization(byOfficer, { signers: [signerOf(officer, 'Sam Other')], now: FIXED_NOW })), 'named-person-mismatch');
  assert.equal(reasonOf(verifyAuthorization(byOfficer, { signers: [signerOf(officer, NAMED_PERSON.name, 'Clerk')], now: FIXED_NOW })), 'named-person-mismatch');
  // A signer entry with the right fingerprint but another key is not that signer.
  const impostor = { ...signerOf(officer), publicKey: device.publicKey };
  assert.equal(reasonOf(verifyAuthorization(byOfficer, { signers: [impostor], now: FIXED_NOW })), 'unknown-signer');
});

test('D-30: each kind passes at its maximum length and is too-long one day over; declassify has no maximum', () => {
  const device = deviceKey();
  assert.deepEqual({ ...MAX_DAYS_BY_KIND }, {
    'protected-b': 365, 't1-risk': 90, 'accredited-device': 365, 'residency-exception': 90, declassify: undefined
  });
  for (const kind of ['protected-b', 't1-risk', 'accredited-device', 'residency-exception'] as const) {
    const max = MAX_DAYS_BY_KIND[kind] as number;
    const extra = {};
    const at = signAuthorization(authorizationFor({ kind, days: max, ...extra }), device);
    assert.equal(reasonOf(verifyAuthorization(at, { thisDevice: self(device), now: FIXED_NOW })), 'ok', `${kind} at ${String(max)} days`);
    const over = signAuthorization(authorizationFor({ kind, days: max + 1, ...extra }), device);
    assert.equal(reasonOf(verifyAuthorization(over, { thisDevice: self(device), now: FIXED_NOW })), 'too-long', `${kind} one day over`);
  }
  const decade = signAuthorization(authorizationFor({ kind: 'declassify', days: 3650 }), device);
  assert.equal(reasonOf(verifyAuthorization(decade, { thisDevice: self(device), now: FIXED_NOW })), 'ok');
});

test('every other refusal is reached: malformed, wrong-purpose, too-large, bad-signature, signer-mismatch, not-yet-valid, expired, revoked', () => {
  const device = deviceKey();
  const check = (envelope: unknown, now = FIXED_NOW): AuthorizationRefusal | 'ok' => reasonOf(verifyAuthorization(envelope, { thisDevice: self(device), now }));
  const body = authorizationFor({ kind: 'protected-b' });
  const good = signAuthorization(body, device);
  assert.equal(check(good), 'ok');
  assert.equal(check(signAuthorization({ ...body, extra: 1 }, device)), 'malformed');
  assert.equal(check({ ...good, signer: { ...good.signer, memberId: 'mbr-1' } }), 'bad-signature', 'an added member id breaks the signature');
  assert.equal(check(signPayload(device, 'policy-authorization', body, { now: () => new Date(body.issuedAt), memberId: 'mbr-1' })), 'malformed', 'a member id is not part of an authorization');
  assert.equal(check('garbage'), 'malformed');
  assert.equal(check(signPayload(device, 'policy-bundle', body, { now: () => new Date(body.issuedAt) })), 'wrong-purpose');
  const huge = plain(good);
  huge.payload.evidence = 'x'.repeat(MAX_PAYLOAD_BYTES);
  assert.equal(check(huge), 'too-large');
  const edited = plain(good);
  edited.payload.scope = { labels: ['ca-protected/Protected C'] };
  assert.equal(check(edited), 'bad-signature');
  assert.equal(check(signPayload(device, 'policy-authorization', body, { now: () => new Date(FIXED_NOW + 1000) })), 'signer-mismatch');
  assert.equal(check(good, FIXED_NOW - 10 * 60 * 1000), 'not-yet-valid');
  assert.equal(check(good, FIXED_NOW - 4 * 60 * 1000), 'ok', 'within the clock skew');
  assert.equal(check(good, Date.parse(body.expiresAt)), 'expired');
  assert.equal(check(good, Date.parse(body.expiresAt) - 1), 'ok');
  assert.equal(check(signAuthorization(authorizationFor({ kind: 'protected-b', revokedBy: 'protected-b-2' }), device)), 'revoked');
  const reached = new Set(['malformed', 'wrong-purpose', 'too-large', 'bad-signature', 'signer-mismatch', 'not-yet-valid', 'expired', 'revoked', 'unknown-signer', 'named-person-mismatch', 'too-long']);
  assert.deepEqual([...reached].sort(), Object.keys(AUTHORIZATION_REFUSALS).sort(), 'every reason has a producer in this file');
  for (const sentence of Object.values(AUTHORIZATION_REFUSALS)) {
    assert.ok(!sentence.includes(EM_DASH) && !/NEAR organization/.test(sentence) && !/Reset/.test(sentence), sentence);
  }
});

test('authorizationCovers: kind, subject, project, label and use each decide; an absent list is any, a present list with nothing asked covers nothing', () => {
  const body = authorizationFor({
    kind: 'protected-b', subject: { endpoint: 'models-example-org' }, scope: { projects: ['project-alpha'], labels: ['ca-protected/Protected B'], uses: ['chat'] }
  });
  const ask = { kind: 'protected-b' as const, subject: { endpoint: 'models-example-org' }, project: 'project-alpha', label: 'ca-protected/Protected B', use: 'chat' };
  assert.equal(authorizationCovers(body, ask, FIXED_NOW), true);
  assert.equal(authorizationCovers(body, { ...ask, kind: 'residency-exception' }, FIXED_NOW), false);
  assert.equal(authorizationCovers(body, { ...ask, subject: { endpoint: 'other' } }, FIXED_NOW), false);
  assert.equal(authorizationCovers(body, { ...ask, subject: { model: 'models-example-org' } }, FIXED_NOW), false);
  assert.equal(authorizationCovers(body, { ...ask, project: 'project-beta' }, FIXED_NOW), false);
  assert.equal(authorizationCovers(body, { ...ask, label: 'ca-protected/Protected A' }, FIXED_NOW), false);
  assert.equal(authorizationCovers(body, { ...ask, use: 't1' }, FIXED_NOW), false);
  const { project: _p, ...noProject } = ask;
  assert.equal(authorizationCovers(body, noProject, FIXED_NOW), false, 'a project-scoped record covers nothing when no project is asked (D-54)');
  const open = authorizationFor({ kind: 'protected-b' });
  assert.equal(authorizationCovers(open, { kind: 'protected-b', subject: { endpoint: 'models-example-org' } }, FIXED_NOW), true, 'absent lists cover any');
  assert.equal(authorizationCovers(open, ask, FIXED_NOW), true);
  assert.equal(authorizationCovers(open, ask, Date.parse(open.expiresAt)), false, 'ended');
  assert.equal(authorizationCovers(open, ask, FIXED_NOW - 60 * 60 * 1000), false, 'not started');
  assert.equal(authorizationCovers(authorizationFor({ kind: 'protected-b', revokedBy: 'x' }), ask, FIXED_NOW), false, 'revoked');
  assert.equal(authorizationCovers(open, ask, Number.NaN), false);
});

test('T-41-04: 2,000 authorizations by fresh random keys, 50 per organization layer with their signers, sign without a secret-scanner refusal', () => {
  const issuer = issuerKey();
  for (let layer = 0; layer < 40; layer += 1) {
    const keys = Array.from({ length: 50 }, () => randomKey());
    const envelopes = keys.map((key, index) => plain(signAuthorization(authorizationFor({ kind: 'protected-b', id: `pb-${String(layer)}-${String(index).padStart(2, '0')}` }), key)));
    envelopes.sort((a, b) => (a.payload.id < b.payload.id ? -1 : 1));
    const signers = keys.map((key) => signerEntry(key)).sort((a, b) => ((a['fingerprint'] as string) < (b['fingerprint'] as string) ? -1 : 1));
    const doc = plain(policyDocumentFor({ key: issuer, layer: 'organization' }));
    doc.authorizations = envelopes;
    doc.people = { v: 1, signers };
    doc.requires = ['agents@1', 'authorizations@1', 'labels@1', 'layers@1', 'people@1'];
    let signed: SignedPayload | undefined;
    assert.doesNotThrow(() => { signed = signOrganizationLayer(doc, issuer); }, `layer ${String(layer)}`);
    if (layer === 0 && signed !== undefined) {
      const state = verifyPolicyLayer(signed, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW });
      assert.equal(state.state, 'valid');
      if (state.state === 'valid') {
        const listed = state.document.people?.signers ?? [];
        for (const envelope of state.document.authorizations ?? []) assert.equal(reasonOf(verifyAuthorization(envelope, { signers: listed, now: FIXED_NOW })), 'ok');
      }
    }
  }
});

test('parseAuthorizations: exact envelopes of purpose policy-authorization, a strict key and signature, no member id, sorted by id, at most 256', () => {
  const device = deviceKey();
  const one = (id: string): Loose => plain(signAuthorization(authorizationFor({ kind: 'protected-b', id }), device));
  const reason = (list: unknown): string => { const parsed = parseAuthorizations(list); return parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`; };
  assert.equal(reason([one('a'), one('b')]), 'ok');
  assert.equal(reason([one('b'), one('a')]), 'not-sorted authorizations[1]');
  assert.equal(reason([one('a'), one('a')]), 'duplicate authorizations[1]');
  assert.equal(reason([{ ...one('a'), purpose: 'policy-bundle' }]), 'not-allowed-here authorizations[0].purpose');
  assert.equal(reason([{ ...one('a'), extra: 1 }]), 'unknown-field authorizations[0].extra');
  assert.equal(reason([{ ...one('a'), v: 2 }]), 'unknown-version authorizations[0].v');
  const member = one('a');
  member.signer.memberId = 'mbr-1';
  assert.equal(reason([member]), 'unknown-field authorizations[0].signer.memberId');
  const badKey = one('a');
  badKey.signer.publicKey = 'short';
  assert.equal(reason([badKey]), 'wrong-type authorizations[0].signer.publicKey');
  const badPrint = one('a');
  badPrint.signer.fingerprint = issuerKey().fingerprint;
  assert.equal(reason([badPrint]), 'wrong-type authorizations[0].signer.fingerprint');
  const badSig = one('a');
  badSig.sig = 'abc';
  assert.equal(reason([badSig]), 'wrong-type authorizations[0].sig');
  const badBody = one('a');
  badBody.payload.subject = { model: 'x' };
  assert.equal(reason([badBody]), 'not-allowed-here authorizations[0].payload.subject.model');
  assert.equal(MAX_AUTHORIZATIONS, 256);
  const template = one('a');
  const many = (count: number): Loose[] => Array.from({ length: count }, (_, index) => ({ ...template, payload: { ...template.payload, id: `a${String(index).padStart(3, '0')}` } }));
  assert.equal(reason(many(256)), 'ok', 'shape only: the signatures are verifyAuthorization\'s');
  assert.equal(reason(many(257)), 'not-allowed-here authorizations');
});

test('parseAuthorizationBody: exact keys, the subject the kind is about and nothing else, scope lists sorted and non-empty, bounded texts', () => {
  const reason = (edit: (body: Loose) => void, kind: Loose = 'protected-b'): string => {
    const body = plain(authorizationFor({ kind }));
    edit(body);
    const parsed = parseAuthorizationBody(body);
    return parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`;
  };
  for (const kind of AUTHORIZATION_KINDS) assert.equal(reason(() => undefined, kind), 'ok', kind);
  assert.deepEqual({ ...SUBJECT_FOR_KIND }, {
    'protected-b': 'endpoint', 't1-risk': 'model', 'accredited-device': 'device', 'residency-exception': 'endpoint', declassify: 'item'
  });
  assert.equal(reason((b) => { b.kind = 'everything'; }), 'not-allowed-here kind');
  assert.equal(reason((b) => { b.subject = { endpoint: 'a', model: 'b' }; }), 'not-allowed-here subject.model');
  assert.equal(reason((b) => { b.subject = {}; }), 'missing-field subject.endpoint');
  assert.equal(reason((b) => { b.subject = { planet: 'x' }; }), 'unknown-field subject.planet');
  assert.equal(reason((b) => { b.subject = { endpoint: '-bad' }; }), 'wrong-type subject.endpoint');
  assert.equal(reason((b) => { b.scope = { labels: [] }; }), 'empty-list scope.labels');
  assert.equal(reason((b) => { b.scope = { labels: ['org/Restricted', 'ca-protected/Protected B'] }; }), 'not-sorted scope.labels[1]');
  assert.equal(reason((b) => { b.scope = { uses: ['T1'] }; }), 'wrong-type scope.uses[0]');
  assert.equal(reason((b) => { b.scope = { projects: ['*'] }; }), 'wrong-type scope.projects[0]', 'any project is an absent list, never a star');
  assert.equal(reason((b) => { b.scope = { everything: true }; }), 'unknown-field scope.everything');
  assert.equal(reason((b) => { b.conditions = Array.from({ length: 9 }, () => 'One condition.'); }), 'not-allowed-here conditions');
  assert.equal(reason((b) => { b.conditions = ['x'.repeat(281)]; }), 'wrong-type conditions[0]');
  assert.equal(reason((b) => { b.evidence = ''; }), 'wrong-type evidence');
  assert.equal(reason((b) => { b.namedPerson = { name: 'A', role: 'B', key: 'k' }; }), 'unknown-field namedPerson.key');
  assert.equal(reason((b) => { b.expiresAt = b.issuedAt; }), 'wrong-type expiresAt');
  assert.equal(reason((b) => { b.issuedAt = '2026-11-20T00:00:00Z'; }), 'wrong-type issuedAt');
  assert.equal(reason((b) => { b.id = 'Has Capitals'; }), 'wrong-type id');
  assert.equal(reason((b) => { b.v = 2; }), 'unknown-version v');
  assert.equal(reason((b) => { b.signature = 'x'; }), 'unknown-field signature', 'the inner signature is the envelope\'s, never a body field');
});

test('parsePolicySigners: name, role and a key whose fingerprint matches, sorted by fingerprint, at most 64', () => {
  const keys = [issuerKey('a'), issuerKey('b'), issuerKey('c')].sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1));
  const list = keys.map((key) => signerEntry(key));
  const reason = (value: unknown): string => { const parsed = parsePolicySigners(value); return parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`; };
  assert.equal(reason(list), 'ok');
  assert.equal(reason([list[1], list[0]]), 'not-sorted signers[1]');
  assert.equal(reason([list[0], list[0]]), 'duplicate signers[1]');
  assert.equal(reason([{ ...list[0], fingerprint: keys[1]?.fingerprint }]), 'wrong-type signers[0].fingerprint');
  assert.equal(reason([{ ...list[0], did: 'did:key:x' }]), 'unknown-field signers[0].did');
  assert.equal(reason([{ ...list[0], name: '' }]), 'wrong-type signers[0].name');
  const sixtyFive = Array.from({ length: 65 }, (_, index) => signerEntry(issuerKey(`s${String(index)}`))).sort((a, b) => (a['fingerprint'] as string) < (b['fingerprint'] as string) ? -1 : 1);
  assert.equal(reason(sixtyFive.slice(0, 64)), 'ok');
  assert.equal(reason(sixtyFive), 'not-allowed-here signers');
});

test('D-09, D-15, D-49: verifyPolicyLayer reads your organization\'s layer under its issuer and refuses every mixed source and size', () => {
  const issuer = issuerKey();
  const device = deviceKey();
  const orgDoc = policyDocumentFor({ key: issuer, layer: 'organization' });
  const orgEnvelope = signOrganizationLayer(orgDoc, issuer);
  const valid = verifyPolicyLayer(orgEnvelope, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW });
  assert.equal(valid.state, 'valid');
  if (valid.state === 'valid') {
    assert.equal(valid.wireVersion, 2);
    assert.equal(valid.document.layer, 'organization');
    assert.equal(valid.renewDue, false);
  }
  const failed = (state: ReturnType<typeof verifyPolicyLayer>): string => (state.state === 'failed-closed' ? state.reason : 'valid');
  // An organization document signed as a policy bundle, or a personal one signed as an organization layer: the purpose and the layer disagree.
  assert.equal(failed(verifyPolicyLayer(signPersonalLayer(orgDoc, issuer), { purpose: 'policy-bundle', status: activeKeys(issuer), now: FIXED_NOW })), 'malformed');
  const personalAsOrg = signOrganizationLayer(policyDocumentFor({ key: issuer }), issuer);
  assert.equal(failed(verifyPolicyLayer(personalAsOrg, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW })), 'malformed');
  // The other purpose is wrong-purpose, never read.
  assert.equal(failed(verifyPolicyLayer(orgEnvelope, { purpose: 'policy-bundle', status: activeKeys(issuer), now: FIXED_NOW })), 'wrong-purpose');
  // D-15: a layer this device signed and presents as your organization's is unknown-key under the pin.
  const forged = signOrganizationLayer(policyDocumentFor({ key: device, layer: 'organization' }), device);
  assert.equal(failed(verifyPolicyLayer(forged, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW })), 'unknown-key');
  // A v1 bundle is a personal layer: under org-policy-layer it is wrong-purpose.
  const v1 = defaultBundlePayload({ issuer: { fingerprint: device.fingerprint, publicKey: device.publicKey }, now: FIXED_NOW });
  const v1Envelope = signPayload(device, 'policy-bundle', v1, { now: () => new Date(v1.issuedAt) });
  assert.equal(failed(verifyPolicyLayer(v1Envelope, { purpose: 'org-policy-layer', status: activeKeys(device), now: FIXED_NOW })), 'wrong-purpose');
  const v1State = verifyPolicyLayer(v1Envelope, { purpose: 'policy-bundle', status: activeKeys(device), now: FIXED_NOW });
  const v1Before = verifyBundleEnvelope(v1Envelope, { status: activeKeys(device), now: FIXED_NOW });
  assert.ok(v1State.state === 'valid' && v1Before.state === 'valid' && v1State.hash === v1Before.hash && v1State.wireVersion === 1);
  // Sizes: 1 MiB for your organization's layer, 256 KiB for the personal one, measured before the signature.
  const pad = (envelope: SignedPayload, bytes: number): Loose => { const copy = plain(envelope); copy.payload.pad = 'x'.repeat(bytes); return copy; };
  assert.equal(failed(verifyPolicyLayer(pad(orgEnvelope, MAX_ORGANIZATION_LAYER_BYTES), { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW })), 'too-large');
  assert.equal(failed(verifyPolicyLayer(pad(orgEnvelope, 300 * 1024), { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW })), 'bad-signature', '300 KiB is within the organization cap');
  const personal = signPersonalLayer(policyDocumentFor({ key: device }), device);
  assert.equal(failed(verifyPolicyLayer(pad(personal, 300 * 1024), { purpose: 'policy-bundle', status: activeKeys(device), now: FIXED_NOW })), 'too-large');
  // The repeat check, the clock and expiry, as for a v1 bundle.
  const misdated = signPayload(issuer, 'org-policy-layer', orgDoc, { now: () => new Date(FIXED_NOW + 1000), maxBytes: MAX_ORGANIZATION_LAYER_BYTES });
  assert.equal(failed(verifyPolicyLayer(misdated, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW })), 'signer-mismatch');
  assert.equal(failed(verifyPolicyLayer(orgEnvelope, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW - DAY_MS })), 'clock-behind');
  assert.equal(failed(verifyPolicyLayer(orgEnvelope, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: Date.parse(orgDoc.expiresAt) })), 'expired');
  assert.equal(failed(verifyPolicyLayer(orgEnvelope, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW, lastValidAt: Date.parse(orgDoc.expiresAt) })), 'expired', 'the clock turned back never revives it');
  assert.equal(failed(verifyPolicyLayer(undefined, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW })), 'missing');
  assert.equal(failed(verifyPolicyLayer(orgEnvelope, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: Number.NaN })), 'clock-behind');
  // A project layer has no signing purpose in this phase, so it never verifies as either.
  const project = signPersonalLayer(policyDocumentFor({ key: device, layer: 'project' }), device);
  assert.equal(failed(verifyPolicyLayer(project, { purpose: 'policy-bundle', status: activeKeys(device), now: FIXED_NOW })), 'malformed');
});

test('fixtures: the full document\'s authorizations verify against its own signers, and an enrolment file carries a layer that verifies under the issuer', () => {
  const issuer = issuerKey();
  const parsed = parsePolicyDocument(fullDocumentFor(issuer));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) return;
  const signers = parsed.value.people?.signers ?? [];
  assert.equal(signers.length, 1);
  const verdicts = (parsed.value.authorizations ?? []).map((envelope) => reasonOf(verifyAuthorization(envelope, { signers, now: FIXED_NOW })));
  assert.ok(verdicts.length >= 5);
  assert.ok(verdicts.every((reason) => reason === 'ok' || reason === 'revoked'), verdicts.join(','));
  assert.ok(verdicts.includes('revoked'));
  const text = enrolmentFileFor({ issuer });
  assert.ok(Buffer.byteLength(text, 'utf8') < 64 * 1024, 'the starting rules fit the enrolment cap (D-56)');
  const envelope = JSON.parse(text) as SignedPayload<{ layer: unknown; issuer: { publicKey: string }; serial: number }>;
  const verdict = verifyPayload<{ layer: unknown; issuer: { publicKey: string }; serial: number }>(envelope, { purpose: 'org-enrolment', status: activeKeys(issuer) });
  assert.ok(verdict.ok);
  if (!verdict.ok) return;
  assert.equal(verdict.payload.issuer.publicKey, issuer.publicKey);
  assert.equal(verdict.payload.serial, 1);
  const layer = verifyPolicyLayer(verdict.payload.layer, { purpose: 'org-policy-layer', status: activeKeys(issuer), now: FIXED_NOW });
  assert.equal(layer.state, 'valid');
  if (layer.state === 'valid') assert.equal((layer.document as PolicyDocument).layer, 'organization');
});

test('a body that would sign a secret-shaped value is refused with a PayloadError, and a valid one is accepted as AuthorizationBody', () => {
  const device = deviceKey();
  const body: AuthorizationBody = authorizationFor({ kind: 'accredited-device' });
  assert.doesNotThrow(() => signAuthorization(body, device));
  // A private key header, built at run time so this file holds none.
  const header = `${'-'.repeat(5)}BEGIN ${['PRIVATE', 'KEY'].join(' ')}${'-'.repeat(5)}`;
  assert.throws(() => signAuthorization({ ...body, evidence: header }, device), PayloadError);
});

test('D-06: authorizations in a document need authorizations@1, keep their signed bytes, and are frozen', () => {
  const device = deviceKey();
  const doc = plain(policyDocumentFor({ key: device }));
  const envelope = plain(signAuthorization(authorizationFor({ kind: 't1-risk' }), device));
  doc.authorizations = [envelope];
  const unnamed = parsePolicyDocument(doc);
  assert.equal(unnamed.ok ? 'ok' : `${unnamed.reason} ${unnamed.path}`, 'missing-field requires');
  doc.requires = ['agents@1', 'authorizations@1', 'labels@1', 'layers@1', 'people@1'];
  const parsed = parsePolicyDocument(doc);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) return;
  const kept = parsed.value.authorizations?.[0];
  assert.deepEqual(kept, envelope, 'the parsed envelope is the signed one, so its signature still verifies');
  assert.equal(reasonOf(verifyAuthorization(kept, { thisDevice: self(device), now: FIXED_NOW })), 'ok');
  assert.ok(Object.isFrozen(kept) && Object.isFrozen(kept?.payload) && Object.isFrozen(kept?.payload.namedPerson));
  envelope.payload.evidence = 'changed after parsing';
  assert.equal(parsed.value.authorizations?.[0]?.payload.evidence, 'TRA-2026-11-0042', 'parsed input is never shared with the result');
});

test('hostile input never throws: a prototype key is an unknown field, and a getter that throws is malformed', () => {
  const device = deviceKey();
  const text = JSON.stringify(signAuthorization(authorizationFor({ kind: 'protected-b' }), device)).replace('"payload":{', '"payload":{"__proto__":{"kind":"declassify"},');
  const parsed = parseAuthorizations([JSON.parse(text)]);
  assert.equal(parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`, 'unknown-field authorizations[0].payload.__proto__');
  const trap = { get v(): number { throw new Error('trap'); } };
  assert.equal(reasonOf(verifyAuthorization(trap, { thisDevice: self(device), now: FIXED_NOW })), 'malformed');
  assert.equal(reasonOf(verifyAuthorization(null, { thisDevice: self(device), now: FIXED_NOW })), 'malformed');
  assert.equal(parseAuthorizationBody(Object.create({ v: 1 })).ok, false);
});

test('an authorization is checked against a key source built only from the caller\'s list: a rotated or revoked state elsewhere cannot make it count', () => {
  const officer = issuerKey('security-officer');
  const envelope = signAuthorization(authorizationFor({ kind: 'accredited-device' }), officer);
  // The officer's key is not this device and not listed, so it is unknown whatever other source might say about it.
  assert.equal(reasonOf(verifyAuthorization(envelope, { thisDevice: self(deviceKey()), now: FIXED_NOW })), 'unknown-signer');
  assert.equal(reasonOf(verifyAuthorization(envelope, { signers: [signerOf(issuerKey('other'))], now: FIXED_NOW })), 'unknown-signer');
  assert.equal(reasonOf(verifyAuthorization(envelope, { signers: [signerOf(officer)], now: FIXED_NOW })), 'ok');
});

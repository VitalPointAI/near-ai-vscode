// The signed label binding (Phase 45.1 plan 01 Task 2; D-03, XCHG-02, coordinator check B6). Fictional writers, sites and content; keys are made at
// test time from a label and never leave this file.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import test from 'node:test';
import { EDDSA_JCS_2022 } from '../domain/credentials/dataIntegrity';
import type { CredentialSigner } from '../domain/credentials/dataIntegrity';
import { multibaseEncode } from '../domain/credentials/multibase';
import {
  LABEL_BINDING_FORMAT, LABEL_BINDING_REFUSALS, LABEL_BINDING_SIGNER_FORMS, LabelBindingError, bindLabel, contentHashOf, signerFormOf, verifyLabelBinding
} from '../domain/exchange/labelBinding';
import type { LabelBinding, LabelBindingFacts } from '../domain/exchange/labelBinding';
import type { Label } from '../domain/gate/labels';

type Loose = Record<string, any>;

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const CONTENT = new TextEncoder().encode('Example released version: the logistics annex, fictional.');
const LABEL: Label = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: ['CAN', 'GBR'], handling: [] };
const TIME = '2026-11-24T12:00:00.000Z';

interface TestKey { signer: CredentialSigner; publicKey: Uint8Array }

function keyFor(seedLabel: string, verificationMethod: string): TestKey {
  const seed = createHash('sha256').update(`label-binding-test/${seedLabel}`, 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = new Uint8Array(Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url'));
  return {
    publicKey,
    signer: { verificationMethod, suite: EDDSA_JCS_2022, sign: async (bytes: Uint8Array) => new Uint8Array(edSign(null, Buffer.from(bytes), privateKey)) }
  };
}

const SESSION = keyFor('session', 'session:writer-7f3a');
const RELEASE = keyFor('release', 'org-release:hq');

function facts(signer: string, edit: Partial<LabelBindingFacts> = {}): LabelBindingFacts {
  return { label: LABEL, mapping: 3, contentHash: contentHashOf(CONTENT), signer, time: TIME, ...edit };
}

function copy(binding: LabelBinding): Loose {
  return JSON.parse(JSON.stringify(binding)) as Loose;
}

function reasonOf(value: unknown, content: Uint8Array = CONTENT, publicKey: Uint8Array = SESSION.publicKey, options: Loose = {}): string {
  const verdict = verifyLabelBinding(value, content, { publicKey, ...options });
  return verdict.ok ? 'ok' : verdict.reason;
}

test('a session signer and an org-release signer each give a binding that verifies against the content and returns the label', async () => {
  assert.deepEqual([...LABEL_BINDING_SIGNER_FORMS], ['session', 'org-release']);
  for (const key of [SESSION, RELEASE]) {
    const binding = await bindLabel(key.signer, facts(key.signer.verificationMethod));
    assert.equal(binding.format, LABEL_BINDING_FORMAT);
    assert.equal(binding.signer, key.signer.verificationMethod);
    assert.equal(binding.mapping, 3);
    assert.equal(binding.contentHash, createHash('sha256').update(CONTENT).digest('hex'));
    const verdict = verifyLabelBinding(copy(binding), CONTENT, { publicKey: key.publicKey, signer: key.signer.verificationMethod, mapping: 3, label: LABEL });
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.message);
    if (verdict.ok) assert.deepEqual(JSON.parse(JSON.stringify(verdict.label)), LABEL);
  }
  // A release copy that never leaves your organization's form binds with mapping 0.
  const local = await bindLabel(SESSION.signer, facts('session:writer-7f3a', { mapping: 0 }));
  assert.equal(reasonOf(copy(local), CONTENT, SESSION.publicKey, { mapping: 0 }), 'ok');
});

test('bindLabel refuses a did:webvh, a did:key or any other signer form, and a signer whose method is not the field', async () => {
  const forms = [
    'did:webvh:QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ:hq.example.org:people:alex',
    'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    'person:alex', 'session:', 'org-release:HQ', 'session:writer 7', ''
  ];
  for (const signer of forms) {
    const key = keyFor('other', signer);
    await assert.rejects(bindLabel(key.signer, facts(signer)), (error: unknown) => error instanceof LabelBindingError && error.reason === 'signer-form', signer);
    assert.equal(signerFormOf(signer), undefined, signer);
  }
  // The field says one signer and the key belongs to another.
  await assert.rejects(bindLabel(SESSION.signer, facts('org-release:hq')), (error: unknown) => error instanceof LabelBindingError && error.reason === 'signer-form');
  // Facts that do not read are refused before signing.
  await assert.rejects(bindLabel(SESSION.signer, facts('session:writer-7f3a', { contentHash: 'abc' })), (error: unknown) => error instanceof LabelBindingError && error.reason === 'malformed');
});

test('the serialized binding holds no DID, no public key and never the content itself', async () => {
  for (const key of [SESSION, RELEASE]) {
    const text = JSON.stringify(await bindLabel(key.signer, facts(key.signer.verificationMethod)));
    assert.ok(!text.includes('did:'), 'no DID');
    for (const form of [Buffer.from(key.publicKey).toString('base64url'), Buffer.from(key.publicKey).toString('base64'), Buffer.from(key.publicKey).toString('hex'), multibaseEncode(key.publicKey)]) {
      assert.ok(!text.includes(form), 'no public key in any encoding');
    }
    const plainText = new TextDecoder().decode(CONTENT);
    assert.ok(!text.includes(plainText) && !text.includes(Buffer.from(CONTENT).toString('base64')), 'no content');
  }
});

test('a changed content, label, mapping version, time or proof is each refused with a named reason', async () => {
  const binding = await bindLabel(SESSION.signer, facts('session:writer-7f3a'));
  assert.equal(reasonOf(copy(binding)), 'ok');
  assert.equal(reasonOf(copy(binding), new TextEncoder().encode('Example released version: changed.')), 'content-changed');
  const relabelled = copy(binding);
  relabelled.label.level = 'Protected A';
  assert.equal(reasonOf(relabelled), 'signature');
  const widened = copy(binding);
  widened.label.releasability = ['CAN', 'GBR', 'USA'];
  assert.equal(reasonOf(widened), 'signature');
  const remapped = copy(binding);
  remapped.mapping = 4;
  assert.equal(reasonOf(remapped), 'signature', 'the mapping version is signed');
  assert.equal(reasonOf(copy(binding), CONTENT, SESSION.publicKey, { mapping: 4 }), 'mapping-version');
  const retimed = copy(binding);
  retimed.time = '2026-11-25T12:00:00.000Z';
  assert.equal(reasonOf(retimed), 'signature');
  const broken = copy(binding);
  broken.proof.proofValue = `${String(broken.proof.proofValue).slice(0, -2)}11`;
  assert.equal(reasonOf(broken), 'signature');
  assert.equal(reasonOf(copy(binding), CONTENT, RELEASE.publicKey), 'signature', 'another key');
  assert.equal(reasonOf(copy(binding), CONTENT, SESSION.publicKey, { label: { ...LABEL, level: 'Protected A' } }), 'label-changed');
});

test('a binding with another signer form, an unexpected signer or a shape this version does not know is refused', async () => {
  const binding = await bindLabel(SESSION.signer, facts('session:writer-7f3a'));
  const asPerson = copy(binding);
  asPerson.signer = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
  asPerson.proof.verificationMethod = asPerson.signer;
  assert.equal(reasonOf(asPerson), 'signer-form');
  assert.equal(reasonOf(copy(binding), CONTENT, SESSION.publicKey, { signer: 'session:writer-other' }), 'wrong-signer');
  const swappedMethod = copy(binding);
  swappedMethod.proof.verificationMethod = 'session:writer-other';
  assert.equal(reasonOf(swappedMethod), 'signature');
  const extra = copy(binding);
  extra.publicKey = 'added';
  assert.equal(reasonOf(extra), 'malformed');
  const otherFormat = copy(binding);
  otherFormat.format = 'label-binding/2';
  assert.equal(reasonOf(otherFormat), 'malformed');
  const missing = copy(binding);
  delete missing.time;
  assert.equal(reasonOf(missing), 'malformed');
  for (const value of [null, [], 'binding', 1]) assert.equal(reasonOf(value), 'malformed');
});

test('refusal sentences are plain and name no value, and verifyLabelBinding never throws', async () => {
  for (const sentence of Object.values(LABEL_BINDING_REFUSALS)) {
    assert.ok(sentence.endsWith('.'));
    assert.doesNotMatch(sentence, /Protected|CAN|GBR|did:/);
  }
  const binding = await bindLabel(SESSION.signer, facts('session:writer-7f3a'));
  const hostile = copy(binding);
  hostile.proof = { ...hostile.proof, proofValue: '!!!not-base58!!!' };
  assert.equal(reasonOf(hostile), 'signature');
  assert.equal(reasonOf(copy(binding), CONTENT, new Uint8Array(3)), 'signature');
});

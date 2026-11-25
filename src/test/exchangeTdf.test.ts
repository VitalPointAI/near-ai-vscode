// Base TDF objects (Phase 45.1 plan 02 Task 2; D-07, XCHG-04). Partners, keys and content are fictional and made at test time; the label table values are
// placeholders (EXAMPLE-...). The OpenTDF schema and examples are test data copied from the public specification (test/fixtures/exchange/opentdf).
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { EDDSA_JCS_2022 } from '../domain/credentials/dataIntegrity';
import { bindLabel, contentHashOf } from '../domain/exchange/labelBinding';
import type { LabelBinding } from '../domain/exchange/labelBinding';
import { mapOut } from '../domain/exchange/labelInterop';
import type { ExternalLabel } from '../domain/exchange/labelInterop';
import { TDF_REFUSALS, TdfError, buildTdf, readTdf, readTdfManifest, unwrapWithPrivateKey } from '../domain/exchange/tdf';
import type { OaepHash, TdfKeyAccess, TdfObject, TdfRecipient } from '../domain/exchange/tdf';
import { parseLabelInteropSection } from '../domain/gate/labelInteropSection';
import type { LabelInteropTable } from '../domain/gate/labelInteropSection';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';

type Loose = Record<string, any>;

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'exchange', 'opentdf');
const SCHEMA = JSON.parse(readFileSync(path.join(FIXTURES, 'manifest.schema.json'), 'utf8')) as Loose;
const EXAMPLES = JSON.parse(readFileSync(path.join(FIXTURES, 'examples.json'), 'utf8')) as Loose;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const CONTENT = new TextEncoder().encode('Example released version: the movement table, fictional. '.repeat(40));
const LABEL: Label = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: ['CAN', 'GBR'], handling: [] };
const SIGNER = 'org-release:hq';

const TABLE = ((): LabelInteropTable => {
  const parsed = parseLabelInteropSection({
    v: 1, version: 2,
    scales: {
      'ca-protected': {
        policy: 'EXAMPLE-POLICY-PROTECTED', levels: { 'Protected A': 'EXAMPLE-PA', 'Protected B': 'EXAMPLE-PB' }, compartments: {},
        releasableTo: { category: 'EXAMPLE-RELEASABLE-TO', values: { CAN: 'EXAMPLE-CAN', GBR: 'EXAMPLE-GBR' } }
      }
    }
  }, SCALE_PRESETS);
  assert.ok(parsed.ok);
  return parsed.value;
})();

const RELEASE_KEY = ((): { sign: (bytes: Uint8Array) => Promise<Uint8Array>; publicKey: Uint8Array } => {
  const seed = createHash('sha256').update('tdf-test/release', 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return {
    sign: async (bytes) => new Uint8Array(edSign(null, Buffer.from(bytes), privateKey)),
    publicKey: new Uint8Array(Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url'))
  };
})();

interface Partner { recipient: TdfRecipient; privateKey: string; oaepHash?: OaepHash }

function ecPartner(): Partner {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    recipient: { url: 'https://kas.partner.example', kid: 'example-ec-1', alg: 'ec:secp256r1', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
}

function rsaPartner(bits: number, oaepHash: OaepHash): Partner {
  const pair = generateKeyPairSync('rsa', { modulusLength: bits });
  return {
    recipient: { url: 'https://kas.partner.example', kid: `example-rsa-${String(bits)}`, alg: 'rsa:2048', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), oaepHash },
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    oaepHash
  };
}

const EC = ecPartner();
const RSA_SHA1 = rsaPartner(2048, 'sha1');

async function labelled(label: Label = LABEL, content: Uint8Array = CONTENT, boundLabel: Label = label): Promise<{ external: ExternalLabel; binding: LabelBinding }> {
  const out = mapOut(label, TABLE);
  assert.ok(out.ok);
  const binding = await bindLabel(
    { verificationMethod: SIGNER, suite: EDDSA_JCS_2022, sign: RELEASE_KEY.sign },
    { label: boundLabel, mapping: TABLE.version, contentHash: contentHashOf(content), signer: SIGNER, time: '2026-11-25T09:00:00.000Z' }
  );
  return { external: out.value, binding };
}

function options(partner: Partner, edit: Loose = {}): Parameters<typeof readTdf>[1] {
  return {
    decryptKey: async (access: TdfKeyAccess) => unwrapWithPrivateKey(access, partner.privateKey, partner.oaepHash ?? 'sha256'),
    table: TABLE,
    bindingKey: (signer: string) => (signer === SIGNER ? RELEASE_KEY.publicKey : undefined),
    ...edit
  };
}

async function built(partner: Partner = EC, segmentBytes?: number): Promise<TdfObject> {
  return buildTdf({ content: CONTENT, ...(await labelled()), recipient: partner.recipient, ...(segmentBytes === undefined ? {} : { segmentBytes }) });
}

function copyOf(object: TdfObject): { manifest: Loose; payload: Uint8Array } {
  return { manifest: JSON.parse(JSON.stringify(object.manifest)) as Loose, payload: new Uint8Array(object.payload) };
}

async function reasonOf(object: { manifest: Loose; payload: Uint8Array }, partner: Partner = EC, edit: Loose = {}): Promise<string> {
  const result = await readTdf(object, options(partner, edit));
  return result.ok ? 'ok' : result.bindingReason === undefined ? result.reason : `${result.reason}/${result.bindingReason}`;
}

/** Every `required` list of the schema checked against the value; a `required` on an array applies to its items (the schema places it there). */
function missingRequired(schema: Loose, value: unknown, where = '$'): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (Array.isArray(schema.required)) for (const key of schema.required as string[]) if (!(key in (item as Loose))) out.push(`${where}[${String(index)}].${key}`);
      if (schema.items !== undefined) out.push(...missingRequired(schema.items as Loose, item, `${where}[${String(index)}]`));
    }
    return out;
  }
  if (typeof value !== 'object' || value === null) return out;
  for (const key of (schema.required ?? []) as string[]) if (!(key in value)) out.push(`${where}.${key}`);
  for (const [key, child] of Object.entries((schema.properties ?? {}) as Loose)) {
    if (key in value) out.push(...missingRequired(child as Loose, (value as Loose)[key], `${where}.${key}`));
  }
  return out;
}

test('buildTdf to an EC partner key writes every field the copied schema marks required, with AES-256-GCM and the version in its three places', async () => {
  const object = await built();
  assert.deepEqual(missingRequired(SCHEMA, object.manifest), []);
  assert.ok(missingRequired(SCHEMA, { payload: {}, encryptionInformation: {} }).length > 5, 'the walk has teeth');
  const manifest = object.manifest as Loose;
  assert.equal(manifest.encryptionInformation.method.algorithm, 'AES-256-GCM');
  assert.equal(manifest.schemaVersion, '4.3.0');
  assert.equal(manifest.tdf_spec_version, '4.3.0');
  assert.equal(manifest.payload.tdf_spec_version, '4.3.0');
  const access = manifest.encryptionInformation.keyAccess[0];
  assert.equal(access.type, 'ec-wrapped');
  assert.match(access.ephemeralPublicKey, /^-----BEGIN PUBLIC KEY-----/);
  assert.equal(manifest.assertions[0].id, 'label-binding');
  assert.equal(manifest.assertions[0].binding.method, 'jws');
  // The content never sits in the manifest or in the clear in the payload.
  const text = JSON.stringify(manifest);
  assert.ok(!text.includes('movement table') && !Buffer.from(object.payload).toString('latin1').includes('movement table'));
});

test('readTdf with the partner EC key opens the object and returns the content and the label read back through the table', async () => {
  const result = await readTdf(await built(), options(EC));
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.deepEqual(Buffer.from(result.content), Buffer.from(CONTENT));
  assert.deepEqual(JSON.parse(JSON.stringify(result.label)), LABEL);
  assert.equal(result.binding.signer, SIGNER);
  assert.equal(result.external.classification, 'EXAMPLE-PB');
});

test('an RSA-2048 partner key wrapped with OAEP SHA-1 (the OpenTDF reference) opens with SHA-1 and not with SHA-256 (our Transit key)', async () => {
  const object = await built(RSA_SHA1);
  assert.equal((object.manifest as Loose).encryptionInformation.keyAccess[0].type, 'wrapped');
  assert.equal(await reasonOf(copyOf(object), RSA_SHA1), 'ok');
  // OpenBao Transit decrypts RSA with OAEP SHA-256 only, so an object wrapped with SHA-1 cannot be opened there (45.1-RESEARCH finding 4, G455).
  assert.equal(await reasonOf(copyOf(object), { ...RSA_SHA1, oaepHash: 'sha256' }), 'key-access');
  // Our receiving key: RSA-3072 with SHA-256.
  const receiving = rsaPartner(3072, 'sha256');
  assert.equal(await reasonOf(copyOf(await built(receiving)), receiving), 'ok');
});

test('a changed payload byte, segment hash or root signature is refused', async () => {
  const object = await built(EC, 512);
  assert.ok(((object.manifest as Loose).encryptionInformation.integrityInformation.segments as unknown[]).length > 2, 'several segments');
  const middle = copyOf(object);
  middle.payload[40] = (middle.payload[40] as number) ^ 1;
  assert.equal(await reasonOf(middle), 'payload');
  const tag = copyOf(object);
  tag.payload[tag.payload.length - 1] = (tag.payload[tag.payload.length - 1] as number) ^ 1;
  assert.equal(await reasonOf(tag), 'integrity');
  const root = copyOf(object);
  root.manifest.encryptionInformation.integrityInformation.rootSignature.sig = Buffer.alloc(32, 7).toString('base64');
  assert.equal(await reasonOf(root), 'integrity');
  const reordered = copyOf(object);
  const segments = reordered.manifest.encryptionInformation.integrityInformation.segments as Loose[];
  [segments[0], segments[1]] = [segments[1] as Loose, segments[0] as Loose];
  assert.equal(await reasonOf(reordered), 'integrity');
  const dropped = copyOf(object);
  (dropped.manifest.encryptionInformation.integrityInformation.segments as Loose[]).pop();
  assert.equal(await reasonOf(dropped), 'integrity');
});

test('a changed policy, key access or assertion is refused', async () => {
  const object = await built();
  const policy = copyOf(object);
  policy.manifest.encryptionInformation.policy = Buffer.from(JSON.stringify({ uuid: 'other', body: { dataAttributes: [], dissem: [] } })).toString('base64');
  assert.equal(await reasonOf(policy), 'policy-binding');
  const bindingHash = copyOf(object);
  bindingHash.manifest.encryptionInformation.keyAccess[0].policyBinding.hash = Buffer.alloc(64, 1).toString('base64');
  assert.equal(await reasonOf(bindingHash), 'policy-binding');
  const wrapped = copyOf(object);
  const key = Buffer.from(wrapped.manifest.encryptionInformation.keyAccess[0].wrappedKey as string, 'base64');
  key[20] = (key[20] as number) ^ 1;
  wrapped.manifest.encryptionInformation.keyAccess[0].wrappedKey = key.toString('base64');
  assert.equal(await reasonOf(wrapped), 'key-access');
  const statement = copyOf(object);
  const value = JSON.parse(statement.manifest.assertions[0].statement.value as string) as Loose;
  value.external.classification = 'EXAMPLE-PA';
  statement.manifest.assertions[0].statement.value = JSON.stringify(value);
  assert.equal(await reasonOf(statement), 'assertion');
  const unbound = copyOf(object);
  unbound.manifest.assertions[0].binding.signature = 'eyJhbGciOiJub25lIn0.e30.';
  assert.equal(await reasonOf(unbound), 'assertion');
  const missing = copyOf(object);
  missing.manifest.assertions = [];
  assert.equal(await reasonOf(missing), 'no-label');
});

test('the label binding is checked against the content and the label read back: another label, an unknown signer and no table are refused', async () => {
  // The partner form says Protected B; the signed binding says Protected A.
  const mismatched = buildTdf({ content: CONTENT, ...(await labelled(LABEL, CONTENT, { ...LABEL, level: 'Protected A' })), recipient: EC.recipient });
  assert.equal(await reasonOf(copyOf(mismatched)), 'label-binding/label-changed');
  assert.equal(await reasonOf(copyOf(await built()), EC, { bindingKey: () => undefined }), 'signer-unknown');
  assert.equal(await reasonOf(copyOf(await built()), EC, { table: undefined }), 'label-mapping');
  const otherKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string;
  assert.equal(await reasonOf(copyOf(await built()), EC, { bindingKey: () => new Uint8Array(Buffer.from(otherKey, 'base64url')) }), 'label-binding/signature');
});

test('buildTdf refuses a binding over other content, an RSA key with no OAEP hash and a key of another curve', async () => {
  const other = await labelled(LABEL, new TextEncoder().encode('other content'));
  assert.throws(() => buildTdf({ content: CONTENT, ...other, recipient: EC.recipient }), (error: unknown) => error instanceof TdfError && error.reason === 'label-binding');
  const parts = await labelled();
  const noHash: TdfRecipient = { ...RSA_SHA1.recipient };
  delete (noHash as Loose).oaepHash;
  assert.throws(() => buildTdf({ content: CONTENT, ...parts, recipient: noHash }), (error: unknown) => error instanceof TdfError && error.reason === 'unsupported');
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.throws(() => buildTdf({ content: CONTENT, ...parts, recipient: { ...EC.recipient, publicKey: p384 } }), (error: unknown) => error instanceof TdfError && error.reason === 'unsupported');
  // Public fixture with a 1024-bit modulus, used only to verify that export refuses it.
  const small = [
    '-----BEGIN PUBLIC KEY-----',
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQChnC9OtaK6MCOawfjlnP0XsjcF',
    'ixKx1cxVSD47EAhM+Fb5efSlXjyMocwJiPlOlrHy5jsQs/dCcscSKz5Nokwl9mSK',
    'fMapDiDk6+yQermvHZ1bqI2ouww5xR5/hF2ZOl1wK5b2iHajZADn1IqObrpFztdZ',
    'vXSC0rjtlq+WusrCswIDAQAB',
    '-----END PUBLIC KEY-----',
    ''
  ].join('\n');
  assert.throws(() => buildTdf({ content: CONTENT, ...parts, recipient: { ...RSA_SHA1.recipient, publicKey: small } }), (error: unknown) => error instanceof TdfError && error.reason === 'unsupported');
});

test('readTdfManifest reads the structure of the specification\'s example manifest and key access object', () => {
  const example = EXAMPLES.manifests[0].manifest as Loose;
  const read = readTdfManifest(example);
  assert.ok(read.ok, read.ok ? '' : read.message);
  if (read.ok) {
    assert.equal(read.value.specVersion, '1.0.0');
    assert.equal(read.value.keyAccess.length, 1);
    assert.equal(read.value.segments.length, 1);
  }
  // The key access example's wrappedKey is shortened with "..." in the text, so it is not Base64 and is refused; with a whole key it reads.
  const withKao = JSON.parse(JSON.stringify(example)) as Loose;
  withKao.encryptionInformation.keyAccess = [EXAMPLES.keyAccess[0].keyAccess];
  assert.equal(readTdfManifest(withKao).ok, false);
  withKao.encryptionInformation.keyAccess = [{ ...EXAMPLES.keyAccess[0].keyAccess, wrappedKey: example.encryptionInformation.keyAccess[0].wrappedKey }];
  assert.equal(readTdfManifest(withKao).ok, true);
  const unversioned = JSON.parse(JSON.stringify(example)) as Loose;
  delete unversioned.tdf_spec_version;
  const legacy = readTdfManifest(unversioned);
  assert.equal(legacy.ok ? 'ok' : legacy.reason, 'unsupported');
  for (const broken of [null, {}, { ...example, payload: { ...example.payload, isEncrypted: false } }]) assert.equal(readTdfManifest(broken).ok, false);
});

test('two key access objects, another segment hash algorithm and a broken file are refused without throwing', async () => {
  const object = await built();
  const two = copyOf(object);
  two.manifest.encryptionInformation.keyAccess.push(two.manifest.encryptionInformation.keyAccess[0]);
  assert.equal(await reasonOf(two), 'unsupported');
  const hs = copyOf(object);
  hs.manifest.encryptionInformation.integrityInformation.segmentHashAlg = 'HS256';
  assert.equal(await reasonOf(hs), 'unsupported');
  assert.equal(await reasonOf({ manifest: { payload: 1 } as Loose, payload: new Uint8Array(0) }), 'malformed');
  for (const sentence of Object.values(TDF_REFUSALS)) assert.ok(sentence.endsWith('.') && !/EXAMPLE|Protected/.test(sentence));
});

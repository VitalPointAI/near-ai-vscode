// An export is a release (Phase 45.1 plan 03 Task 2; D-04, D-05, D-11, XCHG-03). Partners, agreements, people and keys are fictional; the label table
// values are placeholders (EXAMPLE-...). The releasing person's credentials are built as already checked, as credentialsMayRelease does.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import test from 'node:test';
import { EDDSA_JCS_2022 } from '../domain/credentials/dataIntegrity';
import { factsFrom, factsFromAgreement, isCheckedFacts } from '../domain/credentials/mayRelease';
import type { CheckedCredential, CredentialFacts } from '../domain/credentials/mayRelease';
import type { VerifiedCredential } from '../domain/credentials/profile';
import { KNOWN_ARRIVAL_FORMATS, UNKNOWN_FORMAT_TEXT, readableArrival, tdfAdapter } from '../domain/exchange/adapter';
import { EXPORT_REFUSALS, canExport, isExportDecision } from '../domain/exchange/exportCheck';
import type { ExportContext, ExportDecision } from '../domain/exchange/exportCheck';
import { bindLabel, contentHashOf } from '../domain/exchange/labelBinding';
import type { LabelBinding } from '../domain/exchange/labelBinding';
import { TdfError, unwrapWithPrivateKey } from '../domain/exchange/tdf';
import type { TdfKeyAccess, TdfRecipient } from '../domain/exchange/tdf';
import type { Agreement } from '../domain/gate/agreementsSection';
import { parseLabelInteropSection } from '../domain/gate/labelInteropSection';
import type { LabelInteropTable } from '../domain/gate/labelInteropSection';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';

const NOW = Date.UTC(2026, 10, 25);
const ALEX = 'did:webvh:QmExampleScidOnlyForTestsQmExampleScidOnlyForT:example.org:people:alex';
const CONTENT = new TextEncoder().encode('Example released version: the sustainment annex, fictional.');
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SIGNER = 'org-release:hq';

function held(type: string, claims: Record<string, unknown>, validUntil = '2027-06-01T00:00:00Z'): CheckedCredential {
  const credential = Object.freeze({
    type, issuer: 'did:webvh:QmIssuer:example.org:people:officer', validFrom: '2026-01-01T00:00:00Z', validUntil, claims: Object.freeze({ id: ALEX, ...claims }),
    status: Object.freeze([]), suite: 'eddsa-jcs-2022', verificationMethod: 'did:webvh:QmIssuer:example.org:people:officer#issuing', credential: Object.freeze({})
  }) as unknown as VerifiedCredential;
  return { credential, status: 'clear' };
}

const RELEASER = factsFrom([held('ReleaseAuthorityCredential', { scope: 'organization' }), held('ClearanceCredential', { scale: 'ca-protected', atLeast: 'Protected B' })]);
const NOT_RELEASER = factsFrom([held('ClearanceCredential', { scale: 'ca-protected', atLeast: 'Protected B' })]);

const TABLE = ((): LabelInteropTable => {
  const parsed = parseLabelInteropSection({
    v: 1, version: 1,
    scales: {
      'ca-protected': {
        policy: 'EXAMPLE-POLICY-PROTECTED', levels: { 'Protected A': 'EXAMPLE-PA', 'Protected B': 'EXAMPLE-PB' },
        compartments: { CEO: { category: 'EXAMPLE-SPECIAL', value: 'EXAMPLE-CEO' } },
        releasableTo: { category: 'EXAMPLE-RELEASABLE-TO', values: { CAN: 'EXAMPLE-CAN', GBR: 'EXAMPLE-GBR' } }
      }
    }
  }, SCALE_PRESETS);
  assert.ok(parsed.ok);
  return parsed.value;
})();

const AGREEMENT: Agreement = Object.freeze({
  id: 'agreement-gbr-1', partner: 'Example Partner Organization', tokens: Object.freeze(['GBR']), levelCeiling: 'ca-protected/Protected B',
  compartments: Object.freeze([]), until: '2027-11-24T00:00:00.000Z'
});

const LABEL: Label = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: ['CAN', 'GBR'], handling: [] };

const CONTEXT: ExportContext = { releaser: RELEASER, table: TABLE, scales: SCALE_PRESETS, mappings: [], now: NOW };

function reason(label: Label = LABEL, agreement: Agreement | undefined = AGREEMENT, context: Partial<ExportContext> = {}): string {
  const check = canExport(label, agreement, { ...CONTEXT, ...context });
  return check.ok ? 'ok' : check.reason;
}

const RELEASE_KEY = ((): { sign: (bytes: Uint8Array) => Promise<Uint8Array>; publicKey: Uint8Array } => {
  const seed = createHash('sha256').update('export-test/release', 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return {
    sign: async (bytes) => new Uint8Array(edSign(null, Buffer.from(bytes), privateKey)),
    publicKey: new Uint8Array(Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url'))
  };
})();

const PARTNER = ((): { recipient: TdfRecipient; privateKey: string } => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    recipient: { url: 'https://kas.partner.example', kid: 'example-ec-1', alg: 'ec:secp256r1', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
})();

async function bound(label: Label, content: Uint8Array = CONTENT): Promise<LabelBinding> {
  return bindLabel({ verificationMethod: SIGNER, suite: EDDSA_JCS_2022, sign: RELEASE_KEY.sign },
    { label, mapping: TABLE.version, contentHash: contentHashOf(content), signer: SIGNER, time: '2026-11-25T10:00:00.000Z' });
}

function decided(label: Label = LABEL): ExportDecision {
  const check = canExport(label, AGREEMENT, CONTEXT);
  assert.ok(check.ok, check.ok ? '' : check.message);
  return check as ExportDecision;
}

const READ_OPTIONS = {
  decryptKey: async (access: TdfKeyAccess) => unwrapWithPrivateKey(access, PARTNER.privateKey),
  table: TABLE,
  bindingKey: (signer: string) => (signer === SIGNER ? RELEASE_KEY.publicKey : undefined)
};

test('a Protected B version releasable to CAN and GBR passes for a GBR agreement and a release authority, and leaves as a TDF object for the partner', async () => {
  const decision = decided();
  assert.ok(isExportDecision(decision));
  assert.equal(decision.agreement, 'agreement-gbr-1');
  assert.equal(decision.external.classification, 'EXAMPLE-PB');
  const object = tdfAdapter.export({ content: CONTENT, decision, binding: await bound(LABEL) }, PARTNER.recipient);
  assert.equal((object.manifest as Record<string, any>).encryptionInformation.keyAccess[0].kid, 'example-ec-1');
  const imported = await tdfAdapter.import(object, READ_OPTIONS);
  assert.ok(imported.ok, imported.ok ? '' : imported.message);
  if (!imported.ok) return;
  assert.deepEqual(Buffer.from(imported.value.content), Buffer.from(CONTENT));
  assert.deepEqual(JSON.parse(JSON.stringify(imported.value.label)), LABEL);
});

test('the partner\'s facts come from the agreement and go through the same mayRelease as every release', () => {
  const facts = factsFromAgreement(AGREEMENT);
  assert.ok(isCheckedFacts(facts));
  assert.deepEqual(JSON.parse(JSON.stringify(facts.thresholds)), [{ scale: 'ca-protected', level: 'Protected B' }]);
  assert.deepEqual([...facts.tokens], ['GBR']);
  assert.deepEqual([...facts.regimes], [], 'an agreement covers no export-controlled kind');
  assert.deepEqual([...facts.types], [], 'an agreement is not a credential');
});

test('refused: a label the table does not map, and no table at all', () => {
  assert.equal(reason({ ...LABEL, compartments: ['PROJECT_Z'] }, { ...AGREEMENT, compartments: ['PROJECT_Z'] }), 'no-mapping');
  assert.equal(reason(LABEL, AGREEMENT, { table: undefined }), 'no-table');
  assert.equal(reason({ ...LABEL, handling: ['no-agent-tools'] }), 'handling');
});

test('refused: the partner\'s token is not in the label\'s releasability, and an unrestricted label is not released abroad by default', () => {
  assert.equal(reason({ ...LABEL, releasability: ['CAN', 'USA'] }), 'not-releasable');
  assert.equal(reason({ ...LABEL, releasability: [] }), 'not-releasable');
});

test('refused: the agreement\'s ceiling is below the label, or its compartments do not cover the label', () => {
  assert.equal(reason(LABEL, { ...AGREEMENT, levelCeiling: 'ca-protected/Protected A' }), 'above-ceiling');
  assert.equal(reason({ ...LABEL, level: 'Protected C' }), 'above-ceiling');
  assert.equal(reason({ ...LABEL, compartments: ['CEO'] }), 'compartment-not-covered');
  assert.equal(reason({ ...LABEL, compartments: ['CEO'] }, { ...AGREEMENT, compartments: ['CEO'] }), 'ok');
});

test('refused: no agreement, and an agreement that has ended', () => {
  const none = canExport(LABEL, undefined, CONTEXT);
  assert.equal(none.ok ? 'ok' : none.reason, 'no-agreement');
  assert.equal(reason(LABEL, { ...AGREEMENT, until: '2026-11-24T00:00:00.000Z' }), 'agreement-ended');
});

test('refused: a releasing person without a verified ReleaseAuthorityCredential, including hand-built facts', () => {
  assert.equal(reason(LABEL, AGREEMENT, { releaser: NOT_RELEASER }), 'no-release-authority');
  const forged = { ...RELEASER } as CredentialFacts;
  assert.equal(reason(LABEL, AGREEMENT, { releaser: forged }), 'no-release-authority');
  const ended = factsFrom([held('ReleaseAuthorityCredential', { scope: 'organization' }, '2026-11-01T00:00:00Z')]);
  assert.equal(reason(LABEL, AGREEMENT, { releaser: ended }), 'no-release-authority');
});

test('refused: a CGP compartment (until Phase 45), even under an agreement that names it, and RELEASABLE-TO-NONE', () => {
  assert.equal(reason({ ...LABEL, compartments: ['CGP'] }, { ...AGREEMENT, compartments: ['CGP'] }), 'export-controlled');
  assert.equal(reason({ ...LABEL, compartments: ['ITAR'] }), 'export-controlled');
  assert.equal(reason({ ...LABEL, releasability: ['RELEASABLE-TO-NONE'] }), 'releasable-to-none');
  for (const sentence of Object.values(EXPORT_REFUSALS)) assert.ok(sentence.endsWith('.') && !/GBR|EXAMPLE|Protected|CGP/.test(sentence));
});

test('export needs a decision made by canExport, for the label its binding carries', async () => {
  const binding = await bound(LABEL);
  const copied = { ...decided() } as ExportDecision;
  assert.throws(() => tdfAdapter.export({ content: CONTENT, decision: copied, binding }, PARTNER.recipient), (error: unknown) => error instanceof TdfError);
  const otherLabel = await bound({ ...LABEL, level: 'Protected A' });
  assert.throws(() => tdfAdapter.export({ content: CONTENT, decision: decided(), binding: otherLabel }, PARTNER.recipient), (error: unknown) => error instanceof TdfError);
  const otherContent = await bound(LABEL, new TextEncoder().encode('other'));
  assert.throws(() => tdfAdapter.export({ content: CONTENT, decision: decided(), binding: otherContent }, PARTNER.recipient), (error: unknown) => error instanceof TdfError);
});

test('import: every arrival is quarantined with what arrived, what is kept and how it was converted; a broken binding is refused', async () => {
  const object = tdfAdapter.export({ content: CONTENT, decision: decided(), binding: await bound(LABEL) }, PARTNER.recipient);
  const imported = await tdfAdapter.import(object, READ_OPTIONS);
  assert.ok(imported.ok);
  if (!imported.ok) return;
  assert.equal(imported.value.state, 'quarantined');
  assert.equal(imported.value.arrived, 'tdf');
  assert.equal(imported.value.stored, 'cell');
  assert.equal(imported.value.conversion.converter, 'tdf');
  assert.ok(readableArrival(imported.value.arrived, imported.value.stored));
  const broken = JSON.parse(JSON.stringify(object.manifest)) as Record<string, any>;
  const statement = JSON.parse(broken.assertions[0].statement.value as string) as Record<string, any>;
  statement.binding.proof.proofValue = `${String(statement.binding.proof.proofValue).slice(0, -2)}11`;
  broken.assertions[0].statement.value = JSON.stringify(statement);
  const refused = await tdfAdapter.import({ manifest: broken, payload: object.payload }, READ_OPTIONS);
  assert.equal(refused.ok ? 'ok' : refused.reason, 'assertion', 'the assertion JWS covers the statement, so a changed binding is caught there first');
  // A binding broken before it was packed passes the assertion check and is refused by the label binding's own signature.
  const tampered = JSON.parse(JSON.stringify(await bound(LABEL))) as Record<string, any>;
  tampered.time = '2026-11-26T10:00:00.000Z';
  const packed = tdfAdapter.export({ content: CONTENT, decision: decided(), binding: tampered as unknown as LabelBinding }, PARTNER.recipient);
  const unsigned = await tdfAdapter.import(packed, READ_OPTIONS);
  assert.equal(unsigned.ok ? 'ok' : `${unsigned.reason}/${String(unsigned.bindingReason)}`, 'label-binding/signature');
});

test('version safety: an arrived or stored id this version does not know is never interpreted', () => {
  assert.deepEqual([...KNOWN_ARRIVAL_FORMATS], ['tdf']);
  for (const [arrived, stored] of [['ztdf-profile/1', 'cell'], ['bdo-4778', 'cell'], ['marked-file', 'cell'], ['unlabelled', 'cell'], ['tdf', 'cell+ztdf'], [undefined, 'cell']]) {
    assert.equal(readableArrival(arrived, stored), false, `${String(arrived)} ${String(stored)}`);
  }
  assert.equal(UNKNOWN_FORMAT_TEXT, 'Received in a format this version can\'t read; ask your administrator.');
});

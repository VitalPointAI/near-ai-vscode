// A small Example Organization for the Phase 71 checker tests: a root DID, an officer, a member, status-list keys and signed credentials and lists, all
// made at run time with fictional names. A helper with no `.test` suffix, so it registers no tests.
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { SCALE_PRESETS } from '../../domain/gate/labels';
import { parsePolicyDocument } from '../../domain/gate/policyDocument';
import type { CredentialsSection } from '../../domain/gate/credentialsSection';
import { CREDENTIAL_CONTEXTS } from '../../domain/credentials/context';
import type { CredentialSigner } from '../../domain/credentials/dataIntegrity';
import { encodePublicKeyMultibase } from '../../domain/credentials/multibase';
import { credentialHash, issueCredential } from '../../domain/credentials/profile';
import { buildStatusList, listHash, signStatusList } from '../../domain/credentials/statusList';
import type { IssuerDidState, IssuerPolicy } from '../../domain/credentials/issuerAuthority';
import { buildGenesisEntry, verifyWebvhLog } from '../../domain/did/didWebvh';
import type { WebvhState } from '../../domain/did/didWebvh';
import { deviceKey, policyDocumentFor } from './policyFixtures';

export interface Key { multikey: string; did: string; signer: CredentialSigner }

export function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const multikey = encodePublicKeyMultibase('Ed25519', new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
  const did = `did:key:${multikey}`;
  return { multikey, did, signer: { verificationMethod: `${did}#${multikey}`, suite: 'eddsa-jcs-2022', sign: async (bytes) => new Uint8Array(cryptoSign(null, bytes, privateKey)) } };
}

export interface Person { did: string; issuing: Key; method: string; state: WebvhState; signer: CredentialSigner; /** The did:webvh log, for a host that serves it. */ log: string }

function document(assertionKey: string): (did: string) => Record<string, unknown> {
  return (did) => ({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: did, controller: did,
    verificationMethod: [{ id: `${did}#issuing`, type: 'Multikey', controller: did, publicKeyMultibase: assertionKey }],
    authentication: [`${did}#issuing`], assertionMethod: [`${did}#issuing`]
  });
}

export async function person(path: string[], issuing: Key = newKey()): Promise<Person> {
  const update = newKey();
  const genesis = await buildGenesisEntry({ domain: 'hq.example.org', path, updateKeys: [update.multikey], portable: true, versionTime: '2026-01-01T00:00:00Z', document: document(issuing.multikey) }, update.signer);
  const result = verifyWebvhLog(genesis.line, { now: Date.UTC(2026, 10, 24) });
  if (!result.ok) throw new Error(result.reason);
  const method = `${genesis.did}#issuing`;
  return { did: genesis.did, issuing, method, state: result.state, signer: { ...issuing.signer, verificationMethod: method }, log: `${genesis.line}\n` };
}

export const REVOCATIONS = 'https://hq.example.org/v1/trust/status/revocation-1';
export const SUSPENSIONS = 'https://hq.example.org/v1/trust/status/suspension-1';

export interface World {
  root: Person; officer: Person; member: Person; other: Person;
  revocationKey: Key; suspensionKey: Key;
  section: CredentialsSection; policy: IssuerPolicy; didState: IssuerDidState;
}

export async function makeWorld(requiredBySensitivity: Record<string, string[]> = {}): Promise<World> {
  const [root, officer, member, other] = await Promise.all([person(['org']), person(['people', 'alex']), person(['people', 'sam']), person(['people', 'kim'])]);
  const revocationKey = newKey();
  const suspensionKey = newKey();
  const doc = JSON.parse(JSON.stringify(policyDocumentFor({ key: deviceKey() }))) as Record<string, any>;
  doc.credentials = {
    v: 1, root: { did: root.did, scid: root.state.scid },
    issuance: {
      ClearanceCredential: { role: 'IssuerRoleCredential', ceiling: { scale: 'ca-classified', upTo: 'Secret' } },
      NationalityCredential: { role: 'IssuerRoleCredential' }, CompartmentCredential: { role: 'IssuerRoleCredential' },
      ServiceCredential: { role: 'IssuerRoleCredential' }, ExportEligibilityCredential: { role: 'IssuerRoleCredential' },
      AccessAgreementCredential: { role: 'IssuerRoleCredential' }
    },
    suites: ['ecdsa-jcs-2019', 'eddsa-jcs-2022'], didMethods: ['did:key', 'did:webvh'],
    statusLists: [{ uri: REVOCATIONS, purpose: 'revocation', key: revocationKey.multikey }, { uri: SUSPENSIONS, purpose: 'suspension', key: suspensionKey.multikey }],
    statusTtl: 900, maxOfflineAge: { 'ca-protected/Protected B': 72 * 3600, 'ca-classified/Secret': 24 * 3600 }, requiredBySensitivity
  };
  doc.requires = [...doc.requires, 'credentials@1'].sort();
  const parsed = parsePolicyDocument(doc);
  if (!parsed.ok) throw new Error(parsed.message);
  const section = parsed.value.credentials as CredentialsSection;
  const states: Record<string, WebvhState> = {};
  for (const p of [root, officer, member, other]) states[p.did] = p.state;
  return { root, officer, member, other, revocationKey, suspensionKey, section, policy: { section, scales: SCALE_PRESETS }, didState: { states } };
}

let nextIndex = 1000;
export interface Issued { credential: Record<string, unknown>; hash: string; revocationIndex: number; suspensionIndex: number }

export async function issue(signer: CredentialSigner, issuer: string, type: string, subject: Record<string, unknown>, dates: { validFrom?: string; validUntil?: string } = {}): Promise<Issued> {
  const revocationIndex = nextIndex++;
  const suspensionIndex = nextIndex++;
  const credential = await issueCredential(signer, {
    '@context': [...CREDENTIAL_CONTEXTS], type: ['VerifiableCredential', type], issuer,
    validFrom: dates.validFrom ?? '2026-03-01T00:00:00Z', validUntil: dates.validUntil ?? '2027-03-01T00:00:00Z', credentialSubject: subject,
    credentialStatus: [
      { type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: String(revocationIndex), statusListCredential: REVOCATIONS },
      { type: 'BitstringStatusListEntry', statusPurpose: 'suspension', statusListIndex: String(suspensionIndex), statusListCredential: SUSPENSIONS }
    ]
  }, 'eddsa-jcs-2022', { scales: SCALE_PRESETS });
  return { credential, hash: credentialHash(credential), revocationIndex, suspensionIndex };
}

export interface SignedList { credential: Record<string, unknown>; hash: string; id: string; validFrom: string }

export async function list(key: Key, id: string, purpose: 'revocation' | 'suspension', set: readonly number[] = [], options: { version?: number; validFrom?: string; validUntil?: string } = {}): Promise<SignedList> {
  const bits = new Uint8Array(131_072 / 8);
  for (const index of set) bits[index >> 3] = (bits[index >> 3] as number) | (0x80 >> (index & 7));
  const validFrom = options.validFrom ?? '2026-11-20T00:00:00Z';
  const credential = await signStatusList(key.signer, buildStatusList({
    id, issuer: key.did, purpose, version: options.version ?? 1, validFrom, validUntil: options.validUntil ?? '2026-11-27T00:00:00Z', bits
  }), 'eddsa-jcs-2022');
  return { credential, hash: listHash(credential), id, validFrom };
}

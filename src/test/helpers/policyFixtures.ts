// Fixtures for policy bundle v2 (Phase 41): deterministic Ed25519 keys made at test time from a label, a fixed clock, the starting rules as a v2 document,
// a document with every section and optional key, and the one signer for each layer. Fictional names only; no key material is written in this file.
// The key technique (a PKCS8 prefix and a seed from SHA-256 of a label) is copied from replicaWorld's fixedSigner, not imported, so the gate's tests stay
// apart from the replica helpers.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { defaultBundlePayload } from '../../domain/gate/bundle';
import { documentFromBundle } from '../../domain/gate/policyDocument';
import type { PolicyDocument, PolicyLayerName } from '../../domain/gate/policyDocument';
import { fingerprintOf } from '../../domain/team/canonical';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { signPayload } from '../../domain/team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../../domain/team/signedPayload';

/** 2026-11-20T00:00:00.000Z, the clock every Phase 41 fixture uses. */
export const FIXED_NOW = Date.parse('2026-11-20T00:00:00.000Z');
export const DAY_MS = 24 * 60 * 60 * 1000;

// The 16-byte PKCS8 header of an Ed25519 private key; the 32-byte seed follows it.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyFor(label: string): PayloadSigner {
  const seed = createHash('sha256').update(`policy-fixture/${label}`, 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  return { fingerprint: fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
}

/** Your organization's issuer key in a test: the same key for the same label on every run. */
export function issuerKey(label = 'organization-issuer'): PayloadSigner {
  return keyFor(`issuer/${label}`);
}

/** This device's key in a test: the same key for the same label on every run. */
export function deviceKey(label = 'this-device'): PayloadSigner {
  return keyFor(`device/${label}`);
}

/** A key source that knows exactly these keys as active (fingerprint and public key both match) and nothing else. */
export function activeKeys(...signers: PayloadSigner[]): KeyStatusLookup {
  return (key) => (signers.some((signer) => signer.fingerprint === key.fingerprint && signer.publicKey === key.publicKey) ? { state: 'active' } : { state: 'unknown' });
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface PolicyDocumentOptions {
  readonly key: PayloadSigner;
  readonly layer?: PolicyLayerName;
  readonly now?: number;
}

/** The starting rules as a v2 document issued by `key` at `now` (FIXED_NOW by default): documentFromBundle of the default payload, with the layer set. */
export function policyDocumentFor(options: PolicyDocumentOptions): PolicyDocument {
  const bundle = defaultBundlePayload({ issuer: { fingerprint: options.key.fingerprint, publicKey: options.key.publicKey }, now: options.now ?? FIXED_NOW });
  const document = documentFromBundle(bundle);
  if (options.layer === undefined || options.layer === document.layer) return document;
  return Object.freeze({ ...document, layer: options.layer });
}

export interface FullDocumentOptions {
  readonly layer?: PolicyLayerName;
}

/**
 * A plain (JSON) document with every section and every optional key the parsers accept, issued by `key`. Your organization's layer by default (no
 * parent); a personal or project layer names a parent. 41-02 enumerates the accepted keys from it.
 */
export function fullDocumentFor(key: PayloadSigner, options: FullDocumentOptions = {}): Record<string, unknown> {
  const layer = options.layer ?? 'organization';
  const base = plain(policyDocumentFor({ key })) as unknown as Record<string, any>;
  const document: Record<string, any> = {
    ...base,
    layer,
    minClient: '0.4.40',
    requires: ['agents@1', 'endpoints@1', 'labels@1', 'layers@1', 'models@1', 'people@1'],
    labels: { ...base['labels'], routing: { ...base['labels'].routing, compartments: { ...base['labels'].routing.compartments, PROJECT_X: 'attested-cloud' } } },
    agents: {
      ...base['agents'],
      mcp: { unattended: ['git'], labelCeilings: { git: { scale: 'org', level: 'Internal', compartments: [], releasability: [] } } },
      requireAccreditedDevice: true
    },
    endpoints: fixtureEndpoints(),
    models: { v: 1 },
    people: { v: 1, clearances: base['people'].clearances },
    reserved: { v: 1, anchorRoots: [{ root: 'a'.repeat(64), proof: ['b'.repeat(64)] }], statusLists: [{ uri: 'https://status.example.org/list', purpose: 'revocation' }], maxOfflineAge: { 'org/Restricted': 86400 } }
  };
  if (layer !== 'organization') document['parent'] = { hash: 'c'.repeat(64), issuer: issuerKey().fingerprint };
  return document;
}

/** One endpoint of every class, sorted by id, each at the highest ceiling its class and host may hold (fictional hosts). */
export function fixtureEndpoints(): Array<Record<string, unknown>> {
  return [
    { id: 'closed-api', class: 'closed-api', host: 'api.example.com', scheme: 'https', tlsPins: [], region: 'US', maxLabel: ['org/Public'] },
    { id: 'enclave-example-org', class: 'org-tee', host: 'enclave.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['ca-protected/Protected B', 'nato/NATO Restricted', 'org/Restricted'], attestation: 'org-tee-v1' },
    { id: 'forwarder', class: 'forwarded', host: 'router.example.com', scheme: 'https', tlsPins: [], region: 'unstated', maxLabel: ['org/Public'] },
    { id: 'lab-example-org', class: 'org-plain', host: '*.lab.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Restricted'] },
    { id: 'laptop', class: 'local', host: 'localhost', scheme: 'http-loopback', tlsPins: [], region: 'CA', maxLabel: ['ca-classified/Top Secret', 'ca-protected/Protected C', 'nato/Cosmic Top Secret', 'org/Restricted'], provider: 'ollama' },
    { id: 'models-example-org', class: 'org-plain', host: 'models.example.org', scheme: 'https', tlsPins: ['d'.repeat(64), 'e'.repeat(64)], region: 'CA', maxLabel: ['ca-protected/Protected B', 'nato/NATO Restricted', 'org/Restricted'] },
    { id: 'nearai-private', class: 'nearai-tee', host: 'private.example.net', scheme: 'https', tlsPins: [], region: 'US', maxLabel: ['ca-protected/Protected B', 'org/Confidential'], provider: 'nearai' },
    { id: 'vendor-enclave', class: 'vendor-tee', host: 'enclave.example.net', scheme: 'https', tlsPins: [], region: 'EU', maxLabel: ['ca-protected/Protected B', 'org/Confidential'], attestation: 'vendor-tee-v1' },
    { id: 'vendor-region', class: 'vendor-region', host: 'ca.example.net', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['ca-protected/Protected A', 'org/Internal'], provider: 'example' }
  ];
}

/** The personal layer signed by this device with the one signer (purpose policy-bundle), at the document's own issuedAt (D-12's repeat check). */
export function signPersonalLayer(doc: PolicyDocument | Record<string, unknown>, key: PayloadSigner): SignedPayload {
  return signPayload(key, 'policy-bundle', doc, { now: () => new Date(String((doc as { issuedAt: string }).issuedAt)) });
}

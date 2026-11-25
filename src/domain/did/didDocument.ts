// The minimal DID document (Phase 71, PROJECT decision 8, DLGT-01): a DID document from either method holds only id, controller, verificationMethod,
// authentication, assertionMethod and service, plus the JSON-LD @context of its representation. A document carries no authority: whatever a DID may
// do comes from credentials naming it, so any other member (keyAgreement, alsoKnownAs, the spike's agentGuardrails, ...) is refused here rather than
// ignored. Pure: no I/O, no clock, no package.
//
// Verification methods are Multikey only (Ed25519, and P-256 for the strict-FIPS fallback of O8), each with exactly id, type, controller and
// publicKeyMultibase. A relationship lists ids of methods in the same document; an embedded method in a relationship is refused, so a key is always
// named once.
import { MultibaseError, decodePublicKeyMultibase } from '../credentials/multibase';
import type { MultikeyPublicKey } from '../credentials/multibase';

export const DID_CORE_CONTEXT = 'https://www.w3.org/ns/did/v1';
export const DID_DOCUMENT_MEMBERS = Object.freeze(['@context', 'id', 'controller', 'verificationMethod', 'authentication', 'assertionMethod', 'service'] as const);
export const VERIFICATION_RELATIONSHIPS = Object.freeze(['authentication', 'assertionMethod'] as const);
export type VerificationRelationship = (typeof VERIFICATION_RELATIONSHIPS)[number];

const METHOD_MEMBERS = ['id', 'type', 'controller', 'publicKeyMultibase'];
const SERVICE_MEMBERS = ['id', 'type', 'serviceEndpoint'];
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const MAX_METHODS = 32;
const MAX_SERVICES = 16;
const MAX_TEXT = 2048;

export const DID_DOCUMENT_FAILURES = {
  'not-an-object': 'This DID document is not one JSON object.',
  'unknown-member': 'This DID document has a part a DID document here may not have.',
  'bad-id': 'The DID document\'s id is not the DID it was read for.',
  'bad-controller': 'The DID document\'s controller is not a DID.',
  'bad-context': 'The DID document\'s @context does not start with the DID context.',
  'bad-method': 'A verification method is not a Multikey with exactly an id, type, controller and key.',
  'bad-relationship': 'An authentication or assertion entry does not name a verification method of this document.',
  'bad-service': 'A service is not an id, a type and an address.'
} as const;
export type DidDocumentFailure = keyof typeof DID_DOCUMENT_FAILURES;

export interface VerificationMethod {
  readonly id: string;
  readonly type: 'Multikey';
  readonly controller: string;
  readonly publicKeyMultibase: string;
  readonly publicKey: MultikeyPublicKey;
}

export interface DidDocument {
  readonly id: string;
  readonly controller?: readonly string[];
  readonly verificationMethod: readonly VerificationMethod[];
  readonly authentication: readonly string[];
  readonly assertionMethod: readonly string[];
  readonly service: readonly { readonly id: string; readonly type: string; readonly serviceEndpoint: string }[];
}

export type DidDocumentResult = { readonly ok: true; readonly document: DidDocument } | { readonly ok: false; readonly reason: DidDocumentFailure; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function refuse(reason: DidDocumentFailure): DidDocumentResult {
  return { ok: false, reason, message: DID_DOCUMENT_FAILURES[reason] };
}

export function isDidString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT && DID.test(value);
}

function readMethod(value: unknown, documentId: string): VerificationMethod | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== METHOD_MEMBERS.length || !keys.every((key) => METHOD_MEMBERS.includes(key))) return undefined;
  const id = own(value, 'id');
  const controller = own(value, 'controller');
  const multibase = own(value, 'publicKeyMultibase');
  if (own(value, 'type') !== 'Multikey' || typeof id !== 'string' || !id.startsWith(`${documentId}#`) || id.length > MAX_TEXT) return undefined;
  if (!isDidString(controller) || typeof multibase !== 'string') return undefined;
  try {
    const publicKey = decodePublicKeyMultibase(multibase);
    return Object.freeze({ id, type: 'Multikey', controller, publicKeyMultibase: multibase, publicKey: Object.freeze(publicKey) });
  } catch (error) {
    if (error instanceof MultibaseError) return undefined;
    throw error;
  }
}

function readRelationship(value: unknown, methodIds: readonly string[]): readonly string[] | undefined {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_METHODS) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !methodIds.includes(entry) || out.includes(entry)) return undefined;
    out.push(entry);
  }
  return Object.freeze(out);
}

/**
 * Reads a DID document in the minimal shape. With `expectedId`, the document must be that DID's. Returns frozen data with each method's decoded key;
 * never throws.
 */
export function readDidDocument(value: unknown, expectedId?: string): DidDocumentResult {
  if (!isRecord(value)) return refuse('not-an-object');
  for (const key of Object.keys(value)) if (!(DID_DOCUMENT_MEMBERS as readonly string[]).includes(key)) return refuse('unknown-member');
  const id = own(value, 'id');
  if (!isDidString(id) || (expectedId !== undefined && id !== expectedId)) return refuse('bad-id');
  const context = own(value, '@context');
  if (context !== undefined) {
    const list = typeof context === 'string' ? [context] : context;
    if (!Array.isArray(list) || list.length === 0 || list[0] !== DID_CORE_CONTEXT || !list.every((entry) => typeof entry === 'string')) return refuse('bad-context');
  }
  const rawController = own(value, 'controller');
  let controller: readonly string[] | undefined;
  if (rawController !== undefined) {
    const list = typeof rawController === 'string' ? [rawController] : rawController;
    if (!Array.isArray(list) || list.length === 0 || !list.every(isDidString)) return refuse('bad-controller');
    controller = Object.freeze([...list]);
  }
  const rawMethods = own(value, 'verificationMethod') ?? [];
  if (!Array.isArray(rawMethods) || rawMethods.length > MAX_METHODS) return refuse('bad-method');
  const methods: VerificationMethod[] = [];
  for (const raw of rawMethods) {
    const method = readMethod(raw, id);
    if (method === undefined || methods.some((other) => other.id === method.id)) return refuse('bad-method');
    methods.push(method);
  }
  const methodIds = methods.map((method) => method.id);
  const authentication = readRelationship(own(value, 'authentication'), methodIds);
  const assertionMethod = readRelationship(own(value, 'assertionMethod'), methodIds);
  if (authentication === undefined || assertionMethod === undefined) return refuse('bad-relationship');
  const rawServices = own(value, 'service') ?? [];
  if (!Array.isArray(rawServices) || rawServices.length > MAX_SERVICES) return refuse('bad-service');
  const service: Array<{ id: string; type: string; serviceEndpoint: string }> = [];
  for (const raw of rawServices) {
    if (!isRecord(raw) || Object.keys(raw).length !== SERVICE_MEMBERS.length || !Object.keys(raw).every((key) => SERVICE_MEMBERS.includes(key))) return refuse('bad-service');
    const entry = { id: own(raw, 'id'), type: own(raw, 'type'), serviceEndpoint: own(raw, 'serviceEndpoint') };
    if (typeof entry.id !== 'string' || !entry.id.startsWith(`${id}#`) || typeof entry.type !== 'string' || typeof entry.serviceEndpoint !== 'string') return refuse('bad-service');
    if (entry.id.length > MAX_TEXT || entry.type.length > MAX_TEXT || entry.serviceEndpoint.length > MAX_TEXT) return refuse('bad-service');
    service.push(Object.freeze(entry as { id: string; type: string; serviceEndpoint: string }));
  }
  return {
    ok: true,
    document: Object.freeze({
      id, ...(controller === undefined ? {} : { controller }), verificationMethod: Object.freeze(methods), authentication, assertionMethod, service: Object.freeze(service)
    })
  };
}

/** The verification methods a document names for one relationship (assertionMethod for issuing, authentication for signing in), in its order. */
export function verificationMethodsOf(document: DidDocument, relationship: VerificationRelationship = 'assertionMethod'): readonly VerificationMethod[] {
  const ids = document[relationship];
  return Object.freeze(document.verificationMethod.filter((method) => ids.includes(method.id)));
}

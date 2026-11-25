// The signed label binding (Phase 45.1, D-03, XCHG-02): a label tied to the content it marks, so a receiver can check that the label belongs to the content
// and that neither changed. The ADatP-4778 idea (section 2, cited only) in our own JSON form; Phase 45.2 writes the same facts as a 4778 binding object.
// Pure: node:crypto for SHA-256 only (through dataIntegrity.ts for the proof); no I/O, no clock, no vscode, no package.
//
// A binding never carries a person DID or a person key, and is never signed with a person key, because observers see no staff identity (33.1 D-27,
// D-35). The signer is one of two forms only: `session:<writer>`, the certified staff session key that already signs the release copy, or
// `org-release:<site>`, your organization's release key for exports to partners. The binding holds no public key either: the caller passes the key it
// already trusts for that signer. The releasing person's identity stays in your organization's own log.
import { createHash } from 'node:crypto';
import { DataIntegrityError, EDDSA_JCS_2022, createProof, verifyProof } from '../credentials/dataIntegrity';
import type { CredentialSigner, DataIntegrityProof } from '../credentials/dataIntegrity';
import { HANDLING_FLAGS, LABEL_TOKEN_PATTERN, parseLabel } from '../gate/labels';
import type { Label, ScaleTable } from '../gate/labels';
import { parseIsoMillis } from '../gate/shape';

/** The binding's format: permanent once a shared log holds one. */
export const LABEL_BINDING_FORMAT = 'label-binding/1';
/** The proof purpose of a binding, so a binding's proof is never read as a credential's. */
export const LABEL_BINDING_PURPOSE = 'assertionMethod';

/** The only signer forms (D-03, coordinator check B6). */
export const LABEL_BINDING_SIGNER_FORMS = Object.freeze(['session', 'org-release'] as const);
export type LabelBindingSignerForm = (typeof LABEL_BINDING_SIGNER_FORMS)[number];

const SESSION_SIGNER = /^session:[A-Za-z0-9_-]{1,64}$/;
const ORG_RELEASE_SIGNER = /^org-release:[a-z0-9][a-z0-9-]{0,62}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_MAPPING = 2_147_483_647;
const MAX_NAME = 64;
// Control characters: C0, DEL and C1.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** What is bound. `mapping` is the labelInterop version an export was written with, or 0 for a release copy that never leaves your organization's form. */
export interface LabelBindingFacts {
  readonly label: Label;
  readonly mapping: number;
  /** SHA-256 of the content, lowercase hex. */
  readonly contentHash: string;
  /** `session:<writer>` or `org-release:<site>`. */
  readonly signer: string;
  /** `YYYY-MM-DDTHH:MM:SS.sssZ`, the caller's clock. */
  readonly time: string;
}

export interface LabelBinding extends LabelBindingFacts {
  readonly format: typeof LABEL_BINDING_FORMAT;
  readonly proof: DataIntegrityProof;
}

export const LABEL_BINDING_REFUSALS = Object.freeze({
  'malformed': 'This label binding is not in a form this version can read.',
  'signer-form': 'This label binding was not signed by a staff session key or your organization\'s release key, so it is not accepted.',
  'wrong-signer': 'This label binding was signed by another key than the one expected.',
  'content-changed': 'The content does not match its label binding, so it was changed after it was bound.',
  'label-changed': 'The label does not match its label binding, so it was changed after it was bound.',
  'mapping-version': 'This label binding was made with another version of your organization\'s table for allies.',
  'signature': 'The label binding\'s signature does not match, so the label, the time or the binding was changed, or another key made it.'
} as const);
export type LabelBindingRefusal = keyof typeof LABEL_BINDING_REFUSALS;

export class LabelBindingError extends Error {
  public readonly reason: LabelBindingRefusal;

  public constructor(reason: LabelBindingRefusal) {
    super(LABEL_BINDING_REFUSALS[reason]);
    this.name = 'LabelBindingError';
    this.reason = reason;
  }
}

export type LabelBindingVerdict =
  | { readonly ok: true; readonly label: Label; readonly binding: LabelBinding }
  | { readonly ok: false; readonly reason: LabelBindingRefusal; readonly message: string };

function refuse(reason: LabelBindingRefusal): { readonly ok: false; readonly reason: LabelBindingRefusal; readonly message: string } {
  return Object.freeze({ ok: false, reason, message: LABEL_BINDING_REFUSALS[reason] });
}

/** The form of a signer field, or undefined when it is anything else (a DID, a key, an empty text). */
export function signerFormOf(signer: unknown): LabelBindingSignerForm | undefined {
  if (typeof signer !== 'string') return undefined;
  if (SESSION_SIGNER.test(signer)) return 'session';
  if (ORG_RELEASE_SIGNER.test(signer)) return 'org-release';
  return undefined;
}

/** SHA-256 of the content, lowercase hex: the binding's contentHash. */
export function contentHashOf(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME && !CONTROL.test(value);
}

/**
 * A label read by its shape alone (the binding is checked without the policy's scales): scale and level are short texts, tokens sorted and unique, handling
 * flags known. Built on parseLabel with a one-level table, so the token rules stay those of the label module.
 */
function readLabel(value: unknown): Label | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const scale = Object.prototype.hasOwnProperty.call(record, 'scale') ? record['scale'] : undefined;
  const level = Object.prototype.hasOwnProperty.call(record, 'level') ? record['level'] : undefined;
  if (!isName(scale) || !isName(level)) return undefined;
  const scales: Record<string, unknown> = {};
  Object.defineProperty(scales, scale, { value: { name: scale, levels: [level] }, enumerable: true });
  const parsed = parseLabel(value, scales as ScaleTable);
  if (!parsed.ok) return undefined;
  const tokens = [...parsed.value.compartments, ...parsed.value.releasability];
  if (!tokens.every((token) => LABEL_TOKEN_PATTERN.test(token))) return undefined;
  if (!parsed.value.handling.every((flag) => (HANDLING_FLAGS as readonly string[]).includes(flag))) return undefined;
  return parsed.value;
}

function readFacts(value: unknown): LabelBindingFacts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const get = (key: string): unknown => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
  const label = readLabel(get('label'));
  const mapping = get('mapping');
  const contentHash = get('contentHash');
  const signer = get('signer');
  const time = get('time');
  if (label === undefined) return undefined;
  if (typeof mapping !== 'number' || !Number.isSafeInteger(mapping) || mapping < 0 || mapping > MAX_MAPPING) return undefined;
  if (typeof contentHash !== 'string' || !HEX_64.test(contentHash)) return undefined;
  if (typeof signer !== 'string' || typeof time !== 'string' || Number.isNaN(parseIsoMillis(time))) return undefined;
  return { label, mapping, contentHash, signer, time };
}

function unsignedOf(facts: LabelBindingFacts): Record<string, unknown> {
  const label = facts.label;
  return {
    format: LABEL_BINDING_FORMAT,
    label: { scale: label.scale, level: label.level, compartments: [...label.compartments], releasability: [...label.releasability], handling: [...label.handling] },
    mapping: facts.mapping,
    contentHash: facts.contentHash,
    signer: facts.signer,
    time: facts.time
  };
}

/**
 * Signs a label binding with eddsa-jcs-2022 through the Phase 71 signer. Refuses, before the signer is called, a signer field of any other form than the
 * two (a did:webvh, a did:key, anything else), a signer whose verification method is not that field, a signer of another suite, and facts that do not
 * read. Throws LabelBindingError.
 */
export async function bindLabel(signer: CredentialSigner, facts: LabelBindingFacts): Promise<LabelBinding> {
  if (signerFormOf(facts.signer) === undefined) throw new LabelBindingError('signer-form');
  if (signer.verificationMethod !== facts.signer || signer.suite !== EDDSA_JCS_2022) throw new LabelBindingError('signer-form');
  const read = readFacts(facts);
  if (read === undefined) throw new LabelBindingError('malformed');
  const unsigned = unsignedOf(read);
  let proof: DataIntegrityProof;
  try {
    proof = await createProof(unsigned, { proofPurpose: LABEL_BINDING_PURPOSE }, signer);
  } catch (error) {
    if (error instanceof DataIntegrityError) throw new LabelBindingError(error.reason === 'bad-signature' ? 'signature' : 'malformed');
    throw error;
  }
  return Object.freeze({ ...(unsigned as unknown as LabelBindingFacts), format: LABEL_BINDING_FORMAT, proof }) as LabelBinding;
}

export interface VerifyLabelBindingOptions {
  /** The raw 32-byte Ed25519 public key of the signer, which the caller already trusts (the stream's session key, or the release key). */
  readonly publicKey: Uint8Array;
  /** The signer the caller expects, when it knows one. */
  readonly signer?: string;
  /** The mapping version the caller reads with. */
  readonly mapping?: number;
  /** The label the caller was shown beside the content (a TDF policy's label read back, a release copy's label). */
  readonly label?: Label;
}

function sameLabel(a: Label, b: Label): boolean {
  const list = (x: readonly string[]): string => JSON.stringify([...x]);
  return a.scale === b.scale && a.level === b.level && list(a.compartments) === list(b.compartments) && list(a.releasability) === list(b.releasability)
    && list(a.handling) === list(b.handling);
}

/**
 * Checks a label binding against the content it marks and the signer's key, and returns the bound label. Refused, each with its reason: a binding that
 * does not read, a signer of another form or not the expected one, another mapping version, a label other than the one shown, a content that changed, and
 * a signature that does not match (a changed label, time or binding, or another key). Never throws.
 */
export function verifyLabelBinding(value: unknown, content: Uint8Array, options: VerifyLabelBindingOptions): LabelBindingVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse('malformed');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['contentHash', 'format', 'label', 'mapping', 'proof', 'signer', 'time'])) return refuse('malformed');
  if (record['format'] !== LABEL_BINDING_FORMAT) return refuse('malformed');
  const facts = readFacts(record);
  if (facts === undefined) return refuse('malformed');
  if (signerFormOf(facts.signer) === undefined) return refuse('signer-form');
  if (options.signer !== undefined && options.signer !== facts.signer) return refuse('wrong-signer');
  const proof = record['proof'];
  if (typeof proof !== 'object' || proof === null || (proof as Record<string, unknown>)['verificationMethod'] !== facts.signer) return refuse('signature');
  const verdict = verifyProof(record, options.publicKey, { proofPurpose: LABEL_BINDING_PURPOSE });
  if (!verdict.ok) return refuse(verdict.reason === 'not-canonical' ? 'malformed' : 'signature');
  if (options.mapping !== undefined && options.mapping !== facts.mapping) return refuse('mapping-version');
  if (options.label !== undefined && !sameLabel(options.label, facts.label)) return refuse('label-changed');
  if (!(content instanceof Uint8Array) || contentHashOf(content) !== facts.contentHash) return refuse('content-changed');
  return { ok: true, label: facts.label, binding: Object.freeze({ ...facts, format: LABEL_BINDING_FORMAT, proof: verdict.proof }) as LabelBinding };
}

// Data schemas for the personnel family (Phase 33.1, D-19, D-43). Hub-side: pure, no Yjs; it must not import kinds.ts.
//
// These entries live only in the personnel key group, sealed to the ordering tasker and their authority chain (33.1-06). They are not roster kinds,
// so they are never in BASE_CELL_KINDS: a report-unable reason or an order reference never reaches the base roster, a log line, a refusal text,
// presence, an export, the compliance evidence or portfolio supply.
//
// - posting.unable { posting, report, sealed }: report is the posted person's own report, signed by the key posting.enrol bound to that posting, and it
//   carries no reason (its payload names the posting only), so posting.decide can cite its hash in the base roster. sealed is the reason, sealed to
//   the tasker and their authority chain: opaque here; once opened, unableReasonProblem checks it ({ reason, text? }, text at most 500 characters).
// - posting.reference { posting, sealed }: the order reference, sealed the same way.
// The report envelope's purpose, staff-posting-unable, joins the signed payload purposes when 33.1-06 signs and verifies it.
import { isRecord } from '../../team/validate';
import { isLine, keyProblem, slugCheck, validateShape } from './project';
import type { Check, Shape } from './project';
import { invalidAt, isBase64urlBytes, isIsoTime } from './shared';

export const UNABLE_REASONS = ['medical', 'compassionate', 'conflicting-tasking', 'not-qualified', 'not-cleared', 'other'] as const;
export const UNABLE_TEXT_MAX = 500;
export const UNABLE_REPORT_PURPOSE = 'staff-posting-unable';
// The sealed reason: its JSON with at most 500 characters of text (up to 4 bytes each), plus the seal's nonce and tag.
const UNABLE_SEALED_MAX_BYTES = 4096;
const REFERENCE_SEALED_MAX_BYTES = 2048;
const ED25519_PUBLIC_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

const sealedCheck = (max: number): Check => (value, path) => (isBase64urlBytes(value, max) ? undefined : invalidAt(path));

// The person's signed report, which names the posting and nothing else.
function reportProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  const keys = keyProblem(value, path, ['v', 'purpose', 'signer', 'signedAt', 'payload', 'sig']);
  if (keys !== undefined) return keys;
  if (value.v !== 1) return invalidAt(`${path}.v`);
  if (value.purpose !== UNABLE_REPORT_PURPOSE) return invalidAt(`${path}.purpose`);
  const signer = value.signer;
  if (!isRecord(signer)) return invalidAt(`${path}.signer`);
  const signerKeys = keyProblem(signer, `${path}.signer`, ['fingerprint', 'publicKey']);
  if (signerKeys !== undefined) return signerKeys;
  if (!isLine(signer.fingerprint, 128)) return invalidAt(`${path}.signer.fingerprint`);
  if (!isBase64urlBytes(signer.publicKey, ED25519_PUBLIC_BYTES)) return invalidAt(`${path}.signer.publicKey`);
  if (!isIsoTime(value.signedAt)) return invalidAt(`${path}.signedAt`);
  const payload = value.payload;
  if (!isRecord(payload)) return invalidAt(`${path}.payload`);
  const payloadKeys = keyProblem(payload, `${path}.payload`, ['posting']);
  if (payloadKeys !== undefined) return payloadKeys;
  const posting = slugCheck(payload.posting, `${path}.payload.posting`);
  if (posting !== undefined) return posting;
  return isBase64urlBytes(value.sig, ED25519_SIGNATURE_BYTES) ? undefined : invalidAt(`${path}.sig`);
}

const SHAPES: Readonly<Record<string, Shape>> = {
  'posting.unable': {
    required: { posting: slugCheck, report: reportProblem, sealed: sealedCheck(UNABLE_SEALED_MAX_BYTES) },
    rule: (data, path) => ((data.report as { payload: { posting: string } }).payload.posting === data.posting ? undefined : invalidAt(`${path}.report.payload.posting`, 'not this posting'))
  },
  'posting.reference': { required: { posting: slugCheck, sealed: sealedCheck(REFERENCE_SEALED_MAX_BYTES) } }
};

// Returns a reason, or undefined when the data is valid.
export function validatePersonnelData(kind: string, data: unknown, path: string): string | undefined {
  return validateShape(SHAPES, kind, data, path);
}

/** The opened reason of a posting.unable (33.1-06 reads it after opening sealed): one of UNABLE_REASONS and at most 500 characters of text. */
export function unableReasonProblem(value: unknown, path = 'reason'): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  const keys = keyProblem(value, path, ['reason'], ['text']);
  if (keys !== undefined) return keys;
  if (!(UNABLE_REASONS as readonly unknown[]).includes(value.reason)) return invalidAt(`${path}.reason`);
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length === 0 || value.text.length > UNABLE_TEXT_MAX)) return invalidAt(`${path}.text`);
  return undefined;
}

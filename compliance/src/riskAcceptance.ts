// Risk acceptances (44-04, D-20, ACCR-08). A risk acceptance is a statement signed by a named person in the extension's signed-payload format, with
// an expiry at most MAX_ACCEPTANCE_DAYS after it was issued. It is shown as "Risk accepted until {date}", never as Met, and it stops counting the
// moment it expires, which reopens its gap. Only a key listed in attestations/signers.json can sign one, and the signer must be the named person.
// The signer list ships empty (the owner names who may accept a risk) and is a gate path.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ENVELOPE_FAILURES, MAX_PAYLOAD_BYTES, fingerprintOf, isStrictBase64url, verifyEnvelope } from './signed.ts';
import { FUTURE_TOLERANCE_MS } from './status.ts';
import { loadJson, validateOurs } from './validate.ts';
import type { VerifiedRiskAcceptance } from './model.ts';

/** The signed-payload purpose of a risk acceptance. It is inside every signature, so it never changes once one is signed. */
export const RISK_ACCEPTANCE_PURPOSE = 'compliance-risk-acceptance';
/** The longest a risk acceptance may run (D-20). */
export const MAX_ACCEPTANCE_DAYS = 365;
/** The signer list's file name inside the attestations folder. */
export const SIGNERS_FILE = 'signers.json';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One person who may sign a risk acceptance. */
export interface Signer {
  readonly name: string;
  readonly role: string;
  readonly publicKey: string;
  readonly fingerprint: string;
}

/** Why a risk acceptance was refused, each with one plain sentence. The Evidence page lists refusals. */
export const RISK_ACCEPTANCE_REFUSALS = Object.freeze({
  ...ENVELOPE_FAILURES,
  'unreadable': 'This file could not be read as JSON.',
  'invalid-payload': 'This risk acceptance has a missing, unknown or badly formed field.',
  'named-person-mismatch': 'The person named in this risk acceptance is not the person whose key signed it.',
  'issued-at-mismatch': 'The issue time of this risk acceptance is not the time it was signed.',
  'expires-before-issued': 'This risk acceptance ends before it begins.',
  'too-long': `This risk acceptance runs longer than ${MAX_ACCEPTANCE_DAYS} days.`,
  'expired': 'This risk acceptance has expired, so its gap is open again.',
  'duplicate-id': 'Another risk acceptance already uses this id.'
} as const);
export type RiskAcceptanceRefusal = keyof typeof RISK_ACCEPTANCE_REFUSALS;

export type RiskAcceptanceVerdict =
  | { readonly ok: true; readonly acceptance: VerifiedRiskAcceptance; readonly signer: Signer }
  | { readonly ok: false; readonly reason: RiskAcceptanceRefusal; readonly message: string };

export interface RefusedRiskAcceptance {
  /** The file name inside the attestations folder. */
  readonly file: string;
  readonly reason: RiskAcceptanceRefusal;
  readonly message: string;
}

export interface LoadedRiskAcceptances {
  readonly verified: readonly VerifiedRiskAcceptance[];
  readonly refused: readonly RefusedRiskAcceptance[];
}

const refuse = (reason: RiskAcceptanceRefusal): RiskAcceptanceVerdict => ({ ok: false, reason, message: RISK_ACCEPTANCE_REFUSALS[reason] });

/** Reads and checks the signer list: strict schema, every fingerprint derived from its key, no key named twice. Any problem is an error. */
export function loadSigners(file: string): Signer[] {
  const doc = loadJson(file, { maxBytes: MAX_PAYLOAD_BYTES });
  const result = validateOurs(doc, 'signers');
  if (!result.ok) throw new Error(`${file}: not a valid signers file: ${result.errors.join('; ')}`);
  const signers = (doc as { signers: Signer[] }).signers;
  const seen = new Set<string>();
  for (const signer of signers) {
    if (!isStrictBase64url(signer.publicKey, 32) || fingerprintOf(Buffer.from(signer.publicKey, 'base64url')) !== signer.fingerprint) {
      throw new Error(`${file}: the fingerprint of ${signer.name} does not match the public key`);
    }
    if (seen.has(signer.fingerprint)) throw new Error(`${file}: the key ${signer.fingerprint} is listed twice`);
    seen.add(signer.fingerprint);
  }
  return signers.map((signer) => ({ name: signer.name, role: signer.role, publicKey: signer.publicKey, fingerprint: signer.fingerprint }));
}

interface AcceptancePayload {
  readonly v: 1;
  readonly id: string;
  readonly gap: string;
  readonly controls: readonly string[];
  readonly levels?: readonly string[];
  readonly reason: string;
  readonly namedPerson: { readonly name: string; readonly role: string };
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * Judges one parsed risk acceptance against the signer list and the clock. The checks, in order: the envelope's signature by a listed key (the
 * extension's format and this purpose), the strict schema, the named person equal to the signer entry, the issue time equal to the signing time and
 * not ahead of the clock beyond the skew, the expiry after the issue time by at most MAX_ACCEPTANCE_DAYS, and the clock before the expiry.
 */
export function judgeRiskAcceptance(envelope: unknown, signers: readonly Signer[], now: Date): RiskAcceptanceVerdict {
  const verdict = verifyEnvelope(envelope, { purpose: RISK_ACCEPTANCE_PURPOSE, keys: signers, now });
  if (!verdict.ok) return refuse(verdict.reason);
  if (!validateOurs(envelope, 'risk-acceptance').ok) return refuse('invalid-payload');
  const payload = verdict.payload as AcceptancePayload;
  const signer = signers.find((entry) => entry.fingerprint === verdict.signer.fingerprint && entry.publicKey === verdict.signer.publicKey);
  if (!signer) return refuse('unknown-key');
  if (payload.namedPerson.name !== signer.name || payload.namedPerson.role !== signer.role) return refuse('named-person-mismatch');
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  if (Number.isNaN(issued) || Number.isNaN(expires) || new Date(issued).toISOString() !== payload.issuedAt || new Date(expires).toISOString() !== payload.expiresAt) {
    return refuse('invalid-payload');
  }
  if (payload.issuedAt !== verdict.signedAt) return refuse('issued-at-mismatch');
  if (issued > now.getTime() + FUTURE_TOLERANCE_MS) return refuse('signed-in-future');
  if (expires <= issued) return refuse('expires-before-issued');
  if (expires - issued > MAX_ACCEPTANCE_DAYS * DAY_MS) return refuse('too-long');
  if (now.getTime() >= expires) return refuse('expired');
  const acceptance: VerifiedRiskAcceptance = {
    id: payload.id,
    gap: payload.gap,
    controls: [...payload.controls],
    ...(payload.levels ? { levels: [...payload.levels] } : {}),
    reason: payload.reason,
    namedPerson: { name: payload.namedPerson.name, role: payload.namedPerson.role },
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt
  };
  return { ok: true, acceptance, signer };
}

/**
 * Reads every `*.json` file directly in the attestations folder except the signer list, judges each with judgeRiskAcceptance, and returns the
 * verified ones and the refused ones with their reasons, in file-name order. A missing folder or signer list means nothing verifies. A second file
 * with an id already verified is refused (duplicate-id). Reading never throws for an acceptance file; a bad signer list is an error.
 */
export function loadRiskAcceptances(dir: string, now: Date): LoadedRiskAcceptances {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { verified: [], refused: [] };
  const signersFile = path.join(dir, SIGNERS_FILE);
  const signers = existsSync(signersFile) ? loadSigners(signersFile) : [];
  const files = readdirSync(dir).filter((name) => name.endsWith('.json') && name !== SIGNERS_FILE && statSync(path.join(dir, name)).isFile()).sort();
  const verified: VerifiedRiskAcceptance[] = [];
  const refused: RefusedRiskAcceptance[] = [];
  for (const file of files) {
    let envelope: unknown;
    try {
      envelope = loadJson(path.join(dir, file), { maxBytes: MAX_PAYLOAD_BYTES });
    } catch {
      refused.push({ file, reason: 'unreadable', message: RISK_ACCEPTANCE_REFUSALS.unreadable });
      continue;
    }
    const verdict = judgeRiskAcceptance(envelope, signers, now);
    if (!verdict.ok) {
      refused.push({ file, reason: verdict.reason, message: verdict.message });
    } else if (verified.some((item) => item.id === verdict.acceptance.id)) {
      refused.push({ file, reason: 'duplicate-id', message: RISK_ACCEPTANCE_REFUSALS['duplicate-id'] });
    } else {
      verified.push(verdict.acceptance);
    }
  }
  return { verified, refused };
}

/** True when a verified acceptance covers this control at this level and the clock is before its expiry. */
export function acceptanceCovers(acceptance: VerifiedRiskAcceptance, control: string, level: string, now: Date): boolean {
  const expires = Date.parse(acceptance.expiresAt);
  if (Number.isNaN(expires) || now.getTime() >= expires) return false;
  if (!acceptance.controls.includes(control)) return false;
  return acceptance.levels === undefined || acceptance.levels.includes(level);
}

// A person's decisions outside the product release machine (design 10, 3.1 and 4.1: members never decide; review round 3 of drop 1). Today that is a
// PIR's approval or rejection, a standing watch armed or retired (WP-WATCH), and a person's choice to use this branch's product ledger (the head this
// computer checks it against moves to it). A decision counts only when a signed entry in the decision log recorded it: the log is `.planning/staff/ledger/
// decisions.jsonl`, one entry per line, each signed with the deciding person's device key (purpose `staff-decision`) and chained to the one before, the
// same way the product ledger is. A decision block written into a register file by hand, or by a member with Write, is never trusted from the file
// alone: without a matching signed entry it reads as not decided. Pure: no I/O, no clock, no vscode.
import { createHash } from 'node:crypto';
import { canonicalize } from '../team/canonical';
import type { PayloadVerdict } from '../team/signedPayload';
import { isOneLine, isRecord, ownValue } from './parse';
import { isNamedPerson } from './release';
import type { PersonActor } from './release';

export const DECISION_LOG_FILE = 'decisions.jsonl';
export const DECISION_LOG_VERSION = 1;
export const DECISION_LOG_GENESIS = '0'.repeat(64);
const MAX_REASONS = 10;
const MAX_REASON = 500;

/**
 * What a person decided on: a PIR in the J2 PIR register, by its id; or the product ledger head this computer checks against (`ledger-head`, its id the
 * number of entries, its wording the digest of the last one), when a person chose to use this branch's ledger.
 */
export type DecisionSubject = { readonly kind: 'pir'; readonly id: string } | { readonly kind: 'ledger-head'; readonly id: string } | { readonly kind: 'watch'; readonly id: string };
/**
 * `watch` (WP-WATCH): a standing watch by its id. `approved` arms it, `rejected` rejects or retires it; the wording is the hash of the watch as the person
 * saw it (watchWording), so a watch changed after it was armed reads as not armed.
 */
export const DECISION_SUBJECT_KINDS: ReadonlyArray<DecisionSubject['kind']> = ['pir', 'ledger-head', 'watch'];

export interface PersonDecisionEntry {
  readonly v: 1;
  readonly seq: number;
  /** entryDigest of the entry before, or DECISION_LOG_GENESIS. */
  readonly prev: string;
  readonly at: string;
  readonly subject: DecisionSubject;
  readonly decision: 'approved' | 'rejected';
  /** A hash of the exact wording decided on (pirWording): a later change to the wording voids the decision. For a ledger head, the head's digest. */
  readonly wording: string;
  readonly reasons: readonly string[];
  readonly person: PersonActor;
}

/** The hash of a PIR's decided wording: the requirement, the decision point and the latest time of value. */
export function pirWording(pir: { readonly requirement: string; readonly decisionPoint: string; readonly ltiov: string }): string {
  return createHash('sha256').update(JSON.stringify([pir.requirement, pir.decisionPoint, pir.ltiov])).digest('hex');
}

export function decisionKey(subject: DecisionSubject): string {
  return `${subject.kind}:${subject.id}`;
}

export function decisionDigest(envelope: unknown): string {
  return createHash('sha256').update(canonicalize(envelope)).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

export function parsePersonDecision(value: unknown): PersonDecisionEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).sort().join(',') !== 'at,decision,person,prev,reasons,seq,subject,v,wording') return undefined;
  const subject = ownValue(value, 'subject');
  const person = ownValue(value, 'person');
  const reasons = ownValue(value, 'reasons');
  const seq = ownValue(value, 'seq');
  if (ownValue(value, 'v') !== DECISION_LOG_VERSION || !Number.isSafeInteger(seq) || (seq as number) < 0) return undefined;
  if (typeof ownValue(value, 'prev') !== 'string' || !HEX64.test(ownValue(value, 'prev') as string)) return undefined;
  if (typeof ownValue(value, 'wording') !== 'string' || !HEX64.test(ownValue(value, 'wording') as string)) return undefined;
  if (typeof ownValue(value, 'at') !== 'string' || Number.isNaN(Date.parse(ownValue(value, 'at') as string))) return undefined;
  if (!isRecord(subject) || !(DECISION_SUBJECT_KINDS as readonly unknown[]).includes(ownValue(subject, 'kind')) || !isOneLine(ownValue(subject, 'id'), 40) || Object.keys(subject).length !== 2) return undefined;
  const decision = ownValue(value, 'decision');
  if (decision !== 'approved' && decision !== 'rejected') return undefined;
  if (!isRecord(person) || !isNamedPerson(person as never)) return undefined;
  if (!Array.isArray(reasons) || reasons.length > MAX_REASONS || !reasons.every((reason) => isOneLine(reason, MAX_REASON))) return undefined;
  if (decision === 'rejected' && reasons.length === 0) return undefined;
  return JSON.parse(JSON.stringify(value)) as PersonDecisionEntry;
}

export interface DecisionReplay {
  /** The latest trusted decision per subject (decisionKey). */
  readonly decisions: ReadonlyMap<string, PersonDecisionEntry>;
  readonly entries: number;
  readonly head: string;
  /** Where the log broke: nothing from there on is trusted, so those decisions read as not taken. */
  readonly broken?: { readonly seq: number; readonly reason: string };
}

export const DECISION_LOG_PROBLEMS = {
  unreadable: 'A decision log line is not a signed decision.',
  signature: 'A decision is not signed by a key this computer trusts.',
  chain: 'A decision does not follow the one before it, so the log was changed outside NEAR AI.',
  'person-key': 'A decision is signed by a key other than the one of the person it names.'
} as const;

/**
 * Replays the decision log. The first line that fails any check (signature, chain, the person's own key) breaks it: nothing from there on counts, so a
 * decision that cannot be proven reads as not taken, which is the safe side for a decision.
 */
export function replayPersonDecisions(envelopes: readonly unknown[], verify: (envelope: unknown) => PayloadVerdict<unknown>): DecisionReplay {
  const decisions = new Map<string, PersonDecisionEntry>();
  let head = DECISION_LOG_GENESIS;
  let entries = 0;
  for (let index = 0; index < envelopes.length; index += 1) {
    const broken = (reason: keyof typeof DECISION_LOG_PROBLEMS): DecisionReplay => ({ decisions, entries, head, broken: { seq: index, reason: DECISION_LOG_PROBLEMS[reason] } });
    const verdict = verify(envelopes[index]);
    if (!verdict.ok) return broken(verdict.reason === 'malformed' ? 'unreadable' : 'signature');
    const entry = parsePersonDecision(verdict.payload);
    if (!entry) return broken('unreadable');
    if (entry.seq !== index || entry.prev !== head) return broken('chain');
    if (entry.person.deviceFingerprint !== verdict.signer.fingerprint) return broken('person-key');
    decisions.set(decisionKey(entry.subject), entry);
    head = decisionDigest(envelopes[index]);
    entries += 1;
  }
  return { decisions, entries, head };
}

/** Whether a decision block written in a file is the one a signed entry recorded: same decision, same person, same wording. */
export function decisionMatches(recorded: PersonDecisionEntry | undefined, written: { readonly decision: 'approved' | 'rejected'; readonly by: PersonActor } | undefined, wording: string): boolean {
  if (!recorded || !written) return false;
  return recorded.decision === written.decision && recorded.wording === wording && recorded.person.name === written.by.name && recorded.person.role === written.by.role
    && recorded.person.deviceFingerprint === written.by.deviceFingerprint;
}

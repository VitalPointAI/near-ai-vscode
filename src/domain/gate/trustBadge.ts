// The trust badge on each cloud answer (CLAS-08): three plain states, chosen here and only here from the checks that actually ran. The badge never says
// more than was proven: a check that is still running, timed out, could not run or failed is Not verified, and Verified private model needs every input at
// its best. Pure: no vscode, no network, nothing outside src/domain.
import { applyAllowed } from './modelRow';
import { createHash } from 'node:crypto';
import type { ConnectionBindingFact } from './routing';
import type { TrustFacts, TrustLine, TrustPlace } from './trust';

export const TRUST_BADGE_STATES = Object.freeze(['verified-private', 'model-verified', 'not-verified'] as const);
export type TrustBadgeState = (typeof TRUST_BADGE_STATES)[number];

// trust.ts reads TRUST_BADGE_STATES when it loads, and this file calls its trustLine: these imports come after the states, so either file can load first.
import { activeScales } from './labelAlgebra';
import { TRUST_LINE_TEXT, trustLine } from './trust';

/** The owner's three titles (CLAS-08). SECURITY.md and README carry them word for word, and a test keeps them equal. */
export const TRUST_BADGE_TITLES: Readonly<Record<TrustBadgeState, string>> = Object.freeze({
  'verified-private': 'Verified private model',
  'model-verified': 'Model verified, connection not proven',
  'not-verified': 'Not verified'
});

/** How long the badge waits for its check before it says the answer could not be checked in time (D-56). A later result still updates it. */
export const BADGE_CHECK_TIMEOUT_MS = 20_000;

/**
 * Every sentence the badge shows. The explanations are in SECURITY.md word for word. A sentence ending in a colon is followed by its cause; the forwarded
 * reason's `{provider}` is replaced by where NEAR AI forwards the model.
 */
export const TRUST_BADGE_TEXT = Object.freeze({
  explanation: Object.freeze({
    'verified-private': 'This answer\'s signature and NEAR AI Cloud\'s attestation were checked, and the connection that carried your request was proven to end inside NEAR AI Cloud\'s private enclave.',
    'model-verified': 'This answer\'s signature and NEAR AI Cloud\'s attestation were checked, so a private model on NEAR AI Cloud sent it. The connection that carried your request was not proven to end inside the private enclave.',
    'not-verified': 'SovAI could not show that a private model on NEAR AI Cloud sent this answer. The reasons below say why.'
  } satisfies Record<TrustBadgeState, string>),
  helpers: 'This badge is about the answer above. Helper agents in the run may have used other models; each of their requests was routed by the chat\'s label and recorded.',
  checking: 'Checking now.',
  unavailable: 'It could not be checked:',
  timedOut: 'It could not be checked in time. The badge changes if the check finishes later.',
  timedOutReplayed: 'It could not be checked in time when the answer arrived.',
  failed: 'The check failed:',
  notRun: 'It was not checked.',
  forwarded: 'This model runs outside a verified enclave: NEAR AI forwards it to {provider}.',
  forwardedSomewhere: 'This model runs outside a verified enclave: NEAR AI forwards it to another provider.',
  unknownModel: 'NEAR AI does not know where this model runs, so it cannot be checked.',
  otherEndpoint: 'This answer came through an endpoint other than NEAR AI Cloud\'s own, where a model cannot be checked.',
  noSignature: 'NEAR AI returned no signature id for this answer.',
  connectionNotProven: 'The connection was not proven to end inside the private enclave:',
  earlierFailed: 'An earlier check in this chat failed. Use Check again under that answer.',
  earlierFailedLost: 'An earlier check in this chat failed and can no longer be checked again from the editor. Start a new chat to send content at the levels that need an attested cloud to NEAR AI Cloud again.',
  connection: Object.freeze({
    'not-bound': 'the key the server presented did not match the one NEAR AI Cloud\'s attestation names.',
    unavailable: 'the check of the connection could not be made.',
    unknown: 'there was no proof of the connection when your request was sent.',
    stale: 'your request was not sent over a connection held to the key NEAR AI Cloud\'s attestation names.'
  }),
  notChecked: 'Not checked in the editor: ',
  fullCheck: 'For a full check use cloud.near.ai/verify or NEAR’s nearai-cloud-verifier.',
  keptWhileOpen: 'The full attestation is kept only while the window that checked it is open.',
  notKept: 'This answer can no longer be checked again from the editor: only the last 20 answers of this window are kept.',
  replayed: 'This shows the check made when the answer arrived.',
  // The trust line's words when the request that answered left no record of what allowed it (D-38).
  allowedNotRecorded: 'What allowed it was not recorded',
  allowedNotKept: 'What allowed it is not kept for an answer shown again',
  placeNotKept: 'Where it ran is not kept for an answer shown again'
});

/** How far a badge's check got: the outcomes of the client's check, written out because src/domain may not import src/services. */
export type TrustVerification = 'not-run' | 'pending' | 'signed' | 'failed' | 'unavailable' | 'timed-out';
export const TRUST_VERIFICATIONS: readonly TrustVerification[] = Object.freeze(['not-run', 'pending', 'signed', 'failed', 'unavailable', 'timed-out']);

/** What a badge is chosen from: only facts of checks that ran, all read from memory. */
export interface TrustBadgeFacts {
  /** The client the answer came through. A local one gets no badge. */
  readonly route: 'near' | 'local';
  /** The client's endpoint is NEAR AI Cloud's own. */
  readonly nearEndpoint: boolean;
  /** Where the catalog says the model runs; undefined when it does not know. */
  readonly boundary: 'tee' | 'cloud' | 'local' | undefined;
  /** Where NEAR AI forwards a model that is not private, when the catalog names it. */
  readonly forwardedTo?: string;
  /** NEAR AI returned a signature id (the answer's chat id), so the answer can be checked. */
  readonly hasEvidence: boolean;
  readonly verification: TrustVerification;
  /** The check's own summary, said after a failure or an unavailable check. */
  readonly verificationSummary?: string;
  /** The connection fact the answer's request carried, if any. */
  readonly connection?: ConnectionBindingFact;
  /** The request was sent over a connection held to that fact's key while the fact was fresh. */
  readonly connectionFresh: boolean;
  /** A check of another answer in this chat failed and has not been checked again since. */
  readonly earlierCheckFailed: boolean;
  /** One of those failures is no longer kept for Check again, so only a new chat clears it (PR #89 review). */
  readonly earlierCheckLost?: boolean;
  /** The TrustFacts the route check of the request that answered produced (D-38). Absent on an older path or a test client. */
  readonly trust?: TrustFacts;
}

export interface TrustBadge {
  readonly state: TrustBadgeState;
  readonly title: string;
  readonly explanation: string;
  readonly reasons: readonly string[];
  /** The sentence about helper agents (D-56). */
  readonly helpers: string;
  /** What the editor does not check, from the check's result. */
  readonly notChecked?: readonly string[];
  /** A badge shown again for a reopened chat: it has no Check again and no full attestation (plan 27). */
  readonly replayed?: true;
  /** The trust line (D-38): "Runs on {place} · {verified} · {allowed}", its verified part always this badge's own state. */
  readonly line?: TrustLine;
  /** Insert at cursor on this answer (74.1 D-21, P4): absent when allowed with nothing to say; otherwise whether it may write, and why. */
  readonly apply?: { readonly allowed: boolean; readonly reason?: string };
}

/** 0 for Not verified, 1 for Model verified, connection not proven, 2 for Verified private model: a stronger state has a higher rank. */
export function trustBadgeRank(state: TrustBadgeState): number {
  return state === 'verified-private' ? 2 : state === 'model-verified' ? 1 : 0;
}

/** True only when the request carried a fresh bound fact and was sent over a connection held to its key. */
export function connectionProven(facts: Pick<TrustBadgeFacts, 'connection' | 'connectionFresh'>): boolean {
  return facts.connection?.state === 'bound' && facts.connectionFresh === true;
}

function connectionCause(facts: Pick<TrustBadgeFacts, 'connection' | 'connectionFresh'>): string {
  const state = facts.connection?.state;
  if (state === 'not-bound') return TRUST_BADGE_TEXT.connection['not-bound'];
  if (state === 'unavailable') return TRUST_BADGE_TEXT.connection.unavailable;
  if (state === 'bound') return TRUST_BADGE_TEXT.connection.stale;
  return TRUST_BADGE_TEXT.connection.unknown;
}

function withCause(lead: string, cause: string | undefined): string {
  const text = (cause ?? '').trim();
  return text ? `${lead} ${text}` : lead.replace(/:$/, '.');
}

/**
 * The badge for one answer, or undefined for an answer through a local client (CLAS-08). Verified private model only when the model is a TEE model on NEAR
 * AI Cloud's own endpoint, the answer has a signature id, its check is signed, its request carried a fresh bound connection fact over a held connection,
 * and no other check of the chat failed. Model verified, connection not proven when everything but the connection holds. Not verified otherwise, with a
 * reason for each input that was not at its best.
 */
/** Insert at cursor on the answer, from its trust facts (74.1 D-21): undefined when allowed with nothing to say. */
function applyOf(facts: TrustBadgeFacts): TrustBadge['apply'] {
  if (facts.trust === undefined) return undefined;
  const found = applyAllowed(facts.trust, 'This model');
  return found.allowed && found.reason === undefined ? undefined : found;
}

export function trustBadgeFor(facts: TrustBadgeFacts): TrustBadge | undefined {
  if (facts.route === 'local') return undefined;
  const reasons: string[] = [];
  if (!facts.nearEndpoint) reasons.push(TRUST_BADGE_TEXT.otherEndpoint);
  if (facts.boundary !== 'tee') {
    if (facts.boundary === 'cloud') reasons.push(facts.forwardedTo ? TRUST_BADGE_TEXT.forwarded.replace('{provider}', facts.forwardedTo) : TRUST_BADGE_TEXT.forwardedSomewhere);
    else reasons.push(TRUST_BADGE_TEXT.unknownModel);
  }
  if (!facts.hasEvidence) reasons.push(TRUST_BADGE_TEXT.noSignature);
  switch (facts.verification) {
    case 'pending': reasons.push(TRUST_BADGE_TEXT.checking); break;
    case 'timed-out': reasons.push(TRUST_BADGE_TEXT.timedOut); break;
    case 'unavailable': reasons.push(withCause(TRUST_BADGE_TEXT.unavailable, facts.verificationSummary)); break;
    case 'failed': reasons.push(withCause(TRUST_BADGE_TEXT.failed, facts.verificationSummary)); break;
    case 'not-run': if (reasons.length === 0) reasons.push(TRUST_BADGE_TEXT.notRun); break;
    case 'signed': break;
  }
  if (facts.earlierCheckFailed) reasons.push(facts.earlierCheckLost === true ? TRUST_BADGE_TEXT.earlierFailedLost : TRUST_BADGE_TEXT.earlierFailed);
  const modelProven = facts.nearEndpoint && facts.boundary === 'tee' && facts.hasEvidence && facts.verification === 'signed' && !facts.earlierCheckFailed;
  let state: TrustBadgeState;
  if (!modelProven) state = 'not-verified';
  else if (connectionProven(facts)) state = 'verified-private';
  else {
    state = 'model-verified';
    reasons.push(withCause(TRUST_BADGE_TEXT.connectionNotProven, connectionCause(facts)));
  }
  const apply = applyOf(facts);
  return { state, title: TRUST_BADGE_TITLES[state], explanation: TRUST_BADGE_TEXT.explanation[state], reasons, helpers: TRUST_BADGE_TEXT.helpers, line: badgeLine(facts, state), ...(apply === undefined ? {} : { apply }) };
}

/** A line of three parts, joined as trustLine joins them. */
function lineOf(runsOn: string, verified: string, allowed: string): TrustLine {
  return Object.freeze({ runsOn, verified, allowed, text: [runsOn, verified, allowed].filter((part) => part !== '').join(TRUST_LINE_TEXT.partSeparator) });
}

/**
 * The trust line of a badge (D-38): from the request's TrustFacts with the verified part set to the badge's state, so the line never says more than the
 * badge proved (T-41-135). Without TrustFacts the place comes from the badge facts (NEAR AI Cloud's endpoint with a TEE model: its private hardware; a
 * forwarded model: the outside provider; another endpoint: a place your rules do not name) and the allowed part says it was not recorded.
 */
function badgeLine(facts: TrustBadgeFacts, state: TrustBadgeState): TrustLine {
  if (facts.trust !== undefined) return trustLine({ ...facts.trust, verification: state }, activeScales());
  const place: TrustPlace = !facts.nearEndpoint
    ? { class: 'unknown', region: 'unstated' }
    : facts.boundary === 'tee' ? { class: 'nearai-tee', region: 'unstated' } : { class: 'forwarded', region: 'unstated', ...(facts.forwardedTo === undefined ? {} : { forwardedTo: facts.forwardedTo }) };
  const derived = trustLine({ place, verification: state, allowedBy: [], wouldRefuse: [] }, activeScales());
  return lineOf(derived.runsOn, derived.verified, TRUST_BADGE_TEXT.allowedNotRecorded);
}


// ---- A badge kept with the chat (plan 27): the state its checks reached when the answer arrived, shown again when the chat reopens ----

/**
 * One answer's settled badge as the chat's metadata keeps it (ThreadMeta.trust): the state, its plain reasons and when, keyed by a hash of the answer's
 * text. Never a fingerprint, a signing address or the answer's text, so it syncs with the rest of the chat's metadata and passes the secret scanner.
 */
export interface TrustRecord {
  readonly key: string;
  readonly state: TrustBadgeState;
  readonly reasons: readonly string[];
  readonly at: string;
}

/** How many badge records a chat keeps: the newest by time. */
export const MAX_TRUST_RECORDS = 200;
/** The most bytes a chat's badge records take in its metadata (as JSON), the oldest dropped first (PR #95 review). */
export const MAX_TRUST_BYTES = 64 * 1024;
const MAX_RECORD_REASONS = 12;
const MAX_REASON_LENGTH = 400;
/** A run of hex long enough to be a key, an address or a fingerprint: never kept in a record. */
const LONG_HEX = /(?:0x)?[0-9a-fA-F]{16,}/g;
const HAS_LONG_HEX = /[0-9a-fA-F]{16,}/;

/** The key of an answer's record: the first 32 hex characters of the SHA-256 of its text. */
export function trustRecordKey(answerText: string): string {
  return createHash('sha256').update(answerText, 'utf8').digest('hex').slice(0, 32);
}

/** A reason as a record keeps it: any long hex run (an address, a fingerprint, a hash) taken out, and the length capped. */
function recordReason(reason: string): string {
  const plain = reason.replace(LONG_HEX, '(hidden)');
  return plain.length > MAX_REASON_LENGTH ? `${plain.slice(0, MAX_REASON_LENGTH - 1)}…` : plain;
}

/** The record of a settled badge for one answer. */
export function trustRecordOf(answerText: string, badge: Pick<TrustBadge, 'state' | 'reasons'>, at: Date): TrustRecord {
  return { key: trustRecordKey(answerText), state: badge.state, reasons: badge.reasons.slice(0, MAX_RECORD_REASONS).map(recordReason), at: at.toISOString() };
}

/** A record read from stored or synced metadata: undefined unless every field has its type and the state is one of the three. */
export function parseTrustRecord(value: unknown): TrustRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((name) => !['key', 'state', 'reasons', 'at'].includes(name))) return undefined;
  if (typeof record.key !== 'string' || !/^[0-9a-f]{32}$/.test(record.key)) return undefined;
  if (typeof record.state !== 'string' || !(TRUST_BADGE_STATES as readonly string[]).includes(record.state)) return undefined;
  if (!Array.isArray(record.reasons) || record.reasons.length > MAX_RECORD_REASONS || record.reasons.some((reason) => typeof reason !== 'string' || reason.length > MAX_REASON_LENGTH || HAS_LONG_HEX.test(reason))) return undefined;
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) return undefined;
  return { key: record.key, state: record.state as TrustBadgeState, reasons: [...(record.reasons as string[])], at: record.at };
}

/** The weaker of two records of one answer: the lower state, and for the same state the newer one. */
export function weakerTrustRecord(a: TrustRecord, b: TrustRecord): TrustRecord {
  const rankA = trustBadgeRank(a.state);
  const rankB = trustBadgeRank(b.state);
  if (rankA !== rankB) return rankA < rankB ? a : b;
  return a.at >= b.at ? a : b;
}

/**
 * Two copies' records merged: every key of both, and for a key both hold the weaker state whichever copy is newer, so no merge makes a badge stronger
 * (CLAS-08). Unreadable records are dropped. The newest MAX_TRUST_RECORDS by time are kept.
 */
export function mergeTrustRecords(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): TrustRecord[] {
  const byKey = new Map<string, TrustRecord>();
  for (const value of [...(a ?? []), ...(b ?? [])]) {
    const record = parseTrustRecord(value);
    if (record === undefined) continue;
    const held = byKey.get(record.key);
    byKey.set(record.key, held === undefined ? record : weakerTrustRecord(held, record));
  }
  return newestTrustRecords([...byKey.values()]);
}

const UTF8 = new TextEncoder();
function jsonBytes(value: unknown): number { return UTF8.encode(JSON.stringify(value)).length; }

/** The newest records by time, oldest first: at most MAX_TRUST_RECORDS, and at most MAX_TRUST_BYTES as JSON, the oldest dropped first. */
export function newestTrustRecords(records: readonly TrustRecord[]): TrustRecord[] {
  const kept = [...records].sort((x, y) => x.at.localeCompare(y.at) || x.key.localeCompare(y.key)).slice(-MAX_TRUST_RECORDS);
  // The JSON of a list is its records' JSON, a comma between each, and the two brackets.
  let bytes = 2 + kept.reduce((sum, record) => sum + jsonBytes(record) + 1, 0) - (kept.length > 0 ? 1 : 0);
  while (kept.length > 0 && bytes > MAX_TRUST_BYTES) {
    const dropped = kept.shift()!;
    bytes -= jsonBytes(dropped) + (kept.length > 0 ? 1 : 0);
  }
  return kept;
}

/** The badge a reopened chat shows for a record: replayed (no Check again, no full attestation), saying it shows the check made when the answer arrived. */
export function trustBadgeFromRecord(record: TrustRecord): TrustBadge {
  return {
    state: record.state,
    title: TRUST_BADGE_TITLES[record.state],
    explanation: TRUST_BADGE_TEXT.explanation[record.state],
    // A reason that speaks of a check still to come is about the window that checked it, never true on replay: it is reworded or left out.
    reasons: [...record.reasons.flatMap((reason) => reason === TRUST_BADGE_TEXT.timedOut ? [TRUST_BADGE_TEXT.timedOutReplayed] : reason === TRUST_BADGE_TEXT.checking ? [] : [reason]), TRUST_BADGE_TEXT.replayed],
    helpers: TRUST_BADGE_TEXT.helpers,
    replayed: true,
    // A record proves where only for the two states whose check showed NEAR AI's private hardware; what allowed the answer is never kept in it.
    line: lineOf(
      record.state === 'not-verified' ? TRUST_BADGE_TEXT.placeNotKept : `${TRUST_LINE_TEXT.runsOn} ${TRUST_LINE_TEXT.places['nearai-tee']}`,
      TRUST_LINE_TEXT.verified[record.state],
      TRUST_BADGE_TEXT.allowedNotKept
    )
  };
}

// The trust badge on each cloud answer (CLAS-08): three plain states, chosen here and only here from the checks that actually ran. The badge never says
// more than was proven: a check that is still running, timed out, could not run or failed is Not verified, and Verified private model needs every input at
// its best. Pure: no vscode, no network, nothing outside src/domain.
import type { ConnectionBindingFact } from './routing';

export const TRUST_BADGE_STATES = Object.freeze(['verified-private', 'model-verified', 'not-verified'] as const);
export type TrustBadgeState = (typeof TRUST_BADGE_STATES)[number];

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
    'not-verified': 'NEAR AI could not show that a private model on NEAR AI Cloud sent this answer. The reasons below say why.'
  } satisfies Record<TrustBadgeState, string>),
  helpers: 'This badge is about the answer above. Helper agents in the run may have used other models; each of their requests was routed by the chat\'s label and recorded.',
  checking: 'Checking now.',
  unavailable: 'It could not be checked:',
  timedOut: 'It could not be checked in time. The badge changes if the check finishes later.',
  failed: 'The check failed:',
  notRun: 'It was not checked.',
  forwarded: 'This model runs outside a verified enclave: NEAR AI forwards it to {provider}.',
  forwardedSomewhere: 'This model runs outside a verified enclave: NEAR AI forwards it to another provider.',
  unknownModel: 'NEAR AI does not know where this model runs, so it cannot be checked.',
  otherEndpoint: 'This answer came through an endpoint other than NEAR AI Cloud\'s own, where a model cannot be checked.',
  noSignature: 'NEAR AI returned no signature id for this answer.',
  connectionNotProven: 'The connection was not proven to end inside the private enclave:',
  earlierFailed: 'An earlier check in this chat failed. Use Check again under that answer.',
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
  replayed: 'This shows the check made when the answer arrived.'
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
  if (facts.earlierCheckFailed) reasons.push(TRUST_BADGE_TEXT.earlierFailed);
  const modelProven = facts.nearEndpoint && facts.boundary === 'tee' && facts.hasEvidence && facts.verification === 'signed' && !facts.earlierCheckFailed;
  let state: TrustBadgeState;
  if (!modelProven) state = 'not-verified';
  else if (connectionProven(facts)) state = 'verified-private';
  else {
    state = 'model-verified';
    reasons.push(withCause(TRUST_BADGE_TEXT.connectionNotProven, connectionCause(facts)));
  }
  return { state, title: TRUST_BADGE_TITLES[state], explanation: TRUST_BADGE_TEXT.explanation[state], reasons, helpers: TRUST_BADGE_TEXT.helpers };
}


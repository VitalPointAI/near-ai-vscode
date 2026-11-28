// Trusting your organization's server again (Phase 33 D-13, D-42; 33-27). After a fork or rollback finding, every member's computer distrusts the
// hub and stays at attention; a member cannot clear it alone (D-42: members never disagree about the hub). Only a lead or deputy device may trust it
// again, and only after comparing the twelve words of the hub's certificate pin (serverWords.ts, 33-18) with the person who runs the server: the
// words are typed or read back, and only when they match is one hub.readmit { hub, certPin } written. The device the roster names signs it, which
// in a hosted session is the person key through a fresh step-up (D-60), never the session key. Folding it clears the witness's distrusted mark on
// every member device (hubSync.ts readmitWitness), so their replicators leave attention.
//
//   words differ                         -> refused, nothing written
//   not a lead or deputy device, split   -> refused as every roster change (membership writerProblem)
//   no hub, hub unknown, hub revoked     -> refused with the hub flows' sentences
//   words match                          -> one hub.readmit, folded at the roster head
//
// Host-neutral: no vscode, no Theia. No result names a key or the pin.
import { SERVER_WORD_COUNT, serverPinWords } from '../../domain/replica/serverWords';
import { hubAt } from '../../domain/replica/rosterMembers';
import { multiUserNoticeLines } from '../../domain/staff/multiUser';
import { HUB_MEMBERSHIP_REFUSALS } from './hubMembership';
import type { HubMembershipResult } from './hubMembership';
import { append, headOf, writerProblem } from './membership';
import type { MembershipResult, SharedProjectHost } from './membership';
import { ReplicaProjectError } from './replicaProject';

export const HUB_READMIT_REFUSALS = {
  'words-differ': `The words do not match the ${SERVER_WORD_COUNT} words of this server's certificate, so it was not trusted again. Nothing was changed. Compare the words again with the person who runs your organization's server.`,
  'pin-invalid': 'That is not a certificate pin of your organization\'s server, so nothing was changed. Ask the person who runs the server for its pin.'
} as const;

export interface ReadmitHubInput {
  /** The hub's id; the only hub the roster has in force when absent. */
  hub?: string;
  /** The certificate pin the lead compared (64 hex characters): the server's current one, or the restored server's. */
  certPin: string;
  /** The twelve words as typed or read back, in order; spaces, commas and case do not matter. */
  words: string | readonly string[];
  /** A restored checkpoint the hub starts from (D-32), when the operator named one. */
  fromCheckpoint?: string;
}

const PIN = /^[0-9a-f]{64}$/;

/** The typed words in the form they are compared: lower case, in order, no punctuation. */
export function typedWords(words: string | readonly string[]): string[] {
  const text = typeof words === 'string' ? words : words.join(' ');
  return text.toLowerCase().split(/[\s,;.]+/).filter((word) => word.length > 0);
}

const refused = (reason: string, message: string): HubMembershipResult => ({ ok: false, reason, message, notices: multiUserNoticeLines() });

/** True when the typed words are the pin's twelve words, in order. */
export function readmitWordsMatch(certPin: string, words: string | readonly string[]): boolean {
  if (!PIN.test(certPin)) return false;
  const expected = serverPinWords(certPin);
  const typed = typedWords(words);
  return typed.length === expected.length && typed.every((word, index) => word === expected[index]);
}

/** The hub the re-admission is for: named, or the only one admitted at the head. Revoked or unknown hubs are refused with the hub flows' words. */
function hubFor(roster: Awaited<ReturnType<SharedProjectHost['project']['state']>>['roster'], named: string | undefined): string | HubMembershipResult {
  const position = headOf(roster).position;
  if (named !== undefined) {
    if (!roster.members.hubs.has(named)) return refused('hub-unknown', HUB_MEMBERSHIP_REFUSALS['hub-unknown']);
    return hubAt(roster.members, named, position) === undefined ? refused('hub-revoked', HUB_MEMBERSHIP_REFUSALS['hub-revoked']) : named;
  }
  const admitted = [...roster.members.hubs.keys()].filter((hub) => hubAt(roster.members, hub, position) !== undefined);
  if (admitted.length === 0) return refused('no-hub', HUB_MEMBERSHIP_REFUSALS['no-hub']);
  if (admitted.length > 1) return refused('hub-not-named', HUB_MEMBERSHIP_REFUSALS['hub-not-named']);
  return admitted[0] as string;
}

/**
 * Trusts your organization's server again (D-42) once the lead has compared its twelve words: writes one hub.readmit with the compared pin. Every
 * refusal comes before anything is written. A refusal of the person key (no fresh confirmation) is returned with the key store's sentence.
 */
export async function readmitHub(shared: SharedProjectHost, input: ReadmitHubInput): Promise<HubMembershipResult> {
  if (typeof input.certPin !== 'string' || !PIN.test(input.certPin)) return refused('pin-invalid', HUB_READMIT_REFUSALS['pin-invalid']);
  if (!readmitWordsMatch(input.certPin, input.words)) return refused('words-differ', HUB_READMIT_REFUSALS['words-differ']);
  try {
    const { roster } = await shared.project.state();
    const problem = writerProblem(shared, roster);
    if (problem !== undefined) return problem;
    const hub = hubFor(roster, input.hub);
    if (typeof hub !== 'string') return hub;
    const data = { hub, certPin: input.certPin, ...(input.fromCheckpoint === undefined ? {} : { fromCheckpoint: input.fromCheckpoint }) };
    const written: { hash: string } | MembershipResult = await append(shared, 'hub.readmit', data);
    if ('ok' in written) return written;
    return { ok: true, message: 'Your organization\'s server is trusted again. Each computer in this shared work starts syncing with it at its next connection.', notices: multiUserNoticeLines(), hub };
  } catch (error) {
    if (error instanceof ReplicaProjectError) return refused(error.refusal.refused, error.refusal.message);
    throw error;
  }
}

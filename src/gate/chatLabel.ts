// Signed lowerings of a chat's label (CLAS-04, D-58): a person's Lower This Chat's Label travels to their other copies of the chat only as a declassification
// signed with this person's device key under the purpose label-declassify, and a merge applies one only when it verifies against this computer's key sources
// with the key valid at the signing time, names this chat, its from-mark covers the other copy's mark, and the other copy was not used after it. Anything
// else keeps the joined, higher label. Node only, no vscode.
import { raiseMark, sameMark } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { SCALE_PRESETS, parseLabel } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { NO_KNOWN_KEYS, combineKeyStatus, teamKeyStatus } from '../domain/team/keyStatus';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../domain/team/signedPayload';
import type { TeamState } from '../domain/team/types';
import type { LoweringContext, LoweringVerdict } from '../domain/gate/lowerings';

/** What a signed lowering says. */
export interface ChatLowering {
  readonly chatId: string;
  readonly from: readonly Label[];
  readonly to: readonly Label[];
  readonly reason: string;
  /** When the person lowered it (ISO). */
  readonly at: string;
}

/** Why a lowering from another copy was not applied, in plain words (each recorded as label.declassify-rejected and said once). */
export const LOWERING_REJECTION_CAUSES = Object.freeze({
  'no-signature': 'it has no signature',
  'does-not-verify': 'its signature does not verify',
  'another-purpose': 'it was signed for another use',
  'key-unknown': 'it was signed by a key unknown to this computer',
  'key-revoked': 'its key was revoked',
  'key-rotated': 'its key was replaced before it was signed',
  'another-chat': 'it names another chat',
  'higher-mark': 'the other copy of the chat holds a higher label',
  'used-after': 'the chat was used on the other copy after it was lowered',
  'both-lowered': 'both copies hold lowerings the other does not',
  'no-judge': 'this window cannot check signed lowerings'
} as const);
export type LoweringRejection = keyof typeof LOWERING_REJECTION_CAUSES;

/** Signs a lowering with this install's device identity under label-declassify (one signer, a closed purpose list: Phase 69 D-10). */
export function signChatLowering(identity: PayloadSigner, lowering: ChatLowering): SignedPayload<ChatLowering> {
  return signPayload(identity, 'label-declassify', { chatId: lowering.chatId, from: [...lowering.from], to: [...lowering.to], reason: lowering.reason, at: lowering.at }, { now: () => new Date(lowering.at) });
}

/**
 * The key sources a lowering is checked against (D-58): this install's key history and, in Team Mode, only the devices the roster lists for this person's
 * own member id (never a teammate's). Outside Team Mode a computer knows only its own install's keys.
 */
export function chatLoweringKeys(local: KeyStatusLookup, team?: { readonly state: Pick<TeamState, 'members' | 'deviceIndex'>; readonly memberId: string }): KeyStatusLookup {
  if (team === undefined) return local;
  const roster = teamKeyStatus(team.state);
  const own: KeyStatusLookup = (key) => (team.state.deviceIndex.get(key.fingerprint) === team.memberId ? roster(key) : { state: 'unknown' });
  return combineKeyStatus(local, own);
}

function markOf(value: unknown): Mark | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return undefined;
  const out: Label[] = [];
  for (const entry of value) {
    const parsed = parseLabel(entry, SCALE_PRESETS);
    if (!parsed.ok) return undefined;
    out.push(parsed.value);
  }
  return out;
}

/** Judges one signed lowering a copy of the chat holds and the other does not (D-58). Never throws. */
export function judgeChatLowering(envelope: unknown, context: LoweringContext, keys: KeyStatusLookup = NO_KNOWN_KEYS): LoweringVerdict {
  const reject = (cause: LoweringRejection): LoweringVerdict => ({ apply: false, cause });
  const sig = (envelope as { sig?: unknown } | null)?.sig;
  if (envelope === null || typeof envelope !== 'object' || typeof sig !== 'string' || sig === '') return reject('no-signature');
  const verdict = verifyPayload<ChatLowering>(envelope, { purpose: 'label-declassify', status: keys });
  if (!verdict.ok) {
    switch (verdict.reason) {
      case 'unknown-purpose': case 'wrong-purpose': return reject('another-purpose');
      case 'unknown-key': return reject('key-unknown');
      case 'key-revoked': return reject('key-revoked');
      case 'key-rotated': return reject('key-rotated');
      default: return reject('does-not-verify');
    }
  }
  const payload = verdict.payload as Partial<ChatLowering> | null;
  const from = markOf(payload?.from);
  const to = markOf(payload?.to);
  if (payload === null || typeof payload !== 'object' || from === undefined || to === undefined || typeof payload.chatId !== 'string') return reject('does-not-verify');
  if (payload.chatId !== context.chatId) return reject('another-chat');
  // The from-mark covers the other copy's mark: raising it by that mark changes nothing, so the lowering undoes no raise made there.
  let raised: Mark = from;
  for (const label of context.otherMark) raised = raiseMark(raised, label, SCALE_PRESETS);
  if (!sameMark(raised, from)) return reject('higher-mark');
  if (context.otherLastUsedAt > verdict.signedAt) return reject('used-after');
  return { apply: true };
}

/** The sentence a chat shows once when a lowering made on another copy was not applied (it names the Lower command). */
export function loweringRejectedText(cause: string): string {
  const why = (LOWERING_REJECTION_CAUSES as Record<string, string>)[cause] ?? LOWERING_REJECTION_CAUSES['does-not-verify'];
  return `A lowering of this chat's label made on another computer was not applied here, because ${why}. The chat keeps the higher label. To lower it on this computer, use NEAR AI: Lower This Chat's Label.`;
}

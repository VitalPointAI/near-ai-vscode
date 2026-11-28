/**
 * The person signer (Phase 33 D-60): the engine's asynchronous signer over the person's long-term key in your organization's OpenBao Transit,
 * reached only through KeyService.sign (46-07). KeyService logs in to the step-up role with the latest sign-in for every signature, so a
 * signature needs a fresh passkey or security key confirmation and OpenBao enforces it. Every refusal comes back as a value carrying KeyService's
 * own sentence and, when there is one, its fix; sign never throws. Each signature is checked against the person's public key before it is
 * returned, so a key store that answers with another key's signature signs nothing. When the key's Transit version is known (the session read
 * it with the public key), a signature by any other version is refused too, so a key rotated during the session signs nothing here.
 *
 * The signer keeps nothing between calls: no token, no signature, no message. It never logs. Nothing here imports Theia.
 *
 * One action per confirmation (33.1-17, 33.1 D-09). The invariant: a step-up token signs exactly one action, the one whose request id the step-up
 * was started for and whose summary the person saw. Nothing binds a token because it arrived next. PendingActions holds the actions of this one
 * session backend, in memory only (a restart drops every one):
 *
 *   beginAction     -> pending     a random action id, an opaque request id for the browser, a backend nonce, the SHA-256 of the exact payload
 *                                  and the summary the calling backend service built from it; every earlier action not yet resumed is cancelled
 *   pending  -> bound              bindStepUp on the return route of its own nonce: a token the person check just accepted, acr the step-up
 *                                  value, auth_time after the action began and used by no other action, sub the sub the session became active with
 *   bound    -> resumed            resumeAction with its request id and the same payload: the action id is handed out once, in one synchronous step
 *   pending  -> expired            PENDING_ACTION_MS after it began, or sooner at the step-up window
 *   bound, resumed -> expired      the step-up window (STERLING_STEPUP_MAX_AGE_SECONDS) after its bind
 *   pending, bound -> cancelled    a later beginAction
 *
 * The signer signs bytes passed with an action id only while that action is resumed and unexpired and the latest sign-in's auth_time is the one
 * bound to it; every other action id is refused with the step-up fix. Bytes passed with no action id are signed as before; the engine's append
 * path decides which kinds may come without one (requiresActionId, 33.1-17 task 3). No id, nonce, summary or token is logged or written anywhere.
 */
import { createHash, createPublicKey, randomBytes, verify as edVerify } from 'node:crypto';
import { KEY_SERVICE_TEXT } from '../../common/key-service.js';
import type { KeyService } from '../key-service.js';

/** A refusal the engine passes through to the person unchanged (`refused`), with KeyService's fix when it has one. */
export interface PersonSignRefused {
  readonly refused: string;
  readonly fix?: string;
}

/** The engine's SignOptions (src/domain/team/signedPayload.ts): the one person action the bytes belong to. */
export interface PersonSignOptions {
  readonly action?: string;
}

/** The engine's AsyncPayloadSigner shape (src/domain/team/signedPayload.ts), typed here because the extension cannot import src/. */
export interface PersonSigner {
  readonly fingerprint: string;
  /** The raw Ed25519 public key, base64url. */
  readonly publicKey: string;
  sign(bytes: Buffer, options?: PersonSignOptions): Promise<string | PersonSignRefused>;
  canSignAction?(action: string, payload: Uint8Array): boolean;
}

/** What the signer asks before it signs for an action: may this action id sign now? */
export interface ActionGate {
  authorize(action: string): boolean;
  authorizePayload?(action: string, payload: Uint8Array): boolean;
}

/** One value the person confirms, labelled. A date is formatted by the backend; every value is shown quoted. */
export interface ActionField {
  readonly label: string;
  readonly value: string;
  readonly date?: boolean;
}

/** What the person sees before the step-up: the kind (its action line is fixed, ACTION_LINES) and the payload's values. */
export interface ActionSummary {
  readonly kind: string;
  readonly fields: readonly ActionField[];
}

/** The token on a return request, as the person check just accepted it. */
export interface StepUpToken {
  readonly acr?: string;
  /** Seconds since the epoch. */
  readonly authTime?: number;
  readonly sub?: string;
  /** The sub of the token the session became active with. */
  readonly activeSub?: string;
}

export interface PendingActions extends ActionGate {
  authorizePayload(action: string, payload: Uint8Array): boolean;
  /** A new pending action: the request id goes to the browser, the nonce into the step-up address only. */
  beginAction(payload: Uint8Array, summary: ActionSummary, attachment?: unknown): { requestId: string; nonce: string };
  /** The summary of a pending, unexpired action, for its page; undefined otherwise. */
  summaryOf(nonce: string): ActionSummary | undefined;
  /** Called only by the return route. True when the token was bound to this nonce's action. */
  bindStepUp(nonce: string, token: StepUpToken): boolean;
  /** Access a server-only attachment while a review is pending or bound. */
  reviewAttachment(requestId: string): unknown;
  cancelReview(requestId: string): void;
  /** The action id, once, for a bound action and the same payload; undefined otherwise. */
  resumeAction(requestId: string, payload: Uint8Array): string | undefined;
}

export interface PendingActionOptions {
  /** STERLING_STEPUP_ACR; with none, nothing ever binds. */
  readonly stepUpAcr: string | undefined;
  /** STERLING_STEPUP_MAX_AGE_SECONDS. */
  readonly windowSeconds: number;
  /** The latest sign-in's auth_time (seconds), from the session. */
  readonly latestAuthTime: () => number | undefined;
  readonly clock?: { now(): number };
}

/** A pending action that is never confirmed ends after this, or sooner at the step-up window. */
export const PENDING_ACTION_MS = 120_000;

type ActionState = 'pending' | 'bound' | 'resumed';
interface ActionRecord {
  readonly id: string;
  readonly requestId: string;
  readonly nonce: string;
  readonly payload: string;
  readonly summary: ActionSummary;
  readonly begunAt: number;
  attachment?: unknown;
  state: ActionState;
  authTime?: number;
  boundAt?: number;
}

const randomId = (): string => randomBytes(24).toString('base64url');
const payloadHash = (payload: Uint8Array): string => createHash('sha256').update(payload).digest('hex');

/** The pending actions of one session backend. In memory only: nothing here is written to disk, the key store or a log. */
export function createPendingActions(options: PendingActionOptions): PendingActions {
  const clock = options.clock ?? { now: () => Date.now() };
  const windowMs = options.windowSeconds * 1000;
  const actions = new Map<string, ActionRecord>();
  // Each step-up auth_time serves one action only, for the life of this backend.
  const usedAuthTimes = new Set<number>();

  const expiresAt = (record: ActionRecord): number =>
    record.state === 'pending' ? record.begunAt + Math.min(PENDING_ACTION_MS, windowMs) : (record.boundAt as number) + windowMs;
  const prune = (): void => {
    const now = clock.now();
    for (const [id, record] of actions) if (now >= expiresAt(record)) actions.delete(id);
  };
  const find = (match: (record: ActionRecord) => boolean): ActionRecord | undefined => {
    prune();
    for (const record of actions.values()) if (match(record)) return record;
    return undefined;
  };

  const resumed = (action: string): ActionRecord | undefined => {
    const record = find((item) => item.id === action && item.state === 'resumed');
    return record !== undefined && record.authTime === options.latestAuthTime() ? record : undefined;
  };

  return {
    beginAction(payload, summary, attachment) {
      prune();
      for (const [id, record] of actions) if (record.state !== 'resumed') actions.delete(id);
      const record: ActionRecord = { id: randomId(), requestId: randomId(), nonce: randomId(), payload: payloadHash(payload), summary, begunAt: clock.now(), state: 'pending', attachment };
      actions.set(record.id, record);
      return { requestId: record.requestId, nonce: record.nonce };
    },
    summaryOf(nonce) {
      return find((record) => record.nonce === nonce && record.state === 'pending')?.summary;
    },
    bindStepUp(nonce, token) {
      const record = find((item) => item.nonce === nonce && item.state === 'pending');
      if (record === undefined || options.stepUpAcr === undefined || token.acr !== options.stepUpAcr) return false;
      const authTime = token.authTime;
      if (authTime === undefined || !(authTime > Math.floor(record.begunAt / 1000)) || usedAuthTimes.has(authTime)) return false;
      if (token.sub === undefined || token.activeSub === undefined || token.sub !== token.activeSub) return false;
      usedAuthTimes.add(authTime);
      record.state = 'bound';
      record.authTime = authTime;
      record.boundAt = clock.now();
      return true;
    },
    reviewAttachment(requestId) {
      return find((record) => record.requestId === requestId && record.state !== 'resumed')?.attachment;
    },
    cancelReview(requestId) {
      const record = find((item) => item.requestId === requestId && item.state !== 'resumed');
      if (record !== undefined) actions.delete(record.id);
    },
    resumeAction(requestId, payload) {
      const record = find((item) => item.requestId === requestId && item.state === 'bound');
      if (record === undefined || record.payload !== payloadHash(payload)) return undefined;
      record.state = 'resumed';
      record.attachment = undefined;
      return record.id;
    },
    authorize: (action) => resumed(action) !== undefined,
    authorizePayload: (action, payload) => resumed(action)?.payload === payloadHash(payload),
  };
}

export const PERSON_SIGNER_TEXT = {
  mismatch: "Your organization's key store signed with a key that is not your person key, so nothing was signed. Ask your administrator.",
  rotated: 'Your person key was changed while this session was open, so nothing was signed. Sign in again.',
} as const;

/**
 * The summary page and the return page of one action (33.1-17). The action line of a kind is fixed text with no payload in it; every payload
 * value is shown below it as a labelled, quoted field.
 */
export const ACTION_STEP_UP_TEXT = {
  title: 'Confirm this action',
  intro: 'Check what you are about to confirm. Your passkey or security key confirms this action only.',
  continue: 'Continue to confirm with your passkey or security key',
  notFound: 'This confirmation has ended or was replaced by a newer one, so nothing will be signed. Go back to Sterling and start again.',
  notSetUp: 'Your organization has not set up confirmation with a passkey or security key, so this action cannot be confirmed. Ask your administrator.',
  confirmed: 'Confirmed. Go back to Sterling to finish.',
  notBound: 'This confirmation does not match the action you started, so nothing will be signed. Go back to Sterling and start again.',
  back: 'Back to Sterling',
  defaultLine: 'You are about to sign a change to your shared work.',
} as const;

/** One fixed action line per kind. A kind not listed gets ACTION_STEP_UP_TEXT.defaultLine. */
export const ACTION_LINES: Readonly<Record<string, string>> = Object.freeze({
  'member.remove': 'You are about to remove a person from this shared work.',
  'position.create': 'You are about to create a position.',
  'position.update': 'You are about to change a position.',
  'position.disestablish': 'You are about to close a position.',
  'authority.delegate': 'You are about to give a person authority to fill positions.',
  'authority.revoke': 'You are about to take back authority to fill positions.',
  'posting.order': 'You are about to place a person in a position.',
  'posting.enrol': 'You are about to confirm that the keys for a position reach you.',
  'posting.report': 'You are about to take up a position.',
  'posting.unable': 'You are about to say that you cannot take up a position.',
  'posting.decide': 'You are about to decide on a person who cannot take up a position.',
  'posting.return': 'You are about to return a person to their own position.',
  'posting.end': 'You are about to end a person\'s time in a position.',
  'posting.cancel': 'You are about to cancel a placement.',
  'cell.rekey.finish': 'You are about to finish changing the key for this part of your shared work.',
  'cell.rekey.staged': 'You are about to prepare a key change.',
  'project.mode': 'You are about to change how this shared work is run.',
});

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The engine's signer fingerprint of a raw Ed25519 public key (fingerprintOf in src/domain/team/canonical.ts). */
export function signerFingerprint(publicKey: string): string {
  return `dev-${createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 32)}`;
}

/** True for a raw 32-byte Ed25519 public key written as strict base64url. */
export function isPublicKeyText(publicKey: unknown): publicKey is string {
  return typeof publicKey === 'string' && publicKey.length === 43 && BASE64URL.test(publicKey)
    && Buffer.from(publicKey, 'base64url').toString('base64url') === publicKey;
}

/** What a person signer is bound to besides its public key: the key's Transit version, and the session's pending actions (33.1-17). */
export interface PersonSignerOptions {
  readonly keyVersion?: number | undefined;
  readonly actions?: ActionGate | undefined;
}

/**
 * The person signer for the key whose raw public key is `publicKey`, and, when given, whose Transit version is `keyVersion`. Throws only for a
 * public key that is not one (a programming error); every answer of sign is a signature (base64url, as the engine verifies) or a refusal value.
 */
export function personSigner(keyService: Pick<KeyService, 'sign'>, publicKey: string, options: PersonSignerOptions = {}): PersonSigner {
  const { keyVersion, actions } = options;
  if (!isPublicKeyText(publicKey)) throw new Error('The person key must be a 32-byte Ed25519 public key written as base64url.');
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey, 'base64url')]), format: 'der', type: 'spki' });

  async function sign(bytes: Buffer, options?: PersonSignOptions): Promise<string | PersonSignRefused> {
    // An action id signs only under the step-up bound to that action (33.1 D-09); without a gate no action id can sign.
    if (options?.action !== undefined && (actions === undefined || !actions.authorize(options.action))) {
      return { refused: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm };
    }
    let answer: Awaited<ReturnType<KeyService['sign']>>;
    try {
      answer = await keyService.sign(Buffer.from(bytes).toString('base64'));
    } catch {
      return { refused: KEY_SERVICE_TEXT.unreachable };
    }
    if (answer.kind === 'refused') return answer.fix === undefined ? { refused: answer.reason } : { refused: answer.reason, fix: answer.fix };
    if (keyVersion !== undefined && answer.value.keyVersion !== keyVersion) return { refused: PERSON_SIGNER_TEXT.rotated };
    const signature = Buffer.from(answer.value.signature, 'base64');
    let matches = false;
    try {
      matches = signature.length === 64 && edVerify(null, bytes, key, signature);
    } catch {
      matches = false;
    }
    return matches ? signature.toString('base64url') : { refused: PERSON_SIGNER_TEXT.mismatch };
  }

  return { fingerprint: signerFingerprint(publicKey), publicKey, sign, canSignAction: (action, payload) => actions?.authorizePayload?.(action, payload) === true };
}

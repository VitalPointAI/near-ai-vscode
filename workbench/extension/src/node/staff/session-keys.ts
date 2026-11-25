/**
 * Session keys in a hosted session (Phase 33 P6; D-60, D-61, D-62). When the sign-in is active the backend makes a fresh Ed25519 session key,
 * in memory only. It signs the person's ordinary work (typing, compaction, proposals, verdicts, submissions). The person's long-term key, in
 * your organization's OpenBao Transit, vouches for it once per shared project with a session.certify entry signed through KeyService.sign
 * (46-07), so the engine's fold counts the session key's writes as the person's. Decisions and roster changes stay with the person key.
 *
 *   startSessionKeys   active sign-in        -> the person key's public key (read from Transit when not given), the session key, the
 *                                               person signer and the notAfter, 12 hours ahead
 *   certificate        per shared project    -> one session.certify, appended by the project with the person signer
 *                      stale sign-in         -> refused: "Confirm with your passkey or security key to work on shared projects."
 *   stop               identity at stopping  -> the session key and every secret held with it are dropped; nothing signs after
 *
 * The person key's public key is read once, through KeyService.personPublicKey: the session policy reads only transit/keys/person-<entity>,
 * read only (owner decision 2026-11-24). Every signature the person signer returns is checked against that key and its version, so a key
 * store that answered with another key, or a key rotated since, signs nothing. Right after sign-in auth_time is fresh, so the first
 * certificates need no other prompt. The private session key is never exported, stored,
 * logged or returned: only sign reaches it. Nothing here imports Theia; the engine names come from the staff engine bundle (staff-engine.ts).
 */
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { KEY_SERVICE_TEXT } from '../../common/key-service.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import type { SessionIdentityStatus } from '../../common/session-identity.js';
import type { KeyService } from '../key-service.js';
import { isPublicKeyText, personSigner, signerFingerprint, type ActionGate, type PersonSigner } from './person-signer.js';
import type { StaffEngine } from './staff-engine.js';

/** How long a session key's certificate lasts (D-62); your organization's server refuses it after notAfter. */
export const SESSION_NOT_AFTER_MS = 12 * 60 * 60 * 1000;

/** Every sentence the session keys refuse with: no em-dashes, "your organization", no key or token. */
export const SESSION_KEY_TEXT = {
  stepUp: 'Confirm with your passkey or security key to work on shared projects.',
  ended: 'This session has ended, so its session key signs nothing more.',
  noPersonKey: 'Your person key is not known to this session, so shared projects cannot be opened. Ask your administrator.',
} as const;

/** The engine's PayloadSigner shape (src/domain/team/signedPayload.ts): sign answers a base64url Ed25519 signature. */
export interface SessionSigner {
  readonly fingerprint: string;
  /** The raw Ed25519 public key, base64url. */
  readonly publicKey: string;
  /** Throws SESSION_KEY_TEXT.ended once the session's keys are stopped. */
  sign(bytes: Buffer): string;
}

/** KeyService.personPublicKey (46-07, extended for Phase 33 D-61): the person key's latest public key (base64url) and its Transit version. */
export interface PersonKeyReader {
  personPublicKey(): Promise<ServiceResult<{ readonly publicKey: string; readonly keyVersion: number }>>;
}

/** What the session needs from SessionIdentity (46-02). */
export interface SessionKeyIdentity {
  status(): SessionIdentityStatus;
}

export interface SessionKeyClock {
  now(): number;
}

/** A shared project as the certificate needs it: ReplicaProject's projectId and appendOwn, structurally. */
export interface CertifyTarget {
  readonly projectId: string;
  appendOwn(kind: string, data: unknown, options: { signer: PersonSigner }): Promise<
    { readonly ok: true; readonly hash: string; readonly built: { readonly entry: unknown } } | { readonly refused: string; readonly message: string }
  >;
}

/** A certificate as appended: its entry hash, the sealed entry (for the hub transport's first session, 33-22) and its notAfter. */
export interface SessionCertificate {
  readonly hash: string;
  readonly entry: unknown;
  readonly notAfter: string;
}

export interface SessionKeys {
  /** For ReplicaProjectDeps.sessionSigner and the hub transport's signer. */
  readonly sessionSigner: SessionSigner;
  /** For ReplicaProjectDeps.personSigner: the person key through KeyService.sign. */
  readonly personSigner: PersonSigner;
  /** ISO time the certificates end. */
  readonly notAfter: string;
  /** Certifies the session key in one shared project, where the person key is a device of `member` at `slot`. */
  certificate(target: CertifyTarget, seat: { readonly member: string; readonly slot: number }): Promise<ServiceResult<SessionCertificate>>;
  /** Keeps another session secret (the opened encryption key) to be dropped by stop; after stop it is dropped at once. */
  hold(secret: { drop(): void }): void;
  /** Drops the session key and every held secret. Idempotent. */
  stop(): void;
}

export interface SessionKeyOptions {
  /** The person key's raw Ed25519 public key, base64url (the Transit key person-<entity>). Absent: read through KeyService.personPublicKey. */
  readonly personPublicKey?: string;
  readonly engine: Pick<StaffEngine, 'sessionCertifyData' | 'writerIdOf'>;
  /** The session's pending actions (33.1-17): the person signer signs an action id only under the step-up bound to it. */
  readonly actions?: ActionGate;
}

/**
 * Makes this session's key when the sign-in is active. Refused in local mode (a single machine signs with its own device key), before the
 * sign-in is active, and without a person key; a refusal to read the person key is passed through with its own sentence. Nothing is signed
 * until a certificate is asked for.
 */
export function startSessionKeys(
  keyService: Pick<KeyService, 'sign'> & Partial<PersonKeyReader>, identity: SessionKeyIdentity, clock: SessionKeyClock, options: SessionKeyOptions,
): Promise<ServiceResult<SessionKeys>> {
  return start(keyService, identity, clock, options);
}

async function start(
  keyService: Pick<KeyService, 'sign'> & Partial<PersonKeyReader>, identity: SessionKeyIdentity, clock: SessionKeyClock, options: SessionKeyOptions,
): Promise<ServiceResult<SessionKeys>> {
  const status = identity.status();
  if (status.mode === 'local') return refused(KEY_SERVICE_TEXT.local);
  if (status.state !== 'active') return refused(KEY_SERVICE_TEXT.notReady);
  let personPublicKey = options.personPublicKey;
  let keyVersion: number | undefined;
  if (personPublicKey === undefined && keyService.personPublicKey !== undefined) {
    const read = await keyService.personPublicKey();
    if (read.kind === 'refused') return read;
    ({ publicKey: personPublicKey, keyVersion } = read.value);
  }
  if (!isPublicKeyText(personPublicKey)) return refused(SESSION_KEY_TEXT.noPersonKey);
  const personKey: string = personPublicKey;

  const { engine } = options;
  const person = personSigner(keyService, personKey, { keyVersion, actions: options.actions });
  const pair = generateKeyPairSync('ed25519');
  let privateKey: KeyObject | undefined = pair.privateKey;
  const publicKey = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64url');
  const notAfter = new Date(clock.now() + SESSION_NOT_AFTER_MS).toISOString();
  const held: Array<{ drop(): void }> = [];
  let stopped = false;

  const sessionSigner: SessionSigner = {
    fingerprint: signerFingerprint(publicKey),
    publicKey,
    sign(bytes) {
      if (privateKey === undefined) throw new Error(SESSION_KEY_TEXT.ended);
      return edSign(null, bytes, privateKey).toString('base64url');
    },
  };

  async function certificate(target: CertifyTarget, seat: { readonly member: string; readonly slot: number }): Promise<ServiceResult<SessionCertificate>> {
    if (privateKey === undefined) return refused(SESSION_KEY_TEXT.ended);
    const data = engine.sessionCertifyData({
      project: target.projectId, member: seat.member, device: engine.writerIdOf(personKey), sessionKey: publicKey, slot: seat.slot, notAfter,
    }, (bytes) => sessionSigner.sign(bytes));
    const written = await target.appendOwn('session.certify', data, { signer: person });
    if ('ok' in written) return ok({ hash: written.hash, entry: written.built.entry, notAfter });
    if (written.message === KEY_SERVICE_TEXT.stepUpNeeded) return refused(SESSION_KEY_TEXT.stepUp, KEY_SERVICE_TEXT.confirm);
    return refused(written.message);
  }

  function hold(secret: { drop(): void }): void {
    if (stopped) secret.drop();
    else held.push(secret);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    privateKey = undefined;
    for (const secret of held.splice(0)) secret.drop();
  }

  return ok({ sessionSigner, personSigner: person, notAfter, certificate, hold, stop });
}


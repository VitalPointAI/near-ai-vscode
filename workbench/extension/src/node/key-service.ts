/**
 * KeyService: the person's long-term keys, used only inside your organization's OpenBao Transit (D-20, D-21, D-25; T-46-28 to T-46-30).
 *
 *   sign(messageBase64)        transit/sign/person-<entity>, ed25519, only after a fresh passkey or security key sign-in
 *   generateWrappedDataKey()   transit/datakey/wrapped/kek-<entity>: a new data key, wrapped; no plaintext leaves OpenBao here
 *   unwrapDataKey(ciphertext)  transit/decrypt/kek-<entity>: backend only (never on the RPC), needs an active session, not step-up
 *
 * The workbench never creates, rotates, exports, configures or deletes a Transit key: Phase 47 creates person-<entity> and kek-<entity> at
 * enrolment, and a missing key is a plain refusal. Signing has two checks. Here, a guard and a clear message: the latest forwarded token's
 * acr must equal STERLING_STEPUP_ACR and its auth_time be within STERLING_STEPUP_MAX_AGE_SECONDS. In OpenBao, the enforcement: each
 * signature logs in with that forwarded token to the step-up jwt role (STERLING_OPENBAO_STEPUP_ROLE, bound to the step-up acr, with a token
 * TTL no longer than the window), signs with the short-lived token it gets, and revokes it. The session's ordinary token never signs.
 *
 * Every result is a ServiceResult; refusals are values, never throws, and carry no token, key or entity id. Nothing here imports Theia.
 */
import { KEY_SERVICE_TEXT, type KeyServiceRpc, type Signature, type WrappedDataKey } from '../common/key-service.js';
import { ok, refused, type ServiceResult } from '../common/service-result.js';
import { OpenBaoError } from './openbao-client.js';
import type { ActiveSession } from './session-identity.js';
import type { SessionIdentityStatus } from '../common/session-identity.js';

export const KeyService = Symbol('KeyService');

export interface KeyService extends KeyServiceRpc {
  /** Backend only: the plaintext data key, base64. Never offered on the RPC. */
  unwrapDataKey(ciphertext: string): Promise<ServiceResult<{ readonly plaintext: string }>>;
}

/** What the key service needs from SessionIdentity. */
export interface KeySessionSource {
  session(): ActiveSession | undefined;
  status(): SessionIdentityStatus;
}

export interface KeyClock {
  now(): number;
}

/** The largest message sign accepts, decoded. */
export const MAX_SIGN_BYTES = 64 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TRANSIT_TEXT = /^vault:v([1-9][0-9]{0,8}):([A-Za-z0-9+/]+={0,2})$/;
/** A forwarded token's auth_time may be this far ahead of the clock (skew between the identity provider and the pod). */
const CLOCK_SKEW_SECONDS = 30;

const realClock: KeyClock = { now: () => Date.now() };

function storeRefusal(error: unknown): ServiceResult<never> {
  return error instanceof OpenBaoError && error.kind === 'refused' ? refused(KEY_SERVICE_TEXT.refused) : refused(KEY_SERVICE_TEXT.unreachable);
}

/** A 400 or 404 from a Transit call names a key that is not there (Phase 47 creates the keys); any other failure is the store's. */
function missingOr(error: unknown, missing: string): ServiceResult<never> {
  if (error instanceof OpenBaoError && error.status === 400) return refused(missing);
  return storeRefusal(error);
}

export function createKeyService(identity: KeySessionSource, clock: KeyClock = realClock): KeyService {
  /** The active session, or the refusal that says why there is none. */
  function active(): ActiveSession | ServiceResult<never> {
    if (identity.status().mode === 'local') return refused(KEY_SERVICE_TEXT.local);
    return identity.session() ?? refused(KEY_SERVICE_TEXT.notReady);
  }
  const isRefusal = (value: ActiveSession | ServiceResult<never>): value is ServiceResult<never> => 'kind' in value;

  async function sign(messageBase64: string): Promise<ServiceResult<Signature>> {
    const session = active();
    if (isRefusal(session)) return session;
    if (typeof messageBase64 !== 'string' || !BASE64.test(messageBase64) || Buffer.byteLength(messageBase64, 'base64') > MAX_SIGN_BYTES) {
      return refused(KEY_SERVICE_TEXT.badMessage);
    }
    const { config } = session;
    if (config.stepUpAcr === undefined) return refused(KEY_SERVICE_TEXT.notSetUp);
    const nowSeconds = clock.now() / 1000;
    const fresh = session.acr === config.stepUpAcr && session.authTime !== undefined
      && nowSeconds - session.authTime <= config.stepUpMaxAgeSeconds && session.authTime <= nowSeconds + CLOCK_SKEW_SECONDS;
    if (!fresh) return refused(KEY_SERVICE_TEXT.stepUpNeeded, KEY_SERVICE_TEXT.confirm);

    // OpenBao's own check: only the step-up role, bound to the step-up acr, can sign.
    let stepUpToken: string;
    try {
      const answer = await session.client.request('POST', `auth/${config.jwtMount}/login`, { body: { role: config.stepUpRole, jwt: session.forwardedToken } });
      const token = (answer.json as { auth?: { client_token?: unknown } } | undefined)?.auth?.client_token;
      if (typeof token !== 'string' || token === '') return refused(KEY_SERVICE_TEXT.stepUpNeeded, KEY_SERVICE_TEXT.confirm);
      stepUpToken = token;
    } catch (error) {
      if (error instanceof OpenBaoError && error.kind === 'refused') return refused(KEY_SERVICE_TEXT.stepUpNeeded, KEY_SERVICE_TEXT.confirm);
      return refused(KEY_SERVICE_TEXT.unreachable);
    }
    try {
      const answer = await session.client.request('POST', `${config.transitMount}/sign/person-${session.entityId}`, {
        token: stepUpToken,
        body: { input: messageBase64 },
      });
      if (answer.status === 404) return refused(KEY_SERVICE_TEXT.signingKeyMissing);
      const text = (answer.json as { data?: { signature?: unknown } } | undefined)?.data?.signature;
      const parts = typeof text === 'string' ? TRANSIT_TEXT.exec(text) : null;
      if (!parts) return refused(KEY_SERVICE_TEXT.unreachable);
      return ok({ signature: parts[2], keyVersion: Number(parts[1]) });
    } catch (error) {
      return missingOr(error, KEY_SERVICE_TEXT.signingKeyMissing);
    } finally {
      await session.client.request('POST', 'auth/token/revoke-self', { token: stepUpToken }).catch(() => undefined);
    }
  }

  async function generateWrappedDataKey(): Promise<ServiceResult<WrappedDataKey>> {
    const session = active();
    if (isRefusal(session)) return session;
    try {
      const answer = await session.client.request('POST', `${session.config.transitMount}/datakey/wrapped/kek-${session.entityId}`, { token: session.token, body: {} });
      if (answer.status === 404) return refused(KEY_SERVICE_TEXT.dataKeyMissing);
      const ciphertext = (answer.json as { data?: { ciphertext?: unknown } } | undefined)?.data?.ciphertext;
      if (typeof ciphertext !== 'string' || !TRANSIT_TEXT.test(ciphertext)) return refused(KEY_SERVICE_TEXT.unreachable);
      return ok({ ciphertext });
    } catch (error) {
      return missingOr(error, KEY_SERVICE_TEXT.dataKeyMissing);
    }
  }

  async function unwrapDataKey(ciphertext: string): Promise<ServiceResult<{ readonly plaintext: string }>> {
    if (typeof ciphertext !== 'string' || ciphertext.length > 4096 || !TRANSIT_TEXT.test(ciphertext)) return refused(KEY_SERVICE_TEXT.badCiphertext);
    const session = active();
    if (isRefusal(session)) return session;
    try {
      const answer = await session.client.request('POST', `${session.config.transitMount}/decrypt/kek-${session.entityId}`, { token: session.token, body: { ciphertext } });
      if (answer.status === 404) return refused(KEY_SERVICE_TEXT.dataKeyMissing);
      const plaintext = (answer.json as { data?: { plaintext?: unknown } } | undefined)?.data?.plaintext;
      if (typeof plaintext !== 'string' || !BASE64.test(plaintext)) return refused(KEY_SERVICE_TEXT.unreachable);
      return ok({ plaintext });
    } catch (error) {
      return missingOr(error, KEY_SERVICE_TEXT.dataKeyMissing);
    }
  }

  return { sign, generateWrappedDataKey, unwrapDataKey };
}

/** The object bound at KEY_SERVICE_PATH: sign and generateWrappedDataKey only, so the browser can never unwrap a data key (T-46-29). */
export function keyServiceRpc(service: KeyService): KeyServiceRpc {
  return {
    sign: (messageBase64) => service.sign(messageBase64),
    generateWrappedDataKey: () => service.generateWrappedDataKey(),
  };
}

/**
 * GuestSecretsService (Phase 47 D-84, owner 2026-11-25; plan 47-34): a security officer removes ended guests' secrets after your
 * organization's retention period, in their own session.
 *
 *   notice()        logs in to the jwt role security-officer-notices with the forwarded sign-in token (only the site's named security
 *                   officers are admitted) and reads the count the hourly check wrote; anyone else gets null and sees nothing
 *   candidates()    after a fresh passkey or security key step-up, logs in to the jwt role guest-secrets-removal (the step-up acr and the
 *                   named officers; the token lives at most the step-up window) and lists the newest end record of each guest whose
 *                   removeAfter has passed, whose entity is disabled and that has no removal record
 *   remove(record)  the same login and checks for that one record, then writes one create-only removal record (which guest, when, by
 *                   whom (the officer's entity) and how many secrets) and only then deletes every secret under the guest entity's own KV
 *                   path (kv/metadata/guests/<entity id>/..., every version). If the record cannot be written, or another officer wrote it
 *                   first, nothing is deleted. If a delete fails, the guest is offered again and the next removal finishes the deletes
 *                   under the record already written.
 *
 * The step-up token is the only token that can delete, it is used for one call and revoked. OpenBao's audit device records every request.
 * Every result is a ServiceResult; refusals carry no token or entity id. Nothing here imports Theia.
 */
import { GUEST_SECRETS_TEXT, type EndedGuest, type GuestSecretsNotice, type GuestSecretsRpc } from '../common/guest-secrets.js';
import { ok, refused, type ServiceResult } from '../common/service-result.js';
import type { SessionIdentityStatus } from '../common/session-identity.js';
import { ownFolder } from './kv-path.js';
import { OpenBaoError } from './openbao-client.js';
import type { ActiveSession } from './session-identity.js';

export const GuestSecretsService = Symbol('GuestSecretsService');
export type GuestSecretsService = GuestSecretsRpc;

/** The jwt roles Phase 47 defines (deploy/openbao/apply.mjs). */
export const REMOVAL_ROLE = 'guest-secrets-removal';
export const NOTICE_ROLE = 'security-officer-notices';
export const NOTICE_PATH = 'site/notices/guest-secrets-removal';
export const REMOVED_FORMAT = 'sterling-guest-secrets-removed/1';
/** An end record's name: guest-<Keycloak id>-<end time, yyyymmddThhmmssZ> (deploy/keycloak/guests.mjs). */
const RECORD = /^(guest-[A-Za-z0-9-]{1,64})-(\d{8}T\d{6}Z)$/;
/** A KV key name as OpenBao lists it: a name, or a folder ending in a slash. */
const KEY_NAME = /^[^/]+\/?$/;
const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLOCK_SKEW_SECONDS = 30;
const MAX_SECRETS = 10_000;

export interface GuestSecretsSessionSource {
  session(): ActiveSession | undefined;
  status(): SessionIdentityStatus;
}

/** An ended guest due for removal, as the service sees it (the RPC shows only record, endedAt and removeAfter). */
interface Due extends EndedGuest {
  readonly entity: string;
  readonly entityId: string;
  /** A removal record exists already: an earlier removal whose deletes did not all finish. */
  readonly recorded: boolean;
}

export interface GuestSecretsClock {
  now(): number;
}

const realClock: GuestSecretsClock = { now: () => Date.now() };
const isoNow = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function createGuestSecretsService(identity: GuestSecretsSessionSource, clock: GuestSecretsClock = realClock): GuestSecretsService {
  function active(): ActiveSession | ServiceResult<never> {
    if (identity.status().mode === 'local') return refused(GUEST_SECRETS_TEXT.local);
    return identity.session() ?? refused(GUEST_SECRETS_TEXT.notReady);
  }
  const isRefusal = (value: ActiveSession | ServiceResult<never>): value is ServiceResult<never> => 'kind' in value;

  async function login(session: ActiveSession, role: string): Promise<string | undefined> {
    const answer = await session.client.request('POST', `auth/${session.config.jwtMount}/login`, { body: { role, jwt: session.forwardedToken } });
    const token = (answer.json as { auth?: { client_token?: unknown } } | undefined)?.auth?.client_token;
    return typeof token === 'string' && token !== '' ? token : undefined;
  }

  async function revoke(session: ActiveSession, token: string): Promise<void> {
    await session.client.request('POST', 'auth/token/revoke-self', { token }).catch(() => undefined);
  }

  async function notice(): Promise<ServiceResult<GuestSecretsNotice | null>> {
    const session = active();
    if (isRefusal(session)) return session;
    let token: string | undefined;
    try {
      token = await login(session, NOTICE_ROLE);
    } catch (error) {
      // Refused: not one of the site's named security officers. The notice is theirs only.
      if (error instanceof OpenBaoError && error.kind === 'refused') return ok(null);
      return refused(GUEST_SECRETS_TEXT.unreachable);
    }
    if (token === undefined) return ok(null);
    try {
      const answer = await session.client.request('GET', `${session.config.kvMount}/data/${NOTICE_PATH}`, { token });
      const data = (answer.json as { data?: { data?: { count?: unknown; checkedAt?: unknown } } } | undefined)?.data?.data;
      if (answer.status === 404 || data === undefined) return ok(null);
      const count = Number(data.count);
      if (!Number.isSafeInteger(count) || count < 0 || typeof data.checkedAt !== 'string') return refused(GUEST_SECRETS_TEXT.unreachable);
      return ok({ count, checkedAt: data.checkedAt });
    } catch {
      return refused(GUEST_SECRETS_TEXT.unreachable);
    } finally {
      await revoke(session, token);
    }
  }

  /** The step-up login: the fresh-sign-in guard first, then OpenBao's own check (the role is bound to the step-up acr and the officers). */
  async function stepUp(session: ActiveSession): Promise<string | ServiceResult<never>> {
    const { config } = session;
    if (config.stepUpAcr === undefined) return refused(GUEST_SECRETS_TEXT.notOfficer);
    const nowSeconds = clock.now() / 1000;
    const fresh = session.acr === config.stepUpAcr && session.authTime !== undefined
      && nowSeconds - session.authTime <= config.stepUpMaxAgeSeconds && session.authTime <= nowSeconds + CLOCK_SKEW_SECONDS;
    if (!fresh) return refused(GUEST_SECRETS_TEXT.stepUpNeeded, GUEST_SECRETS_TEXT.confirm);
    try {
      return (await login(session, REMOVAL_ROLE)) ?? refused(GUEST_SECRETS_TEXT.notOfficer);
    } catch (error) {
      // With a fresh step-up, a refused login means this person is not one of the named security officers.
      if (error instanceof OpenBaoError && error.kind === 'refused') return refused(GUEST_SECRETS_TEXT.notOfficer);
      return refused(GUEST_SECRETS_TEXT.unreachable);
    }
  }

  async function list(session: ActiveSession, token: string, path: string): Promise<string[]> {
    // OpenBao's LIST verb, sent as GET with list=true (Node's HTTP client has no LIST method).
    const answer = await session.client.request('GET', `${session.config.kvMount}/metadata/${path}?list=true`, { token });
    if (answer.status === 404) return [];
    const keys = (answer.json as { data?: { keys?: unknown } } | undefined)?.data?.keys;
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string' && KEY_NAME.test(key) && key !== '../' && key !== './') : [];
  }

  /** Every secret name under one guest's own folder, guests/<entity id>/, folder by folder; nothing outside it. Undefined past MAX_SECRETS. */
  async function secretsOf(session: ActiveSession, token: string, entityId: string): Promise<string[] | undefined> {
    const secrets: string[] = [];
    const folders = [''];
    while (folders.length) {
      const folder = folders.shift()!;
      for (const key of await list(session, token, `${ownFolder(entityId, 'guests')}/${folder}`)) {
        if (key.endsWith('/')) folders.push(`${folder}${key}`); else secrets.push(`${folder}${key}`);
        if (secrets.length + folders.length > MAX_SECRETS) return undefined;
      }
    }
    return secrets;
  }

  /**
   * The ended guests due now: the newest end record per guest, past removeAfter, with a disabled entity, and either no removal record yet or
   * a removal record whose deletes did not all finish (secrets still under the guest's folder; `recorded` is then true).
   */
  async function due(session: ActiveSession, token: string): Promise<Due[]> {
    const removed = new Set(await list(session, token, 'site/guest-secrets-removed/'));
    const newest = new Map<string, string>();
    for (const key of (await list(session, token, 'site/guest-ended/')).sort().reverse()) {
      const parts = RECORD.exec(key);
      if (parts && !newest.has(parts[1]!)) newest.set(parts[1]!, key);
    }
    const now = isoNow(clock.now());
    const out: Due[] = [];
    for (const [entity, record] of newest) {
      const read = await session.client.request('GET', `${session.config.kvMount}/data/site/guest-ended/${record}`, { token });
      const data = (read.json as { data?: { data?: { entity?: unknown; endedAt?: unknown; removeAfter?: unknown } } } | undefined)?.data?.data;
      if (read.status === 404 || data?.entity !== entity || typeof data.removeAfter !== 'string' || typeof data.endedAt !== 'string') continue;
      if (!(data.removeAfter <= now)) continue;
      const found = await session.client.request('GET', `identity/entity/name/${entity}`, { token });
      const info = (found.json as { data?: { disabled?: unknown; name?: unknown; id?: unknown } } | undefined)?.data;
      if (found.status === 404 || info?.name !== entity || info.disabled !== true) continue;
      if (typeof info.id !== 'string' || !ENTITY_ID.test(info.id)) continue;
      const recorded = removed.has(record);
      // A recorded removal is offered again only while secrets are left (a delete that failed after the record was written).
      if (recorded && (await secretsOf(session, token, info.id))?.length === 0) continue;
      out.push({ record, entity, entityId: info.id, recorded, endedAt: data.endedAt, removeAfter: data.removeAfter });
    }
    return out.sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  }

  async function candidates(): Promise<ServiceResult<readonly EndedGuest[]>> {
    const session = active();
    if (isRefusal(session)) return session;
    const token = await stepUp(session);
    if (typeof token !== 'string') return token;
    try {
      return ok((await due(session, token)).map(({ record, endedAt, removeAfter }) => ({ record, endedAt, removeAfter })));
    } catch {
      return refused(GUEST_SECRETS_TEXT.unreachable);
    } finally {
      await revoke(session, token);
    }
  }

  async function remove(record: string): Promise<ServiceResult<{ readonly removed: number }>> {
    if (typeof record !== 'string' || !RECORD.test(record)) return refused(GUEST_SECRETS_TEXT.badRecord);
    const session = active();
    if (isRefusal(session)) return session;
    const token = await stepUp(session);
    if (typeof token !== 'string') return token;
    const kv = session.config.kvMount;
    const recordPath = `${kv}/data/site/guest-secrets-removed/${record}`;
    try {
      // The same checks as the list, for this record, just before acting.
      const target = (await due(session, token)).find((guest) => guest.record === record);
      if (target === undefined) return refused(GUEST_SECRETS_TEXT.notDue);
      const secrets = await secretsOf(session, token, target.entityId);
      if (secrets === undefined) return refused(GUEST_SECRETS_TEXT.unreachable);
      if (!target.recorded) {
        // The create-only removal record first (cas 0): nothing is deleted unless it is written. A second officer acting at the same time
        // finds it written and deletes nothing; a write that fails deletes nothing.
        const self = await session.client.request('GET', 'auth/token/lookup-self', { token });
        const removedBy = (self.json as { data?: { entity_id?: unknown } } | undefined)?.data?.entity_id;
        try {
          await session.client.request('POST', recordPath, {
            token,
            body: { options: { cas: 0 }, data: { format: REMOVED_FORMAT, entity: target.entity, record, removedAt: isoNow(clock.now()), removedBy: typeof removedBy === 'string' ? removedBy : '', secrets: secrets.length } },
          });
        } catch (error) {
          if (!(error instanceof OpenBaoError && error.kind === 'refused')) return refused(GUEST_SECRETS_TEXT.unreachable);
          // Refused: either the record exists now (check-and-set) or the write is not allowed. Only the first is another officer.
          const written = await session.client.request('GET', recordPath, { token }).catch(() => undefined);
          return refused(written !== undefined && written.status !== 404 ? GUEST_SECRETS_TEXT.removedByOther : GUEST_SECRETS_TEXT.unreachable);
        }
      }
      // Recorded: delete every secret under the guest's own folder, every version. A failed delete is counted, and the guest is offered again.
      let removed = 0;
      for (const secret of secrets) {
        try {
          await session.client.request('DELETE', `${kv}/metadata/${ownFolder(target.entityId, 'guests')}/${secret}`, { token });
          removed += 1;
        } catch {
          // Counted below; the record is written, so the next removal finishes this one.
        }
      }
      if (removed < secrets.length) return refused(GUEST_SECRETS_TEXT.unfinished(secrets.length - removed), GUEST_SECRETS_TEXT.command);
      return ok({ removed });
    } catch {
      return refused(GUEST_SECRETS_TEXT.unreachable);
    } finally {
      await revoke(session, token);
    }
  }

  return { notice, candidates, remove };
}

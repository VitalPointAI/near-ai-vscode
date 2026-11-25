/**
 * The person's own identity in a hosted session (Phase 71, 71-10; D-07, D-13, D-15, VCRD-06). Backend only.
 *
 *   ensurePersonDid()   once the session is active: the person's did:webvh, made by their own backend. The genesis entry names their Transit
 *                       person key (update key and assertion key) and is signed through KeyService.sign, which needs a fresh sign-in step-up
 *                       that OpenBao itself enforces. The log is kept under the person's own KV prefix, then the site directory entry
 *                       kv/site/people/<own entity> = { did } is created (create only, a path templated on the caller's own entity, so nobody
 *                       can claim another person's DID). A second session finds them and makes nothing.
 *   publishToHub(hub)   at the person's first session with your organization's server: posts the log through that authenticated hub session
 *                       (POST /v1/trust/did/people/<id>/did.jsonl, 71-09), once (owner decision A, 2026-11-24: never a first log without a
 *                       session, never an officer publishing for the person).
 *   bindComputer(...)   in the person's own session, after the step-up: a DeviceBindingCredential { device, class } for a single computer's
 *                       did:key, once the person has compared the computer's six words. Returned as a .near-vc file the computer's wallet
 *                       imports; a lost computer is cut off by revoking that one credential, with no change to the person's DID.
 *   collectInbox(check) at session start, after ensurePersonDid (71-12, D-15): each item an officer left in the person's own inbox
 *                       (kv/users/<entity>/credentials-inbox/<hash>) is checked, moved into the person's own wallet folder
 *                       (kv/users/<entity>/credentials-wallet/<hash>) and removed from the inbox; an item that does not check stays out of
 *                       the wallet and is reported in one sentence. Only the person's own token reads either folder.
 *
 * Nothing is made half-way: a step-up refusal, or a secret store that does not answer, writes nothing and leaves the state pending with one
 * sentence and Retry. Never logs a DID log, a key, a token or an entity id. Nothing here imports Theia.
 */
import { randomBytes } from 'node:crypto';
import { IDENTITY_TEXT, type BoundComputerFile, type DeviceClass, type IdentityStatus } from '../../common/identity.js';
import { INBOX_TEXT } from '../../common/issuer-service.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import type { KeyService } from '../key-service.js';
import type { ActiveSession } from '../session-identity.js';

/** The pure code the service runs, from engine/identity.cjs (tools/identity-entry.ts): the extension's own did:webvh and credential code. */
export interface IdentityEngine {
  buildGenesisEntry(input: Record<string, unknown>, signer: EngineSigner): Promise<{ readonly did: string; readonly line: string }>;
  verifyWebvhLog(log: string, options: { readonly now: number }): { readonly ok: boolean };
  encodePublicKeyMultibase(type: 'Ed25519', key: Uint8Array): string;
  issueCredential(signer: EngineSigner, unsigned: Record<string, unknown>, suite: 'eddsa-jcs-2022', options: { readonly scales: unknown }): Promise<Record<string, unknown>>;
  readonly CREDENTIAL_CONTEXTS: readonly string[];
  readonly SCALE_PRESETS: unknown;
  deviceIdentityWords(did: string): string[];
  deviceFingerprint(did: string): string;
}

export interface EngineSigner {
  readonly verificationMethod: string;
  readonly suite: 'eddsa-jcs-2022';
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

/** KV v2 under the session's own token. */
export interface IdentityKv {
  read(path: string): Promise<Record<string, unknown> | undefined>;
  /** Creates only (check-and-set 0): 'exists' when something is there already. */
  create(path: string, data: Record<string, unknown>): Promise<'created' | 'exists'>;
  write(path: string, data: Record<string, unknown>): Promise<void>;
  /** The names in a folder ("" for none); needed by the inbox pickup only. */
  list?(folder: string): Promise<readonly string[]>;
  /** Removes every version of an entry; needed by the inbox pickup only. */
  remove?(path: string): Promise<void>;
}

/** Checks one inbox item's credential for the holder `did` (71-12's inboxVerifier): its label when it checks, or why not. */
export type InboxCheck = (credential: unknown, did: string) => Promise<{ readonly ok: true; readonly hash: string; readonly label: string } | { readonly ok: false; readonly unchecked: boolean }>;

/** What the pickup found: the sentences to tell the person (none when nothing arrived). */
export interface InboxResult {
  readonly arrived: number;
  readonly refused: number;
  readonly waiting: number;
  readonly sentences: readonly string[];
}

/** The person's authenticated session with your organization's server (a hub session, 33-23); its answer status only. */
export interface HubTrustSession {
  postLog(path: string, log: string): Promise<{ readonly status: number }>;
}

/** Status list indexes for a new credential, from your organization's issuance setup (71-12). */
export interface StatusAllocator {
  allocate(): Promise<{ readonly revocation: StatusSlot; readonly suspension: StatusSlot } | undefined>;
}
export interface StatusSlot { readonly list: string; readonly index: number }

export interface IdentityServiceDeps {
  readonly keys: Pick<KeyService, 'sign' | 'personPublicKey'>;
  readonly kv: IdentityKv;
  /** The active session's entity id, or undefined. */
  readonly entityId: () => string | undefined;
  /** Loaded on first use; undefined when the bundle is missing (then nothing is made). */
  readonly engine: () => IdentityEngine | undefined;
  /** The host people's DIDs live under (STERLING_DID_DOMAIN), for example hq.example.org; undefined: identities are not set up here. */
  readonly domain: string | undefined;
  readonly now?: () => number;
  /** The random part of a person's DID path: never a name (71-RESEARCH.md). */
  readonly randomId?: () => string;
  readonly statusAllocator?: StatusAllocator;
}

export interface IdentityService {
  ensurePersonDid(): Promise<IdentityStatus>;
  status(): IdentityStatus;
  publishToHub(hub: HubTrustSession): Promise<ServiceResult<{ readonly posted: boolean }>>;
  bindComputer(didKey: string, words: string, deviceClass: DeviceClass): Promise<ServiceResult<BoundComputerFile>>;
  collectInbox(check: InboxCheck): Promise<InboxResult>;
  /** The sentences of the last pickup, given once: a second call answers none. */
  inboxNews(): readonly string[];
}

export const PERSON_DID_FORMAT = 'sterling-person-did/1';
export const directoryPath = (entity: string): string => `site/people/${entity}`;
export const ownRecordPath = (entity: string): string => `users/${entity}/identity/did-webvh`;

const DID_KEY = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const BINDING_DAYS = 365;
const PENDING: IdentityStatus = { state: 'pending', message: IDENTITY_TEXT.notSetUp, action: IDENTITY_TEXT.retry };

/** A signing refusal carried out of the engine's signer callback, so the caller returns the key service's own sentence. */
class SignRefused extends Error {
  constructor(readonly result: ServiceResult<never>) {
    super('signing refused');
  }
}

interface OwnRecord { readonly did: string; readonly path: string; readonly log: string; readonly published: boolean }

function ownRecordOf(data: Record<string, unknown> | undefined): OwnRecord | undefined {
  if (data?.format !== PERSON_DID_FORMAT) return undefined;
  const { did, path, log, published } = data;
  if (typeof did !== 'string' || typeof path !== 'string' || typeof log !== 'string' || typeof published !== 'boolean') return undefined;
  return { did, path, log, published };
}

const iso = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

function documentFor(multikey: string): (did: string) => Record<string, unknown> {
  return (did) => ({
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'], id: did, controller: did,
    verificationMethod: [{ id: `${did}#key-1`, type: 'Multikey', controller: did, publicKeyMultibase: multikey }],
    authentication: [`${did}#key-1`], assertionMethod: [`${did}#key-1`],
  });
}

export function createIdentityService(deps: IdentityServiceDeps): IdentityService {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? ((): string => randomBytes(8).toString('hex'));
  let current: IdentityStatus = { state: 'not-configured' };
  let running: Promise<IdentityStatus> | undefined;
  let news: readonly string[] = [];

  /** The person key as a signer: each signature goes through KeyService.sign (the step-up), and must come from the key version read. */
  function signerFor(verificationMethod: string, keyVersion: number): EngineSigner {
    return {
      verificationMethod,
      suite: 'eddsa-jcs-2022',
      async sign(bytes) {
        const answer = await deps.keys.sign(Buffer.from(bytes).toString('base64'));
        if (answer.kind !== 'ok') throw new SignRefused(answer as ServiceResult<never>);
        if (answer.value.keyVersion !== keyVersion) throw new SignRefused(refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry));
        return new Uint8Array(Buffer.from(answer.value.signature, 'base64'));
      },
    };
  }

  async function make(): Promise<IdentityStatus> {
    const entity = deps.entityId();
    const engine = deps.engine();
    if (deps.domain === undefined || !DOMAIN.test(deps.domain) || entity === undefined || engine === undefined) return { state: 'not-configured' };
    try {
      const own = ownRecordOf(await deps.kv.read(ownRecordPath(entity)));
      if (own !== undefined) {
        // Made in an earlier session (perhaps one that stopped before the directory entry): finish the entry, sign nothing.
        if ((await deps.kv.read(directoryPath(entity))) === undefined) await deps.kv.create(directoryPath(entity), { did: own.did });
        return { state: 'ready', did: own.did, published: own.published };
      }
      const listed = await deps.kv.read(directoryPath(entity));
      if (typeof listed?.did === 'string') return { state: 'ready', did: listed.did, published: false };

      const key = await deps.keys.personPublicKey();
      if (key.kind !== 'ok') return PENDING;
      const multikey = engine.encodePublicKeyMultibase('Ed25519', new Uint8Array(Buffer.from(key.value.publicKey, 'base64url')));
      const id = randomId();
      let genesis: { did: string; line: string };
      try {
        genesis = await engine.buildGenesisEntry(
          { domain: deps.domain, path: ['people', id], updateKeys: [multikey], portable: false, versionTime: iso(now()), document: documentFor(multikey) },
          signerFor(`did:key:${multikey}#${multikey}`, key.value.keyVersion),
        );
      } catch (error) {
        if (error instanceof SignRefused) return PENDING;
        throw error;
      }
      const log = `${genesis.line}\n`;
      if (!engine.verifyWebvhLog(log, { now: now() }).ok) return PENDING;
      const record = { format: PERSON_DID_FORMAT, did: genesis.did, path: `people/${id}`, log, published: false };
      if ((await deps.kv.create(ownRecordPath(entity), record)) === 'exists') {
        // Another of the person's sessions made it a moment ago: use that one, and this signature is never used.
        const other = ownRecordOf(await deps.kv.read(ownRecordPath(entity)));
        return other === undefined ? PENDING : { state: 'ready', did: other.did, published: other.published };
      }
      await deps.kv.create(directoryPath(entity), { did: genesis.did });
      return { state: 'ready', did: genesis.did, published: false };
    } catch {
      // The secret store did not answer: whatever was written is finished at the next try, and nothing is ever signed twice for it.
      return PENDING;
    }
  }

  async function ensurePersonDid(): Promise<IdentityStatus> {
    running ??= make().finally(() => {
      running = undefined;
    });
    current = await running;
    return current;
  }

  async function publishToHub(hub: HubTrustSession): Promise<ServiceResult<{ readonly posted: boolean }>> {
    const entity = deps.entityId();
    if (entity === undefined) return refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry);
    let own: OwnRecord | undefined;
    try {
      own = ownRecordOf(await deps.kv.read(ownRecordPath(entity)));
    } catch {
      return refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry);
    }
    if (own === undefined) return refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry);
    if (own.published) return ok({ posted: false });
    let status: number;
    try {
      status = (await hub.postLog(own.path, own.log)).status;
    } catch {
      return refused(IDENTITY_TEXT.notPublished);
    }
    if (status !== 200 && status !== 201) return refused(IDENTITY_TEXT.notPublished);
    try {
      await deps.kv.write(ownRecordPath(entity), { format: PERSON_DID_FORMAT, did: own.did, path: own.path, log: own.log, published: true });
    } catch {
      // The server has the log; the next session posts it again and the server answers that it holds it already.
    }
    current = { state: 'ready', did: own.did, published: true };
    return ok({ posted: true });
  }

  async function bindComputer(didKey: string, words: string, deviceClass: DeviceClass): Promise<ServiceResult<BoundComputerFile>> {
    const entity = deps.entityId();
    const engine = deps.engine();
    if (entity === undefined || engine === undefined) return refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry);
    if (typeof didKey !== 'string' || !DID_KEY.test(didKey)) return refused(IDENTITY_TEXT.notADevice);
    const shown = typeof words === 'string' ? words.trim().toLowerCase().split(/\s+/).join(' ') : '';
    if (shown !== engine.deviceIdentityWords(didKey).join(' ')) return refused(IDENTITY_TEXT.wordsDiffer);
    if (deviceClass !== 'personal' && deviceClass !== 'managed') return refused(IDENTITY_TEXT.notADevice);
    let own: OwnRecord | undefined;
    try {
      own = ownRecordOf(await deps.kv.read(ownRecordPath(entity)));
    } catch {
      own = undefined;
    }
    if (own === undefined) return refused(IDENTITY_TEXT.notSetUp, IDENTITY_TEXT.retry);
    const slots = await deps.statusAllocator?.allocate();
    if (slots === undefined) return refused(IDENTITY_TEXT.noStatusLists);
    const key = await deps.keys.personPublicKey();
    if (key.kind !== 'ok') return key as ServiceResult<never>;
    const from = now();
    const entry = (purpose: string, slot: StatusSlot): Record<string, unknown> => ({
      type: 'BitstringStatusListEntry', statusPurpose: purpose, statusListIndex: String(slot.index), statusListCredential: slot.list,
    });
    let credential: Record<string, unknown>;
    try {
      credential = await engine.issueCredential(signerFor(`${own.did}#key-1`, key.value.keyVersion), {
        '@context': [...engine.CREDENTIAL_CONTEXTS], type: ['VerifiableCredential', 'DeviceBindingCredential'], issuer: own.did,
        validFrom: iso(from), validUntil: iso(from + BINDING_DAYS * 86_400_000),
        credentialSubject: { id: didKey, device: engine.deviceFingerprint(didKey), class: deviceClass },
        credentialStatus: [entry('revocation', slots.revocation), entry('suspension', slots.suspension)],
      }, 'eddsa-jcs-2022', { scales: engine.SCALE_PRESETS });
    } catch (error) {
      if (error instanceof SignRefused) return error.result;
      throw error;
    }
    return ok({ fileName: `computer-${engine.deviceFingerprint(didKey).slice(4, 12)}.near-vc`, text: `${JSON.stringify(credential, null, 2)}\n` });
  }

  async function collectInbox(check: InboxCheck): Promise<InboxResult> {
    const nothing: InboxResult = { arrived: 0, refused: 0, waiting: 0, sentences: [] };
    const entity = deps.entityId();
    if (entity === undefined || deps.kv.list === undefined || deps.kv.remove === undefined) return nothing;
    let own: OwnRecord | undefined;
    try {
      own = ownRecordOf(await deps.kv.read(ownRecordPath(entity)));
    } catch {
      return nothing;
    }
    if (own === undefined) return nothing;
    const labels: string[] = [];
    let refusedCount = 0;
    let waiting = 0;
    try {
      for (const name of await deps.kv.list(`${inboxFolder(entity)}/`)) {
        if (!/^[0-9a-f]{64}$/.test(name)) continue;
        const item = await deps.kv.read(`${inboxFolder(entity)}/${name}`);
        const checked = item?.format === 'sterling-inbox-item/1' ? await check(item.credential, own.did) : { ok: false as const, unchecked: false };
        if (!checked.ok) {
          // Left where it is: an officer can see it was not taken, and a check that could not run yet runs at the next session.
          if (checked.unchecked) waiting += 1;
          else refusedCount += 1;
          continue;
        }
        await deps.kv.create(`users/${entity}/credentials-wallet/${checked.hash}`, { format: 'sterling-wallet-item/1', credential: item?.credential });
        await deps.kv.remove(`${inboxFolder(entity)}/${name}`);
        labels.push(checked.label);
      }
    } catch {
      // The store stopped answering: what moved has moved, and the rest is picked up at the next session.
    }
    const sentences = [
      ...(labels.length > 0 ? [INBOX_TEXT.arrived(labels)] : []),
      ...(refusedCount > 0 ? [INBOX_TEXT.refused(refusedCount)] : []),
      ...(waiting > 0 ? [INBOX_TEXT.unchecked] : []),
    ];
    news = sentences;
    return { arrived: labels.length, refused: refusedCount, waiting, sentences };
  }

  function inboxNews(): readonly string[] {
    const given = news;
    news = [];
    return given;
  }

  return { ensurePersonDid, status: () => current, publishToHub, bindComputer, collectInbox, inboxNews };
}

const inboxFolder = (entity: string): string => `users/${entity}/credentials-inbox`;

/** KV v2 at the session's KV mount, with the session's own token: a 404 reads as nothing, a check-and-set refusal as 'exists'. */
export function openBaoKv(session: () => ActiveSession | undefined): IdentityKv {
  const active = (): ActiveSession => {
    const found = session();
    if (found === undefined) throw new Error('no active session');
    return found;
  };
  return {
    async read(path) {
      const s = active();
      const answer = await s.client.request('GET', `${s.config.kvMount}/data/${path}`, { token: s.token });
      if (answer.status === 404) return undefined;
      const data = (answer.json as { data?: { data?: unknown } } | undefined)?.data?.data;
      return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
    },
    async create(path, data) {
      const s = active();
      try {
        await s.client.request('POST', `${s.config.kvMount}/data/${path}`, { token: s.token, body: { options: { cas: 0 }, data } });
        return 'created';
      } catch (error) {
        if ((error as { status?: number }).status === 400) return 'exists';
        throw error;
      }
    },
    async write(path, data) {
      const s = active();
      await s.client.request('POST', `${s.config.kvMount}/data/${path}`, { token: s.token, body: { data } });
    },
    async list(folder) {
      const s = active();
      const answer = await s.client.request('GET', `${s.config.kvMount}/metadata/${folder}?list=true`, { token: s.token });
      const keys = (answer.json as { data?: { keys?: unknown } } | undefined)?.data?.keys;
      return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
    },
    async remove(path) {
      const s = active();
      await s.client.request('DELETE', `${s.config.kvMount}/metadata/${path}`, { token: s.token });
    },
  };
}

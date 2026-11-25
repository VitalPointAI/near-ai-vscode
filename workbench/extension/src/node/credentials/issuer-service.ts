/**
 * Issuing, revoking and suspending credentials in the officer's own session (Phase 71, 71-12; D-07, D-14, D-15, D-22; O4, O7). Backend only.
 *
 *   issue(request)        the officer's role credentials are checked with issuerAuthority first (no signature for a type, level or subject the
 *                         role does not allow; never a did:key subject); then the issuer step-up login (OpenBao role sterling-issuer-stepup:
 *                         the step-up acr and the officer's own sub, named in the site file), a status list place for each purpose claimed once
 *                         (check-and-set 0, one retry on a clash), the signature with the officer's person key through KeyService.sign, the
 *                         inbox item kv/users/<entity>/credentials-inbox/<hash> (create only) or a .near-vc file, and the issued register entry
 *                         kv/site/issued/<entity>/<hash> (no credential body).
 *   revoke, suspend       the bit is set in the next version of the list, signed by the status-list key through the issuer step-up token, and
 *                         put on your organization's server with its compare-and-swap; a clash re-reads the list and tries once more.
 *   clearSuspension       only a holder of a role for that type, after a step-up; a revocation is never cleared, by anything.
 *   listRevocationRequests, resolveRequest
 *                         the requests 47-20 and 47-31 file (sterling-revocation-request/1), each resolved through the OpenBao entity and the
 *                         people directory to the person's DID, showing the officer only what they issued to that person. A request is removed
 *                         only once every credential issued to that person, by any officer, is revoked or suspended in the newest lists.
 *
 * Issuing is a person's act only: an agent or unattended caller is refused before anything else (D-07), and the step-up needs the person's
 * passkey. Refusals are ServiceResults with one sentence; nothing here logs a credential, a key, a token, an entity id or a status index, and
 * none of them reaches the browser. Nothing here imports Theia.
 */
import { randomInt } from 'node:crypto';
import { ISSUER_TEXT, REVOCATION_REASON_TEXT, type IssuableType, type IssueFormField, type IssueReview, type IssueRequest, type IssueResult, type IssuedCredentialView, type RevocationComputerView, type RevocationReason, type RevocationRequestView } from '../../common/issuer-service.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import type { KeyService } from '../key-service.js';
import type { EngineSigner } from './identity-service.js';
import { COMPUTER_LOST_REASON, DEVICE_INDEX_FROM, MAX_COMPUTERS, slotPath, slotRecordOf, type DeviceSlotRecord } from './device-slots.js';

/** The pure code the service runs, from engine/identity.cjs (tools/identity-entry.ts). Types are loose on purpose: the engine checks shapes. */
export interface IssuerEngine {
  readCredential(value: unknown, scales: unknown, options: { readonly signed: boolean }): { readonly ok: true; readonly value: ReadView } | { readonly ok: false };
  verifyCredential(value: unknown, options: { readonly publicKey: unknown; readonly scales: unknown; readonly at?: number }): { readonly ok: boolean };
  issueCredential(signer: EngineSigner, unsigned: Record<string, unknown>, suite: 'eddsa-jcs-2022', options: { readonly scales: unknown }): Promise<Record<string, unknown>>;
  credentialHash(value: unknown): string;
  issuerAuthority(credential: unknown, roles: readonly { readonly credential: unknown; readonly statusClear: boolean }[], policy: IssuerPolicy, didState: { readonly states: Readonly<Record<string, unknown>> }):
  { readonly ok: boolean; readonly role?: { readonly validUntil: string } };
  verifyWebvhLog(log: string, options: { readonly now: number }): { readonly ok: true; readonly state: unknown } | { readonly ok: false };
  methodsAt(state: unknown, at: number): readonly { readonly id: string; readonly publicKeyMultibase: string }[];
  decodePublicKeyMultibase(text: string): unknown;
  encodePublicKeyMultibase(type: 'Ed25519', key: Uint8Array): string;
  buildStatusList(input: Record<string, unknown>): Record<string, unknown>;
  signStatusList(signer: EngineSigner, unsigned: Record<string, unknown>, suite: 'eddsa-jcs-2022'): Promise<Record<string, unknown>>;
  verifyStatusList(value: unknown, issuerKey: unknown, at?: number): { readonly ok: true; readonly list: ListState } | { readonly ok: false };
  setBit(list: ListState, index: number, purpose: Purpose): ListState;
  clearSuspension(list: ListState, index: number): ListState;
  statusAt(list: ListState, index: number, purpose: Purpose): boolean | undefined;
  readonly CREDENTIAL_CONTEXTS: readonly string[];
  readonly STATUS_LIST_VALIDITY_MS: number;
  readonly PERSON_ATTRIBUTE_TYPES: readonly string[];
  readonly ROLE_TYPES: readonly string[];
  // The Issue credential form (src/domain/credentials/issueForm.ts).
  issuableTypes(roles: readonly { readonly type: string; readonly validFrom: string; readonly validUntil: string; readonly claims: Readonly<Record<string, unknown>> }[],
    policy: { readonly issuance: IssuerPolicy['section']['issuance']; readonly scales: unknown }, at: number): readonly FormIssuable[];
  validateForm(issuable: FormIssuable, values: FormValuesView, scales: unknown, today: number): { readonly ok: true; readonly validUntil: string } | { readonly ok: false; readonly field: string; readonly message: string };
  reviewSentence(type: string, values: FormValuesView, scales: unknown, today: number): string;
  revokeSentence(type: string, personName: string): string;
  suspendSentence(type: string, personName: string): string;
  liftSentence(type: string, personName: string): string;
  typeLabel(type: string): string;
  validUntilFor(lastDay: string): string;
}

/** issueForm.ts's Issuable and FormValues, as the service passes them through. */
export interface FormIssuable { readonly type: string; readonly label: string; readonly ceiling?: string; readonly roleValidUntil: string; readonly fields: readonly IssueFormField[] }
interface FormValuesView { readonly personName: string; readonly subject: string; readonly until: string; readonly claims: Readonly<Record<string, string>> }

export type Purpose = 'revocation' | 'suspension';
export interface ReadView {
  readonly type: string;
  readonly issuer: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly claims: Readonly<Record<string, unknown>> & { readonly id: string };
  readonly status: readonly { readonly statusPurpose: Purpose; readonly statusListIndex: number; readonly statusListCredential: string }[];
  readonly proof?: { readonly suite: string; readonly verificationMethod: string };
}
export interface ListState {
  readonly id: string; readonly issuer: string; readonly purpose: Purpose; readonly version: number; readonly size: number;
  readonly validFrom: string; readonly validUntil: string; readonly ttl?: number; readonly bits: Uint8Array;
}
export interface IssuerPolicy {
  readonly section: {
    readonly root: { readonly did: string };
    readonly issuance: Readonly<Record<string, { readonly role: string } | undefined>>;
    readonly statusLists: readonly { readonly uri: string; readonly purpose: Purpose; readonly key: string }[];
    readonly statusTtl: number;
  };
  readonly scales: unknown;
}

/** OpenBao through the issuer step-up token: the only way this service reaches site paths and other people's inboxes. */
export interface IssuerVault {
  read(path: string): Promise<Record<string, unknown> | undefined>;
  /** Create only (check-and-set 0): 'exists' when something is there already. */
  create(path: string, data: Record<string, unknown>): Promise<'created' | 'exists'>;
  list(folder: string): Promise<readonly string[]>;
  /** Removes every version of a KV entry (DELETE on its metadata). */
  remove(path: string): Promise<void>;
  /** The entity id of an OpenBao entity name, or undefined. */
  entityId(name: string): Promise<string | undefined>;
  /** Signs with the site's status-list key; the signature, base64. */
  signStatus(messageBase64: string): Promise<string>;
  /** Revokes the short token; never throws. */
  end(): Promise<void>;
}
export type IssuerLogin = IssuerVault | 'step-up' | 'not-officer' | 'unreachable';

/** The officer's authenticated session with your organization's server (a hub session, 33-23): logs and lists. */
export interface HubStatusSession {
  getLog(path: string): Promise<string | undefined>;
  getList(name: string): Promise<string | undefined>;
  putList(name: string, text: string): Promise<{ readonly status: number }>;
}

/** KV under the officer's own session token: their DID record and their own wallet. */
export interface OwnKv {
  read(path: string): Promise<Record<string, unknown> | undefined>;
  list(folder: string): Promise<readonly string[]>;
}

export interface IssuerCaller {
  readonly presence: 'person' | 'none';
  readonly context: 'interactive' | 'unattended';
}

export interface IssuerServiceDeps {
  readonly keys: Pick<KeyService, 'sign' | 'personPublicKey'>;
  readonly ownKv: OwnKv;
  readonly entityId: () => string | undefined;
  readonly engine: () => IssuerEngine | undefined;
  /** Your organization's rules in force in this session (71-13's trust source); undefined while none reached it. */
  readonly policy: () => IssuerPolicy | undefined;
  /** The officer's hub session (33-23); undefined while there is none. */
  readonly hub: () => HubStatusSession | undefined;
  /** Logs in to the issuer step-up role with the latest forwarded sign-in. */
  readonly login: () => Promise<IssuerLogin>;
  readonly now?: () => number;
  readonly randomIndex?: (size: number) => number;
}

export const ISSUED_FORMAT = 'sterling-issued/1';
export const INBOX_FORMAT = 'sterling-inbox-item/1';
export const WALLET_ITEM_FORMAT = 'sterling-wallet-item/1';
export const REVOCATION_FORMAT = 'sterling-revocation-request/1';
export const inboxPath = (entity: string, hash: string): string => `users/${entity}/credentials-inbox/${hash}`;
export const walletFolder = (entity: string): string => `users/${entity}/credentials-wallet`;
export const issuedPath = (entity: string, hash: string): string => `site/issued/${entity}/${hash}`;
export const REQUESTS_FOLDER = 'site/revocation-requests';
const OWN_RECORD = (entity: string): string => `users/${entity}/identity/did-webvh`;
const HASH = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_SIZE = 131_072;
const REASONS: readonly RevocationReason[] = ['disabled', 'removed', 'guest-ended', 'computer-lost'];

interface Slot { readonly list: string; readonly index: number }
interface Issued { readonly type: string; readonly issuer: string; readonly personName: string; readonly validUntil: string; readonly revocation: Slot; readonly suspension: Slot }

class Refusal extends Error {
  constructor(readonly result: ServiceResult<never>) {
    super('refused');
  }
}
const stop = (reason: string, fix?: string): never => {
  throw new Refusal(refused(reason, fix));
};

const iso = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const listName = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1);
/** A did:webvh's path on the hub: the parts after the host, joined by "/" (71-09's routes). */
export function didHostPath(did: string): string {
  const parts = did.split(':');
  return parts.length > 4 ? parts.slice(4).join('/') : '.well-known';
}

function slotOf(value: unknown): Slot | undefined {
  const slot = value as { list?: unknown; index?: unknown } | undefined;
  return typeof slot?.list === 'string' && Number.isSafeInteger(slot.index) ? { list: slot.list, index: slot.index as number } : undefined;
}
function issuedOf(data: Record<string, unknown> | undefined): Issued | undefined {
  if (data?.format !== ISSUED_FORMAT) return undefined;
  const revocation = slotOf(data.revocation);
  const suspension = slotOf(data.suspension);
  const { type, issuer, personName, validUntil } = data;
  if (typeof type !== 'string' || typeof issuer !== 'string' || typeof validUntil !== 'string' || revocation === undefined || suspension === undefined) return undefined;
  return { type, issuer, personName: typeof personName === 'string' ? personName : '', validUntil, revocation, suspension };
}

export interface IssuerService {
  issuableTypes(): Promise<ServiceResult<readonly IssuableType[]>>;
  review(request: IssueRequest, caller: IssuerCaller): Promise<ServiceResult<IssueReview>>;
  issue(request: IssueRequest, caller: IssuerCaller): Promise<ServiceResult<IssueResult>>;
  listIssued(caller: IssuerCaller): Promise<ServiceResult<readonly IssuedCredentialView[]>>;
  revoke(hash: string, caller: IssuerCaller): Promise<ServiceResult<IssuedCredentialView>>;
  suspend(hash: string, caller: IssuerCaller): Promise<ServiceResult<IssuedCredentialView>>;
  clearSuspension(hash: string, caller: IssuerCaller): Promise<ServiceResult<IssuedCredentialView>>;
  listRevocationRequests(caller: IssuerCaller): Promise<ServiceResult<readonly RevocationRequestView[]>>;
  resolveRequest(id: string, caller: IssuerCaller): Promise<ServiceResult<{ readonly removed: boolean; readonly remaining: number }>>;
  revokeComputer(id: string, slot: number, caller: IssuerCaller): Promise<ServiceResult<RevocationComputerView>>;
  /** The officer's current role credentials, verified (for the form: what they may issue). */
  roles(): Promise<ServiceResult<readonly ReadView[]>>;
}

interface Context {
  readonly engine: IssuerEngine;
  readonly policy: IssuerPolicy;
  readonly hub: HubStatusSession;
  readonly entity: string;
  readonly did: string;
  readonly states: Record<string, unknown>;
  readonly roles: readonly { readonly credential: unknown; readonly read: ReadView; readonly statusClear: boolean }[];
}

export function createIssuerService(deps: IssuerServiceDeps): IssuerService {
  const now = deps.now ?? Date.now;
  const randomIndex = deps.randomIndex ?? ((size: number): number => randomInt(size));

  async function run<T>(caller: IssuerCaller, body: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    if (caller.presence !== 'person' || caller.context !== 'interactive') return refused(ISSUER_TEXT.personOnly);
    try {
      return await body();
    } catch (error) {
      if (error instanceof Refusal) return error.result;
      return refused(ISSUER_TEXT.storeDown);
    }
  }

  /** A verified did:webvh state from a log, or undefined. */
  function stateOf(engine: IssuerEngine, log: string | undefined): unknown {
    if (log === undefined) return undefined;
    const verified = engine.verifyWebvhLog(log, { now: now() });
    return verified.ok ? verified.state : undefined;
  }

  /** The newest list for a uri on the hub, verified against the key the rules name for it; undefined when the hub holds none. */
  async function newestList(context: Pick<Context, 'engine' | 'policy' | 'hub'>, uri: string): Promise<ListState | undefined> {
    const entry = context.policy.section.statusLists.find((list) => list.uri === uri);
    if (entry === undefined) return stop(ISSUER_TEXT.noRules);
    const text = await context.hub.getList(listName(uri));
    if (text === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return stop(ISSUER_TEXT.noServer);
    }
    const verified = context.engine.verifyStatusList(value, context.engine.decodePublicKeyMultibase(entry.key));
    return verified.ok ? verified.list : stop(ISSUER_TEXT.noServer);
  }

  async function bitSet(context: Pick<Context, 'engine' | 'policy' | 'hub'>, slot: Slot, purpose: Purpose): Promise<boolean> {
    const list = await newestList(context, slot.list);
    return list === undefined ? false : context.engine.statusAt(list, slot.index, purpose) === true;
  }

  /** Everything a call needs, or the refusal that says what is missing. */
  async function contextFor(): Promise<Context> {
    const engine = deps.engine();
    const entity = deps.entityId();
    if (engine === undefined || entity === undefined) return stop(ISSUER_TEXT.notSetUp);
    const policy = deps.policy();
    if (policy === undefined) return stop(ISSUER_TEXT.noRules);
    const hub = deps.hub();
    if (hub === undefined) return stop(ISSUER_TEXT.noServer);
    const own = await deps.ownKv.read(OWN_RECORD(entity));
    if (typeof own?.did !== 'string' || typeof own.log !== 'string') return stop(ISSUER_TEXT.noIdentity);
    const did = own.did;
    const states: Record<string, unknown> = {};
    const ownState = stateOf(engine, own.log);
    if (ownState === undefined) return stop(ISSUER_TEXT.noIdentity);
    states[did] = ownState;
    const root = policy.section.root.did;
    const rootState = stateOf(engine, await hub.getLog(didHostPath(root)));
    if (rootState !== undefined) states[root] = rootState;
    // The officer's own role credentials, from their own wallet: signed by your organization's root, about them, and current.
    const roles: Array<{ credential: unknown; read: ReadView; statusClear: boolean }> = [];
    const folder = `${walletFolder(entity)}/`;
    for (const name of await deps.ownKv.list(folder)) {
      const item = await deps.ownKv.read(`${walletFolder(entity)}/${name}`);
      const credential = item?.format === WALLET_ITEM_FORMAT ? item.credential : undefined;
      const read = engine.readCredential(credential, policy.scales, { signed: true });
      if (!read.ok || !engine.ROLE_TYPES.includes(read.value.type) || read.value.claims.id !== did || read.value.issuer !== root || rootState === undefined) continue;
      const method = engine.methodsAt(rootState, Date.parse(read.value.validFrom)).find((entry) => entry.id === read.value.proof?.verificationMethod);
      if (method === undefined) continue;
      if (!engine.verifyCredential(credential, { publicKey: engine.decodePublicKeyMultibase(method.publicKeyMultibase), scales: policy.scales, at: now() }).ok) continue;
      let clear = true;
      for (const entry of read.value.status) {
        if (await bitSet({ engine, policy, hub }, { list: entry.statusListCredential, index: entry.statusListIndex }, entry.statusPurpose)) clear = false;
      }
      roles.push({ credential, read: read.value, statusClear: clear });
    }
    return { engine, policy, hub, entity, did, states, roles };
  }

  /** Logs in to the issuer step-up role, or stops with the sentence that says why not. */
  async function vaultFor(): Promise<IssuerVault> {
    const login = await deps.login();
    if (login === 'step-up') return stop(ISSUER_TEXT.stepUp, ISSUER_TEXT.confirm);
    if (login === 'not-officer') return stop(ISSUER_TEXT.notOfficer);
    if (login === 'unreachable') return stop(ISSUER_TEXT.storeDown);
    return login;
  }
  async function withVault<T>(body: (vault: IssuerVault) => Promise<T>): Promise<T> {
    const vault = await vaultFor();
    try {
      return await body(vault);
    } finally {
      await vault.end();
    }
  }

  /**
   * issuerAuthority on the credential about to be signed (its type, level and the officer's key in force), and the credential may not outlast the
   * role relied on.
   */
  function mayIssue(context: Context, unsigned: Record<string, unknown>, verificationMethod: string): boolean {
    const read = context.engine.readCredential(unsigned, context.policy.scales, { signed: false });
    if (!read.ok) return false;
    const view = { ...read.value, credential: unsigned, suite: 'eddsa-jcs-2022', verificationMethod };
    // RoleEvidence holds each role as verified: its read fields with the signed blob, suite and method (profile.ts VerifiedCredential).
    const roles = context.roles.map((role) => ({
      credential: { ...role.read, credential: role.credential, suite: role.read.proof?.suite, verificationMethod: role.read.proof?.verificationMethod }, statusClear: role.statusClear,
    }));
    const result = context.engine.issuerAuthority(view, roles, context.policy, { states: context.states });
    return result.ok && result.role !== undefined && Date.parse(read.value.validUntil) <= Date.parse(result.role.validUntil);
  }

  /** The types the officer may issue now (the form's view of their roles), each with its form. */
  function issuable(context: Context): readonly FormIssuable[] {
    const roles = context.roles.filter((role) => role.statusClear).map((role) => ({ type: role.read.type, validFrom: role.read.validFrom, validUntil: role.read.validUntil, claims: role.read.claims }));
    return context.engine.issuableTypes(roles, { issuance: context.policy.section.issuance, scales: context.policy.scales }, now());
  }
  const valuesOf = (request: IssueRequest): FormValuesView => ({ personName: request.personName, subject: request.subject, until: request.until, claims: request.claims });

  /** The form's refusal for a request, with the field's own sentence; undefined when it passes. */
  function checkForm(context: Context, request: IssueRequest): ServiceResult<never> | undefined {
    const found = issuable(context).find((entry) => entry.type === request.type);
    if (found === undefined) return refused(ISSUER_TEXT.noRole);
    const check = context.engine.validateForm(found, valuesOf(request), context.policy.scales, now());
    return check.ok ? undefined : refused(check.message);
  }

  async function issuableTypes(): Promise<ServiceResult<readonly IssuableType[]>> {
    return run({ presence: 'person', context: 'interactive' }, async () => {
      const context = await contextFor();
      return ok(issuable(context).map((entry) => ({
        type: entry.type, label: entry.label, ...(entry.ceiling === undefined ? {} : { ceiling: entry.ceiling }), roleValidUntil: entry.roleValidUntil, fields: entry.fields,
      })));
    });
  }

  async function review(request: IssueRequest, caller: IssuerCaller): Promise<ServiceResult<IssueReview>> {
    return run(caller, async () => {
      if (typeof request?.subject !== 'string' || typeof request.type !== 'string' || typeof request.until !== 'string' || request.claims === null || typeof request.claims !== 'object') {
        return refused(ISSUER_TEXT.badRequest);
      }
      const context = await contextFor();
      const form = checkForm(context, request);
      if (form !== undefined) return form;
      return ok({ sentence: context.engine.reviewSentence(request.type, valuesOf(request), context.policy.scales, now()) });
    });
  }

  function listFor(policy: IssuerPolicy, purpose: Purpose): string {
    const found = policy.section.statusLists.find((list) => list.purpose === purpose);
    return found === undefined ? stop(ISSUER_TEXT.noRules) : found.uri;
  }

  function unsignedFor(context: Context, request: IssueRequest, revocation: Slot, suspension: Slot): Record<string, unknown> {
    const entry = (purpose: Purpose, slot: Slot): Record<string, unknown> => ({
      type: 'BitstringStatusListEntry', statusPurpose: purpose, statusListIndex: String(slot.index), statusListCredential: slot.list,
    });
    return {
      '@context': [...context.engine.CREDENTIAL_CONTEXTS], type: ['VerifiableCredential', request.type], issuer: context.did,
      validFrom: iso(now()), validUntil: context.engine.validUntilFor(request.until),
      credentialSubject: { id: request.subject, ...request.claims },
      credentialStatus: [entry('revocation', revocation), entry('suspension', suspension)],
    };
  }

  /** A status list place no other credential has: claimed once in kv/site/status-index/, with one more try on a clash. */
  async function claim(vault: IssuerVault, uri: string, purpose: Purpose, issuer: string): Promise<Slot> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Officers' credentials take places below the device quarter of each list (D-25), so a person's computer never shares a bit with one.
      const index = randomIndex(DEVICE_INDEX_FROM);
      if ((await vault.create(`site/status-index/${purpose}-${listName(uri)}/${String(index)}`, { issuer, claimedAt: iso(now()) })) === 'created') return { list: uri, index };
    }
    return stop(ISSUER_TEXT.noIndex);
  }

  /** The entity whose people directory entry is `did`, or undefined. */
  async function entityOfDid(vault: IssuerVault, did: string): Promise<string | undefined> {
    for (const name of await vault.list('site/people/')) {
      if ((await vault.read(`site/people/${name}`))?.did === did) return name;
    }
    return undefined;
  }

  async function issue(request: IssueRequest, caller: IssuerCaller): Promise<ServiceResult<IssueResult>> {
    return run(caller, async () => {
      if (typeof request?.subject !== 'string' || !request.subject.startsWith('did:webvh:')) return refused(ISSUER_TEXT.notAPerson);
      if (typeof request.type !== 'string' || typeof request.personName !== 'string' || request.personName.trim() === '' || request.claims === null
        || typeof request.claims !== 'object' || typeof request.until !== 'string' || !DAY.test(request.until) || !['inbox', 'file'].includes(request.delivery)) {
        return refused(ISSUER_TEXT.badRequest);
      }
      const context = await contextFor();
      if (!context.engine.PERSON_ATTRIBUTE_TYPES.includes(request.type)) return refused(ISSUER_TEXT.noRole);
      const form = checkForm(context, request);
      if (form !== undefined) return form;
      const revocationList = listFor(context.policy, 'revocation');
      const suspensionList = listFor(context.policy, 'suspension');
      // Authority first, on the very credential to be signed (its places are filled in after): no step-up, no place, no signature without it.
      const draft = unsignedFor(context, request, { list: revocationList, index: 0 }, { list: suspensionList, index: 0 });
      if (!context.engine.readCredential(draft, context.policy.scales, { signed: false }).ok) return refused(ISSUER_TEXT.badRequest);
      // The officer's person key and the method of their DID that names it now.
      const key = await deps.keys.personPublicKey();
      if (key.kind !== 'ok') return key as ServiceResult<never>;
      const multikey = context.engine.encodePublicKeyMultibase('Ed25519', new Uint8Array(Buffer.from(key.value.publicKey, 'base64url')));
      const method = context.engine.methodsAt(context.states[context.did], now()).find((entry) => entry.publicKeyMultibase === multikey);
      if (method === undefined) return refused(ISSUER_TEXT.noIdentity);
      if (!mayIssue(context, draft, method.id)) return refused(ISSUER_TEXT.noRole);
      return withVault(async (vault) => {
        const subjectEntity = await entityOfDid(vault, request.subject);
        if (request.delivery === 'inbox' && subjectEntity === undefined) return refused(ISSUER_TEXT.unknownPerson);
        const revocation = await claim(vault, revocationList, 'revocation', context.did);
        const suspension = await claim(vault, suspensionList, 'suspension', context.did);
        const signer: EngineSigner = {
          verificationMethod: method.id, suite: 'eddsa-jcs-2022',
          async sign(bytes) {
            const answer = await deps.keys.sign(Buffer.from(bytes).toString('base64'));
            if (answer.kind !== 'ok') throw new Refusal(answer as ServiceResult<never>);
            if (answer.value.keyVersion !== key.value.keyVersion) throw new Refusal(refused(ISSUER_TEXT.noIdentity));
            return new Uint8Array(Buffer.from(answer.value.signature, 'base64'));
          },
        };
        const credential = await context.engine.issueCredential(signer, unsignedFor(context, request, revocation, suspension), 'eddsa-jcs-2022', { scales: context.policy.scales });
        const hash = context.engine.credentialHash(credential);
        const text = `${JSON.stringify(credential, null, 2)}\n`;
        // The role credentials the officer relies on travel beside it (71-13): every verifier of the credential needs them as cited evidence.
        if (request.delivery === 'inbox' && subjectEntity !== undefined) await vault.create(inboxPath(subjectEntity, hash), { format: INBOX_FORMAT, credential, roles: typeRoles(context, request.type) });
        // The register: what was issued, to whom, by whom and where its status is; a person with no directory entry is registered under their DID's path.
        const registerKey = subjectEntity ?? `did-${didHostPath(request.subject).replaceAll('/', '-')}`;
        await vault.create(issuedPath(registerKey, hash), {
          format: ISSUED_FORMAT, type: request.type, issuer: context.did, personName: request.personName.trim(), validUntil: String(credential.validUntil), revocation, suspension,
        });
        return request.delivery === 'inbox'
          ? ok({ hash, delivered: 'inbox' as const, sentence: ISSUER_TEXT.issuedInbox })
          : ok({ hash, delivered: 'file' as const, file: { fileName: `credential-${hash.slice(0, 8)}.near-vc`, text }, sentence: ISSUER_TEXT.issuedFile });
      });
    });
  }

  /** Every register entry: [entity, hash, entry]. */
  async function register(vault: IssuerVault, only?: string): Promise<Array<{ entity: string; hash: string; issued: Issued }>> {
    const found: Array<{ entity: string; hash: string; issued: Issued }> = [];
    const entities = only === undefined ? (await vault.list('site/issued/')).map((name) => name.replace(/\/$/, '')) : [only];
    for (const entity of entities) {
      for (const hash of await vault.list(`site/issued/${entity}/`)) {
        if (!HASH.test(hash)) continue;
        const issued = issuedOf(await vault.read(issuedPath(entity, hash)));
        if (issued !== undefined) found.push({ entity, hash, issued });
      }
    }
    return found;
  }

  async function viewOf(context: Context, hash: string, issued: Issued): Promise<IssuedCredentialView> {
    let state: IssuedCredentialView['state'] = 'active';
    try {
      if (await bitSet(context, issued.revocation, 'revocation')) state = 'revoked';
      else if (await bitSet(context, issued.suspension, 'suspension')) state = 'suspended';
    } catch {
      state = 'unknown';
    }
    const { engine } = context;
    return {
      hash, type: issued.type, label: engine.typeLabel(issued.type), personName: issued.personName, validUntil: issued.validUntil, state,
      reviews: { revoke: engine.revokeSentence(issued.type, issued.personName), suspend: engine.suspendSentence(issued.type, issued.personName), lift: engine.liftSentence(issued.type, issued.personName) },
    };
  }

  async function listIssued(caller: IssuerCaller): Promise<ServiceResult<readonly IssuedCredentialView[]>> {
    return run(caller, async () => {
      const context = await contextFor();
      return withVault(async (vault) => {
        const mine = (await register(vault)).filter((entry) => entry.issued.issuer === context.did);
        return ok(await Promise.all(mine.map((entry) => viewOf(context, entry.hash, entry.issued))));
      });
    });
  }

  /** Sets or clears one bit in the next version of a list, signed by the status-list key, with one re-read on a compare-and-swap clash. */
  async function changeBit(context: Context, vault: IssuerVault, slot: Slot, purpose: Purpose, set: boolean): Promise<void> {
    const entry = context.policy.section.statusLists.find((list) => list.uri === slot.list && list.purpose === purpose);
    if (entry === undefined) return stop(ISSUER_TEXT.noRules);
    const issuer = `did:key:${entry.key}`;
    const signer: EngineSigner = {
      verificationMethod: `${issuer}#${entry.key}`, suite: 'eddsa-jcs-2022',
      sign: async (bytes) => new Uint8Array(Buffer.from(await vault.signStatus(Buffer.from(bytes).toString('base64')), 'base64')),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const held = await newestList(context, slot.list);
      if (held !== undefined && context.engine.statusAt(held, slot.index, purpose) === set) return;
      const base: ListState = held ?? { id: slot.list, issuer, purpose, version: 0, size: STATUS_SIZE, validFrom: iso(0), validUntil: iso(0), bits: new Uint8Array(STATUS_SIZE / 8) };
      const next = set ? context.engine.setBit(base, slot.index, purpose) : context.engine.clearSuspension(base, slot.index);
      const from = Math.max(now(), Date.parse(base.validFrom) + 1000);
      const unsigned = context.engine.buildStatusList({
        id: next.id, issuer, purpose, version: next.version, size: next.size, bits: next.bits, validFrom: iso(from),
        validUntil: iso(from + context.engine.STATUS_LIST_VALIDITY_MS), ttl: context.policy.section.statusTtl * 1000,
      });
      const signed = await context.engine.signStatusList(signer, unsigned, 'eddsa-jcs-2022');
      const answer = await context.hub.putList(listName(slot.list), JSON.stringify(signed));
      if (answer.status === 200 || answer.status === 201) return;
      if (answer.status !== 409) return stop(ISSUER_TEXT.listRefused);
    }
    return stop(ISSUER_TEXT.listChanged);
  }

  async function act(hash: string, caller: IssuerCaller, what: 'revoke' | 'suspend' | 'clear'): Promise<ServiceResult<IssuedCredentialView>> {
    return run(caller, async () => {
      if (typeof hash !== 'string' || !HASH.test(hash)) return refused(ISSUER_TEXT.unknownCredential);
      const context = await contextFor();
      return withVault(async (vault) => {
        const found = (await register(vault)).find((entry) => entry.hash === hash);
        if (found === undefined) return refused(ISSUER_TEXT.unknownCredential);
        // Only a holder of a current role for this type acts on it (D-14), whoever issued it.
        if (!hasTypeRole(context, found.issued.type)) return refused(ISSUER_TEXT.noRole);
        if (what === 'clear') {
          if (await bitSet(context, found.issued.revocation, 'revocation')) return refused(ISSUER_TEXT.revocationFinal);
          if (!(await bitSet(context, found.issued.suspension, 'suspension'))) return refused(ISSUER_TEXT.notSuspended);
          await changeBit(context, vault, found.issued.suspension, 'suspension', false);
        } else {
          await changeBit(context, vault, what === 'revoke' ? found.issued.revocation : found.issued.suspension, what === 'revoke' ? 'revocation' : 'suspension', true);
        }
        return ok(await viewOf(context, hash, found.issued));
      });
    });
  }

  /** The officer's current, clear role credentials your organization's rules name for issuing `type` (signed, as held). */
  function typeRoles(context: Context, type: string): unknown[] {
    const rule = Object.prototype.hasOwnProperty.call(context.policy.section.issuance, type) ? context.policy.section.issuance[type] : undefined;
    if (rule === undefined) return [];
    const at = now();
    return context.roles.filter((role) => role.statusClear && role.read.type === rule.role
      && (rule.role !== 'IssuerRoleCredential' || role.read.claims.credentialType === type)
      && Date.parse(role.read.validFrom) <= at && at < Date.parse(role.read.validUntil)).map((role) => role.credential);
  }

  /** Whether the officer holds a current, clear role credential your organization's rules name for issuing `type`. */
  function hasTypeRole(context: Context, type: string): boolean {
    return typeRoles(context, type).length > 0;
  }

  interface OpenRequest { readonly id: string; readonly entityName: string; readonly reason: string; readonly seenAt: string; readonly slot?: number }
  function requestOf(id: string, data: Record<string, unknown> | undefined): OpenRequest | 'newer' | undefined {
    if (data === undefined) return undefined;
    if (data.format !== REVOCATION_FORMAT) return 'newer';
    const { entity, reason, seenAt, slot } = data;
    if (typeof entity !== 'string' || typeof reason !== 'string' || typeof seenAt !== 'string') return 'newer';
    if (reason === COMPUTER_LOST_REASON && !(Number.isSafeInteger(slot) && (slot as number) >= 1 && (slot as number) <= MAX_COMPUTERS)) return 'newer';
    return { id, entityName: entity, reason, seenAt, ...(reason === COMPUTER_LOST_REASON ? { slot: slot as number } : {}) };
  }

  /** The computers a request is about: the one slot of a lost-computer report, or every computer of a person whose access ended. */
  async function computersOf(vault: IssuerVault, entity: string | undefined, request: OpenRequest): Promise<Array<{ slot: number; record: DeviceSlotRecord }>> {
    if (entity === undefined) return [];
    const slots = request.slot === undefined ? Array.from({ length: MAX_COMPUTERS }, (_unused, index) => index + 1) : [request.slot];
    const found: Array<{ slot: number; record: DeviceSlotRecord }> = [];
    for (const slot of slots) {
      const record = slotRecordOf(await vault.read(slotPath(entity, slot)));
      if (record !== undefined) found.push({ slot, record });
    }
    return found;
  }

  async function computerView(context: Context, personName: string, slot: number, record: DeviceSlotRecord): Promise<RevocationComputerView> {
    let state: RevocationComputerView['state'] = 'active';
    try {
      if (await bitSet(context, record.revocation, 'revocation')) state = 'revoked';
    } catch {
      state = 'unknown';
    }
    return { slot, device: record.device, claimedAt: record.claimedAt, state, review: context.engine.revokeSentence('DeviceBindingCredential', personName) };
  }

  async function listRevocationRequests(caller: IssuerCaller): Promise<ServiceResult<readonly RevocationRequestView[]>> {
    return run(caller, async () => {
      const context = await contextFor();
      return withVault(async (vault) => {
        const views: RevocationRequestView[] = [];
        for (const id of await vault.list(`${REQUESTS_FOLDER}/`)) {
          if (!REQUEST_ID.test(id)) continue;
          const request = requestOf(id, await vault.read(`${REQUESTS_FOLDER}/${id}`));
          if (request === undefined) continue;
          if (request === 'newer') {
            views.push({ id, current: false, message: ISSUER_TEXT.newerRequest });
            continue;
          }
          const entity = await vault.entityId(request.entityName);
          const entries = entity === undefined ? [] : await register(vault, entity);
          const personName = entries.find((entry) => entry.issued.personName !== '')?.issued.personName ?? 'A person';
          // A lost computer is about that computer only; an ended access is about everything this officer issued to the person, and their computers.
          const mine = request.slot === undefined ? entries.filter((entry) => entry.issued.issuer === context.did) : [];
          const credentials = await Promise.all(mine.map((entry) => viewOf(context, entry.hash, entry.issued)));
          const computers = await Promise.all((await computersOf(vault, entity, request)).map(({ slot, record }) => computerView(context, personName, slot, record)));
          const reasonText = (REASONS as readonly string[]).includes(request.reason) ? REVOCATION_REASON_TEXT[request.reason as RevocationReason] : request.reason;
          views.push({ id, current: true, personName, reason: request.reason, reasonText, seenAt: request.seenAt, credentials, computers });
        }
        return ok(views);
      });
    });
  }

  /** Revokes a computer a request names (D-25): any named officer, after the step-up; a revocation is never undone. */
  async function revokeComputer(id: string, slot: number, caller: IssuerCaller): Promise<ServiceResult<RevocationComputerView>> {
    return run(caller, async () => {
      if (typeof id !== 'string' || !REQUEST_ID.test(id) || !Number.isSafeInteger(slot)) return refused(ISSUER_TEXT.noRequest);
      const context = await contextFor();
      return withVault(async (vault) => {
        const request = requestOf(id, await vault.read(`${REQUESTS_FOLDER}/${id}`));
        if (request === undefined || request === 'newer') return refused(ISSUER_TEXT.noRequest);
        const entity = await vault.entityId(request.entityName);
        const found = (await computersOf(vault, entity, request)).find((entry) => entry.slot === slot);
        if (found === undefined) return refused(ISSUER_TEXT.noComputer);
        await changeBit(context, vault, found.record.revocation, 'revocation', true);
        const entries = entity === undefined ? [] : await register(vault, entity);
        return ok(await computerView(context, entries.find((entry) => entry.issued.personName !== '')?.issued.personName ?? 'A person', slot, found.record));
      });
    });
  }

  async function resolveRequest(id: string, caller: IssuerCaller): Promise<ServiceResult<{ readonly removed: boolean; readonly remaining: number }>> {
    return run(caller, async () => {
      if (typeof id !== 'string' || !REQUEST_ID.test(id)) return refused(ISSUER_TEXT.noRequest);
      const context = await contextFor();
      return withVault(async (vault) => {
        const request = requestOf(id, await vault.read(`${REQUESTS_FOLDER}/${id}`));
        if (request === undefined) return refused(ISSUER_TEXT.noRequest);
        if (request === 'newer') return refused(ISSUER_TEXT.newerRequest);
        const entity = await vault.entityId(request.entityName);
        const entries = entity === undefined || request.slot !== undefined ? [] : await register(vault, entity);
        const computers = await computersOf(vault, entity, request);
        let remaining = 0;
        for (const entry of entries) {
          const ended = (await bitSet(context, entry.issued.revocation, 'revocation')) || (await bitSet(context, entry.issued.suspension, 'suspension'));
          if (!ended) remaining += 1;
        }
        for (const computer of computers) if (!(await bitSet(context, computer.record.revocation, 'revocation'))) remaining += 1;
        if (remaining > 0) return ok({ removed: false, remaining });
        // A lost computer's slot is freed once its binding is revoked, so the person can bind another (at most 5 at once).
        if (request.slot !== undefined && entity !== undefined) await vault.remove(slotPath(entity, request.slot));
        await vault.remove(`${REQUESTS_FOLDER}/${id}`);
        return ok({ removed: true, remaining: 0 });
      });
    });
  }

  async function roles(): Promise<ServiceResult<readonly ReadView[]>> {
    return run({ presence: 'person', context: 'interactive' }, async () => {
      const context = await contextFor();
      return ok(context.roles.filter((role) => role.statusClear).map((role) => role.read));
    });
  }

  return {
    issuableTypes, review, issue, listIssued, listRevocationRequests, resolveRequest, revokeComputer, roles,
    revoke: (hash, caller) => act(hash, caller, 'revoke'),
    suspend: (hash, caller) => act(hash, caller, 'suspend'),
    clearSuspension: (hash, caller) => act(hash, caller, 'clear'),
  };
}

const plainLabel = (type: string): string => type.replace(/Credential$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/**
 * The check the inbox pickup runs on each item (D-15): the credential is about the holder, signed by the key its issuer's did:webvh (from your
 * organization's server) had in force on its first day, and current now. Without the rules or the server it answers `unchecked`, so the item
 * waits in the inbox for a session that can check it.
 */
export function inboxVerifier(deps: Pick<IssuerServiceDeps, 'engine' | 'policy' | 'hub' | 'now'>): (credential: unknown, did: string) => Promise<
  { readonly ok: true; readonly hash: string; readonly label: string } | { readonly ok: false; readonly unchecked: boolean }> {
  const now = deps.now ?? Date.now;
  return async (credential, did) => {
    const engine = deps.engine();
    const policy = deps.policy();
    const hub = deps.hub();
    if (engine === undefined || policy === undefined || hub === undefined) return { ok: false, unchecked: true };
    const read = engine.readCredential(credential, policy.scales, { signed: true });
    if (!read.ok || read.value.claims.id !== did || !engine.PERSON_ATTRIBUTE_TYPES.includes(read.value.type)) return { ok: false, unchecked: false };
    let log: string | undefined;
    try {
      log = await hub.getLog(didHostPath(read.value.issuer));
    } catch {
      return { ok: false, unchecked: true };
    }
    if (log === undefined) return { ok: false, unchecked: true };
    const state = engine.verifyWebvhLog(log, { now: now() });
    if (!state.ok) return { ok: false, unchecked: false };
    const method = engine.methodsAt(state.state, Date.parse(read.value.validFrom)).find((entry) => entry.id === read.value.proof?.verificationMethod);
    if (method === undefined) return { ok: false, unchecked: false };
    const verified = engine.verifyCredential(credential, { publicKey: engine.decodePublicKeyMultibase(method.publicKeyMultibase), scales: policy.scales, at: now() });
    if (!verified.ok) return { ok: false, unchecked: false };
    return { ok: true, hash: engine.credentialHash(credential), label: plainLabel(read.value.type) };
  };
}

/** What the OpenBao adapter needs from the active session (session-identity.ts's ActiveSession). */
export interface IssuerSessionSource {
  readonly forwardedToken: string;
  readonly acr?: string;
  readonly authTime?: number;
  readonly client: { request(method: string, path: string, options?: { readonly token?: string; readonly body?: unknown }): Promise<{ readonly status: number; readonly json: unknown }> };
  readonly config: { readonly jwtMount: string; readonly kvMount: string; readonly transitMount: string; readonly stepUpAcr?: string; readonly stepUpMaxAgeSeconds: number };
}

const TRANSIT_SIGNATURE = /^vault:v[1-9][0-9]{0,8}:([A-Za-z0-9+/]+={0,2})$/;

/**
 * The issuer step-up login in production: the same freshness guard as KeyService (the forwarded token's acr and auth_time), then OpenBao's own
 * check, a login to role `role` (sterling-issuer-stepup: the step-up acr and the officer's named sub). Every call afterwards uses that short
 * token, which is revoked when the call ends. A refused login after a fresh step-up means the person is not a named officer.
 */
export function openBaoIssuerLogin(session: () => IssuerSessionSource | undefined, statusKey: string | undefined, role: string, clock: () => number = Date.now): () => Promise<IssuerLogin> {
  return async () => {
    const s = session();
    if (s === undefined || statusKey === undefined) return 'unreachable';
    const nowSeconds = clock() / 1000;
    const fresh = s.config.stepUpAcr !== undefined && s.acr === s.config.stepUpAcr && s.authTime !== undefined
      && nowSeconds - s.authTime <= s.config.stepUpMaxAgeSeconds && s.authTime <= nowSeconds + 30;
    if (!fresh) return 'step-up';
    let token: string;
    try {
      const answer = await s.client.request('POST', `auth/${s.config.jwtMount}/login`, { body: { role, jwt: s.forwardedToken } });
      const found = (answer.json as { auth?: { client_token?: unknown } } | undefined)?.auth?.client_token;
      if (typeof found !== 'string' || found === '') return 'not-officer';
      token = found;
    } catch (error) {
      return (error as { kind?: string }).kind === 'refused' ? 'not-officer' : 'unreachable';
    }
    const kv = s.config.kvMount;
    const dataOf = (answer: { readonly json: unknown }): Record<string, unknown> | undefined => {
      const found = (answer.json as { data?: { data?: unknown } } | undefined)?.data?.data;
      return typeof found === 'object' && found !== null && !Array.isArray(found) ? (found as Record<string, unknown>) : undefined;
    };
    return {
      async read(path) {
        const answer = await s.client.request('GET', `${kv}/data/${path}`, { token });
        return answer.status === 404 ? undefined : dataOf(answer);
      },
      async create(path, value) {
        try {
          await s.client.request('POST', `${kv}/data/${path}`, { token, body: { options: { cas: 0 }, data: value } });
          return 'created';
        } catch (error) {
          // A create-only token gets 403 for an entry that exists (OpenBao counts the second write as an update); a reading one gets 400.
          const status = (error as { status?: number }).status;
          if (status === 400 || status === 403) return 'exists';
          throw error;
        }
      },
      async list(folder) {
        const answer = await s.client.request('GET', `${kv}/metadata/${folder}?list=true`, { token });
        const keys = (answer.json as { data?: { keys?: unknown } } | undefined)?.data?.keys;
        return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
      },
      async remove(path) {
        await s.client.request('DELETE', `${kv}/metadata/${path}`, { token });
      },
      async entityId(name) {
        const answer = await s.client.request('GET', `identity/entity/name/${encodeURIComponent(name)}`, { token });
        const id = (answer.json as { data?: { id?: unknown } } | undefined)?.data?.id;
        return typeof id === 'string' ? id : undefined;
      },
      async signStatus(messageBase64) {
        const answer = await s.client.request('POST', `${s.config.transitMount}/sign/${statusKey}`, { token, body: { input: messageBase64 } });
        const text = (answer.json as { data?: { signature?: unknown } } | undefined)?.data?.signature;
        const parts = typeof text === 'string' ? TRANSIT_SIGNATURE.exec(text) : null;
        if (!parts) throw new Error('the status-list key did not sign');
        return parts[1] as string;
      },
      async end() {
        await s.client.request('POST', 'auth/token/revoke-self', { token }).catch(() => undefined);
      },
    };
  };
}

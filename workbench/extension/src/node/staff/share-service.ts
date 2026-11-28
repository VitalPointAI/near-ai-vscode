/**
 * Share with people in the session backend (Phase 33 D-10, D-13, D-21, D-42, D-58, D-60, D-61; 33-27, superseding 33-11). It is the front door to
 * the executed flows of Phases 31 and 32 and the Phase 33 server actions, all from the engine bundle, over the session's live engine (33-24):
 *
 *   turnOn         makeMultiUser: the project is converted, roster.require armed, and this person its lead; in a hosted session the person key is
 *                  the lead device and binds the X25519 key (signed through personSigner after a fresh step-up); the engine then opens it
 *   connectServer  connectProjectToHub from the operator's hub file; the hub's address is kept for this computer (D-10)
 *   invite         inviteThroughHub (or by file before a server is connected); the invitation is signed by the person key
 *   openInvitation joinFromInvite, then sendJoinRequestThroughHub when the invitation names a server; the invitation's hub address is kept for
 *                  the project being joined, so it syncs once admitted (D-10)
 *   openWelcome    openWelcome; the engine opens the shared work and certifies the session key in it
 *   joinRequests   fetchJoinRequests, each read with reviewJoinRequest for its six words; admit: admitJoinRequest after the words matched
 *   remove, grant, revoke, changeAddress, readmit, singleCopy, setShowWork
 *
 * Every person-key signature goes through the session's personSigner (KeyService.sign with a fresh step-up); the session key never signs a
 * roster change, a grant, an invitation or a join request (D-60). A refused confirmation comes back as the Staff Room's sentence with its fix.
 * Nothing here imports Theia; no log line holds a name, a key or a file.
 */
import type { ShareJoinRequest, ShareOutcome, SharePart, SharePerson, ShareView, StaffShareServer, InviteInput, ManagedKeyFileChoice, OpenManagedKeyFileInput, SaveManagedKeyFileInput } from '../../common/staff-share.js';
import { MANAGED_KEY_FILE_MAX_BYTES, STAFF_SHARE_TEXT } from '../../common/staff-share.js';
import { actionStepUpUrl, isActionNonce } from '../../common/session-identity.js';
import type { PendingActions } from './person-signer.js';
import { KEY_SERVICE_TEXT } from '../../common/key-service.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import type { SecretStorageLike } from './keystore-secrets.js';
import type { HostedSessionKeys } from './staff-live-engine.js';
import { SESSION_KEY_TEXT } from './session-keys.js';
import type { EngineProject, EngineRoster, StaffEngine } from './staff-engine.js';
import type { StaffStatusRow } from '../../common/staff-live.js';

/** The engine's MembershipResult and HubMembershipResult, as far as the service reads them. */
export interface EngineResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly message: string;
  readonly notices: readonly string[];
  readonly file?: { readonly name: string; readonly text: string };
  readonly safetyWords?: readonly string[];
  readonly hub?: string;
  readonly member?: string;
  readonly requests?: ReadonlyArray<{ readonly invite: string; readonly text: string }>;
  /** openWelcome: the joined project, which the caller closes. */
  readonly project?: { close(): Promise<void> };
}

/** The engine names Share with people calls (tools/staff-engine-entry.ts, 33-27); the workbench test checks this against the entry. */
export interface StaffShareApi {
  makeMultiUser(root: string, deps: never, options: never): Promise<{ readonly ok: true; readonly notices: readonly string[]; readonly cells: ReadonlyArray<{ readonly cell: string; readonly label?: string }>; readonly withheld: ReadonlyArray<{ readonly product: string; readonly cell: string }>; readonly unversioned: ReadonlyArray<{ readonly product: string }> } | { readonly refused: string; readonly message: string }>;
  conversionNoticeLines(withheld: ReadonlyArray<{ product: string; cell: string }>, unversioned: ReadonlyArray<{ product: string }>, labelOf: (cell: string) => string | undefined): string[];
  connectProjectToHub(shared: never, hubFileText: unknown, input: never, open?: never): Promise<EngineResult>;
  inviteToProject(shared: never, input: never): Promise<EngineResult>;
  inviteThroughHub(shared: never, input: never, endpoint: { readonly address: string; readonly hub?: string }, open?: never): Promise<EngineResult>;
  joinFromInvite(root: string, deps: never, inviteText: unknown, input: { readonly name: string }): Promise<EngineResult>;
  sendJoinRequestThroughHub(inviteText: unknown, requestText: unknown, deps: never, open?: never): Promise<EngineResult>;
  openWelcome(root: string, deps: never, welcomeText: unknown): Promise<EngineResult>;
  fetchJoinRequests(shared: never, endpoint: { readonly address: string; readonly hub?: string }, open?: never): Promise<EngineResult>;
  reviewJoinRequest(shared: never, requestText: unknown): Promise<EngineResult>;
  admitJoinRequest(shared: never, requestText: unknown, input: { readonly codeMatched: boolean }): Promise<EngineResult>;
  removeFromProject(shared: never, input: { readonly member: string }, action?: string): Promise<EngineResult>;
  managedWithdrawalActionBytes(roster: never, authority: string, input: { readonly member: string }): Buffer | undefined;
  readonly CELL_ACCESS_FEATURE: string;
  workbenchManagedFileChoices(shared: never, roster: never): readonly ManagedKeyFileChoice[];
  exportWorkbenchManagedFile(shared: never, cell: string, recipient: string, repeat?: string): Promise<{ name: string; text: string; repeat: string } | undefined>;
  openWorkbenchManagedFile(shared: never, text: string): Promise<EngineResult>;
  pendingWorkbenchFinishParts(shared: never, roster: never): NonNullable<ShareView['keyChanges']>;
  prepareWorkbenchFinish(shared: never, roster: never, cell: string, now: Date): WorkbenchFinishDraft | undefined;
  grantCellToHub(shared: never, input: { readonly cell: string; readonly confirmed: boolean }): Promise<EngineResult>;
  revokeHub(shared: never, input: { readonly hub?: string }): Promise<EngineResult>;
  readmitHub(shared: never, input: { readonly hub?: string; readonly certPin: string; readonly words: string }): Promise<EngineResult>;
  makeSingleMachineCopy(sharedRoot: string, destination: string, deps: never): Promise<{ readonly ok: true; readonly notices: readonly string[]; readonly contested: readonly string[]; readonly differs: ReadonlyArray<{ readonly product: string; readonly reason: string }>; readonly left: ReadonlyArray<{ readonly ledger: string; readonly reason: string }> } | { readonly ok: false; readonly refused: string; readonly message: string }>;
  readInvite(file: unknown, now: Date): { readonly ok: true; readonly invite: { readonly project: string; readonly hub?: { readonly address: string; readonly writer: string } } } | { readonly ok: false; readonly reason: string; readonly message?: string };
  writeHubAddress(globalStorageDir: string, value: { readonly v: 1; readonly project: string; readonly hub: string; readonly address: string; readonly setAt: string }): Promise<void>;
  hubIdOf(writer: string): string;
  isHubAddress(value: unknown): boolean;
  serverPinWords(certPin: string): string[];
  memberAt(state: never, member: string, position: number): { readonly name: string; readonly seat?: string } | undefined;
  cellsAt(roster: never, keys: never, position: number, scales: never): ReadonlyArray<{ readonly cell: string; readonly base: boolean; readonly label?: unknown; readonly legacy?: readonly unknown[] }>;
  labelKey(label: never): string;
  SCALE_PRESETS: unknown;
  HUB_GRANT_TRADE_OFF: string;
  openHubTransport(options: never): unknown;
}

interface WorkbenchFinishDraft {
  readonly label: string;
  currentBytes(shared: never, roster: never, now: Date): Buffer | undefined;
  commit(shared: never, action: string): Promise<EngineResult>;
}

/** What the share service reads of the session's live engine (StaffLiveEngine). */
export interface ShareLive {
  projects(): StaffStatusRow[];
  project(id: string): EngineProject | undefined;
  shareContext(): ShareContext;
  /** Opens a folder that became shared, or opens it again after its server changed, and starts its replicator. */
  reopen(root: string): Promise<void>;
  /** Runs one exchange for the project now. */
  syncNow(id: string): unknown;
  /** Hosted: the session key's certificate in the project, for the lead flows' own connections to the server. */
  certificateOf(id: string): unknown;
  /** Hosted: certifies the session key in the project at `root` (a conversion's genesis), before its other entries are written (33-30). */
  certifyAt(root: string): Promise<boolean>;
}

/** The deps shared projects open with in this session, the person's secrets and storage, and the session keys when hosted. */
export interface ShareContext {
  readonly deps: object;
  readonly secrets: SecretStorageLike;
  readonly globalStorageDir: string;
  readonly hosted?: HostedSessionKeys;
}

export interface StaffShareServiceOptions {
  readonly engine: StaffShareApi & Pick<StaffEngine, 'hubStanding' | 'readHubAddress' | 'isRosterWriterAt' | 'writerIdOf'> & { x25519BindingBytes(rawX25519: string, writer: string): Buffer };
  /** The session's live engine, once it has started. */
  readonly live: () => ShareLive | undefined;
  readonly actions?: Pick<PendingActions, 'beginAction' | 'resumeAction' | 'reviewAttachment' | 'cancelReview'>;
  /** The open staff project's folder (the workspace folder). */
  readonly root: () => Promise<string | undefined>;
  /** The hub transport factory; the engine's own when absent (tests pass one with short limits). */
  readonly open?: unknown;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

/** Where "Show others what I am working on" is kept for the person (D-21): their key store, so it follows them to every session. */
export const SHOW_WORK_SECRET = 'sterling.staff.showWork';

/** "Show others what I am working on": on unless the person turned it off. */
export async function showWorkOf(secrets: SecretStorageLike): Promise<boolean> {
  return (await secrets.get(SHOW_WORK_SECRET)) !== '0';
}

type Refused = { readonly kind: 'refused'; readonly reason: string; readonly fix?: string };
interface FinishReview {
  readonly owner: symbol;
  readonly root: string;
  readonly live: ShareLive;
  readonly project: EngineProject;
  readonly writer: string;
  readonly signer: NonNullable<ShareContext['hosted']>['keys']['personSigner'];
  readonly signerKey: string;
  readonly cell: string;
  readonly draft: WorkbenchFinishDraft;
}
type Shared = { readonly root: string; readonly live: ShareLive; readonly context: ShareContext; readonly project: EngineProject; readonly roster: EngineRoster; readonly lead: boolean };

const isRefused = (value: unknown): value is Refused => typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'refused';

/** A refusal in the person's words: the key store's step-up sentence becomes the Staff Room's, with its fix. */
function refusal(message: string): Refused {
  return message === KEY_SERVICE_TEXT.stepUpNeeded ? refused(SESSION_KEY_TEXT.stepUp, KEY_SERVICE_TEXT.confirm) as Refused : refused(message) as Refused;
}

function outcome(result: EngineResult, extra: Partial<ShareOutcome> = {}): ServiceResult<ShareOutcome> {
  if (!result.ok) return refusal(result.message);
  return ok({
    message: result.message, notices: [...result.notices],
    ...(result.file === undefined ? {} : { file: { name: result.file.name, text: result.file.text } }),
    ...(result.safetyWords === undefined ? {} : { safetyWords: [...result.safetyWords] }),
    ...extra,
  });
}

export class StaffShareService implements StaffShareServer {
  private readonly finishReviewOwner = Symbol();
  private binding: { readonly key: string; readonly sig: string } | undefined;

  constructor(private readonly options: StaffShareServiceOptions) {}

  public view(): Promise<ServiceResult<ShareView>> {
    return this.guard<ShareView>(async () => {
      const root = await this.options.root();
      const live = this.options.live();
      const showWork = live === undefined ? true : await showWorkOf(live.shareContext().secrets);
      const empty = { lead: false, people: [], parts: [], showWork };
      if (root === undefined || live === undefined) return ok({ state: 'no-project', ...empty });
      const shared = await this.sharedAt(root, live);
      if (isRefused(shared)) return ok({ state: (await this.isStaffFolder(root)) ? 'not-shared' : 'no-project', ...empty });
      const { engine } = this.options;
      const { project, roster, lead } = shared;
      const head = roster.positions.length - 1;
      const people: SharePerson[] = [];
      const members = (roster as unknown as { members: { members: ReadonlyMap<string, unknown> } }).members.members;
      for (const member of members.keys()) {
        const record = engine.memberAt((roster as unknown as { members: never }).members, member, head);
        if (record !== undefined) people.push({ member, name: record.name, ...(record.seat === undefined ? {} : { seat: record.seat }) });
      }
      const standing = (await engine.hubStanding({ project, deps: shared.context.deps } as never)) as Array<{ hub: string; certPin: string; cells: string[]; standing: 'admitted' | 'revoked' }>;
      const hub = standing.find((item) => item.standing === 'admitted') ?? standing[0];
      const held = new Set(hub?.standing === 'admitted' ? hub.cells : []);
      const parts: SharePart[] = engine.cellsAt(roster as never, (project as unknown as { keys: never }).keys, head, engine.SCALE_PRESETS as never)
        .filter((info) => !info.base && info.legacy === undefined && info.label !== undefined)
        .map((info) => ({ cell: info.cell, label: engine.labelKey(info.label as never), onServer: held.has(info.cell) }));
      let server: ShareView['server'];
      if (hub !== undefined) {
        const address = await engine.readHubAddress(shared.context.globalStorageDir, project.projectId, { hub: hub.hub });
        server = { hub: hub.hub, standing: hub.standing, words: engine.serverPinWords(hub.certPin), ...(address === undefined ? {} : { address: address.address }) };
      }
      const keyChanges = this.mayReviewFinish(shared) ? engine.pendingWorkbenchFinishParts(this.host(shared), roster as never) : [];
      const managed = roster.required?.includes(engine.CELL_ACCESS_FEATURE) === true;
      const managedKeyFiles = managed && lead ? engine.workbenchManagedFileChoices(this.host(shared), roster as never) : [];
      return ok({ state: 'shared', project: project.projectId, lead, people: people.sort((a, b) => a.name.localeCompare(b.name)), parts,
        ...(keyChanges.length === 0 ? {} : { keyChanges }), ...(server === undefined ? {} : { server }),
        ...(managed ? { canOpenManagedKeyFile: true } : {}), ...(managedKeyFiles.length === 0 ? {} : { managedKeyFiles }), showWork });
    });
  }

  public turnOn(input: { readonly clearance?: unknown }): Promise<ServiceResult<ShareOutcome>> {
    return this.guard(async () => {
      const root = await this.options.root();
      const live = this.options.live();
      if (root === undefined || live === undefined || !(await this.isStaffFolder(root))) return refused(STAFF_SHARE_TEXT.noProject);
      const context = live.shareContext();
      const deps = await this.depsWithBinding(context);
      if (isRefused(deps)) return deps;
      const keyStatus = (deps as { keyStatus?: unknown }).keyStatus ?? (() => Promise.resolve(() => ({ state: 'active' })));
      const options = input.clearance === undefined ? {} : { leadClearance: input.clearance };
      if (context.hosted !== undefined) {
        // The session key signs the conversion's products and texts, and the fold takes them only once a session.certify names it (D-62):
        // the genesis first, then the certificate, then the conversion runs again from where it stopped (33-30).
        const genesis = await this.options.engine.makeMultiUser(root, { ...deps, staffKeyStatus: keyStatus } as never, { ...options, stopAfter: 'genesis' } as never);
        if ('refused' in genesis) return refusal(genesis.message);
        if (!(await live.certifyAt(root))) return refused(SESSION_KEY_TEXT.stepUp, KEY_SERVICE_TEXT.confirm);
      }
      const made = await this.options.engine.makeMultiUser(root, { ...deps, staffKeyStatus: keyStatus } as never, options as never);
      if ('refused' in made) return refusal(made.message);
      const withheld = this.options.engine.conversionNoticeLines(made.withheld, made.unversioned, (cell) => made.cells.find((item) => item.cell === cell)?.label);
      await live.reopen(root);
      const message = withheld.length === 0 ? STAFF_SHARE_TEXT.shared : `${STAFF_SHARE_TEXT.shared} ${withheld.length === 1 ? 'One product was' : `${withheld.length} products were`} not shared in full; see below.`;
      return ok({ message, notices: [...made.notices], withheld });
    });
  }

  public connectServer(input: { readonly hubFile: string; readonly ceiling?: unknown }): Promise<ServiceResult<ShareOutcome>> {
    return this.lead(async (shared) => {
      const ceiling = input.ceiling ?? { scale: 'org', level: 'Internal', compartments: [], releasability: [] };
      const result = await this.options.engine.connectProjectToHub(this.host(shared), input.hubFile, { ceiling } as never, this.options.open as never);
      const address = addressOf(input.hubFile);
      if ((result.ok || result.reason === 'enrol-unreachable') && result.hub !== undefined && address !== undefined) {
        await this.options.engine.writeHubAddress(shared.context.globalStorageDir, { v: 1, project: shared.project.projectId, hub: result.hub, address, setAt: this.now().toISOString() });
        await shared.live.reopen(shared.root);
      }
      return outcome(result);
    });
  }

  public invite(input: InviteInput): Promise<ServiceResult<ShareOutcome>> {
    return this.lead(async (shared) => {
      const endpoint = await this.endpoint(shared);
      const value = { name: input.name, seat: input.seat, clearance: input.clearance, ...(input.days === undefined ? {} : { days: input.days }) };
      const result = endpoint === undefined
        ? await this.options.engine.inviteToProject(this.host(shared), value as never)
        : await this.options.engine.inviteThroughHub(this.host(shared), value as never, endpoint, this.openFor(shared));
      return outcome(result);
    });
  }

  public openInvitation(input: { readonly text: string; readonly name: string }): Promise<ServiceResult<ShareOutcome>> {
    return this.guard(async () => {
      const root = await this.options.root();
      const live = this.options.live();
      if (root === undefined || live === undefined) return refused(STAFF_SHARE_TEXT.noProject);
      const { engine } = this.options;
      const read = engine.readInvite(input.text, this.now());
      if (!read.ok) return refusal(read.message ?? 'This is not an invitation SovAI can read. Ask the person who sent it for a new file.');
      const context = live.shareContext();
      const deps = await this.depsWithBinding(context);
      if (isRefused(deps)) return deps;
      const joined = await engine.joinFromInvite(root, deps as never, input.text, { name: input.name });
      if (!joined.ok || joined.file === undefined) return outcome(joined);
      const hub = read.invite.hub;
      if (hub === undefined) return outcome(joined);
      // The invitation's server, for the project being joined: kept for this computer so the engine syncs once the welcome is opened (D-10).
      await engine.writeHubAddress(context.globalStorageDir, { v: 1, project: read.invite.project, hub: engine.hubIdOf(hub.writer), address: hub.address, setAt: this.now().toISOString() });
      const sent = await engine.sendJoinRequestThroughHub(input.text, joined.file.text, deps as never, this.options.open as never);
      return sent.ok ? outcome(sent, { file: joined.file }) : outcome({ ...joined, message: `${joined.message} ${sent.message}` });
    });
  }

  public openWelcome(input: { readonly text: string }): Promise<ServiceResult<ShareOutcome>> {
    return this.guard(async () => {
      const root = await this.options.root();
      const live = this.options.live();
      if (root === undefined || live === undefined) return refused(STAFF_SHARE_TEXT.noProject);
      const opened = await this.options.engine.openWelcome(root, live.shareContext().deps as never, input.text);
      await opened.project?.close();
      if (opened.ok) await live.reopen(root);
      return outcome(opened);
    });
  }

  public joinRequests(): Promise<ServiceResult<readonly ShareJoinRequest[]>> {
    return this.lead(async (shared) => {
      const endpoint = await this.endpoint(shared);
      if (endpoint === undefined) return refused(STAFF_SHARE_TEXT.noServer);
      const fetched = await this.options.engine.fetchJoinRequests(this.host(shared), endpoint, this.openFor(shared));
      if (!fetched.ok) return refusal(fetched.message);
      const found: ShareJoinRequest[] = [];
      for (const request of fetched.requests ?? []) {
        const reviewed = await this.options.engine.reviewJoinRequest(this.host(shared), request.text);
        if (!reviewed.ok || reviewed.safetyWords === undefined) continue;
        found.push({ invite: request.invite, name: nameOf(request.text), safetyWords: [...reviewed.safetyWords], text: request.text });
      }
      return ok(found);
    });
  }

  public admit(input: { readonly request: string; readonly codeMatched: boolean }): Promise<ServiceResult<ShareOutcome>> {
    return this.lead(async (shared) => outcome(await this.options.engine.admitJoinRequest(this.host(shared), input.request, { codeMatched: input.codeMatched === true })));
  }

  public remove(input: { readonly member: string; readonly requestId?: string }): Promise<ServiceResult<ShareOutcome>> {
    return this.shared(async (shared) => {
      if (!shared.lead) return refused(STAFF_SHARE_TEXT.notLead);
      const { engine, actions } = this.options;
      const target = { member: input.member };
      if (shared.context.hosted === undefined || !shared.roster.required?.includes(engine.CELL_ACCESS_FEATURE)) {
        if (input.requestId !== undefined) return refused(STAFF_SHARE_TEXT.removalNeedsReview);
        const result = await engine.removeFromProject(this.host(shared), target);
        shared.live.syncNow(shared.project.projectId);
        return outcome(result);
      }

      if (actions === undefined) return refused(SESSION_KEY_TEXT.stepUp, KEY_SERVICE_TEXT.confirm);
      const payload = engine.managedWithdrawalActionBytes(shared.roster as never, shared.project.deviceWriter, target);
      if (payload === undefined) return refused(STAFF_SHARE_TEXT.removalUnavailable);
      if (input.requestId === undefined) {
        const record = engine.memberAt(shared.roster.members as never, input.member, shared.roster.positions.length - 1);
        if (record === undefined) return refused(STAFF_SHARE_TEXT.removalUnavailable);
        const fields = [{ label: 'Person', value: record.name }, ...(record.seat === undefined ? [] : [{ label: 'Position', value: record.seat }])];
        const { requestId, nonce } = actions.beginAction(payload, { kind: 'member.remove', fields });
        return ok({ message: STAFF_SHARE_TEXT.removalReady, notices: [], confirmation: { requestId, url: actionStepUpUrl(nonce) } });
      }

      const action = isActionNonce(input.requestId) ? actions.resumeAction(input.requestId, payload) : undefined;
      if (action === undefined) return refused(STAFF_SHARE_TEXT.removalNeedsReview);
      const result = await engine.removeFromProject(this.host(shared), target, action);
      if (result.ok) shared.live.syncNow(shared.project.projectId);
      return result.reason === 'action-required' ? refused(STAFF_SHARE_TEXT.removalNeedsReview) : outcome(result);
    });
  }

  public saveManagedKeys(input: SaveManagedKeyFileInput): Promise<ServiceResult<ShareOutcome>> {
    return this.shared(async (shared) => {
      if (!this.selectedManagedFileProject(shared, input.project)) return refused(STAFF_SHARE_TEXT.managedKeyFileProjectChanged);
      if (!shared.lead) return refused(STAFF_SHARE_TEXT.notLead);
      if (input.repeat !== undefined && !/^[0-9a-f]{64}$/.test(input.repeat)) return refused(STAFF_SHARE_TEXT.managedKeyFileRepeatUnavailable);
      const file = await this.options.engine.exportWorkbenchManagedFile(this.host(shared), input.cell, input.recipient, input.repeat);
      if (file === undefined) return refused(input.repeat === undefined ? STAFF_SHARE_TEXT.managedKeyFileUnavailable : STAFF_SHARE_TEXT.managedKeyFileRepeatUnavailable);
      if (await this.options.root() !== shared.root || !this.selectedManagedFileProject(shared, input.project)) return refused(STAFF_SHARE_TEXT.managedKeyFileProjectChanged);
      return ok({ message: STAFF_SHARE_TEXT.managedKeyFileSaved, notices: [], file: { name: file.name, text: file.text }, fileRepeat: file.repeat });
    });
  }

  public openManagedKeys(input: OpenManagedKeyFileInput): Promise<ServiceResult<ShareOutcome>> {
    return this.shared(async (shared) => {
      if (!this.selectedManagedFileProject(shared, input.project)) return refused(STAFF_SHARE_TEXT.managedKeyFileProjectChanged);
      if (typeof input.text !== 'string' || input.text.length > MANAGED_KEY_FILE_MAX_BYTES ||
          Buffer.byteLength(input.text) > MANAGED_KEY_FILE_MAX_BYTES) return refused(STAFF_SHARE_TEXT.managedKeyFileTooLarge);
      return outcome(await this.options.engine.openWorkbenchManagedFile(this.host(shared), input.text));
    });
  }

  private selectedManagedFileProject(shared: Shared, project: string): boolean {
    return shared.project.projectId === project && this.options.live() === shared.live && shared.live.project(project) === shared.project &&
      shared.roster.required?.includes(this.options.engine.CELL_ACCESS_FEATURE) === true;
  }

  public finishKeyChange(input: { readonly cell: string; readonly requestId?: string }): Promise<ServiceResult<ShareOutcome>> {
    return this.shared(async (shared) => {
      const { engine, actions } = this.options;
      if (!shared.lead) return refused(STAFF_SHARE_TEXT.notLead);
      const signer = shared.context.hosted?.keys?.personSigner;
      if (signer === undefined || !shared.roster.required?.includes(engine.CELL_ACCESS_FEATURE)) {
        return refused(input.requestId === undefined ? STAFF_SHARE_TEXT.keyChangeUnavailable : STAFF_SHARE_TEXT.keyChangeNeedsReview);
      }
      if (actions === undefined) return refused(SESSION_KEY_TEXT.stepUp, KEY_SERVICE_TEXT.confirm);
      const host = this.host(shared);
      const roster = shared.roster as never;
      const now = this.now();
      if (input.requestId === undefined) {
        const draft = engine.prepareWorkbenchFinish(host, roster, input.cell, now);
        const bytes = draft?.currentBytes(host, roster, now);
        if (draft === undefined || bytes === undefined) return refused(STAFF_SHARE_TEXT.keyChangeUnavailable);
        const review: FinishReview = { owner: this.finishReviewOwner, root: shared.root, live: shared.live, project: shared.project,
          writer: shared.project.deviceWriter, signer, signerKey: signer.publicKey, cell: input.cell, draft };
        const { requestId, nonce } = actions.beginAction(bytes, { kind: 'cell.rekey.finish', fields: [{ label: 'Part', value: draft.label }] }, review);
        return ok({ message: STAFF_SHARE_TEXT.keyChangeReady, notices: [], confirmation: { requestId, url: actionStepUpUrl(nonce) } });
      }

      const requestId = input.requestId;
      const review = isActionNonce(requestId) ? actions.reviewAttachment(requestId) as FinishReview | undefined : undefined;
      if (review?.owner !== this.finishReviewOwner || review.cell !== input.cell) return refused(STAFF_SHARE_TEXT.keyChangeNeedsReview);
      const current = review.root === shared.root && review.live === shared.live && review.project === shared.project &&
        review.writer === shared.project.deviceWriter && review.signer === signer && review.signerKey === signer.publicKey &&
        this.options.live() === shared.live && shared.live.project(shared.project.projectId) === shared.project;
      const bytes = current ? review.draft.currentBytes(host, roster, now) : undefined;
      if (bytes === undefined) {
        actions.cancelReview(requestId);
        return refused(STAFF_SHARE_TEXT.keyChangeNeedsReview);
      }
      const action = actions.resumeAction(requestId, bytes);
      if (action === undefined) return refused(STAFF_SHARE_TEXT.keyChangeNeedsReview);
      const result = await review.draft.commit(host, action);
      if (result.ok) shared.live.syncNow(shared.project.projectId);
      return result.reason === 'action-required' ? refused(STAFF_SHARE_TEXT.keyChangeNeedsReview) : outcome(result);
    });
  }

  private mayReviewFinish(shared: Shared): boolean {
    return shared.lead && this.options.actions !== undefined && shared.context.hosted?.keys?.personSigner !== undefined &&
      shared.roster.required?.includes(this.options.engine.CELL_ACCESS_FEATURE) === true;
  }

  public grant(input: { readonly cell: string; readonly confirmed: boolean }): Promise<ServiceResult<ShareOutcome>> {
    return this.lead(async (shared) => outcome(await this.options.engine.grantCellToHub(this.host(shared), { cell: input.cell, confirmed: input.confirmed === true })));
  }

  public revoke(): Promise<ServiceResult<ShareOutcome>> {
    return this.lead(async (shared) => {
      const result = await this.options.engine.revokeHub(this.host(shared), {});
      if (result.ok) await shared.live.reopen(shared.root);
      return outcome(result);
    });
  }

  public changeAddress(input: { readonly address: string }): Promise<ServiceResult<ShareOutcome>> {
    return this.shared(async (shared) => {
      if (!this.options.engine.isHubAddress(input.address)) return refused(STAFF_SHARE_TEXT.badAddress);
      const hub = await this.admittedHub(shared);
      if (hub === undefined) return refused(STAFF_SHARE_TEXT.noServer);
      // Only the address changes: the pin stays in the roster and is checked again at the next connection (D-10).
      await this.options.engine.writeHubAddress(shared.context.globalStorageDir, { v: 1, project: shared.project.projectId, hub: hub.hub, address: input.address, setAt: this.now().toISOString() });
      await shared.live.reopen(shared.root);
      return ok({ message: STAFF_SHARE_TEXT.addressChanged, notices: [] });
    });
  }

  public readmit(input: { readonly words: string; readonly certPin?: string }): Promise<ServiceResult<ShareOutcome>> {
    return this.lead(async (shared) => {
      const hub = await this.admittedHub(shared);
      if (hub === undefined) return refused(STAFF_SHARE_TEXT.noServer);
      const result = await this.options.engine.readmitHub(this.host(shared), { hub: hub.hub, certPin: input.certPin ?? hub.certPin, words: input.words });
      if (result.ok) await shared.live.reopen(shared.root);
      return outcome(result);
    });
  }

  public singleCopy(input: { readonly destination: string }): Promise<ServiceResult<ShareOutcome>> {
    return this.shared(async (shared) => {
      const head = shared.roster.positions.length - 1;
      const self = shared.roster.members.devices.get(shared.project.deviceWriter)?.at(-1);
      const name = self === undefined ? 'A member' : this.options.engine.memberAt((shared.roster as unknown as { members: never }).members, self.member, head)?.name ?? 'A member';
      const copied = await this.options.engine.makeSingleMachineCopy(shared.root, input.destination, { ...shared.context.deps, copier: { name, role: 'member' } } as never);
      if (!copied.ok) return refusal(copied.message);
      const lines = [
        ...copied.differs.map((item) => `${item.product}: ${item.reason}`),
        ...copied.left.map((item) => `${item.ledger}: ${item.reason}`),
      ];
      return ok({ message: `The single-machine copy is ready in ${input.destination}.${copied.contested.length === 0 ? '' : ` ${copied.contested.length} contested decisions were left undecided in it.`}`, notices: [...copied.notices, ...lines] });
    });
  }

  public setShowWork(on: boolean): Promise<ServiceResult<boolean>> {
    return this.guard(async () => {
      const live = this.options.live();
      if (live === undefined) return refused(STAFF_SHARE_TEXT.noProject);
      await live.shareContext().secrets.store(SHOW_WORK_SECRET, on === true ? '1' : '0');
      return ok(on === true);
    });
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------------------------------------

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private host(shared: Shared): never {
    return { project: shared.project, deps: shared.context.deps } as never;
  }

  private async isStaffFolder(root: string): Promise<boolean> {
    const { stat } = await import('node:fs/promises');
    const { join } = await import('node:path');
    try {
      return (await stat(join(root, '.planning', 'staff'))).isDirectory();
    } catch {
      return false;
    }
  }

  /** The open shared project of the folder, as the live engine has it open. */
  private async sharedAt(root: string, live: ShareLive): Promise<Shared | Refused> {
    const row = live.projects().find((item) => item.root === root);
    const project = row === undefined ? undefined : live.project(row.project);
    if (project === undefined) return refused(STAFF_SHARE_TEXT.notOpen) as Refused;
    const { roster } = await project.state();
    const lead = this.options.engine.isRosterWriterAt(roster as never, project.deviceWriter, roster.positions.length - 1);
    return { root, live, context: live.shareContext(), project, roster, lead };
  }

  private shared<T>(work: (shared: Shared) => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    return this.guard(async () => {
      const root = await this.options.root();
      const live = this.options.live();
      if (root === undefined || live === undefined) return refused(STAFF_SHARE_TEXT.noProject);
      const shared = await this.sharedAt(root, live);
      return isRefused(shared) ? shared : work(shared);
    });
  }

  /**
   * The connections a lead flow opens to your organization's server (an invitation, the join requests). In a hosted session the session key answers
   * the server, so its certificate goes with the answer, as the replicator's does (33-22); otherwise the engine's own transport.
   */
  private openFor(shared: Shared): never {
    if (this.options.open !== undefined) return this.options.open as never;
    const certificate = shared.live.certificateOf(shared.project.projectId);
    if (certificate === undefined) return undefined as never;
    return ((options: object) => this.options.engine.openHubTransport({ ...options, certificate } as never)) as never;
  }

  /** A lead action; what it wrote goes to your organization's server at once (one exchange), so the other computers see it. */
  private lead<T>(work: (shared: Shared) => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    return this.shared(async (shared) => {
      if (!shared.lead) return refused(STAFF_SHARE_TEXT.notLead);
      const result = await work(shared);
      shared.live.syncNow(shared.project.projectId);
      return result;
    });
  }

  private async admittedHub(shared: Shared): Promise<{ hub: string; certPin: string } | undefined> {
    const standing = (await this.options.engine.hubStanding({ project: shared.project, deps: shared.context.deps } as never)) as Array<{ hub: string; certPin: string; standing: string }>;
    return standing.find((item) => item.standing === 'admitted');
  }

  /** Where this computer reaches the project's server: the kept address of the admitted hub, or undefined before one is connected. */
  private async endpoint(shared: Shared): Promise<{ address: string; hub: string } | undefined> {
    const hub = await this.admittedHub(shared);
    if (hub === undefined) return undefined;
    const kept = await this.options.engine.readHubAddress(shared.context.globalStorageDir, shared.project.projectId, { hub: hub.hub });
    return kept === undefined ? undefined : { address: kept.address, hub: hub.hub };
  }

  /**
   * The deps a flow that makes or joins shared work runs with. In a hosted session the person key binds the X25519 key (D-19, D-61): signed once
   * per session through the person signer, so the genesis and the welcome name a key the person key vouches for.
   */
  private async depsWithBinding(context: ShareContext): Promise<object | Refused> {
    const hosted = context.hosted;
    if (hosted === undefined) return context.deps;
    const { personSigner } = hosted.keys;
    const x25519 = hosted.encryption.publicKey;
    if (this.binding?.key !== x25519) {
      const sig = await personSigner.sign(this.options.engine.x25519BindingBytes(x25519, this.options.engine.writerIdOf(personSigner.publicKey)));
      if (typeof sig !== 'string') return refusal(sig.refused);
      this.binding = { key: x25519, sig };
    }
    const deps = context.deps as { hosted: { personPublicKey: string; encryption: object } };
    return { ...deps, hosted: { ...deps.hosted, encryption: { ...deps.hosted.encryption, binding: this.binding.sig } } };
  }

  /** Runs an action; an engine refusal thrown on the way (a signature the person key refused) comes back as a refusal, never as an error. */
  private async guard<T>(work: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    try {
      return await work();
    } catch (error) {
      const message = (error as { refusal?: { message?: unknown } }).refusal?.message;
      if (typeof message === 'string') return refusal(message);
      if (error instanceof Error && error.message === KEY_SERVICE_TEXT.stepUpNeeded) return refusal(error.message);
      this.options.log?.(`staff: a Share with people action failed (${error instanceof Error ? error.name : 'error'})`);
      return refused('SovAI could not finish this. Nothing more was changed. Try again, or ask your administrator.');
    }
  }
}

/** The address the operator's hub file names, read after the engine checked the file. */
function addressOf(hubFile: string): string | undefined {
  try {
    const address = (JSON.parse(hubFile) as { payload?: { address?: unknown } }).payload?.address;
    return typeof address === 'string' ? address : undefined;
  } catch {
    return undefined;
  }
}

/** The name the person typed in their join request, as the lead compares it with them. */
function nameOf(requestText: string): string {
  try {
    const name = (JSON.parse(requestText) as { payload?: { name?: unknown } }).payload?.name;
    return typeof name === 'string' ? name : 'A person';
  } catch {
    return 'A person';
  }
}

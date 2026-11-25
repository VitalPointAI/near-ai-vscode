/**
 * The native Staff Room's service (Phase 33 D-21 to D-26, D-44, D-48, D-59, D-60; Pitfall N8.4): one per session backend, at STAFF_ROOM_PATH. For
 * each open shared work it builds the room with the pure live model (staffRoomLive) from the live engine's status, the fold's versions (contested
 * cards, changes since, decisions waiting for your organization's server), the roster (who can see what, roster splits, the lead's device) and the
 * people list, and sends it to every tab when anything changes.
 *
 * Decisions (D-24, D-60): beginDecision takes the decision stamp of the version on screen (versionActs.decisionStamp) and keeps it here for the
 * step-up window only; decide writes version.decide with that stamp, signed by the person key (the project's signer for the kind). A decision on
 * that version that folded meanwhile refuses with CHANGED_WHILE_DECIDING_TEXT and writes nothing. A confirmation that is too old answers with the
 * link that confirms it; the stamp stays, so the same decision finishes when the person comes back. Only a person decides: the acts run as a person.
 *
 * The switch to post-quantum keys (33.2 D-05): the room shows this computer's Switch, Move or Give keys card, and its actions run in the live
 * engine. Each refusal comes back as its sentence; a confirmation that is too old answers with the link that confirms it, as a decision does.
 *
 * No log line holds text, a key, a token or a name.
 */
import { randomUUID } from 'node:crypto';
import type { interfaces } from '@theia/core/shared/inversify';
import type { RpcProxy } from '@theia/core/lib/common/messaging/index.js';
import { KEY_SERVICE_TEXT } from '../../common/key-service.js';
import { ok, refused, type ServiceResult } from '../../common/service-result.js';
import { stepUpUrl } from '../../common/session-identity.js';
import {
  STAFF_ROOM_PATH, STAFF_ROOM_TEXT, StaffRoomServer, type StaffDecisionResult, type StaffPendingDecision, type StaffRoom, type StaffRoomClient,
  type StaffRoomLiveView, type StaffSignedResult,
} from '../../common/staff-room.js';
import type { StaffStatusRow } from '../../common/staff-live.js';
import { bindBackendService } from '../backend-service.js';
import type { EngineProject, StaffEngine } from './staff-engine.js';
import type { StaffKeysAnswer, StaffLiveEngine } from './staff-live-engine.js';

/** How long a begun decision keeps its stamp: the step-up trip and back (Pitfall N8.4). */
export const DECISION_WINDOW_MS = 15 * 60_000;

/** What the Staff Room reads of the session's live engine. */
export type RoomLiveSource = Pick<StaffLiveEngine, 'projects' | 'shared' | 'projectionInput' | 'onStatus' | 'onJoinRequest' | 'localAppended'
  | 'wrapCards' | 'switchToV2' | 'moveCellsToV2' | 'giveKeys'> & Partial<Pick<StaffLiveEngine, 'people' | 'onPeople'>>;

/** A person in the people list (livePresence.ts PresencePerson). */
export interface RoomPerson {
  readonly member: string;
  readonly name: string;
  readonly position?: string;
  readonly live: boolean;
  readonly lastSeen: number;
  readonly product?: string;
  readonly runs?: number;
}

type ActResult = { readonly ok: true; readonly hash: string } | { readonly ok: false; readonly reason: string; readonly message: string };

/** The version acts a decision uses (versionActs.ts VersionActs). */
export interface RoomActs {
  decisionStamp(input: { product: string; hash: string }): Promise<string | undefined>;
  decide(input: { product: string; hash: string; outcome: 'approve' | 'reject'; reasons: readonly string[]; stamp?: string; settle?: boolean }): Promise<ActResult>;
  propose(input: { product: string }): Promise<ActResult>;
}

export interface StaffRoomServiceOptions {
  readonly live: () => RoomLiveSource | undefined;
  readonly engine: Pick<StaffEngine, 'staffRoomLive' | 'VersionActs' | 'contestedCards' | 'changesSinceRows' | 'pendingConfirmation' | 'memberNameAt' | 'whoCanSee'
    | 'chooseRosterBranch' | 'describeRosterBranches' | 'isRosterWriterAt' | 'syncStatusFor' | 'projectProductStates'>;
  /** The acr of your organization's step-up sign-in, when it has one (STERLING_STEPUP_ACR). */
  readonly stepUpAcr?: () => string | undefined;
  /** The other people of a shared work (33-12's LivePresence); by default the live engine's presence (33-29). */
  readonly people?: (project: string) => readonly RoomPerson[] | undefined;
  /** The acts of one shared work; by default the engine's VersionActs as a person. */
  readonly actsFor?: (shared: { project: EngineProject; deps: object }) => RoomActs;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

interface Ticket extends StaffPendingDecision {
  readonly project: string;
  readonly stamp: string;
  readonly expires: number;
}

/** The fold's versions family, as far as the room reads it. */
interface VersionsProduct { readonly stream: string; readonly product: string }

export class StaffRoomService implements StaffRoomServer {
  private readonly clients = new Set<StaffRoomClient>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly joins = new Map<string, Map<string, { invite: string }>>();
  private readonly dismissed = new Map<string, Set<string>>();
  private readonly watched = new WeakSet<object>();

  constructor(private readonly options: StaffRoomServiceOptions) {}

  public addClient(client: RpcProxy<StaffRoomClient> | (StaffRoomClient & { onDidCloseConnection?: RpcProxy<StaffRoomClient>['onDidCloseConnection'] })): void {
    this.clients.add(client);
    client.onDidCloseConnection?.(() => { this.clients.delete(client); });
    void this.rooms().then((rooms) => { for (const room of rooms) client.onRoom(room); }).catch(() => undefined);
  }

  public async rooms(): Promise<StaffRoom[]> {
    const live = this.options.live();
    if (live === undefined) return [];
    this.watch(live);
    const out: StaffRoom[] = [];
    for (const row of live.projects()) {
      const room = await this.room(live, row).catch(() => undefined);
      if (room !== undefined) out.push(room);
    }
    return out;
  }

  public async beginDecision(project: string, product: string, hash: string, settle: boolean): Promise<ServiceResult<StaffPendingDecision>> {
    const shared = this.options.live()?.shared(project);
    if (shared === undefined) return refused(STAFF_ROOM_TEXT.notOpen);
    const stamp = await this.acts(shared).decisionStamp({ product, hash });
    if (stamp === undefined) return refused(STAFF_ROOM_TEXT.notVersion);
    const { fold } = await shared.project.state();
    const number = ((fold as { families: Record<string, unknown> }).families.versions as Array<VersionsProduct & { versions: Array<{ hash: string; number: number }> }> | undefined ?? [])
      .find((item) => item.product === product)?.versions.find((version) => version.hash === hash)?.number ?? 0;
    // One decision at a time per shared work: a new begin replaces the one before.
    for (const [ticket, item] of this.tickets) if (item.project === project) this.tickets.delete(ticket);
    const ticket: Ticket = { ticket: randomUUID(), project, product, hash, number, settle, title: `v${number} of ${product}`, stamp, expires: this.now() + DECISION_WINDOW_MS };
    this.tickets.set(ticket.ticket, ticket);
    void this.push(project);
    return ok(this.pendingOf(ticket));
  }

  public async decide(ticketId: string, outcome: 'approve' | 'reject', reasons: readonly string[], returnTo: string): Promise<StaffDecisionResult> {
    const ticket = this.ticket(ticketId);
    const shared = ticket === undefined ? undefined : this.options.live()?.shared(ticket.project);
    if (ticket === undefined || shared === undefined) return refused(STAFF_ROOM_TEXT.decisionGone);
    const result = await this.acts(shared).decide({ product: ticket.product, hash: ticket.hash, outcome, reasons: [...reasons], stamp: ticket.stamp, settle: ticket.settle });
    if (result.ok) {
      this.tickets.delete(ticketId);
      this.options.live()?.localAppended(ticket.project);
      void this.push(ticket.project);
      return ok({ hash: result.hash });
    }
    // The stamp stays for the trip to confirm: the same decision finishes when the person comes back (Pitfall N8.4).
    if (isStepUp(result)) return this.stepUp(result.message, returnTo);
    this.tickets.delete(ticketId);
    void this.push(ticket.project);
    this.log(`staff: a decision was not written (${result.reason})`);
    return refused(result.message);
  }

  public async cancelDecision(ticketId: string): Promise<void> {
    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined) return;
    this.tickets.delete(ticketId);
    void this.push(ticket.project);
  }

  public async admit(_project: string, _invite: string): Promise<ServiceResult<string>> {
    return refused(STAFF_ROOM_TEXT.joinLater);
  }

  public async decline(_project: string, _invite: string): Promise<ServiceResult<string>> {
    return refused(STAFF_ROOM_TEXT.joinLater);
  }

  public async choose(project: string, branch: string): Promise<ServiceResult<string>> {
    const shared = this.options.live()?.shared(project);
    if (shared === undefined) return refused(STAFF_ROOM_TEXT.notOpen);
    const result = await this.options.engine.chooseRosterBranch(shared as never, branch) as { ok: boolean; message?: string; hash?: string };
    void this.push(project);
    if (!result.ok) return refused(result.message ?? STAFF_ROOM_TEXT.notOpen);
    this.options.live()?.localAppended(project);
    return ok(branch);
  }

  public async propose(project: string, product: string): Promise<ServiceResult<string>> {
    const shared = this.options.live()?.shared(project);
    if (shared === undefined) return refused(STAFF_ROOM_TEXT.notOpen);
    const result = await this.acts(shared).propose({ product });
    void this.push(project);
    if (!result.ok) return refused(result.message);
    this.options.live()?.localAppended(project);
    return ok(result.hash);
  }

  public async dismiss(project: string, product: string, hash: string): Promise<void> {
    const set = this.dismissed.get(project) ?? new Set<string>();
    set.add(`${product}:${hash}`);
    this.dismissed.set(project, set);
    await this.push(project);
  }

  public switchToV2(project: string, returnTo: string): Promise<StaffSignedResult<string>> {
    return this.keys(project, returnTo, (live) => live.switchToV2(project));
  }

  public moveCellsToV2(project: string, includeWaiting: boolean, returnTo: string): Promise<StaffSignedResult<string>> {
    return this.keys(project, returnTo, (live) => live.moveCellsToV2(project, includeWaiting));
  }

  public giveKeys(project: string, returnTo: string): Promise<StaffSignedResult<string>> {
    return this.keys(project, returnTo, (live) => live.giveKeys(project));
  }

  /** A key action in the live engine; the room is sent again either way, so a card that went away goes from every tab. */
  private async keys(project: string, returnTo: string, act: (live: RoomLiveSource) => Promise<StaffKeysAnswer>): Promise<StaffSignedResult<string>> {
    const live = this.options.live();
    if (live === undefined || live.shared(project) === undefined) return refused(STAFF_ROOM_TEXT.notOpen);
    const answer = await act(live);
    void this.push(project);
    if (answer.ok) return ok(project);
    return isStepUp(answer) ? this.stepUp(answer.message, returnTo) : refused(answer.message);
  }

  /** A person key that wants a fresh confirmation: the link that confirms it and comes back to `returnTo`, or the fix alone without one. */
  private stepUp(message: string, returnTo: string): StaffSignedResult<never> {
    const acr = this.options.stepUpAcr?.();
    if (acr !== undefined) {
      try {
        return { kind: 'step-up', reason: message, fix: KEY_SERVICE_TEXT.confirm, url: stepUpUrl(returnTo, acr) };
      } catch {
        return refused(message, KEY_SERVICE_TEXT.confirm);
      }
    }
    return refused(message, KEY_SERVICE_TEXT.confirm);
  }

  private acts(shared: { project: EngineProject; deps: object }): RoomActs {
    if (this.options.actsFor !== undefined) return this.options.actsFor(shared);
    const Acts = this.options.engine.VersionActs as unknown as new (project: never, actor: { kind: 'person' }, context: object) => RoomActs;
    return new Acts(shared.project as never, { kind: 'person' }, { deps: shared.deps });
  }

  private ticket(id: string): Ticket | undefined {
    const ticket = this.tickets.get(id);
    if (ticket !== undefined && ticket.expires <= this.now()) {
      this.tickets.delete(id);
      return undefined;
    }
    return ticket;
  }

  private pendingOf(ticket: Ticket): StaffPendingDecision {
    return { ticket: ticket.ticket, product: ticket.product, hash: ticket.hash, number: ticket.number, settle: ticket.settle, title: ticket.title };
  }

  private watch(live: RoomLiveSource): void {
    if (this.watched.has(live)) return;
    this.watched.add(live);
    live.onStatus((row) => { void this.push(row.project); });
    live.onPeople?.((project) => { void this.push(project); });
    live.onJoinRequest((request) => {
      if (request.invite === undefined) return;
      const joins = this.joins.get(request.project) ?? new Map<string, { invite: string }>();
      joins.set(request.invite, { invite: request.invite });
      this.joins.set(request.project, joins);
      void this.push(request.project);
    });
  }

  /** Sends the project's room to every tab. */
  private async push(project: string): Promise<void> {
    const live = this.options.live();
    const row = live?.projects().find((item) => item.project === project);
    if (live === undefined || row === undefined || this.clients.size === 0) return;
    const room = await this.room(live, row).catch(() => undefined);
    if (room === undefined) return;
    for (const client of [...this.clients]) client.onRoom(room);
  }

  private async room(live: RoomLiveSource, row: StaffStatusRow): Promise<StaffRoom | undefined> {
    const shared = live.shared(row.project);
    if (shared === undefined) return undefined;
    const { engine } = this.options;
    const { project } = shared;
    const { fold, roster } = await project.state() as unknown as { fold: { families: Record<string, unknown> }; roster: RosterLike };
    const versions = (fold.families.versions as VersionsProduct[] | undefined) ?? [];
    const head = roster.positions.length - 1;
    const me = [...(roster.members.devices.get(project.deviceWriter) ?? [])].reverse()[0]?.member;
    const myRecord = me === undefined ? undefined : [...(roster.members.members.get(me) ?? [])].reverse()[0];
    const input = await live.projectionInput(row.project).catch(() => undefined);
    const states = input === undefined ? new Map() : engine.projectProductStates(input as never);
    const streamOf = new Map<string, string>();
    for (const item of versions) if (!streamOf.has(item.product)) streamOf.set(item.product, item.stream);
    const products = [...states.entries()].map(([product, state]) => {
      const meta = (state as { meta?: { label?: string }; record: { roles?: { owner?: string } } });
      const stream = streamOf.get(product);
      return {
        product, ...(meta.meta?.label === undefined ? {} : { label: meta.meta.label }),
        whoCanSee: stream === undefined ? [] : engine.whoCanSee(roster as never, stream),
        owned: myRecord?.seat !== undefined && meta.record.roles?.owner === myRecord.seat,
      };
    });
    const status = (engine.syncStatusFor(row.root) as unknown as { status?: { state: string; reason?: string; findings: readonly string[]; lastSyncedAt?: number } }).status
      ?? { state: row.state, findings: [], ...(row.lastSyncedAt === undefined ? {} : { lastSyncedAt: row.lastSyncedAt }) };
    const isLeadDevice = engine.isRosterWriterAt(roster as never, project.deviceWriter, head);
    const splits = roster.pending.length === 0 || !isLeadDevice ? [] : await this.splits(shared, roster);
    // This person, then the others presence has heard (33-29 runs it; LivePresence never lists this computer's own heartbeat).
    const others = this.options.people?.(row.project) ?? live.people?.(row.project) ?? [];
    const people = [...(myRecord === undefined ? [] : [{
      member: myRecord.member, name: myRecord.name, ...(myRecord.seat === undefined ? {} : { position: myRecord.seat }), live: true, lastSeen: this.now(),
    }]), ...others.filter((person) => person.member !== myRecord?.member)];
    const view = engine.staffRoomLive({
      status,
      isLeadDevice,
      people,
      products,
      versions: engine.changesSinceRows(versions as never),
      contested: engine.contestedCards(versions as never, (member: string, at: string) => engine.memberNameAt(roster as never, member, at)),
      unconfirmed: engine.pendingConfirmation(versions as never),
      joins: [...(this.joins.get(row.project)?.values() ?? [])],
      splits,
      agents: [],
      earlyShareCopyNeeded: versions.some((item) => item.stream === project.projectId),
      dismissed: [...(this.dismissed.get(row.project) ?? [])],
      wrapCards: await live.wrapCards(row.project).catch(() => []),
    } as never) as StaffRoomLiveView;
    const pending = [...this.tickets.values()].find((ticket) => ticket.project === row.project && ticket.expires > this.now());
    return { project: row.project, root: row.root, view, ...(pending === undefined ? {} : { pending: this.pendingOf(pending) }) };
  }

  private async splits(shared: { project: EngineProject; deps: object }, roster: RosterLike): Promise<Array<{ at: string; text: string; branches: Array<{ hash: string; text: string }> }>> {
    const views = await this.options.engine.describeRosterBranches(shared as never).catch(() => []) as Array<{ branch: string; summary: string; by?: string }>;
    return roster.pending.map((split) => ({
      at: split.at, text: split.text,
      branches: split.branches.map((hash) => {
        const view = views.find((item) => item.branch === hash);
        return { hash, text: view === undefined ? hash.slice(0, 8) : view.by === undefined ? `${view.summary}.` : `${view.summary}, by ${view.by}.` };
      }),
    }));
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

/** A refusal of the person key that a fresh confirmation with the passkey or security key lifts. */
const isStepUp = (result: { readonly reason?: string; readonly message: string }): boolean =>
  result.reason === 'signer-refused' && result.message === KEY_SERVICE_TEXT.stepUpNeeded;

/** The roster as far as the room reads it; the rest goes back to the engine untouched. */
interface RosterLike {
  readonly positions: readonly string[];
  readonly pending: ReadonlyArray<{ readonly at: string; readonly branches: readonly string[]; readonly text: string }>;
  readonly members: {
    readonly devices: ReadonlyMap<string, ReadonlyArray<{ readonly member: string }>>;
    readonly members: ReadonlyMap<string, ReadonlyArray<{ readonly member: string; readonly name: string; readonly seat?: string }>>;
  };
}

/** Binds the Staff Room service and its RPC path, with every tab as a client. */
export function bindStaffRoomService(bind: interfaces.Bind, options: (context: interfaces.Context) => StaffRoomServiceOptions): void {
  bindBackendService<StaffRoomService, StaffRoomClient>(bind, StaffRoomServer, STAFF_ROOM_PATH, (context) => new StaffRoomService(options(context)),
    (service, client) => service.addClient(client));
}

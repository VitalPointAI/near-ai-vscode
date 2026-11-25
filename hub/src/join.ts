// Join requests through your organization's hub (D-37, D-39, D-47, D-48, D-58, D-60). The hub never holds a join secret: the lead's device registers
// an invitation over its session with the invite id, its expiry and the hub check key (hubJoinCheckKey in src/domain/replica/invite.ts, HKDF of the
// secret), and a joining device posts {join, request}: the hub join envelope it signed (buildHubJoin, purpose staff-hub-join, with hubMac under the
// check key) and its Phase 31 signed join request. The hub's acceptance admits nobody. The lead's device still checks the Phase 31 MAC with the real
// secret and compares the six words before anyone is admitted.
//
// States of one invitation on the hub:
//   (none) --register by a lead or deputy device--> registered
//   registered --join post that passes every check--> registered, with an accepted request (the same request again is held, not a failure)
//   registered, 8 requests waiting for it or 64 for the project --join post of a new request--> refused invite-full (D-30), nothing kept or counted
//   registered --join post whose hub MAC fails--> registered with one more failure; the 5th failure locks it for good (the lead makes a new one)
//   registered --the roster records member.admit naming it--> used     --the roster records invite.void--> voided
//   registered --the hub's clock passes its expiry--> expired
// A join post to an invitation that is unknown, voided, used, locked or expired is refused before any signature is checked. Registering the same
// invitation again with the same check key is held; with another check key it is refused and the first is kept.
//
// Order of the join checks (Pitfall 7, T-32-101, T-32-102): the per-address bucket and the 64 KiB body cap (both in routes.ts, before the body is
// read), the shape, the invitation's standing from the store and the roster fold, the waiting-request caps (D-30), readHubJoin (both signatures, the envelope signed by the request's
// own device, request hash and invite agreeing), this hub's writer id, the project's genesis, and last the hub MAC in constant time. Failures are
// counted in the store, so the count and the lock survive a restart.
//
// An accepted request is kept 7 days after it was accepted, then removed by the sweep that runs at start and every hour; the sweep never removes an
// invitation record. A join-request event {project, invite} goes to the lead's and deputy's devices only, and only they may list the requests.
// Log lines carry the project id, the invite id and a reason word, never a key, a MAC or a request.
import { checkHubJoinMac, HUB_CHECK_KEY_BYTES, INVITE_REFUSALS, readHubJoin } from '@ext/domain/replica/invite';
import { STREAM_ID_PATTERN } from '@ext/domain/replica/entry';
import { inviteAt } from '@ext/domain/replica/rosterMembers';
import { canonicalize, isStrictBase64url } from '@ext/domain/team/canonical';
import type { RosterCache } from './append/rosterCache';
import type { HubIdentity } from './enrol';
import type { EventHub, Scheduler, Timer } from './live/events';
import { INVITE_LOCK_AFTER } from './store/hubStore';
import type { HubStore } from './store/hubStore';
import { LIMITS } from './limits';

const DAY_MS = 24 * 60 * 60 * 1000;
/** An accepted join request is kept this long after it was accepted (D-48). */
export const JOIN_REQUEST_KEEP_MS = 7 * DAY_MS;
/** How often the removal of old requests runs. */
export const JOIN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** The latest expiry a registration may name, from now (an invitation stays open 1 to 366 days). */
const MAX_INVITE_DAYS = 366;
const INVITE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Every refusal of a join post or a registration, one plain sentence each. None names a key, a MAC or what was posted. */
export const JOIN_REFUSALS = {
  'rate-limited': 'Too many join requests came from this address. Wait the time the hub gives, then try again.',
  malformed: INVITE_REFUSALS.malformed,
  'unknown-invite': 'The hub holds no such invitation for this project. Send the join request file to the staff lead any way you like instead.',
  'invite-expired': INVITE_REFUSALS['invite-expired'],
  'invite-used': INVITE_REFUSALS['invite-used'],
  'invite-voided': INVITE_REFUSALS['invite-voided'],
  'invite-locked': 'Too many join requests for this invitation did not match it, so the hub takes no more for it. Ask the staff lead for a new invitation.',
  // D-30, word for word: more distinct requests wait for this invitation, or for the project, than LIMITS allows.
  'invite-full': 'This invitation has too many people waiting. Ask the staff lead for a new one.',
  'wrong-hub': 'This join request was made for another hub, so this hub did not take it.',
  'wrong-project': INVITE_REFUSALS['wrong-project'],
  'bad-signature': INVITE_REFUSALS['bad-signature'],
  'wrong-device': INVITE_REFUSALS['wrong-device'],
  'wrong-secret': 'This join request was not made from the invitation the staff lead registered with the hub. Make a new join request from that invitation.',
  forbidden: 'Only a device of the staff lead or the deputy lead can register invitations or read join requests.',
  'invite-exists': 'The hub already holds this invitation with another check, so the first one was kept.',
} as const;
export type JoinRefusal = keyof typeof JOIN_REFUSALS;

const STATUS: Readonly<Record<JoinRefusal, number>> = {
  'rate-limited': 429,
  malformed: 400,
  'unknown-invite': 404,
  'invite-expired': 403,
  'invite-used': 403,
  'invite-voided': 403,
  'invite-locked': 403,
  // 403, not 429: waiting does not help, and the client hears 429 as "wait and try again" (hub-busy).
  'invite-full': 403,
  'wrong-hub': 403,
  'wrong-project': 403,
  'bad-signature': 403,
  'wrong-device': 403,
  'wrong-secret': 403,
  forbidden: 403,
  'invite-exists': 409,
};

export type JoinFailure = { ok: false; status: number; reason: JoinRefusal; message: string };
export type JoinOutcome = { ok: true; status: 202; project: string; invite: string; held: boolean } | JoinFailure;
export type RegisterOutcome = { ok: true; status: 200 | 201; project: string; invite: string; held: boolean } | JoinFailure;
export interface PendingRequest {
  invite: string;
  /** The signed join request as canonical JSON text, exactly what the lead's device checks. */
  request: string;
  receivedAt: string;
}
export type ListOutcome = { ok: true; status: 200; project: string; requests: PendingRequest[] } | JoinFailure;

/** The two checks that cost a signature or a MAC; a test may count their calls (the per-address bucket must come before them). */
export interface JoinChecks {
  readHubJoin: typeof readHubJoin;
  checkHubJoinMac: typeof checkHubJoinMac;
}
export const JOIN_CHECKS: JoinChecks = Object.freeze({ readHubJoin, checkHubJoinMac });

export type JoinLog = (level: 'info' | 'warn', event: string, fields: Record<string, string | number>) => void;

export interface JoinDeskOptions {
  store: HubStore;
  cache: RosterCache;
  identity: Pick<HubIdentity, 'writer'>;
  events: EventHub;
  /** Milliseconds. */
  now: () => number;
  checks?: JoinChecks;
  log?: JoinLog;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(value).sort();
  return present.length === keys.length && [...keys].sort().every((key, index) => present[index] === key);
};
const fail = (reason: JoinRefusal): JoinFailure => ({ ok: false, status: STATUS[reason], reason, message: JOIN_REFUSALS[reason] });

/** A JSON value given as text or already parsed; undefined for text that does not parse. */
function valueOf(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

/** The invitations, join requests and their checks of one hub. One per composed hub; routes.ts calls it. */
export class JoinDesk {
  private readonly store: HubStore;
  private readonly cache: RosterCache;
  private readonly hubWriter: string;
  private readonly events: EventHub;
  private readonly now: () => number;
  private readonly checks: JoinChecks;
  private readonly log: JoinLog;
  private scheduler: Scheduler | undefined;
  private timer: Timer | undefined;

  constructor(options: JoinDeskOptions) {
    this.store = options.store;
    this.cache = options.cache;
    this.hubWriter = options.identity.writer;
    this.events = options.events;
    this.now = options.now;
    this.checks = options.checks ?? JOIN_CHECKS;
    this.log = options.log ?? ((): void => undefined);
  }

  /**
   * POST /v1/projects/:p/invites {invite, expiresAt, checkKey} from a device with a session: only a device of the lead or the deputy at the hub's
   * roster head may register (D-48). checkKey is 32 bytes as base64url; the expiry is after now and at most 366 days away.
   */
  async register(project: string, writer: string, body: unknown): Promise<RegisterOutcome> {
    const roster = await this.cache.get(project);
    if (!roster.actsForRosterWriter(writer)) return fail('forbidden');
    if (!isRecord(body) || !exactKeys(body, ['invite', 'expiresAt', 'checkKey'])) return fail('malformed');
    const invite = own(body, 'invite');
    const expiresAt = own(body, 'expiresAt');
    const checkKey = own(body, 'checkKey');
    if (typeof invite !== 'string' || !INVITE_ID.test(invite) || typeof checkKey !== 'string' || !isStrictBase64url(checkKey, HUB_CHECK_KEY_BYTES)) return fail('malformed');
    if (typeof expiresAt !== 'string' || !ISO_TIME.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) return fail('malformed');
    const now = this.now();
    const expires = Date.parse(expiresAt);
    if (expires <= now) return fail('invite-expired');
    if (expires > now + MAX_INVITE_DAYS * DAY_MS) return fail('malformed');
    const held = this.store.invite(project, invite);
    if (held !== undefined && held.checkKey !== checkKey) {
      this.log('warn', 'invite.refused', { project, invite, reason: 'invite-exists' });
      return fail('invite-exists');
    }
    const stored = this.store.putInvite({ project, invite, expiresAt: expires, checkKey, registeredBy: writer, registeredAt: now });
    this.log('info', 'invite.registered', { project, invite, reason: stored });
    return { ok: true, status: stored === 'stored' ? 201 : 200, project, invite, held: stored === 'held' };
  }

  /** POST /v1/join {join, request}: no session. The address bucket and the body cap ran in routes.ts before this. */
  async join(body: unknown): Promise<JoinOutcome> {
    if (!isRecord(body) || !exactKeys(body, ['join', 'request'])) return fail('malformed');
    const joinValue = valueOf(own(body, 'join'));
    const requestValue = valueOf(own(body, 'request'));
    // The project and invite are read before any check only to find the invitation; readHubJoin then verifies them under the signature.
    const named = isRecord(joinValue) ? own(joinValue, 'payload') : undefined;
    const project = isRecord(named) ? own(named, 'project') : undefined;
    const invite = isRecord(named) ? own(named, 'invite') : undefined;
    if (typeof project !== 'string' || !STREAM_ID_PATTERN.test(project) || typeof invite !== 'string' || !INVITE_ID.test(invite)) return fail('malformed');

    const now = this.now();
    const refuse = (reason: JoinRefusal): JoinFailure => {
      this.log('warn', 'join.refused', { project, invite, reason });
      return fail(reason);
    };
    const projectRecord = this.store.project(project);
    const record = projectRecord === undefined ? undefined : this.store.invite(project, invite);
    if (projectRecord === undefined || record === undefined) return refuse('unknown-invite');
    const roster = await this.cache.get(project);
    const standing = inviteAt(roster.state.members, invite, roster.headPosition)?.state;
    if (standing === 'voided') return refuse('invite-voided');
    if (standing === 'used' || record.usedAt !== undefined) return refuse('invite-used');
    if (record.lockedAt !== undefined) return refuse('invite-locked');
    if (now > record.expiresAt) return refuse('invite-expired');
    // D-30: checked before any signature, with the hash the post claims; checked again below with the verified hash, so a false claim gains nothing.
    const claimed = isRecord(named) ? own(named, 'request') : undefined;
    if (this.full(project, invite, typeof claimed === 'string' ? claimed : undefined, now)) return refuse('invite-full');

    const read = this.checks.readHubJoin(joinValue, requestValue);
    if (!read.ok) return refuse(read.reason === 'bad-signature' || read.reason === 'wrong-device' ? read.reason : 'malformed');
    if (read.join.project !== project || read.join.invite !== invite) return refuse('malformed');
    if (read.join.hub !== this.hubWriter) return refuse('wrong-hub');
    const requestPayload = isRecord(requestValue) ? own(requestValue, 'payload') : undefined;
    if (!isRecord(requestPayload) || own(requestPayload, 'genesisHash') !== projectRecord.genesisHash) return refuse('wrong-project');
    const fields = { hub: this.hubWriter, project, invite, request: read.join.request };
    if (!this.checks.checkHubJoinMac(record.checkKey, fields, read.join.hubMac)) {
      const failures = this.store.recordInviteFailure(project, invite, now);
      if (failures === INVITE_LOCK_AFTER) this.log('warn', 'invite.locked', { project, invite, reason: 'wrong-secret' });
      return refuse('wrong-secret');
    }

    // No await since the check above, so no other post can be stored between this check and the store.
    if (this.full(project, invite, read.join.request, now)) return refuse('invite-full');
    const stored = this.store.putJoinRequest({ project, requestHash: read.join.request, invite, body: canonicalize(requestValue), receivedAt: now });
    // Accepted now: the 7 days run from here. A request held from before keeps its first acceptance.
    this.store.acceptJoinRequest(project, read.join.request, now);
    if (stored === 'stored') {
      this.log('info', 'join.accepted', { project, invite, reason: 'stored' });
      const current = await this.cache.get(project);
      this.events.publish(project, (device) => current.actsForRosterWriter(device), 'join-request', { project, invite });
    }
    return { ok: true, status: 202, project, invite, held: stored === 'held' };
  }

  /**
   * True when a new request would pass a cap (D-30): the distinct requests received within the 7-day keep number LIMITS.pendingJoinsPerInvite for
   * this invitation or LIMITS.pendingJoinsPerProject for the project. A request already stored is never full: sent again it stays held.
   */
  private full(project: string, invite: string, requestHash: string | undefined, now: number): boolean {
    const rows = this.store.joinRequests(project);
    if (requestHash !== undefined && rows.some((row) => row.requestHash === requestHash)) return false;
    const cutoff = now - JOIN_REQUEST_KEEP_MS;
    const waiting = rows.filter((row) => row.receivedAt >= cutoff);
    const forInvite = new Set(waiting.filter((row) => row.invite === invite).map((row) => row.requestHash)).size;
    const forProject = new Set(waiting.map((row) => row.requestHash)).size;
    return forInvite >= LIMITS.pendingJoinsPerInvite || forProject >= LIMITS.pendingJoinsPerProject;
  }

  /** GET /v1/projects/:p/join-requests: the requests accepted in the last 7 days, for a device of the lead or the deputy only. */
  async list(project: string, writer: string): Promise<ListOutcome> {
    const roster = await this.cache.get(project);
    if (!roster.actsForRosterWriter(writer)) return fail('forbidden');
    const cutoff = this.now() - JOIN_REQUEST_KEEP_MS;
    const requests = this.store
      .joinRequests(project)
      .filter((row) => row.acceptedAt !== undefined && row.acceptedAt >= cutoff)
      .map((row) => ({ invite: row.invite, request: row.body, receivedAt: new Date(row.receivedAt).toISOString() }));
    return { ok: true, status: 200, project, requests };
  }

  /** Removes accepted requests older than 7 days. Never an invitation record. Returns how many were removed. */
  sweep(): number {
    const removed = this.store.removeAcceptedBefore(Math.max(0, this.now() - JOIN_REQUEST_KEEP_MS));
    if (removed > 0) this.log('info', 'join.removed', { removed });
    return removed;
  }

  /** Runs the sweep now and every hour on the scheduler. */
  start(scheduler: Scheduler): void {
    if (this.timer !== undefined) return;
    this.scheduler = scheduler;
    this.safeSweep();
    this.timer = scheduler.setInterval(() => this.safeSweep(), JOIN_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== undefined) this.scheduler?.clearInterval(this.timer);
    this.timer = undefined;
  }

  private safeSweep(): void {
    try {
      this.sweep();
    } catch {
      // A closed or damaged store is reported by the health probe; the sweep tries again at the next hour.
      this.log('warn', 'join.sweep_failed', { reason: 'store' });
    }
  }
}

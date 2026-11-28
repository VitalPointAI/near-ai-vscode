// The roster fold (DESIGN 7.1; D-07 to D-11, D-41, D-44): a pure function from the roster stream, the pinned anchor and the base cell's keys to the
// real RosterView. Hub-side: no clock (time comes from signed entry fields and the injected now), no I/O, no private key, no Yjs.
//
// Two passes (D-44, 31-RESEARCH.md Pattern 1): the roster stream is folded first, alone, from the pinned anchor; its RosterView is then placed in
// ReplicaContext.roster for the main fold of every stream. So the main fold never depends on itself.
//
// Positions: position 0 is the origin roster (hash ORIGIN_ROSTER, 64 zeros), holding only the anchor's lead with the lead's device. The genesis cites
// it and takes position 1; every later roster entry cites the head as both its rosterPrev and its body.roster and takes the next position.
//
// The driver:
// 1. considers only entries in the roster stream (the project id) whose kind ROSTER_KIND_OWNER routes; every other entry is the main fold's;
// 2. verifies each with verifyEntry against a view of the roster folded so far (so a device admitted by an earlier roster entry can be checked),
//    opening each body once;
// 3. refuses for good an entry that is not the pinned genesis, cites another roster than its rosterPrev, or was written by an agent;
// 4. repeatedly takes the entries that cite the head and whose signer is a roster writer there (a device of the lead or the deputy at the head): one
//    candidate applies through its owner module, two or more are a split, recorded in pending with ROSTER_SPLIT_TEXT, and none applies. A
//    roster.choose citing the split point and naming one of its branches, from an allowed chooser, takes the next position and the chosen branch
//    the one after it; the other branches and everything chained after them stay unapplied (notChosen, rosterBranchPending);
// 5. after the line, places each grant it was given (signer a roster writer and every wrap a device admitted at the roster the grant names; a founding
//    grant equal to its commitment);
// 6. after the line, places each session.certify (Phase 33 D-62) by the rules in sessionKeys.ts, oldest cited roster first, and refuses a roster
//    change or certificate written by a certified session key with person-key-required (D-60). Certificates never take a position.
// 7. after the line, places each device.kem (33.2 D-03) by the rules in deviceKem.ts; like certificates they take no position.
//
// Module seams (plans 31-14 to 31-17 each extend one file): ROSTER_KIND_OWNER routes each kind to rosterMembers (member, device, hub and invite
// kinds), rosterCells (cell kinds) or this file (genesis, lead.handover, deputy.name, roster.choose, roster.require), and rosterView builds every answer from query
// functions those modules export. Phase 33.1 adds rosterPositions (positions and postings, routed 'positions'), whose write rule is
// positionWriteProblem below, shared with your organization's server.
import { GENESIS_PREV, parseHeaderShape, entryHash, writerIdOf } from './entry';
import type { Actor, SealedBlob } from './entry';
import { readGrant } from './cellKeys';
import type { CellGrant } from './cellKeys';
import { readGrantPages } from './grantPages';
import { WRAP_FEATURE, wrapFormatProblem } from './wrapFormat';
import { CELL_ACCESS_FEATURE } from './features';
import { accessRevisionId, verifiesAccessWrite } from './rotationProof';
import type { AccessRevision } from './rotationProof';
import { advanceGrantEvidence, matchesGrantEvidence, openGrantEvidence, readAuthoredAccessStage, readGrantDelivery } from './rotationGrants';
import type { GrantEvidence, OpenedGrantEvidence } from './rotationGrants';
import { deviceKemContext, placeDeviceKems } from './deviceKem';
import type { KemRecord } from './deviceKem';
import { slotOfClientId } from './clientIds';
import { addGrant, applyCellEntry, applyGenesisCells, createCellsState, epochAt, granteesAt } from './rosterCells';
import type { CellsState } from './rosterCells';
import { applyGenesisLead, applyMemberEntry, chosenBranchOf, createMembersState, deviceAt, deviceKeyOf, devicesOfMemberAt, hubAt, hubReadmitPositions, hubSignerAt, memberAt, quarantinesOf, seatsAt, slotOwnerAt, x25519At } from './rosterMembers';
import type { MembersState } from './rosterMembers';
import { POSITION_REFUSALS, applyPositionEntry, createPostsState, positionAt, positionTakenAt, postingAt, postingReportedAt } from './rosterPositions';
import type { PositionRefusal, PostsState } from './rosterPositions';
import type { KeyRing, ReplicaContext, RosterView } from './rosterView';
import { SESSION_MAX_LIFETIME_MS, certificateProblem, certifiedWriter } from './sessionKeys';
import type { SessionCertificate, SessionCertifyData } from './sessionKeys';
import { verifyEntry } from './verify';
import type { VerifiedEntry } from './verify';

// The origin roster: position 0, before the genesis. Equal to GENESIS_PREV, the prev of a chain's first entry.
export const ORIGIN_ROSTER = GENESIS_PREV;

// What a joining machine pins (D-07): the genesis hash, the project id, and the lead's member id and keys.
export interface RosterAnchor { genesisHash: string; project: string; lead: { member: string; writer: string; publicKey: string; x25519: string } }

export type RosterKindOwner = 'members' | 'cells' | 'roster' | 'positions';

// Every roster kind (34) and project.genesis, each routed to exactly one owner module.
export const ROSTER_KIND_OWNER: Readonly<Record<string, RosterKindOwner>> = Object.freeze({
  'project.genesis': 'roster',
  'member.invite': 'members',
  'member.admit': 'members',
  'member.update': 'members',
  'member.remove': 'members',
  'device.add': 'members',
  'device.rotate': 'members',
  'device.revoke': 'members',
  'device.quarantine': 'members',
  'device.release': 'members',
  'hub.admit': 'members',
  'hub.grant': 'members',
  'hub.revoke': 'members',
  'hub.readmit': 'members',
  'invite.void': 'members',
  'cell.create': 'cells',
  'cell.rekey': 'cells',
  'cell.access.commit': 'roster',
  'lead.handover': 'roster',
  'roster.choose': 'roster',
  'deputy.name': 'roster',
  'roster.require': 'roster',
  // Phase 33.1: positions and postings. Kinds without a reducer yet are refused roster-kind-pending by positionWriteProblem.
  'position.create': 'positions',
  'position.update': 'positions',
  'position.disestablish': 'positions',
  'authority.delegate': 'positions',
  'authority.revoke': 'positions',
  'posting.order': 'positions',
  'posting.enrol': 'positions',
  'posting.report': 'positions',
  'posting.decide': 'positions',
  'posting.return': 'positions',
  'posting.end': 'positions',
  'posting.cancel': 'positions',
  'cell.rekey.staged': 'positions',
  'project.mode': 'positions'
});

export const ROSTER_REFUSALS = {
  'roster-kind-pending': 'This kind of roster change is not applied by this version yet, so it is kept and changes nothing.',
  'not-a-roster-writer': 'Only a device of the staff lead or the deputy lead may change the roster, and the device that wrote this was not one at the roster it follows.',
  'roster-citation-mismatch': 'This roster entry cites a different roster than the one it says it follows, so it is refused.',
  'not-the-pinned-genesis': 'This project genesis is not the one this machine pinned when it joined, so it is refused.',
  'genesis-anchor-mismatch': 'The pinned project genesis does not name the lead and device this machine pinned, so the roster cannot start from it.',
  'person-only': 'Only a person can change the roster; an agent or the hub cannot.',
  'deputy-cannot-name-deputy': 'Only the staff lead names the deputy lead, so this naming by the deputy is refused.',
  'not-an-active-member': 'This names someone who is not an active member at the roster it follows.',
  'names-the-lead': 'This names the member who already holds the staff lead role, so it is refused.',
  'handover-not-allowed': 'The deputy lead may hand over the lead only when the lead is lost, so this handover is refused.',
  'choose-not-allowed': 'Only the staff lead chooses a roster branch, or the deputy lead when the lead has no active device, so this choice is refused.',
  'choose-not-a-branch': 'This choice names an entry that is not one of the roster changes made at the roster it follows, so it is refused.',
  'choose-superseded': 'A later choice at the same roster split was applied instead, so this one changes nothing.',
  'choose-branch-refused': 'The change this choice picked is itself refused, so the choice resolves nothing and the roster split stays open. Choose one of the other changes, or make the change again.',
  ...POSITION_REFUSALS
} as const;
export type RosterRefusal = keyof typeof ROSTER_REFUSALS;

// What the fold reports for a roster split (D-09). Phase 33 shows it in the Staff Room; the command that writes roster.choose shows it too.
export const ROSTER_SPLIT_TEXT = 'The roster was changed in two places at once. The lead or the deputy must choose.';

export interface RosterFoldInput {
  // Any entries; only roster-stream entries of a routed kind are read.
  entries: readonly unknown[];
  anchor: RosterAnchor;
  // The epoch keys this machine holds (for the roster stream: the base cell's). Built by the host from the grants addressed to this device.
  keys: KeyRing;
  blobs: (hash: string) => SealedBlob | undefined;
  // Signed grant objects (readGrant checks each).
  grants: readonly unknown[];
  grantEvidence?: readonly unknown[];
  // Passed to verifyEntry only; the roster fold decides nothing from it.
  now: Date;
}

export interface RosterRefused { hash: string; kind: string; reason: string }
export interface RosterHeld { hash: string; reason: string }

export interface RosterState {
  anchor: RosterAnchor;
  // Applied roster hashes by position; positions[0] is ORIGIN_ROSTER.
  positions: string[];
  positionOf: Map<string, number>;
  members: MembersState;
  cells: CellsState;
  // Positions and postings (Phase 33.1), each record at the roster position it took effect.
  posts: PostsState;
  // Who holds staff_lead and deputy_lead from which position: the anchor's lead from the origin, then each lead.handover and deputy.name at the
  // position it takes. A deputy record without a member ends the deputy role (the deputy became the lead).
  leads: Array<{ member: string; from: number }>;
  deputies: Array<{ member: string | undefined; from: number }>;
  // Roster splits not chosen yet: two or more entries citing one head (the split point at); none of them applies until a choice (D-09).
  pending: Array<{ at: string; branches: string[]; text: string }>;
  // Splits a person chose: the roster.choose took the position after the split point and the chosen branch the one after it; the other branches stay
  // unapplied and are listed here.
  choices: Array<{ at: string; branches: string[]; chosen: string; choose: string }>;
  // The features the project requires (POST-01, D-04): the sorted union of every applied roster.require. It never shrinks. Whether this build knows
  // them is the host's question (requireGate.ts against KNOWN_REPLICA_FEATURES), never the fold's.
  required: readonly string[];
  // The roster position at which each required feature was first required (33.2 D-06 reads wrap@2's).
  requiredFrom: Map<string, number>;
  accessRevision?: AccessRevision;
  accessHistory: Map<string, AccessRevision>;
  accessGrants: Map<string, OpenedGrantEvidence>;
  // The session key certificates placed after the line (Phase 33 D-62), by the session's writer id. Certificates take no position.
  sessions: Map<string, SessionCertificate>;
  // Each device's latest placed device.kem (33.2 D-03), by the device's writer id. kemKeysAt (deviceKem.ts) reads it. No position.
  kems: Map<string, KemRecord>;
  // Every roster hash on a branch nobody chose (pending or set aside by a choice), with every roster entry chained after it (D-11).
  notChosen: Set<string>;
  refused: RosterRefused[];
  held: RosterHeld[];
}

function createRosterState(anchor: RosterAnchor): RosterState {
  return {
    anchor,
    positions: [ORIGIN_ROSTER],
    positionOf: new Map([[ORIGIN_ROSTER, 0]]),
    members: createMembersState(anchor),
    cells: createCellsState(anchor.project),
    posts: createPostsState(),
    leads: [{ member: anchor.lead.member, from: 0 }],
    deputies: [],
    pending: [],
    choices: [],
    required: Object.freeze([]),
    requiredFrom: new Map(),
    accessHistory: new Map(),
    accessGrants: new Map(),
    sessions: new Map(),
    kems: new Map(),
    notChosen: new Set(),
    refused: [],
    held: []
  };
}

const holderAt = (history: ReadonlyArray<{ member: string | undefined; from: number }>, position: number): string | undefined => {
  let holder: string | undefined;
  for (const item of history) if (item.from <= position) holder = item.member;
  return holder;
};

export const leadAt = (state: RosterState, position: number): string | undefined => holderAt(state.leads, position);
export const deputyAt = (state: RosterState, position: number): string | undefined => holderAt(state.deputies, position);

// May this device write the roster at the position? An admitted device of an active member who holds the staff lead or the deputy lead role there
// (D-08, D-10). This is the one authority check of the driver and of the grants; what each kind needs beyond it is checked where the kind applies.
export function isRosterWriterAt(state: RosterState, writer: string, position: number): boolean {
  const device = deviceAt(state.members, writer, position);
  if (device === undefined || memberAt(state.members, device.member, position) === undefined) return false;
  return device.member === leadAt(state, position) || device.member === deputyAt(state, position);
}

/** Undefined delegates to the existing guard on a project which has not enabled managed access. */
export function managedWriteAllowed(state: RosterState, stream: string, epoch: number, writer: string, cited: number, now: Date, proof: unknown, storedProofs: readonly unknown[] = []): boolean | undefined {
  const since = state.requiredFrom.get(CELL_ACCESS_FEATURE);
  if (since === undefined) return undefined;
  const revision = state.accessRevision;
  const head = state.positions.length - 1;
  if (revision === undefined || state.pending.length > 0 || epochAt(state.cells, stream, head) !== epoch) return false;
  const cell = state.cells.cells.get(stream);
  const founding = cell?.epochs.find((item) => item.epoch === epoch);
  if (founding === undefined || (founding.from > since && !cell?.grants.some((grant) => grant.founding && grant.hash === founding.grant))) return false;
  const at = state.positionOf.get(revision.entry);
  const predecessor = state.positionOf.get(revision.predecessor);
  if (at === undefined || predecessor === undefined || cited < at) return false;
  const certificate = state.sessions.get(writer);
  let device = writer;
  if (certificate !== undefined) {
    if (certifiedWriter(rosterView(state), writer, state.positions[head]) === undefined || !(Date.parse(certificate.notAfter) > now.getTime())) return false;
    device = certificate.device;
  } else if (deviceAt(state.members, writer, head) === undefined) return false;
  const verifies = (candidate: unknown): boolean => verifiesAccessWrite(revision, candidate, {
    project: state.anchor.project, cell: stream, epoch, device, writer, certificate: certificate?.hash ?? null,
    authorityKey: (authority) => isRosterWriterAt(state, authority, predecessor) ? deviceKeyOf(state.members, authority)?.publicKey : undefined
  });
  return proof === undefined ? storedProofs.some(verifies) : verifies(proof);
}

/** The parts of an entry the position write rule reads: the same from a verified entry (the fold) and an opened base-stream body (the hub). */
export interface PositionWrite { writer: string; kind: string; data: unknown; actor: Actor; at: string }

// The kinds whose reducers exist (33.1-01); every other positions kind is refused as not yet applied until its plan applies it.
const APPLIED_POSITION_KINDS: ReadonlySet<string> = new Set(['position.create', 'posting.order', 'posting.report']);

/**
 * Why this position or posting write is refused at the roster position it cites, or undefined (D-01, D-02, D-09, D-12). The one rule the roster fold
 * and your organization's server both run, so they cannot disagree:
 * - only a person acts: an agent or hub actor is refused on every positions kind (DESIGN 3.4);
 * - position.create: a device of the lead or the deputy (a roster writer), with a new position id;
 * - posting.order: a device of the lead (delegates come in 33.1-04), naming a position that exists and is vacant (handover is 33.1-05), a new
 *   posting id and an active member; a new person, a delegated grant, staged key changes and acting or temporary postings are not applied yet;
 * - posting.report: a device of the posted member (the self-report rule, DESIGN 3.7), for an ordered posting not reported yet, signed on or after
 *   its start by its signed time (D-12).
 */
/** The refusals positionWriteProblem can give, each one your organization's server also names (hub APPEND_REFUSALS). */
export type PositionWriteRefusal = Extract<RosterRefusal, 'person-only' | 'roster-kind-pending' | 'not-a-roster-writer' | 'not-an-active-member'> | PositionRefusal;

export function positionWriteProblem(state: RosterState, write: PositionWrite, cited: number): PositionWriteRefusal | undefined {
  if (write.actor.kind !== 'person') return 'person-only';
  if (!APPLIED_POSITION_KINDS.has(write.kind)) return 'roster-kind-pending';
  const signer = deviceAt(state.members, write.writer, cited)?.member;
  if (write.kind === 'position.create') {
    if (!isRosterWriterAt(state, write.writer, cited)) return 'not-a-roster-writer';
    const position = (write.data as { position: string }).position;
    return positionAt(state.posts, position, cited) === undefined ? undefined : 'position-exists';
  }
  if (write.kind === 'posting.order') {
    if (signer === undefined || signer !== leadAt(state, cited) || memberAt(state.members, signer, cited) === undefined) return 'order-not-allowed';
    const order = write.data as { posting: string; position: string; person: { member?: string }; kind: string; grant?: string; stages: readonly string[] };
    if (order.person.member === undefined || order.grant !== undefined || order.stages.length > 0 || order.kind !== 'substantive') return 'roster-kind-pending';
    if (positionAt(state.posts, order.position, cited) === undefined) return 'unknown-position';
    if (postingAt(state.posts, order.posting, cited) !== undefined) return 'posting-exists';
    if (memberAt(state.members, order.person.member, cited) === undefined) return 'not-an-active-member';
    return positionTakenAt(state.posts, order.position, cited) ? 'position-not-vacant' : undefined;
  }
  const posting = postingAt(state.posts, (write.data as { posting: string }).posting, cited);
  if (posting === undefined) return 'unknown-posting';
  if (signer === undefined || signer !== posting.member) return 'not-the-posted-member';
  if (postingReportedAt(posting, cited)) return 'posting-not-open';
  return Date.parse(write.at) < Date.parse(posting.start) ? 'report-before-start' : undefined;
}

const positionWriteOf = (entry: VerifiedEntry): PositionWrite => ({ writer: entry.header.writer, kind: entry.body.kind, data: entry.data, actor: entry.body.actor, at: entry.body.at });

// Who may write this roster entry at the head: positionWriteProblem for a positions kind (the posted member reports for their own posting), a roster
// writer for every other kind.
function authorityProblem(state: RosterState, entry: VerifiedEntry, head: number): string | undefined {
  if (ROSTER_KIND_OWNER[entry.body.kind] === 'positions') return positionWriteProblem(state, positionWriteOf(entry), head);
  if (!isRosterWriterAt(state, entry.header.writer, head)) return 'not-a-roster-writer';
  const access = nextAccessRevision(state, entry);
  return typeof access === 'string' ? access : undefined;
}

// The member whose device wrote the entry, at the roster the entry cites.
const signerAt = (state: RosterState, entry: VerifiedEntry, position: number): string | undefined => deviceAt(state.members, entry.header.writer, position)?.member;

function hasRoleAt(state: RosterState, member: string, role: string, position: number): boolean {
  const record = memberAt(state.members, member, position);
  if (record === undefined) return false;
  if (role === 'staff_lead') return leadAt(state, position) === member;
  if (role === 'deputy_lead') return deputyAt(state, position) === member;
  return record.roles.includes(role);
}

// The RosterView over a roster state. It reads the state live, so the driver uses one view while it folds. Every answer comes from the members and
// cells modules' query functions at the position of the roster asked about.
export function rosterView(state: RosterState): RosterView {
  const at = (hash: string): number | undefined => state.positionOf.get(hash);
  return {
    hasRoster: (hash) => state.positionOf.has(hash),
    rosterPosition: (hash) => at(hash),
    deviceKey: (writer) => deviceKeyOf(state.members, writer),
    isAdmitted(writer, hash) {
      const position = at(hash);
      return position !== undefined && deviceAt(state.members, writer, position) !== undefined;
    },
    memberName(member, hash) {
      const position = at(hash);
      return position === undefined ? undefined : memberAt(state.members, member, position)?.name;
    },
    hasRole(member, role, hash) {
      const position = at(hash);
      return position !== undefined && hasRoleAt(state, member, role, position);
    },
    roleWithdrawnBy(member, role, hash) {
      const position = at(hash);
      if (position === undefined) return undefined;
      for (let later = position + 1; later < state.positions.length; later += 1) if (!hasRoleAt(state, member, role, later)) return state.positions[later];
      return undefined;
    },
    chosenBranch: (writer, stream, seq) => chosenBranchOf(state.members, writer, stream, seq),
    checkpointSigner(writer, hash) {
      const position = at(hash);
      return position !== undefined && hubSignerAt(state.members, writer, position);
    },
    canRunAgent(member, seat, hash) {
      const position = at(hash);
      return position !== undefined && seatsAt(state.members, member, position).includes(seat);
    },
    clientIdOwner(clientId, hash) {
      const position = at(hash);
      const slot = slotOfClientId(clientId);
      return position === undefined || slot === 0 ? undefined : slotOwnerAt(state.members, slot, position);
    },
    deviceEncryptionKey(writer, hash) {
      const position = at(hash);
      return position === undefined ? undefined : x25519At(state.members, writer, position);
    },
    cellGrantees(cell, hash) {
      const position = at(hash);
      return position === undefined ? undefined : granteesAt(state.cells, cell, position, (writer) => deviceAt(state.members, writer, position) !== undefined);
    },
    rosterBranchPending: (hash) => state.notChosen.has(hash),
    hubPin(hub, hash) {
      const position = at(hash);
      return position === undefined ? undefined : hubAt(state.members, hub, position)?.certPin;
    },
    hubReadmits: (hub) => hubReadmitPositions(state.members, hub).map((position) => state.positions[position]),
    sessionCertificate: (writer) => state.sessions.get(writer),
    deviceQuarantines: (writer) => quarantinesOf(state.members, writer)
  };
}

interface GenesisData { project: string; lead: { member: string; writer: string; device?: { writer: string; publicKey: string; x25519: string; x25519Sig: string; slot?: number } }; cells?: Array<{ cell: string; epoch: number; grant: string }> }

// The roster an entry says it follows: rosterPrev for a roster kind, the origin for the genesis.
const rosterPrevOf = (entry: VerifiedEntry): string | undefined => {
  if (entry.body.kind === 'project.genesis') return ORIGIN_ROSTER;
  const data = entry.data as { rosterPrev?: unknown };
  return typeof data.rosterPrev === 'string' ? data.rosterPrev : undefined;
};

// A refusal that no later roster can change, or undefined.
function settledRefusal(state: RosterState, entry: VerifiedEntry): RosterRefusal | undefined {
  if (entry.body.kind === 'project.genesis' && entry.hash !== state.anchor.genesisHash) return 'not-the-pinned-genesis';
  if (entry.body.actor.kind !== 'person') return 'person-only';
  if (entry.body.roster !== rosterPrevOf(entry)) return 'roster-citation-mismatch';
  // keep is not read here: the probe view answers no to isAdmitted for a roster not applied yet, so admission is checked at the head instead.
  return undefined;
}

function applyGenesis(state: RosterState, entry: VerifiedEntry, position: number): { status: 'applied' } | { status: 'refused'; reason: string } {
  const { anchor } = state;
  const data = entry.data as GenesisData;
  const device = data.lead.device;
  if (entry.header.stream !== anchor.project || data.project !== anchor.project || data.lead.member !== anchor.lead.member || data.lead.writer !== anchor.lead.writer || device === undefined
    || device.writer !== anchor.lead.writer || device.publicKey !== anchor.lead.publicKey || device.x25519 !== anchor.lead.x25519) {
    return { status: 'refused', reason: 'genesis-anchor-mismatch' };
  }
  const lead = applyGenesisLead(state.members, device, position);
  if (lead.status === 'refused') return lead;
  const cells = applyGenesisCells(state.cells, data.cells ?? [], { position, roster: entry.body.roster });
  if (cells.status === 'refused') {
    // The genesis is the first entry applied, so undoing the lead device is starting the members over from the anchor.
    state.members = createMembersState(anchor);
    return cells;
  }
  return { status: 'applied' };
}

type ApplyOutcome = { status: 'applied' } | { status: 'refused'; reason: string };

// A member a lead role may be given to: active at the cited roster and not the lead there.
function leadRoleProblem(state: RosterState, member: string, cited: number): RosterRefusal | undefined {
  if (memberAt(state.members, member, cited) === undefined) return 'not-an-active-member';
  if (member === leadAt(state, cited)) return 'names-the-lead';
  return undefined;
}

// deputy.name (D-10, owner decision 5): written by the lead only; the deputy can write every other roster entry the lead can.
function applyDeputyName(state: RosterState, entry: VerifiedEntry, position: number): ApplyOutcome {
  const cited = position - 1;
  if (signerAt(state, entry, cited) !== leadAt(state, cited)) return { status: 'refused', reason: 'deputy-cannot-name-deputy' };
  const member = (entry.data as { member: string }).member;
  const problem = leadRoleProblem(state, member, cited);
  if (problem !== undefined) return { status: 'refused', reason: problem };
  state.deputies.push({ member, from: position });
  return { status: 'applied' };
}

// lead.handover (D-10): the lead hands over for any reason; the deputy hands over only with reason lead-lost (D-48: a lead who is merely unreachable
// is replaced this way). The new lead holds staff_lead from the handover's position on and the old lead keeps it at every earlier roster (D-11). When
// the deputy becomes the lead, the deputy role ends there, so one member never holds both.
function applyHandover(state: RosterState, entry: VerifiedEntry, position: number): ApplyOutcome {
  const cited = position - 1;
  const data = entry.data as { to: string; reason: string };
  const signer = signerAt(state, entry, cited);
  if (signer !== leadAt(state, cited) && !(signer === deputyAt(state, cited) && data.reason === 'lead-lost')) return { status: 'refused', reason: 'handover-not-allowed' };
  const problem = leadRoleProblem(state, data.to, cited);
  if (problem !== undefined) return { status: 'refused', reason: problem };
  state.leads.push({ member: data.to, from: position });
  if (deputyAt(state, cited) === data.to) state.deputies.push({ member: undefined, from: position });
  return { status: 'applied' };
}

// roster.require (POST-01, D-04): the driver already allowed only a lead device and a person. The required set grows by the union and never shrinks; an
// entry whose features are all required already applies as a no-op and keeps its place in the line, so two leads arming at once never conflict.
function applyRequire(state: RosterState, entry: VerifiedEntry, position: number): ApplyOutcome {
  // The closed schema checked the ids (name@N, distinct, sorted) at verification.
  const features = (entry.data as { features: readonly string[] }).features;
  for (const feature of features) if (!state.requiredFrom.has(feature)) state.requiredFrom.set(feature, position);
  state.required = Object.freeze([...new Set([...state.required, ...features])].sort());
  return { status: 'applied' };
}

function applyOperation(state: RosterState, entry: VerifiedEntry): ApplyOutcome {
  const position = state.positions.length;
  const owner = ROSTER_KIND_OWNER[entry.body.kind];
  if (entry.body.kind === 'project.genesis') return applyGenesis(state, entry, position);
  if (owner === 'members') {
    const deputy = deputyAt(state, position - 1);
    const streamKnown = (stream: string): boolean => stream === state.anchor.project || epochAt(state.cells, stream, position - 1) !== undefined;
    return applyMemberEntry(state.members, entry, { position, lead: leadAt(state, position - 1) as string, streamKnown, ...(deputy === undefined ? {} : { deputy }) });
  }
  if (owner === 'cells') return applyCellEntry(state.cells, entry, { position, roster: entry.body.roster });
  if (entry.body.kind === 'deputy.name') return applyDeputyName(state, entry, position);
  if (entry.body.kind === 'lead.handover') return applyHandover(state, entry, position);
  if (entry.body.kind === 'roster.require') return applyRequire(state, entry, position);
  if (entry.body.kind === 'cell.access.commit') return { status: 'applied' };
  if (owner === 'positions') {
    // Judged again at the roster it cites, because a chosen branch reaches here without the head's authority check.
    const problem = positionWriteProblem(state, positionWriteOf(entry), position - 1);
    if (problem !== undefined) return { status: 'refused', reason: problem };
    applyPositionEntry(state.posts, entry.body.kind, entry.data, signerAt(state, entry, position - 1) as string, position);
    return { status: 'applied' };
  }
  // roster.choose is decided by the driver at the split point (chooseProblem), never here.
  return { status: 'refused', reason: 'roster-kind-pending' };
}

const ACCESS_CHANGES: ReadonlySet<string> = new Set(['member.remove', 'device.revoke', 'device.rotate', 'hub.revoke', 'cell.create', 'cell.rekey', 'cell.access.commit']);

function nextAccessRevision(state: RosterState, entry: VerifiedEntry): { id: string; root: string } | string | undefined {
  if (entry.body.kind === 'project.genesis') return undefined;
  const { accessRevision, accessRoot, rosterPrev: _prev, ...operation } = entry.data as Record<string, unknown>;
  const kind = entry.body.kind;
  const changesAccess = ACCESS_CHANGES.has(kind) || (kind === 'member.update' &&
    ('clearance' in operation || 'did' in operation || 'evidence' in operation));
  if (!state.requiredFrom.has(CELL_ACCESS_FEATURE) || !changesAccess) {
    return accessRevision !== undefined || accessRoot !== undefined ? 'cell-access-not-required' : undefined;
  }
  const id = accessRevisionId(state.anchor.project, state.accessRevision?.id ?? null, entry.body.roster, kind, operation);
  return accessRevision === id && typeof accessRoot === 'string' ? { id, root: accessRoot } : 'cell-access-revision-invalid';
}

/** A managed mutation and its access revision apply together, including on a chosen roster branch. */
function applyOne(state: RosterState, entry: VerifiedEntry): ApplyOutcome {
  const access = nextAccessRevision(state, entry);
  if (typeof access === 'string') return { status: 'refused', reason: access };
  const outcome = applyOperation(state, entry);
  if (outcome.status === 'applied' && access !== undefined) {
    state.accessRevision = Object.freeze({
      ...access, entry: entry.hash, predecessor: entry.body.roster, cells: Object.freeze([...state.cells.cells.keys()].sort())
    });
    state.accessHistory.set(entry.hash, state.accessRevision);
  }
  return outcome;
}

const isRouted = (kind: string): boolean => Object.prototype.hasOwnProperty.call(ROSTER_KIND_OWNER, kind);
const byHash = (a: { hash: string }, b: { hash: string }): number => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

// Why this roster.choose at the split point cannot resolve it, or undefined (D-09, D-48). The chooser is the lead at the split point, or the deputy
// there when the lead has no active device (a lead who has handed over is no longer the lead, so the member they handed over to chooses). The chosen
// hash must be one of the other roster changes citing the split point. Nothing else ever picks a branch (P-31-22).
function chooseProblem(state: RosterState, choose: VerifiedEntry, position: number, branches: readonly VerifiedEntry[]): RosterRefusal | undefined {
  const signer = signerAt(state, choose, position);
  const lead = leadAt(state, position) as string;
  const leadless = devicesOfMemberAt(state.members, lead, position).length === 0;
  if (signer !== lead && !(signer === deputyAt(state, position) && leadless)) return 'choose-not-allowed';
  const chosen = (choose.data as { chosen: string }).chosen;
  return branches.some((entry) => entry.hash === chosen) ? undefined : 'choose-not-a-branch';
}

// The person's choice at a split point: of the allowed choices, the one signed latest (every allowed choice there is by the same member, so this is
// that person's last word), ties to the smaller hash. The others are refused choose-superseded.
function latestChoice(chooses: readonly VerifiedEntry[]): VerifiedEntry[] {
  return [...chooses].sort((a, b) => Date.parse(b.body.at) - Date.parse(a.body.at) || byHash(a, b));
}

export function foldRoster(input: RosterFoldInput): RosterState {
  const state = createRosterState(input.anchor);
  const view = rosterView(state);
  // verifyEntry runs against the roster folded so far, except that the probe says yes to every roster hash: each body is then opened once, and the
  // driver itself checks the roster an entry cites against the line (it must be the head, and the device must be a roster writer there). Without
  // the probe, a body citing a roster not applied yet would be opened again after every roster entry.
  const probe: ReplicaContext = { roster: { ...view, hasRoster: () => true, rosterBranchPending: () => false }, keys: input.keys, blobs: input.blobs, now: input.now };

  // Roster-stream inputs by entry hash; the first copy of a hash is the one read.
  const waiting = new Map<string, unknown>();
  for (const raw of input.entries) {
    const shape = parseHeaderShape(typeof raw === 'object' && raw !== null ? (raw as { header?: unknown }).header : undefined);
    if (!shape.ok || shape.header.stream !== input.anchor.project) continue;
    const hash = entryHash(shape.header);
    if (!waiting.has(hash)) waiting.set(hash, raw);
  }
  const ready: VerifiedEntry[] = [];
  const certificates: VerifiedEntry[] = [];
  const kemEntries: VerifiedEntry[] = [];
  const refuse = (hash: string, kind: string, reason: string): void => { state.refused.push({ hash, kind, reason }); };

  for (;;) {
    // Read what is still waiting. Only an unknown device can become known (when a roster entry admits it), so only that hold is tried again.
    for (const [hash, raw] of waiting) {
      const outcome = verifyEntry(raw, probe);
      if (outcome.status === 'held' && outcome.reason === 'unknown-writer') continue;
      waiting.delete(hash);
      if (outcome.status === 'held') {
        state.held.push({ hash, reason: outcome.reason });
        continue;
      }
      if (outcome.status === 'rejected') {
        refuse(hash, '', outcome.reason);
        continue;
      }
      const entry = outcome.entry;
      if (entry.body.kind === 'session.certify') certificates.push(entry);
      if (entry.body.kind === 'device.kem') kemEntries.push(entry);
      if (entry.keep === 'newer-version' || !isRouted(entry.body.kind)) continue;
      const settled = settledRefusal(state, entry);
      if (settled !== undefined) refuse(hash, entry.body.kind, settled);
      else ready.push(entry);
    }
    const headPosition = state.positions.length - 1;
    const head = state.positions[headPosition];
    const citing = ready.filter((entry) => rosterPrevOf(entry) === head);
    if (citing.length === 0) break;
    // Authority at the head: an entry by a device that may not write it there is refused, so it can neither apply nor split the roster.
    const candidates: VerifiedEntry[] = [];
    for (const entry of citing) {
      ready.splice(ready.indexOf(entry), 1);
      const problem = authorityProblem(state, entry, headPosition);
      if (problem === undefined) candidates.push(entry);
      else refuse(entry.hash, entry.body.kind, problem);
    }
    if (candidates.length === 0) continue;
    // A roster.choose citing the head is not a branch: it names one of the other candidates (the branches) and lets that one continue the line.
    const branches = candidates.filter((entry) => entry.body.kind !== 'roster.choose');
    const allowed: VerifiedEntry[] = [];
    for (const choose of candidates.filter((entry) => entry.body.kind === 'roster.choose')) {
      const problem = chooseProblem(state, choose, headPosition, branches);
      if (problem === undefined) allowed.push(choose);
      else refuse(choose.hash, choose.body.kind, problem);
    }
    let open = branches;
    if (allowed.length > 0) {
      const [choose, ...superseded] = latestChoice(allowed);
      for (const other of superseded) refuse(other.hash, other.body.kind, 'choose-superseded');
      const chosenHash = (choose.data as { chosen: string }).chosen;
      const chosen = branches.find((entry) => entry.hash === chosenHash) as VerifiedEntry;
      const others = branches.filter((entry) => entry !== chosen);
      // The choice takes one position and changes nothing else, so the chosen entry, judged at the split point it cites, applies at the next one.
      // Every rule checks before it changes anything, so a refused chosen entry leaves the state as it was.
      append(state, choose.hash);
      const outcome = applyOne(state, chosen);
      if (outcome.status === 'applied') {
        append(state, chosen.hash);
        state.choices.push({ at: head, branches: branches.map((entry) => entry.hash).sort(), chosen: chosenHash, choose: choose.hash });
        // The branches not chosen stay unapplied; what is chained after them is found below.
        ready.push(...others);
        continue;
      }
      // The chosen change is refused by its own rule: the choice resolves nothing (its position is taken back), so the split is not silently closed
      // with nothing applied. The choice and the refused change are recorded as refused, and the other changes are judged as if it had not been there:
      // two or more stay a pending split the lead can still choose between, and a single one continues the line.
      state.positions.pop();
      state.positionOf.delete(choose.hash);
      refuse(chosen.hash, chosen.body.kind, outcome.reason);
      refuse(choose.hash, choose.body.kind, 'choose-branch-refused');
      open = others;
    }
    if (open.length === 0) continue;
    const branchesLeft = open;
    if (branchesLeft.length > 1) {
      state.pending.push({ at: head, branches: branchesLeft.map((entry) => entry.hash).sort(), text: ROSTER_SPLIT_TEXT });
      ready.push(...branchesLeft);
      break;
    }
    const entry = branchesLeft[0];
    const outcome = applyOne(state, entry);
    if (outcome.status === 'refused') {
      refuse(entry.hash, entry.body.kind, outcome.reason);
      continue;
    }
    append(state, entry.hash);
  }

  markNotChosen(state, ready);
  placeSessions(state, certificates);
  placeKems(state, kemEntries);
  // A roster change or certificate by a certified session key: refused for good (D-60). Anything else still waiting is held as an unknown writer.
  const settledView: ReplicaContext = { roster: rosterView(state), keys: input.keys, blobs: input.blobs, now: input.now };
  for (const [hash, raw] of waiting) {
    const outcome = state.sessions.size === 0 ? undefined : verifyEntry(raw, settledView);
    const entry = outcome?.status === 'verified' ? outcome.entry : undefined;
    if (entry !== undefined && entry.session !== undefined && (isRouted(entry.body.kind) || entry.body.kind === 'session.certify' || entry.body.kind === 'device.kem')) refuse(hash, entry.body.kind, 'person-key-required');
    else state.held.push({ hash, reason: 'unknown-writer' });
  }
  // Verified entries that never reached the head: on a branch nobody chose (D-11), or following a roster that is not on this machine's line.
  for (const entry of ready) state.held.push({ hash: entry.hash, reason: state.notChosen.has(entry.hash) ? 'roster-branch-not-chosen' : 'roster-prev-not-applied' });
  state.held.sort(byHash);

  placeGrants(state, input.grants, input.grantEvidence ?? []);
  return state;
}

// Places the session certificates (Phase 33 D-62) against the settled line, oldest cited roster first and then by hash, so every machine and the
// server place the same ones. A certificate citing a roster off the line waits; one sessionKeys.ts or its signed lifetime refuses is refused.
function placeSessions(state: RosterState, certificates: readonly VerifiedEntry[]): void {
  const view = rosterView(state);
  const on = (entry: VerifiedEntry): number => state.positionOf.get(entry.body.roster) ?? Number.MAX_SAFE_INTEGER;
  for (const entry of [...certificates].sort((a, b) => on(a) - on(b) || byHash(a, b))) {
    if (!state.positionOf.has(entry.body.roster)) {
      state.held.push({ hash: entry.hash, reason: state.notChosen.has(entry.body.roster) ? 'roster-branch-not-chosen' : 'missing-roster' });
      continue;
    }
    const data = entry.data as SessionCertifyData;
    const lifetime = Date.parse(data.notAfter) - Date.parse(entry.body.at);
    const problem = lifetime > 0 && lifetime <= SESSION_MAX_LIFETIME_MS ? certificateProblem(view, entry, state.anchor.project, state.sessions) : 'session-certificate-invalid';
    if (problem !== undefined) {
      state.refused.push({ hash: entry.hash, kind: entry.body.kind, reason: problem });
      continue;
    }
    const writer = writerIdOf(data.sessionKey);
    state.sessions.set(writer, { hash: entry.hash, writer, member: data.member, device: data.device, sessionKey: data.sessionKey, slot: data.slot, notAfter: data.notAfter, roster: entry.body.roster });
  }
}

// Places the device key bindings (33.2 D-03) against the settled line with deviceKem.ts's one check, shared with your organization's server.
function placeKems(state: RosterState, entries: readonly VerifiedEntry[]): void {
  const offLine = (roster: string): string => (state.notChosen.has(roster) ? 'roster-branch-not-chosen' : 'missing-roster');
  const result = placeDeviceKems(entries, deviceKemContext(state, (writer, position) => isRosterWriterAt(state, writer, position)), (roster) => state.positionOf.get(roster), offLine);
  state.kems = result.placed;
  state.refused.push(...result.refused);
  state.held.push(...result.held);
}

function append(state: RosterState, hash: string): void {
  state.positions.push(hash);
  state.positionOf.set(hash, state.positions.length - 1);
}

// The branches of every pending split and the branches a choice set aside, then every unapplied entry chained after one of them by rosterPrev.
function markNotChosen(state: RosterState, unapplied: readonly VerifiedEntry[]): void {
  for (const split of state.pending) for (const hash of split.branches) state.notChosen.add(hash);
  for (const choice of state.choices) for (const hash of choice.branches) if (hash !== choice.chosen) state.notChosen.add(hash);
  const after = new Map<string, string[]>();
  for (const entry of unapplied) {
    const prev = rosterPrevOf(entry);
    if (prev !== undefined) after.set(prev, [...(after.get(prev) ?? []), entry.hash]);
  }
  const queue = [...state.notChosen];
  while (queue.length > 0) {
    for (const next of after.get(queue.pop() as string) ?? []) {
      if (state.notChosen.has(next)) continue;
      state.notChosen.add(next);
      queue.push(next);
    }
  }
}

// Places the grants. A grant that lists pages (33.2 D-04) is read with readGrantPages together with the pages it lists and placed as one grant under
// its own hash; a listed page is never placed alone. A grant whose pages have not all arrived waits, held missing-blob under its hash like an entry
// whose blob has not arrived (33-07), and is placed when they come.
function placeGrants(state: RosterState, grants: readonly unknown[], openings: readonly unknown[]): void {
  const evidence: OpenedGrantEvidence[] = [];
  const delivered: unknown[] = [];
  for (const candidate of openings) {
    const stage = readAuthoredAccessStage(candidate);
    for (const opening of stage?.openings ?? [candidate]) {
      const bound = openGrantEvidence(state.anchor.project, state.accessHistory, opening);
      if (bound !== undefined) evidence.push(bound);
    }
    const item = stage?.founding ?? stage?.supplemental ?? readGrantDelivery(candidate);
    if (item === undefined) continue;
    const bound = openGrantEvidence(state.anchor.project, state.accessHistory, item.opening);
    if (bound === undefined) continue;
    evidence.push(bound);
    delivered.push(...item.grants);
  }
  if (state.pending.length === 0) {
    const position = state.positions.length - 1;
    for (const item of evidence) {
      const { cell, epoch } = item.evidence;
      if (item.entry === state.accessRevision?.entry && epochAt(state.cells, cell, position) === epoch) state.accessGrants.set(cell, item);
    }
  }
  const approved = new Set(evidence.flatMap(({ evidence: item }) => item.grants.map((grant) => grant.hash)));
  const reads: Array<{ value: unknown; read: Extract<ReturnType<typeof readGrant>, { ok: true }> }> = [];
  const byHash = new Map<string, unknown>();
  for (const value of [...grants, ...delivered]) {
    const read = readGrant(value);
    if (!read.ok) {
      state.refused.push({ hash: '', kind: 'grant', reason: read.reason });
      continue;
    }
    if (byHash.has(read.hash)) continue;
    byHash.set(read.hash, value);
    reads.push({ value, read });
  }
  const listed = new Set<string>();
  for (const { read } of reads) {
    if (approved.has(read.hash) || !requiresManagedGrant(state, read.grant)) for (const page of read.grant.pages ?? []) listed.add(page);
  }
  for (const { value, read: first } of reads) {
    if (listed.has(first.hash)) continue;
    const managed = requiresManagedGrant(state, first.grant);
    if (managed && !approved.has(first.hash)) {
      state.held.push({ hash: first.hash, reason: 'cell-access-grant-pending' });
      continue;
    }
    let read: { grant: CellGrant; hash: string; signer: { writer: string } } = first;
    if ((first.grant.pages ?? []).length > 0) {
      const pages = (first.grant.pages as string[]).map((hash) => byHash.get(hash));
      if (pages.some((page) => page === undefined)) {
        state.held.push({ hash: first.hash, reason: 'missing-blob' });
        continue;
      }
      const paged = readGrantPages(value, pages);
      if (!paged.ok) {
        state.refused.push({ hash: first.hash, kind: 'grant', reason: paged.reason });
        continue;
      }
      read = paged;
    }
    const position = state.positionOf.get(read.grant.roster);
    if (position === undefined) {
      state.held.push({ hash: read.hash, reason: 'missing-roster' });
      continue;
    }
    if (managed && !evidence.some(({ entry, evidence: item }) => item.cell === read.grant.cell && item.epoch === read.grant.epoch &&
      (state.positionOf.get(entry) ?? -1) >= position && matchesGrantEvidence(item, {
        hash: read.hash, pages: read.grant.pages ?? [], recipients: read.grant.wraps.map((wrap) => wrap.writer).sort()
      }))) {
      state.held.push({ hash: read.hash, reason: 'cell-access-grant-pending' });
      continue;
    }
    // The cutover rule (33.2 D-06), the same function your organization's server calls: no v1 wrap for an epoch founded after the switch.
    const founded = state.cells.cells.get(read.grant.cell)?.epochs.find((epoch) => epoch.epoch === read.grant.epoch)?.from;
    const format = founded === undefined ? undefined : wrapFormatProblem(read.grant, founded, state.requiredFrom.get(WRAP_FEATURE));
    if (format !== undefined) {
      state.refused.push({ hash: read.hash, kind: 'grant', reason: format });
      continue;
    }
    const outcome = addGrant(state.cells, {
      grant: read.grant,
      hash: read.hash,
      position,
      signerIsRosterWriter: isRosterWriterAt(state, read.signer.writer, position),
      admitted: (writer) => deviceAt(state.members, writer, position) !== undefined
    });
    if (outcome.status === 'refused') state.refused.push({ hash: read.hash, kind: 'grant', reason: outcome.reason });
  }
}

type Withdrawal = { member: string; writer?: string };
type WithdrawalCell = { evidence: GrantEvidence; decision: OpenedGrantEvidence['decision']; recipients: string[] };

/** Prepare the next managed membership operation without signing or writing. Every cell needs selected-root evidence. */
export function prepareManagedWithdrawal(state: RosterState, authority: string, input: Withdrawal):
  { kind: 'member.remove' | 'device.revoke'; operation: Withdrawal; predecessor: string; priorRoot: string; priorEntry: string;
    revision: string; cells: WithdrawalCell[] } | undefined {
  const prior = state.accessRevision;
  const position = state.positions.length - 1;
  const predecessor = state.positions[position];
  if (!state.requiredFrom.has(CELL_ACCESS_FEATURE) || prior === undefined || state.pending.length > 0 || !isRosterWriterAt(state, authority, position)) return undefined;
  if (memberAt(state.members, input.member, position) === undefined) return undefined;
  const devices = devicesOfMemberAt(state.members, input.member, position);
  const target = input.writer;
  if (input.member === leadAt(state, position) && (target === undefined || (devices.filter((device) => device.kind === 'person').length <= 1 &&
      deviceAt(state.members, authority, position)?.member !== deputyAt(state, position)))) return undefined;
  if (target !== undefined && !devices.some(({ writer }) => writer === target)) return undefined;
  const withdrawn = new Set(target === undefined ? devices.map(({ writer }) => writer) : [target]);
  const cells: WithdrawalCell[] = [];
  for (const cell of prior.cells) {
    const known = state.accessGrants.get(cell);
    if (known?.entry !== prior.entry || known.evidence.epoch !== epochAt(state.cells, cell, position)) return undefined;
    const holders = [...new Set(known.evidence.grants.flatMap((grant) => grant.recipients))].sort();
    const excludedNow = holders.filter((writer) => withdrawn.has(writer) || deviceAt(state.members, writer, position) === undefined);
    const evidence = advanceGrantEvidence(known.evidence, { epoch: known.evidence.epoch, grants: [], excluded: excludedNow });
    if (evidence === undefined) return undefined;
    const excluded = new Set(evidence.excluded);
    const recipients = holders.filter((writer) => !excluded.has(writer));
    const pending = known.decision === 'pending' || recipients.length < holders.length;
    const decision = known.decision === 'closed' || recipients.length === 0 ? 'closed' : pending ? 'pending' : 'continues';
    cells.push({ evidence, decision, recipients: decision === 'closed' ? [] : recipients });
  }
  const operation = { member: input.member, ...(target === undefined ? {} : { writer: target }) };
  const kind = target === undefined ? 'member.remove' : 'device.revoke';
  return { kind, operation, predecessor, priorRoot: prior.root, priorEntry: prior.entry, cells,
    revision: accessRevisionId(state.anchor.project, prior.id, predecessor, kind, operation) };
}

/** Raw grant bytes can arrive before their authority. After the switch they are only staging material. */
export function requiresManagedGrant(state: RosterState, grant: Pick<CellGrant, 'roster' | 'cell' | 'epoch'>): boolean {
  const since = state.requiredFrom.get(CELL_ACCESS_FEATURE);
  if (since === undefined) return false;
  const cited = state.positionOf.get(grant.roster);
  const founded = state.cells.cells.get(grant.cell)?.epochs.find((epoch) => epoch.epoch === grant.epoch)?.from;
  return cited === undefined || founded === undefined || cited >= since || founded > since;
}

/** Only legacy grants may bootstrap read keys through the legacy catching-up path. */
export function legacyReadingGrants(state: RosterState, grants: readonly unknown[]): readonly unknown[] {
  if (!state.requiredFrom.has(CELL_ACCESS_FEATURE)) return grants;
  return grants.filter((signed) => {
    const grant = readGrant(signed);
    return grant.ok && !requiresManagedGrant(state, grant.grant);
  });
}

/** What can change the cached roster view used by the main fold. */
export function rosterSignature(roster: RosterState): string {
  let grants = 0;
  for (const cell of roster.cells.cells.values()) grants += cell.grants.length;
  return [roster.positions.join(','), roster.pending.map((split) => `${split.at}:${split.branches.join('+')}`).join(';'), roster.choices.map((choice) => choice.choose).join(';'), String(roster.notChosen.size), String(grants), String(roster.sessions.size)].join('|');
}

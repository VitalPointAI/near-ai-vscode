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
//    grant equal to its commitment).
//
// Module seams (plans 31-14 to 31-17 each extend one file): ROSTER_KIND_OWNER routes each kind to rosterMembers (member, device, hub and invite
// kinds), rosterCells (cell kinds) or this file (genesis, lead.handover, deputy.name, roster.choose), and rosterView builds every answer from query
// functions those modules export.
import { GENESIS_PREV, parseHeaderShape, entryHash } from './entry';
import type { SealedBlob } from './entry';
import { readGrant } from './cellKeys';
import { slotOfClientId } from './clientIds';
import { addGrant, applyCellEntry, applyGenesisCells, createCellsState, epochAt, granteesAt } from './rosterCells';
import type { CellsState } from './rosterCells';
import { applyGenesisLead, applyMemberEntry, chosenBranchOf, createMembersState, deviceAt, deviceKeyOf, devicesOfMemberAt, hubSignerAt, memberAt, seatsAt, slotOwnerAt, x25519At } from './rosterMembers';
import type { MembersState } from './rosterMembers';
import type { KeyRing, ReplicaContext, RosterView } from './rosterView';
import { verifyEntry } from './verify';
import type { VerifiedEntry } from './verify';

// The origin roster: position 0, before the genesis. Equal to GENESIS_PREV, the prev of a chain's first entry.
export const ORIGIN_ROSTER = GENESIS_PREV;

// What a joining machine pins (D-07): the genesis hash, the project id, and the lead's member id and keys.
export interface RosterAnchor { genesisHash: string; project: string; lead: { member: string; writer: string; publicKey: string; x25519: string } }

export type RosterKindOwner = 'members' | 'cells' | 'roster';

// Every roster kind (18) and project.genesis, each routed to exactly one owner module.
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
  'invite.void': 'members',
  'cell.create': 'cells',
  'cell.rekey': 'cells',
  'lead.handover': 'roster',
  'roster.choose': 'roster',
  'deputy.name': 'roster'
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
  'choose-branch-refused': 'The change this choice picked is itself refused, so the choice resolves nothing and the roster split stays open. Choose one of the other changes, or make the change again.'
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
  // Who holds staff_lead and deputy_lead from which position: the anchor's lead from the origin, then each lead.handover and deputy.name at the
  // position it takes. A deputy record without a member ends the deputy role (the deputy became the lead).
  leads: Array<{ member: string; from: number }>;
  deputies: Array<{ member: string | undefined; from: number }>;
  // Roster splits not chosen yet: two or more entries citing one head (the split point at); none of them applies until a choice (D-09).
  pending: Array<{ at: string; branches: string[]; text: string }>;
  // Splits a person chose: the roster.choose took the position after the split point and the chosen branch the one after it; the other branches stay
  // unapplied and are listed here.
  choices: Array<{ at: string; branches: string[]; chosen: string; choose: string }>;
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
    leads: [{ member: anchor.lead.member, from: 0 }],
    deputies: [],
    pending: [],
    choices: [],
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
    rosterBranchPending: (hash) => state.notChosen.has(hash)
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

function applyOne(state: RosterState, entry: VerifiedEntry): ApplyOutcome {
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
  // roster.choose is decided by the driver at the split point (chooseProblem), never here.
  return { status: 'refused', reason: 'roster-kind-pending' };
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
      if (entry.keep === 'newer-version' || !isRouted(entry.body.kind)) continue;
      const settled = settledRefusal(state, entry);
      if (settled !== undefined) refuse(hash, entry.body.kind, settled);
      else ready.push(entry);
    }
    const headPosition = state.positions.length - 1;
    const head = state.positions[headPosition];
    const citing = ready.filter((entry) => rosterPrevOf(entry) === head);
    if (citing.length === 0) break;
    // Authority at the head: an entry by a device that may not write the roster there is refused, so it can neither apply nor split the roster.
    const candidates: VerifiedEntry[] = [];
    for (const entry of citing) {
      ready.splice(ready.indexOf(entry), 1);
      if (isRosterWriterAt(state, entry.header.writer, headPosition)) candidates.push(entry);
      else refuse(entry.hash, entry.body.kind, 'not-a-roster-writer');
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
  for (const hash of waiting.keys()) state.held.push({ hash, reason: 'unknown-writer' });
  // Verified entries that never reached the head: on a branch nobody chose (D-11), or following a roster that is not on this machine's line.
  for (const entry of ready) state.held.push({ hash: entry.hash, reason: state.notChosen.has(entry.hash) ? 'roster-branch-not-chosen' : 'roster-prev-not-applied' });
  state.held.sort(byHash);

  placeGrants(state, input.grants);
  return state;
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

function placeGrants(state: RosterState, grants: readonly unknown[]): void {
  const seen = new Set<string>();
  for (const value of grants) {
    const read = readGrant(value);
    if (!read.ok) {
      state.refused.push({ hash: '', kind: 'grant', reason: read.reason });
      continue;
    }
    if (seen.has(read.hash)) continue;
    seen.add(read.hash);
    const position = state.positionOf.get(read.grant.roster);
    if (position === undefined) {
      state.held.push({ hash: read.hash, reason: 'missing-roster' });
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

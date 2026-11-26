// Products and their versions on the replica layer (MUS-03; D-23, D-24, D-27, D-34, D-37; DESIGN 6.1 to 6.3, 15.4 rows 1 to 5).
// Hub-side except for one call into doc.ts (snapshotReport), which takes plain bytes and so needs no Yjs types here.
//
// A product has a working text (the doc family) and frozen versions. A version.propose pins a content hash, a sealed blob of the exact text and header,
// and a Yjs snapshot. The fold accepts it only when the blob opens, the hash matches the text and the pins, and the text at the snapshot is the blob's
// text: text that was never in the document cannot become a version (15.4, forbidden act "proposal of text never in the document").
//
// Two kinds of work, kept apart so nothing depends on arrival order:
// - apply (fold order, which is deterministic for a set of entries): the checks that need only the entry, the product and the text so far.
// - finish (whole sets): numbering, concurrent proposals, "changes since", the owner prompt, and each version's gate state. Gate steps all go through
//   release.ts's transition(), in a fixed canonical sequence (tradecraft verdict, guard verdict, submit), never in arrival order. release.ts is reused
//   and never edited (D-24).
//
// Writers must set deps to the heads they have seen when they propose, so the updates the snapshot names are in the proposal's causal past and so
// before it in the total order. A proposal that names updates the fold has not reached is held updates-missing, not guessed at.
import type { Actor } from './entry';
import { blobBytesHash, openBlob } from './entry';
import { snapshotReport } from './doc';
import type { AttributionRun } from './doc';
import { MAX_STATE_BYTES } from './kindSchemas/doc';
import { sealedBlobWithin } from './updateGuard';
import { attributeText, summariseAuthors } from './attribution';
import type { AuthorSummary } from './attribution';
import type { CausalGraph } from './causal';
import { recordedDecisionOutcome, resolveDecisions } from './decisions';
import { PRODUCT_CELL_REFUSALS, pinProblem } from './productCells';
import type { PinCandidate } from './productCells';
import type { DecisionAct, DecisionClass, DecisionOutcome, DecisionResult } from './decisions';
import type { FamilyReducer, FoldView, ReduceOutcome } from './reducers';
import type { ReplicaContext, RosterView } from './rosterView';
import type { TextState } from './textFold';
import type { VerifiedEntry } from './verify';
import { isRecord } from '../team/validate';
import { createHash } from 'node:crypto';
import { transition } from '../staff/release';
import type { GuardVerdict, PersonActor, ProductRecord, ProductRoles, ReleaseEvent, ReleaseRefusalReason, ReleaseResult, StaffActor, TradecraftVerdict } from '../staff/release';

// Owner decision 4: the owner is asked, never overruled, once this many changes by other writers have piled up since a version. A named constant so it
// can be retuned. Nothing is ever withdrawn automatically.
export const OWNER_PROMPT_THRESHOLD = 20;

// Limits on what one writer can make this reducer build or keep (D-02, WR-05, WR-06). No honest flow comes near them.
// Proposals one writer may make on one product. Every proposal that passes the owner check counts, refused or applied, because each one may cost a
// blob decryption and a scratch build; a held proposal leaves no trace and does not count.
export const MAX_PROPOSALS_PER_WRITER_PRODUCT = 200;
// Acts (verdict, submit, decide, release, withdraw, supersede) one writer may write on one version hash. Every act of a version is judged against the
// others in finish, so this bounds that work too.
export const MAX_ACTS_PER_WRITER_VERSION = 32;

export const VERSION_REFUSALS = {
  'not-owner': 'Only the owning member\'s agent for a person who answers for the section, a person who answers for the section, or the section lead can propose this product.',
  'not-authorised': 'Only a section lead, the staff lead or the deputy lead can do that.',
  'product-exists': 'This product already exists.',
  'bad-roles': 'The owner seat must differ from the release-guard and the tradecraft reviewer.',
  'bad-blob': 'The text of the proposal cannot be read.',
  'too-large': 'The text of the proposal is larger than the allowed size.',
  'hash-mismatch': 'The version hash does not match the text and pins in the proposal.',
  'text-not-in-document': 'The proposed text was never in the shared document at the snapshot the proposal names.',
  'no-change': 'The proposal has the same hash as a version the product already has.',
  'wrong-state': 'That step is not possible from the version\'s current state.',
  'stale-version': 'That names a version this product does not have.',
  'not-decision-holder': 'Only a person who holds the decision role the version was submitted to can do that.',
  'not-released': 'The newer version has not been released, so it cannot replace this one.',
  'no-approval': 'There is no approval of this exact version in the past of this step.',
  'no-release': 'There is no release of this version in the past of this step.',
  'decline-not-pending': 'A decline can only settle decisions that were waiting for confirmation.',
  'not-gate-member': 'Only a member the roster lets run the release guard, or for the tradecraft gate the tradecraft reviewer, can give that verdict.',
  'too-many': 'This device has already proposed this product the largest allowed number of times.',
  'too-many-acts': 'This device has already written the largest allowed number of steps on this version.',
  'unsupported-kind': 'This kind of entry is not applied by this version.',
  // Plan 32-08 (D-18): a pin to a product above the version's own cell.
  ...PRODUCT_CELL_REFUSALS
} as const;
export type VersionRefusalReason = keyof typeof VERSION_REFUSALS | ReleaseRefusalReason;

export const VERSION_HOLDS = {
  'product-unknown': 'The product has no product.create yet, so the entry waits for it.',
  'missing-blob': 'The text of the proposal has not arrived yet.',
  'updates-missing': 'The snapshot names text updates this machine has not got yet.'
} as const;

export interface Pin { product: string; hash: string }

// One recorded act of a version-family kind: everything a later step needs, kept as the entry carried it.
export interface VersionAct {
  kind: string;
  entry: string;
  // Place among the entries of the product's own stream, in the total order. Never the global index: an unrelated stream must not change it.
  position: number;
  writer: string;
  member: string;
  actor: Actor;
  roster: string;
  data: Readonly<Record<string, unknown>>;
}

// An accepted proposal, before its gate state is derived.
export interface VersionProposal {
  number: number;
  hash: string;
  entry: string;
  proposer: { writer: string; member: string; actor: Actor };
  // The roles in force when it was proposed: a later product.owner affects later proposals only.
  roles: ProductRoles;
  pins: Pin[];
  header: Record<string, unknown>;
  // The Yjs snapshot the proposal pinned, kept to read who shaped the text at that point (D-20).
  snapshot: Uint8Array;
  // The attribution runs of the text at the snapshot, read once by the same inspection that checked the text (WR-05). Runs are joined across struct
  // splits and the snapshot names exact structs, so later updates never change them.
  runs: AttributionRun[];
}

export interface ProductEntry {
  stream: string;
  product: string;
  section: string;
  title: string;
  created: string;
  roles: ProductRoles;
  versions: VersionProposal[];
  acts: VersionAct[];
  // Added by plan 31-07. Proposals counted against MAX_PROPOSALS_PER_WRITER_PRODUCT, by writer.
  proposalCounts: Map<string, number>;
  // Acts counted against MAX_ACTS_PER_WRITER_VERSION, by `${version hash}/${writer}`.
  actCounts: Map<string, number>;
  // How many snapshot inspections (scratch builds) proposals of this product cost. Read by tests only; no output or digest carries it.
  snapshotReports: number;
}
export interface VersionsState { products: Map<string, ProductEntry> }

export interface VersionRefusal { entry: string; reason: VersionRefusalReason }

export interface VersionView {
  number: number;
  hash: string;
  entry: string;
  state: ProductRecord['state'];
  held?: { gate: 'guard' | 'tradecraft'; reasons: string[] };
  decisionFor?: string;
  proposedAtSameTimeAs: number[];
  changesSince: number;
  othersChangesSince: number;
  ownerPromptDue: boolean;
  pins: Pin[];
  header: Record<string, unknown>;
  // Guard or tradecraft verdicts that disagree and no fresh verdict has seen both (D-37).
  verdictConflict?: boolean;
  // Submits naming different decision_for roles with none after the other (a conservative reading).
  submitConflict?: boolean;
  // Set while the decisions on the version are in dispute or wait for confirmation (DESIGN 15.5). The state stays where it was.
  overlay?: 'contested' | 'pending-confirmation';
  decision: DecisionSummary;
  // Presentation only: the current decisions outside the newest verified checkpoint.
  decisionsSinceCheckpoint: string[];
  // Who shaped the text at the version's snapshot, persons and agents with their run (D-20). Later edits never change it.
  attribution: AuthorSummary[];
  // The products this version pins whose newest released version has a different hash (D-26).
  sourceChanged: SourceChange[];
}

export interface SourceChange { product: string; pinned: string; current: string }

// The outcome of the decision algebra for one version, in the words the interface needs (D-25).
export interface DecisionSummary {
  status: 'none' | 'effective' | 'contested';
  outcome?: DecisionClass;
  // The names of the persons whose acts are effective (agents are named by their member slug).
  names: string[];
  // Entry hashes: the maximal acts that conflict, the acts that count, the acts waiting for confirmation, and the acts held for an unknown entry.
  contested: string[];
  effective: string[];
  pending: string[];
  held: Array<{ id: string; reason: string }>;
  finalBeforeDispute: boolean;
}

// What 30-10 builds on: the version with its release.ts record and every act that names it.
export interface VersionRecord {
  number: number;
  hash: string;
  entry: string;
  roles: ProductRoles;
  release: ProductRecord;
  acts: VersionAct[];
}

export interface ProductVersions {
  stream: string;
  product: string;
  section: string;
  title: string;
  roles: ProductRoles;
  versions: VersionView[];
  records: VersionRecord[];
  refusals: VersionRefusal[];
  // The working text is withdrawn exactly when the newest version is withdrawn, and open again once a newer one is proposed (D-23).
  working: 'open' | 'withdrawn';
}

const productKey = (stream: string, product: string): string => `${stream}/${product}`;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The version hash (D-37): sha256 of the text with CRLF made LF, then a line "--depends_on: " and the product@hash pins joined by commas. This is the
// construction of ledger.ts productHash with hashes in place of numbers, so a pin names exact text.
export function replicaVersionHash(text: string, pins: readonly Pin[]): string {
  const depends = pins.map((pin) => `${pin.product}@${pin.hash}`).join(',');
  return createHash('sha256').update(`${text.replace(/\r\n/g, '\n')}\n--depends_on: ${depends}`).digest('hex');
}

interface Acting { actor: Actor; member: string; writer: string; roster: string }

// Does the writer count as the owner side of a product? An agent of one of the seats on the device of a person who answers for the section or leads
// it, or such a person themselves (DESIGN 6.3). The roles are read at the roster the entry cites (D-27).
export function isOwnerSide(who: Acting, section: string, seats: readonly string[], roster: RosterView): boolean {
  const holds = roster.hasRole(who.member, `answers_for:${section}`, who.roster) || roster.hasRole(who.member, `section_lead:${section}`, who.roster);
  if (!holds) return false;
  if (who.actor.kind === 'agent') return seats.includes(who.actor.member);
  return who.actor.kind === 'person';
}

// How a writer is presented to release.ts. An agent acts as itself. A person authorised as owner side is presented as the owner seat, as research's
// adapter proposes. An agent is never presented as a person, and a person who is not owner side stays a person, which the gate steps refuse.
export function actorForTransition(who: Acting, roster: RosterView, roles: ProductRoles, ownerSide: boolean): StaffActor {
  if (who.actor.kind === 'agent') return { kind: 'agent', member: who.actor.member };
  // A hub is never a person (D-06). The fold keeps hub entries before they reach a reducer; this is the second guard.
  if (who.actor.kind === 'hub') return { kind: 'agent', member: `hub:${who.actor.watch}` };
  if (ownerSide) return { kind: 'agent', member: roles.owner };
  return { kind: 'person', name: roster.memberName(who.member, who.roster) ?? who.member, role: 'member', deviceFingerprint: who.writer };
}

// The named person release.ts is shown for a decision: the roster's name for the member, the role the version waits on, and the signing device.
export function personForTransition(member: string, role: string, writer: string, rosterHash: string, roster: RosterView): PersonActor {
  return { kind: 'person', name: roster.memberName(member, rosterHash) ?? member, role, deviceFingerprint: writer };
}

function held(reason: keyof typeof VERSION_HOLDS): ReduceOutcome {
  return { status: 'held', reason };
}
function refused(reason: VersionRefusalReason): ReduceOutcome {
  return { status: 'refused', reason };
}

// tooLarge: the blob is the named one and its sealed length is over the state limit, so it is refused without being opened.
export function readVersionBlob(ctx: ReplicaContext, entry: VerifiedEntry, blobHash: string): { ok: true; text: string; header: Record<string, unknown> } | { ok: false; hold: boolean; tooLarge?: true } {
  const blob = ctx.blobs(blobHash);
  if (blob === undefined || blobBytesHash(blob) !== blobHash) return { ok: false, hold: true };
  // The size gate (31-RESEARCH new defect 1, D-43), from the base64url length and before the key is fetched or the blob decrypted. The blob matched
  // its name, so the answer does not depend on which copy this machine holds.
  if (!sealedBlobWithin(blob, MAX_STATE_BYTES)) return { ok: false, hold: false, tooLarge: true };
  const key = ctx.keys(entry.header.stream, entry.header.epoch);
  if (key === undefined) return { ok: false, hold: true };
  const opened = openBlob(key, entry.header.stream, entry.header.epoch, blob);
  if (opened === undefined) return { ok: false, hold: false };
  try {
    const parsed: unknown = JSON.parse(opened.toString('utf8'));
    if (!isRecord(parsed) || Object.keys(parsed).length !== 2 || typeof parsed.text !== 'string' || !isRecord(parsed.header)) return { ok: false, hold: false };
    return { ok: true, text: parsed.text, header: parsed.header };
  } catch {
    // Anything that is not the canonical JSON of { text, header } is an unreadable blob.
    return { ok: false, hold: false };
  }
}

function actOf(entry: VerifiedEntry, position: number): VersionAct {
  return { kind: entry.body.kind, entry: entry.hash, position, writer: entry.header.writer, member: entry.member, actor: entry.body.actor, roster: entry.body.roster, data: entry.data as Record<string, unknown> };
}

function leadership(entry: VerifiedEntry, view: FoldView, section: string | undefined): { section: boolean; staff: boolean } {
  const roster = view.ctx.roster;
  return {
    section: section !== undefined && roster.hasRole(entry.member, `section_lead:${section}`, entry.body.roster),
    staff: roster.hasRole(entry.member, 'staff_lead', entry.body.roster) || roster.hasRole(entry.member, 'deputy_lead', entry.body.roster)
  };
}

function applyPropose(state: VersionsState, entry: VerifiedEntry, view: FoldView): ReduceOutcome {
  const data = entry.data as { product: string; hash: string; textBlob: string; snapshot: string; pins: Pin[] };
  const product = state.products.get(productKey(entry.header.stream, data.product));
  if (product === undefined) return held('product-unknown');
  const who: Acting = { actor: entry.body.actor, member: entry.member, writer: entry.header.writer, roster: entry.body.roster };
  if (!isOwnerSide(who, product.section, [product.roles.owner], view.ctx.roster)) return refused('not-owner');
  // The proposal cap (WR-05), checked before any blob is opened. A held outcome leaves no trace, so only an applied or refused proposal counts.
  const writer = entry.header.writer;
  const count = product.proposalCounts.get(writer) ?? 0;
  if (count >= MAX_PROPOSALS_PER_WRITER_PRODUCT) return refused('too-many');
  const outcome = checkProposal(state, product, entry, data, view);
  if (outcome.status !== 'held') product.proposalCounts.set(writer, count + 1);
  return outcome;
}

// Every product the fold has reached, with the hashes of its accepted versions: what a pin may name (D-18).
function pinCandidates(state: VersionsState): PinCandidate[] {
  return [...state.products.values()].map((item) => ({ stream: item.stream, product: item.product, hashes: new Set(item.versions.map((version) => version.hash)) }));
}

function checkProposal(state: VersionsState, product: ProductEntry, entry: VerifiedEntry, data: { product: string; hash: string; textBlob: string; snapshot: string; pins: Pin[] }, view: FoldView): ReduceOutcome {
  // Write up, never down, through pins too (D-18, D-67): checked first, before any blob is opened, and counted against the cap like any refusal. Only
  // earlier entries in the fold order decide it, so every machine that holds the same cells gets the same answer.
  if (view.ctx.cellOrder !== undefined && data.pins.length > 0) {
    const problem = pinProblem(entry.header.stream, data.pins, pinCandidates(state), (citing, cited) => view.ctx.cellOrder?.(citing, cited) === true);
    if (problem !== undefined) return refused(problem);
  }
  const read = readVersionBlob(view.ctx, entry, data.textBlob);
  if (!read.ok) return read.hold ? held('missing-blob') : refused(read.tooLarge === true ? 'too-large' : 'bad-blob');
  const pins = data.pins.map((pin) => ({ product: pin.product, hash: pin.hash }));
  if (replicaVersionHash(read.text, pins) !== data.hash) return refused('hash-mismatch');
  if (product.versions.some((version) => version.hash === data.hash)) return refused('no-change');

  // The text family's updates the fold has reached so far; the snapshot must be covered by them and its text must be the blob's text.
  const text = view.state('doc') as TextState | undefined;
  const updates = (text?.products.get(productKey(entry.header.stream, data.product))?.accepted ?? []).map((update) => update.update);
  const snapshot = Buffer.from(data.snapshot, 'base64url');
  // One scratch build answers all three questions (WR-05): are updates missing, what was the text, and who shaped it.
  const report = snapshotReport(updates, snapshot);
  product.snapshotReports += 1;
  if (report?.missing === true) return held('updates-missing');
  if (report === undefined || report.text !== read.text) return refused('text-not-in-document');

  product.versions.push({
    number: product.versions.length + 1,
    hash: data.hash,
    entry: entry.hash,
    proposer: { writer: entry.header.writer, member: entry.member, actor: entry.body.actor },
    roles: product.roles,
    pins,
    header: read.header,
    snapshot,
    runs: report.runs ?? []
  });
  return { status: 'applied' };
}

export const versionsReducer: FamilyReducer<VersionsState, ProductVersions[]> = {
  family: 'versions',
  init: () => ({ products: new Map() }),
  apply(state, entry, view): ReduceOutcome {
    const kind = entry.body.kind;
    const data = entry.data as { product: string };
    const key = productKey(entry.header.stream, data.product);
    if (kind === 'product.create') {
      const create = entry.data as { section: string; roles: ProductRoles; title: string };
      const lead = leadership(entry, view, create.section);
      if (entry.body.actor.kind !== 'person' || !(lead.section || lead.staff)) return refused('not-authorised');
      if (state.products.has(key)) return refused('product-exists');
      const roles: ProductRoles = {
        owner: create.roles.owner,
        sectionLead: create.roles.sectionLead,
        releaseGuard: create.roles.releaseGuard,
        ...(create.roles.tradecraftReviewer === undefined ? {} : { tradecraftReviewer: create.roles.tradecraftReviewer })
      };
      state.products.set(key, { stream: entry.header.stream, product: data.product, section: create.section, title: create.title, created: entry.hash, roles, versions: [], acts: [], proposalCounts: new Map(), actCounts: new Map(), snapshotReports: 0 });
      return { status: 'applied' };
    }
    const product = state.products.get(key);
    if (product === undefined) return held('product-unknown');
    if (kind === 'product.owner') {
      const lead = leadership(entry, view, product.section);
      if (entry.body.actor.kind !== 'person' || !(lead.section || lead.staff)) return refused('not-authorised');
      const owner = (entry.data as { owner: string }).owner;
      if (owner === product.roles.releaseGuard || owner === product.roles.tradecraftReviewer) return refused('bad-roles');
      // Concurrent product.owner entries resolve by fold order, which is the same on every machine: the later one in the total order wins.
      product.roles = { ...product.roles, owner };
      return { status: 'applied' };
    }
    if (kind === 'version.propose') return applyPropose(state, entry, view);
    if (['version.verdict', 'version.submit', 'version.withdraw', 'version.decide', 'version.release', 'version.supersede'].includes(kind)) {
      // Judged in finish, from the whole set of acts on the version, so no step depends on which act arrived first. The act cap (WR-06) is the one
      // check here: it reads only the acts this writer already wrote on the same version hash, which come before this one in the total order.
      const counted = `${String((entry.data as { hash?: unknown }).hash)}/${entry.header.writer}`;
      const acts = product.actCounts.get(counted) ?? 0;
      if (acts >= MAX_ACTS_PER_WRITER_VERSION) return refused('too-many-acts');
      product.actCounts.set(counted, acts + 1);
      product.acts.push(actOf(entry, view.streamPosition(entry.hash) ?? 0));
      return { status: 'applied' };
    }
    return refused('unsupported-kind');
  },
  finish(state, view) {
    const text = view.state('doc') as TextState | undefined;
    const derived = [...state.products.values()]
      .sort((a, b) => compare(a.stream, b.stream) || compare(a.product, b.product))
      .map((product) => deriveProduct(product, text, view));
    markSourceChanges(derived);
    return derived;
  },
  canonical(output, stream) {
    return output
      .filter((product) => product.stream === stream)
      .sort((a, b) => compare(a.product, b.product))
      .map((product) => ({
        product: product.product,
        section: product.section,
        roles: { ...product.roles },
        versions: product.versions.map((version) => ({
          number: version.number,
          hash: version.hash,
          entry: version.entry,
          state: version.state,
          held: version.held === undefined ? null : { gate: version.held.gate, reasons: [...version.held.reasons] },
          decisionFor: version.decisionFor ?? null,
          sameTime: [...version.proposedAtSameTimeAs],
          changesSince: version.changesSince,
          othersChangesSince: version.othersChangesSince,
          ownerPromptDue: version.ownerPromptDue,
          verdictConflict: version.verdictConflict === true,
          submitConflict: version.submitConflict === true,
          overlay: version.overlay ?? null,
          decision: {
            status: version.decision.status,
            outcome: version.decision.outcome ?? null,
            names: [...version.decision.names],
            contested: [...version.decision.contested],
            effective: [...version.decision.effective],
            pending: [...version.decision.pending],
            held: version.decision.held.map((item): [string, string] => [item.id, item.reason]),
            finalBeforeDispute: version.decision.finalBeforeDispute
          },
          attribution: version.attribution.map((row) => [row.writer, row.member, row.actor, row.agentMember ?? null, row.run ?? null, row.characters]),
          sourceChanged: version.sourceChanged.map((change): [string, string, string] => [change.product, change.pinned, change.current])
        })),
        working: product.working,
        refusals: product.refusals.map((refusal): [string, string] => [refusal.entry, refusal.reason])
      }));
  },
  clone(state) {
    const copy: VersionsState = { products: new Map() };
    for (const [key, product] of state.products) {
      copy.products.set(key, { ...product, roles: { ...product.roles }, versions: [...product.versions], acts: [...product.acts], proposalCounts: new Map(product.proposalCounts), actCounts: new Map(product.actCounts) });
    }
    return copy;
  }
};

// The acts of one kind that name a version hash, in fold order.
const named = (acts: readonly VersionAct[], kind: string, hash: string): VersionAct[] => acts.filter((act) => act.kind === kind && act.data.hash === hash);

// The acts no other act of the list follows in the causal graph.
function maximal<T extends { entry: string }>(items: readonly T[], graph: CausalGraph): T[] {
  return items.filter((item) => !items.some((other) => other !== item && graph.isBefore(item.entry, other.entry)));
}

const last = <T>(items: readonly T[]): T => items[items.length - 1];

interface Verdict { act: VersionAct; verdict: string; reasons: string[]; entry: string }

interface Derived {
  record: ProductRecord;
  refusals: VersionRefusal[];
  verdictConflict: boolean;
  submitConflict: boolean;
  decision: DecisionSummary;
  overlay?: 'contested' | 'pending-confirmation';
  // Entry hashes of the release acts that count, for the supersede check of an older version.
  releaseActs: string[];
}

// Was a release of this version (by hash) made in the causal past of the entry? Supplied by the product, which derives the newest version first.
type ReleasedBefore = (versionHash: string, entry: string) => boolean;

function deriveVersion(product: ProductEntry, version: VersionProposal, view: FoldView, releasedBefore: ReleasedBefore): Derived {
  const graph = view.graph;
  const roster = view.ctx.roster;
  const roles = version.roles;
  const refusals: VersionRefusal[] = [];
  const base: ProductRecord = { product: product.product, section: product.section as ProductRecord['section'], roles, state: 'draft', version: version.number, hash: version.hash };
  const refuse = (act: VersionAct, reason: VersionRefusalReason): void => { refusals.push({ entry: act.entry, reason }); };
  const run = (record: ProductRecord, act: VersionAct, event: Parameters<typeof transition>[1], ownerSide: boolean): ReleaseResult => {
    return transition(record, event, actorForTransition(act, roster, roles, ownerSide));
  };

  // Valid verdicts of one gate: each is tried alone against the version's own record, so a refused act never hides a valid one before it.
  // WR-01 (D-12): the writing device's member must be allowed to run the gate's seat at the roster the verdict cites, or the verdict is dropped
  // not-gate-member before release.ts sees it. A roster view without canRunAgent allows nobody (default deny). A product without a tradecraft gate
  // has no seat to ask about, and release.ts refuses that verdict no-tradecraft-gate.
  const validVerdicts = (gate: 'guard' | 'tradecraft', signedBefore: (act: VersionAct) => boolean): Verdict[] => {
    const valid: Verdict[] = [];
    const seat = gate === 'guard' ? roles.releaseGuard : roles.tradecraftReviewer;
    for (const act of named(product.acts, 'version.verdict', version.hash)) {
      const data = act.data as { gate: 'guard' | 'tradecraft'; verdict: string; reasons: string[]; hash: string };
      if (data.gate !== gate) continue;
      if (seat !== undefined && roster.canRunAgent?.(act.member, seat, act.roster) !== true) { refuse(act, 'not-gate-member'); continue; }
      const context: ProductRecord = signedBefore(act) ? { ...base, tradecraftSignOff: version.hash } : base;
      const result = run(context, act, { type: 'verdict', gate, verdict: data.verdict as GuardVerdict | TradecraftVerdict, hash: data.hash, reasons: data.reasons }, false);
      if (result.ok) valid.push({ act, verdict: data.verdict, reasons: data.reasons, entry: act.entry });
      else refuse(act, result.reason);
    }
    return valid;
  };

  // Tradecraft first: a verdict of this gate needs nothing from the guard.
  const tradecraft = validVerdicts('tradecraft', () => false);
  const tradecraftMax = maximal(tradecraft, graph);
  const signedAt = (act: VersionAct): boolean => {
    const before = maximal(tradecraft.filter((candidate) => graph.isBefore(candidate.entry, act.entry)), graph);
    return before.length > 0 && before.every((candidate) => candidate.verdict === 'SIGN-OFF');
  };
  const guard = validVerdicts('guard', signedAt);

  let record = base;
  let verdictConflict = false;
  const applyVerdict = (item: Verdict, gate: 'guard' | 'tradecraft'): void => {
    const result = run(record, item.act, { type: 'verdict', gate, verdict: item.verdict as GuardVerdict | TradecraftVerdict, hash: version.hash, reasons: item.reasons }, false);
    if (result.ok) record = result.record;
    else refuse(item.act, result.reason);
  };
  if (roles.tradecraftReviewer !== undefined && tradecraftMax.length > 0) {
    const negatives = tradecraftMax.filter((item) => item.verdict === 'NOT READY');
    // Disagreement among the maximal verdicts is held until a fresh verdict has all of them in its past (D-37).
    if (negatives.length > 0 && negatives.length < tradecraftMax.length) verdictConflict = true;
    applyVerdict(last(negatives.length > 0 ? negatives : tradecraftMax), 'tradecraft');
  }

  const guardMax = maximal(guard, graph);
  const holds = guardMax.filter((item) => item.verdict === 'HOLD');
  const cleared = guardMax.filter((item) => item.verdict === 'CLEARED');
  if (holds.length > 0 && cleared.length > 0) verdictConflict = true;
  let clearedApplied = false;
  if (holds.length > 0) {
    applyVerdict(last(holds), 'guard');
  } else if (cleared.length > 0) {
    applyVerdict(last(cleared), 'guard');
    clearedApplied = record.state === 'guard-checked';
  }

  // Submit: only after the effective CLEARED, only by the owner side, and the maximal ones must agree on who decides.
  let submitConflict = false;
  const submits: Array<{ act: VersionAct; decisionFor: string }> = [];
  for (const act of named(product.acts, 'version.submit', version.hash)) {
    const ownerSide = isOwnerSide(act, product.section, [roles.owner, roles.sectionLead], roster);
    if (!ownerSide) { refuse(act, 'not-owner-or-lead'); continue; }
    const decisionFor = (act.data as { decisionFor: string }).decisionFor;
    const result = run(record, act, { type: 'submit', decisionFor }, ownerSide);
    if (!result.ok) { refuse(act, result.reason); continue; }
    const afterCleared = clearedApplied && cleared.some((item) => graph.isBefore(item.entry, act.entry));
    if (!afterCleared) { refuse(act, 'wrong-state'); continue; }
    submits.push({ act, decisionFor });
  }
  const submitMax = maximal(submits.map((item) => ({ ...item, entry: item.act.entry })), graph);
  if (submitMax.length > 0) {
    if (new Set(submitMax.map((item) => item.decisionFor)).size > 1) {
      submitConflict = true;
    } else {
      const chosen = last(submitMax);
      const result = run(record, chosen.act, { type: 'submit', decisionFor: chosen.decisionFor }, true);
      if (result.ok) record = result.record;
      else refuse(chosen.act, result.reason);
    }
  }
  const decided = deriveDecisions(product, version, record, submits.map((item) => ({ entry: item.act.entry, decisionFor: item.decisionFor })), view, releasedBefore);
  refusals.push(...decided.refusals);
  return { record: decided.record, refusals, verdictConflict, submitConflict, decision: decided.decision, ...(decided.overlay === undefined ? {} : { overlay: decided.overlay }), releaseActs: decided.releaseActs };
}

const DECISION_KINDS: readonly string[] = ['version.decide', 'version.release', 'version.withdraw', 'version.supersede'];
const SEEN_KINDS: readonly string[] = ['version.decide', 'version.release', 'version.withdraw'];

// How an act is shown to release.ts: a person as a named person with the role the version waits on, an agent as itself, a hub as an agent that can
// never decide.
function presented(act: VersionAct, role: string, roster: RosterView): StaffActor {
  if (act.actor.kind === 'person') return personForTransition(act.member, role, act.writer, act.roster, roster);
  if (act.actor.kind === 'agent') return { kind: 'agent', member: act.actor.member };
  return { kind: 'agent', member: `hub:${act.actor.watch}` };
}

interface Candidate { act: VersionAct; outcome: DecisionOutcome; entry: DecisionAct; actor: StaffActor }

const NO_DECISION: DecisionSummary = { status: 'none', names: [], contested: [], effective: [], pending: [], held: [], finalBeforeDispute: false };

interface Decided { record: ProductRecord; refusals: VersionRefusal[]; decision: DecisionSummary; overlay?: 'contested' | 'pending-confirmation'; releaseActs: string[] }

// Decisions on one version (D-24, D-25; DESIGN 15.4 rows 6 to 11, 15.5). Each act is judged alone first: an agent or hub act goes to release.ts
// transition() and is refused there (agent-cannot-decide) before any roster check, so the rule holds without the roster. A person must hold
// decision_for:<role> at the roster the act cites. The surviving acts go to resolveDecisions with the causal order, and the effective outcome is applied
// to the record through transition(). Nothing here reads fold order, so every delivery order of the same entries gives the same result.
function deriveDecisions(product: ProductEntry, version: VersionProposal, start: ProductRecord, submits: ReadonlyArray<{ entry: string; decisionFor: string }>, view: FoldView, releasedBefore: ReleasedBefore): Decided {
  const graph = view.graph;
  const roster = view.ctx.roster;
  const roles = version.roles;
  const acts = product.acts.filter((act) => DECISION_KINDS.includes(act.kind) && act.data.hash === version.hash);
  if (acts.length === 0) return { record: start, refusals: [], decision: NO_DECISION, releaseActs: [] };

  const refusals: VersionRefusal[] = [];
  const decisionFor = start.decisionFor;
  const role = decisionFor ?? 'owner-side';
  const probePerson: PersonActor = { kind: 'person', name: 'probe', role, deviceFingerprint: 'probe' };
  const awaiting = start.state === 'awaiting-decision' ? start : undefined;
  const approveStep = awaiting === undefined ? undefined : transition(awaiting, { type: 'approve', hash: version.hash }, probePerson);
  const approved = approveStep !== undefined && approveStep.ok ? approveStep.record : undefined;
  const releaseStep = approved === undefined ? undefined : transition(approved, { type: 'release', hash: version.hash }, probePerson);
  const released = releaseStep !== undefined && releaseStep.ok ? releaseStep.record : undefined;

  const holder = (act: VersionAct): boolean => decisionFor !== undefined && roster.hasRole(act.member, `decision_for:${decisionFor}`, act.roster);
  const ownerSide = (act: VersionAct): boolean => isOwnerSide(act, product.section, [roles.owner], roster);
  const seenOf = (act: VersionAct): string[] => (SEEN_KINDS.includes(act.kind) ? ([...(act.data.decisionsSeen as string[])]) : []);
  // A person's decision is unconfirmed when the removal of the role is concurrent with it: the decision may have been made after the role was lost, so a
  // person who still holds the role must confirm it (D-25). A removal the decision saw is no problem; one it follows is a stale citation, rejected by the chain.
  const confirmed = (act: VersionAct): boolean => {
    if (act.actor.kind !== 'person' || decisionFor === undefined) return true;
    const removal = roster.roleWithdrawnBy(act.member, `decision_for:${decisionFor}`, act.roster);
    if (removal === undefined || view.entry(removal) === undefined) return true;
    return !graph.concurrent(act.entry, removal);
  };
  const nameOf = (act: VersionAct): string => {
    if (act.actor.kind === 'person') return roster.memberName(act.member, act.roster) ?? act.member;
    return act.actor.kind === 'agent' ? `agent:${act.actor.member}` : `hub:${act.actor.watch}`;
  };
  const build = (act: VersionAct, outcome: DecisionOutcome, withConfirmation: boolean): DecisionAct => ({
    id: act.entry, outcome, by: nameOf(act), versionHash: version.hash, seen: seenOf(act), confirmed: withConfirmation ? confirmed(act) : true, final: view.isFinal(act.entry)
  });
  const resolve = (list: readonly DecisionAct[]): DecisionResult => resolveDecisions({ versionHash: version.hash, acts: list, before: graph.isBefore, isKnownEntry: (id) => graph.has(id) });

  const candidates: Candidate[] = [];
  const reject = (act: VersionAct, reason: VersionRefusalReason): void => { refusals.push({ entry: act.entry, reason }); };

  // Step one: every act but withdraw, judged alone.
  for (const act of acts) {
    const outcome = recordedDecisionOutcome(act.kind, act.data.outcome);
    if (outcome === undefined || act.kind === 'version.withdraw') continue;
    const actor = presented(act, role, roster);
    const newer = act.kind === 'version.supersede' ? product.versions.find((other) => other.hash === act.data.byHash) : undefined;
    const event: ReleaseEvent =
      act.kind === 'version.release' ? { type: 'release', hash: version.hash }
        : act.kind === 'version.supersede' ? { type: 'supersede', byVersion: newer?.number ?? version.number + 1 }
          : outcome === 'reject' ? { type: 'reject', reasons: act.data.reasons as string[] }
            // A decline is no transition; its actor is judged as an approve would be, which is the same human-only rule.
            : { type: 'approve', hash: version.hash };
    if (act.actor.kind !== 'person') {
      const result = transition(start, event, actor);
      reject(act, result.ok ? 'agent-cannot-decide' : result.reason);
      continue;
    }
    if (decisionFor === undefined || awaiting === undefined) {
      reject(act, act.kind === 'version.decide' ? 'wrong-state' : act.kind === 'version.release' ? 'no-approval' : 'no-release');
      continue;
    }
    if (!holder(act)) { reject(act, 'not-decision-holder'); continue; }
    let step: ReleaseResult | undefined;
    if (act.kind === 'version.decide') {
      if (!submits.some((submit) => submit.decisionFor === decisionFor && graph.isBefore(submit.entry, act.entry))) { reject(act, 'wrong-state'); continue; }
      step = transition(awaiting, event, actor);
    } else if (act.kind === 'version.release') {
      step = approved === undefined ? undefined : transition(approved, event, actor);
    } else {
      if (newer === undefined) { reject(act, 'stale-version'); continue; }
      if (newer.number <= version.number) { reject(act, 'out-of-order'); continue; }
      if (!releasedBefore(newer.hash, act.entry)) { reject(act, 'not-released'); continue; }
      step = released === undefined ? undefined : transition(released, event, actor);
    }
    if (step !== undefined && !step.ok) { reject(act, step.reason); continue; }
    candidates.push({ act, outcome, entry: build(act, outcome, true), actor });
  }

  // Step two: withdraws. Whether the version was already approved when the act was made decides who may withdraw it (release.ts: the owner side before,
  // a person after), and that depends on the acts in the withdraw's own past.
  const approvedIn = (act: VersionAct): boolean => {
    const known = new Set(seenOf(act));
    const before = candidates.filter((item) => item.outcome !== 'supersede' && (graph.isBefore(item.act.entry, act.entry) || known.has(item.act.entry))).map((item) => item.entry);
    const result = resolve(before);
    return result.status === 'effective' && result.outcome === 'APPROVE';
  };
  for (const act of acts) {
    if (act.kind !== 'version.withdraw') continue;
    const actor = presented(act, role, roster);
    const locked = approvedIn(act);
    const reason = act.data.reason as string;
    const against = locked && approved !== undefined ? approved : start;
    const result = transition(against, { type: 'withdraw', reason }, actor);
    if (!result.ok) { reject(act, result.reason); continue; }
    if (act.actor.kind === 'hub') { reject(act, 'agent-cannot-decide'); continue; }
    if (act.actor.kind === 'agent') {
      if (!ownerSide(act)) { reject(act, 'not-owner'); continue; }
    } else if (locked) {
      if (!holder(act)) { reject(act, 'not-decision-holder'); continue; }
    } else if (!ownerSide(act) && !holder(act)) {
      reject(act, 'not-owner-or-person');
      continue;
    }
    // An owner-side withdraw before any approval needs no confirmation: only the decision role can be withdrawn from a person.
    candidates.push({ act, outcome: 'withdraw', entry: build(act, 'withdraw', locked || !ownerSide(act)), actor });
  }

  const all = candidates.map((item) => item.entry);
  const result = resolve(all);
  const byId = new Map(candidates.map((item) => [item.act.entry, item]));
  for (const item of result.refused) refusals.push({ entry: item.id, reason: item.reason });
  const dropped = new Set([...result.refused.map((item) => item.id), ...result.held.map((item) => item.id)]);

  // A dispute leaves the version where its undisputed past put it: the acts that precede every contested act decide the state (DESIGN 15.5).
  let basis = result;
  let set = all;
  while (basis.status === 'contested') {
    const disputed = basis.contested;
    set = set.filter((item) => disputed.every((id) => graph.isBefore(item.id, id)));
    basis = resolve(set);
  }

  let record = start;
  if (basis.status === 'effective' && basis.outcome !== undefined) {
    const chosen = basis.effective.map((id) => byId.get(id) as Candidate).sort((a, b) => compare(a.act.entry, b.act.entry));
    const first = chosen[0];
    let applied: ReleaseResult | undefined;
    if (basis.outcome === 'APPROVE') {
      const approver = chosen.find((item) => item.outcome === 'approve') ?? first;
      applied = transition(record, { type: 'approve', hash: version.hash }, approver.actor);
      const releaser = chosen.find((item) => item.outcome === 'release');
      if (applied.ok && releaser !== undefined) applied = transition(applied.record, { type: 'release', hash: version.hash }, releaser.actor);
    } else if (basis.outcome === 'REJECT') {
      applied = transition(record, { type: 'reject', reasons: first.act.data.reasons as string[] }, first.actor);
    } else if (basis.outcome === 'WITHDRAW') {
      applied = transition(record, { type: 'withdraw', reason: first.act.data.reason as string }, first.actor);
    } else {
      // A supersede follows a release: the version is taken through the approval and release in its past, which the algebra has already checked exist.
      const before = candidates.filter((item) => !dropped.has(item.act.entry) && item.entry.confirmed && graph.isBefore(item.act.entry, first.act.entry));
      const approver = before.filter((item) => item.outcome === 'approve').sort((a, b) => compare(a.act.entry, b.act.entry))[0] ?? before.filter((item) => item.outcome === 'release').sort((a, b) => compare(a.act.entry, b.act.entry))[0];
      const releaser = before.filter((item) => item.outcome === 'release').sort((a, b) => compare(a.act.entry, b.act.entry))[0];
      applied = approver === undefined ? undefined : transition(record, { type: 'approve', hash: version.hash }, approver.actor);
      if (applied !== undefined && applied.ok && releaser !== undefined) applied = transition(applied.record, { type: 'release', hash: version.hash }, releaser.actor);
      const newer = product.versions.find((other) => other.hash === first.act.data.byHash);
      if (applied !== undefined && applied.ok) applied = transition(applied.record, { type: 'supersede', byVersion: newer?.number ?? version.number }, first.actor);
    }
    if (applied === undefined) refusals.push({ entry: first.act.entry, reason: 'no-release' });
    else if (applied.ok) record = applied.record;
    else refusals.push({ entry: first.act.entry, reason: applied.reason });
  }

  const overlay = result.status === 'contested' ? 'contested' as const : result.status === 'none' && result.pending.length > 0 ? 'pending-confirmation' as const : undefined;
  const decision: DecisionSummary = {
    status: result.status,
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
    names: [...result.names],
    contested: [...result.contested],
    effective: [...result.effective],
    pending: [...result.pending],
    held: result.held.map((item) => ({ id: item.id, reason: item.reason })),
    finalBeforeDispute: result.finalBeforeDispute
  };
  const releaseActs = candidates.filter((item) => item.outcome === 'release' && !dropped.has(item.act.entry) && item.entry.confirmed).map((item) => item.act.entry).sort(compare);
  return { record, refusals, decision, ...(overlay === undefined ? {} : { overlay }), releaseActs };
}

function deriveProduct(product: ProductEntry, text: TextState | undefined, view: FoldView): ProductVersions {
  const roster = view.ctx.roster;
  const productText = text?.products.get(productKey(product.stream, product.product));
  const updates = productText?.accepted ?? [];
  const sideCache = new Map<string, boolean>();
  const ownerSideUpdate = (hash: string, owner: string): boolean => {
    const cacheKey = `${hash}/${owner}`;
    const known = sideCache.get(cacheKey);
    if (known !== undefined) return known;
    const entry = view.entry(hash);
    const side = entry !== undefined && isOwnerSide({ actor: entry.body.actor, member: entry.member, writer: entry.header.writer, roster: entry.body.roster }, product.section, [owner], roster);
    sideCache.set(cacheKey, side);
    return side;
  };

  // The newest version first: a supersede of an older one needs the newer one's release to be in its causal past.
  const derivedBy = new Map<string, Derived>();
  const releases = new Map<string, string[]>();
  const releasedBefore: ReleasedBefore = (versionHash, entry) => (releases.get(versionHash) ?? []).some((release) => view.graph.isBefore(release, entry));
  for (const proposal of [...product.versions].sort((a, b) => b.number - a.number)) {
    const derived = deriveVersion(product, proposal, view, releasedBefore);
    derivedBy.set(proposal.hash, derived);
    releases.set(proposal.hash, derived.releaseActs);
  }

  const refusals: VersionRefusal[] = [];
  const versions: VersionView[] = [];
  const records: VersionRecord[] = [];
  for (const proposal of product.versions) {
    const derived = derivedBy.get(proposal.hash) as Derived;
    refusals.push(...derived.refusals);
    const past = view.graph.past(proposal.entry);
    const since = updates.filter((update) => !past.has(update.hash));
    const others = since.filter((update) => !ownerSideUpdate(update.hash, proposal.roles.owner));
    const sameTime = product.versions
      .filter((other) => other.number < proposal.number && view.graph.concurrent(other.entry, proposal.entry))
      .map((other) => other.number);
    const record = derived.record;
    // Who shaped the text as it stood at the snapshot (D-20), from the runs the proposal's own inspection read (WR-05): no scratch build here.
    const attribution = productText === undefined ? [] : summariseAuthors(attributeText(proposal.runs, productText.registrations));
    versions.push({
      number: proposal.number,
      hash: proposal.hash,
      entry: proposal.entry,
      state: record.state,
      ...(record.held === undefined ? {} : { held: { gate: record.held.gate, reasons: [...record.held.reasons] } }),
      ...(record.decisionFor === undefined ? {} : { decisionFor: record.decisionFor }),
      proposedAtSameTimeAs: sameTime,
      changesSince: since.length,
      othersChangesSince: others.length,
      ownerPromptDue: others.length >= OWNER_PROMPT_THRESHOLD,
      pins: proposal.pins.map((pin) => ({ ...pin })),
      header: proposal.header,
      ...(derived.verdictConflict ? { verdictConflict: true } : {}),
      ...(derived.submitConflict ? { submitConflict: true } : {}),
      ...(derived.overlay === undefined ? {} : { overlay: derived.overlay }),
      decision: derived.decision,
      decisionsSinceCheckpoint: [...derived.decision.contested, ...derived.decision.effective, ...derived.decision.pending]
        .filter((hash) => !view.isFinal(hash)).sort(compare),
      attribution,
      sourceChanged: []
    });
    records.push({
      number: proposal.number,
      hash: proposal.hash,
      entry: proposal.entry,
      roles: proposal.roles,
      release: record,
      acts: product.acts.filter((act) => act.data.hash === proposal.hash)
    });
  }
  // A step that names a hash this product has no version for is stale: nothing it names exists.
  const known = new Set(product.versions.map((version) => version.hash));
  for (const act of product.acts) {
    if (act.kind !== 'version.propose' && !known.has(act.data.hash as string)) refusals.push({ entry: act.entry, reason: 'stale-version' });
  }
  refusals.sort((a, b) => compare(a.entry, b.entry) || compare(a.reason, b.reason));
  const newest = versions[versions.length - 1];
  const working = newest !== undefined && newest.state === 'withdrawn' ? 'withdrawn' : 'open';
  return { stream: product.stream, product: product.product, section: product.section, title: product.title, roles: { ...product.roles }, versions, records, refusals, working };
}

// The dependants' "source changed" (D-26): a pin names product@hash, and that product's newest released version is another hash. Only a released version
// counts, so an approved one that has not been released shows nothing. A pin of a version newer than the newest released one is not out of date.
function markSourceChanges(products: readonly ProductVersions[]): void {
  const newest = new Map<string, { number: number; hash: string }>();
  const numbers = new Map<string, number>();
  for (const product of products) {
    for (const version of product.versions) {
      numbers.set(`${product.product}@${version.hash}`, version.number);
      if (version.state !== 'released') continue;
      const current = newest.get(product.product);
      if (current === undefined || version.number > current.number || (version.number === current.number && version.hash < current.hash)) newest.set(product.product, { number: version.number, hash: version.hash });
    }
  }
  for (const product of products) {
    for (const version of product.versions) {
      version.sourceChanged = version.pins
        .filter((pin) => {
          const current = newest.get(pin.product);
          if (current === undefined || current.hash === pin.hash) return false;
          const pinned = numbers.get(`${pin.product}@${pin.hash}`);
          return pinned === undefined || pinned < current.number;
        })
        .map((pin) => ({ product: pin.product, pinned: pin.hash, current: (newest.get(pin.product) as { hash: string }).hash }))
        .sort((a, b) => compare(a.product, b.product) || compare(a.pinned, b.pinned));
    }
  }
}

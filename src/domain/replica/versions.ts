// Products and their versions on the replica layer (MUS-03; D-23, D-24, D-27, D-34, D-37; DESIGN 6.1 to 6.3, 15.4 rows 1 to 5).
// Hub-side except for one call into doc.ts (textAtSnapshot, snapshotMissing), which takes plain bytes and so needs no Yjs types here.
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
import { snapshotMissing, textAtSnapshot } from './doc';
import type { CausalGraph } from './causal';
import type { FamilyReducer, FoldView, ReduceOutcome } from './reducers';
import type { RosterView } from './rosterView';
import type { TextState } from './textFold';
import type { VerifiedEntry } from './verify';
import { isRecord } from '../team/validate';
import { createHash } from 'node:crypto';
import { transition } from '../staff/release';
import type { GuardVerdict, ProductRecord, ProductRoles, ReleaseRefusalReason, ReleaseResult, StaffActor, TradecraftVerdict } from '../staff/release';

// Owner decision 4: the owner is asked, never overruled, once this many changes by other writers have piled up since a version. A named constant so it
// can be retuned. Nothing is ever withdrawn automatically.
export const OWNER_PROMPT_THRESHOLD = 20;

export const VERSION_REFUSALS = {
  'not-owner': 'Only the owning member\'s agent for a person who answers for the section, a person who answers for the section, or the section lead can propose this product.',
  'not-authorised': 'Only a section lead, the staff lead or the deputy lead can do that.',
  'product-exists': 'This product already exists.',
  'bad-roles': 'The owner seat must differ from the release-guard and the tradecraft reviewer.',
  'bad-blob': 'The text of the proposal cannot be read.',
  'hash-mismatch': 'The version hash does not match the text and pins in the proposal.',
  'text-not-in-document': 'The proposed text was never in the shared document at the snapshot the proposal names.',
  'no-change': 'The proposal has the same hash as a version the product already has.',
  'wrong-state': 'That step is not possible from the version\'s current state.',
  'stale-version': 'That names a version this product does not have.',
  'unsupported-kind': 'This kind of entry is not applied by this version.'
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
  // Place in the total order.
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
  if (ownerSide) return { kind: 'agent', member: roles.owner };
  return { kind: 'person', name: roster.memberName(who.member, who.roster) ?? who.member, role: 'member', deviceFingerprint: who.writer };
}

function held(reason: keyof typeof VERSION_HOLDS): ReduceOutcome {
  return { status: 'held', reason };
}
function refused(reason: VersionRefusalReason): ReduceOutcome {
  return { status: 'refused', reason };
}

function readBlobText(view: FoldView, entry: VerifiedEntry, blobHash: string): { ok: true; text: string; header: Record<string, unknown> } | { ok: false; hold: boolean } {
  const blob = view.ctx.blobs(blobHash);
  if (blob === undefined || blobBytesHash(blob) !== blobHash) return { ok: false, hold: true };
  const key = view.ctx.keys(entry.header.stream, entry.header.epoch);
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

  const read = readBlobText(view, entry, data.textBlob);
  if (!read.ok) return read.hold ? held('missing-blob') : refused('bad-blob');
  const pins = data.pins.map((pin) => ({ product: pin.product, hash: pin.hash }));
  if (replicaVersionHash(read.text, pins) !== data.hash) return refused('hash-mismatch');
  if (product.versions.some((version) => version.hash === data.hash)) return refused('no-change');

  // The text family's updates the fold has reached so far; the snapshot must be covered by them and its text must be the blob's text.
  const text = view.state('doc') as TextState | undefined;
  const updates = (text?.products.get(productKey(entry.header.stream, data.product))?.accepted ?? []).map((update) => update.update);
  const snapshot = Buffer.from(data.snapshot, 'base64url');
  if (snapshotMissing(updates, snapshot)) return held('updates-missing');
  if (textAtSnapshot(updates, snapshot) !== read.text) return refused('text-not-in-document');

  product.versions.push({
    number: product.versions.length + 1,
    hash: data.hash,
    entry: entry.hash,
    proposer: { writer: entry.header.writer, member: entry.member, actor: entry.body.actor },
    roles: product.roles,
    pins,
    header: read.header
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
      state.products.set(key, { stream: entry.header.stream, product: data.product, section: create.section, title: create.title, created: entry.hash, roles, versions: [], acts: [] });
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
      // Judged in finish, from the whole set of acts on the version, so no step depends on which act arrived first.
      product.acts.push(actOf(entry, view.position(entry.hash) ?? 0));
      return { status: 'applied' };
    }
    return refused('unsupported-kind');
  },
  finish(state, view) {
    const text = view.state('doc') as TextState | undefined;
    return [...state.products.values()]
      .sort((a, b) => compare(a.stream, b.stream) || compare(a.product, b.product))
      .map((product) => deriveProduct(product, text, view));
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
          submitConflict: version.submitConflict === true
        })),
        refusals: product.refusals.map((refusal): [string, string] => [refusal.entry, refusal.reason])
      }));
  },
  clone(state) {
    const copy: VersionsState = { products: new Map() };
    for (const [key, product] of state.products) {
      copy.products.set(key, { ...product, roles: { ...product.roles }, versions: [...product.versions], acts: [...product.acts] });
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

interface Derived { record: ProductRecord; refusals: VersionRefusal[]; verdictConflict: boolean; submitConflict: boolean }

function deriveVersion(product: ProductEntry, version: VersionProposal, view: FoldView): Derived {
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
  const validVerdicts = (gate: 'guard' | 'tradecraft', signedBefore: (act: VersionAct) => boolean): Verdict[] => {
    const valid: Verdict[] = [];
    for (const act of named(product.acts, 'version.verdict', version.hash)) {
      const data = act.data as { gate: 'guard' | 'tradecraft'; verdict: string; reasons: string[]; hash: string };
      if (data.gate !== gate) continue;
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
  return { record, refusals, verdictConflict, submitConflict };
}

function deriveProduct(product: ProductEntry, text: TextState | undefined, view: FoldView): ProductVersions {
  const roster = view.ctx.roster;
  const updates = text?.products.get(productKey(product.stream, product.product))?.accepted ?? [];
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

  const refusals: VersionRefusal[] = [];
  const versions: VersionView[] = [];
  const records: VersionRecord[] = [];
  for (const proposal of product.versions) {
    const derived = deriveVersion(product, proposal, view);
    refusals.push(...derived.refusals);
    const past = view.graph.past(proposal.entry);
    const since = updates.filter((update) => !past.has(update.hash));
    const others = since.filter((update) => !ownerSideUpdate(update.hash, proposal.roles.owner));
    const sameTime = product.versions
      .filter((other) => other.number < proposal.number && view.graph.concurrent(other.entry, proposal.entry))
      .map((other) => other.number);
    const record = derived.record;
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
      ...(derived.submitConflict ? { submitConflict: true } : {})
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
  // A verdict or submit that names a hash this product has no version for is stale: nothing it names exists.
  const known = new Set(product.versions.map((version) => version.hash));
  for (const act of product.acts) {
    if ((act.kind === 'version.verdict' || act.kind === 'version.submit') && !known.has(act.data.hash as string)) refusals.push({ entry: act.entry, reason: 'stale-version' });
  }
  refusals.sort((a, b) => compare(a.entry, b.entry) || compare(a.reason, b.reason));
  return { stream: product.stream, product: product.product, section: product.section, title: product.title, roles: { ...product.roles }, versions, records, refusals };
}

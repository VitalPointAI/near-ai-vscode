// The release state machine every staff product follows (design 10, 4.1; WP-0). Pure: no I/O, no clock, no vscode.
//
// One function moves a product from state to state, and it is the only place the rules live. An agent (a team member) can only draft, revise, give a
// gate verdict, submit and withdraw; approve, reject, release and supersede need a named person, and the function refuses them for any agent whatever
// the product's state, so no tool, MCP server or edited header can reach them through this contract. Every allowed step returns the transition records
// to write to the decision log and to send as `staff.product.state` events; every refused step returns one reason from a closed list and changes nothing.
import { STAFF_SECTION_IDS } from './doctrine';
import type { StaffSectionId } from './doctrine';
import { isOneLine, STAFF_SLUG } from './parse';

export const RELEASE_STATES = ['draft', 'guard-checked', 'awaiting-decision', 'approved', 'rejected', 'released', 'superseded', 'withdrawn'] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

/** States nothing leaves. */
export const TERMINAL_RELEASE_STATES: readonly ReleaseState[] = ['superseded', 'withdrawn'];

/** States in which the product's content is fixed: a change is a new version (a new product record), never an edit. */
export const LOCKED_RELEASE_STATES: readonly ReleaseState[] = ['approved', 'released'];

export const RELEASE_EVENT_TYPES = ['propose', 'verdict', 'submit', 'edit', 'approve', 'reject', 'release', 'supersede', 'withdraw'] as const;
export type ReleaseEventType = (typeof RELEASE_EVENT_TYPES)[number];

/** The events only a named person may cause. No agent verb maps to any of them. */
export const HUMAN_ONLY_EVENTS: readonly ReleaseEventType[] = ['approve', 'reject', 'release', 'supersede'];

/**
 * The verbs the `staff-products` tool offers agents (design 10, 4.1). There is no approve, reject, release or supersede verb: the manifest declares none,
 * and the state machine refuses those events from an agent in any case.
 */
export const AGENT_PRODUCT_VERBS = ['propose', 'verdict', 'submit', 'withdraw', 'status', 'list'] as const;
export type AgentProductVerb = (typeof AGENT_PRODUCT_VERBS)[number];

export const GUARD_VERDICTS = ['CLEARED', 'HOLD'] as const;
export const TRADECRAFT_VERDICTS = ['SIGN-OFF', 'NOT READY'] as const;
export type GuardVerdict = (typeof GUARD_VERDICTS)[number];
export type TradecraftVerdict = (typeof TRADECRAFT_VERDICTS)[number];
export type StaffGate = 'guard' | 'tradecraft';

/** A version hash: the SHA-256 of the product file, as 64 lower case hex digits. */
export const PRODUCT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** An agent: a member of a staff team, by its slug. */
export interface AgentActor { readonly kind: 'agent'; readonly member: string }

/**
 * A named person: their name and role, and the fingerprint of the device key that signs the decision record. Until verified identities arrive (Phase
 * 71) the name is self-declared, and the UI says so.
 */
export interface PersonActor { readonly kind: 'person'; readonly name: string; readonly role: string; readonly deviceFingerprint: string }

export type StaffActor = AgentActor | PersonActor;

/**
 * Who does what for one product, fixed when the product is first proposed: the owning member, the section lead who may submit it, the release-guard, and
 * for products that pass the J2 tradecraft gate, the tradecraft reviewer. A product with a tradecraft reviewer needs that sign-off before the guard can
 * clear it.
 */
export interface ProductRoles {
  readonly owner: string;
  readonly sectionLead: string;
  readonly releaseGuard: string;
  readonly tradecraftReviewer?: string;
}

export interface ProductIdentity {
  readonly product: string;
  readonly section: StaffSectionId;
  readonly roles: ProductRoles;
}

/** One product's place in the machine. Only `transition` and `startProduct` make these. */
export interface ProductRecord extends ProductIdentity {
  readonly state: ReleaseState;
  readonly version: number;
  readonly hash: string;
  /** The last HOLD or NOT READY on the current version, with its reasons; cleared by a new version or a passing verdict. */
  readonly held?: { readonly gate: StaffGate; readonly reasons: readonly string[] };
  /** The version hash the tradecraft reviewer signed off. */
  readonly tradecraftSignOff?: string;
  /** The version hash the release-guard cleared. */
  readonly guardCleared?: string;
  /** The human role the product waits on (`decision_for`). */
  readonly decisionFor?: string;
  readonly approval?: { readonly hash: string; readonly by: PersonActor };
  /** The last rejection, kept when the owner revises so the new draft links to the reasons. */
  readonly rejection?: { readonly version: number; readonly reasons: readonly string[]; readonly by: PersonActor };
  readonly supersededBy?: number;
  readonly withdrawal?: { readonly reason: string; readonly by: StaffActor };
}

export type ReleaseEvent =
  | { readonly type: 'propose'; readonly hash: string }
  | { readonly type: 'verdict'; readonly gate: StaffGate; readonly verdict: GuardVerdict | TradecraftVerdict; readonly hash: string; readonly reasons: readonly string[] }
  | { readonly type: 'submit'; readonly decisionFor: string }
  | { readonly type: 'edit'; readonly hash: string }
  | { readonly type: 'approve'; readonly hash: string; readonly releaseOnApproval?: boolean }
  | { readonly type: 'reject'; readonly reasons: readonly string[] }
  | { readonly type: 'release'; readonly hash: string }
  | { readonly type: 'supersede'; readonly byVersion: number }
  | { readonly type: 'withdraw'; readonly reason: string };

/** One step, as written to the decision log and sent as a `staff.product.state` event. `from` is null for the first version. */
export interface TransitionRecord {
  readonly product: string;
  readonly section: StaffSectionId;
  readonly version: number;
  readonly hash: string;
  readonly from: ReleaseState | null;
  readonly to: ReleaseState;
  readonly event: ReleaseEventType;
  readonly actor: StaffActor;
  readonly reasons?: readonly string[];
}

/** The closed list of reasons a step is refused, each one plain sentence. */
export const RELEASE_REFUSALS = {
  'agent-cannot-decide': 'Only a named person can approve, reject, release or supersede a staff product. An agent can only draft or propose.',
  'unnamed-person': 'A decision needs a named person: a name, a role and the device key that signs it.',
  'not-owner': 'Only the product\'s owner can do that.',
  'not-owner-or-lead': 'Only the product\'s owner or the section lead can submit it for a decision.',
  'not-owner-or-person': 'Only the product\'s owner or a person can withdraw it.',
  'not-gate-member': 'Only the product\'s release-guard, or for the tradecraft gate its tradecraft reviewer, can give that verdict.',
  'no-tradecraft-gate': 'This product has no tradecraft gate.',
  'wrong-verdict': 'That verdict does not belong to that gate.',
  'wrong-state': 'That step is not possible from the product\'s current state.',
  locked: 'An approved or released product cannot change. Write a new version instead.',
  terminal: 'The product is superseded or withdrawn. Nothing further can happen to it.',
  'stale-version': 'That refers to a different version of the product than the current one.',
  'tradecraft-required': 'This product needs the tradecraft sign-off on this exact version before the release-guard can clear it.',
  'reasons-required': 'Give at least one reason.',
  'decision-for-required': 'Name the role of the person who decides.',
  'no-change': 'The new version is the same as the current one.',
  'out-of-order': 'A product is superseded only by a newer version of itself.',
  'bad-input': 'A value has the wrong form.'
} as const;

export type ReleaseRefusalReason = keyof typeof RELEASE_REFUSALS;

export type ReleaseResult =
  | { readonly ok: true; readonly record: ProductRecord; readonly transitions: readonly TransitionRecord[] }
  | { readonly ok: false; readonly reason: ReleaseRefusalReason; readonly message: string };

/**
 * The transition table (design 10, 4.1) as data, for documentation, the UI and the tests. `who` is the class of actor the row admits; the function
 * below is the authority and the tests hold the two to each other.
 */
export const RELEASE_TRANSITIONS: ReadonlyArray<{ readonly from: ReleaseState | null; readonly to: ReleaseState; readonly event: ReleaseEventType; readonly who: string }> = [
  { from: null, to: 'draft', event: 'propose', who: 'owner' },
  { from: 'draft', to: 'draft', event: 'propose', who: 'owner' },
  { from: 'rejected', to: 'draft', event: 'propose', who: 'owner' },
  { from: 'draft', to: 'guard-checked', event: 'verdict', who: 'release-guard (CLEARED)' },
  { from: 'draft', to: 'draft', event: 'verdict', who: 'release-guard (HOLD) or tradecraft reviewer' },
  { from: 'guard-checked', to: 'awaiting-decision', event: 'submit', who: 'owner or section lead' },
  { from: 'draft', to: 'draft', event: 'edit', who: 'anyone' },
  { from: 'guard-checked', to: 'draft', event: 'edit', who: 'anyone' },
  { from: 'awaiting-decision', to: 'draft', event: 'edit', who: 'anyone' },
  { from: 'awaiting-decision', to: 'approved', event: 'approve', who: 'named person' },
  { from: 'awaiting-decision', to: 'rejected', event: 'reject', who: 'named person' },
  { from: 'approved', to: 'released', event: 'release', who: 'named person' },
  { from: 'released', to: 'superseded', event: 'supersede', who: 'named person' },
  { from: 'draft', to: 'withdrawn', event: 'withdraw', who: 'owner or person' },
  { from: 'guard-checked', to: 'withdrawn', event: 'withdraw', who: 'owner or person' },
  { from: 'awaiting-decision', to: 'withdrawn', event: 'withdraw', who: 'owner or person' },
  { from: 'rejected', to: 'withdrawn', event: 'withdraw', who: 'owner or person' },
  { from: 'approved', to: 'withdrawn', event: 'withdraw', who: 'person' },
  { from: 'released', to: 'withdrawn', event: 'withdraw', who: 'person' }
];

const MAX_REASON = 500;
const MAX_REASONS = 20;
const MAX_ROLE = 80;

function refuse(reason: ReleaseRefusalReason): ReleaseResult {
  return { ok: false, reason, message: RELEASE_REFUSALS[reason] };
}

/** A person counts as named only with a name, a role and a device key fingerprint, each one line of text. */
export function isNamedPerson(actor: StaffActor): actor is PersonActor {
  return actor.kind === 'person' && isOneLine(actor.name, 120) && isOneLine(actor.role, MAX_ROLE) && isOneLine(actor.deviceFingerprint, 200);
}

function isAgent(actor: StaffActor, member: string | undefined): boolean {
  return actor.kind === 'agent' && member !== undefined && actor.member === member;
}

function validReasons(reasons: readonly string[]): boolean {
  return Array.isArray(reasons) && reasons.length >= 1 && reasons.length <= MAX_REASONS && reasons.every((reason) => isOneLine(reason, MAX_REASON));
}

function validRoles(roles: ProductRoles): boolean {
  const slugs = [roles.owner, roles.sectionLead, roles.releaseGuard, ...(roles.tradecraftReviewer === undefined ? [] : [roles.tradecraftReviewer])];
  if (!slugs.every((slug) => typeof slug === 'string' && STAFF_SLUG.test(slug))) return false;
  // A gate never checks its own work: the guard and the tradecraft reviewer are never the owner, and never each other.
  if (roles.releaseGuard === roles.owner || roles.tradecraftReviewer === roles.owner || roles.tradecraftReviewer === roles.releaseGuard) return false;
  return true;
}

function step(record: ProductRecord, from: ReleaseState, actor: StaffActor, event: ReleaseEventType, reasons?: readonly string[]): TransitionRecord {
  return { product: record.product, section: record.section, version: record.version, hash: record.hash, from, to: record.state, event, actor, ...(reasons ? { reasons: [...reasons] } : {}) };
}

/** A copy of the record without the named optional fields. */
function without(record: ProductRecord, ...keys: ReadonlyArray<keyof ProductRecord>): ProductRecord {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record) as Array<keyof ProductRecord>) if (!keys.includes(key)) copy[key] = record[key];
  return copy as unknown as ProductRecord;
}

/** A new version: the hash changes, the version counts up, and every verdict, hold and pending decision on the old version is void. */
function newVersion(record: ProductRecord, hash: string): ProductRecord {
  return { ...without(record, 'held', 'tradecraftSignOff', 'guardCleared', 'decisionFor'), state: 'draft', version: record.version + 1, hash };
}

/** (none) to draft: the owning member writes the first version. */
export function startProduct(identity: ProductIdentity, actor: StaffActor, hash: string): ReleaseResult {
  if (!STAFF_SLUG.test(identity.product) || !(STAFF_SECTION_IDS as readonly string[]).includes(identity.section) || !validRoles(identity.roles)) return refuse('bad-input');
  if (!PRODUCT_HASH_PATTERN.test(hash)) return refuse('bad-input');
  if (!isAgent(actor, identity.roles.owner)) return refuse('not-owner');
  const roles: ProductRoles = {
    owner: identity.roles.owner, sectionLead: identity.roles.sectionLead, releaseGuard: identity.roles.releaseGuard,
    ...(identity.roles.tradecraftReviewer === undefined ? {} : { tradecraftReviewer: identity.roles.tradecraftReviewer })
  };
  const record: ProductRecord = { product: identity.product, section: identity.section, roles, state: 'draft', version: 1, hash };
  return { ok: true, record, transitions: [{ product: record.product, section: record.section, version: 1, hash, from: null, to: 'draft', event: 'propose', actor }] };
}

/**
 * One step of the machine. Checks run in a fixed order: who (an agent never decides; a decision needs a named person; the role the step needs), then
 * when (the state allows the step), then what (version hashes, reasons, the tradecraft sign-off). The record passed in is never changed.
 */
export function transition(record: ProductRecord, event: ReleaseEvent, actor: StaffActor): ReleaseResult {
  if (HUMAN_ONLY_EVENTS.includes(event.type)) {
    if (actor.kind !== 'person') return refuse('agent-cannot-decide');
    if (!isNamedPerson(actor)) return refuse('unnamed-person');
  }
  const from = record.state;
  if (TERMINAL_RELEASE_STATES.includes(from)) return refuse('terminal');
  const roles = record.roles;
  switch (event.type) {
    case 'propose': {
      if (!isAgent(actor, roles.owner)) return refuse('not-owner');
      if (LOCKED_RELEASE_STATES.includes(from)) return refuse('locked');
      if (from !== 'draft' && from !== 'rejected') return refuse('wrong-state');
      if (!PRODUCT_HASH_PATTERN.test(event.hash)) return refuse('bad-input');
      if (event.hash === record.hash) return refuse('no-change');
      const next = newVersion(record, event.hash);
      return { ok: true, record: next, transitions: [step(next, from, actor, 'propose')] };
    }
    case 'verdict': {
      const guard = event.gate === 'guard';
      if (!guard && event.gate !== 'tradecraft') return refuse('bad-input');
      if (!guard && roles.tradecraftReviewer === undefined) return refuse('no-tradecraft-gate');
      if (!isAgent(actor, guard ? roles.releaseGuard : roles.tradecraftReviewer)) return refuse('not-gate-member');
      const words: readonly string[] = guard ? GUARD_VERDICTS : TRADECRAFT_VERDICTS;
      if (!words.includes(event.verdict)) return refuse('wrong-verdict');
      if (from !== 'draft') return LOCKED_RELEASE_STATES.includes(from) ? refuse('locked') : refuse('wrong-state');
      if (event.hash !== record.hash) return refuse('stale-version');
      if (event.verdict === 'HOLD' || event.verdict === 'NOT READY') {
        if (!validReasons(event.reasons)) return refuse('reasons-required');
        const base = guard ? without(record, 'guardCleared') : without(record, 'tradecraftSignOff');
        const next: ProductRecord = { ...base, state: 'draft', held: { gate: event.gate, reasons: [...event.reasons] } };
        return { ok: true, record: next, transitions: [step(next, from, actor, 'verdict', event.reasons)] };
      }
      if (event.verdict === 'SIGN-OFF') {
        const next: ProductRecord = { ...(record.held?.gate === 'tradecraft' ? without(record, 'held') : record), tradecraftSignOff: record.hash };
        return { ok: true, record: next, transitions: [step(next, from, actor, 'verdict')] };
      }
      // CLEARED: a product with a tradecraft gate needs its sign-off on this exact version first (design 10, 4.4: tradecraft, then release-guard).
      if (roles.tradecraftReviewer !== undefined && record.tradecraftSignOff !== record.hash) return refuse('tradecraft-required');
      const next: ProductRecord = { ...without(record, 'held'), state: 'guard-checked', guardCleared: record.hash };
      return { ok: true, record: next, transitions: [step(next, from, actor, 'verdict')] };
    }
    case 'submit': {
      if (!isAgent(actor, roles.owner) && !isAgent(actor, roles.sectionLead)) return refuse('not-owner-or-lead');
      if (from !== 'guard-checked') return LOCKED_RELEASE_STATES.includes(from) ? refuse('locked') : refuse('wrong-state');
      if (!isOneLine(event.decisionFor, MAX_ROLE)) return refuse('decision-for-required');
      if (record.guardCleared !== record.hash) return refuse('stale-version');
      const next: ProductRecord = { ...record, state: 'awaiting-decision', decisionFor: event.decisionFor.trim() };
      return { ok: true, record: next, transitions: [step(next, from, actor, 'submit')] };
    }
    case 'edit': {
      // Detected by hash, whoever made it: the actor is recorded, never checked.
      if (LOCKED_RELEASE_STATES.includes(from)) return refuse('locked');
      if (from !== 'draft' && from !== 'guard-checked' && from !== 'awaiting-decision') return refuse('wrong-state');
      if (!PRODUCT_HASH_PATTERN.test(event.hash)) return refuse('bad-input');
      if (event.hash === record.hash) return refuse('no-change');
      const next = newVersion(record, event.hash);
      return { ok: true, record: next, transitions: [step(next, from, actor, 'edit')] };
    }
    case 'approve': {
      if (from !== 'awaiting-decision') return refuse('wrong-state');
      if (event.hash !== record.hash || record.guardCleared !== record.hash) return refuse('stale-version');
      const person = actor as PersonActor;
      const approved: ProductRecord = { ...record, state: 'approved', approval: { hash: record.hash, by: person } };
      const first = step(approved, from, actor, 'approve');
      if (event.releaseOnApproval !== true) return { ok: true, record: approved, transitions: [first] };
      const released: ProductRecord = { ...approved, state: 'released' };
      return { ok: true, record: released, transitions: [first, step(released, 'approved', actor, 'release')] };
    }
    case 'reject': {
      if (from !== 'awaiting-decision') return refuse('wrong-state');
      if (!validReasons(event.reasons)) return refuse('reasons-required');
      const next: ProductRecord = { ...record, state: 'rejected', rejection: { version: record.version, reasons: [...event.reasons], by: actor as PersonActor } };
      return { ok: true, record: next, transitions: [step(next, from, actor, 'reject', event.reasons)] };
    }
    case 'release': {
      if (from !== 'approved') return refuse('wrong-state');
      if (record.approval === undefined || event.hash !== record.approval.hash || event.hash !== record.hash) return refuse('stale-version');
      const next: ProductRecord = { ...record, state: 'released' };
      return { ok: true, record: next, transitions: [step(next, from, actor, 'release')] };
    }
    case 'supersede': {
      if (from !== 'released') return refuse('wrong-state');
      if (!Number.isSafeInteger(event.byVersion) || event.byVersion <= record.version) return refuse('out-of-order');
      const next: ProductRecord = { ...record, state: 'superseded', supersededBy: event.byVersion };
      return { ok: true, record: next, transitions: [step(next, from, actor, 'supersede')] };
    }
    case 'withdraw': {
      // Withdrawing an approved or released product undoes a person's decision, so only a person may; before that the owner may too.
      const ownerMay = !LOCKED_RELEASE_STATES.includes(from);
      if (actor.kind === 'person' && !isNamedPerson(actor)) return refuse('unnamed-person');
      if (actor.kind === 'agent' && !isAgent(actor, roles.owner)) return refuse('not-owner-or-person');
      if (actor.kind === 'agent' && !ownerMay) return refuse('agent-cannot-decide');
      if (!isOneLine(event.reason, MAX_REASON)) return refuse('reasons-required');
      const next: ProductRecord = { ...record, state: 'withdrawn', withdrawal: { reason: event.reason, by: actor } };
      return { ok: true, record: next, transitions: [step(next, from, actor, 'withdraw', [event.reason])] };
    }
    default:
      return refuse('bad-input');
  }
}

/** Plays a list of steps from the first version, stopping at the first refusal. For tests, replays from the decision log, and the playground fixtures. */
export function replay(identity: ProductIdentity, first: { readonly actor: StaffActor; readonly hash: string }, steps: ReadonlyArray<{ readonly event: ReleaseEvent; readonly actor: StaffActor }>): ReleaseResult {
  let result = startProduct(identity, first.actor, first.hash);
  const log: TransitionRecord[] = [];
  for (const next of steps) {
    if (!result.ok) return result;
    log.push(...result.transitions);
    result = transition(result.record, next.event, next.actor);
  }
  if (!result.ok) return result;
  return { ok: true, record: result.record, transitions: [...log, ...result.transitions] };
}

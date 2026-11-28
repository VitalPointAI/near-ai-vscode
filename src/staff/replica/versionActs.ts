import { createHash } from 'node:crypto';
import { applyUpdate, createFoldDoc, docText, snapshotOf } from '../../domain/replica/doc';
import { MAX_DEPS, writerIdOf } from '../../domain/replica/entry';
import type { Actor } from '../../domain/replica/entry';
import type { FoldResult } from '../../domain/replica/fold';
import { MAX_DECISIONS_SEEN, validateVersionsData } from '../../domain/replica/kindSchemas/versions';
import { rosterView } from '../../domain/replica/roster';
import type { RosterState } from '../../domain/replica/roster';
import { deviceAt, memberAt } from '../../domain/replica/rosterMembers';
import { certifiedWriter } from '../../domain/replica/sessionKeys';
import { isOwnerSide, replicaVersionHash, VERSION_REFUSALS } from '../../domain/replica/versions';
import type { Pin, ProductVersions, VersionRecord, VersionRefusalReason, VersionView } from '../../domain/replica/versions';
import { LOCKED_RELEASE_STATES, RELEASE_REFUSALS, TERMINAL_RELEASE_STATES } from '../../domain/staff/release';
import type { GuardVerdict, TradecraftVerdict } from '../../domain/staff/release';
import { cellLabelTexts, proposeVersion } from './labelCells';
import type { SharedProjectHost } from './membership';
import { acceptedUpdates, productOutput } from './productFeed';
import { ReplicaProjectError } from './replicaProject';
import type { ProjectState, ReplicaProject } from './replicaProject';

export const CHANGED_WHILE_DECIDING_TEXT = 'Someone else decided this version while you were deciding. Look again.';

export const VERSION_ACT_WORDS = {
  ...RELEASE_REFUSALS,
  ...VERSION_REFUSALS,
  'agent-cannot-decide': 'Only a named person can take this step.',
  'unsupported-kind': 'This step is unavailable in this version.',
  'hash-mismatch': 'The contents do not match this version.',
  'text-not-in-document': 'The proposed text was never part of this product at the selected point.',
  'pin-above-cell': 'A source product’s label is outside the access allowed for this product.',
  'product-unavailable': 'This product is unavailable for this step.',
  'product-ambiguous': 'More than one shared product has this name. Ask your staff lead to resolve it.',
  'changed-while-deciding': CHANGED_WHILE_DECIDING_TEXT,
  'decision-role-unavailable': 'Nobody who can see this version holds that decision role right now.',
  'too-many-dependencies': 'This version has too many earlier actions to save this step safely.',
  'cannot-write': 'This step could not be saved. Nothing was written.',
  'text-incomplete': 'The text of this product is not complete on this computer yet, so no version was made. Sync, then try again.',
  unchanged: 'The product has not changed since its current version.',
  'header-missing': 'Say what kind of product this is before its first version is proposed.',
  'pin-unknown': 'A product this version depends on has no such version in the shared record.',
  'signer-refused': 'Your key did not sign this change, so nothing was written.'
} as const;

type VersionTarget = { product: string; hash: string };
/** The header and pins default to the newest version's; a first version names at least its kind, profile and level. */
type ProposeInput = { product: string; header?: Record<string, unknown>; pins?: readonly Pin[] };
/** Only `propose` needs more of the shared project than the project itself: the label checks read the scales and the clock. */
type ProposeContext = Omit<SharedProjectHost, 'project'>;
type SubmitInput = VersionTarget & { decisionFor: string };
type DecisionOptions = { stamp?: string; settle?: boolean };
type DecideInput = VersionTarget & DecisionOptions & { outcome: 'approve' | 'reject'; reasons: readonly string[] };
type WithdrawInput = VersionTarget & { reason: string };
type SupersedeInput = VersionTarget & { byHash: string };

export interface VersionRoomActions {
  hash: string;
  number: number;
  submitRoles: string[];
  decision?: { stamp: string; settle: boolean };
}

const REQUIRED_STATE = {
  'version.verdict': undefined,
  'version.submit': 'guard-checked',
  'version.decide': 'awaiting-decision',
  'version.release': 'approved',
  'version.withdraw': undefined,
  'version.supersede': 'released'
} as const;
type VersionAction = keyof typeof REQUIRED_STATE;
const OBSERVED_ACTIONS: Record<VersionAction, readonly string[]> = {
  'version.verdict': ['version.verdict'],
  'version.submit': ['version.verdict', 'version.submit'],
  'version.decide': ['version.verdict', 'version.submit'],
  'version.release': [],
  'version.withdraw': ['version.verdict', 'version.submit'],
  'version.supersede': []
};
type VerdictInput = VersionTarget & { reasons: readonly string[] } &
  ({ gate: 'guard'; verdict: GuardVerdict } | { gate: 'tradecraft'; verdict: TradecraftVerdict });

type Refused = { ok: false; reason: keyof typeof VERSION_ACT_WORDS; message: string };
type Written = { ok: true; hash: string; stream: string };

function refuse(reason: Refused['reason']): Refused {
  return { ok: false, reason, message: VERSION_ACT_WORDS[reason] };
}

const products = (fold: FoldResult): ProductVersions[] => (fold.families.versions as ProductVersions[] | undefined) ?? [];
const namedProducts = (fold: FoldResult, projectId: string, product: string): ProductVersions[] =>
  products(fold).filter((item) => item.product === product && item.stream !== projectId);

/** Captures the decision view of this version without including unrelated edits or changes elsewhere in the product. */
export function decisionStamp(product: ProductVersions, version: VersionView): string {
  const { state, decisionFor, decision } = version;
  return createHash('sha256').update(JSON.stringify([
    product.stream, product.product, version.entry, version.hash, state, decisionFor,
    decision.status, decision.outcome, decision.effective, decision.contested, decision.pending, decision.held,
    decision.finalBeforeDispute
  ])).digest('hex');
}

/** Look up the exact version in an already verified shared fold. */
export function decisionStampAt(fold: FoldResult, projectId: string, input: VersionTarget): string | undefined {
  const candidates = namedProducts(fold, projectId, input.product);
  if (candidates.length !== 1) return undefined;
  const [product] = candidates;
  const version = product.versions.find((item) => item.hash === input.hash);
  return version === undefined ? undefined : decisionStamp(product, version);
}

function checkWrite(fold: FoldResult, stream: string, product: string, entry: string): Refused | undefined {
  const output = products(fold).find((item) => item.stream === stream && item.product === product);
  if (output === undefined) return refuse('cannot-write');
  const problem = output.refusals.find((item) => item.entry === entry);
  if (problem !== undefined) return refuse(problem.reason);
  const reduced = fold.refused.find((item) => item.family === 'versions' && item.hash === entry)?.reason;
  if (reduced !== undefined && Object.hasOwn(VERSION_REFUSALS, reduced)) return refuse(reduced as VersionRefusalReason);
  return fold.applied.includes(entry) ? undefined : refuse('cannot-write');
}

/** The newest version of a product, by number. */
const newest = (product: ProductVersions): VersionView | undefined =>
  product.versions.reduce<VersionView | undefined>((best, item) => (best === undefined || item.number > best.number ? item : best), undefined);

/** The one shared product of this name, or the refusal that says why there is none. */
export function sharedProductOf(fold: FoldResult, projectId: string, product: string): ProductVersions | Refused {
  const candidates = namedProducts(fold, projectId, product);
  if (candidates.length === 0) return refuse('product-unavailable');
  return candidates.length > 1 ? refuse('product-ambiguous') : candidates[0];
}

const DECISION_ROLE = 'decision_for:';

function submitRoles(roster: RosterState, product: ProductVersions, version: VersionRecord, actor: Actor, writer: string): string[] | Refused {
  if (version.release.state !== 'guard-checked' || version.release.guardCleared !== version.hash) return refuse('wrong-state');
  const position = roster.positions.length - 1;
  const head = roster.positions[position];
  const view = rosterView(roster);
  const device = certifiedWriter(view, writer, head)?.device ?? writer;
  const person = deviceAt(roster.members, device, position);
  if (actor.kind !== 'person' || person?.kind !== 'person' ||
    !isOwnerSide({ actor, member: person.member, writer, roster: head }, product.section, [version.roles.owner, version.roles.sectionLead], view)) {
    return refuse('not-owner-or-lead');
  }
  const grantees = view.cellGrantees?.(product.stream, head) ?? [];
  if (!grantees.includes(device)) return refuse('cannot-write');
  const roles = new Set<string>();
  for (const grantee of grantees) {
    const reader = deviceAt(roster.members, grantee, position);
    if (reader?.kind !== 'person') continue;
    for (const role of memberAt(roster.members, reader.member, position)?.roles ?? []) {
      if (role.startsWith(DECISION_ROLE)) roles.add(role.slice(DECISION_ROLE.length));
    }
  }
  return [...roles].sort();
}

function decisionReady(version: VersionView | undefined, settle: boolean): version is VersionView {
  return version?.state === 'awaiting-decision' && version.decision.status === (settle ? 'contested' : 'none') &&
    version.decision.pending.length === 0 && version.decision.held.length === 0;
}

function holdsDecisionRole(roster: RosterState, writer: string, role: string | undefined): boolean {
  const position = roster.positions.length - 1;
  const person = deviceAt(roster.members, writer, position);
  return role !== undefined && person?.kind === 'person' &&
    rosterView(roster).hasRole(person.member, DECISION_ROLE + role, roster.positions[position]);
}

/** Signed actions on the shared version record. The same fold judges local and received writes. */
export class VersionActs {
  public constructor(private readonly project: ReplicaProject, private readonly actor: Actor, private readonly context?: ProposeContext) {}

  /**
   * Proposes the product's live text as a new version: the text the fold accepted, rebuilt from its accepted updates on this computer and never
   * read from the file on disk. A text this device cannot rebuild whole is refused rather than proposed in part.
   */
  public async propose(input: ProposeInput): Promise<(Written & { version: string }) | Refused> {
    if (this.context === undefined) return refuse('cannot-write');
    const { fold } = await this.project.state();
    const product = sharedProductOf(fold, this.project.projectId, input.product);
    if ('ok' in product) return product;
    const output = productOutput(fold, product.stream, product.product);
    if (output === undefined || output.incomplete || output.problem !== undefined) return refuse('text-incomplete');
    const feed = await acceptedUpdates(this.project, product.stream, product.product);
    const doc = createFoldDoc();
    if (feed.updates.length !== output.accepted.length || !feed.updates.every((update) => applyUpdate(doc, update.bytes))) return refuse('text-incomplete');
    const text = docText(doc);
    if (text !== output.text) return refuse('text-incomplete');
    const previous = newest(product);
    const label = previous?.header.label ?? (await cellLabelTexts(this.project)).get(product.stream);
    const header: Record<string, unknown> = { ...(label === undefined ? {} : { label }), ...previous?.header, ...input.header };
    if (!['kind', 'label', 'profile', 'level'].every((key) => typeof header[key] === 'string')) return refuse('header-missing');
    const pins = input.pins ?? previous?.pins ?? [];
    if (previous !== undefined && previous.hash === replicaVersionHash(text, pins)) return refuse('unchanged');
    const proposed = await proposeVersion({ project: this.project, ...this.context }, {
      product: product.product, text, header, pins, snapshot: snapshotOf(doc), actor: { ...this.actor }
    });
    if (!proposed.ok) return Object.hasOwn(VERSION_ACT_WORDS, proposed.reason) ? refuse(proposed.reason as Refused['reason']) : { ok: false, reason: 'cannot-write', message: proposed.message };
    return { ok: true, hash: proposed.hash, stream: proposed.stream, version: proposed.version };
  }

  public async decisionStamp(input: VersionTarget): Promise<string | undefined> {
    const { fold } = await this.project.state();
    return decisionStampAt(fold, this.project.projectId, input);
  }

  /** Native actions for the exact versions in an already verified project state. */
  public roomActions({ fold, roster }: ProjectState, name: string): VersionRoomActions[] {
    if (this.actor.kind !== 'person') return [];
    const product = sharedProductOf(fold, this.project.projectId, name);
    if ('ok' in product) return [];
    const submitWriter = writerIdOf(this.project.signerOf('version.submit').publicKey);
    const decisionWriter = writerIdOf(this.project.signerOf('version.decide').publicKey);
    const actions: VersionRoomActions[] = [];
    for (const version of product.versions) {
      const { hash, number } = version;
      const record = product.records.find((item) => item.hash === hash);
      if (record === undefined) continue;
      const choices = submitRoles(roster, product, record, this.actor, submitWriter);
      if (Array.isArray(choices) && choices.length > 0) {
        actions.push({ hash, number, submitRoles: choices });
      }
      const settle = version.decision.status === 'contested';
      if (decisionReady(version, settle) && holdsDecisionRole(roster, decisionWriter, version.decisionFor)) {
        actions.push({ hash, number, submitRoles: [], decision: { stamp: decisionStamp(product, version), settle } });
      }
    }
    return actions;
  }

  public async verdict(input: VerdictInput): Promise<Written | Refused> {
    const data = { product: input.product, hash: input.hash, gate: input.gate, verdict: input.verdict, reasons: input.reasons };
    if (validateVersionsData('version.verdict', data, 'verdict') !== undefined) return refuse('bad-input');
    return this.write('version.verdict', { ...data, reasons: [...data.reasons] });
  }

  public async submit(input: SubmitInput): Promise<Written | Refused> {
    return this.submitVersion(input, false);
  }

  public async submitForRosterRole(input: SubmitInput): Promise<Written | Refused> {
    return this.submitVersion(input, true);
  }

  private async submitVersion(input: SubmitInput, forRosterRole: boolean): Promise<Written | Refused> {
    const data = { product: input.product, hash: input.hash, decisionFor: input.decisionFor };
    if (validateVersionsData('version.submit', data, 'submit') !== undefined) return refuse('bad-input');
    return this.write('version.submit', data, { forRosterRole });
  }

  public async decide(input: DecideInput): Promise<Written | Refused> {
    if (this.actor.kind !== 'person') return refuse('agent-cannot-decide');
    if (input.outcome !== 'approve' && input.outcome !== 'reject') return refuse('bad-input');
    const data = { product: input.product, hash: input.hash, outcome: input.outcome, reasons: input.reasons, decisionsSeen: [] };
    if (validateVersionsData('version.decide', data, 'decision') !== undefined) return refuse('bad-input');
    return this.write('version.decide', { ...data, reasons: [...data.reasons] }, { stamp: input.stamp, settle: input.settle });
  }

  public async release(input: VersionTarget): Promise<Written | Refused> {
    if (this.actor.kind !== 'person') return refuse('agent-cannot-decide');
    const data = { product: input.product, hash: input.hash, decisionsSeen: [] };
    if (validateVersionsData('version.release', data, 'release') !== undefined) return refuse('bad-input');
    return this.write('version.release', data);
  }

  public async withdraw(input: WithdrawInput): Promise<Written | Refused> {
    if (this.actor.kind !== 'person') return refuse('agent-cannot-decide');
    const data = { product: input.product, hash: input.hash, reason: input.reason, decisionsSeen: [] };
    if (validateVersionsData('version.withdraw', data, 'withdrawal') !== undefined) return refuse('bad-input');
    return this.write('version.withdraw', data);
  }

  public async supersede(input: SupersedeInput): Promise<Written | Refused> {
    if (this.actor.kind !== 'person') return refuse('agent-cannot-decide');
    const data = { product: input.product, hash: input.hash, byHash: input.byHash };
    if (validateVersionsData('version.supersede', data, 'supersession') !== undefined) return refuse('bad-input');
    return this.write('version.supersede', data);
  }

  private async write(kind: VersionAction, data: VersionTarget & Record<string, unknown>, options: DecisionOptions & { forRosterRole?: boolean } = {}): Promise<Written | Refused> {
    const actor = { ...this.actor };
    const observed = OBSERVED_ACTIONS[kind];
    // The person key signs a decision when the project has a person signer (D-60: isPersonKeyKind in signerOf); its own earlier acts are on its chain.
    const signer = this.project.signerOf(kind);
    const signing = writerIdOf(signer.publicKey);
    try {
      const written = await this.project.appendChecked<Refused>(({ fold, roster }) => {
        const candidates = namedProducts(fold, this.project.projectId, data.product);
        if (candidates.length === 0) return refuse('product-unavailable');
        if (candidates.length > 1) return refuse('product-ambiguous');
        const [product] = candidates;
        const version = product.records.find((item) => item.hash === data.hash);
        if (version === undefined) return refuse('stale-version');
        const view = product.versions.find((item) => item.hash === data.hash);
        if (options.stamp !== undefined && (view === undefined || options.stamp !== decisionStamp(product, view))) return refuse('changed-while-deciding');
        const { state } = version.release;
        const required = REQUIRED_STATE[kind];
        if (kind === 'version.withdraw' && TERMINAL_RELEASE_STATES.includes(state)) return refuse('terminal');
        if (required !== undefined && state !== required) {
          if (TERMINAL_RELEASE_STATES.includes(state)) return refuse('terminal');
          if (kind === 'version.release' && state !== 'released') return refuse('no-approval');
          if (kind === 'version.supersede') return refuse('no-release');
          return refuse(kind === 'version.submit' && LOCKED_RELEASE_STATES.includes(state) ? 'locked' : 'wrong-state');
        }
        if (options.forRosterRole === true) {
          const choices = submitRoles(roster, product, version, actor, signing);
          if (!Array.isArray(choices)) return choices;
          if (typeof data.decisionFor !== 'string' || !choices.includes(data.decisionFor)) return refuse('decision-role-unavailable');
        }
        const decision = view?.decision;
        let decisionsSeen: string[] = [];
        if (kind === 'version.decide') {
          if (!decisionReady(view, options.settle === true)) return refuse('wrong-state');
          if (options.stamp !== undefined && !holdsDecisionRole(roster, signing, view.decisionFor)) return refuse('not-decision-holder');
          if (options.settle === true) decisionsSeen = [...view.decision.contested];
        }
        const additionalDeps: string[] = [];
        if (kind === 'version.release') {
          if (decision?.status !== 'effective' || decision.outcome !== 'APPROVE' || decision.effective.length === 0) return refuse('no-approval');
          if (decision.pending.length > 0 || decision.held.length > 0) return refuse('wrong-state');
          decisionsSeen = [...decision.effective].sort();
        }
        if (kind === 'version.withdraw' || kind === 'version.supersede') {
          // These ordinary actions must not resolve a dispute or confirm a pending decision implicitly.
          if (decision === undefined || decision.status === 'contested' || decision.pending.length > 0 || decision.held.length > 0) return refuse('wrong-state');
          decisionsSeen = [...decision.effective].sort();
        }
        if (kind === 'version.supersede') {
          const replacement = product.versions.find((item) => item.hash === data.byHash);
          if (replacement === undefined) return refuse('stale-version');
          if (replacement.number <= version.number) return refuse('out-of-order');
          if (replacement.state !== 'released' || replacement.decision.status !== 'effective' ||
            replacement.decision.pending.length > 0 || replacement.decision.held.length > 0) return refuse('not-released');
          additionalDeps.push(...replacement.decision.effective);
        }
        const writesDecisionsSeen = kind === 'version.decide' || kind === 'version.release' || kind === 'version.withdraw';
        if (writesDecisionsSeen && decisionsSeen.length > MAX_DECISIONS_SEEN) return refuse('too-many-dependencies');
        const refused = new Set(product.refusals.map((item) => item.entry));
        // A settlement observes conflicts through decisionsSeen, whose limit is independent of the signed entry's causal dependency cap.
        const seen = new Set(options.settle === true ? [] : decisionsSeen);
        // A release observes approvals, and a supersession observes both releases. Those actions already cite their gates and submissions.
        // This writer's stream head already cites its own actions on the version.
        const prior = version.acts.filter((act) =>
          (observed.includes(act.kind) || seen.has(act.entry)) && !refused.has(act.entry) && act.writer !== signing);
        const deps = [...new Set([version.entry, ...prior.map((act) => act.entry), ...additionalDeps])];
        if (deps.length > MAX_DEPS) return refuse('too-many-dependencies');
        return {
          kind, data: writesDecisionsSeen ? { ...data, decisionsSeen } : data, options: { stream: product.stream, actor, deps, signer },
          check: (preview, hash) => checkWrite(preview, product.stream, product.product, hash)
        };
      });
      // A refusal from the person's key store (a step-up that did not happen) reaches the person in its own words.
      if ('refused' in written) return written.refused === 'signer-refused' ? { ok: false, reason: 'signer-refused', message: written.message } : refuse('cannot-write');
      if (!written.ok) return written;
      return { ok: true, hash: written.hash, stream: written.built.entry.header.stream };
    } catch (error) {
      if (error instanceof ReplicaProjectError) return refuse('cannot-write');
      throw error;
    }
  }
}

// ---- The staff host's shared branch (D-41, F3) ---------------------------------------------------------------------------------------------------
// StaffHost's propose, verdict, submit, withdraw and decide hand a shared project to sharedHostAct in one line, so the frozen host keeps one write path
// per kind of project. Nothing here writes the single-machine ledgers or staff files: the shared record is the history, and the projection writes files.

type HostResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };
type HostDependency = { readonly product: string; readonly version: number };
type HostScan = { result: { hold: boolean }; hash: string } | HostResult;
type HostLint = { findings: readonly unknown[]; hash: string } | HostResult;

/** The parts of StaffHost the shared branch uses: the one opened shared project, and the mechanical checks a gate verdict runs on the product file. */
export interface SharedActHost<C> {
  sharedReplica(): Promise<{ readonly project: ReplicaProject; readonly context: ProposeContext } | undefined>;
  scan(caller: C, product: string): Promise<HostScan>;
  lint(caller: C, product: string): Promise<HostLint>;
  replay(): Promise<{ products: ReadonlyMap<string, { record: { version: number; hash: string } }> }>;
}

export type SharedHostCall<C extends { readonly run: string }> =
  | { act: 'propose'; caller: C; member: string; input: { product: string; kind?: string; label?: string; dependsOn?: readonly HostDependency[] }; defaults: { profile: string; level: string } }
  | { act: 'verdict'; caller: C; member: string; input: { product: string; gate: 'guard' | 'tradecraft'; verdict: string; hash: string; reasons: readonly string[] } }
  | { act: 'submit'; caller: C; member: string; input: { product: string; decisionFor: string } }
  | { act: 'withdraw'; caller: C; member: string; input: { product: string; reason: string } }
  | { act: 'decide'; person: { readonly name: string; readonly role: string }; input: { product: string; action: 'approve' | 'reject' | 'release' | 'withdraw'; hash?: string; reasons?: readonly string[]; releaseOnApproval?: boolean; stamp?: string; settle?: boolean } };

const hostRefused = (message: string): HostResult => ({ ok: false, message });
const STATE_WORDS: Partial<Record<VersionView['state'], string>> = { 'awaiting-decision': 'awaiting a decision' };
const stateWord = (view: VersionView): string => STATE_WORDS[view.state] ?? view.state;

/** The named version of a product as the fold has it now. */
async function viewOf(project: ReplicaProject, product: string, hash: string): Promise<VersionView | undefined> {
  const found = sharedProductOf((await project.state()).fold, project.projectId, product);
  return 'ok' in found ? undefined : found.versions.find((item) => item.hash === hash);
}

/** A product's newest version in the shared record, or the refusal. */
async function newestOf(project: ReplicaProject, product: string): Promise<VersionView | Refused> {
  const found = sharedProductOf((await project.state()).fold, project.projectId, product);
  if ('ok' in found) return found;
  return newest(found) ?? refuse('stale-version');
}

/** The pins of `dependsOn` (product and version number) as exact version hashes from the shared record. */
async function pinsOf(project: ReplicaProject, dependsOn: readonly HostDependency[]): Promise<Pin[] | undefined> {
  const { fold } = await project.state();
  const pins: Pin[] = [];
  for (const dependency of dependsOn) {
    const source = sharedProductOf(fold, project.projectId, dependency.product);
    const pinned = 'ok' in source ? undefined : source.versions.find((item) => item.number === dependency.version);
    if (pinned === undefined) return undefined;
    pins.push({ product: dependency.product, hash: pinned.hash });
  }
  return pins;
}

/**
 * Runs a staff host write of a shared project through VersionActs. `refusal` is what the host would refuse with; a project that cannot even be checked,
 * or that is shared but not open on this computer, keeps it and nothing is written.
 */
export async function sharedHostAct<C extends { readonly run: string }>(host: SharedActHost<C>, refusal: HostResult, sharedRefusal: string, call: SharedHostCall<C>): Promise<HostResult> {
  if (refusal.ok || refusal.message !== sharedRefusal) return refusal;
  const replica = await host.sharedReplica();
  if (replica === undefined) return refusal;
  const { project } = replica;
  const actor: Actor = call.act === 'decide' ? { kind: 'person' } : { kind: 'agent', member: call.member, run: call.caller.run };
  const acts = new VersionActs(project, actor, replica.context);
  const { product } = call.input;
  const said = async (result: Written | Refused, hash: string, say: (view: VersionView) => string): Promise<HostResult> => {
    if (!result.ok) return hostRefused(result.message);
    const view = await viewOf(project, product, hash);
    return { ok: true, text: view === undefined ? `${product}: recorded in the shared record.` : say(view) };
  };
  if (call.act === 'propose') {
    const { input } = call;
    const pins = input.dependsOn === undefined ? undefined : await pinsOf(project, input.dependsOn);
    if (input.dependsOn !== undefined && pins === undefined) return hostRefused(VERSION_ACT_WORDS['pin-unknown']);
    const first = 'ok' in await newestOf(project, product) ? call.defaults : {};
    const header = { ...first, ...(input.kind === undefined ? {} : { kind: input.kind }), ...(input.label === undefined ? {} : { label: input.label }) };
    const proposed = await acts.propose({ product, header, ...(pins === undefined ? {} : { pins }) });
    if (!proposed.ok) return hostRefused(proposed.message);
    return said(proposed, proposed.version, (view) => `${product} version ${view.number} recorded in the shared record. Version hash ${view.hash}. Next: the release-guard checks this exact version.`);
  }
  if (call.act === 'verdict') {
    const { input } = call;
    // A gate's mechanical check reads the product file, so it counts only when that file is exactly the version named (its projected number and hash).
    if (input.gate === 'guard' ? input.verdict === 'CLEARED' : input.verdict === 'SIGN-OFF') {
      const view = await viewOf(project, product, input.hash);
      if (view === undefined) return hostRefused(VERSION_ACT_WORDS['stale-version']);
      const checked = input.gate === 'guard' ? await host.scan(call.caller, product) : await host.lint(call.caller, product);
      if ('ok' in checked) return checked;
      const projected = (await host.replay()).products.get(product)?.record;
      if (projected?.version !== view.number || checked.hash !== projected.hash) {
        return hostRefused(`${input.verdict} is refused: the product file on this computer is not version ${view.number}. Sync, then check it again.`);
      }
      if ('result' in checked && checked.result.hold) return hostRefused('CLEARED is refused: guard-scan holds this version.');
      if ('findings' in checked && checked.findings.length > 0) return hostRefused('SIGN-OFF is refused: the tradecraft lint has findings on this version.');
    }
    const reasons = input.reasons.map((reason) => reason.trim()).filter(Boolean);
    const written = await acts.verdict({ product, hash: input.hash, gate: input.gate, verdict: input.verdict, reasons } as VerdictInput);
    return said(written, input.hash, (view) => `${input.verdict} recorded on ${product} version ${view.number}; it is now ${stateWord(view)}${view.held ? ' (held)' : ''}.`);
  }
  if (call.act === 'submit' || call.act === 'withdraw') {
    const latest = await newestOf(project, product);
    if ('ok' in latest) return hostRefused(latest.message);
    const target = { product, hash: latest.hash };
    if (call.act === 'withdraw') return said(await acts.withdraw({ ...target, reason: call.input.reason }), latest.hash, (view) => `${product} version ${view.number} is withdrawn.`);
    const { decisionFor } = call.input;
    return said(await acts.submit({ ...target, decisionFor }), latest.hash, (view) =>
      `${product} version ${view.number} is awaiting a decision by the ${decisionFor}. Only that person can approve or reject it; nothing past this point is an agent's to do. Carry on with work that does not depend on the decision.`);
  }
  const { input, person } = call;
  const reasons = (input.reasons ?? []).map((reason) => reason.trim()).filter(Boolean);
  const by = (view: VersionView): string => `${product} version ${view.number} is now ${stateWord(view)}, by ${person.name} (${person.role}).`;
  // An approval or a release names the version the person saw; only a rejection or a withdrawal may take the newest version.
  let hash = input.hash ?? '';
  if (hash === '') {
    if (input.action === 'approve' || input.action === 'release') return hostRefused(VERSION_ACT_WORDS['stale-version']);
    const latest = await newestOf(project, product);
    if ('ok' in latest) return hostRefused(latest.message);
    hash = latest.hash;
  }
  const target = { product, hash };
  const options = { ...(input.stamp === undefined ? {} : { stamp: input.stamp }), ...(input.settle === true ? { settle: true } : {}) };
  if (input.action === 'withdraw') return said(await acts.withdraw({ ...target, reason: reasons.join('; ') }), hash, by);
  if (input.action !== 'release') {
    const decided = await acts.decide({ ...target, outcome: input.action, reasons, ...options });
    if (!decided.ok || input.action === 'reject' || input.releaseOnApproval !== true) return said(decided, hash, by);
  }
  const released = await acts.release(target);
  if (!released.ok) return input.action === 'release' ? hostRefused(released.message) : said({ ok: true, hash, stream: '' }, hash, (view) => `${by(view)} ${released.message}`);
  // A release supersedes each older released version of the product, as on a single machine.
  const found = sharedProductOf((await project.state()).fold, project.projectId, product);
  const current = 'ok' in found ? undefined : found.versions.find((item) => item.hash === hash);
  const older = 'ok' in found || current === undefined ? [] : found.versions.filter((item) => item.state === 'released' && item.number < current.number);
  for (const line of older) {
    const superseded = await acts.supersede({ product, hash: line.hash, byHash: hash });
    if (!superseded.ok) return said(released, hash, (view) => `${by(view)} Version ${line.number} stays released: ${superseded.message}`);
  }
  return said(released, hash, by);
}

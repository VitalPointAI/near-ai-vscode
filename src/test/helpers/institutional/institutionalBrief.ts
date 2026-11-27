import { canonicalBytes } from '../../../domain/team/canonical';
import { verifyPayload, type PayloadSignerRef } from '../../../domain/team/signedPayload';
import { STAFF_SLUG } from '../../../domain/staff/parse';
import {
  canonicalDigest, catalogueId, institutionalBriefDigest, institutionalBriefMaxBytes, institutionalSourceHash,
  list, metadataDate, metadataSource, record, requestedCatalogueRows, requireCatalogue, sourceReferences, text,
  type InstitutionalCatalogueSource,
} from './institutionalEvidence';
import type { InstitutionalBudgetEvidence, InstitutionalBudgetReview, InstitutionalInventoryEvidence, InstitutionalInventoryReview } from './institutionalReconciliation';

import type { InstitutionalAccessibilityEvidence, InstitutionalAccessibilityReview } from './institutionalAccessibilityReview';
import type { InstitutionalServiceMonitoringEvidence, InstitutionalServiceMonitoringReview } from './institutionalServiceMonitoring';

export {
  institutionalBriefDigest, institutionalBriefMaxBytes, institutionalCatalogueUnavailable, institutionalSourceHash, isInstitutionalCatalogueRecordId,
} from './institutionalEvidence';

export const institutionalBriefDirectory = '.planning/staff/institutional/command/briefs';
export const institutionalActionRegisterDirectory = '.planning/staff/institutional/j3/action-registers';
export const institutionalObservationDirectory = '.planning/staff/institutional/j7/observations';
export const institutionalLibraryRemitsDirectory = '.planning/staff/institutional/j9/service-remits';
export const institutionalPlanningDirectory = '.planning/staff/institutional/j5/evidence-assumptions';
export const institutionalBusinessServicesDirectory = '.planning/staff/institutional/j6/business-services';
export const institutionalCatalogueDirectory = '.planning/staff/institutional/j2/catalogue';
export const institutionalFindingsDirectory = '.planning/staff/institutional/j7/after-action';

export interface InstitutionalBriefSource {
  readonly id: string;
  readonly revision: string;
  readonly date: string;
  readonly label: 'org/Public';
  readonly project: string;
  readonly text: string;
  readonly spans: readonly { readonly start: number; readonly end: number }[];
  readonly dissentAttribution?: string;
}

export interface InstitutionalBriefBinding {
  readonly project: string;
  readonly directory: string;
  readonly team: string;
  readonly teamVersion: string;
  readonly skillVersion: string;
}

export interface InstitutionalDraftScope {
  readonly root: string;
  readonly binding: InstitutionalBriefBinding;
  readonly bindingIsCurrent: () => Promise<boolean>;
  readonly stagedIsCurrent: () => boolean;
  readonly currentSources: () => readonly InstitutionalBriefSource[];
  readonly withStableParents: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly actionRegister?: {
    readonly predecessorCurrent: () => Promise<boolean>;
    readonly predecessorFacts: () => boolean;
    /** Called with the fixture interlock held immediately before a J3 effect. */
    readonly predecessorAtEffect: (version: string) => boolean;
    readonly current: () => InstitutionalActionAcceptance;
  };
  readonly observation?: {
    readonly current: () => InstitutionalObservationEvidence;
    /** Called with the fixture interlock held immediately before a J7 effect. */
    readonly correctionAtEffect: (correction: InstitutionalObservationCorrection | null) => boolean;
  };
  readonly catalogue?: () => InstitutionalCatalogueEvidence;
  readonly businessServices?: () => InstitutionalBusinessServicesEvidence;
  readonly planningEvidence?: () => InstitutionalPlanningEvidence;
  readonly libraryRemits?: () => InstitutionalLibraryRemitEvidence;
  readonly inventory?: () => InstitutionalInventoryEvidence;
  readonly budget?: () => InstitutionalBudgetEvidence;
  readonly serviceMonitoring?: () => InstitutionalServiceMonitoringEvidence;
  readonly accessibility?: () => InstitutionalAccessibilityEvidence;
  readonly findings?: {
    readonly current: () => InstitutionalFindingsEvidence;
    readonly predecessorCurrent: () => Promise<boolean>;
    /** Called with the fixture interlock held immediately before a J7-10 effect. */
    readonly predecessorAtEffect: (version: string) => boolean;
  };
}

interface InstitutionalCitation {
  readonly sourceId: string;
  readonly revision: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

export interface InstitutionalBriefReview {
  readonly project: string;
  readonly directory: string;
  readonly team: string;
  readonly teamVersion: string;
  readonly skillVersion: string;
  readonly duty: 'CG-07';
  readonly echelon: 'L3';
  readonly kind: 'brief';
  readonly productId: string;
  readonly version: string;
  readonly sources: readonly { readonly id: string; readonly revision: string; readonly date: string; readonly label: 'org/Public'; readonly hash: string }[];
}

export interface InstitutionalActionRegisterReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J3-07';
  readonly kind: 'action-register';
  readonly predecessor: InstitutionalActionPredecessor;
}

export interface InstitutionalObservationReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J7-09';
  readonly kind: 'observation';
  readonly access: 'org/Public';
  readonly correction: InstitutionalObservationCorrection | null;
}

export interface InstitutionalFindingsReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J7-10';
  readonly kind: 'findings';
  readonly observation: InstitutionalFindingsEvidence['observation'];
  readonly objective: InstitutionalFindingsEvidence['objective'];
  readonly evidenceDigest: string;
  readonly validation: 'open';
  readonly release: 'disabled';
  readonly owner: string;
  readonly reasoningReview: { readonly person: string; readonly state: 'pending' };
  readonly requiredApproval: InstitutionalFindingsEvidence['approver'];
}

interface InstitutionalCatalogueReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J2-IS01';
  readonly kind: 'records-catalogue';
  readonly policyRevision: string;
  readonly scopeDigest: string;
  readonly steward: InstitutionalCatalogueSource;
  readonly stewardship: 'pending';
}

interface InstitutionalBusinessServicesReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J6-IT01';
  readonly kind: 'business-services';
  readonly policyRevision: string;
  readonly scopeDigest: string;
  readonly portfolioOwner: InstitutionalCatalogueSource;
  readonly portfolioDecision: 'pending';
}

interface InstitutionalPlanningReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J5-03';
  readonly kind: 'planning-evidence';
  readonly policyRevision: string;
  readonly scopeDigest: string;
  readonly sourceCutoff: string;
  readonly planOwner: InstitutionalCatalogueSource;
  readonly planDecision: 'pending';
}

interface InstitutionalLibraryRemitReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J9-CL02';
  readonly kind: 'library-service-remits';
  readonly policyRevision: string;
  readonly scopeDigest: string;
  readonly liaisonLead: InstitutionalCatalogueSource;
  readonly liaisonDecision: 'pending';
}

export type InstitutionalDraftReview = InstitutionalAccessibilityReview | InstitutionalServiceMonitoringReview | InstitutionalBudgetReview | InstitutionalInventoryReview | InstitutionalLibraryRemitReview | InstitutionalPlanningReview | InstitutionalBusinessServicesReview | InstitutionalCatalogueReview | InstitutionalBriefReview | InstitutionalActionRegisterReview | InstitutionalObservationReview | InstitutionalFindingsReview;

export interface PreparedInstitutionalDraft {
  readonly path: string;
  readonly text: string;
  readonly review: InstitutionalDraftReview;
}

export interface PreparedInstitutionalBrief extends PreparedInstitutionalDraft {
  readonly path: string;
  readonly text: string;
  readonly review: InstitutionalBriefReview;
}

/** Trait checks are limited to the admitted fictional public scope of this tracer. */
export function validateInstitutionalBriefSource(source: InstitutionalBriefSource, project: string): boolean {
  return source.project === project && source.label === 'org/Public' && STAFF_SLUG.test(source.id) &&
    typeof source.revision === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(source.revision) &&
    typeof source.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.date) && Number.isFinite(Date.parse(source.date)) &&
    new Date(source.date).toISOString().slice(0, 10) === source.date &&
    typeof source.text === 'string' && source.text.length > 0 && source.text.length <= 4000 &&
    (source.dissentAttribution === undefined || (typeof source.dissentAttribution === 'string' && source.dissentAttribution.trim().length > 0 && source.dissentAttribution.length <= 100)) &&
    Array.isArray(source.spans) && source.spans.length > 0 && source.spans.length <= 12 &&
    source.spans.every(({ start, end }) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end <= source.text.length && start < end);
}

function admittedCitations(sources: readonly InstitutionalBriefSource[]) {
  const cited = new Map<string, InstitutionalBriefSource>();
  function citation(input: unknown): InstitutionalCitation {
    const { sourceId, revision, start, end, quote } = record(input, ['sourceId', 'revision', 'start', 'end', 'quote']);
    const source = sources.find((entry) => entry.id === sourceId);
    if (!source || source.revision !== revision || !source.spans.some((span) => span.start === start && span.end === end) ||
        source.text.slice(start as number, end as number) !== quote) throw new Error('A citation does not match an admitted source revision and span.');
    cited.set(source.id, source);
    return { sourceId: source.id, revision: source.revision, start: start as number, end: end as number, quote: quote as string };
  }
  return { citation, used: (): InstitutionalBriefReview['sources'] => sourceReferences([...cited.values()]) };
}

/** Prepare a single canonical payload and the exact gate path derived from it. */
export function prepareInstitutionalBrief(input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[]): PreparedInstitutionalBrief {
  const value = record(input, ['productId', 'decisionRequested', 'facts', 'alternatives', 'assumptions', 'dissent', 'dependencies']);
  if (typeof value.productId !== 'string' || !STAFF_SLUG.test(value.productId)) throw new Error('The decision brief needs a stable product identifier.');
  const { citation, used } = admittedCitations(sources);
  const fact = (entry: unknown) => {
    const item = record(entry, ['text', 'evidence']);
    return { text: text(item.text), evidence: list(item.evidence, citation, 1) };
  };
  const dissent = list(value.dissent, (entry) => {
    const item = record(entry, ['attribution', 'text', 'evidence']);
    return { attribution: text(item.attribution, 100), text: text(item.text), evidence: list(item.evidence, citation, 1) };
  });
  for (const source of sources) {
    if (source.dissentAttribution !== undefined && !dissent.some((entry) => entry.attribution === source.dissentAttribution &&
        entry.evidence.some((evidence) => evidence.sourceId === source.id))) throw new Error('The brief must preserve attributed disagreement from the admitted evidence.');
  }
  const body = {
    decisionRequested: text(value.decisionRequested), facts: list(value.facts, fact, 1),
    alternatives: list(value.alternatives, (entry) => text(entry), 2),
    assumptions: list(value.assumptions, (entry) => text(entry)), dissent,
    dependencies: list(value.dependencies, (entry) => text(entry)),
  };
  const identity = { ...binding, duty: 'CG-07' as const, echelon: 'L3' as const, kind: 'brief' as const, productId: value.productId, sources: used() };
  const bytes = canonicalBytes({ schema: 1, ...identity, body });
  if (bytes.length > institutionalBriefMaxBytes) throw new Error('The canonical decision brief exceeds the 128 KiB draft limit.');
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalBriefDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}

const actionPurpose = 'fictional-office-hours-j3-07';
const chairMember = 'fictional-office-chair';

export interface InstitutionalActionAuthority {
  readonly chair: Pick<PayloadSignerRef, 'fingerprint' | 'publicKey'>;
  readonly readPredecessor: () => Promise<InstitutionalBriefReview>;
  readonly current: () => {
    readonly envelope: unknown;
    readonly decisionId: string;
    readonly revision: string;
    readonly state: string;
    readonly roster: InstitutionalActionRoster;
    readonly now: number;
  };
}

interface InstitutionalActionRoster {
  readonly revision: string;
  readonly owners: readonly { readonly actionId: string; readonly owner: string }[];
}

interface InstitutionalActionPredecessor {
  readonly version: string;
  readonly reviewDigest: string;
  readonly decisionId: string;
  readonly revision: string;
  readonly signer: string;
  readonly envelopeDigest: string;
  readonly rosterRevision: string;
}

interface InstitutionalActionRow {
  readonly decisionId: string;
  readonly actionId: string;
  readonly text: string;
  readonly owner: string | null;
  readonly dueDate: string | null;
  readonly acceptanceCriteria: string;
  readonly dependencies: readonly { readonly id: string; readonly crossProgramme: boolean }[];
  readonly exceptions: readonly string[];
  readonly acknowledgments: readonly { readonly owner: string; readonly date: string; readonly evidence: readonly InstitutionalCitation[] }[];
  readonly evidence: readonly InstitutionalCitation[];
}

interface InstitutionalActionRegisterBody {
  readonly asOf: string;
  readonly rows: readonly (InstitutionalActionRow & {
    readonly overdue: boolean | null;
    readonly humanHandoff: { readonly branch: 'J5'; readonly dependencyIds: readonly string[] } | null;
  })[];
}

export interface InstitutionalActionAcceptance {
  readonly predecessor: InstitutionalActionPredecessor;
  readonly asOf: string;
  readonly actions: readonly InstitutionalActionRow[];
}

function requireAction(condition: unknown): asserts condition {
  if (!condition) throw new Error('The office-hours action register does not have current accepted chair evidence.');
}

function slug(value: unknown): string {
  requireAction(typeof value === 'string' && STAFF_SLUG.test(value));
  return value;
}

function revision(value: unknown): string {
  requireAction(typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value));
  return value;
}

function day(value: unknown): string {
  requireAction(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value);
  return value;
}

/** Parse only cited action facts. The verified chair disposition controls the admitted values. */
function actionRow(value: unknown, citation: (value: unknown) => InstitutionalCitation): InstitutionalActionRow {
  const row = record(value, ['decisionId', 'actionId', 'text', 'owner', 'dueDate', 'acceptanceCriteria', 'dependencies', 'exceptions', 'acknowledgments', 'evidence']);
  const owner = row.owner === null ? null : slug(row.owner);
  const dueDate = row.dueDate === null ? null : day(row.dueDate);
  const exceptions = list(row.exceptions, (value) => text(value), owner === null || dueDate === null ? 1 : 0);
  const dependencies = list(row.dependencies, (value) => {
    const dependency = record(value, ['id', 'crossProgramme']);
    requireAction(typeof dependency.crossProgramme === 'boolean');
    return { id: slug(dependency.id), crossProgramme: dependency.crossProgramme };
  });
  requireAction(new Set(dependencies.map(({ id }) => id)).size === dependencies.length);
  const acknowledgments = list(row.acknowledgments, (value) => {
    const acknowledgment = record(value, ['owner', 'date', 'evidence']);
    requireAction(owner !== null && acknowledgment.owner === owner);
    return { owner, date: day(acknowledgment.date), evidence: list(acknowledgment.evidence, citation, 1) };
  });
  return {
    decisionId: slug(row.decisionId), actionId: slug(row.actionId), text: text(row.text), owner, dueDate,
    acceptanceCriteria: text(row.acceptanceCriteria), dependencies, exceptions, acknowledgments, evidence: list(row.evidence, citation, 1),
  };
}

/** Verify the host-owned evidence against the exact reopened predecessor, scope, roster and extracts. */
export function verifyInstitutionalActionAcceptance(
  authority: InstitutionalActionAuthority, brief: InstitutionalBriefReview, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalActionAcceptance {
  requireAction(brief.kind === 'brief' && brief.duty === 'CG-07' && brief.echelon === 'L3' &&
    brief.project === binding.project && brief.directory === binding.directory);
  const live = authority.current();
  requireAction(live.state === 'active' && Number.isSafeInteger(live.now) && Number.isFinite(new Date(live.now).getTime()));
  const envelopeBytes = canonicalBytes(live.envelope);
  requireAction(envelopeBytes.length <= institutionalBriefMaxBytes);
  const verified = verifyPayload(JSON.parse(envelopeBytes.toString('utf8')), {
    purpose: 'staff-decision', maxBytes: institutionalBriefMaxBytes,
    status: (key) => ({ state: key.fingerprint === authority.chair.fingerprint && key.publicKey === authority.chair.publicKey ? 'active' : 'unknown' }),
  });
  requireAction(verified.ok && verified.signer.memberId === chairMember);
  const claim = record(verified.payload, ['schema', 'purpose', 'disposition', 'chair', 'decisionId', 'revision', 'project', 'directory',
    'echelon', 'briefVersion', 'briefReviewDigest', 'expiresAt', 'asOf', 'rosterRevision', 'rosterDigest', 'sourceDigests', 'actions']);
  const reviewDigest = canonicalDigest(brief);
  const decisionId = slug(claim.decisionId);
  const decisionRevision = revision(claim.revision);
  const rosterRevision = revision(claim.rosterRevision);
  const asOf = day(claim.asOf);
  const expiry = typeof claim.expiresAt === 'string' ? Date.parse(claim.expiresAt) : NaN;
  const signedAt = Date.parse(verified.signedAt);
  requireAction(claim.schema === 1 && claim.purpose === actionPurpose && claim.disposition === 'accepted' && claim.chair === chairMember &&
    claim.project === binding.project && claim.directory === binding.directory && claim.echelon === 'L3' &&
    claim.briefVersion === brief.version && claim.briefReviewDigest === reviewDigest && decisionId === live.decisionId && decisionRevision === live.revision &&
    signedAt <= live.now && live.now < expiry && new Date(expiry).toISOString() === claim.expiresAt &&
    asOf <= new Date(live.now).toISOString().slice(0, 10));
  requireAction(rosterRevision === live.roster.revision && claim.rosterDigest === canonicalDigest(live.roster));
  requireAction(canonicalDigest(claim.sourceDigests) === canonicalDigest(sourceReferences(sources).map(({ id, hash }) => ({ id, hash }))));
  const assignments = list(live.roster.owners, (value) => {
    const entry = record(value, ['actionId', 'owner']);
    return { actionId: slug(entry.actionId), owner: slug(entry.owner) };
  });
  const ownerByAction = new Map(assignments.map(({ actionId, owner }) => [actionId, owner]));
  requireAction(ownerByAction.size === assignments.length);
  const { citation } = admittedCitations(sources);
  const actions = list(claim.actions, (value) => actionRow(value, citation), 1);
  requireAction(new Set(actions.map(({ actionId }) => actionId)).size === actions.length &&
    actions.every((row) => row.decisionId === decisionId && row.owner === (ownerByAction.get(row.actionId) ?? null) &&
      row.acknowledgments.every(({ date }) => date <= asOf)) && assignments.every(({ actionId }) => actions.some((row) => row.actionId === actionId)));
  return {
    asOf, actions,
    predecessor: { version: brief.version, reviewDigest, decisionId, revision: decisionRevision,
      signer: verified.signer.fingerprint, envelopeDigest: institutionalBriefDigest(envelopeBytes), rosterRevision },
  };
}

export function prepareInstitutionalActionRegister(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalActionAcceptance,
): PreparedInstitutionalDraft {
  const value = record(input, ['productId', 'rows']);
  const productId = slug(value.productId);
  const { citation, used } = admittedCitations(sources);
  const expected = new Map(accepted.actions.map((row) => [row.actionId, canonicalDigest(row)]));
  const unique = new Map<string, InstitutionalActionRow>();
  for (const row of list(value.rows, (value) => actionRow(value, citation), 1)) {
    requireAction(expected.get(row.actionId) === canonicalDigest(row));
    unique.set(row.actionId, row);
  }
  requireAction(unique.size === expected.size);
  const body: InstitutionalActionRegisterBody = { asOf: accepted.asOf, rows: [...unique.values()].sort((left, right) => left.actionId.localeCompare(right.actionId)).map((row) => {
    const dependencyIds = row.dependencies.filter(({ crossProgramme }) => crossProgramme).map(({ id }) => id);
    return { ...row, overdue: row.dueDate === null ? null : row.dueDate < accepted.asOf,
      humanHandoff: dependencyIds.length ? { branch: 'J5', dependencyIds } : null };
  }) };
  const identity = { ...binding, duty: 'J3-07' as const, echelon: 'L3' as const, kind: 'action-register' as const,
    productId, sources: used(), predecessor: accepted.predecessor };
  const bytes = canonicalBytes({ schema: 1, ...identity, body });
  requireAction(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalActionRegisterDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}

export interface InstitutionalObservationCorrection {
  readonly version: string;
  readonly reason: string;
  readonly evidence: readonly InstitutionalCitation[];
}

interface InstitutionalObservationStatement {
  readonly kind: 'observed' | 'reported' | 'judgment' | 'hypothesis';
  readonly personId: string;
  readonly text: string;
  readonly evidence: readonly InstitutionalCitation[];
}

export interface InstitutionalObservationEvidence {
  readonly project: string;
  readonly directory: string;
  readonly access: 'org/Public';
  readonly productId: string;
  readonly time: string;
  readonly timeKind: 'observed' | 'reported';
  readonly people: readonly { readonly id: string; readonly kind: 'observer' | 'reporter'; readonly sourceIds: readonly string[] }[];
  readonly relatedObservationIds: readonly string[];
  readonly corroborations: readonly InstitutionalObservationStatement[];
  readonly correction: InstitutionalObservationCorrection | null;
}

function requireObservation(condition: unknown): asserts condition {
  if (!condition) throw new Error('The office-hours observation does not match the current admitted fixture evidence.');
}

function observationStatement(
  statement: Record<string, unknown>, people: InstitutionalObservationEvidence['people'],
  citation: (entry: unknown) => InstitutionalCitation,
): InstitutionalObservationStatement {
  const { kind, personId } = statement;
  requireObservation(kind === 'observed' || kind === 'reported' || kind === 'judgment' || kind === 'hypothesis');
  const person = people.find((candidate) => candidate.id === personId);
  const evidence = list(statement.evidence, citation, 1);
  requireObservation(person && (kind !== 'observed' || person.kind === 'observer') && (kind !== 'reported' || person.kind === 'reporter') &&
    evidence.some((source) => person.sourceIds.includes(source.sourceId)));
  const normalized = text(statement.text).normalize('NFC').trim();
  return { kind, personId: person.id, text: text(normalized), evidence };
}

function observationSupportKey({ kind, personId, text, evidence }: InstitutionalObservationStatement): string {
  return canonicalDigest({ kind, personId, text, evidence: evidence.map(canonicalDigest).sort() });
}

export function admittedInstitutionalObservation(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalObservationEvidence {
  const value = record(raw, ['project', 'directory', 'access', 'productId', 'time', 'timeKind', 'people', 'relatedObservationIds', 'corroborations', 'correction']);
  requireObservation(value.project === binding.project && value.directory === binding.directory && value.access === 'org/Public');
  const productId = slug(value.productId);
  const { time, timeKind } = value;
  requireObservation(typeof time === 'string' && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time &&
    (timeKind === 'observed' || timeKind === 'reported'));
  const people = list(value.people, (entry) => {
    const person = record(entry, ['id', 'kind', 'sourceIds']);
    requireObservation(person.kind === 'observer' || person.kind === 'reporter');
    const sourceIds = list(person.sourceIds, slug, 1);
    requireObservation(new Set(sourceIds).size === sourceIds.length && sourceIds.every((id) => sources.some((source) => source.id === id)));
    return { id: slug(person.id), kind: person.kind, sourceIds } as const;
  }, 1);
  requireObservation(new Set(people.map(({ id }) => id)).size === people.length &&
    people.some(({ kind }) => kind === (timeKind === 'observed' ? 'observer' : 'reporter')));
  const relatedObservationIds = list(value.relatedObservationIds, slug);
  requireObservation(new Set(relatedObservationIds).size === relatedObservationIds.length && !relatedObservationIds.includes(productId));
  const { citation } = admittedCitations(sources);
  const corroborations = list(value.corroborations, (entry) => {
    const proof = observationStatement(record(entry, ['kind', 'personId', 'text', 'evidence']), people, citation);
    requireObservation(new Set(proof.evidence.map(({ sourceId }) => sourceId)).size >= 2 &&
      new Set(proof.evidence.map(canonicalDigest)).size === proof.evidence.length);
    return proof;
  });
  requireObservation(new Set(corroborations.map(({ kind, personId, text }) => canonicalDigest({ kind, personId, text }))).size === corroborations.length);
  let correction: InstitutionalObservationCorrection | null = null;
  if (value.correction !== null) {
    const prior = record(value.correction, ['version', 'reason', 'evidence']);
    requireObservation(typeof prior.version === 'string' && /^[a-f0-9]{64}$/.test(prior.version));
    correction = { version: prior.version, reason: text(prior.reason), evidence: list(prior.evidence, citation, 1) };
  }
  return { project: binding.project, directory: binding.directory, access: 'org/Public', productId, time, timeKind,
    people, relatedObservationIds, corroborations, correction };
}

function attributedDissent(
  value: unknown, sources: readonly InstitutionalBriefSource[], citation: (entry: unknown) => InstitutionalCitation,
) {
  const dissent = list(value, (entry) => {
    const objection = record(entry, ['attribution', 'text', 'evidence']);
    const attribution = text(objection.attribution, 100);
    const evidence = list(objection.evidence, citation, 1);
    requireObservation(evidence.some(({ sourceId }) => sources.some((source) => source.id === sourceId && source.dissentAttribution === attribution)));
    return { attribution, text: text(objection.text), evidence };
  });
  requireObservation(sources.every((source) => source.dissentAttribution === undefined ||
    dissent.some((entry) => entry.attribution === source.dissentAttribution && entry.evidence.some(({ sourceId }) => sourceId === source.id))));
  return dissent;
}

export function prepareInstitutionalObservation(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalObservationEvidence,
): PreparedInstitutionalDraft {
  const value = record(input, ['productId', 'time', 'timeKind', 'statements', 'relatedObservations', 'potentialDuplicates', 'dissent']);
  requireObservation(value.productId === accepted.productId && value.time === accepted.time && value.timeKind === accepted.timeKind);
  const { citation, used } = admittedCitations(sources);
  const approvedSupport = new Set(accepted.corroborations.map(observationSupportKey));
  const statements = list(value.statements, (entry) => {
    const statement = record(entry, ['kind', 'personId', 'text', 'confidence', 'evidence']);
    const { confidence } = statement;
    requireObservation(confidence === 'low' || confidence === 'medium' || confidence === 'high');
    const normalized = observationStatement(statement, accepted.people, citation);
    const corroborated = approvedSupport.has(observationSupportKey(normalized));
    requireObservation(corroborated || confidence !== 'high');
    return { ...normalized, confidence, corroboration: corroborated ? 'confirmed' : 'unconfirmed' };
  }, 1);
  requireObservation(statements.some(({ kind }) => kind === accepted.timeKind));
  const relatedObservations = list(value.relatedObservations, slug);
  requireObservation(new Set(relatedObservations).size === relatedObservations.length &&
    relatedObservations.every((id) => accepted.relatedObservationIds.includes(id)));
  const potentialDuplicates = list(value.potentialDuplicates, (entry) => {
    const duplicate = record(entry, ['observationId', 'reason', 'evidence']);
    const observationId = slug(duplicate.observationId);
    requireObservation(relatedObservations.includes(observationId));
    return { observationId, reason: text(duplicate.reason), evidence: list(duplicate.evidence, citation, 1) };
  });
  requireObservation(new Set(potentialDuplicates.map(({ observationId }) => observationId)).size === potentialDuplicates.length);
  const dissent = attributedDissent(value.dissent, sources, citation);
  const correction = accepted.correction && { ...accepted.correction, evidence: accepted.correction.evidence.map(citation) };
  const body = { time: accepted.time, timeKind: accepted.timeKind, statements, relatedObservations, potentialDuplicates, dissent };
  const identity = { ...binding, duty: 'J7-09' as const, echelon: 'L3' as const, kind: 'observation' as const,
    productId: accepted.productId, sources: used(), access: accepted.access, correction };
  const bytes = canonicalBytes({ schema: 1, ...identity, body });
  requireObservation(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalObservationDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}

/** Re-create the admitted input from stored bytes, stripping only derived statement metadata. */
export function institutionalObservationInput(body: object, productId: unknown): unknown {
  const stored = record(body, ['time', 'timeKind', 'statements', 'relatedObservations', 'potentialDuplicates', 'dissent']);
  return { ...stored, productId, statements: list(stored.statements, (entry) => {
    const { corroboration: _derived, ...statement } = record(entry, ['kind', 'personId', 'text', 'confidence', 'evidence', 'corroboration']);
    return statement;
  }, 1) };
}

export interface InstitutionalFindingsEvidence {
  readonly productId: string;
  readonly observation: { readonly version: string; readonly reviewDigest: string; readonly productId: string;
    readonly access: 'org/Public'; readonly verification: 'unverified-draft'; readonly sources: InstitutionalBriefReview['sources'] };
  readonly objective: { readonly id: string; readonly revision: string; readonly evidence: readonly InstitutionalCitation[] };
  readonly directEvidence: readonly InstitutionalCitation[];
  readonly conflictingEvidence: readonly InstitutionalCitation[];
  readonly dissentEvidence: readonly InstitutionalCitation[];
  readonly correctionEvidence: readonly InstitutionalCitation[];
  readonly corroboratingEvidence: readonly InstitutionalCitation[];
  readonly owner: string;
  readonly subjectMatterExpert: string;
  readonly approver: { readonly person: string; readonly level: string };
}

function requireFindings(condition: unknown): asserts condition {
  if (!condition) throw new Error('The office-hours findings do not match the current admitted observation and objective.');
}

export function admittedInstitutionalFindings(
  raw: unknown, observation: InstitutionalObservationReview, observationBody: object, binding: InstitutionalBriefBinding,
  sources: readonly InstitutionalBriefSource[],
): InstitutionalFindingsEvidence {
  const value = record(raw, ['purpose', 'project', 'directory', 'echelon', 'state', 'productId', 'observationVersion', 'observationReviewDigest',
    'observationEvidence', 'objective', 'corroboratingEvidence', 'owner', 'subjectMatterExpert', 'approver']);
  const reviewDigest = canonicalDigest(observation);
  requireFindings(value.purpose === 'fictional-office-hours-j7-10' && value.state === 'approved-for-draft' &&
    value.project === binding.project && value.directory === binding.directory && value.echelon === 'L3' &&
    observation.project === binding.project && observation.directory === binding.directory && observation.echelon === 'L3' &&
    observation.duty === 'J7-09' && observation.kind === 'observation' && observation.access === 'org/Public' &&
    value.observationVersion === observation.version && value.observationReviewDigest === reviewDigest &&
    observation.sources.every(({ id, hash }) => sources.some((source) => source.id === id && institutionalSourceHash(source) === hash)));
  const objective = record(value.objective, ['id', 'revision', 'evidence']);
  const approver = record(value.approver, ['person', 'level']);
  const owner = slug(value.owner);
  const subjectMatterExpert = slug(value.subjectMatterExpert);
  const approverPerson = slug(approver.person);
  requireFindings(new Set([owner, subjectMatterExpert, approverPerson]).size === 3);
  const { citation } = admittedCitations(sources);
  const objectiveRevision = revision(objective.revision);
  const objectiveEvidence = list(objective.evidence, citation, 1);
  requireFindings(objectiveEvidence.every((entry) => entry.revision === objectiveRevision));

  const explicitlyDisclosed = new Set(list(value.observationEvidence, citation, 1).map(canonicalDigest));
  const admitted = (entries: readonly InstitutionalCitation[]) =>
    [...new Map(entries.map((entry) => [canonicalDigest(entry), entry])).entries()]
      .filter(([key]) => explicitlyDisclosed.has(key)).map(([, entry]) => entry);
  const body = record(observationBody, ['time', 'timeKind', 'statements', 'relatedObservations', 'potentialDuplicates', 'dissent']);
  const statements = list(body.statements, (entry) => {
    const statement = record(entry, ['kind', 'personId', 'text', 'confidence', 'evidence', 'corroboration']);
    return { kind: statement.kind, evidence: list(statement.evidence, citation, 1) };
  }, 1);
  const dissentEvidence = admitted(list(body.dissent, (entry) =>
    list(record(entry, ['attribution', 'text', 'evidence']).evidence, citation, 1)).flat());
  const correctionEvidence = admitted(observation.correction?.evidence ?? []);
  const excludedFromDirect = new Set([...dissentEvidence, ...correctionEvidence].map(canonicalDigest));
  const observationsAndReports = statements.filter(({ kind }) => kind === 'observed' || kind === 'reported');
  const directEvidence = admitted(observationsAndReports.flatMap(({ evidence }) => evidence))
    .filter((entry) => !excludedFromDirect.has(canonicalDigest(entry)));
  requireFindings(directEvidence.length > 0);
  const conflictingEvidence = admitted([...statements.filter(({ kind }) => kind === 'reported').flatMap(({ evidence }) => evidence), ...dissentEvidence]);
  const observedSources = new Set([...directEvidence, ...conflictingEvidence, ...correctionEvidence].map(({ sourceId }) => sourceId));
  return {
    productId: slug(value.productId),
    observation: { version: observation.version, reviewDigest, productId: observation.productId, access: observation.access,
      verification: 'unverified-draft', sources: observation.sources.filter(({ id }) => observedSources.has(id)) },
    objective: { id: slug(objective.id), revision: objectiveRevision, evidence: objectiveEvidence },
    directEvidence, conflictingEvidence, dissentEvidence, correctionEvidence,
    corroboratingEvidence: list(value.corroboratingEvidence, citation, 1),
    owner, subjectMatterExpert, approver: { person: approverPerson, level: slug(approver.level) },
  };
}

export function prepareInstitutionalFindings(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalFindingsEvidence,
): PreparedInstitutionalDraft {
  const value = record(input, ['productId', 'candidates', 'dissent', 'limitations']);
  requireFindings(value.productId === accepted.productId);
  const { citation, used } = admittedCitations(sources);
  accepted.objective.evidence.forEach(citation);
  const directCitations = new Set(accepted.directEvidence.map(canonicalDigest));
  const corroboration = new Set(accepted.corroboratingEvidence.map(canonicalDigest));
  const conflicts = new Set(accepted.conflictingEvidence.map(canonicalDigest));
  const dissent = new Set(accepted.dissentEvidence.map(canonicalDigest));
  const dissentSources = new Set(accepted.dissentEvidence.map(({ sourceId }) => sourceId));
  const candidates = list(value.candidates, (entry) => {
    const candidate = record(entry, ['text', 'direct', 'corroborating', 'conflicting', 'alternateExplanations',
      'uncertainty', 'recommendation', 'implementationEvidence', 'independentCheck']);
    const direct = list(candidate.direct, citation, 1);
    const corroborating = list(candidate.corroborating, citation, 1);
    const conflicting = list(candidate.conflicting, citation);
    requireFindings(direct.every((cite) => directCitations.has(canonicalDigest(cite))) &&
      corroborating.every((cite) => corroboration.has(canonicalDigest(cite))) &&
      conflicting.every((cite) => conflicts.has(canonicalDigest(cite))));
    return { text: text(candidate.text), direct, corroborating, conflicting,
      alternateExplanations: list(candidate.alternateExplanations, (entry) => text(entry), 1),
      uncertainty: text(candidate.uncertainty), recommendation: text(candidate.recommendation),
      implementationEvidence: text(candidate.implementationEvidence), independentCheck: text(candidate.independentCheck) };
  }, 1);
  const limitations = list(value.limitations, (entry) => {
    const limitation = record(entry, ['gap', 'resolve']);
    return { gap: text(limitation.gap), resolve: text(limitation.resolve) };
  }, 1);
  const objections = attributedDissent(value.dissent, sources.filter(({ id }) => dissentSources.has(id)), (entry) => {
    const cited = citation(entry);
    requireFindings(dissent.has(canonicalDigest(cited)));
    return cited;
  });
  const body = { candidates, dissent: objections, limitations };
  const identity = { ...binding, duty: 'J7-10' as const, echelon: 'L3' as const, kind: 'findings' as const, productId: accepted.productId,
    observation: accepted.observation, objective: accepted.objective, evidenceDigest: canonicalDigest(accepted),
    sources: used(), validation: 'open' as const, release: 'disabled' as const,
    owner: accepted.owner, reasoningReview: { person: accepted.subjectMatterExpert, state: 'pending' as const }, requiredApproval: accepted.approver };
  const bytes = canonicalBytes({ schema: 1, ...identity, body });
  requireFindings(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalFindingsDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}

const catalogueFields = ['title', 'category', 'description', 'platform-status'] as const;
type CatalogueField = typeof catalogueFields[number];

interface InstitutionalCatalogueRow {
  readonly id: string;
  readonly fields: Partial<Record<Exclude<CatalogueField, 'platform-status'>, string>>;
  readonly scope: 'confirmed' | 'uncertain';
  readonly availability: 'documented' | 'unknown';
  readonly freshness: 'current' | 'stale' | 'unknown';
  readonly handling: 'local-review-only';
  readonly custodian: InstitutionalCatalogueSource;
  readonly steward: InstitutionalCatalogueSource;
  readonly platformStatus?: { readonly state: 'documented' | 'unknown'; readonly source: InstitutionalCatalogueSource };
}

export interface InstitutionalCatalogueEvidence {
  readonly requester: 'fictional-catalogue-reviewer';
  readonly purpose: 'fictional-office-records-j2-is01';
  readonly productId: string;
  readonly policyRevision: string;
  readonly steward: InstitutionalCatalogueSource;
  readonly records: readonly InstitutionalCatalogueRow[];
}

function metadataGrants<Field extends string>(input: unknown, allowedFields: readonly Field[]): ReadonlyMap<string, readonly Field[]> {
  const grants = list(input, (entry) => {
    const grant = record(entry, ['id', 'fields']);
    const fields = list(grant.fields, (field) => {
      const allowed = allowedFields.find((candidate) => candidate === field);
      requireCatalogue(allowed !== undefined);
      return allowed;
    });
    requireCatalogue(new Set(fields).size === fields.length);
    return [catalogueId(grant.id), fields] as const;
  });
  const grantsById = new Map(grants);
  requireCatalogue(grantsById.size === grants.length);
  return grantsById;
}

export function admittedInstitutionalCatalogue(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalCatalogueEvidence {
  const { receipt, inventory } = record(raw, ['receipt', 'inventory']);
  const authorization = record(receipt, ['project', 'directory', 'requester', 'purpose', 'policyRevision', 'productId', 'steward', 'grants']);
  const { requester, purpose } = authorization;
  requireCatalogue(authorization.project === binding.project && authorization.directory === binding.directory &&
    requester === 'fictional-catalogue-reviewer' && purpose === 'fictional-office-records-j2-is01');
  const steward = metadataSource(sources, authorization.steward, 'fictional-domain-steward');
  const eligible = metadataGrants(authorization.grants, catalogueFields);
  const rows = list(inventory, (entry) => {
    requireCatalogue(entry && typeof entry === 'object' && !Array.isArray(entry));
    return entry as Record<string, unknown>;
  });
  const records: InstitutionalCatalogueRow[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.confirmed !== true) continue;
    const fields = eligible.get(row.id);
    if (!fields) continue;
    const { id, scope, availability, freshness, handling } = row;
    requireCatalogue((scope === 'confirmed' || scope === 'uncertain') &&
      (availability === 'documented' || availability === 'unknown') &&
      (freshness === 'current' || freshness === 'stale' || freshness === 'unknown') && handling === 'local-review-only');
    requireCatalogue(row.fields && typeof row.fields === 'object' && !Array.isArray(row.fields));
    const descriptive = row.fields as Record<string, unknown>;
    const projected: InstitutionalCatalogueRow['fields'] = {};
    for (const field of fields) {
      if (field !== 'platform-status' && Object.hasOwn(descriptive, field)) projected[field] = text(descriptive[field], 240);
    }
    const custodian = metadataSource(sources, row.custodian, 'fictional-records-custodian');
    requireCatalogue(custodian.sourceId !== steward.sourceId);
    let platformStatus: InstitutionalCatalogueRow['platformStatus'];
    if (fields.includes('platform-status') && row.platformStatus !== undefined) {
      const status = record(row.platformStatus, ['state', 'source']);
      requireCatalogue(status.state === 'documented' || status.state === 'unknown');
      platformStatus = { state: status.state, source: metadataSource(sources, status.source, 'fictional-platform-steward') };
    }
    records.push({ id, fields: projected, scope, availability, freshness, handling, custodian, steward, ...(platformStatus && { platformStatus }) });
  }
  requireCatalogue(new Set(records.map(({ id }) => id)).size === records.length);
  return { requester, purpose, productId: slug(authorization.productId), policyRevision: revision(authorization.policyRevision), steward,
    records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function prepareInstitutionalCatalogue(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalCatalogueEvidence,
): PreparedInstitutionalDraft {
  const records = requestedCatalogueRows(input, accepted);
  const evidenceIds = new Set([accepted.steward.sourceId, ...records.flatMap(({ custodian, platformStatus }) =>
    platformStatus ? [custodian.sourceId, platformStatus.source.sourceId] : [custodian.sourceId])]);
  const identity = { ...binding, duty: 'J2-IS01' as const, echelon: 'L3' as const, kind: 'records-catalogue' as const,
    productId: accepted.productId, policyRevision: accepted.policyRevision, scopeDigest: canonicalDigest(accepted),
    steward: accepted.steward, stewardship: 'pending' as const, sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalCatalogueDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}

const businessServiceFields = ['title', 'owner', 'review-date', 'support-hours', 'user-groups', 'dependencies', 'support-route'] as const;

interface InstitutionalServiceRecord {
  readonly id: string;
  readonly title?: string;
  readonly owner?: InstitutionalCatalogueSource;
  readonly reviewDate?: string;
  readonly supportHours?: string;
  readonly userGroups?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly supportRoute?: { readonly desk: string; readonly instruction: string; readonly source: InstitutionalCatalogueSource };
  readonly document: InstitutionalCatalogueSource;
  readonly freshness: 'current' | 'stale' | 'unknown';
  readonly state: 'proposed' | 'exception';
  readonly openIssues: readonly ('owner-unresolved' | 'review-date-unresolved' | 'freshness-unresolved' | 'possible-duplicate')[];
}

export interface InstitutionalBusinessServicesEvidence {
  readonly requester: 'fictional-service-reviewer';
  readonly purpose: 'fictional-office-services-j6-it01';
  readonly productId: string;
  readonly policyRevision: string;
  readonly portfolioOwner: InstitutionalCatalogueSource;
  readonly records: readonly InstitutionalServiceRecord[];
}

export function admittedInstitutionalBusinessServices(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalBusinessServicesEvidence {
  const { receipt, services } = record(raw, ['receipt', 'services']);
  const authorization = record(receipt, ['project', 'directory', 'requester', 'purpose', 'policyRevision', 'productId', 'portfolioOwner', 'grants']);
  const { requester, purpose } = authorization;
  requireCatalogue(authorization.project === binding.project && authorization.directory === binding.directory &&
    requester === 'fictional-service-reviewer' && purpose === 'fictional-office-services-j6-it01');
  const portfolioOwner = metadataSource(sources, authorization.portfolioOwner, 'fictional-service-portfolio-owner');
  const grants = metadataGrants(authorization.grants, businessServiceFields);
  const records: InstitutionalServiceRecord[] = [];
  for (const entry of list(services, (value) => value)) {
    requireCatalogue(entry && typeof entry === 'object' && !Array.isArray(entry));
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string') continue;
    const fields = grants.get(row.id);
    if (!fields) continue;
    const { id, freshness } = row;
    requireCatalogue(freshness === 'current' || freshness === 'stale' || freshness === 'unknown');
    requireCatalogue(row.duplicate === undefined || typeof row.duplicate === 'boolean');
    const document = metadataSource(sources, row.document, 'fictional-service-documenter');
    requireCatalogue(document.sourceId !== portfolioOwner.sourceId);
    const title = fields.includes('title') && row.title !== undefined ? text(row.title, 80) : undefined;
    requireCatalogue(title === undefined || /^[a-z0-9][a-z0-9 '-]*$/i.test(title));
    const owner = fields.includes('owner') && row.owner !== undefined
      ? metadataSource(sources, row.owner, 'fictional-induction-coordinator') : undefined;
    requireCatalogue(!owner || (owner.sourceId !== document.sourceId && owner.sourceId !== portfolioOwner.sourceId));
    const reviewDate = fields.includes('review-date') && row.reviewDate !== undefined ? metadataDate(row.reviewDate) : undefined;
    const supportHours = fields.includes('support-hours') && row.supportHours !== undefined ? text(row.supportHours, 32) : undefined;
    requireCatalogue(supportHours === undefined || /^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d weekdays$/.test(supportHours));
    const userGroups = fields.includes('user-groups') && row.userGroups !== undefined ? list(row.userGroups, slug) : undefined;
    const dependencies = fields.includes('dependencies') && row.dependencies !== undefined ? list(row.dependencies, slug) : undefined;
    let supportRoute: InstitutionalServiceRecord['supportRoute'];
    if (fields.includes('support-route') && row.supportRoute !== undefined) {
      const route = record(row.supportRoute, ['desk', 'instruction', 'source']);
      requireCatalogue(route.desk === 'office-welcome-desk' && route.instruction === 'ask-for-induction-scheduling');
      supportRoute = { desk: 'Office welcome desk', instruction: 'Ask the office welcome desk about induction scheduling.',
        source: metadataSource(sources, route.source, 'fictional-office-welcome-desk') };
    }
    const openIssues: Array<InstitutionalServiceRecord['openIssues'][number]> = [];
    if (!owner) openIssues.push('owner-unresolved');
    if (!reviewDate) openIssues.push('review-date-unresolved');
    if (freshness !== 'current') openIssues.push('freshness-unresolved');
    if (row.duplicate) openIssues.push('possible-duplicate');
    records.push({ id, document, freshness, state: openIssues.length ? 'exception' : 'proposed', openIssues,
      ...(title && { title }), ...(owner && { owner }), ...(reviewDate && { reviewDate }), ...(supportHours && { supportHours }),
      ...(userGroups && { userGroups }), ...(dependencies && { dependencies }), ...(supportRoute && { supportRoute }) });
  }
  requireCatalogue(new Set(records.map(({ id }) => id)).size === records.length);
  return { requester, purpose, productId: slug(authorization.productId), policyRevision: revision(authorization.policyRevision),
    portfolioOwner, records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function prepareInstitutionalBusinessServices(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalBusinessServicesEvidence,
): PreparedInstitutionalDraft {
  const records = requestedCatalogueRows(input, accepted);
  const evidenceIds = new Set([accepted.portfolioOwner.sourceId, ...records.flatMap(({ document, owner, supportRoute }) =>
    [document.sourceId, owner?.sourceId, supportRoute?.source.sourceId])]);
  const identity = { ...binding, duty: 'J6-IT01' as const, echelon: 'L3' as const, kind: 'business-services' as const,
    productId: accepted.productId, policyRevision: accepted.policyRevision, scopeDigest: canonicalDigest(accepted),
    portfolioOwner: accepted.portfolioOwner, portfolioDecision: 'pending' as const, sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalBusinessServicesDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}

type InstitutionalPlanningRow = {
  readonly id: string;
  readonly statement: string;
  readonly evidence: readonly InstitutionalCatalogueSource[];
} & ({
  readonly kind: 'fact';
  readonly validation: 'attested' | 'unresolved';
  readonly quantity: { readonly value: number; readonly unit: 'documents' } | null;
} | {
  readonly kind: 'estimate';
  readonly validation: 'estimated' | 'unresolved';
  readonly quantity: {
    readonly value: number;
    readonly unit: 'staff-hours' | 'workdays';
    readonly basis: string | null;
    readonly date: string | null;
  } | null;
} | {
  readonly kind: 'assumption' | 'dependency';
  readonly validation: 'open' | 'contradicted' | 'superseded';
  readonly accountableRole: string | null;
  readonly reviewDate: string | null;
});

export interface InstitutionalPlanningEvidence {
  readonly requester: 'fictional-planning-reviewer';
  readonly purpose: 'fictional-office-migration-j5-03';
  readonly productId: string;
  readonly policyRevision: string;
  readonly sourceCutoff: string;
  readonly planOwner: InstitutionalCatalogueSource;
  readonly records: readonly InstitutionalPlanningRow[];
}

export function admittedInstitutionalPlanningEvidence(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalPlanningEvidence {
  const { receipt, rows } = record(raw, ['receipt', 'rows']);
  const authorization = record(receipt, ['project', 'directory', 'requester', 'purpose', 'policyRevision', 'productId', 'sourceCutoff', 'planOwner', 'recordIds']);
  const { requester, purpose } = authorization;
  requireCatalogue(authorization.project === binding.project && authorization.directory === binding.directory &&
    requester === 'fictional-planning-reviewer' && purpose === 'fictional-office-migration-j5-03');
  const sourceCutoff = metadataDate(authorization.sourceCutoff);
  const planOwner = metadataSource(sources, authorization.planOwner, 'fictional-plan-owner');
  const eligibleIds = list(authorization.recordIds, catalogueId);
  const eligible = new Set(eligibleIds);
  requireCatalogue(eligible.size === eligibleIds.length);
  const attested = (entry: unknown) => {
    const input = record(entry, ['sourceId', 'revision', 'role']);
    const { role } = input;
    requireCatalogue(role === 'fictional-records-evidence-owner' || role === 'fictional-platform-evidence-owner');
    const source = metadataSource(sources, input, role);
    requireCatalogue(source.sourceId !== planOwner.sourceId && sources.some(({ id, date }) => id === source.sourceId && date <= sourceCutoff));
    return source;
  };
  const records: InstitutionalPlanningRow[] = [];
  for (const entry of list(rows, (value) => value)) {
    requireCatalogue(entry && typeof entry === 'object' && !Array.isArray(entry));
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || !eligible.has(row.id)) continue;
    const { id, kind } = row;
    const evidence = attested(row.evidence);
    const common = { id, statement: text(row.statement, 240) };
    if (kind === 'fact') {
      const { quantity } = record({ quantity: null, ...row }, ['id', 'kind', 'statement', 'evidence', 'quantity']);
      if (quantity === null) {
        records.push({ ...common, kind, evidence: [evidence], validation: 'unresolved', quantity: null });
        continue;
      }
      const { value, unit } = record(quantity, ['value', 'unit']);
      requireCatalogue(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && unit === 'documents');
      records.push({ ...common, kind, evidence: [evidence], validation: 'attested', quantity: { value, unit } });
      continue;
    }
    if (kind === 'estimate') {
      const { quantity } = record({ quantity: null, ...row }, ['id', 'kind', 'statement', 'evidence', 'quantity']);
      if (quantity === null) {
        records.push({ ...common, kind, evidence: [evidence], validation: 'unresolved', quantity: null });
        continue;
      }
      requireCatalogue(typeof quantity === 'object' && !Array.isArray(quantity));
      const { value, unit, basis, date } = record({ basis: null, date: null, ...quantity }, ['value', 'unit', 'basis', 'date']);
      requireCatalogue(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER &&
        (unit === 'staff-hours' || unit === 'workdays'));
      const admittedDate = date === null ? null : metadataDate(date);
      requireCatalogue(admittedDate === null || admittedDate <= sourceCutoff);
      records.push({ ...common, kind, evidence: [evidence], validation: 'estimated',
        quantity: { value, unit, basis: basis === null ? null : text(basis, 240), date: admittedDate } });
      continue;
    }
    requireCatalogue(kind === 'assumption' || kind === 'dependency');
    const pending = record({ accountableRole: null, reviewDate: null, challenge: null, ...row },
      ['id', 'kind', 'statement', 'evidence', 'accountableRole', 'reviewDate', 'challenge']);
    const { accountableRole, reviewDate } = pending;
    requireCatalogue(accountableRole === null || accountableRole === 'fictional-records-reviewer' || accountableRole === 'fictional-platform-reviewer');
    let validation: 'open' | 'contradicted' | 'superseded' = 'open';
    const citations = [evidence];
    if (pending.challenge !== null) {
      const challenge = record(pending.challenge, ['state', 'evidence']);
      requireCatalogue(challenge.state === 'contradicted' || challenge.state === 'superseded');
      const additional = attested(challenge.evidence);
      requireCatalogue(additional.sourceId !== evidence.sourceId);
      citations.push(additional);
      validation = challenge.state;
    }
    records.push({ ...common, kind, evidence: citations, validation, accountableRole,
      reviewDate: reviewDate === null ? null : metadataDate(reviewDate) });
  }
  requireCatalogue(new Set(records.map(({ id }) => id)).size === records.length);
  return { requester, purpose, productId: slug(authorization.productId), policyRevision: revision(authorization.policyRevision),
    sourceCutoff, planOwner, records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function prepareInstitutionalPlanningRegister(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalPlanningEvidence,
): PreparedInstitutionalDraft {
  const records = requestedCatalogueRows(input, accepted);
  const evidenceIds = new Set([accepted.planOwner.sourceId, ...records.flatMap(({ evidence }) => evidence.map(({ sourceId }) => sourceId))]);
  const identity = { ...binding, duty: 'J5-03' as const, echelon: 'L3' as const, kind: 'planning-evidence' as const,
    productId: accepted.productId, policyRevision: accepted.policyRevision, sourceCutoff: accepted.sourceCutoff, scopeDigest: canonicalDigest(accepted),
    planOwner: accepted.planOwner, planDecision: 'pending' as const, sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalPlanningDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}

const remitPurpose = 'fictional-library-remit-comparison-j9-cl02' as const;
const libraryScopes = ['branch-room-bookings', 'mobile-library-visits', 'reading-session-registration'] as const;
type LibraryScope = typeof libraryScopes[number];
const libraryAttestors = {
  'fictional-library-branch-service': { mandate: 'fictional-branch-mandate-attestor', consent: 'fictional-branch-consent-attestor' },
  'fictional-mobile-library-service': { mandate: 'fictional-mobile-mandate-attestor', consent: 'fictional-mobile-consent-attestor' },
} as const;
type LibraryOrganization = keyof typeof libraryAttestors;

interface InstitutionalLibraryRemitRecord {
  readonly id: string;
  readonly organizationRole: LibraryOrganization;
  readonly description: string;
  readonly scope: readonly LibraryScope[];
  readonly mandate: InstitutionalCatalogueSource | null;
  readonly confirmation: 'verified' | 'disputed' | 'unconfirmed';
  readonly reviewDate: string | null;
  readonly consent: {
    readonly organizationId: string;
    readonly purpose: typeof remitPurpose;
    readonly scope: readonly LibraryScope[];
    readonly startsAt: string;
    readonly expiresAt: string;
    readonly state: 'verified';
    readonly evidence: InstitutionalCatalogueSource;
  };
}

export interface InstitutionalLibraryRemitEvidence {
  readonly requester: 'fictional-library-remit-reviewer';
  readonly purpose: typeof remitPurpose;
  readonly productId: string;
  readonly policyRevision: string;
  readonly liaisonLead: InstitutionalCatalogueSource;
  readonly records: readonly InstitutionalLibraryRemitRecord[];
}

function libraryScope(input: unknown): LibraryScope[] {
  const scopes = list(input, (entry) => {
    const scope = libraryScopes.find((known) => known === entry);
    requireCatalogue(scope);
    return scope;
  }, 1);
  requireCatalogue(new Set(scopes).size === scopes.length);
  return scopes.sort();
}

function remitInstant(input: unknown): string {
  requireCatalogue(typeof input === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input));
  const milliseconds = Date.parse(input);
  requireCatalogue(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input);
  return input;
}

export function admittedInstitutionalLibraryRemits(
  raw: unknown, fixtureInstant: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalLibraryRemitEvidence {
  const now = remitInstant(fixtureInstant);
  const { receipt, organizations } = record(raw, ['receipt', 'organizations']);
  const authorization = record(receipt, ['project', 'directory', 'requester', 'purpose', 'policyRevision', 'productId', 'liaisonLead', 'grants']);
  const { requester, purpose } = authorization;
  requireCatalogue(authorization.project === binding.project && authorization.directory === binding.directory &&
    requester === 'fictional-library-remit-reviewer' && purpose === remitPurpose);
  const liaisonLead = metadataSource(sources, authorization.liaisonLead, 'fictional-liaison-lead');
  const grants = list(authorization.grants, (entry) => {
    const grant = record(entry, ['id', 'scope']);
    return [catalogueId(grant.id), libraryScope(grant.scope)] as const;
  });
  const authorizedScopes = new Map(grants);
  requireCatalogue(authorizedScopes.size === grants.length);
  const records: InstitutionalLibraryRemitRecord[] = [];
  for (const entry of list(organizations, (value) => value)) {
    requireCatalogue(entry && typeof entry === 'object' && !Array.isArray(entry));
    const organization = entry as Record<string, unknown>;
    const { id, organizationRole, confirmation } = organization;
    if (typeof id !== 'string') continue;
    const allowedScope = authorizedScopes.get(id);
    if (!allowedScope) continue;
    requireCatalogue(typeof organizationRole === 'string' && Object.hasOwn(libraryAttestors, organizationRole) &&
      (confirmation === 'verified' || confirmation === 'disputed' || confirmation === 'unconfirmed'));
    const role = organizationRole as LibraryOrganization;
    const attestors = libraryAttestors[role];
    const scope = libraryScope(organization.scope);
    const receipt = record(organization.consent, ['organizationId', 'purpose', 'scope', 'startsAt', 'expiresAt', 'state', 'evidence']);
    const consentScope = libraryScope(receipt.scope);
    const startsAt = remitInstant(receipt.startsAt);
    const expiresAt = remitInstant(receipt.expiresAt);
    requireCatalogue(receipt.organizationId === id && receipt.purpose === purpose && receipt.state === 'verified' &&
      startsAt <= now && now < expiresAt && canonicalDigest(scope) === canonicalDigest(allowedScope) &&
      canonicalDigest(consentScope) === canonicalDigest(allowedScope));
    const mandate = organization.mandate == null ? null : metadataSource(sources, organization.mandate, attestors.mandate);
    const reviewDate = organization.reviewDate == null ? null : metadataDate(organization.reviewDate);
    requireCatalogue(confirmation !== 'verified' || (mandate && reviewDate));
    const description = text(organization.description, 180);
    requireCatalogue(/^[a-z][a-z ,'’-]*\.?$/i.test(description));
    records.push({ id, organizationRole: role, scope, description, mandate, confirmation, reviewDate,
      consent: { organizationId: id, purpose, scope: consentScope, startsAt, expiresAt, state: 'verified',
        evidence: metadataSource(sources, receipt.evidence, attestors.consent) } });
  }
  requireCatalogue(new Set(records.map(({ id }) => id)).size === records.length &&
    new Set(records.map(({ organizationRole }) => organizationRole)).size === records.length);
  const authorities = [liaisonLead.sourceId, ...records.flatMap(({ mandate, consent }) =>
    mandate ? [mandate.sourceId, consent.evidence.sourceId] : [consent.evidence.sourceId])];
  requireCatalogue(new Set(authorities).size === authorities.length);
  return { requester, purpose, productId: slug(authorization.productId), policyRevision: revision(authorization.policyRevision),
    liaisonLead, records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function prepareInstitutionalLibraryRemits(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalLibraryRemitEvidence,
): PreparedInstitutionalDraft {
  const records = requestedCatalogueRows(input, accepted);
  requireCatalogue(records.length === 2);
  const reviewRole = 'fictional-library-legal-reviewer';
  const overlap = libraryScopes.flatMap((scope) => {
    const organizationIds = records.filter((entry) => entry.scope.includes(scope)).map(({ id }) => id);
    return organizationIds.length > 1 ? [{ scope, organizationIds, state: 'unresolved', reviewRole }] : [];
  });
  const unresolved = records.filter(({ confirmation }) => confirmation !== 'verified').map(({ id, confirmation }) => ({
    organizationId: id, confirmation, state: 'unresolved', reviewRole,
  }));
  const evidenceIds = new Set([accepted.liaisonLead.sourceId, ...records.flatMap(({ mandate, consent }) => [mandate?.sourceId, consent.evidence.sourceId])]);
  const identity = { ...binding, duty: 'J9-CL02' as const, echelon: 'L3' as const, kind: 'library-service-remits' as const,
    productId: accepted.productId, policyRevision: accepted.policyRevision, scopeDigest: canonicalDigest(accepted),
    liaisonLead: accepted.liaisonLead, liaisonDecision: 'pending' as const, sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records, overlap, unresolved } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalLibraryRemitsDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}

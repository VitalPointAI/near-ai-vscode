import { createHash } from 'node:crypto';
import { canonicalBytes } from '../team/canonical';
import { verifyPayload, type PayloadSignerRef } from '../team/signedPayload';
import { STAFF_SLUG } from './parse';

export const institutionalBriefDirectory = '.planning/staff/institutional/command/briefs';
export const institutionalActionRegisterDirectory = '.planning/staff/institutional/j3/action-registers';
export const institutionalObservationDirectory = '.planning/staff/institutional/j7/observations';
export const institutionalBriefMaxBytes = 128 * 1024;

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

export type InstitutionalDraftReview = InstitutionalBriefReview | InstitutionalActionRegisterReview | InstitutionalObservationReview;

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

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      !fields.every((field) => Object.hasOwn(value, field))) throw new Error('The decision brief fields do not match the institutional draft form.');
  return value as Record<string, unknown>;
}

function text(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error('The decision brief contains missing or invalid text.');
  }
  return value;
}

function list<T>(value: unknown, parse: (entry: unknown) => T, min = 0): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > 12) throw new Error('The decision brief contains an invalid list.');
  return value.map(parse);
}

export function institutionalBriefDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
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

export function institutionalSourceHash(source: InstitutionalBriefSource): string {
  return institutionalBriefDigest(canonicalBytes(source));
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

function sourceReferences(sources: readonly InstitutionalBriefSource[]): InstitutionalBriefReview['sources'] {
  return [...sources].sort((a, b) => a.id.localeCompare(b.id)).map((source) => ({
    id: source.id, revision: source.revision, date: source.date, label: source.label, hash: institutionalSourceHash(source),
  }));
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

function canonicalDigest(value: unknown): string {
  return institutionalBriefDigest(canonicalBytes(value));
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
  const dissent = list(value.dissent, (entry) => {
    const objection = record(entry, ['attribution', 'text', 'evidence']);
    const attribution = text(objection.attribution, 100);
    const evidence = list(objection.evidence, citation, 1);
    requireObservation(evidence.some(({ sourceId }) => sources.some((source) => source.id === sourceId && source.dissentAttribution === attribution)));
    return { attribution, text: text(objection.text), evidence };
  });
  requireObservation(sources.every((source) => source.dissentAttribution === undefined ||
    dissent.some((entry) => entry.attribution === source.dissentAttribution && entry.evidence.some(({ sourceId }) => sourceId === source.id))));
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

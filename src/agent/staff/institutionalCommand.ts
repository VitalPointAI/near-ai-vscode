import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  admittedInstitutionalFindings, admittedInstitutionalObservation, institutionalBriefDigest, institutionalBriefDirectory, institutionalBriefMaxBytes, institutionalObservationDirectory,
  institutionalObservationInput, institutionalSourceHash, prepareInstitutionalActionRegister, prepareInstitutionalBrief, prepareInstitutionalFindings, prepareInstitutionalObservation,
  validateInstitutionalBriefSource, verifyInstitutionalActionAcceptance, type InstitutionalActionAuthority, type InstitutionalBriefSource,
  type InstitutionalDraftReview, type InstitutionalDraftScope, type InstitutionalObservationEvidence, type InstitutionalObservationReview, type PreparedInstitutionalDraft,
} from '../../domain/staff/institutionalBrief';
import { canonicalBytes } from '../../domain/team/canonical';
import { parseTeam, renderTeam, teamAgents, type TeamDefinition } from '../teams';
import { declareManifest, fromArgument, INTERACTIVE_ONLY, type AgentTool, type ToolContext } from '../tools';
import { ToolError } from '../workspace';

export const INSTITUTIONAL_COMMAND_GROUP_TEAM = 'institutional-command-group-v1';
export const INSTITUTIONAL_COMMAND_GROUP_NAME = 'Institutional Command Group';
export const INSTITUTIONAL_COMMAND_GROUP_PROFILE = 'Canadian brigade (L3)';
export const INSTITUTIONAL_COMMAND_GROUP_LEAD = 'Command Group lead';
export const INSTITUTIONAL_COMMAND_GROUP_MEMBER = 'command-brief-drafter';
export const INSTITUTIONAL_J3_ACTION_REGISTER_TEAM = 'institutional-j3-action-register-v1';
export const INSTITUTIONAL_J7_LESSONS_TEAM = 'institutional-j7-lessons-v1';
export type InstitutionalRoleId = typeof INSTITUTIONAL_COMMAND_GROUP_TEAM | typeof INSTITUTIONAL_J3_ACTION_REGISTER_TEAM | typeof INSTITUTIONAL_J7_LESSONS_TEAM;

const description = 'Prepare a local institutional decision brief for human review.';
const instructions = 'Prepare a CG-07 decision brief using only evidence admitted for this project. Separate sourced facts, assumptions and alternatives. Preserve attributed disagreement. Leave the decision with the Command Group lead.';

export const institutionalCommandGroupDefinition = renderTeam(INSTITUTIONAL_COMMAND_GROUP_NAME, description, [{
  name: INSTITUTIONAL_COMMAND_GROUP_MEMBER,
  role: 'Decision brief drafter',
  instructions,
}], { private: true });

export const institutionalCommandGroupSkill = [
  '# Decision brief (CG-07)',
  '',
  instructions,
  '',
  'State the decision requested, options, dependencies, uncertainties and dissent. Cite each factual claim to its exact source version and text span.',
  '',
  'Present the completed draft for human review. The brief does not approve a decision, change an official record or authorize release.',
  '',
].join('\n');

const actionRegisterName = 'Institutional G3 Action Register';
const actionRegisterInstructions = 'Draft the fictional J3-07 office-hours action register from the admitted extracts and accepted chair decision. Preserve uncertain assignments and dates for the chair. Leave acknowledgment and any handoff with the responsible human.';
const actionRegisterMember = 'action-register-drafter';
const lessonsName = 'Institutional G7 Lessons';
const lessonsMember = 'lessons-drafter';
const saveFindings = 'SaveInstitutionalAfterActionDraft';
const findingsInstructions = 'Draft fictional J7-10 office-hours findings for independent human validation. Show direct, corroborating and conflicting evidence, alternate explanations, uncertainty and missing implementation proof. Leave validation and release to the designated people.';
const lessonsInstructions = 'Draft a fictional J7-09 office-hours observation from admitted local evidence. Distinguish direct observation, reports, judgment and hypothesis. Retain uncertainty, citations, corrections and dissent for human review.';
const institutionalRoles = {
  [INSTITUTIONAL_COMMAND_GROUP_TEAM]: {
    label: INSTITUTIONAL_COMMAND_GROUP_NAME, member: INSTITUTIONAL_COMMAND_GROUP_MEMBER, lead: INSTITUTIONAL_COMMAND_GROUP_LEAD,
    definition: institutionalCommandGroupDefinition, skill: institutionalCommandGroupSkill, keySegment: 'commandGroup',
    read: 'ReadInstitutionalBriefEvidence', save: 'SaveInstitutionalBriefDraft',
  },
  [INSTITUTIONAL_J3_ACTION_REGISTER_TEAM]: {
    label: actionRegisterName, member: actionRegisterMember, lead: 'Fictional staff-coordination lead',
    definition: renderTeam(actionRegisterName, 'Prepare a local office-hours action register for human review.', [{
      name: actionRegisterMember, role: 'Action register drafter', instructions: actionRegisterInstructions,
    }], { private: true }),
    skill: ['# Office-hours action register (J3-07)', '', actionRegisterInstructions, '',
      'Cite exact admitted extracts. Deduplicate identical decision and action IDs. Leave unsupported owners and dates unresolved.', ''].join('\n'),
    keySegment: 'j3ActionRegister', read: 'ReadInstitutionalActionEvidence', save: 'SaveInstitutionalActionRegisterDraft',
  },
  [INSTITUTIONAL_J7_LESSONS_TEAM]: {
    label: lessonsName, member: lessonsMember, lead: 'Fictional lessons lead',
    definition: renderTeam(lessonsName, 'Prepare and cite local observations from a fictional office-hours trial.', [{
      name: lessonsMember, role: 'Lessons drafter', instructions: lessonsInstructions,
    }], { private: true }),
    skill: ['# Office-hours observations and lessons (J7-09 and J7-10)', '', lessonsInstructions,
      'Keep observation and findings in draft. The observer or lessons lead confirms facts, merge and access decisions. Independent human reviewers own findings validation.', ''].join('\n'),
    keySegment: 'j7Lessons', read: 'ReadInstitutionalLessonsEvidence', save: 'SaveInstitutionalObservationDraft',
  },
} as const;

export function isInstitutionalRole(team: string): team is InstitutionalRoleId {
  return Object.hasOwn(institutionalRoles, team);
}

export function institutionalRole(team: InstitutionalRoleId) {
  return institutionalRoles[team];
}

export function institutionalDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface InstitutionalRoleBinding<T extends InstitutionalRoleId = InstitutionalRoleId> {
  readonly version: 1;
  readonly echelon: 'L3';
  readonly rootDigest: string;
  readonly directoryDigest: string;
  readonly team: T;
  readonly teamDigest: string;
  readonly skillDigest: string;
}

export type InstitutionalCommandGroupBinding = InstitutionalRoleBinding<typeof INSTITUTIONAL_COMMAND_GROUP_TEAM>;

export function institutionalRoleBinding<T extends InstitutionalRoleId>(canonicalRoot: string, directoryDigest: string, team: T): InstitutionalRoleBinding<T> {
  const role = institutionalRole(team);
  return {
    version: 1,
    echelon: 'L3',
    rootDigest: institutionalDigest(canonicalRoot),
    directoryDigest,
    team,
    teamDigest: institutionalDigest(role.definition),
    skillDigest: institutionalDigest(role.skill),
  };
}

export function institutionalCommandGroupBinding(canonicalRoot: string, directoryDigest: string): InstitutionalCommandGroupBinding {
  return institutionalRoleBinding(canonicalRoot, directoryDigest, INSTITUTIONAL_COMMAND_GROUP_TEAM);
}

/** Checks the exact setup-owned binding. Matching metadata is not run authority. */
export function readInstitutionalRoleBinding<T extends InstitutionalRoleBinding>(value: unknown, expected: T): T | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(expected) as Array<keyof InstitutionalRoleBinding>;
  if (Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field) || record[field] !== expected[field])) return undefined;
  return expected;
}

export function readInstitutionalCommandGroupBinding(value: unknown, expected: InstitutionalCommandGroupBinding): InstitutionalCommandGroupBinding | undefined {
  return readInstitutionalRoleBinding(value, expected);
}

/** This host port is supplied only by the private synthetic acceptance fixture. */
export interface InstitutionalCommandFixture {
  readonly root: string;
  readonly runId: string;
  readonly model: string;
  readonly policyHash: string;
  readonly currentActionSettings: () => unknown;
  readonly readStaged: () => unknown;
  readonly currentSources: () => readonly InstitutionalBriefSource[];
  readonly withStableParents: <T>(operation: () => Promise<T>) => Promise<T>;
}

interface InstitutionalActionRegisterFixture extends InstitutionalCommandFixture {
  readonly actionAuthority: InstitutionalActionAuthority & { readonly predecessorTeam: TeamDefinition };
}

interface InstitutionalObservationFixture extends InstitutionalCommandFixture {
  readonly currentObservation: () => unknown;
}

interface InstitutionalFindingsFixture extends InstitutionalCommandFixture {
  readonly findingsAuthority: {
    readonly predecessorTeam: TeamDefinition;
    readonly readObservation: () => Promise<InstitutionalObservationReview>;
    readonly current: () => unknown;
  };
}

const fixtureSelections = new WeakMap<TeamDefinition, { readonly fixture: InstitutionalCommandFixture; readonly scope: InstitutionalDraftScope }>();
const stale = 'The institutional command fixture no longer matches the staged project, source or run.';

async function captureInstitutionalBinding(root: string, team: InstitutionalRoleId): Promise<InstitutionalRoleBinding> {
  if (path.resolve(root) !== root || await realpath(root) !== root) throw new ToolError(stale);
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new ToolError(stale);
  return institutionalRoleBinding(root, institutionalDigest(`${info.dev}:${info.ino}:${info.birthtimeNs}`), team);
}

export async function selectSyntheticInstitutionalCommandGroup(fixture: InstitutionalCommandFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_COMMAND_GROUP_TEAM);
}

export async function selectSyntheticInstitutionalJ3ActionRegister(fixture: InstitutionalActionRegisterFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J3_ACTION_REGISTER_TEAM, { authority: fixture.actionAuthority });
}

export async function selectSyntheticInstitutionalJ7Observation(fixture: InstitutionalObservationFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J7_LESSONS_TEAM, { currentObservation: fixture.currentObservation });
}

export async function selectSyntheticInstitutionalJ7Findings(fixture: InstitutionalFindingsFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J7_LESSONS_TEAM, { findingsAuthority: fixture.findingsAuthority });
}

async function selectSyntheticInstitutionalRole(fixture: InstitutionalCommandFixture, teamId: InstitutionalRoleId, {
  authority, currentObservation, findingsAuthority,
}: { authority?: InstitutionalActionRegisterFixture['actionAuthority']; currentObservation?: () => unknown;
  findingsAuthority?: InstitutionalFindingsFixture['findingsAuthority'] } = {}): Promise<TeamDefinition> {
  const exact = await captureInstitutionalBinding(fixture.root, teamId);
  if (!readInstitutionalRoleBinding(fixture.readStaged(), exact) || typeof fixture.withStableParents !== 'function' ||
      typeof fixture.currentSources !== 'function' || typeof fixture.currentActionSettings !== 'function' || !fixture.runId || !fixture.model ||
      !/^[a-f0-9]{64}$/.test(fixture.policyHash) || (teamId === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM && !authority) ||
      (teamId === INSTITUTIONAL_J7_LESSONS_TEAM && typeof currentObservation !== 'function' && !findingsAuthority)) throw new ToolError(stale);
  const role = institutionalRole(teamId);
  const team = parseTeam(role.definition, `${teamId}.md`);
  for (const member of team.members) {
    // Keep the staged definition bytes stable. Only the selected fixture supplies the explicit tool list.
    member.tools = [role.read, findingsAuthority ? saveFindings : role.save];
    if (findingsAuthority) member.instructions = findingsInstructions;
    Object.freeze(member.tools);
    Object.freeze(member);
  }
  Object.freeze(team.members);
  Object.freeze(team);
  const binding = Object.freeze({ project: exact.rootDigest, directory: exact.directoryDigest, team: exact.team, teamVersion: exact.teamDigest, skillVersion: exact.skillDigest });
  const provider = Object.freeze({ ...fixture });
  const currentSources = () => admitted(provider.currentSources(), binding.project);
  const stagedIsCurrent = () => Boolean(readInstitutionalRoleBinding(provider.readStaged(), exact));
  let actionRegister: InstitutionalDraftScope['actionRegister'];
  if (authority) {
    const evidence = Object.freeze({ ...authority, chair: Object.freeze({ ...authority.chair }) });
    const previousScope = fixtureSelections.get(evidence.predecessorTeam)?.scope;
    const command = institutionalCommandGroupBinding(fixture.root, exact.directoryDigest);
    if (!previousScope || previousScope.root !== fixture.root || previousScope.binding.directory !== exact.directoryDigest ||
        previousScope.binding.team !== command.team || !await previousScope.bindingIsCurrent()) throw new ToolError(stale);
    const previousSources = sourceHashes(previousScope.currentSources());
    const predecessorFacts = () => {
      try { return previousScope.stagedIsCurrent() && sameSources(previousSources, previousScope.currentSources()); }
      catch { return false; }
    };
    const previous = structuredClone(await evidence.readPredecessor());
    if (previous.kind !== 'brief' || previous.team !== command.team || previous.teamVersion !== command.teamDigest ||
        previous.skillVersion !== command.skillDigest || !predecessorFacts() ||
        previous.sources.some(({ id, hash }) => previousSources.get(id) !== hash)) throw new ToolError(stale);
    const previousDigest = institutionalBriefDigest(canonicalBytes(previous));
    actionRegister = Object.freeze({
      current: () => verifyInstitutionalActionAcceptance(evidence, previous, binding, currentSources()),
      predecessorFacts,
      predecessorAtEffect: (version) => version === previous.version && predecessorFacts() && Boolean(readExactDraftLeaf(fixture.root, institutionalBriefDirectory, version)),
      predecessorCurrent: async () => {
        try {
          if (!predecessorFacts()) return false;
          const reopened = await evidence.readPredecessor();
          return predecessorFacts() && institutionalBriefDigest(canonicalBytes(reopened)) === previousDigest;
        } catch { return false; }
      },
    });
    actionRegister.current();
  }
  let observation: InstitutionalDraftScope['observation'];
  if (currentObservation) {
    const current = () => admittedInstitutionalObservation(currentObservation(), binding, currentSources());
    observation = Object.freeze({
      current,
      correctionAtEffect: (correction: InstitutionalObservationEvidence['correction']) => {
        try {
          const active = current();
          return institutionalBriefDigest(canonicalBytes(active.correction)) === institutionalBriefDigest(canonicalBytes(correction)) &&
            (!correction || Boolean(reconstructObservationPredecessor(fixture.root, binding, currentSources(), active, correction.version)));
        } catch { return false; }
      },
    });
    current();
  }
  let findings: InstitutionalDraftScope['findings'];
  if (findingsAuthority) {
    const evidence = Object.freeze({ ...findingsAuthority });
    const priorScope = fixtureSelections.get(evidence.predecessorTeam)?.scope;
    const priorObservation = priorScope?.observation;
    if (!priorScope || !priorObservation || priorScope.root !== fixture.root ||
        priorScope.binding.directory !== binding.directory || priorScope.binding.team !== binding.team ||
        !await priorScope.bindingIsCurrent()) throw new ToolError(stale);
    const priorSources = sourceHashes(priorScope.currentSources());
    const priorApprovalDigest = institutionalBriefDigest(canonicalBytes(priorObservation.current()));
    const prior = structuredClone(await evidence.readObservation());
    const reviewDigest = institutionalBriefDigest(canonicalBytes(prior));
    const predecessorFacts = () => {
      try {
        return priorScope.stagedIsCurrent() && sameSources(priorSources, priorScope.currentSources()) &&
          institutionalBriefDigest(canonicalBytes(priorObservation.current())) === priorApprovalDigest;
      } catch { return false; }
    };
    if (prior.kind !== 'observation' || prior.team !== binding.team || prior.teamVersion !== binding.teamVersion ||
        prior.skillVersion !== binding.skillVersion || !predecessorFacts() ||
        prior.sources.some(({ id, hash }) => priorSources.get(id) !== hash)) throw new ToolError(stale);
    const priorBody = await priorScope.withStableParents(async () => predecessorFacts() &&
      priorObservation.correctionAtEffect(prior.correction) &&
      reconstructObservationPredecessor(priorScope.root, priorScope.binding, priorScope.currentSources(), priorObservation.current(), prior.version));
    if (!priorBody) throw new ToolError(stale);
    findings = Object.freeze({
      current: () => admittedInstitutionalFindings(evidence.current(), prior, priorBody, binding, currentSources()),
      predecessorCurrent: async () => {
        try {
          if (!predecessorFacts()) return false;
          const reopened = await evidence.readObservation();
          return predecessorFacts() && institutionalBriefDigest(canonicalBytes(reopened)) === reviewDigest;
        } catch { return false; }
      },
      predecessorAtEffect: (version: string) => {
        try {
          return version === prior.version && predecessorFacts() &&
            priorObservation.correctionAtEffect(prior.correction) &&
            Boolean(reconstructObservationPredecessor(priorScope.root, priorScope.binding, priorScope.currentSources(), priorObservation.current(), version));
        } catch { return false; }
      },
    });
    findings.current();
  }
  fixtureSelections.set(team, { fixture: provider, scope: Object.freeze({
    root: fixture.root, binding, withStableParents: fixture.withStableParents, currentSources, stagedIsCurrent,
    ...(actionRegister ? { actionRegister } : {}), ...(observation ? { observation } : {}), ...(findings ? { findings } : {}),
    bindingIsCurrent: async () => {
      const sampled = await captureInstitutionalBinding(provider.root, teamId);
      return sampled.directoryDigest === exact.directoryDigest && stagedIsCurrent();
    },
  }) });
  return team;
}

export function selectedInstitutionalScope(team: TeamDefinition): InstitutionalDraftScope | undefined {
  return fixtureSelections.get(team)?.scope;
}

export function selectedTeamAgents(team: TeamDefinition | undefined): ReturnType<typeof teamAgents> {
  if (!team || (isInstitutionalRole(team.slug) && !fixtureSelections.has(team))) return [];
  return teamAgents(team);
}

function admitted(current: readonly InstitutionalBriefSource[], project: string): readonly InstitutionalBriefSource[] {
  if (!Array.isArray(current) || current.length < 1 || current.length > 12 || current.some((source) => !validateInstitutionalBriefSource(source, project)) ||
      new Set(current.map((source) => source.id)).size !== current.length) throw new ToolError(stale);
  return current;
}

/** Read the bounded predecessor leaf synchronously under the fixture interlock. */
function readExactDraftLeaf(root: string, directory: string, version: string): Buffer | undefined {
  if (!/^[a-f0-9]{64}$/.test(version)) return undefined;
  const file = path.join(root, directory, `${version}.json`);
  try {
    if (realpathSync(file) !== file) return undefined;
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.size > institutionalBriefMaxBytes) return undefined;
    const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return undefined;
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(descriptor, bytes, count, bytes.length - count, count);
        if (read === 0) break;
        count += read;
      }
      const after = lstatSync(file, { bigint: true });
      const payload = bytes.subarray(0, count);
      if (after.isFile() && after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
          after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs && BigInt(count) === before.size &&
          institutionalBriefDigest(payload) === version) return payload;
      return undefined;
    } finally { closeSync(descriptor); }
  } catch { return undefined; }
}

function reconstructObservationPredecessor(
  root: string, binding: InstitutionalDraftScope['binding'], sources: readonly InstitutionalBriefSource[],
  approval: InstitutionalObservationEvidence, version: string,
): object | undefined {
  const bytes = readExactDraftLeaf(root, institutionalObservationDirectory, version);
  if (!bytes) return undefined;
  const stored: unknown = JSON.parse(bytes.toString('utf8'));
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const { body, productId, correction } = stored as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body) || productId !== approval.productId) return undefined;
  const prior = admittedInstitutionalObservation({ ...approval, correction }, binding, sources);
  const expected = prepareInstitutionalObservation(institutionalObservationInput(body, productId), binding, sources, prior);
  return expected.review.version === version && bytes.equals(Buffer.from(expected.text)) ? body : undefined;
}

function sourceHashes(sources: readonly InstitutionalBriefSource[]): ReadonlyMap<string, string> {
  return new Map(sources.map((source) => [source.id, institutionalSourceHash(source)]));
}

function sameSources(expected: ReadonlyMap<string, string>, current: readonly InstitutionalBriefSource[]): boolean {
  return expected.size === current.length && current.every((source) => expected.get(source.id) === institutionalSourceHash(source));
}

const exactSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const line = { type: 'string' };
const offset = { type: 'integer', minimum: 0 };
const entries = (items: Record<string, unknown>) => ({ type: 'array', items });
const citationSchema = entries(exactSchema({ sourceId: line, revision: line, start: offset, end: offset, quote: line }));
const briefSchema = exactSchema({
  productId: line, decisionRequested: line, facts: entries(exactSchema({ text: line, evidence: citationSchema })),
  alternatives: entries(line), assumptions: entries(line),
  dissent: entries(exactSchema({ attribution: line, text: line, evidence: citationSchema })), dependencies: entries(line),
});

const actionRegisterSchema = exactSchema({
  productId: line, rows: entries(exactSchema({
    decisionId: line, actionId: line, text: line, owner: { type: ['string', 'null'] }, dueDate: { type: ['string', 'null'] },
    acceptanceCriteria: line, dependencies: entries(exactSchema({ id: line, crossProgramme: { type: 'boolean' } })),
    exceptions: entries(line), acknowledgments: entries(exactSchema({ owner: line, date: line, evidence: citationSchema })),
    evidence: citationSchema,
  })),
});

const observationSchema = exactSchema({
  productId: line, time: line, timeKind: { ...line, enum: ['observed', 'reported'] },
  statements: entries(exactSchema({
    kind: { ...line, enum: ['observed', 'reported', 'judgment', 'hypothesis'] }, personId: line, text: line,
    confidence: { ...line, enum: ['low', 'medium', 'high'] }, evidence: citationSchema,
  })),
  relatedObservations: entries(line),
  potentialDuplicates: entries(exactSchema({ observationId: line, reason: line, evidence: citationSchema })),
  dissent: entries(exactSchema({ attribution: line, text: line, evidence: citationSchema })),
});

const findingsSchema = exactSchema({
  productId: line,
  candidates: entries(exactSchema({
    text: line, direct: citationSchema, corroborating: citationSchema, conflicting: citationSchema,
    alternateExplanations: entries(line), uncertainty: line, recommendation: line, implementationEvidence: line, independentCheck: line,
  })),
  dissent: entries(exactSchema({ attribution: line, text: line, evidence: citationSchema })),
  limitations: entries(exactSchema({ gap: line, resolve: line })),
});

export async function institutionalChildTools(
  team: TeamDefinition | undefined, selection: { root: string; runId: string; label: string; model: string; local: boolean; onTeam: boolean; detached: boolean },
  store: {
    verify: (scope: InstitutionalDraftScope, draft: PreparedInstitutionalDraft) => Promise<void>;
    commit: (scope: InstitutionalDraftScope, draft: PreparedInstitutionalDraft, verifyBeforeInstall: () => boolean) => Promise<InstitutionalDraftReview>;
  },
): Promise<[AgentTool<string>, AgentTool<PreparedInstitutionalDraft>] | undefined> {
  if (!team || !isInstitutionalRole(team.slug)) return undefined;
  const role = institutionalRole(team.slug);
  const selected = fixtureSelections.get(team);
  if (!selected || !selection.local || !selection.onTeam || selection.detached || selection.label !== role.member ||
      selected.scope.root !== selection.root || selected.fixture.runId !== selection.runId || selected.fixture.model !== selection.model) throw new ToolError(stale);
  const { scope, fixture: { policyHash, currentActionSettings } } = selected;
  if (!await scope.bindingIsCurrent() || (scope.actionRegister && !await scope.actionRegister.predecessorCurrent()) ||
      (scope.findings && !await scope.findings.predecessorCurrent())) throw new ToolError(stale);
  const accepted = scope.actionRegister?.current();
  const approvedObservation = scope.observation?.current();
  const observationDigest = approvedObservation && institutionalBriefDigest(canonicalBytes(approvedObservation));
  const approvedFindings = scope.findings?.current();
  const findingsDigest = approvedFindings && institutionalBriefDigest(canonicalBytes(approvedFindings));
  const readEvidence = role.read;
  const saveDraft = approvedFindings ? saveFindings : role.save;
  const sources = structuredClone(scope.currentSources());
  const approvedExtracts = approvedFindings && [
    ...approvedFindings.directEvidence, ...approvedFindings.conflictingEvidence, ...approvedFindings.correctionEvidence,
    ...approvedFindings.objective.evidence, ...approvedFindings.corroboratingEvidence,
  ];
  const quoteSources = approvedExtracts ? sources.map((source) => ({
    ...source,
    spans: source.spans.filter(({ start, end }) =>
      approvedExtracts.some((entry) => entry.sourceId === source.id && entry.start === start && entry.end === end)),
    dissentAttribution: approvedFindings?.dissentEvidence.some(({ sourceId }) => sourceId === source.id) ? source.dissentAttribution : undefined,
  })).filter(({ spans }) => spans.length > 0) : sources;
  const capturedSources = sourceHashes(sources);
  const currentFacts = (context: ToolContext) => {
    try {
      return sameSources(capturedSources, scope.currentSources()) && scope.stagedIsCurrent() && !context.signal.aborted &&
        (!scope.actionRegister || (scope.actionRegister.predecessorFacts() &&
          scope.actionRegister.current().predecessor.envelopeDigest === accepted?.predecessor.envelopeDigest)) &&
        (!scope.observation || institutionalBriefDigest(canonicalBytes(scope.observation.current())) === observationDigest) &&
        (!scope.findings || institutionalBriefDigest(canonicalBytes(scope.findings.current())) === findingsDigest);
    } catch { return false; }
  };
  const fresh = async (context: ToolContext) => Boolean(context.agentId && context.agentLabel === selection.label &&
    context.root === scope.root && !context.signal.aborted && await scope.bindingIsCurrent() && currentFacts(context));
  const project = (raw: Record<string, unknown>) => {
    const draft = approvedFindings ? prepareInstitutionalFindings(raw, scope.binding, sources, approvedFindings)
      : approvedObservation ? prepareInstitutionalObservation(raw, scope.binding, sources, approvedObservation)
      : accepted ? prepareInstitutionalActionRegister(raw, scope.binding, sources, accepted)
      : prepareInstitutionalBrief(raw, scope.binding, sources);
    draft.review.sources.forEach(Object.freeze);
    Object.freeze(draft.review.sources);
    if (draft.review.kind === 'action-register') Object.freeze(draft.review.predecessor);
    if (draft.review.kind === 'observation' && draft.review.correction) {
      draft.review.correction.evidence.forEach(Object.freeze);
      Object.freeze(draft.review.correction.evidence);
      Object.freeze(draft.review.correction);
    }
    if (draft.review.kind === 'findings') {
      draft.review.observation.sources.forEach(Object.freeze);
      Object.freeze(draft.review.observation.sources);
      Object.freeze(draft.review.observation);
      draft.review.objective.evidence.forEach(Object.freeze);
      Object.freeze(draft.review.objective.evidence);
      Object.freeze(draft.review.objective);
      Object.freeze(draft.review.reasoningReview);
      Object.freeze(draft.review.requiredApproval);
    }
    Object.freeze(draft.review);
    return Object.freeze(draft);
  };
  const read: AgentTool<string> = {
    name: readEvidence, description: 'Read the admitted text spans of one fictional evidence source by ID.',
    parameters: exactSchema({ sourceId: { ...line, enum: quoteSources.map((source) => source.id) } }), capability: 'read',
    // The admitted extracts are in memory and have no workspace path.
    manifest: declareManifest({ tool: readEvidence, effects: [{ verb: 'plan' }], contexts: INTERACTIVE_ONLY }),
    fixtureGate: () => ({ policyHash, currentActionSettings, effect: { verb: 'plan' } }),
    parse(raw) {
      if (Object.keys(raw).length !== 1 || typeof raw.sourceId !== 'string' || !quoteSources.some((source) => source.id === raw.sourceId)) throw new ToolError('This evidence is unavailable.');
      return raw.sourceId;
    },
    title: () => 'Read admitted brief evidence',
    async forbidden(_id, context) { return await fresh(context) ? undefined : stale; },
    async run(id, context) {
      if (!await fresh(context)) throw new ToolError(stale);
      const quote = () => {
        if (!context.verifyFixtureGate?.(id) ||
            (accepted && (!currentFacts(context) || !scope.actionRegister?.predecessorAtEffect(accepted.predecessor.version))) ||
            (approvedObservation && (!currentFacts(context) || !scope.observation?.correctionAtEffect(approvedObservation.correction))) ||
            (approvedFindings && (!currentFacts(context) || !scope.findings?.predecessorAtEffect(approvedFindings.observation.version)))) throw new ToolError(stale);
        const source = quoteSources.find((candidate) => candidate.id === id)!;
        return JSON.stringify({ id, revision: source.revision, date: source.date, label: source.label,
          ...(source.dissentAttribution ? { dissentAttribution: source.dissentAttribution } : {}),
          spans: source.spans.map(({ start, end }) => ({ start, end, quote: source.text.slice(start, end) })),
        });
      };
      return accepted || approvedObservation || approvedFindings ? scope.withStableParents(async () => quote()) : quote();
    },
  };
  const save: AgentTool<PreparedInstitutionalDraft> = {
    name: saveDraft, description: approvedFindings ? 'Save cited fictional office-hours candidate findings for independent human validation.'
      : approvedObservation ? 'Save one cited fictional office-hours observation for human review.'
      : accepted ? 'Save one cited fictional office-hours action register for human review.' : 'Save one cited CG-07 decision brief as a local draft for human review.',
    parameters: approvedFindings ? findingsSchema : approvedObservation ? observationSchema : accepted ? actionRegisterSchema : briefSchema, capability: 'workspaceWrite',
    manifest: declareManifest({ tool: saveDraft, effects: [{ verb: 'workspaceWrite', paths: [fromArgument('draftPath')] }], contexts: INTERACTIVE_ONLY }),
    fixtureGate: (draft) => ({ policyHash, currentActionSettings, effect: { verb: 'workspaceWrite', path: draft.path } }),
    parse: project,
    title: () => approvedFindings ? 'Save local candidate findings draft' : approvedObservation ? 'Save local observation draft' : accepted ? 'Save local action register draft' : 'Save local decision brief draft',
    async forbidden(draft, context) {
      if (!await fresh(context)) return stale;
      return store.verify(scope, draft).then(() => undefined, () => stale);
    },
    async run(draft, context) {
      if (!await fresh(context) || !context.verifyFixtureGate?.(draft, draft.path)) throw new ToolError(stale);
      return JSON.stringify({ state: 'draft', review: await store.commit(scope, draft,
        () => currentFacts(context) && Boolean(context.verifyFixtureGate?.(draft, draft.path))) });
    },
  };
  return [read, save];
}

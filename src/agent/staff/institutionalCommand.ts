import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  institutionalBriefDigest, institutionalBriefDirectory, institutionalBriefMaxBytes, institutionalSourceHash, prepareInstitutionalActionRegister, prepareInstitutionalBrief,
  validateInstitutionalBriefSource, verifyInstitutionalActionAcceptance, type InstitutionalActionAuthority, type InstitutionalBriefSource,
  type InstitutionalDraftReview, type InstitutionalDraftScope, type PreparedInstitutionalDraft,
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
export type InstitutionalRoleId = typeof INSTITUTIONAL_COMMAND_GROUP_TEAM | typeof INSTITUTIONAL_J3_ACTION_REGISTER_TEAM;

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
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J3_ACTION_REGISTER_TEAM, fixture.actionAuthority);
}

async function selectSyntheticInstitutionalRole(fixture: InstitutionalCommandFixture, teamId: InstitutionalRoleId, authority?: InstitutionalActionRegisterFixture['actionAuthority']): Promise<TeamDefinition> {
  const exact = await captureInstitutionalBinding(fixture.root, teamId);
  if (!readInstitutionalRoleBinding(fixture.readStaged(), exact) || typeof fixture.withStableParents !== 'function' ||
      typeof fixture.currentSources !== 'function' || typeof fixture.currentActionSettings !== 'function' || !fixture.runId || !fixture.model ||
      !/^[a-f0-9]{64}$/.test(fixture.policyHash) || (teamId === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM && !authority)) throw new ToolError(stale);
  const role = institutionalRole(teamId);
  const team = parseTeam(role.definition, `${teamId}.md`);
  for (const member of team.members) {
    // Keep the staged definition bytes stable. Only the selected fixture supplies the explicit tool list.
    member.tools = [role.read, role.save];
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
      predecessorAtEffect: (version) => version === previous.version && predecessorFacts() && exactCommandGroupLeaf(fixture.root, version),
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
  fixtureSelections.set(team, { fixture: provider, scope: Object.freeze({
    root: fixture.root, binding, withStableParents: fixture.withStableParents, currentSources, stagedIsCurrent,
    ...(actionRegister ? { actionRegister } : {}),
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
function exactCommandGroupLeaf(root: string, version: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(version)) return false;
  const file = path.join(root, institutionalBriefDirectory, `${version}.json`);
  try {
    if (realpathSync(file) !== file) return false;
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.size > institutionalBriefMaxBytes) return false;
    const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return false;
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(descriptor, bytes, count, bytes.length - count, count);
        if (read === 0) break;
        count += read;
      }
      const after = lstatSync(file, { bigint: true });
      return after.isFile() && after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
        after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs && BigInt(count) === before.size &&
        institutionalBriefDigest(bytes.subarray(0, count)) === version;
    } finally { closeSync(descriptor); }
  } catch { return false; }
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
  if (!await scope.bindingIsCurrent() || (scope.actionRegister && !await scope.actionRegister.predecessorCurrent())) throw new ToolError(stale);
  const accepted = scope.actionRegister?.current();
  const { read: readEvidence, save: saveDraft } = role;
  const sources = structuredClone(scope.currentSources());
  const capturedSources = sourceHashes(sources);
  const currentFacts = (context: ToolContext) => {
    try {
      return sameSources(capturedSources, scope.currentSources()) && scope.stagedIsCurrent() && !context.signal.aborted &&
        (!scope.actionRegister || (scope.actionRegister.predecessorFacts() &&
          scope.actionRegister.current().predecessor.envelopeDigest === accepted?.predecessor.envelopeDigest));
    } catch { return false; }
  };
  const fresh = async (context: ToolContext) => Boolean(context.agentId && context.agentLabel === selection.label &&
    context.root === scope.root && !context.signal.aborted && await scope.bindingIsCurrent() && currentFacts(context));
  const project = (raw: Record<string, unknown>) => {
    const draft = accepted
      ? prepareInstitutionalActionRegister(raw, scope.binding, sources, accepted)
      : prepareInstitutionalBrief(raw, scope.binding, sources);
    draft.review.sources.forEach(Object.freeze);
    Object.freeze(draft.review.sources);
    if (draft.review.kind === 'action-register') Object.freeze(draft.review.predecessor);
    Object.freeze(draft.review);
    return Object.freeze(draft);
  };
  const read: AgentTool<string> = {
    name: readEvidence, description: 'Read the admitted text spans of one fictional evidence source by ID.',
    parameters: exactSchema({ sourceId: { ...line, enum: sources.map((source) => source.id) } }), capability: 'read',
    // The admitted extracts are in memory and have no workspace path.
    manifest: declareManifest({ tool: readEvidence, effects: [{ verb: 'plan' }], contexts: INTERACTIVE_ONLY }),
    fixtureGate: () => ({ policyHash, currentActionSettings, effect: { verb: 'plan' } }),
    parse(raw) {
      if (Object.keys(raw).length !== 1 || typeof raw.sourceId !== 'string' || !sources.some((source) => source.id === raw.sourceId)) throw new ToolError('This evidence is unavailable.');
      return raw.sourceId;
    },
    title: () => 'Read admitted brief evidence',
    async forbidden(_id, context) { return await fresh(context) ? undefined : stale; },
    async run(id, context) {
      if (!await fresh(context)) throw new ToolError(stale);
      const quote = () => {
        if (!context.verifyFixtureGate?.(id) ||
            (accepted && (!currentFacts(context) || !scope.actionRegister?.predecessorAtEffect(accepted.predecessor.version)))) throw new ToolError(stale);
        const source = sources.find((candidate) => candidate.id === id)!;
        return JSON.stringify({ id, revision: source.revision, date: source.date, label: source.label,
          ...(source.dissentAttribution ? { dissentAttribution: source.dissentAttribution } : {}),
          spans: source.spans.map(({ start, end }) => ({ start, end, quote: source.text.slice(start, end) })),
        });
      };
      return accepted ? scope.withStableParents(async () => quote()) : quote();
    },
  };
  const save: AgentTool<PreparedInstitutionalDraft> = {
    name: saveDraft, description: accepted ? 'Save one cited fictional office-hours action register for human review.' : 'Save one cited CG-07 decision brief as a local draft for human review.',
    parameters: accepted ? actionRegisterSchema : briefSchema, capability: 'workspaceWrite',
    manifest: declareManifest({ tool: saveDraft, effects: [{ verb: 'workspaceWrite', paths: [fromArgument('draftPath')] }], contexts: INTERACTIVE_ONLY }),
    fixtureGate: (draft) => ({ policyHash, currentActionSettings, effect: { verb: 'workspaceWrite', path: draft.path } }),
    parse: project,
    title: () => accepted ? 'Save local action register draft' : 'Save local decision brief draft',
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

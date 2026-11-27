import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  institutionalSourceHash, prepareInstitutionalBrief, validateInstitutionalBriefSource, type InstitutionalBriefReview,
  type InstitutionalBriefSource, type InstitutionalDraftScope, type PreparedInstitutionalBrief,
} from '../../domain/staff/institutionalBrief';
import { parseTeam, renderTeam, teamAgents, type TeamDefinition } from '../teams';
import { declareManifest, fromArgument, INTERACTIVE_ONLY, type AgentTool, type ToolContext } from '../tools';
import { ToolError } from '../workspace';

export const INSTITUTIONAL_COMMAND_GROUP_TEAM = 'institutional-command-group-v1';
export const INSTITUTIONAL_COMMAND_GROUP_NAME = 'Institutional Command Group';
export const INSTITUTIONAL_COMMAND_GROUP_PROFILE = 'Canadian brigade (L3)';
export const INSTITUTIONAL_COMMAND_GROUP_LEAD = 'Command Group lead';
export const INSTITUTIONAL_COMMAND_GROUP_MEMBER = 'command-brief-drafter';
const readEvidence = 'ReadInstitutionalBriefEvidence';
const saveDraft = 'SaveInstitutionalBriefDraft';
const institutionalTools = [readEvidence, saveDraft];

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

export function institutionalDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface InstitutionalCommandGroupBinding {
  readonly version: 1;
  readonly echelon: 'L3';
  readonly rootDigest: string;
  readonly directoryDigest: string;
  readonly team: typeof INSTITUTIONAL_COMMAND_GROUP_TEAM;
  readonly teamDigest: string;
  readonly skillDigest: string;
}

export function institutionalCommandGroupBinding(canonicalRoot: string, directoryDigest: string): InstitutionalCommandGroupBinding {
  return {
    version: 1,
    echelon: 'L3',
    rootDigest: institutionalDigest(canonicalRoot),
    directoryDigest,
    team: INSTITUTIONAL_COMMAND_GROUP_TEAM,
    teamDigest: institutionalDigest(institutionalCommandGroupDefinition),
    skillDigest: institutionalDigest(institutionalCommandGroupSkill),
  };
}

/** Checks the exact setup-owned binding. Matching metadata is not run authority. */
export function readInstitutionalCommandGroupBinding(value: unknown, expected: InstitutionalCommandGroupBinding): InstitutionalCommandGroupBinding | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(expected) as Array<keyof InstitutionalCommandGroupBinding>;
  if (Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field) || record[field] !== expected[field])) return undefined;
  return expected;
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

const fixtureSelections = new WeakMap<TeamDefinition, { readonly fixture: InstitutionalCommandFixture; readonly scope: InstitutionalDraftScope }>();
const stale = 'The institutional command fixture no longer matches the staged project, source or run.';

async function captureInstitutionalBinding(root: string): Promise<InstitutionalCommandGroupBinding> {
  if (path.resolve(root) !== root || await realpath(root) !== root) throw new ToolError(stale);
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new ToolError(stale);
  return institutionalCommandGroupBinding(root, institutionalDigest(`${info.dev}:${info.ino}:${info.birthtimeNs}`));
}

export async function selectSyntheticInstitutionalCommandGroup(fixture: InstitutionalCommandFixture): Promise<TeamDefinition> {
  const exact = await captureInstitutionalBinding(fixture.root);
  if (!readInstitutionalCommandGroupBinding(fixture.readStaged(), exact) || typeof fixture.withStableParents !== 'function' ||
      typeof fixture.currentSources !== 'function' || typeof fixture.currentActionSettings !== 'function' || !fixture.runId || !fixture.model || !/^[a-f0-9]{64}$/.test(fixture.policyHash)) throw new ToolError(stale);
  const team = parseTeam(institutionalCommandGroupDefinition, `${INSTITUTIONAL_COMMAND_GROUP_TEAM}.md`);
  for (const member of team.members) {
    // Keep the already staged definition bytes stable. Only the trusted
    // selected fixture supplies the explicit tool list to the runtime team.
    member.tools = [...institutionalTools];
    Object.freeze(member.tools);
    Object.freeze(member);
  }
  Object.freeze(team.members);
  Object.freeze(team);
  const binding = Object.freeze({ project: exact.rootDigest, directory: exact.directoryDigest, team: exact.team, teamVersion: exact.teamDigest, skillVersion: exact.skillDigest });
  const provider = Object.freeze({ ...fixture });
  const stagedIsCurrent = () => Boolean(readInstitutionalCommandGroupBinding(provider.readStaged(), exact));
  fixtureSelections.set(team, { fixture: provider, scope: Object.freeze({
    root: fixture.root, binding, withStableParents: fixture.withStableParents,
    currentSources: () => admitted(provider.currentSources(), binding.project),
    stagedIsCurrent,
    bindingIsCurrent: async () => {
      const sampled = await captureInstitutionalBinding(provider.root);
      return sampled.directoryDigest === exact.directoryDigest && stagedIsCurrent();
    },
  }) });
  return team;
}

export function selectedInstitutionalScope(team: TeamDefinition): InstitutionalDraftScope | undefined {
  return fixtureSelections.get(team)?.scope;
}

export function selectedTeamAgents(team: TeamDefinition | undefined): ReturnType<typeof teamAgents> {
  if (!team || (team.slug === INSTITUTIONAL_COMMAND_GROUP_TEAM && !fixtureSelections.has(team))) return [];
  return teamAgents(team);
}

function admitted(current: readonly InstitutionalBriefSource[], project: string): readonly InstitutionalBriefSource[] {
  if (!Array.isArray(current) || current.length < 1 || current.length > 12 || current.some((source) => !validateInstitutionalBriefSource(source, project)) ||
      new Set(current.map((source) => source.id)).size !== current.length) throw new ToolError(stale);
  return current;
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

export async function institutionalChildTools(
  team: TeamDefinition | undefined, selection: { root: string; runId: string; label: string; model: string; local: boolean; onTeam: boolean; detached: boolean },
  store: {
    verify: (scope: InstitutionalDraftScope, draft: PreparedInstitutionalBrief) => Promise<void>;
    commit: (scope: InstitutionalDraftScope, draft: PreparedInstitutionalBrief, verifyBeforeInstall: () => boolean) => Promise<InstitutionalBriefReview>;
  },
): Promise<[AgentTool<string>, AgentTool<PreparedInstitutionalBrief>] | undefined> {
  if (!team || team.slug !== INSTITUTIONAL_COMMAND_GROUP_TEAM) return undefined;
  const selected = fixtureSelections.get(team);
  if (!selected || !selection.local || !selection.onTeam || selection.detached || selection.label !== INSTITUTIONAL_COMMAND_GROUP_MEMBER ||
      selected.scope.root !== selection.root || selected.fixture.runId !== selection.runId || selected.fixture.model !== selection.model) throw new ToolError(stale);
  const { scope, fixture: { policyHash, currentActionSettings } } = selected;
  if (!await scope.bindingIsCurrent()) throw new ToolError(stale);
  const sources = structuredClone(scope.currentSources());
  const currentMatches = () => {
    const current = scope.currentSources();
    return sources.length === current.length && sources.every((source) =>
      current.some((entry) => source.id === entry.id && institutionalSourceHash(source) === institutionalSourceHash(entry)));
  };
  const currentFacts = (context: ToolContext) => currentMatches() && scope.stagedIsCurrent() && !context.signal.aborted;
  const fresh = async (context: ToolContext) => Boolean(context.agentId && context.agentLabel === selection.label &&
    context.root === scope.root && !context.signal.aborted && await scope.bindingIsCurrent() && currentFacts(context));
  const project = (raw: Record<string, unknown>) => {
    const draft = prepareInstitutionalBrief(raw, scope.binding, sources);
    draft.review.sources.forEach(Object.freeze);
    Object.freeze(draft.review.sources);
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
      if (!await fresh(context) || !context.verifyFixtureGate?.(id)) throw new ToolError(stale);
      const source = sources.find((candidate) => candidate.id === id)!;
      return JSON.stringify({ id, revision: source.revision, date: source.date, label: source.label,
        ...(source.dissentAttribution ? { dissentAttribution: source.dissentAttribution } : {}),
        spans: source.spans.map(({ start, end }) => ({ start, end, quote: source.text.slice(start, end) })),
      });
    },
  };
  const save: AgentTool<PreparedInstitutionalBrief> = {
    name: saveDraft, description: 'Save one cited CG-07 decision brief as a local draft for human review.',
    parameters: briefSchema, capability: 'workspaceWrite',
    manifest: declareManifest({ tool: saveDraft, effects: [{ verb: 'workspaceWrite', paths: [fromArgument('draftPath')] }], contexts: INTERACTIVE_ONLY }),
    fixtureGate: (draft) => ({ policyHash, currentActionSettings, effect: { verb: 'workspaceWrite', path: draft.path } }),
    parse: project,
    title: () => 'Save local decision brief draft',
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

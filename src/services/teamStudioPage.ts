import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PROJECT_TYPES, projectTypeTeam, type ProjectType } from '../agent/projectTypes';
import { checkDraft, draftFromMarkdown, lineDiff, type DiffLine, type DraftIssue, type DraftMember, type TeamDraft } from '../agent/teamMarkdown';
import { DEFAULT_TOOLS, parseTeam, recommendedProjectTeam, slugify, TeamLibrary, type TeamDefinition } from '../agent/teams';
import type { AgentDiscoveryAnswers } from '../domain/agents';
import { buildToolsDirectory, firstSentence, PRIVACY_TEXT, privacyOf, resolveAgentModel, type DirectoryInput, type DirectoryModel, type ToolStatus, type ToolsDirectory } from './toolsDirectory';

// NEAR AI Team Studio: a guided, visual way to build and manage agent teams. The team Markdown
// files stay the source of truth; the studio reads them, writes them through TeamLibrary (so
// every save is a version and nothing is ever hard-deleted), and computes models and permissions
// from the same sources the Tools page and a run use. No VS Code imports, so the tests run it
// directly.

export type StudioTarget = 'project' | 'user';

export interface StudioTool { name: string; description: string; capability: string; status: ToolStatus; statusText: string }
export interface StudioRole { id: string; label: string; description: string; source: 'team' | 'gsd'; suggestion: string; tools: string[] | null; model: string }
export interface StudioStartingPoint { id: string; group: 'recommend' | 'project-type' | 'gsd' | 'empty'; label: string; description: string; members: string[] }

export interface StudioContext {
  hasProject: boolean;
  knowledgeBase: boolean;
  policy: ToolsDirectory['policy'];
  tools: StudioTool[];
  roles: StudioRole[];
  tiers: { main: string; deep: string; standard: string; fast: string };
  models: DirectoryModel[];
  modelsProblem?: string;
  startingPoints: StudioStartingPoint[];
  /** The tools a member gets without a `tools:` line. */
  defaultTools: string[];
}

export interface StudioMemberModel { tier: string; model: string; privacy: DirectoryModel['privacy']; privacyText: string; available?: boolean }
export interface LibraryTeam { id: string; kind: 'project' | 'user'; name: string; description: string; command?: string; file: string; savedAt?: string; error?: string; members: Array<{ name: string; role?: string } & StudioMemberModel> }
export interface LibraryArchived { id: string; name: string; file: string; savedAt?: string }
export interface LibraryState { teams: LibraryTeam[]; archived: LibraryArchived[] }

export interface StudioReview { markdown: string; errors: DraftIssue[]; warnings: DraftIssue[]; members: StudioMemberModel[] }

const READ = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall', 'Remember'];
const WEB = ['WebSearch', 'WebFetch', 'CheckCitations'];
const WRITE = ['Write', 'Edit'];
const DOCS = ['CreatePresentation', 'RenderSvg', 'VectorizeImage'];

/** General team roles with suggested instructions; Open-GSD agent roles are added from the installed library. */
const TEAM_ROLES: Array<Omit<StudioRole, 'source'>> = [
  { id: 'planner', label: 'Planner', model: 'standard', tools: READ, description: 'Breaks the work into small, verifiable steps. Does not change files.', suggestion: 'Read the relevant code and break the task into small, verifiable steps. Do not change files. Report the plan with the files each step touches.' },
  { id: 'implementer', label: 'Implementer', model: 'deep', tools: null, description: 'Makes the changes and runs the tests.', suggestion: 'Make the changes in the plan, matching the project\'s style. Run the relevant tests and fix what you broke. Report what changed and how you verified it.' },
  { id: 'reviewer', label: 'Reviewer', model: 'standard', tools: [...READ, 'Bash'], description: 'Reviews changes and reports concrete findings. Does not edit.', suggestion: 'Review the changes for correctness, regressions, and missing tests. Report concrete findings with file:line, most severe first. Do not edit files.' },
  { id: 'tester', label: 'Tester', model: 'standard', tools: [...READ, ...WRITE, 'Bash'], description: 'Tests the change as a user would and adds missing tests.', suggestion: 'Test the change as a user would: run the test suite, add missing tests for the acceptance criteria and edge cases, and try the feature end to end. Report what passed, what failed with exact output, and gaps in coverage.' },
  { id: 'security', label: 'Security', model: 'deep', tools: [...READ, 'Bash', 'SecurityScan', 'WebFetch'], description: 'Looks for vulnerabilities and unsafe dependencies. Does not edit.', suggestion: 'Check the change for vulnerabilities: input handling, authentication and authorization, secrets, injection, unsafe dependencies (run SecurityScan), and data exposure. Report findings with severity and a fix. Do not edit files.' },
  { id: 'researcher', label: 'Researcher', model: 'deep', tools: [...READ, ...WEB, 'Write'], description: 'Investigates questions and records sources.', suggestion: 'Investigate the question: search widely, read primary sources with WebFetch, and record each finding with its URL, date, and the exact supporting passage. Note where sources disagree.' },
  { id: 'analyst', label: 'Analyst', model: 'deep', tools: [...READ, ...WRITE], description: 'Weighs the findings and states conclusions with confidence.', suggestion: 'Collate the findings: identify the key facts, trends, and open questions; weigh conflicting evidence; and state your confidence explicitly. Write the analysis to the place the task names.' },
  { id: 'writer', label: 'Writer', model: 'standard', tools: [...READ, ...WRITE, ...DOCS], description: 'Drafts documents in the project\'s tone and format.', suggestion: 'Draft the document from the material you are given, in the tone and format the project asks for. Never add facts that are not in your sources. Report what you wrote and where.' },
  { id: 'editor', label: 'Editor', model: 'standard', tools: [...READ, 'CheckCitations'], description: 'Edits for accuracy, clarity, and structure. Does not rewrite.', suggestion: 'Edit the draft for accuracy, clarity, tone, and structure. Confirm that citations support the sentences they are attached to. Report required changes; do not rewrite the document yourself.' },
  { id: 'red-team', label: 'Red team', model: 'deep', tools: [...READ, 'Bash', 'Write'], description: 'Attacks the work like an adversary before it is verified.', suggestion: 'Attack the work like an adversary before it is verified: find bugs, holes, unhandled edge cases, wrong assumptions, and weak tests. Prove what you can. Report the findings, numbered with severity and evidence. Do not fix anything yourself.' }
];

/** Starting points built from Open-GSD agent roles. Each member's role names the Open-GSD agent it is modelled on. */
const GSD_TEMPLATES: Array<{ id: string; label: string; description: string; members: Array<{ name: string; role: string; model: string; tools: string[] | null; fallback: string }> }> = [
  { id: 'research', label: 'Research', description: 'Investigate a question, synthesize the findings, and check them.', members: [
    { name: 'researcher', role: 'gsd-phase-researcher', model: 'standard', tools: [...READ, ...WEB, 'Write'], fallback: 'Research how to approach the task: read the code and primary sources, and record each finding with where it came from.' },
    { name: 'synthesizer', role: 'gsd-research-synthesizer', model: 'fast', tools: [...READ, 'Write'], fallback: 'Combine the research notes into one summary with the decisions it supports and the open questions.' },
    { name: 'checker', role: 'gsd-verifier', model: 'standard', tools: [...READ, ...WEB], fallback: 'Check the summary against its sources and report anything unsupported or contradicted.' }] },
  { id: 'build-test', label: 'Build & test', description: 'Plan a change, implement it, and verify it works.', members: [
    { name: 'planner', role: 'gsd-planner', model: 'deep', tools: READ, fallback: 'Create a plan with small, verifiable tasks, the files each touches, and how each will be checked.' },
    { name: 'executor', role: 'gsd-executor', model: 'deep', tools: null, fallback: 'Carry out the plan task by task with small commits, running the tests as you go.' },
    { name: 'verifier', role: 'gsd-verifier', model: 'standard', tools: [...READ, 'Bash'], fallback: 'Verify that the result meets the goal: run the checks and report what is shown to work and what is not.' }] },
  { id: 'review', label: 'Review', description: 'Independent code, security, and integration review.', members: [
    { name: 'code-reviewer', role: 'gsd-code-reviewer', model: 'standard', tools: [...READ, 'Bash'], fallback: 'Review the changed files for bugs, security issues, and code quality problems. Report findings by severity with file:line.' },
    { name: 'security-auditor', role: 'gsd-security-auditor', model: 'deep', tools: [...READ, 'Bash', 'SecurityScan'], fallback: 'Check that the threats the work faces are mitigated in the code. Report open threats with evidence.' },
    { name: 'integration-checker', role: 'gsd-integration-checker', model: 'standard', tools: [...READ, 'Bash'], fallback: 'Check that the parts connect: follow each user flow end to end and report breaks.' }] },
  { id: 'writing', label: 'Writing', description: 'Write documentation and check it against the code.', members: [
    { name: 'doc-writer', role: 'gsd-doc-writer', model: 'standard', tools: [...READ, ...WRITE, ...DOCS], fallback: 'Write or update the documentation the task asks for, matching the project\'s existing docs.' },
    { name: 'doc-verifier', role: 'gsd-doc-verifier', model: 'standard', tools: [...READ, 'Bash'], fallback: 'Check every factual claim in the documentation against the code and report what is wrong.' }] },
  { id: 'analysis', label: 'Analysis', description: 'Map the codebase and surface assumptions and patterns.', members: [
    { name: 'mapper', role: 'gsd-codebase-mapper', model: 'fast', tools: [...READ, 'Write'], fallback: 'Explore the codebase and write a structured summary of its architecture, conventions, and concerns.' },
    { name: 'assumptions', role: 'gsd-assumptions-analyzer', model: 'standard', tools: READ, fallback: 'List the assumptions the task depends on, with the evidence for each from the code.' },
    { name: 'patterns', role: 'gsd-pattern-mapper', model: 'fast', tools: READ, fallback: 'Find the closest existing patterns in the codebase for the new work and say where each lives.' }] }
];

function studioTools(directory: ToolsDirectory): StudioTool[] {
  return directory.tools.map((tool) => ({ name: tool.name, description: tool.description, capability: tool.capability, status: tool.status, statusText: tool.statusText }));
}

/** Everything the studio's pickers need, computed from the Tools directory (the same sources a run uses). */
export function buildStudioContext(input: DirectoryInput, options: { hasProject: boolean; knowledgeBase: boolean }): StudioContext {
  const directory = buildToolsDirectory(input);
  const tools = studioTools(directory);
  const known = new Set(tools.map((tool) => tool.name));
  const gsdRoles: StudioRole[] = directory.agents.map((agent) => {
    const own = agent.tools.filter((tool) => known.has(tool));
    return { id: agent.name, label: agent.name, source: 'gsd', description: firstSentence(agent.description), model: agent.tier === 'model' || agent.tier === 'inherit' ? '' : agent.tier, tools: own.length ? own : null,
      suggestion: `Work as the Open-GSD ${agent.name} agent: ${firstSentence(agent.description)}\n\nStay within the task you are given, and finish with a short report of what you did and how you checked it.` };
  });
  const gsdDescription = (role: string) => directory.agents.find((agent) => agent.name === role)?.description;
  return {
    hasProject: options.hasProject,
    knowledgeBase: options.knowledgeBase,
    policy: directory.policy,
    tools,
    defaultTools: [...DEFAULT_TOOLS],
    roles: [...TEAM_ROLES.map((role) => ({ ...role, source: 'team' as const })), ...gsdRoles],
    tiers: { main: input.settings.mainModel, ...input.settings.tiers },
    models: directory.models,
    ...(directory.modelsProblem ? { modelsProblem: directory.modelsProblem } : {}),
    startingPoints: [
      { id: 'recommend', group: 'recommend', label: 'Recommend a team for me', description: 'Answer three questions about the work and its risk; the studio suggests a team sized to it.', members: [] },
      ...PROJECT_TYPES.map((type) => ({ id: `type:${type.id}`, group: 'project-type' as const, label: type.label, description: type.description, members: type.members.map((member) => member.name) })),
      ...GSD_TEMPLATES.map((template) => ({ id: `gsd:${template.id}`, group: 'gsd' as const, label: template.label, description: `${template.description}${gsdDescription(template.members[0].role) ? '' : ' (Open-GSD roles; installs with your first workflow.)'}`, members: template.members.map((member) => member.name) })),
      { id: 'empty', group: 'empty', label: 'Start empty', description: 'Add every member yourself.', members: [] }
    ]
  };
}

function catalogEntry(input: DirectoryInput, model: string) {
  return input.models?.find((candidate) => candidate.id === model);
}

/** The model a member actually runs on, resolved the way a run resolves it, with its privacy. */
export function memberModel(member: { name: string; model?: string }, input: DirectoryInput): StudioMemberModel {
  const resolved = resolveAgentModel(member.name, member.model?.trim() || undefined, input, true);
  const entry = catalogEntry(input, resolved.model);
  const privacy = entry ? privacyOf(entry) : 'unknown';
  return { tier: resolved.tier, model: resolved.model, privacy, privacyText: entry?.forwardedTo && privacy === 'forwarded' ? `Forwarded to ${entry.forwardedTo}: not private` : PRIVACY_TEXT[privacy], ...(input.models ? { available: Boolean(entry) } : {}) };
}

/** What saving the draft would write, and what is wrong with it: the round trip, models, privacy, and tools. */
export function reviewDraft(draft: TeamDraft, original: string | undefined, input: DirectoryInput, context: Pick<StudioContext, 'knowledgeBase' | 'tools'>): StudioReview {
  const { markdown, errors } = checkDraft(draft, original);
  const warnings: DraftIssue[] = [];
  const known = new Set(context.tools.map((tool) => tool.name));
  const members = draft.members.map((member, index) => {
    const label = member.name || `Member ${index + 1}`;
    const model = memberModel(member, input);
    const value = member.model.trim();
    if (value && model.tier === 'inherit' && !/^(?:inherit|default)$/i.test(value)) warnings.push({ member: index, field: 'model', message: `${label}: "${value}" is not a tier (deep, standard, fast) or a model ID, so this member uses the main model.` });
    if (model.available === false) {
      if (value.includes('/')) errors.push({ member: index, field: 'model', message: `${label}: ${value} is not in your key's model list. Pick another model.` });
      else warnings.push({ member: index, field: 'model', message: `${label}: ${model.model} (${model.tier === 'inherit' ? 'the main model' : `the ${model.tier} tier`}) is not in your key's model list. Change the tier's setting or pick a model.` });
    }
    if (model.privacy === 'forwarded') (context.knowledgeBase ? errors : warnings).push({ member: index, field: 'model', message: context.knowledgeBase ? `${label}: this project has a knowledge base, so members must use a TEE or local model. ${model.model} is forwarded outside NEAR's TEE.` : `${label}: ${model.model} is forwarded outside NEAR's TEE, so its prompts and files are not private.` });
    else if (context.knowledgeBase && model.privacy === 'unknown' && input.models) warnings.push({ member: index, field: 'model', message: `${label}: this project has a knowledge base; the privacy of ${model.model} is unknown. Use a TEE or local model.` });
    const unknownTools = (member.tools ?? []).filter((tool) => !known.has(tool) && !/^mcp__/.test(tool));
    if (unknownTools.length) warnings.push({ member: index, field: 'tools', message: `${label}: ${unknownTools.join(', ')} ${unknownTools.length === 1 ? 'is not a built-in tool' : 'are not built-in tools'}; agents only get tools that exist.` });
    return model;
  });
  return { markdown, errors, warnings, members };
}

/** A starting point's members (and description) as a draft. */
export function startingPointDraft(request: { id: string; goal: string; locality: 'cloud' | 'local' | 'hybrid'; workShape?: AgentDiscoveryAnswers['workShape']; riskLevel?: AgentDiscoveryAnswers['riskLevel'] }, context: StudioContext): { draft: TeamDraft; projectType?: string } {
  const goal = request.goal.trim().slice(0, 400) || 'the work in this project';
  if (request.id === 'recommend') {
    const draft = draftFromMarkdown(recommendedProjectTeam({ goal, riskLevel: request.riskLevel ?? 'medium', preferredProvider: 'near-ai', locality: request.locality, workShape: request.workShape ?? 'feature' }), 'team.md');
    return { draft: { ...draft, name: '' } };
  }
  if (request.id.startsWith('type:')) {
    const type = PROJECT_TYPES.find((candidate) => `type:${candidate.id}` === request.id) as ProjectType;
    const draft = draftFromMarkdown(projectTypeTeam(type, goal, request.locality), 'team.md');
    return { draft: { ...draft, name: '' }, projectType: type.id };
  }
  if (request.id.startsWith('gsd:')) {
    const template = GSD_TEMPLATES.find((candidate) => `gsd:${candidate.id}` === request.id)!;
    const local = request.locality === 'local';
    return { draft: { name: '', description: `${template.description} Goal: ${goal}`.slice(0, 300), members: template.members.map((member): DraftMember => {
      const role = context.roles.find((candidate) => candidate.id === member.role && candidate.source === 'gsd');
      const tools = member.tools && local ? member.tools.filter((tool) => !WEB.includes(tool)) : member.tools;
      return { name: member.name, role: member.role, model: member.model, tools: tools ? [...tools] : null, instructions: `${role ? `${role.description} ` : ''}${member.fallback}\n\nProject goal: ${goal}` };
    }) } };
  }
  return { draft: { name: '', description: '', members: [] } };
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const exists = async (file: string) => Boolean(await stat(file).catch(() => undefined));
const mtime = async (file: string) => (await stat(file).catch(() => undefined))?.mtime.toISOString();

/** Every team the studio manages: the project team, the user's teams, and archived teams. */
export async function listLibrary(library: TeamLibrary, root: string | undefined, input: DirectoryInput): Promise<LibraryState> {
  const entries = await library.list(root);
  const teams = await Promise.all(entries.map(async (entry): Promise<LibraryTeam> => {
    const slug = slugify(path.basename(entry.file, '.md'));
    const team = entry.team;
    return {
      id: entry.project ? 'project' : `user:${slug}`, kind: entry.project ? 'project' : 'user', file: entry.file,
      name: team?.name ?? slug, description: team?.description ?? '',
      ...(team ? { command: `/team:${entry.project ? 'project' : team.slug} ` } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(await mtime(entry.file) ? { savedAt: await mtime(entry.file) } : {}),
      members: (team?.members ?? []).map((member) => ({ name: member.name, ...(member.role ? { role: member.role } : {}), ...memberModel(member, input) }))
    };
  }));
  const archived = await Promise.all((await library.archived()).map(async (file): Promise<LibraryArchived> => {
    const name = await readFile(file, 'utf8').then((text) => parseTeam(text, file).name, () => path.basename(file, '.md'));
    const savedAt = await mtime(file);
    return { id: `archived:${slugify(path.basename(file, '.md'))}`, name, file, ...(savedAt ? { savedAt } : {}) };
  }));
  return { teams, archived };
}

// ---- Messages from the page: strictly validated; anything else is ignored. ----

const TEAM_ID = /^(?:project|user:[a-z0-9][a-z0-9-]{0,60}|archived:[a-z0-9][a-z0-9-]{0,60})$/;
const VERSION_REF = /^[\w.-]{1,80}\.md$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const LOCALITIES = ['cloud', 'local', 'hybrid'] as const;
const WORK_SHAPES = ['feature', 'bugfix', 'refactor', 'research', 'release'] as const;
const RISKS = ['low', 'medium', 'high'] as const;

export type StudioMessage =
  | { type: 'ready' } | { type: 'refresh' } | { type: 'import' } | { type: 'discard-draft' } | { type: 'discard-kept' }
  /** Cancel or "All teams" in the guided builder with unsaved changes: the host asks Discard changes / Save draft. */
  | { type: 'leave-wizard'; wizard: SavedWizard }
  /** "All teams" in the editor with unsaved changes: the host asks Discard changes / Save. */
  | { type: 'leave-editor'; edit: OpenEdit }
  /** What is unsaved right now (nothing, the builder, or the editor), kept if the panel is closed. */
  | { type: 'unsaved'; wizard?: SavedWizard; edit?: OpenEdit }
  | { type: 'open' | 'duplicate' | 'export' | 'archive' | 'restore' | 'use-in-chat' | 'open-markdown' | 'versions'; id: string }
  | { type: 'version-view' | 'version-restore'; id: string; ref: string }
  | { type: 'review'; seq: number; draft: TeamDraft; id?: string }
  | { type: 'save'; draft: TeamDraft; id: string; base: string }
  | { type: 'create'; draft: TeamDraft; target: StudioTarget; projectType?: { id: string; goal: string } }
  | { type: 'save-draft'; draft: TeamDraft; step: number; target: StudioTarget; startingPoint?: string }
  | { type: 'starting-point'; id: string; goal: string; locality: 'cloud' | 'local' | 'hybrid'; workShape?: AgentDiscoveryAnswers['workShape']; riskLevel?: AgentDiscoveryAnswers['riskLevel'] }
  | { type: 'open-setting'; key: string };

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Plain, required: string[], optional: string[] = []) => required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

/** A draft from the page: exact keys, bounded sizes, plain strings; content rules are checked by reviewDraft. */
export function parseDraft(value: unknown): TeamDraft | undefined {
  if (!isPlain(value) || !exactKeys(value, ['name', 'description', 'members']) || !text(value.name, 120) || !text(value.description, 600) || !Array.isArray(value.members) || value.members.length > 12) return undefined;
  const members: DraftMember[] = [];
  for (const member of value.members) {
    if (!isPlain(member) || !exactKeys(member, ['name', 'role', 'model', 'tools', 'instructions']) || !text(member.name, 60) || !text(member.role, 120) || !text(member.model, 160) || !text(member.instructions, 12_000)) return undefined;
    if (member.tools !== null && (!Array.isArray(member.tools) || member.tools.length > 80 || !member.tools.every((tool) => typeof tool === 'string' && TOOL_NAME.test(tool)))) return undefined;
    members.push({ name: member.name, role: member.role, model: member.model, tools: member.tools === null ? null : [...new Set(member.tools as string[])], instructions: member.instructions });
  }
  return { name: value.name, description: value.description, members };
}

export function parseStudioMessage(value: unknown): StudioMessage | undefined {
  if (!isPlain(value) || typeof value.type !== 'string') return undefined;
  const message = value;
  const id = () => typeof message.id === 'string' && TEAM_ID.test(message.id);
  switch (message.type) {
    case 'ready': case 'refresh': case 'import': case 'discard-draft': case 'discard-kept':
      return exactKeys(message, ['type']) ? { type: message.type } : undefined;
    case 'leave-wizard': {
      const wizard = exactKeys(message, ['type', 'wizard']) ? savedWizard(message.wizard) : undefined;
      return wizard ? { type: 'leave-wizard', wizard } : undefined;
    }
    case 'leave-editor': {
      const edit = exactKeys(message, ['type', 'edit']) ? openEdit(message.edit) : undefined;
      return edit ? { type: 'leave-editor', edit } : undefined;
    }
    case 'unsaved': {
      if (!exactKeys(message, ['type'], ['wizard', 'edit']) || (message.wizard !== undefined && message.edit !== undefined)) return undefined;
      if (message.wizard !== undefined) { const wizard = savedWizard(message.wizard); return wizard ? { type: 'unsaved', wizard } : undefined; }
      if (message.edit !== undefined) { const edit = openEdit(message.edit); return edit ? { type: 'unsaved', edit } : undefined; }
      return { type: 'unsaved' };
    }
    case 'open': case 'duplicate': case 'export': case 'archive': case 'restore': case 'use-in-chat': case 'open-markdown': case 'versions':
      return exactKeys(message, ['type', 'id']) && id() ? { type: message.type, id: message.id as string } : undefined;
    case 'version-view': case 'version-restore':
      return exactKeys(message, ['type', 'id', 'ref']) && id() && typeof message.ref === 'string' && VERSION_REF.test(message.ref) ? { type: message.type, id: message.id as string, ref: message.ref } : undefined;
    case 'review': {
      if (!exactKeys(message, ['type', 'seq', 'draft'], ['id']) || !Number.isSafeInteger(message.seq) || (message.id !== undefined && !id())) return undefined;
      const draft = parseDraft(message.draft);
      return draft ? { type: 'review', seq: message.seq as number, draft, ...(message.id !== undefined ? { id: message.id as string } : {}) } : undefined;
    }
    case 'save': {
      if (!exactKeys(message, ['type', 'draft', 'id', 'base']) || !id() || !String(message.id).match(/^(?:project|user:)/) || typeof message.base !== 'string' || !/^[0-9a-f]{64}$/.test(message.base)) return undefined;
      const draft = parseDraft(message.draft);
      return draft ? { type: 'save', draft, id: message.id as string, base: message.base } : undefined;
    }
    case 'create': {
      if (!exactKeys(message, ['type', 'draft', 'target'], ['projectType']) || (message.target !== 'project' && message.target !== 'user')) return undefined;
      let projectType: { id: string; goal: string } | undefined;
      if (message.projectType !== undefined) {
        const candidate = message.projectType;
        if (!isPlain(candidate) || !exactKeys(candidate, ['id', 'goal']) || typeof candidate.id !== 'string' || !PROJECT_TYPES.some((type) => type.id === candidate.id) || !text(candidate.goal, 400)) return undefined;
        projectType = { id: candidate.id, goal: candidate.goal };
      }
      const draft = parseDraft(message.draft);
      return draft ? { type: 'create', draft, target: message.target, ...(projectType ? { projectType } : {}) } : undefined;
    }
    case 'save-draft': {
      if (!exactKeys(message, ['type', 'draft', 'step', 'target'], ['startingPoint']) || !Number.isInteger(message.step) || (message.step as number) < 0 || (message.step as number) > 4 || (message.target !== 'project' && message.target !== 'user')) return undefined;
      if (message.startingPoint !== undefined && (typeof message.startingPoint !== 'string' || !/^[a-z:-]{1,40}$/.test(message.startingPoint))) return undefined;
      const draft = parseDraft(message.draft);
      return draft ? { type: 'save-draft', draft, step: message.step as number, target: message.target, ...(message.startingPoint !== undefined ? { startingPoint: message.startingPoint as string } : {}) } : undefined;
    }
    case 'starting-point': {
      if (!exactKeys(message, ['type', 'id', 'goal', 'locality'], ['workShape', 'riskLevel']) || typeof message.id !== 'string' || !/^(?:recommend|empty|type:[a-z]+|gsd:[a-z-]+)$/.test(message.id) || !text(message.goal, 400)) return undefined;
      if (!(LOCALITIES as readonly unknown[]).includes(message.locality)) return undefined;
      if (message.workShape !== undefined && !(WORK_SHAPES as readonly unknown[]).includes(message.workShape)) return undefined;
      if (message.riskLevel !== undefined && !(RISKS as readonly unknown[]).includes(message.riskLevel)) return undefined;
      const known = message.id === 'recommend' || message.id === 'empty' || PROJECT_TYPES.some((type) => message.id === `type:${type.id}`) || GSD_TEMPLATES.some((template) => message.id === `gsd:${template.id}`);
      return known ? { type: 'starting-point', id: message.id, goal: message.goal as string, locality: message.locality as 'cloud', ...(message.workShape ? { workShape: message.workShape as 'feature' } : {}), ...(message.riskLevel ? { riskLevel: message.riskLevel as 'low' } : {}) } : undefined;
    }
    case 'open-setting':
      return exactKeys(message, ['type', 'key']) && typeof message.key === 'string' && /^nearAi\.(?:defaultModel|actionPolicy|agent\.(?:deepModel|standardModel|fastModel|roleModels))$/.test(message.key) ? { type: 'open-setting', key: message.key } : undefined;
    default:
      return undefined;
  }
}

// ---- The page controller ----

export interface StudioHost {
  webview: { postMessage(message: unknown): Thenable<boolean> | Promise<boolean>; onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void } };
  onDidDispose(listener: () => void): { dispose(): void };
}

export interface SavedWizard { draft: TeamDraft; step: number; target: StudioTarget; startingPoint?: string }
/** Unsaved changes to a team open in the editor: its id, the draft, and the file version it started from. */
export interface OpenEdit { id: string; draft: TeamDraft; base: string }
/**
 * What the studio kept when its panel was closed with unsaved work (VS Code cannot stop a panel
 * closing): the builder's draft (saved as the resumable draft), or an open team's changes.
 */
export type KeptWork = { kind: 'wizard'; name: string } | ({ kind: 'editor'; name: string } & OpenEdit);

export const KEPT_WIZARD_TEXT = 'Your unsaved team was kept as a draft. Resume it below, or discard it.';

export interface TeamStudioDeps {
  library: TeamLibrary;
  root?: string;
  gather(): Promise<DirectoryInput>;
  knowledgeBase(): Promise<boolean>;
  sidebar: { prefill(text: string): Promise<void> };
  openFile(file: string): Promise<unknown>;
  openSetting(key: string): Promise<unknown>;
  confirm(message: string, action: string): Promise<boolean>;
  ask(prompt: string, value: string): Promise<string | undefined>;
  pickExportTarget(defaultName: string): Promise<string | undefined>;
  pickImportSource(): Promise<string | undefined>;
  applyProjectType(root: string, type: ProjectType, goal: string): Promise<unknown>;
  drafts: { get(): unknown; set(value: SavedWizard | undefined): Promise<void> };
  /** A modal question; resolves to the action chosen, or undefined when dismissed. */
  choose?(message: string, ...actions: string[]): Promise<string | undefined>;
  /** Unsaved work kept when the panel was closed, shown the next time the studio opens. */
  kept?: { get(): unknown; set(value: KeptWork | undefined): Promise<void> };
  /** Team files changed on disk (by an editor, git, or another window). */
  watch(listener: (file: string) => void): { dispose(): void };
  onDidChangeSettings?(listener: () => void): { dispose(): void };
}

interface OpenTeam { id: string; file: string; text: string; base: string }

/** Wires the studio page to the team library. Returns refresh/dispose for the host and the tests. */
export function attachTeamStudio(host: StudioHost, deps: TeamStudioDeps): { refresh(): Promise<void>; startWizard(target: StudioTarget): Promise<void>; dispose(): void; ready: Promise<void> } {
  let input: DirectoryInput | undefined;
  let context: StudioContext | undefined;
  let library: LibraryState = { teams: [], archived: [] };
  let open: OpenTeam | undefined;
  let pendingWizard: StudioTarget | undefined;
  let pageReady = false;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** What the page last said is unsaved; kept if the panel closes. */
  let unsaved: { wizard?: SavedWizard; edit?: OpenEdit } = {};
  const post = (message: unknown) => { void host.webview.postMessage(message); };
  const choose = (message: string, ...actions: string[]): Promise<string | undefined> => deps.choose
    ? deps.choose(message, ...actions)
    : deps.confirm(message, actions[0]).then((yes) => (yes ? actions[0] : undefined));

  const load = async () => {
    input = await deps.gather();
    context = buildStudioContext(input, { hasProject: Boolean(deps.root), knowledgeBase: await deps.knowledgeBase().catch(() => false) });
    library = await listLibrary(deps.library, deps.root, input);
  };
  const refresh = async () => {
    await load();
    const saved = savedWizard(deps.drafts.get());
    const kept = keptWork(deps.kept?.get());
    // The builder's draft is already the resumable draft: say once that it was kept. An open
    // team's changes stay kept until the user reopens or discards them.
    if (kept?.kind === 'wizard' || (kept?.kind === 'editor' && !library.teams.some((team) => team.id === kept.id))) await deps.kept?.set(undefined);
    post({ type: 'state', library, context, ...(saved ? { savedDraft: saved } : {}), ...(kept?.kind === 'wizard' && saved ? { kept: { kind: 'wizard', text: KEPT_WIZARD_TEXT } } : kept?.kind === 'editor' && library.teams.some((team) => team.id === kept.id) ? { kept: { ...kept, text: `Your unsaved changes to "${kept.name || 'the team'}" were kept as a draft.` } } : {}) });
  };
  const refreshLibrary = async () => {
    if (!input) return;
    library = await listLibrary(deps.library, deps.root, input);
    post({ type: 'library', library });
  };
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void refreshLibrary(); }, 150);
    timer.unref?.();
  };

  /** The file behind a page id: only ids from the current listing, never a path from the page. */
  const fileFor = (id: string, kinds: Array<'project' | 'user' | 'archived'> = ['project', 'user']): string | undefined => {
    if (id.startsWith('archived:')) return kinds.includes('archived') ? library.archived.find((entry) => entry.id === id)?.file : undefined;
    const team = library.teams.find((entry) => entry.id === id);
    return team && kinds.includes(team.kind) ? team.file : undefined;
  };
  const teamFor = (id: string) => library.teams.find((entry) => entry.id === id);

  const versionsOf = async (file: string) => (await deps.library.versions(file)).map((version) => ({ ref: path.basename(version), label: versionLabel(path.basename(version)) }));

  const sendTeam = async (id: string, file: string, notice?: string) => {
    const textNow = await readFile(file, 'utf8');
    const draft = draftFromMarkdown(textNow, file);
    open = { id, file, text: textNow, base: hash(textNow) };
    const entry = teamFor(id);
    post({ type: 'team', id, kind: entry?.kind ?? (id === 'project' ? 'project' : 'user'), file: displayPath(file, deps.root), command: entry?.command ?? '', draft, base: open.base, versions: await versionsOf(file), ...(notice ? { notice } : {}) });
  };

  const onWatch = async (file: string) => {
    soon();
    if (!open || path.resolve(file) !== path.resolve(open.file)) return;
    const textNow = await readFile(open.file, 'utf8').catch(() => undefined);
    if (textNow === undefined || hash(textNow) === open.base) return;
    try {
      const draft = draftFromMarkdown(textNow, open.file);
      open = { ...open, text: textNow, base: hash(textNow) };
      post({ type: 'external-change', id: open.id, reason: 'edited', draft, base: open.base, versions: await versionsOf(open.file) });
    } catch (error) {
      post({ type: 'notice', level: 'warning', text: `The team file was changed outside the studio and can't be read yet: ${(error as Error).message} Fix it in the Markdown editor; the studio keeps your view until then.` });
    }
  };

  /** Saves an open team's draft; undefined when it was not saved (the page was told why). */
  const saveTeam = async (edit: OpenEdit): Promise<{ file: string; notice: string } | undefined> => {
    const file = fileFor(edit.id);
    if (!file) return undefined;
    if (!input || !context) await load();
    const disk = await readFile(file, 'utf8');
    if (hash(disk) !== edit.base) {
      // Someone else changed the file since the studio loaded it: the page asks reload or keep mine.
      let draft: TeamDraft | undefined;
      try { draft = draftFromMarkdown(disk, file); } catch { /* an unreadable file still conflicts */ }
      open = { id: edit.id, file, text: disk, base: hash(disk) };
      post({ type: 'external-change', id: edit.id, reason: 'conflict', base: open.base, versions: await versionsOf(file), ...(draft ? { draft } : {}) });
      return undefined;
    }
    const review = reviewDraft(edit.draft, disk, input!, context!);
    if (review.errors.length) { post({ type: 'save-failed', id: edit.id, errors: review.errors }); return undefined; }
    await writeFile(file, review.markdown, 'utf8');
    const version = await deps.library.snapshot(file);
    await refreshLibrary();
    return { file, notice: `Saved "${edit.draft.name.trim()}" as version ${version}.` };
  };

  const startWizard = async (target: StudioTarget) => {
    if (!pageReady) { pendingWizard = target; return; }
    post({ type: 'start-wizard', target: target === 'project' && !deps.root ? 'user' : target });
  };

  const handle = async (message: StudioMessage) => {
    switch (message.type) {
      case 'ready': {
        await refresh();
        pageReady = true;
        markReady();
        if (pendingWizard) { const target = pendingWizard; pendingWizard = undefined; await startWizard(target); }
        return;
      }
      case 'refresh': await refresh(); return;
      case 'review': {
        if (!input || !context) await load();
        const original = message.id && open?.id === message.id ? open.text : undefined;
        post({ type: 'review', seq: message.seq, ...reviewDraft(message.draft, original, input!, context!) });
        return;
      }
      case 'starting-point': {
        if (!context) await load();
        const result = startingPointDraft(message, context!);
        post({ type: 'starting-point', id: message.id, draft: result.draft, ...(result.projectType ? { projectType: result.projectType } : {}) });
        return;
      }
      case 'open': {
        const file = fileFor(message.id);
        if (!file) return;
        try { await sendTeam(message.id, file); } catch (error) { post({ type: 'error', text: `This team file can't be opened in the studio: ${(error as Error).message} Open it as Markdown to fix it.` }); }
        return;
      }
      case 'save': {
        const saved = await saveTeam(message);
        if (saved) await sendTeam(message.id, saved.file, saved.notice);
        return;
      }
      case 'leave-wizard': {
        const name = message.wizard.draft.name.trim();
        const choice = await choose(`You have an unsaved team${name ? ` "${name}"` : ''}. Discard it, or save it as a draft to finish later?`, 'Discard changes', 'Save draft');
        if (choice === 'Save draft') {
          await deps.drafts.set(message.wizard);
          unsaved = {};
          post({ type: 'left', choice: 'save-draft', savedDraft: message.wizard, notice: 'Draft saved. Pick it up again from Team Studio at any time.' });
        } else if (choice === 'Discard changes') {
          unsaved = {};
          post({ type: 'left', choice: 'discard' });
        } else post({ type: 'left', choice: 'stay' });
        return;
      }
      case 'leave-editor': {
        const name = message.edit.draft.name.trim() || teamFor(message.edit.id)?.name || 'this team';
        const choice = await choose(`You have unsaved changes to "${name}". Discard them, or save them before leaving?`, 'Discard changes', 'Save');
        if (choice === 'Save') {
          const saved = await saveTeam(message.edit);
          // Not saved (a problem to fix, or the file changed meanwhile): the page stays on the editor, which says why.
          if (!saved) { post({ type: 'left', choice: 'stay' }); return; }
          open = undefined;
          unsaved = {};
          post({ type: 'left', choice: 'saved', notice: saved.notice });
        } else if (choice === 'Discard changes') {
          open = undefined;
          unsaved = {};
          post({ type: 'left', choice: 'discard' });
        } else post({ type: 'left', choice: 'stay' });
        return;
      }
      case 'unsaved': unsaved = { ...(message.wizard ? { wizard: message.wizard } : {}), ...(message.edit ? { edit: message.edit } : {}) }; return;
      case 'discard-kept': await deps.kept?.set(undefined); return;
      case 'create': {
        if (!input || !context) await load();
        const review = reviewDraft(message.draft, undefined, input!, context!);
        if (review.errors.length) { post({ type: 'save-failed', errors: review.errors }); return; }
        let file: string;
        let id: string;
        if (message.target === 'project') {
          if (!deps.root) { post({ type: 'error', text: 'Open a project folder to save a project team, or save it to My teams.' }); return; }
          file = TeamLibrary.projectTeamFile(deps.root);
          if (await exists(file)) {
            if (!await deps.confirm('This project already has a team. Replace it? Its earlier versions stay in the team history.', 'Replace')) return;
            await deps.library.snapshot(file);
          }
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, review.markdown, 'utf8');
          await deps.library.snapshot(file);
          id = 'project';
          const type = message.projectType ? PROJECT_TYPES.find((candidate) => candidate.id === message.projectType!.id) : undefined;
          if (type) await deps.applyProjectType(deps.root, type, message.projectType!.goal.trim().slice(0, 400) || message.draft.description.trim());
        } else {
          file = await deps.library.create(message.draft.name.trim(), review.markdown);
          id = `user:${slugify(path.basename(file, '.md'))}`;
        }
        await deps.drafts.set(undefined);
        await refreshLibrary();
        await sendTeam(id, file, message.target === 'project' ? `Saved the project team. Run it with /team:project <task>.${message.projectType ? ' AGENTS.md now has this project type\'s guidance.' : ''}` : `Saved "${message.draft.name.trim()}". Run it with /team:${path.basename(file, '.md')} <task>.`);
        return;
      }
      case 'save-draft': {
        await deps.drafts.set({ draft: message.draft, step: message.step, target: message.target, ...(message.startingPoint ? { startingPoint: message.startingPoint } : {}) });
        post({ type: 'notice', text: 'Draft saved. Pick it up again from Team Studio at any time.' });
        return;
      }
      case 'discard-draft': await deps.drafts.set(undefined); return;
      case 'use-in-chat': {
        const team = teamFor(message.id);
        if (team?.command) await deps.sidebar.prefill(team.command);
        return;
      }
      case 'open-markdown': {
        const file = fileFor(message.id, ['project', 'user', 'archived']);
        if (file) await deps.openFile(file);
        return;
      }
      case 'duplicate': {
        const file = fileFor(message.id);
        const team = teamFor(message.id);
        if (!file || !team || team.error) return;
        const name = (await deps.ask('Name for the copy', `${team.name} copy`))?.trim();
        if (!name) return;
        const copy = await deps.library.duplicate(file, name.slice(0, 80));
        await refreshLibrary();
        post({ type: 'notice', text: `Duplicated as "${name}".`, focus: `user:${slugify(path.basename(copy, '.md'))}` });
        return;
      }
      case 'export': {
        const file = fileFor(message.id);
        if (!file) return;
        const target = await deps.pickExportTarget(message.id === 'project' ? 'project-team.md' : path.basename(file));
        if (!target) return;
        await copyFile(file, target);
        post({ type: 'notice', text: `Exported to ${path.basename(target)}.` });
        return;
      }
      case 'archive': {
        const file = fileFor(message.id, ['user']);
        if (!file) return;
        const name = teamFor(message.id)?.name ?? path.basename(file, '.md');
        await deps.library.archive(file);
        if (open?.id === message.id) open = undefined;
        await refreshLibrary();
        post({ type: 'notice', text: `Archived "${name}". Restore it from Archived teams.` });
        return;
      }
      case 'restore': {
        const file = fileFor(message.id, ['archived']);
        if (!file) return;
        const restored = await deps.library.restore(file);
        await refreshLibrary();
        post({ type: 'notice', text: `Restored "${path.basename(restored, '.md')}".`, focus: `user:${slugify(path.basename(restored, '.md'))}` });
        return;
      }
      case 'import': {
        const source = await deps.pickImportSource();
        if (!source) return;
        const file = await deps.library.import(source);
        await refreshLibrary();
        await sendTeam(`user:${slugify(path.basename(file, '.md'))}`, file, `Imported "${parseTeam(await readFile(file, 'utf8'), file).name}".`);
        return;
      }
      case 'versions': {
        const file = fileFor(message.id);
        if (file) post({ type: 'versions', id: message.id, versions: await versionsOf(file) });
        return;
      }
      case 'version-view': case 'version-restore': {
        const file = fileFor(message.id);
        if (!file) return;
        const version = (await deps.library.versions(file)).find((candidate) => path.basename(candidate) === message.ref);
        if (!version) return;
        const versionText = await readFile(version, 'utf8');
        const current = await readFile(file, 'utf8');
        if (message.type === 'version-view') {
          post({ type: 'version', id: message.id, ref: message.ref, label: versionLabel(message.ref), text: versionText, diff: lineDiff(versionText, current) satisfies DiffLine[] });
          return;
        }
        try { parseTeam(versionText, file); } catch (error) { post({ type: 'error', text: `That version is not a usable team: ${(error as Error).message}` }); return; }
        if (!await deps.confirm(`Restore the version from ${versionLabel(message.ref)}? It replaces the team file (the current contents stay in the history), and unsaved changes in the studio are discarded.`, 'Restore')) return;
        await writeFile(file, versionText, 'utf8');
        await deps.library.snapshot(file);
        await refreshLibrary();
        await sendTeam(message.id, file, `Restored the version from ${versionLabel(message.ref)}.`);
        return;
      }
      case 'open-setting': await deps.openSetting(message.key); return;
    }
  };

  const subscriptions = [
    deps.watch((file) => { void onWatch(file); }),
    ...(deps.onDidChangeSettings ? [deps.onDidChangeSettings(() => { void refresh(); })] : []),
    host.webview.onDidReceiveMessage(async (value) => {
      const message = parseStudioMessage(value);
      if (!message) return;
      try { await handle(message); } catch (error) { post({ type: 'error', text: (error as Error).message }); }
    })
  ];
  /** The panel closed: unsaved work is kept (the builder as its draft, an open team's changes as kept changes). */
  const keepUnsaved = async () => {
    const { wizard, edit } = unsaved;
    unsaved = {};
    if (wizard) {
      await deps.drafts.set(wizard);
      await deps.kept?.set({ kind: 'wizard', name: wizard.draft.name.trim() });
    } else if (edit) {
      await deps.kept?.set({ kind: 'editor', name: edit.draft.name.trim() || teamFor(edit.id)?.name || '', ...edit });
    }
  };
  const dispose = () => {
    if (timer) clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
    void keepUnsaved().catch(() => undefined);
  };
  host.onDidDispose(dispose);
  return { refresh, startWizard, dispose, ready };
}

function openEdit(value: unknown): OpenEdit | undefined {
  if (!isPlain(value)) return undefined;
  const parsed = parseStudioMessage({ ...value, type: 'save' });
  return parsed?.type === 'save' ? { id: parsed.id, draft: parsed.draft, base: parsed.base } : undefined;
}

function keptWork(value: unknown): KeptWork | undefined {
  if (!isPlain(value)) return undefined;
  const name = typeof value.name === 'string' ? value.name.slice(0, 120) : '';
  if (value.kind === 'wizard') return { kind: 'wizard', name };
  if (value.kind !== 'editor') return undefined;
  const edit = openEdit({ id: value.id, draft: value.draft, base: value.base });
  return edit ? { kind: 'editor', name, ...edit } : undefined;
}

function savedWizard(value: unknown): SavedWizard | undefined {
  if (!isPlain(value)) return undefined;
  const parsed = parseStudioMessage({ ...value, type: 'save-draft' });
  return parsed?.type === 'save-draft' ? { draft: parsed.draft, step: parsed.step, target: parsed.target, ...(parsed.startingPoint ? { startingPoint: parsed.startingPoint } : {}) } : undefined;
}

/** "2026-10-29T14-03-12-345Z.md" → "2026-10-29 14:03:12 UTC". */
export function versionLabel(ref: string): string {
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-\d+Z\.md$/.exec(ref);
  return match ? `${match[1]} ${match[2]}:${match[3]}:${match[4]} UTC` : ref.replace(/\.md$/, '');
}

function displayPath(file: string, root: string | undefined): string {
  return root && file.startsWith(root + path.sep) ? path.relative(root, file) : `My teams/${path.basename(file)}`;
}

export type { TeamDefinition };

/** The page's HTML: one nonce script and one stylesheet; everything else is rendered by the script with textContent. */
export function teamStudioHtml(options: { cspSource: string; nonce: string; script: string; style: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}';">
<link rel="stylesheet" href="${options.style}"><title>NEAR AI Team Studio</title></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="title"><h1 id="title">Team Studio</h1><p id="subtitle" class="hint">Build and manage agent teams. Each team is a Markdown file; the studio reads and writes it for you.</p></div><nav id="crumbs" aria-label="Breadcrumb"></nav></header>
<div id="announce" class="visually-hidden" aria-live="polite" role="status"></div>
<div id="banner" class="banner" hidden role="alert"></div>
<main id="main" tabindex="-1"><p class="hint">Loading…</p></main>
<script nonce="${options.nonce}" src="${options.script}"></script></body></html>`;
}

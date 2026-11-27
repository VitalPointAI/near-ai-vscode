import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PROJECT_TYPES, projectTypeTeam, type ProjectType } from '../agent/projectTypes';
import { detectTemplate, stampTeam } from '../agent/teamUpdate';
import { checkDraft, draftFromMarkdown, handWrittenTeamPrivacy, lineDiff, type DiffLine, type DraftIssue, type DraftMember, type TeamDraft } from '../agent/teamMarkdown';
import { DEFAULT_TOOLS, parseTeam, recommendedProjectTeam, SLUG_MAX, slugify, slugWhole, TeamLibrary, teamIsPrivate, teamKnowledgeKey, type TeamDefinition } from '../agent/teams';
import type { AgentDiscoveryAnswers } from '../domain/agents';
import { buildTeamGraph } from '../agent/teamGraph';
import { checkNotes, checkTeam, checkWarnings } from '../agent/teamCheck';
import { ACCEPT_ALL_KINDS, applySuggestion, KNOWLEDGE_BASE_PRIVATE, MAX_REFINE_BYTES, parseRefinement, REFINE_PROMPT, refinePlan, refinePrompt, type RefinePlan, type Suggestion } from '../agent/teamRefine';
import { chooseImageModel, chooseTeamModel, imageCallBlocked, imageEstimate, teamImageCall, teamModelCall, type TeamAiDeps, type TeamImageResult } from './teamStudioAi';
import { CUSTOM_PLAGIARISM_CHECKER } from '../agent/researchIntegrity';
import { builderPrompt, parseProposal, proposalDraft, proposalText, TEAM_BUILDER_PROMPT } from '../agent/teamBuilder';
import { layoutNetwork } from '../domain/networkLayout';
import { gradingCoverage } from '../domain/teamKnowledge';
import { knowledgeFile, loadKnowledge } from './teamKnowledgeStore';
import { buildTeamPackage, cleanKnowledge, importQuestion, MAX_TEAM_PACKAGE_BYTES, readTeamMarkdown, readTeamPackage, shareProblems, TEAM_PACKAGE_EXTENSION, TeamPackageError, type ReadPackage } from '../agent/teamPackage';
import type { TeamKnowledge } from '../domain/teamKnowledge';
import { teamRating, withTeamRating } from '../agent/teamFrontMatter';
import { buildDashboard, legacyRoleTestKey, migrateRoleTests, moveKept, parseRatings, parseRoleTests, projectIdentity, teamKey, withRating, type CheckCounts, type DashboardTeam, type RatingRecord, type RoleTestRecord, type RunningTeam, type TeamDashboard } from '../domain/teamDashboard';
import type { ActivitySessionSummary } from '../domain/activity';
import { checkTeamIcon, decodeIconBase64, ICON_VARIATIONS, iconDataUri, iconPixelProblem, iconSourceProblem, iconSourceType, MAX_GENERATED_IMAGE_BYTES, MAX_ICON_SOURCE_BYTES, TeamIconError, TeamIconPartialError, teamIconPrompt, withIconReference, type IconSourceType } from '../agent/teamIcon';

/** The facts, relations and grading of each node, so the page can show a card without being sent the whole graph twice. */
function nodeDetails(graph: { nodes: Array<{ id: string; facts: Array<{ text: string; source?: string }>; functions: string[]; grading?: unknown; origin: string; mentions: number }>; edges: Array<{ from: string; to: string; kind: string; tension: number | null; basis?: string; grading?: unknown }> }): Record<string, unknown> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return Object.fromEntries(graph.nodes.map((node) => [node.id, {
    functions: node.functions, facts: node.facts, grading: node.grading ?? null, origin: node.origin, mentions: node.mentions,
    relations: graph.edges.filter((edge) => edge.from === node.id || edge.to === node.id).map((edge) => ({
      kind: edge.kind, tension: edge.tension, basis: edge.basis ?? null, grading: edge.grading ?? null,
      direction: edge.from === node.id ? 'out' : 'in', other: edge.from === node.id ? edge.to : edge.from
    }))
  }]));
}
import { isAbliteratedModel } from '../domain/cyberModel';
import { buildToolsDirectory, firstSentence, PRIVACY_TEXT, privacyOf, resolveAgentModel, type DirectoryInput, type DirectoryTool, type DirectoryModel, type ToolStatus, type ToolsDirectory } from './toolsDirectory';

// SovAI Team Studio: a guided, visual way to build and manage agent teams. The team Markdown
// files stay the source of truth; the studio reads them, writes them through TeamLibrary (so
// every save is a version and nothing is ever hard-deleted), and computes models and permissions
// from the same sources the Tools page and a run use. No VS Code imports, so the tests run it
// directly.

export type StudioTarget = 'project' | 'user';

/** `words`: what the tool's manifest says it can do, from the same sentences the Tools page shows (GATE-03, D-07); the member card shows them beside the tool. */
/** `server`: a built-in staff server's tool (or its whole-server grant, `mcp:<id>`): the picker groups it under that server, and only a staff team's run gets it. */
export interface StudioTool { name: string; description: string; capability: string; status: ToolStatus; statusText: string; words: string[]; server?: { id: string; name: string } }
export interface StudioRole { id: string; label: string; description: string; source: 'team' | 'gsd'; suggestion: string; tools: string[] | null; model: string }
/** `name`: the team's own name (startingPointTeamName), set by buildStudioContext so the page never works one out. */
export interface StudioStartingPoint { id: string; group: 'recommend' | 'project-type' | 'gsd' | 'empty'; label: string; name?: string; description: string; members: string[] }

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
/** `update`: the built-in template the team was made from and whether a newer version exists, so the card can offer Update Team. */
/** `imported`: added with Import team and not yet approved to run; the person is asked the first time it would run. */
/** `icon` (0.4.30): the team's own icon as a PNG data URI, checked; absent when the team shows the default (initials on a colour, drawn by the page). */
export interface LibraryTeam { id: string; kind: 'project' | 'user'; name: string; description: string; command?: string; file: string; savedAt?: string; error?: string; imported?: boolean; derived?: boolean; /** 0.4.27: marked private, or every member private. */ private?: boolean; /** A military staff section team: its section and the named person's role who decides. */ staff?: { section: string; humanLead?: string }; update?: { template: string; from?: number; to: number; available: boolean }; icon?: string; /** The person's own rating (1 to 5 stars), from the ratings kept on this computer by the team's identity; never from or into the file. */ rating?: number; /** Host only: a `rating:` line an earlier build wrote into the file, read once into the kept ratings. */ legacyRating?: number; /** What the free local check finds in it, counted. */ check?: CheckCounts; members: Array<{ name: string; role?: string } & StudioMemberModel> }
export interface LibraryArchived { id: string; name: string; file: string; savedAt?: string }
export interface LibraryState { teams: LibraryTeam[]; archived: LibraryArchived[] }

/**
 * One choice in the new-team picker (owner, 2026-11-16: "I'm not seeing the teams I've already set up in other projects and saved as one of my reusable
 * teams ... Need to see all available teams and maybe be able to filter between my teams and those provided by the extension"). `source` is what the
 * filter uses: `mine` for the person's saved teams (from any project), `builtin` for what the extension provides. `origin` says where it came from.
 */
export interface PickerEntry { id: string; source: 'mine' | 'builtin'; group: StudioStartingPoint['group'] | 'library'; label: string; /** The team's own name. */ name: string;
  /** What Clone and modify names the copy: "<the team's name> copy", made unique among every team (cloneNameFor). */ cloneName: string;
  /** A built-in only: the name Use as is saves it to My teams under when no project is open, made unique the same way. The page shows it, never works it out. */ saveAs?: string;
  description: string; members: string[]; memberCount: number; origin: string; imported?: boolean; teamId?: string }
export type PickerFilter = 'all' | 'mine' | 'builtin';

/** A generated icon's request, kept until the page sends its PNG back: what to ask again with another variation if it matches another team's icon. */
/** `model`: the image model the person agreed to; a later call that would use another one is refused rather than sent. */
interface IconJob { model: string; variation: number; attempt: 1 | 2 }

/**
 * A built-in starting point's own name as a team (owner, 2026-11-17: Use as is saves a built-in "under its own name"). A project type's team is already
 * named "<label> team" when it is made (projectTypeTeam), and the recommendation is a team made from answers, so it gets a name of its own.
 */
export function startingPointTeamName(point: { id: string; label: string }): string {
  if (point.id === 'recommend') return 'Recommended team';
  if (point.id === 'empty') return 'New team';
  return /\bteam$/i.test(point.label.trim()) ? point.label.trim() : `${point.label.trim()} team`;
}

/**
 * A name a team already has, which a clone may not take (owner, 2026-11-18: a clone of a team kept its look and could reuse its name). `slug`: a saved
 * team's file name, which the name it shows may have moved away from. `by`: whose name it is, said in the message.
 */
export interface TakenTeamName { name: string; slug?: string; by: 'saved' | 'builtin' | 'project' }

/** Every name a clone may not take: the person's saved teams (their names and file names), this project's team, and every built-in team. */
export function takenTeamNames(teams: ReadonlyArray<Pick<LibraryTeam, 'id' | 'kind' | 'name'>>, startingPoints: ReadonlyArray<{ id: string; label: string }>): TakenTeamName[] {
  return [
    ...teams.filter((team) => team.kind === 'user').map((team): TakenTeamName => ({ name: team.name, slug: team.id.slice('user:'.length), by: 'saved' })),
    ...teams.filter((team) => team.kind === 'project').map((team): TakenTeamName => ({ name: team.name, by: 'project' })),
    // "Start empty" is not a team, so its "New team" is not a name any team has.
    ...startingPoints.filter((point) => point.id !== 'empty').map((point): TakenTeamName => ({ name: startingPointTeamName(point), by: 'builtin' }))
  ];
}

/**
 * The file name a team name is saved under (slugify), or undefined for a name with no letter or digit it can use: every such name falls back to the same
 * file name, so it would make every two of them the same.
 */
function nameSlug(name: string): string | undefined {
  return /[a-z0-9]/i.test(name) ? slugify(name.trim()) : undefined;
}

/** The taken name this one clashes with: the same name ignoring case, or the same file name (so "Web-Team" and "web team" clash). */
export function teamNameClash(name: string, taken: readonly TakenTeamName[]): TakenTeamName | undefined {
  const clean = name.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return undefined;
  const lower = clean.toLowerCase();
  const slug = nameSlug(clean);
  return taken.find((other) => other.name.trim().toLowerCase() === lower || (slug !== undefined && (nameSlug(other.name) === slug || other.slug === slug)));
}

/** Why a clone may not have this name, in plain words, or undefined when no team has it. */
export function cloneNameProblem(name: string, taken: readonly TakenTeamName[]): string | undefined {
  const clash = teamNameClash(name, taken);
  if (!clash) return undefined;
  const clean = name.replace(/[\r\n]+/g, ' ').trim();
  const other = clash.name.trim();
  const whose = clash.by === 'saved' ? 'one of your teams' : clash.by === 'project' ? 'this project\'s team' : 'a built-in team';
  if (other.toLowerCase() === clean.toLowerCase()) return `"${other}" is already the name of ${whose}. Give the new team a name of its own.`;
  const sameFile = clash.slug !== undefined && nameSlug(clean) === clash.slug && nameSlug(other) !== clash.slug;
  if (sameFile) return `"${clean}" would be saved under the same file name as "${other}", ${whose}. Give the new team a name of its own.`;
  return `"${clean}" is too close to "${other}", ${whose}: names are compared without capitals, spaces or punctuation. Give the new team a name of its own.`;
}

/** The longest name a team is given (the name field's limit); a name is checked as it will be saved, cut to this. */
export const TEAM_NAME_MAX = 80;
/** A team name as it is saved: one line, trimmed, at most TEAM_NAME_MAX characters. Checks run on this value, never on what was typed. */
export function savedTeamName(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').trim().slice(0, TEAM_NAME_MAX).trim();
}

/**
 * The name a clone (or a duplicate) starts with: "<the team's name> copy", then "copy 2", "copy 3"... until no team has it (PR #90 review, round 2). The
 * team's name is shortened, at a word where it can be, so the whole name fits in TEAM_NAME_MAX characters and so its number still changes the file name
 * it would be saved under, which keeps only the first 40 characters: without that, every number gave the same file name and the search never ended.
 */
export function cloneNameFor(name: string, taken: readonly TakenTeamName[]): string {
  const source = savedTeamName(name) || 'Team';
  // slugify's own spelling and limit (PR #90 review: a copy of its rules here could drift from the file name really used).
  const cut = (value: string) => slugWhole(value).length > SLUG_MAX;
  const fit = (suffix: string) => {
    let base = source.slice(0, TEAM_NAME_MAX - suffix.length).trim();
    // Only a name whose file name would be cut is shortened further; one with no usable letters keeps its own name, told apart by the name itself.
    while (base.length > 1 && cut(`${base}${suffix}`)) {
      const word = base.lastIndexOf(' ');
      base = (word > 0 && !cut(`${base.slice(0, word)}${suffix}`) ? base.slice(0, word) : base.slice(0, -1)).trim();
    }
    return `${base || 'Team'}${suffix}`;
  };
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = fit(n === 1 ? ' copy' : ` copy ${n}`);
    if (!teamNameClash(candidate, taken)) return candidate;
  }
  return fit(` copy ${Date.now()}`.slice(0, 20));
}

/** `base`, or `base 2`, `base 3`... : the first that none of the person's saved teams has as its name or its file name. */
export function uniqueTeamName(base: string, teams: ReadonlyArray<Pick<LibraryTeam, 'id' | 'kind' | 'name'>>): string {
  const clean = base.replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || 'New team';
  const taken = (name: string) => teams.some((team) => team.kind === 'user' && (team.name.trim().toLowerCase() === name.toLowerCase() || team.id === `user:${slugify(name)}`));
  let name = clean;
  for (let n = 2; taken(name); n += 1) name = `${clean.slice(0, 76)} ${n}`;
  return name;
}

/**
 * What a saved clone is told about its icon (owner, 2026-11-18). A clone never takes the icon file of the team it was copied from: it is written without
 * an icon line (a project team's old icon goes into History), so it shows the default until the person uploads or generates one of its own.
 */
export const CLONE_ICON_NOTE = ' It shows the default icon, not the icon of the team it was copied from. Upload a picture or generate one on its Purpose tab.';

/** Every starting point the picker offers: the person's saved teams first, then the built-in ones. A library team that does not parse is left out. */
export function teamPicker(startingPoints: StudioStartingPoint[], teams: LibraryTeam[]): PickerEntry[] {
  const taken = takenTeamNames(teams, startingPoints);
  const mine = teams.filter((team) => team.kind === 'user' && !team.error).map((team): PickerEntry => ({
    id: `lib:${team.id.slice('user:'.length)}`, source: 'mine', group: 'library', label: team.name, name: team.name, cloneName: cloneNameFor(team.name, taken), description: team.description,
    members: team.members.map((member) => member.name), memberCount: team.members.length,
    origin: team.imported ? (team.derived ? 'Made from an import, not approved yet' : 'Imported, not approved yet') : `My team${team.savedAt ? `, saved ${team.savedAt.slice(0, 10)}` : ''}`,
    ...(team.imported ? { imported: true } : {}), teamId: team.id
  }));
  // The recommendation is made from answers on its own screen (0.4.30), so the picker does not offer it a second time.
  const builtin = startingPoints.filter((point) => point.id !== 'recommend').map((point): PickerEntry => ({
    id: point.id, source: 'builtin', group: point.group, label: point.label, name: startingPointTeamName(point), cloneName: cloneNameFor(startingPointTeamName(point), taken), saveAs: uniqueTeamName(startingPointTeamName(point), teams), description: point.description, members: point.members, memberCount: point.members.length,
    origin: point.group === 'project-type' ? 'Built in: project type' : point.group === 'gsd' ? 'Built in: Open-GSD roles' : 'Built in'
  }));
  return [...mine, ...builtin];
}

/** The picker's entries under a filter. "Start empty" is not a team, so it shows under every filter. */
export function filterPicker(entries: PickerEntry[], filter: PickerFilter): PickerEntry[] {
  return entries.filter((entry) => filter === 'all' || entry.source === filter || entry.id === 'empty');
}

export const NO_SAVED_TEAMS_TEXT = 'You have no saved teams yet. Save a team as one of your teams in Team Studio to reuse it in any project.';

/** `notes`: advice shown while editing (the parallel-work notes); never blocks a save. */
export interface StudioReview { markdown: string; errors: DraftIssue[]; warnings: DraftIssue[]; notes: DraftIssue[]; members: StudioMemberModel[] }

const READ = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall', 'Remember'];
const WEB = ['WebSearch', 'WebFetch', 'CheckCitations'];
const WRITE = ['Write', 'Edit'];
const DOCS = ['CreatePresentation', 'CreatePdf', 'CreateDocument', 'RenderSvg', 'VectorizeImage'];

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
  { id: 'red-team', label: 'Red team', model: 'deep', tools: [...READ, 'Bash', 'Write'], description: 'Attacks the work like an adversary before it is verified.', suggestion: 'Attack the work like an adversary before it is verified: find bugs, holes, unhandled edge cases, wrong assumptions, and weak tests. Prove what you can. Report the findings, numbered with severity and evidence. Do not fix anything yourself.' },
  { id: 'plagiarism-checker', label: 'Plagiarism checker', model: 'deep', tools: [...CUSTOM_PLAGIARISM_CHECKER.tools], description: 'Checks the draft for plagiarism and Chicago 18 citations, and says CLEAN or NOT CLEAN. Does not edit.', suggestion: CUSTOM_PLAGIARISM_CHECKER.instructions }
];

/** The role ids the studio offers, in order, so a benchmark can require a task for each one. */
export const TEAM_ROLE_IDS: string[] = TEAM_ROLES.map((role) => role.id);

/** Starting points built from Open-GSD agent roles. Each member's role names the Open-GSD agent it is modelled on. */
const GSD_TEMPLATES: Array<{ id: string; label: string; description: string; members: Array<{ name: string; role: string; model: string; tools: string[] | null; fallback: string }> }> = [
  { id: 'research', label: 'Research', description: 'Investigate a question, synthesize the findings, and check them.', members: [
    { name: 'researcher', role: 'gsd-phase-researcher', model: 'standard', tools: [...READ, ...WEB, 'Write'], fallback: 'Research how to approach the task: read the code and primary sources, and record each finding with where it came from. Your area is your research notes.' },
    { name: 'synthesizer', role: 'gsd-research-synthesizer', model: 'fast', tools: [...READ, 'Write'], fallback: 'Starts once the research notes are ready. Combine them into one summary with the decisions it supports and the open questions; the summary is your area.' },
    { name: 'checker', role: 'gsd-verifier', model: 'standard', tools: [...READ, ...WEB], fallback: 'Check the summary against its sources and report anything unsupported or contradicted.' }] },
  { id: 'build-test', label: 'Build & test', description: 'Plan a change, implement it, and verify it works.', members: [
    { name: 'planner', role: 'gsd-planner', model: 'deep', tools: READ, fallback: 'Create a plan with small, verifiable tasks, the files each touches, and how each will be checked. Give each task its own area (the files it owns) and mark which tasks can run at the same time.' },
    { name: 'executor', role: 'gsd-executor', model: 'deep', tools: null, fallback: 'Carry out your tasks in the plan with small commits, running the tests as you go. Work only on the area your tasks own. When other members change files at the same time, work in your own git worktree and report your branch for the lead to merge.' },
    { name: 'verifier', role: 'gsd-verifier', model: 'standard', tools: [...READ, 'Bash'], fallback: 'Verify that the merged result meets the goal: run the checks and report what is shown to work and what is not.' }] },
  { id: 'review', label: 'Review', description: 'Independent code, security, and integration review.', members: [
    { name: 'code-reviewer', role: 'gsd-code-reviewer', model: 'standard', tools: [...READ, 'Bash'], fallback: 'Review the changed files for bugs, security issues, and code quality problems, at the same time as the other reviewers. Your area is your report. Report findings by severity with file:line.' },
    { name: 'security-auditor', role: 'gsd-security-auditor', model: 'deep', tools: [...READ, 'Bash', 'SecurityScan'], fallback: 'Check that the threats the work faces are mitigated in the code. Report open threats with evidence.' },
    { name: 'integration-checker', role: 'gsd-integration-checker', model: 'standard', tools: [...READ, 'Bash'], fallback: 'Check that the merged parts connect: follow each user flow end to end and report breaks.' }] },
  { id: 'writing', label: 'Writing', description: 'Write documentation and check it against the code.', members: [
    { name: 'doc-writer', role: 'gsd-doc-writer', model: 'standard', tools: [...READ, ...WRITE, ...DOCS], fallback: 'Write or update the documentation the task asks for, matching the project\'s existing docs. Your area is the documents you are given.' },
    { name: 'doc-verifier', role: 'gsd-doc-verifier', model: 'standard', tools: [...READ, 'Bash'], fallback: 'Once the documentation is written, check the whole of it: every factual claim against the code. Report what is wrong.' }] },
  { id: 'analysis', label: 'Analysis', description: 'Map the codebase and surface assumptions and patterns, each in its own report; the lead combines them.', members: [
    { name: 'mapper', role: 'gsd-codebase-mapper', model: 'fast', tools: [...READ, 'Write'], fallback: 'Explore the codebase and write a structured summary of its architecture, conventions, and concerns. Your area is that summary.' },
    { name: 'assumptions', role: 'gsd-assumptions-analyzer', model: 'standard', tools: READ, fallback: 'List the assumptions the task depends on, with the evidence for each from the code.' },
    { name: 'patterns', role: 'gsd-pattern-mapper', model: 'fast', tools: READ, fallback: 'Find the closest existing patterns in the codebase for the new work and say where each lives.' }] }
];

function studioTools(directory: ToolsDirectory): StudioTool[] {
  const entry = (tool: DirectoryTool, server?: StudioTool['server']): StudioTool => ({ name: tool.name, description: tool.description, capability: tool.capability, status: tool.status, statusText: tool.statusText, words: tool.words, ...(server ? { server } : {}) });
  // A built-in staff server's tools are grouped under the server, after the tools every run gets, with the whole-server grant first (what the staff
  // templates write). The grant runs the way its strictest tool does under the approval mode.
  const serverOf = new Map(directory.staffServers.flatMap((server) => server.tools.map((tool) => [tool.name, { id: server.id, name: server.name }] as const)));
  const rank: Record<ToolStatus, number> = { runs: 0, 'auto-checked': 1, asks: 2, off: 3, stopped: 4 };
  const listed = new Set(directory.tools.map((tool) => tool.name));
  const staff = directory.staffServers.flatMap((server) => {
    const tag = { id: server.id, name: server.name };
    const strictest = server.tools.reduce<DirectoryTool | undefined>((worst, tool) => (!worst || rank[tool.status] > rank[worst.status] ? tool : worst), undefined);
    const grant: StudioTool = { name: server.grant, description: `Every tool of ${server.name.replace(/ \(built in\)$/, '')}. ${server.description}`, capability: strictest?.capability ?? 'read', status: strictest?.status ?? 'asks', statusText: strictest?.statusText ?? '', words: [], server: tag };
    return [grant, ...server.tools.filter((tool) => !listed.has(tool.name)).map((tool) => entry(tool, tag))];
  });
  return [...directory.tools.map((tool) => entry(tool, serverOf.get(tool.name))), ...staff];
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
    startingPoints: ([
      { id: 'recommend', group: 'recommend', label: 'Recommend a team for me', description: 'Answer three questions about the work and its risk; the studio suggests a team sized to it.', members: [] },
      ...PROJECT_TYPES.map((type) => ({ id: `type:${type.id}`, group: 'project-type' as const, label: type.label, description: type.description, members: type.members.map((member) => member.name) })),
      ...GSD_TEMPLATES.map((template) => ({ id: `gsd:${template.id}`, group: 'gsd' as const, label: template.label, description: `${template.description}${gsdDescription(template.members[0].role) ? '' : ' (Open-GSD roles; installs with your first workflow.)'}`, members: template.members.map((member) => member.name) })),
      { id: 'empty', group: 'empty', label: 'Start empty', description: 'Add every member yourself.', members: [] }
    ] as StudioStartingPoint[]).map((point) => ({ ...point, name: startingPointTeamName(point) }))
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
    // A private member (its own line, or the whole team marked private) runs only on a private model: say so when the model it names is not one.
    if ((member.privacy === 'private' || draft.private) && (model.privacy === 'forwarded' || (model.privacy === 'unknown' && input.models))) {
      warnings.push({ member: index, field: 'model', message: `${label}: ${draft.private && member.privacy !== 'private' ? 'the team is private' : 'it is private'}, so a run uses a private model instead of ${model.model}${model.privacy === 'forwarded' ? ' (forwarded outside NEAR\'s TEE)' : ' (its privacy is unknown)'}, and stops if there is none.` });
    }
    const unknownTools = (member.tools ?? []).filter((tool) => !known.has(tool) && !/^mcp__/.test(tool));
    if (unknownTools.length) warnings.push({ member: index, field: 'tools', message: `${label}: ${unknownTools.join(', ')} ${unknownTools.length === 1 ? 'is not a built-in tool' : 'are not built-in tools'}; agents only get tools that exist.` });
    return model;
  });
  // 0.4.27: the free local team check (tools that do not match the instructions, no deliverable, overlaps, reports-to problems, keys) shows as
  // warnings while editing, so a save never depends on running Improve with AI.
  const findings = checkTeam(draft, { defaultTools: DEFAULT_TOOLS });
  warnings.push(...checkWarnings(findings));
  // Owner, 2026-11-18: whether members own separate areas and who brings their parts together, shown as notes so the person editing sees them.
  return { markdown, errors, warnings, notes: checkNotes(findings), members };
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
/**
 * `checks`: the local check's counts by the file's content hash, kept by the caller, so a listing (every library, state and dashboard message) checks only
 * a file that changed (PR 86 review).
 */
export async function listLibrary(library: TeamLibrary, root: string | undefined, input: DirectoryInput, options: { checks?: Map<string, CheckCounts | undefined> } = {}): Promise<LibraryState> {
  const entries = await library.list(root);
  // The unapproved team files themselves (the library maps each marker to its file), compared by path rather than rebuilt from marker names.
  const pending = new Set((await library.pendingImportFiles()).map((file) => path.resolve(file)));
  const teams = await Promise.all(entries.map(async (entry): Promise<LibraryTeam> => {
    const slug = slugify(path.basename(entry.file, '.md'));
    const team = entry.team;
    const text = team ? await readFile(entry.file, 'utf8').catch(() => undefined) : undefined;
    const template = text !== undefined ? detectTemplate(text) : undefined;
    // 0.4.30: the team's own icon, checked, as a data URI; the page draws the default for a team without one.
    const icon = text !== undefined ? await library.readIcon(entry.file, text) : undefined;
    const legacyRating = text !== undefined ? teamRating(text) : undefined;
    let check: CheckCounts | undefined;
    if (text !== undefined) {
      // The file and its content: the check reads the file's name too, so two files with the same text are each checked (PR 86 review, round 2).
      const key = `${path.resolve(entry.file)}\n${hash(text)}`;
      if (options.checks?.has(key)) check = options.checks.get(key);
      else { check = checkCounts(text, entry.file); options.checks?.set(key, check); }
    }
    return {
      id: entry.project ? 'project' : `user:${slug}`, kind: entry.project ? 'project' : 'user', file: entry.file,
      name: team?.name ?? slug, description: team?.description ?? '',
      ...(team ? { command: `/team:${entry.project ? 'project' : team.slug} ` } : {}),
      ...(entry.error ? { error: plainTeamError(entry.error, entry.file) } : {}),
      ...(team && teamIsPrivate(team) ? { private: true } : {}),
      ...(team?.staff ? { staff: { section: team.staff.section, ...(team.staff.humanLead ? { humanLead: team.staff.humanLead } : {}) } } : {}),
      ...(!entry.project && pending.has(path.resolve(entry.file)) ? { imported: true, ...((await library.pendingKind(entry.file))?.kind === 'derived' ? { derived: true } : {}) } : {}),
      ...(template ? { update: { template: template.label, ...(template.fromVersion ? { from: template.fromVersion } : {}), to: template.toVersion, available: !template.stamped || template.fromVersion !== template.toVersion } } : {}),
      ...(await mtime(entry.file) ? { savedAt: await mtime(entry.file) } : {}),
      ...(icon ? { icon: iconDataUri(icon) } : {}),
      ...(legacyRating ? { legacyRating } : {}),
      ...(check ? { check } : {}),
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

/** The free local check's findings for a team file, counted by how serious they are; undefined when the file does not read as a draft. */
function checkCounts(text: string, file: string): CheckCounts | undefined {
  try {
    const findings = checkTeam(draftFromMarkdown(text, file), { defaultTools: DEFAULT_TOOLS });
    return { block: findings.filter((finding) => finding.severity === 'block').length, warning: findings.filter((finding) => finding.severity === 'warning').length, advice: findings.filter((finding) => finding.severity === 'advice').length };
  } catch { return undefined; }
}

/**
 * An actual path in a message (PR 86 review, round 5): an absolute Unix path, a single part included (`/home`), a drive letter, a home path (~/), or any
 * backslash (a Windows or UNC path). A model id (vendor/model) or a /team: command is not one.
 */
export const NAMES_A_PATH = /\\|(?:^|[\s'"(\[=,])(?:\/(?!team:)[^\s'"]|~\/|[A-Za-z]:\/)/;

/** What the page shows for a team file whose reason names a path. */
export const UNREADABLE_TEAM = 'The team file cannot be read as a team. Open it as Markdown to fix it.';

/**
 * Why a team file is not usable, in words the page may show (PR 86 review, rounds 3 and 4). A file-system error is mapped by its code (fileProblem),
 * whatever the spelling of the path it carries; any other reason that names a path (a separator, or a drive letter) is replaced by a fixed sentence,
 * so no spelling of a path on this computer ever reaches the page. The team loader's own reasons name no path and pass through.
 */
export function plainTeamError(message: string, _file?: string): string {
  const code = /^(E[A-Z]+):/.exec(message)?.[1];
  if (code) return `The team file could not be read${fileProblem({ code })}.`;
  if (NAMES_A_PATH.test(message)) return UNREADABLE_TEAM;
  return message;
}

/** The listing as the page gets it: everything but the files' paths, which stay here (the page names teams only by the ids it was given). */
export function pageLibrary(state: LibraryState): { teams: Array<Omit<LibraryTeam, 'file' | 'legacyRating'>>; archived: Array<Omit<LibraryArchived, 'file'>> } {
  return { teams: state.teams.map(({ file: _file, legacyRating: _legacy, ...team }) => team), archived: state.archived.map(({ file: _file, ...entry }) => entry) };
}

/** The slug `/team:` names a team by: a library team's file name, and the project team's file is team.md. */
const slugOf = (team: Pick<LibraryTeam, 'id' | 'kind' | 'file'>) => (team.kind === 'project' ? slugify(path.basename(team.file, '.md')) : team.id.slice('user:'.length));

/** A listed team as the dashboard counts it, with its stable key (`project`: this project's identity). */
function dashboardTeam(team: LibraryTeam, project: string | undefined): DashboardTeam {
  const key = teamKey({ kind: team.kind, slug: team.id.slice('user:'.length) }, project);
  return {
    id: team.id, kind: team.kind, slug: slugOf(team), file: team.file, ...(key ? { key } : {}),
    ...(team.error ? { error: team.error } : {}), ...(team.imported ? { imported: true } : {}), ...(team.derived ? { derived: true } : {}), ...(team.check ? { check: team.check } : {}),
    members: team.members.map((member) => ({ name: member.name, model: member.model, ...(member.available !== undefined ? { available: member.available } : {}) }))
  };
}

/** The dashboard's sort orders. */
export const DASHBOARD_SORTS = ['used', 'recent', 'rating', 'name'] as const;
export type DashboardSort = typeof DASHBOARD_SORTS[number];

/** A kept dashboard view read back: exactly a known sort and a yes or no, or nothing. */
export function dashboardView(value: unknown): { sort: DashboardSort; attention: boolean } | undefined {
  if (!isPlain(value) || !exactKeys(value, ['sort', 'attention']) || !(DASHBOARD_SORTS as readonly unknown[]).includes(value.sort) || typeof value.attention !== 'boolean') return undefined;
  return { sort: value.sort as DashboardSort, attention: value.attention };
}

// ---- Messages from the page: strictly validated; anything else is ignored. ----

const TEAM_ID = /^(?:project|user:[a-z0-9][a-z0-9-]{0,60}|archived:[a-z0-9][a-z0-9-]{0,60})$/;
const VERSION_REF = /^[\w.-]{1,80}\.md$/;
const ICON_VERSION_REF = /^[\w.-]{1,80}\.png$/;
/** A team whose icon may change: the project's or one of the person's (an archived team's id is not one). */
const ICON_TEAM_ID = /^(?:project|user:[a-z0-9][a-z0-9-]{0,60})$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const LOCALITIES = ['cloud', 'local', 'hybrid'] as const;
const WORK_SHAPES = ['feature', 'bugfix', 'refactor', 'research', 'release'] as const;
const RISKS = ['low', 'medium', 'high'] as const;

export type StudioMessage =
  | { type: 'ready' } | { type: 'refresh' } | { type: 'import' } | { type: 'discard-draft' } | { type: 'discard-kept' }
  /** The drafted team waiting for review was used (Use this team) or discarded (Discard, Start over): it is no longer kept. */
  | { type: 'proposal-done' }
  /** Watch it live (Team Live): `id`, the team whose run to show; without one, the newest run. */
  | { type: 'watch-live'; id?: string }
  /** The person's own rating of a team, 1 to 5 stars; 0 clears it. */
  | { type: 'rate'; id: string; rating: number }
  /** How the person last sorted and filtered the dashboard, kept so the tab opens that way again. */
  | { type: 'view'; sort: DashboardSort; attention: boolean }
  /** Cancel or "All teams" in the guided builder with unsaved changes: the host asks Discard changes / Save draft. */
  | { type: 'leave-wizard'; wizard: SavedWizard }
  /** "All teams" in the editor with unsaved changes: the host asks Discard changes / Save. */
  | { type: 'leave-editor'; edit: OpenEdit }
  /** What is unsaved right now (nothing, the builder, or the editor), kept if the panel is closed. */
  | { type: 'unsaved'; wizard?: SavedWizard; edit?: OpenEdit }
  | { type: 'open' | 'duplicate' | 'share' | 'archive' | 'restore' | 'use-in-chat' | 'open-markdown' | 'versions' | 'update-team'; id: string }
  | { type: 'version-view' | 'version-restore'; id: string; ref: string }
  /** `clone` (owner, 2026-11-18): the draft was cloned from a team, so its name must be one no team has (cloneNameProblem), checked here as well. */
  | { type: 'review'; seq: number; draft: TeamDraft; id?: string; clone?: true }
  | { type: 'save'; draft: TeamDraft; id: string; base: string }
  | { type: 'create'; draft: TeamDraft; target: StudioTarget; projectType?: { id: string; goal: string }; clone?: true }
  | { type: 'save-draft'; draft: TeamDraft; step: number; target: StudioTarget; startingPoint?: string; path?: BuilderPath }
  | { type: 'optimise-all' }
  | { type: 'staff-setup' }
  | { type: 'staff-room' }
  | { type: 'draft-team'; idea: string; outputFormat?: string; depth?: 'quick' | 'thorough'; private?: boolean }
  /** `seq`: the page's number for this request, sent back with the reply, so a reply to an earlier request is never taken for this one's (PR #75 review). */
  | { type: 'starting-point'; id: string; goal: string; locality: 'cloud' | 'local' | 'hybrid'; workShape?: AgentDiscoveryAnswers['workShape']; riskLevel?: AgentDiscoveryAnswers['riskLevel']; seq?: number }
  /**
   * Use as is (owner, 2026-11-17): an existing team, unchanged and with no name asked. With a project open it becomes the project's team; with none it
   * goes to the chat (a built-in is saved to My teams first). `discard`: the builder holds unsaved work, so the host asks before it is dropped.
   */
  | { type: 'use-team'; id: string; goal?: string; locality?: 'cloud' | 'local' | 'hybrid'; workShape?: AgentDiscoveryAnswers['workShape']; riskLevel?: AgentDiscoveryAnswers['riskLevel']; discard?: true }
  /**
   * Recommend a team for me (0.4.30, on the builder's first screen): the team these answers make, shown before Use as is or Clone and modify, which send
   * the same answers. `seq` matches the reply to the request.
   */
  | { type: 'recommend'; seq: number; goal: string; locality: 'cloud' | 'local' | 'hybrid'; workShape: AgentDiscoveryAnswers['workShape']; riskLevel: AgentDiscoveryAnswers['riskLevel'] }
  | { type: 'open-setting'; key: string }
  /** Improve with AI (0.4.27): the free local check and whether an AI review is possible, for this draft. */
  | { type: 'improve-check'; seq: number; draft: TeamDraft; id?: string }
  /** Ask for the AI review (one model call); `member` reviews one member only. */
  | { type: 'improve-ai'; seq: number; draft: TeamDraft; id?: string; member?: string }
  | { type: 'improve-cancel'; seq: number }
  /** Accept suggestions (by the ids the host gave) into the page's current draft; `edited` is the person's own wording for a single suggestion. */
  | { type: 'improve-accept'; seq: number; ids: string[]; draft: TeamDraft; id?: string; edited?: string }
  /**
   * Team icons (0.4.30). Upload: the host asks for a picture with VS Code's own file picker and checks it (PNG, JPEG or WebP by its bytes, at most 2 MB);
   * Generate: an image model makes one, after the cost is shown and the person agrees. Either way the host sends the picture to the page (icon-source),
   * which crops it to a square and re-encodes it as a 128 x 128 PNG, and answers with icon-set (or icon-failed); the host checks that PNG again before
   * it writes it. Remove goes back to the default; Restore brings back an earlier icon from the team's history, by its name there.
   */
  | { type: 'icon-upload' | 'icon-generate' | 'icon-remove'; id: string }
  | { type: 'icon-set'; seq: number; id: string; png: Buffer }
  | { type: 'icon-failed'; seq: number }
  | { type: 'icon-restore'; id: string; ref: string };

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Plain, required: string[], optional: string[] = []) => required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

/** A draft from the page: exact keys, bounded sizes, plain strings; content rules are checked by reviewDraft. */
export function parseDraft(value: unknown): TeamDraft | undefined {
  if (!isPlain(value) || !exactKeys(value, ['name', 'description', 'members'], ['private']) || !text(value.name, 120) || !text(value.description, 600) || !Array.isArray(value.members) || value.members.length > 12) return undefined;
  // The team's own private marking (0.4.27): true or absent, never anything else.
  if (value.private !== undefined && value.private !== true) return undefined;
  const members: DraftMember[] = [];
  for (const member of value.members) {
    // `reportsTo` is optional and must be allowed here, or a draft that carries the team's hierarchy is refused outright (0.4.19 review).
    if (!isPlain(member) || !exactKeys(member, ['name', 'role', 'model', 'tools', 'instructions'], ['reportsTo', 'privacy']) || !text(member.name, 60) || !text(member.role, 120) || !text(member.model, 160) || !text(member.instructions, 12_000)) return undefined;
    if (member.reportsTo !== undefined && !text(member.reportsTo, 60)) return undefined;
    if (member.privacy !== undefined && member.privacy !== 'private') return undefined;
    if (member.tools !== null && (!Array.isArray(member.tools) || member.tools.length > 80 || !member.tools.every((tool) => typeof tool === 'string' && TOOL_NAME.test(tool)))) return undefined;
    members.push({ name: member.name, role: member.role, model: member.model, tools: member.tools === null ? null : [...new Set(member.tools as string[])], instructions: member.instructions, ...(member.reportsTo ? { reportsTo: member.reportsTo as string } : {}), ...(member.privacy === 'private' ? { privacy: 'private' as const } : {}) });
  }
  return { name: value.name, description: value.description, members, ...(value.private === true ? { private: true } : {}) };
}

/**
 * How a team in the builder was started (owner, 2026-11-17), so Back from its Purpose step returns to the screen it came from: `scratch` (Create a new
 * team > From scratch), `clone` (Create a new team > Clone an existing team) or `existing` (Use an existing team > Clone and modify). A draft saved before
 * this has none, and goes back to Create a new team.
 */
export const BUILDER_PATHS = ['scratch', 'clone', 'existing'] as const;
export type BuilderPath = typeof BUILDER_PATHS[number];

/** The team a starting-point or use-team message names, with its answers. A saved team (lib:<slug>) is looked up in the listing when it is handled. */
function startRequest(message: Plain, allowEmpty: boolean): { id: string; locality?: 'cloud' | 'local' | 'hybrid'; workShape?: AgentDiscoveryAnswers['workShape']; riskLevel?: AgentDiscoveryAnswers['riskLevel'] } | undefined {
  const id = message.id;
  if (typeof id !== 'string' || !/^(?:recommend|empty|type:[a-z]+|gsd:[a-z-]+|lib:[a-z0-9][a-z0-9-]{0,60})$/.test(id) || (!allowEmpty && id === 'empty')) return undefined;
  if (message.locality !== undefined && !(LOCALITIES as readonly unknown[]).includes(message.locality)) return undefined;
  if (message.workShape !== undefined && !(WORK_SHAPES as readonly unknown[]).includes(message.workShape)) return undefined;
  if (message.riskLevel !== undefined && !(RISKS as readonly unknown[]).includes(message.riskLevel)) return undefined;
  const known = id === 'recommend' || id === 'empty' || id.startsWith('lib:') || PROJECT_TYPES.some((type) => id === `type:${type.id}`) || GSD_TEMPLATES.some((template) => id === `gsd:${template.id}`);
  if (!known) return undefined;
  return { id, ...(message.locality !== undefined ? { locality: message.locality as 'cloud' } : {}), ...(message.workShape ? { workShape: message.workShape as 'feature' } : {}), ...(message.riskLevel ? { riskLevel: message.riskLevel as 'low' } : {}) };
}

export function parseStudioMessage(value: unknown): StudioMessage | undefined {
  if (!isPlain(value) || typeof value.type !== 'string') return undefined;
  const message = value;
  const id = () => typeof message.id === 'string' && TEAM_ID.test(message.id);
  switch (message.type) {
    case 'ready': case 'refresh': case 'import': case 'discard-draft': case 'discard-kept': case 'proposal-done':
      return exactKeys(message, ['type']) ? { type: message.type } : undefined;
    case 'watch-live':
      if (!exactKeys(message, ['type'], ['id'])) return undefined;
      if (message.id === undefined) return { type: 'watch-live' };
      return typeof message.id === 'string' && ICON_TEAM_ID.test(message.id) ? { type: 'watch-live', id: message.id } : undefined;
    case 'view': {
      if (!exactKeys(message, ['type', 'sort', 'attention'])) return undefined;
      const view = dashboardView({ sort: message.sort, attention: message.attention });
      return view ? { type: 'view', ...view } : undefined;
    }
    case 'rate':
      return exactKeys(message, ['type', 'id', 'rating']) && typeof message.id === 'string' && ICON_TEAM_ID.test(message.id) && Number.isInteger(message.rating) && (message.rating as number) >= 0 && (message.rating as number) <= 5
        ? { type: 'rate', id: message.id, rating: message.rating as number } : undefined;
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
    case 'open': case 'duplicate': case 'share': case 'archive': case 'restore': case 'use-in-chat': case 'open-markdown': case 'versions': case 'update-team':
      return exactKeys(message, ['type', 'id']) && id() ? { type: message.type, id: message.id as string } : undefined;
    case 'version-view': case 'version-restore':
      return exactKeys(message, ['type', 'id', 'ref']) && id() && typeof message.ref === 'string' && VERSION_REF.test(message.ref) ? { type: message.type, id: message.id as string, ref: message.ref } : undefined;
    case 'review': {
      if (!exactKeys(message, ['type', 'seq', 'draft'], ['id', 'clone']) || !Number.isSafeInteger(message.seq) || (message.id !== undefined && !id())) return undefined;
      // A clone is a new team: an open team (id) is never one.
      if (message.clone !== undefined && (message.clone !== true || message.id !== undefined)) return undefined;
      const draft = parseDraft(message.draft);
      return draft ? { type: 'review', seq: message.seq as number, draft, ...(message.id !== undefined ? { id: message.id as string } : {}), ...(message.clone ? { clone: true as const } : {}) } : undefined;
    }
    case 'optimise-all': return isPlain(message) && exactKeys(message, ['type']) ? { type: 'optimise-all' } : undefined;
    case 'staff-setup': return exactKeys(message, ['type']) ? { type: 'staff-setup' } : undefined;
    case 'staff-room': return exactKeys(message, ['type']) ? { type: 'staff-room' } : undefined;
    case 'draft-team': {
      if (!exactKeys(message, ['type', 'idea'], ['outputFormat', 'depth', 'private']) || !text(message.idea, 2000) || !message.idea.trim()) return undefined;
      if (message.private !== undefined && typeof message.private !== 'boolean') return undefined;
      if (message.outputFormat !== undefined && !text(message.outputFormat, 300)) return undefined;
      if (message.depth !== undefined && message.depth !== 'quick' && message.depth !== 'thorough') return undefined;
      return { type: 'draft-team', idea: message.idea, ...(message.outputFormat ? { outputFormat: message.outputFormat } : {}), ...(message.depth === 'quick' || message.depth === 'thorough' ? { depth: message.depth } : {}), ...(message.private === true ? { private: true } : {}) };
    }
    case 'save': {
      if (!exactKeys(message, ['type', 'draft', 'id', 'base']) || !id() || !String(message.id).match(/^(?:project|user:)/) || typeof message.base !== 'string' || !/^[0-9a-f]{64}$/.test(message.base)) return undefined;
      const draft = parseDraft(message.draft);
      return draft ? { type: 'save', draft, id: message.id as string, base: message.base } : undefined;
    }
    case 'create': {
      if (!exactKeys(message, ['type', 'draft', 'target'], ['projectType', 'clone']) || (message.target !== 'project' && message.target !== 'user')) return undefined;
      if (message.clone !== undefined && message.clone !== true) return undefined;
      let projectType: { id: string; goal: string } | undefined;
      if (message.projectType !== undefined) {
        const candidate = message.projectType;
        if (!isPlain(candidate) || !exactKeys(candidate, ['id', 'goal']) || typeof candidate.id !== 'string' || !PROJECT_TYPES.some((type) => type.id === candidate.id) || !text(candidate.goal, 400)) return undefined;
        projectType = { id: candidate.id, goal: candidate.goal };
      }
      const draft = parseDraft(message.draft);
      return draft ? { type: 'create', draft, target: message.target, ...(projectType ? { projectType } : {}), ...(message.clone ? { clone: true as const } : {}) } : undefined;
    }
    case 'save-draft': {
      if (!exactKeys(message, ['type', 'draft', 'step', 'target'], ['startingPoint', 'path']) || !Number.isInteger(message.step) || (message.step as number) < 0 || (message.step as number) > 4 || (message.target !== 'project' && message.target !== 'user')) return undefined;
      if (message.startingPoint !== undefined && (typeof message.startingPoint !== 'string' || !/^[a-z0-9:-]{1,70}$/.test(message.startingPoint))) return undefined;
      if (message.path !== undefined && !(BUILDER_PATHS as readonly unknown[]).includes(message.path)) return undefined;
      const draft = parseDraft(message.draft);
      return draft ? { type: 'save-draft', draft, step: message.step as number, target: message.target, ...(message.startingPoint !== undefined ? { startingPoint: message.startingPoint as string } : {}), ...(message.path !== undefined ? { path: message.path as BuilderPath } : {}) } : undefined;
    }
    case 'starting-point': {
      if (!exactKeys(message, ['type', 'id', 'goal', 'locality'], ['workShape', 'riskLevel', 'seq']) || !text(message.goal, 400)) return undefined;
      // Where the models may run decides the members' tools, so it is always given (PR #75 review): a missing or undefined one is refused, never
      // taken for the cloud.
      if (!(LOCALITIES as readonly unknown[]).includes(message.locality)) return undefined;
      if (message.seq !== undefined && !Number.isSafeInteger(message.seq)) return undefined;
      const start = startRequest(message, true);
      return start ? { type: 'starting-point', ...start, goal: message.goal, locality: message.locality as 'cloud', ...(message.seq !== undefined ? { seq: message.seq as number } : {}) } : undefined;
    }
    case 'use-team': {
      if (!exactKeys(message, ['type', 'id'], ['goal', 'locality', 'workShape', 'riskLevel', 'discard']) || (message.goal !== undefined && !text(message.goal, 400))) return undefined;
      if (message.discard !== undefined && message.discard !== true) return undefined;
      const start = startRequest(message, false);
      return start ? { type: 'use-team', ...start, ...(typeof message.goal === 'string' ? { goal: message.goal } : {}), ...(message.discard === true ? { discard: true as const } : {}) } : undefined;
    }
    case 'recommend': {
      if (!exactKeys(message, ['type', 'seq', 'goal', 'locality', 'workShape', 'riskLevel']) || !Number.isSafeInteger(message.seq) || !text(message.goal, 400)) return undefined;
      if (!(LOCALITIES as readonly unknown[]).includes(message.locality) || !(WORK_SHAPES as readonly unknown[]).includes(message.workShape) || !(RISKS as readonly unknown[]).includes(message.riskLevel)) return undefined;
      return { type: 'recommend', seq: message.seq as number, goal: message.goal, locality: message.locality as 'cloud', workShape: message.workShape as 'feature', riskLevel: message.riskLevel as 'low' };
    }
    case 'improve-check': case 'improve-ai': {
      if (!exactKeys(message, ['type', 'seq', 'draft'], message.type === 'improve-ai' ? ['id', 'member'] : ['id']) || !Number.isSafeInteger(message.seq) || (message.id !== undefined && !id())) return undefined;
      if (message.member !== undefined && (typeof message.member !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(message.member))) return undefined;
      const draft = parseDraft(message.draft);
      if (!draft) return undefined;
      const extra = { ...(message.id !== undefined ? { id: message.id as string } : {}) };
      return message.type === 'improve-ai'
        ? { type: 'improve-ai', seq: message.seq as number, draft, ...extra, ...(message.member !== undefined ? { member: message.member as string } : {}) }
        : { type: 'improve-check', seq: message.seq as number, draft, ...extra };
    }
    case 'improve-cancel':
      return exactKeys(message, ['type', 'seq']) && Number.isSafeInteger(message.seq) ? { type: 'improve-cancel', seq: message.seq as number } : undefined;
    case 'improve-accept': {
      if (!exactKeys(message, ['type', 'seq', 'ids', 'draft'], ['id', 'edited']) || !Number.isSafeInteger(message.seq) || (message.id !== undefined && !id())) return undefined;
      const ids = message.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 40 || !ids.every((entry) => typeof entry === 'string' && /^s\d{1,3}$/.test(entry)) || new Set(ids).size !== ids.length) return undefined;
      if (message.edited !== undefined && (!text(message.edited, 12_000) || ids.length !== 1)) return undefined;
      const draft = parseDraft(message.draft);
      return draft ? { type: 'improve-accept', seq: message.seq as number, ids: ids as string[], draft, ...(message.id !== undefined ? { id: message.id as string } : {}), ...(message.edited !== undefined ? { edited: message.edited as string } : {}) } : undefined;
    }
    case 'icon-upload': case 'icon-generate': case 'icon-remove':
      return exactKeys(message, ['type', 'id']) && typeof message.id === 'string' && ICON_TEAM_ID.test(message.id) ? { type: message.type, id: message.id } : undefined;
    case 'icon-set': {
      if (!exactKeys(message, ['type', 'seq', 'id', 'png']) || !Number.isSafeInteger(message.seq) || typeof message.id !== 'string' || !ICON_TEAM_ID.test(message.id)) return undefined;
      const png = decodeIconBase64(message.png);
      return png ? { type: 'icon-set', seq: message.seq as number, id: message.id, png } : undefined;
    }
    case 'icon-failed':
      return exactKeys(message, ['type', 'seq']) && Number.isSafeInteger(message.seq) ? { type: 'icon-failed', seq: message.seq as number } : undefined;
    case 'icon-restore':
      return exactKeys(message, ['type', 'id', 'ref']) && typeof message.id === 'string' && ICON_TEAM_ID.test(message.id) && typeof message.ref === 'string' && ICON_VERSION_REF.test(message.ref) ? { type: 'icon-restore', id: message.id, ref: message.ref } : undefined;
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

export interface SavedWizard { draft: TeamDraft; step: number; target: StudioTarget; startingPoint?: string; path?: BuilderPath }
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
  /**
   * The open project folder, or undefined with none. Asked each time it is used, never kept, so a folder opened, closed or changed while the studio is open
   * is the one listed, saved to and tested in (PR #70 review carry-over: it was read once, when the panel opened).
   */
  root(): string | undefined;
  /** The window's folders changed: the studio lists the library again for the folder open now. */
  onDidChangeFolder?(listener: () => void): { dispose(): void };
  gather(): Promise<DirectoryInput>;
  knowledgeBase(): Promise<boolean>;
  sidebar: { prefill(text: string): Promise<void> };
  openFile(file: string): Promise<unknown>;
  openSetting(key: string): Promise<unknown>;
  /** Runs Update Team on a team file (preview, choices, and confirmation happen there). */
  updateTeam?(file: string): Promise<unknown>;
  readonly staffSetupPreview?: ReturnType<typeof import('./teamStudioStaffSetup').createStaffSetupPreview>;
  setUpStaffTeam?(): Promise<unknown>;
  /** Opens the Staff Room for this project's staff run. */
  openStaffRoom?(): Promise<unknown>;
  /** 0.4.28: whether a run of the team with this slug is going now, and opening Team Live to watch it. */
  liveRun?(slug: string): boolean;
  /** Opens Team Live; with a run id, on that run. */
  watchLive?(runId?: string): Promise<unknown>;
  /** The open project's run history (its activity history); asked only with a folder open. */
  history?(): Promise<ActivitySessionSummary[]>;
  /** The team runs going now, from the live activity feed: each run's id, the slug its team runs under, and the team's file when the feed has it. */
  runningTeams?(): RunningTeam[];
  /** A team run started or ended (the activity feed's own notification, never a timer), so the dashboard is listed again. */
  onDidChangeRuns?(listener: () => void): { dispose(): void };
  /** The last role test of each team, as Optimise all teams kept it: scores only, keyed by the team's identity (user:<slug>, archived:<slug>, project:<hash>). */
  roleTests?: { get(): unknown; set?(value: Record<string, RoleTestRecord>): Promise<void> };
  /** A drafted team waiting for the person to review it (Describe it, and AI drafts it), kept in this extension's storage on this computer. */
  proposal?: { get(): unknown; set(value: KeptProposal | undefined): Promise<void> };
  /** The person's own ratings of their teams, kept by each team's identity in this extension's storage on this computer (never in a team file). */
  ratings?: { get(): unknown; set(value: Record<string, RatingRecord>): Promise<void> };
  /** The dashboard's sort and filter, kept for the person in this extension's storage on this computer. */
  view?: { get(): unknown; set(value: { sort: DashboardSort; attention: boolean }): Promise<void> };
  confirm(message: string, action: string): Promise<boolean>;
  /** `validate`: why a value is not accepted yet, shown while the person types (undefined when it is). */
  ask(prompt: string, value: string, validate?: (value: string) => string | undefined): Promise<string | undefined>;
  /** Where to save a team's share file (`<team>.near-team.json`); undefined when the person cancelled. */
  pickShareTarget?(defaultName: string): Promise<string | undefined>;
  /** A share file (.near-team.json) or a team .md file to import. */
  pickImportSource(): Promise<string | undefined>;
  /** A picture to make the team's icon from (0.4.30): VS Code's own file picker. Its path stays here; the page is only ever sent the picture. */
  pickIconSource?(): Promise<string | undefined>;
  /** The person's home folder, so a share never carries a path inside it. */
  home?: string;
  applyProjectType(root: string, type: ProjectType, goal: string): Promise<unknown>;
  /**
   * What the model comparisons say each role should use, for a team that was just saved (owner, 2026-11-07: "as new teams are added, we should
   * automatically check and suggest model optimizations for the new members and roles that are created"). Undefined when no comparison has been run.
   */
  suggestModels?(members: Array<{ name: string; role?: string; model?: string }>): Promise<Array<{ member: string; model: string; current?: string; why: string; changes: boolean }>>;
  /**
   * The final step of adding a team (owner, 2026-11-08): run each member's role test with the candidate models and apply the winner, so a new team's
   * models come from evidence rather than a default. Returns what each member ended up with, or undefined when the person skipped it. `confirm: false`
   * means the caller has already asked, so no modal is shown; `signal` cancels the tests part-way. `file` is the team file the caller is acting on, the
   * most specific identity it has: a name alone can match both the project team and a library team (see optimiseTarget).
   */
  optimiseTeam?(members: Array<{ name: string; role?: string; model?: string }>, teamName: string, options?: { signal?: AbortSignal; confirm?: boolean; file?: string }): Promise<{ applied: number; text: string } | undefined>;
  /** The models a role test would try, so testing every team can show the whole cost once before it starts. */
  optimiseCandidates?(): Promise<string[]>;
  /**
   * What a Team Studio model call needs from the active profile (0.4.27): the catalogue, preferred models, routes, settings and today's spend. Every call
   * goes through teamModelCall with it, so the outbound check always runs. Throws (with a message to show) when there is no profile.
   */
  teamAi?(): Promise<TeamAiDeps>;
  /** The person asked everything to stop (Emergency stop), so long-running work can be cancelled. */
  onStop?(listener: () => void): { dispose(): void };
  /** A number from 0 (inclusive) to 1 (exclusive), for the variation each generated icon asks for; Math.random when absent (tests pass their own). */
  random?(): number;
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

/**
 * The library entry whose models a role test rewrites. The file the caller acted on decides when it is given and listed. Without one, a name can match
 * both the project team and a library team of the same name (agent review: the first name match won, so the wrong file's models could be rewritten): a
 * library team found by its slug comes first, then a library team by name, and the project team only when nothing in the library matches.
 */
export function optimiseTarget<T extends { file: string; project: boolean; team?: { name: string } }>(entries: readonly T[], teamName: string, file?: string): T | undefined {
  // On Windows the same file can be reached through a differently-cased path (`c:\\` against `C:\\`), so the comparison ignores case there.
  const same = (one: string, two: string) => (process.platform === 'win32' ? path.resolve(one).toLowerCase() === path.resolve(two).toLowerCase() : path.resolve(one) === path.resolve(two));
  if (file) return entries.find((entry) => same(entry.file, file));
  const library = entries.filter((entry) => !entry.project);
  return library.find((entry) => path.basename(entry.file, '.md') === slugify(teamName))
    ?? library.find((entry) => entry.team?.name === teamName)
    ?? entries.find((entry) => entry.project && entry.team?.name === teamName);
}

/** The most the AI review may write back: room for a dozen suggestions with rewritten instructions. */
const REFINE_MAX_TOKENS = 6000;
const BLOCKED_BY_SECRET = 'Something in this team looks like a key, token or password (see the local check). Remove it, then ask again: Improve with AI never sends it.';

/** Room for the chat format around the two messages, in tokens. */
const MESSAGE_OVERHEAD_TOKENS = 200;

/**
 * What one AI review costs at most (PR #69 review: it counted only the draft, so the "at most" could be exceeded). The input bound is the fixed prompt
 * plus the largest user prompt the review sends (MAX_REFINE_BYTES, which covers the team, the tool list and the findings), counted as one token per
 * byte, which no tokenizer goes below; the output bound is the reply's token cap. A local model costs nothing.
 */
function estimateFor(ai: TeamAiDeps, model: string): { estimate?: string } {
  const info = ai.models.find((candidate) => candidate.id === model);
  if (info?.privacyBoundary === 'local') return { estimate: 'free: it runs on this computer' };
  // 0.4.28 (PR #69 review): a model with no price information says so, rather than leaving the cost out as if it were free.
  if (info?.inputPricePerMillion === undefined && info?.outputPricePerMillion === undefined) return { estimate: 'cost unknown: NEAR gives no price for this model' };
  const inputTokens = Buffer.byteLength(REFINE_PROMPT, 'utf8') + MAX_REFINE_BYTES + MESSAGE_OVERHEAD_TOKENS;
  const cost = (inputTokens * (info.inputPricePerMillion ?? 0) + REFINE_MAX_TOKENS * (info.outputPricePerMillion ?? 0)) / 1_000_000;
  // Rounded up, so the figure shown is never below the ceiling.
  return { estimate: `at most about $${Math.max(0.01, Math.ceil(cost * 100) / 100).toFixed(2)} (one call)` };
}

/** Wires the studio page to the team library. Returns refresh/dispose for the host and the tests. */
export function attachTeamStudio(host: StudioHost, deps: TeamStudioDeps): { refresh(): Promise<void>; startWizard(target: StudioTarget): Promise<void>; dispose(): void; ready: Promise<void> } {
  let input: DirectoryInput | undefined;
  let context: StudioContext | undefined;
  let library: LibraryState = { teams: [], archived: [] };
  let open: OpenTeam | undefined;
  let pendingWizard: StudioTarget | undefined;
  /** A Use as is is running (asking, or writing): another is ignored until it has answered. */
  let usingTeam = false;
  /**
   * Team icons (0.4.30). `iconWorking`: the host is choosing, asking about or making a picture now (a file picker, the cost question, an image model);
   * another icon request is refused until it has answered. `iconWaiting`: the picture was sent to the page, which answers with its PNG for that number;
   * a newer request replaces it, so a page that never answers cannot block the next one.
   */
  let iconSeq = 0;
  let iconWorking = false;
  /** `generated`: the picture came from the image model, so the PNG the page makes of it is compared with the other teams' icons (see icon-set). */
  let iconWaiting: { seq: number; id: string; file: string; generated?: IconJob } | undefined;
  let pageReady = false;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** What the page last said is unsaved; kept if the panel closes. */
  let unsaved: { wizard?: SavedWizard; edit?: OpenEdit } = {};
  const post = (message: unknown) => { void host.webview.postMessage(message); };
  /**
   * Improve with AI's current request (0.4.27). One at a time: a new request, Cancel, Emergency stop, opening another team, leaving the editor or closing
   * the panel aborts it, and a reply for any other sequence number is dropped. The suggestions stay here, keyed by id, so the page accepts them by id
   * and never sends a suggestion of its own. Nothing here is saved: pending suggestions are gone when the panel closes.
   */
  let refine: { seq: number; id?: string; suggestions: Map<string, Suggestion>; controller?: AbortController } | undefined;
  const cancelRefine = () => { refine?.controller?.abort(); if (refine) refine.controller = undefined; };
  const choose = (message: string, ...actions: string[]): Promise<string | undefined> => deps.choose
    ? deps.choose(message, ...actions)
    : deps.confirm(message, actions[0]).then((yes) => (yes ? actions[0] : undefined));

  /** The local check's counts by file content, so a listing checks only what changed. Bounded: cleared when it grows past a few hundred files. */
  const checks = new Map<string, CheckCounts | undefined>();
  const listNow = async () => {
    if (checks.size > 500) checks.clear();
    library = await listLibrary(deps.library, deps.root(), input!, { checks });
    await adoptKept();
  };
  /** This project's identity (its folder's real path, hashed), worked out once per folder. */
  let identity: { root: string; id: string } | undefined;
  const projectId = async (root = deps.root()): Promise<string | undefined> => {
    if (!root) return undefined;
    if (identity?.root !== root) identity = { root, id: await projectIdentity(root) };
    return identity.id;
  };
  const keyOf = async (team: LibraryTeam) => teamKey({ kind: team.kind, slug: team.id.slice('user:'.length) }, await projectId());
  /**
   * Once per team (PR 86 review): a `rating:` line an earlier build wrote into a team file is read into the kept ratings (the file is left as it is), and
   * role tests kept under the old path keys move to the teams' identities. Then each listed team gets its rating from the kept ratings.
   */
  const adoptKept = async () => {
    const project = await projectId();
    const keyed = library.teams.map((team) => ({ team, key: teamKey({ kind: team.kind, slug: team.id.slice('user:'.length) }, project) }));
    let ratings: Record<string, RatingRecord> = parseRatings(deps.ratings?.get());
    if (deps.ratings) {
      let adopted = false;
      for (const { team, key } of keyed) {
        if (!key || key in ratings || !team.legacyRating) continue;
        ratings = withRating(ratings, key, team.legacyRating, new Date().toISOString());
        adopted = true;
      }
      if (adopted) await deps.ratings.set(ratings).catch(() => undefined);
    }
    if (deps.roleTests?.set) {
      const records = parseRoleTests(deps.roleTests.get());
      const moves = keyed.flatMap(({ team, key }) => (key && legacyRoleTestKey(team.file) in records ? [{ from: legacyRoleTestKey(team.file), to: key }] : []));
      // A team archived before the upgrade was tested where it lived then, in the library folder (PR 86 review): its record is looked for under that
      // path, and under the name it had before the archive told it apart with a number (web-team-2.md archived from web-team.md).
      for (const entry of library.archived) {
        const name = path.basename(entry.file);
        const from = [entry.file, path.join(deps.library.directory, name), path.join(deps.library.directory, name.replace(/-\d+\.md$/, '.md'))].map(legacyRoleTestKey).find((candidate) => candidate in records);
        if (from) moves.push({ from, to: entry.id });
      }
      const moved = migrateRoleTests(records, moves);
      if (moved.changed) await deps.roleTests.set(moved.records).catch(() => undefined);
    }
    for (const { team, key } of keyed) {
      // Without a place to keep ratings (an older host), a line in the file is still shown; with one, only what is kept counts.
      const rating = deps.ratings ? (key ? ratings[key]?.rating : undefined) : team.legacyRating;
      if (rating) team.rating = rating; else delete team.rating;
    }
  };
  /**
   * The run history, read once and kept until a run starts or ends, the folder changes or the page asks for Refresh (PR 86 review: every library, state
   * and dashboard message, and every Watch it live, read the whole history again).
   */
  let historyRead: Promise<{ history: boolean; sessions: ActivitySessionSummary[] }> | undefined;
  const forgetHistory = () => { historyRead = undefined; };
  /**
   * A `rating:` line an earlier build wrote, dropped from what is saved once the rating is kept on this computer (PR 86 review, round 5), so the next save
   * of the team through the studio takes it out of the file, a project team's included. A host with nowhere to keep ratings leaves it: it is the only copy.
   */
  const withoutAdoptedRating = async (markdown: string, id: string): Promise<string> => {
    const team = teamFor(id);
    const key = team ? await keyOf(team) : undefined;
    if (!deps.ratings || !key || !(key in parseRatings(deps.ratings.get()))) return markdown;
    return withTeamRating(markdown, undefined);
  };
  /** Rating writes, one after another. */
  let ratingWrites: Promise<unknown> = Promise.resolve();
  /**
   * What is kept for a team moves with it (archive, restore), or is dropped for a new team under a name an earlier team had (create, duplicate, import,
   * a new project team), so a new team never inherits another's stars or health (PR 86 review, round 3). Written in turn with the ratings.
   */
  const moveKeptFor = async (from: string | undefined, to: string | undefined) => {
    if (!from) return;
    const write = ratingWrites.then(async () => {
      if (deps.ratings) {
        const now = parseRatings(deps.ratings.get());
        const next = moveKept(now, from, to);
        if (JSON.stringify(next) !== JSON.stringify(now)) await deps.ratings.set(next);
      }
      if (deps.roleTests?.set) {
        const now = parseRoleTests(deps.roleTests.get());
        const next = moveKept(now, from, to);
        if (JSON.stringify(next) !== JSON.stringify(now)) await deps.roleTests.set(next as Record<string, RoleTestRecord>);
      }
    });
    ratingWrites = write.catch(() => undefined);
    await write.catch(() => undefined);
  };
  const userKey = (file: string) => `user:${slugify(path.basename(file, '.md'))}`;
  /** The dashboard last worked out, which Watch it live reads its run from. */
  let lastDashboard: TeamDashboard | undefined;
  const load = async () => {
    input = await deps.gather();
    context = buildStudioContext(input, { hasProject: Boolean(deps.root()), knowledgeBase: await deps.knowledgeBase().catch(() => false) });
    await listNow();
  };
  const refresh = async () => {
    forgetHistory();
    await load();
    const saved = savedWizard(deps.drafts.get());
    forgetClone();
    rememberSavedClone();
    const kept = keptWork(deps.kept?.get());
    // The builder's draft is already the resumable draft: say once that it was kept. An open
    // team's changes stay kept until the user reopens or discards them.
    if (kept?.kind === 'wizard' || (kept?.kind === 'editor' && !library.teams.some((team) => team.id === kept.id))) await deps.kept?.set(undefined);
    const view = dashboardView(deps.view?.get());
    // A host with somewhere to keep a drafted team always says whether one is waiting (null: none), so a page holding one that was used elsewhere drops it.
    const waiting = deps.proposal ? { proposal: keptProposal(deps.proposal.get()) ?? null } : {};
    post({ type: 'state', library: pageLibrary(library), dashboard: await dashboardOf(), ...(view ? { view } : {}), ...waiting, context, picker: teamPicker(context!.startingPoints, library.teams), ...(saved ? { savedDraft: saved } : {}), ...(kept?.kind === 'wizard' && saved ? { kept: { kind: 'wizard', text: KEPT_WIZARD_TEXT } } : kept?.kind === 'editor' && library.teams.some((team) => team.id === kept.id) ? { kept: { ...kept, text: `Your unsaved changes to "${kept.name || 'the team'}" were kept as a draft.` } } : {}) });
  };
  const refreshLibrary = async () => {
    if (!input) return;
    await listNow();
    await postLibrary(await dashboardOf());
  };
  const postLibrary = async (dashboard: TeamDashboard) => {
    post({ type: 'library', library: pageLibrary(library), dashboard, ...(context ? { picker: teamPicker(context.startingPoints, library.teams) } : {}) });
  };
  /**
   * The dashboard from the listing held now: the open project's run history (none without a folder, or when it cannot be read, which the page then says
   * rather than showing zeros as fact), the runs going now, and the role tests kept.
   */
  const dashboardOf = async (): Promise<TeamDashboard> => {
    historyRead ??= (async () => {
      if (!deps.root() || !deps.history) return { history: false, sessions: [] };
      try { return { history: true, sessions: await deps.history() }; } catch { return { history: false, sessions: [] }; }
    })();
    const { history, sessions } = await historyRead;
    let running: RunningTeam[] = [];
    try { running = deps.runningTeams?.() ?? []; } catch { running = []; }
    const project = await projectId();
    lastDashboard = buildDashboard({ now: Date.now(), history, sessions, running, roleTests: parseRoleTests(deps.roleTests?.get()) as Record<string, RoleTestRecord>, teams: library.teams.map((team) => dashboardTeam(team, project)) });
    return lastDashboard;
  };
  /** A team run started or ended: the dashboard alone is sent again, once for a burst of changes. */
  let dashboardTimer: ReturnType<typeof setTimeout> | undefined;
  const dashboardSoon = () => {
    if (dashboardTimer) clearTimeout(dashboardTimer);
    dashboardTimer = setTimeout(() => { dashboardTimer = undefined; void dashboardOf().then((dashboard) => post({ type: 'dashboard', dashboard }), () => undefined); }, 150);
    dashboardTimer.unref?.();
  };
  /** A run of the open team started or ended: its Team shape tab's Watch it live link follows (it was only set when the team was opened). */
  const liveSoon = () => {
    if (!open || !deps.liveRun) return;
    post({ type: 'live-run', id: open.id, liveRun: deps.liveRun(slugify(path.basename(open.file, '.md'))) === true });
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

  /** Which model Improve with AI would use for this draft under the privacy rule, or why none may (refinePlan). */
  /**
   * Whether this workspace's project has a knowledge base, read from the workspace on every call and never from a message (PR #69 review). A check that
   * fails counts as yes, so a model call is private rather than sent on a guess.
   */
  const hostKnowledgeBase = () => deps.knowledgeBase().catch(() => true);
  const refinePlanFor = async (draft: TeamDraft): Promise<{ plan: RefinePlan; ai?: TeamAiDeps }> => {
    if (!deps.teamAi) return { plan: { ok: false, reason: 'No model is available here. Set up an AI profile for this project first.' } };
    let ai: TeamAiDeps;
    try { ai = await deps.teamAi(); } catch (error) { return { plan: { ok: false, reason: (error as Error).message } }; }
    // Any team in a project with a knowledge base is private, as its members' models already must be (reviewDraft); decided here, never from the page.
    return { plan: refinePlan(draft, { knowledgeBase: await hostKnowledgeBase(), choose: (need) => chooseTeamModel(need, ai) }), ai };
  };
  /** An imported team (or one made from an import) that is not approved: its text is untrusted, and the refiner is told so. */
  const untrustedFor = async (draft: TeamDraft, id: string | undefined): Promise<boolean> => {
    if (id) return Boolean(teamFor(id)?.imported);
    // A check that cannot run counts as untrusted (PR #75 review), so the review never treats such text as the person's own.
    return (await deps.library.unapprovedSource(draft.members).catch(() => 'unknown')) !== undefined;
  };

  const versionsOf = async (file: string) => (await deps.library.versions(file)).map((version) => ({ ref: path.basename(version), label: versionLabel(path.basename(version)) }));
  /**
   * What an icon made with AI would need (0.4.30): a private image model for a private team (marked private, or every member private) or for any team in
   * a project with a knowledge base, decided here from the saved team file and the workspace, never from the page. `why` opens the refusal.
   */
  const iconNeed = async (team: TeamDefinition): Promise<{ need: 'private' | 'any'; why?: string }> => {
    if (teamIsPrivate(team)) return { need: 'private' };
    if (await hostKnowledgeBase()) return { need: 'private', why: 'This project has a knowledge base, so its teams\' icons' };
    return { need: 'any' };
  };
  /** Whether Generate with AI can be offered for this saved team, with which model and at what cost, or the plain reason it cannot. */
  const iconAiFor = async (text: string, file: string): Promise<{ available: boolean; reason?: string; model?: string; private?: boolean; estimate?: string }> => {
    if (!deps.teamAi) return { available: false, reason: 'No model is available here. Set up an AI profile for this project first.' };
    let ai: TeamAiDeps;
    try { ai = await deps.teamAi(); } catch (error) { return { available: false, reason: (error as Error).message }; }
    let team: TeamDefinition;
    try { team = parseTeam(text, file); } catch { return { available: false, reason: 'This team file needs fixing first.' }; }
    const { need, why } = await iconNeed(team);
    const choice = chooseImageModel(need, ai, why);
    return choice.ok ? { available: true, model: choice.model, private: choice.private, estimate: imageEstimate(choice.info) } : { available: false, reason: choice.reason };
  };
  /** The team's icon now (a data URI), checked; undefined for the default. */
  const iconOf = async (file: string, text?: string) => { const bytes = await deps.library.readIcon(file, text); return bytes ? iconDataUri(bytes) : undefined; };
  /** The team's earlier icons, newest first, each checked before it is shown (one that is not a valid icon is left out). */
  const iconHistoryOf = async (file: string) => (await Promise.all((await deps.library.iconVersions(file)).map(async (version) => {
    const bytes = await readFile(version).catch(() => undefined);
    return bytes && checkTeamIcon(bytes) === undefined ? { ref: path.basename(version), label: versionLabel(path.basename(version)), icon: iconDataUri(bytes) } : undefined;
  }))).filter((entry): entry is { ref: string; label: string; icon: string } => entry !== undefined);

  const sendTeam = async (id: string, file: string, notice?: string) => {
    const textNow = await readFile(file, 'utf8');
    const draft = draftFromMarkdown(textNow, file);
    open = { id, file, text: textNow, base: hash(textNow) };
    const entry = teamFor(id);
    // A hand-written private value (tee, local) is shown as it is; the Private team box only ever writes or removes privacy: private (PR #69 review).
    const teamPrivacy = handWrittenTeamPrivacy(textNow);
    // 0.4.28: while a run of this team is going, the Team shape tab links to Team Live.
    const live = deps.liveRun?.(slugify(path.basename(file, '.md'))) === true;
    const icon = await iconOf(file, textNow);
    post({ type: 'team', id, kind: entry?.kind ?? (id === 'project' ? 'project' : 'user'), file: displayPath(file, deps.root()), command: entry?.command ?? '', draft, base: open.base, ...(teamPrivacy ? { teamPrivacy } : {}), ...(live ? { liveRun: true } : {}), versions: await versionsOf(file), ...(icon ? { icon } : {}), iconAi: await iconAiFor(textNow, file), graph: graphOf(textNow, file), knowledge: await knowledgeOf(file), ...(notice ? { notice } : {}) });
  };

  /**
   * Suggests a model for each member of a team that was just saved, from the comparisons that have been run. It never changes anything by itself: it
   * names the members whose tested best model differs and offers to open Compare Models, which is where one click applies the setup. Silent when no
   * comparison exists, because a suggestion without evidence is an opinion.
   */
  const suggestModelsFor = async (team: { members: Array<{ name: string; role?: string; model?: string }> }, id: string) => {
    if (!deps.suggestModels) return;
    let suggestions: Array<{ member: string; model: string; current?: string; why: string; changes: boolean }> = [];
    try { suggestions = await deps.suggestModels(team.members.map((member) => ({ name: member.name, ...(member.role ? { role: member.role } : {}), ...(member.model ? { model: member.model } : {}) }))); } catch { return; }
    const changes = suggestions.filter((entry) => entry.changes);
    if (!changes.length) return;
    const lines = changes.map((entry) => `${entry.member}: ${entry.model} (${entry.why}${entry.current ? `, now ${entry.current}` : ''})`);
    post({ type: 'model-suggestion', id, changes, text: `The comparisons suggest a different model for ${changes.length} member${changes.length === 1 ? '' : 's'}: ${lines.join('; ')}.` });
  };

  /**
   * The team as a shape for the page to draw (owner, 2026-11-08). Built from the text that was just read, and never allowed to break the studio: a file
   * that does not parse as a team gets no shape, and the page falls back to the draft it already shows.
   */
  /**
   * The team's knowledge graph for the network view (owner, 2026-11-08), laid out here so the page only has to draw. A team that has not learned
   * anything yet sends an empty graph, and the page says so rather than drawing an empty frame.
   */
  const knowledgeOf = async (file: string) => {
    try {
      // The same key a run of this team writes under, so a project team shows its own project's graph.
      const { knowledge, problem } = await loadKnowledge(deps.library.directory, teamKnowledgeKey(file));
      const layout = layoutNetwork(knowledge);
      return { nodes: layout.nodes, edges: layout.edges, width: layout.width, height: layout.height, coverage: gradingCoverage(knowledge), groups: nodeDetails(knowledge), ...(problem ? { problem } : {}) };
    } catch { return undefined; }
  };

  const graphOf = (textNow: string, file: string) => {
    try {
      const team = parseTeam(textNow, file);
      const graph = buildTeamGraph(team, isAbliteratedModel);
      return { team: graph.team, roots: graph.roots, orphaned: graph.orphaned };
    } catch { return undefined; }
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

  /**
   * Whether a new team's draft is a clone, worked out here rather than taken from the page (PR #90 review): the page's `clone`, or the clone the host
   * started. `cloneSource` is the current draft's clone, kept by the starting point it came from (round 3), never by its members' text alone: the latest
   * starting point the host sent (Clone and modify, from a saved team, a built-in or the recommendation), or a resumed draft that was cloned. Editing
   * every member's instructions does not make it something else. It is forgotten when another kind of team starts (an AI draft, an open team, a
   * discarded draft, Use as is), when the team is saved, and when the draft is emptied of members (From scratch clears them), so a later team that reuses
   * the same instructions is not taken for a clone.
   */
  let cloneSource: { from: string } | undefined;
  const rememberClone = (from: string) => { cloneSource = { from }; };
  const forgetClone = () => { cloneSource = undefined; };
  /** A resumed builder draft that was cloned (its path is clone or existing, and it started from a team) is the current draft's source. */
  const rememberSavedClone = () => {
    const saved = savedWizard(deps.drafts.get());
    if (saved && (saved.path === 'clone' || saved.path === 'existing') && saved.startingPoint && saved.startingPoint !== 'empty') rememberClone(saved.startingPoint);
  };
  const isCloneDraft = (draft: TeamDraft, flag?: true): boolean => {
    if (flag) return true;
    if (!cloneSource) return false;
    if (draft.members.length) return true;
    forgetClone();
    return false;
  };

  /**
   * A clone's name (owner, 2026-11-18): one no saved team, built-in team or this project's team has, compared ignoring case and by the file name it would
   * be saved under. One rule, here, for the page's inline message and for Save; the page has no naming rules of its own.
   */
  const cloneIssues = (draft: TeamDraft): DraftIssue[] => {
    // The name exactly as create saves it (message.draft.name.trim()), so the check and the file never disagree.
    const problem = cloneNameProblem(draft.name.replace(/[\r\n]+/g, ' ').trim(), takenTeamNames(library.teams, context?.startingPoints ?? []));
    return problem ? [{ field: 'name', message: problem }] : [];
  };

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
    await writeFile(file, await withoutAdoptedRating(review.markdown, edit.id), 'utf8');
    const version = await deps.library.snapshot(file);
    await refreshLibrary();
    return { file, notice: `Saved "${edit.draft.name.trim()}" as version ${version}.` };
  };

  /**
   * Which unapproved imported team any of these members was copied from (0.4.26), for the first-run question. A check that cannot run fails closed
   * (PR #75 review): it was read as "none", so a team could be written without the question that says where its members came from. The caller says
   * nothing was changed and writes nothing.
   */
  const importOrigin = async (members: ReadonlyArray<{ instructions: string }>, verb: 'used' | 'saved'): Promise<{ from: string | undefined } | undefined> => {
    try { return { from: await deps.library.unapprovedSource(members) }; } catch (error) {
      post({ type: 'error', text: `Not ${verb}: it could not be checked whether this team has members from an imported team you have not approved (${(error as Error).message}). Nothing was changed.` });
      return undefined;
    }
  };

  /**
   * Writes the project's team, the one way a save or Use as is replaces it: an existing team is replaced only after the person agrees, and is kept as a
   * version first (so it can be restored from History); the new team is versioned too. Undefined when the person kept the old one.
   */
  const writeProjectTeam = async (root: string, markdown: string, unapprovedFrom: string | undefined, projectType?: { type: ProjectType; goal: string }, icon?: Buffer): Promise<string | undefined> => {
    const file = TeamLibrary.projectTeamFile(root);
    const project = await projectId(root);
    const projectKey = project ? `project:${project}` : undefined;
    const before = await readFile(file, 'utf8').catch(() => undefined);
    // The same team set up again keeps the person's rating and its role-test health (PR 86 review); another team does not inherit them, and the question
    // says so when there are any to lose.
    const sameTeam = before !== undefined && sameTeamText(before, markdown);
    if (before !== undefined) {
      const loses = !sameTeam && projectKey !== undefined && (projectKey in parseRatings(deps.ratings?.get()) || projectKey in parseRoleTests(deps.roleTests?.get()));
      if (!await deps.confirm(`This project already has a team. Replace it? Its earlier versions stay in the team history.${loses ? ' Your rating of it and its role-test health are cleared, because they describe the team it replaces.' : ''}`, 'Replace')) return undefined;
      await deps.library.snapshot(file);
    }
    await mkdir(path.dirname(file), { recursive: true });
    // 0.4.30: the new team's icon goes beside it (a saved team used as is keeps its look), and an icon the old team had goes into the icon history, so
    // the new team never shows the old one's. The icon file is put in place first, then the team file is written once, naming it (its own file name,
    // whatever the team text said), and kept as one version (PR #82 review). If the team file cannot be written, the icon is put back as it was.
    const undo = icon ? await deps.library.placeIcon(file, icon) : await deps.library.retireIcon(file);
    try {
      await writeFile(file, withIconReference(markdown, icon ? TeamLibrary.iconName(file) : undefined), 'utf8');
    } catch (error) {
      if (undo) await undo().catch(() => { throw new TeamIconPartialError(`This project's team was not changed, but its icon could not be put back as it was: it shows ${icon ? 'the new team\'s icon' : 'its default icon'}. Its earlier icon is in History.`); });
      throw error;
    }
    // The team file is written from here on: a step after it that fails says so, never "not changed" (PR #75 review).
    const step = async (what: string, run: () => Promise<unknown>) => {
      try { await run(); } catch (error) { throw new ProjectTeamWrittenError(`This project's team was written, but ${what} failed${fileProblem(error)}. ${PROJECT_TEAM_WRITTEN_HINT}`); }
    };
    await step('keeping it in the team history', () => deps.library.snapshot(file));
    // The project's own consent is asked before it first runs, as for any project team; its question says the members came from that import.
    await step('recording which imported team its members came from', () => deps.library.setProjectDerived(file, unapprovedFrom));
    // A new project team: the replaced team's stars and health are not its own.
    if (!sameTeam) await moveKeptFor(projectKey, undefined);
    if (projectType) await step('writing this project type\'s guidance to AGENTS.md', () => deps.applyProjectType(root, projectType.type, projectType.goal));
    return file;
  };
  /**
   * After the team file was written and a later step failed: the listing is brought up to date (the new team is there), the builder's work is no longer
   * unsaved, and the person is told exactly what was and was not done.
   */
  const reportWritten = async (error: ProjectTeamWrittenError) => {
    unsaved = {};
    forgetClone();
    await refreshLibrary().catch(() => undefined);
    post({ type: 'error', text: error.message, written: 'project' });
  };

  const startWizard = async (target: StudioTarget) => {
    if (!pageReady) { pendingWizard = target; return; }
    post({ type: 'start-wizard', target: target === 'project' && !deps.root() ? 'user' : target });
  };
  const handle = async (message: StudioMessage) => {
    switch (message.type) {
      case 'ready': {
        deps.staffSetupPreview?.reset();
        await refresh();
        pageReady = true;
        markReady();
        if (pendingWizard) { const target = pendingWizard; pendingWizard = undefined; await startWizard(target); }
        return;
      }
      case 'refresh': await refresh(); return;
      case 'optimise-all': {
        // On demand, for every team at once (owner, 2026-11-08: "we can do a model optimization recommendation for all teams whenever the user wants").
        // The whole cost is worked out and asked about ONCE, before any run, and the notice after each team shows the work moving rather than a long silence.
        if (!deps.optimiseTeam) { post({ type: 'error', text: 'No model is available to test the teams. Set up an AI profile first.' }); return; }
        const all = await deps.library.list(deps.root());
        const teams = all.flatMap((entry) => entry.team ? [{ name: entry.team.name, file: entry.file, members: entry.team.members.map((member) => ({ name: member.name, ...(member.role ? { role: member.role } : {}), ...(member.model ? { model: member.model } : {}) })) }] : []);
        if (!teams.length) { post({ type: 'notice', text: 'There are no teams to test yet.' }); return; }
        const candidates = await deps.optimiseCandidates?.().catch(() => undefined) ?? [];
        // Each member is tested on each candidate model, which is what the role suite plans, so the total is members x models summed over the teams.
        const runs = candidates.length ? teams.reduce((total, team) => total + team.members.length * candidates.length, 0) : 0;
        const label = teams.length === 1 ? `"${teams[0]!.name}"` : `all ${teams.length} teams`;
        const breakdown = teams.map((team) => `${team.name}: ${team.members.length} member${team.members.length === 1 ? '' : 's'} x ${candidates.length} model${candidates.length === 1 ? '' : 's'}`).join(', ');
        // 0.4.19 review: "a few minutes" was wrong for six members and three models. The ceiling is stated, from the run count, so nobody starts this
        // expecting minutes.
        const ceiling = Math.max(1, Math.ceil((runs * 8) / 60));
        const cost = runs ? `${runs} runs (${breakdown}), one at a time, up to ${ceiling} hour${ceiling === 1 ? '' : 's'} at the very worst and usually much less. ` : 'A few minutes. ';
        const question = `Test the roles in ${label} and set each member's model? ${cost}Tested: ${candidates.length ? candidates.join(', ') : 'the models this machine is set up with'}. Costs tokens. Cancelling part-way keeps the teams already tested.`;
        if (await choose(question, 'Run the tests', 'Skip') !== 'Run the tests') return;
        // One controller for the whole run, so the person can cancel part-way and the teams that finished keep their results.
        const controller = new AbortController();
        const stop = deps.onStop?.(() => controller.abort());
        const results: string[] = [];
        let done = 0;
        try {
          for (const team of teams) {
            if (controller.signal.aborted) break;
            let outcome: string;
            try {
              const result = await deps.optimiseTeam(team.members, team.name, { signal: controller.signal, confirm: false, file: team.file });
              outcome = result ? result.text : team.name + ': skipped.';
            } catch (error) { outcome = team.name + ': ' + (error as Error).message; }
            results.push(outcome);
            done += 1;
            post({ type: 'notice', text: `${done} of ${teams.length} teams tested. ${outcome}` });
          }
        } finally { stop?.dispose(); }
        if (controller.signal.aborted && done < teams.length) results.push(`Cancelled after ${done} of ${teams.length} teams; the ones already tested kept their models.`);
        post({ type: 'notice', text: results.join(' ') });
        // The role tests just run count in each team's health on the dashboard. A team open in the editor was already told about its new models
        // (external-change, from optimiseTeam); it used to be sent again here under the id "library", and with none open this read an empty path and
        // showed a raw file-system error.
        await refreshLibrary();
        return;
      }
      case 'draft-team': {
        forgetClone();
        // One model call drafts the team from the person's own words (owner, 2026-11-08). The result goes back as a proposal the person reads first, and
        // only becomes a team when they accept it, so nothing is saved on the strength of one answer. Like Improve with AI, it goes through teamModelCall
        // (the outbound check) and the host's own privacy decision (PR #69 review): private when the person asked, or when the project has a knowledge base.
        if (!deps.teamAi) { post({ type: 'error', text: 'No model is available to draft a team. Set up an AI profile, or fill the team in by hand.' }); return; }
        post({ type: 'notice', text: 'Drafting the team...' });
        try {
          const ai = await deps.teamAi();
          const knowledgeBase = await hostKnowledgeBase();
          const brief = { idea: message.idea, ...(message.outputFormat ? { outputFormat: message.outputFormat } : {}), ...(message.depth ? { depth: message.depth } : {}), ...(message.private ? { private: true } : {}) };
          const reply = await teamModelCall(ai, { need: message.private || knowledgeBase ? 'private' : 'any', messages: [
            { role: 'system', content: TEAM_BUILDER_PROMPT },
            { role: 'user', content: builderPrompt(brief) }
          ], maxTokens: 2000 });
          if (!reply.ok) throw new Error(knowledgeBase && !message.private && reply.reason.startsWith('It needs a private model') ? `${KNOWLEDGE_BASE_PRIVATE} ${reply.reason}` : reply.reason);
          const drafted = parseProposal(reply.text, brief);
          // A team asked for as private stays private once it is a draft, so saving it keeps every member on a private model.
          const waiting: KeptProposal = { proposal: drafted.proposal as unknown as Record<string, unknown>, draft: { ...proposalDraft(drafted.proposal), ...(message.private ? { private: true } : {}) }, problems: drafted.problems };
          // PR 86 review, round 2: a drafted team cost a model call, so it is kept until the person uses or discards it, whatever else happens (a banner,
          // unsaved work, the studio closing).
          await deps.proposal?.set(waiting).catch(() => undefined);
          post({ type: 'team-proposal', ...waiting, text: proposalText(drafted.proposal) });
        } catch (error) { post({ type: 'error', text: `The team could not be drafted: ${(error as Error).message}` }); }
        return;
      }
      case 'improve-check': {
        // Step 1, instant and free: the local check, and whether (and with which model) the AI review could run.
        const findings = checkTeam(message.draft);
        const { plan, ai } = await refinePlanFor(message.draft);
        const blocked = findings.some((finding) => finding.severity === 'block');
        post({ type: 'improve-checked', seq: message.seq, findings, ai: plan.ok
          ? { available: !blocked, model: plan.model, private: plan.private, skipped: plan.skipped, ...(plan.note ? { note: plan.note } : {}), ...(blocked ? { reason: BLOCKED_BY_SECRET } : {}), ...(ai ? estimateFor(ai, plan.model) : {}) }
          : { available: false, reason: plan.reason, skipped: [] } });
        return;
      }
      case 'improve-ai': {
        // Step 2, on request: one model call through the outbound check. Requesting -> Reviewing | NothingToSuggest | Failed | Blocked | Cancelled.
        cancelRefine();
        const seq = message.seq;
        const draft = message.draft;
        // The request is current from the moment it arrives, so a Cancel sent while the model is still being chosen stops it before anything is sent.
        const controller = new AbortController();
        const current: NonNullable<typeof refine> = { seq, ...(message.id ? { id: message.id } : {}), suggestions: new Map<string, Suggestion>(), controller };
        refine = current;
        const findings = checkTeam(draft);
        const result = (state: 'blocked' | 'failed' | 'cancelled', reason: string) => { if (refine === current) current.controller = undefined; post({ type: 'improve-result', seq, state, reason, suggestions: [], dropped: [] }); };
        if (findings.some((finding) => finding.severity === 'block')) { result('blocked', BLOCKED_BY_SECRET); return; }
        if (message.member && !draft.members.some((member) => member.name === message.member)) { result('blocked', `${message.member} is not on the team.`); return; }
        const { plan, ai } = await refinePlanFor(draft);
        if (!plan.ok || !ai) { result('blocked', plan.ok ? 'No model is available here.' : plan.reason); return; }
        if (!input || !context) await load();
        const prompt = refinePrompt(draft, { findings, tools: context!.tools.map((tool) => ({ name: tool.name, description: tool.description })), skipped: plan.skipped, ...(message.member ? { member: message.member } : {}), untrusted: await untrustedFor(draft, message.id) });
        // A Cancel (or a newer request) that came while the model was being chosen wins over every later check (0.4.28, PR #69 review): the person is
        // told it was cancelled, not that the team is too large.
        if (refine !== current) return;
        if (controller.signal.aborted) { result('cancelled', 'Cancelled. Nothing changed.'); return; }
        // The cap holds for every review (a one-member one too), so the cost ceiling shown before asking is a true ceiling.
        if (Buffer.byteLength(prompt, 'utf8') > MAX_REFINE_BYTES) { result('blocked', message.member ? `${message.member}'s instructions are too long to review in one go. Shorten them first.` : 'This team is too large to review in one go. Review one member at a time.'); return; }
        post({ type: 'improve-state', seq, state: 'requesting', model: plan.model, private: plan.private });
        let reply: Awaited<ReturnType<typeof teamModelCall>>;
        try {
          reply = await teamModelCall(ai, { need: plan.need, messages: [{ role: 'system', content: REFINE_PROMPT }, { role: 'user', content: prompt }], maxTokens: REFINE_MAX_TOKENS, signal: controller.signal });
        } catch (error) {
          if (refine !== current) return;
          current.controller = undefined;
          if (controller.signal.aborted) result('cancelled', 'Cancelled. Nothing changed.');
          else result('failed', `The AI review failed: ${(error as Error).message} Nothing changed.`);
          return;
        }
        // A newer request (or Cancel) replaced this one: its reply is dropped.
        if (refine !== current) return;
        current.controller = undefined;
        if (controller.signal.aborted) { result('cancelled', 'Cancelled. Nothing changed.'); return; }
        if (!reply.ok) { result('blocked', reply.reason); return; }
        const parsed = parseRefinement(reply.text, draft, { tools: context!.tools.map((tool) => tool.name), skipped: plan.skipped, ...(message.member ? { member: message.member } : {}), ...(reply.finishReason ? { finishReason: reply.finishReason } : {}) });
        if (!parsed.readable) { result('failed', 'The reply could not be read as suggestions, so nothing changed. Try again.'); return; }
        current.suggestions = new Map(parsed.suggestions.map((suggestion) => [suggestion.id, suggestion]));
        post({
          type: 'improve-result', seq, state: parsed.suggestions.some((suggestion) => suggestion.kind !== 'advice') ? 'reviewing' : 'nothing',
          model: reply.model, private: reply.private, suggestions: parsed.suggestions, dropped: parsed.dropped, partial: parsed.partial, findings: findings.length,
          ...(parsed.summary ? { summary: parsed.summary } : {}), ...(parsed.rating ? { rating: parsed.rating } : {}), ...(plan.note ? { note: plan.note } : {})
        });
        return;
      }
      case 'improve-cancel': if (refine?.seq === message.seq) cancelRefine(); return;
      case 'improve-accept': {
        // Accept changes only the page's draft; Save writes it, with its base-hash check and a kept version, as for any edit.
        if (!refine || refine.seq !== message.seq) { post({ type: 'improve-applied', seq: message.seq, draft: message.draft, results: message.ids.map((id) => ({ id, state: 'stale', reason: 'This review is no longer current. Ask for a new one.' })) }); return; }
        let draft = message.draft;
        const results: Array<{ id: string; state: string; reason?: string }> = [];
        for (const id of message.ids) {
          const suggestion = refine.suggestions.get(id);
          if (!suggestion) { results.push({ id, state: 'invalid', reason: 'There is no such suggestion.' }); continue; }
          // Accept all covers wording only: a tool or member change is accepted on its own, never as part of a batch.
          if (message.ids.length > 1 && !ACCEPT_ALL_KINDS.includes(suggestion.kind)) { results.push({ id, state: 'pending', reason: 'Accept this one on its own.' }); continue; }
          const outcome = applySuggestion(draft, suggestion, { original: message.id && open?.id === message.id ? open.text : undefined, ...(message.edited !== undefined ? { edited: message.edited } : {}) });
          if ('draft' in outcome) { draft = outcome.draft; results.push({ id, state: 'accepted' }); } else results.push({ id, state: outcome.state, reason: outcome.reason });
        }
        post({ type: 'improve-applied', seq: message.seq, draft, results, findings: checkTeam(draft).length });
        return;
      }
      case 'review': {
        if (!input || !context) await load();
        const original = message.id && open?.id === message.id ? open.text : undefined;
        const review = reviewDraft(message.draft, original, input!, context!);
        if (!message.id && isCloneDraft(message.draft, message.clone)) review.errors.push(...cloneIssues(message.draft));
        // What the preview shows is what Save writes, the old rating line's removal included.
        post({ type: 'review', seq: message.seq, ...review, ...(message.id ? { markdown: await withoutAdoptedRating(review.markdown, message.id) } : {}) });
        return;
      }
      case 'starting-point': {
        if (!context) await load();
        const seqOf = message.seq !== undefined ? { seq: message.seq } : {};
        if (message.id.startsWith('lib:')) {
          // One of the person's saved teams: its members and description, exactly as saved, copied into the draft. Saving the draft as the project team
          // then goes through the same steps (and the same "use this project's team?" question before it first runs) as any other starting point.
          const team = teamFor(`user:${message.id.slice('lib:'.length)}`);
          if (!team || team.error) { post({ type: 'error', text: 'That team is no longer in your teams. Pick another starting point.', ...seqOf }); return; }
          const draft = draftFromMarkdown(await readFile(team.file, 'utf8'), team.file);
          rememberClone(message.id);
          post({ type: 'starting-point', id: message.id, ...seqOf, cloneName: cloneNameFor(team.name, takenTeamNames(library.teams, context!.startingPoints)), draft: { ...draft, name: '' } });
          return;
        }
        const point = context!.startingPoints.find((candidate) => candidate.id === message.id);
        // startRequest accepts only listed ids, so this cannot happen today; it still answers rather than leave the page waiting.
        if (!point) { post({ type: 'error', text: 'That starting point is not available here. Pick another one.', ...seqOf }); return; }
        const result = startingPointDraft(message, context!);
        // "Start empty" is not a team, so a draft made from it is not a clone.
        if (message.id === 'empty') forgetClone(); else rememberClone(message.id);
        // The name a clone starts with is worked out here, from the library as it is now, so the page never applies naming rules of its own.
        post({ type: 'starting-point', id: message.id, ...seqOf, cloneName: cloneNameFor(startingPointTeamName(point), takenTeamNames(library.teams, context!.startingPoints)), draft: result.draft, ...(result.projectType ? { projectType: result.projectType } : {}) });
        return;
      }
      case 'recommend': {
        // The team Use as is would make from these answers, under the name it would get, so what is shown is what is used.
        if (!input || !context) await load();
        const point = context!.startingPoints.find((candidate) => candidate.id === 'recommend');
        // Always listed today (buildStudioContext); if it ever is not, the page is told rather than left waiting for the reply.
        if (!point) { post({ type: 'error', text: 'Recommend a team is not available here. Pick a team instead.' }); return; }
        const result = startingPointDraft({ id: 'recommend', goal: message.goal, locality: message.locality, workShape: message.workShape, riskLevel: message.riskLevel }, context!);
        const own = startingPointTeamName(point);
        const name = deps.root() ? own : uniqueTeamName(own, library.teams);
        // The answers it was made from go back with it, so the page shows it only while they are still the ones on screen.
        post({ type: 'recommendation', seq: message.seq, answers: { goal: message.goal, locality: message.locality, workShape: message.workShape, riskLevel: message.riskLevel }, name, cloneName: cloneNameFor(own, takenTeamNames(library.teams, context!.startingPoints)), ...(deps.root() ? {} : { saveAs: name }), description: result.draft.description, members: result.draft.members.map((member) => ({ name: member.name, role: member.role })) });
        return;
      }
      case 'use-team': {
        // One at a time (PR #75 review): a second Use as is while one is still asking or writing is ignored, so a double click never asks twice or writes
        // twice. The page also waits for the answer before it offers the buttons again.
        // A second request is answered too (PR #75 review): a page that lost its waiting state, after a reload say, is told rather than left silent.
        if (usingTeam) { post({ type: 'error', text: 'Still working on the team you chose. Wait for it to finish.' }); return; }
        usingTeam = true;
        const use = message;
        try {
          await (async () => {
            // Use as is (owner, 2026-11-17): the team exactly as it is, with no name, description or "Save it as" to fill in. With a project open it becomes
            // the project's team; with none it goes to the chat. The same checks a save runs apply, so Use as is is never a way round them.
            if (!input || !context) await load();
            const root = deps.root();
            let saved: LibraryTeam | undefined;
            let savedIcon: Buffer | undefined;
            let name: string;
            let markdown: string;
            let members: DraftMember[];
            let fromType: ProjectType | undefined;
            const goal = (use.goal ?? '').trim().slice(0, 400);
            if (use.id.startsWith('lib:')) {
              // One of the person's saved teams, found in the current listing (never by a path from the page), copied byte for byte.
              saved = teamFor(`user:${use.id.slice('lib:'.length)}`);
              if (!saved || saved.error) { post({ type: 'error', text: 'That team is no longer in your teams. Pick another one.' }); return; }
              markdown = await readFile(saved.file, 'utf8');
              savedIcon = await deps.library.readIcon(saved.file, markdown);
              const draft = draftFromMarkdown(markdown, saved.file);
              const review = reviewDraft(draft, markdown, input!, context!);
              if (review.errors.length) { post({ type: 'error', text: `Not used: ${review.errors[0]!.message} Choose Clone and modify to change it.` }); return; }
              name = saved.name;
              members = draft.members;
            } else {
              // A built-in: made from its template under its own name. With no project it is saved to My teams, so its name is made unique there.
              const point = context!.startingPoints.find((candidate) => candidate.id === use.id);
              // startRequest accepts only ids that are listed, so this cannot happen today; it still answers rather than leave the page waiting.
              if (!point) { post({ type: 'error', text: 'That built-in team is not available here. Pick another one.' }); return; }
              const result = startingPointDraft({ id: use.id, goal, locality: use.locality ?? 'cloud', ...(use.workShape ? { workShape: use.workShape } : {}), ...(use.riskLevel ? { riskLevel: use.riskLevel } : {}) }, context!);
              name = root ? startingPointTeamName(point) : uniqueTeamName(startingPointTeamName(point), library.teams);
              const draft = { ...result.draft, name };
              const review = reviewDraft(draft, undefined, input!, context!);
              if (review.errors.length) { post({ type: 'error', text: `Not used: ${review.errors[0]!.message} Choose Clone and modify to change it.` }); return; }
              fromType = result.projectType ? PROJECT_TYPES.find((candidate) => candidate.id === result.projectType) : undefined;
              markdown = fromType ? stampTeam(review.markdown, fromType) : review.markdown;
              members = draft.members;
            }
            // Every outcome gets exactly one answer (PR #75 review): the project team opened (team), used, declined (used, with declined), or an error.
            // Anything that writes a team first checks where its members came from, before anything is asked.
            let unapprovedFrom: string | undefined;
            if (root || !saved) {
              const origin = await importOrigin(members, 'used');
              if (!origin) return;
              unapprovedFrom = origin.from;
            }
            // The builder had unsaved work: it is dropped only when the person agrees, as leaving the builder asks.
            if (use.discard && await choose(`Use "${name}" as is? The team you were building is not saved, so it will be discarded.`, 'Use as is') !== 'Use as is') {
              post({ type: 'used', declined: true, text: 'Not changed. The team you were building is still here.' });
              return;
            }
            if (root) {
              const file = await writeProjectTeam(root, markdown, unapprovedFrom, fromType ? { type: fromType, goal: goal || 'the work in this project' } : undefined, savedIcon);
              if (!file) { post({ type: 'used', declined: true, text: 'Not changed. This project\'s team is as it was.' }); return; }
              unsaved = {};
              forgetClone();
              await refreshLibrary();
              const unapprovedNote = unapprovedFrom === undefined ? '' : ` It has members from the imported team "${unapprovedFrom}", which you have not approved, so you are asked before it first runs.`;
              await sendTeam('project', file, `"${name}" is now this project's team. Run it with /team:project <task>.${fromType ? ' AGENTS.md now has this project type\'s guidance.' : ''}${unapprovedNote}`);
              return;
            }
            if (saved) {
              await deps.sidebar.prefill(saved.command ?? `/team:${use.id.slice('lib:'.length)} `);
              unsaved = {};
              forgetClone();
              post({ type: 'used', text: `${(saved.command ?? '').trim()} is in the chat box. Type your task after it and send.`, focus: saved.id });
              return;
            }
            // A built-in with no project: chat runs teams by their file, so it is saved to My teams first, under its own name.
            const file = await deps.library.create(name, markdown);
            await moveKeptFor(userKey(file), undefined);
            if (unapprovedFrom !== undefined) await deps.library.markImported(file, 'derived', unapprovedFrom);
            const slug = path.basename(file, '.md');
            unsaved = {};
            forgetClone();
            await refreshLibrary();
            await deps.sidebar.prefill(`/team:${slug} `);
            post({ type: 'used', text: `Saved "${name}" to My teams, and /team:${slug} is in the chat box. Type your task after it and send.`, focus: `user:${slugify(slug)}` });
            return;
          })();
        } catch (error) {
          // A confirm or write that fails still answers, so the page never waits with its buttons off (PR #75 review).
          // Path-free (PR #82 review, round 2): a file-system error names the file, so it is said in plain words; the icon errors already are plain.
          if (error instanceof ProjectTeamWrittenError) await reportWritten(error);
          else post({ type: 'error', text: error instanceof TeamIconError ? `Not used: ${error.message}` : `Not used: the team file could not be written${fileProblem(error)}.` });
        } finally { usingTeam = false; }
        return;
      }
      case 'open': {
        cancelRefine();
        forgetClone();
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
        cancelRefine();
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
        cancelRefine();
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
        // Whether this save ADDED a team, which decides whether the role tests run afterwards.
        let created = false;
        const review = reviewDraft(message.draft, undefined, input!, context!);
        // A clone's name is checked here too, against the library as it is now, so a page that let Save through (or a team saved meanwhile) cannot
        // give it a name a team already has.
        const cloned = isCloneDraft(message.draft, message.clone);
        if (cloned) { await listNow(); review.errors.push(...cloneIssues(message.draft)); }
        if (review.errors.length) { post({ type: 'save-failed', errors: review.errors }); return; }
        let file: string;
        let id: string;
        // A team made from a project type records the template and each member's generated definition, so Update Team can bring it up to date later.
        const fromType = message.projectType ? PROJECT_TYPES.find((candidate) => candidate.id === message.projectType!.id) : undefined;
        const markdown = fromType ? stampTeam(review.markdown, fromType) : review.markdown;
        // 0.4.26: a team with any member copied unchanged from an unapproved import (a saved team used as the starting point, a resumed draft, a member
        // pasted in) stays unapproved however it was made. Checked on the content, so no path round it depends on how the draft was built.
        const origin = await importOrigin(message.draft.members, 'saved');
        if (!origin) return;
        const unapprovedFrom = origin.from;
        if (message.target === 'project') {
          // The folder open now, read once for the whole save, so the file and the project type go to the same folder.
          const root = deps.root();
          if (!root) { post({ type: 'error', text: 'Open a project folder to save a project team, or save it to My teams.' }); return; }
          let written: string | undefined;
          try {
            written = await writeProjectTeam(root, markdown, unapprovedFrom, fromType ? { type: fromType, goal: message.projectType!.goal.trim().slice(0, 400) || message.draft.description.trim() } : undefined);
          } catch (error) {
            if (!(error instanceof ProjectTeamWrittenError)) throw error;
            // Written: the builder's draft is done with, as after any save.
            await deps.drafts.set(undefined).catch(() => undefined);
            await reportWritten(error);
            return;
          }
          if (!written) return;
          file = written;
          id = 'project';
        } else {
          file = await deps.library.create(message.draft.name.trim(), markdown);
          await moveKeptFor(userKey(file), undefined);
          if (unapprovedFrom !== undefined) await deps.library.markImported(file, 'derived', unapprovedFrom);
          id = `user:${slugify(path.basename(file, '.md'))}`;
          created = true;
        }
        await deps.drafts.set(undefined);
        forgetClone();
        await refreshLibrary();
        const unapprovedNote = unapprovedFrom === undefined ? '' : ` It has members from the imported team "${unapprovedFrom}", which you have not approved, so you are asked before it first runs.`;
        await sendTeam(id, file, `${message.target === 'project' ? `Saved the project team. Run it with /team:project <task>.${message.projectType ? ' AGENTS.md now has this project type\'s guidance.' : ''}` : `Saved "${message.draft.name.trim()}". Run it with /team:${path.basename(file, '.md')} <task>.`}${cloned ? CLONE_ICON_NOTE : ''}${unapprovedNote}`);
        // A team that was just saved is checked against the model results, so a new member does not silently keep a default model the tests disagree with.
        const saved = draftFromMarkdown(await readFile(file, 'utf8'), file);
        await suggestModelsFor(saved, id);
        // The final step of ADDING a team: test each member's role and set its model from what the test found. Only on create, because this spends minutes
        // and tokens: firing it on every edit-and-save would charge the person again for a team that was already measured (0.4.19 review). An existing team
        // is optimised on demand with "Optimise all teams".
        if (created && deps.optimiseTeam && saved.members.length) {
          try {
            const result = await deps.optimiseTeam(saved.members.map((member) => ({ name: member.name, ...(member.role ? { role: member.role } : {}), ...(member.model ? { model: member.model } : {}) })), saved.name, { file });
            if (result) { post({ type: 'notice', text: result.text }); await sendTeam(id, file); }
          } catch (error) { post({ type: 'error', text: `The role tests could not run: ${(error as Error).message}` }); }
        }
        return;
      }
      case 'save-draft': {
        await deps.drafts.set({ draft: message.draft, step: message.step, target: message.target, ...(message.startingPoint ? { startingPoint: message.startingPoint } : {}), ...(message.path ? { path: message.path } : {}) });
        post({ type: 'notice', text: 'Draft saved. Pick it up again from Team Studio at any time.' });
        return;
      }
      case 'discard-draft': forgetClone(); await deps.drafts.set(undefined); return;
      case 'proposal-done': await deps.proposal?.set(undefined); return;
      case 'watch-live': {
        // The team's own run when it has one going now (the listing's ids only); otherwise the newest run, as before.
        // The run is read from the dashboard the page was last sent, not by reading the history again (PR 86 review).
        const run = message.id ? lastDashboard?.cards[message.id]?.runId : undefined;
        await (run ? deps.watchLive?.(run) : deps.watchLive?.());
        return;
      }
      case 'view': await deps.view?.set({ sort: message.sort, attention: message.attention }); return;
      case 'rate': {
        // PR 86 review: the rating is the person's own opinion, kept on this computer by the team's identity and never written into the team file (a
        // project team's file goes wherever the project's files go, a code push included).
        const team = teamFor(message.id);
        if (!team) { post({ type: 'error', text: 'That team is no longer in your teams.' }); return; }
        if (team.error) { post({ type: 'error', text: 'Fix this team file first, then rate it.' }); return; }
        const key = await keyOf(team);
        if (!deps.ratings || !key) { post({ type: 'error', text: 'Ratings cannot be kept here.' }); return; }
        // One write after another (PR 86 review, round 2): two ratings sent together each read the store the other wrote, so neither is lost.
        const store = deps.ratings;
        const write = ratingWrites.then(() => store.set(withRating(parseRatings(store.get()), key, message.rating, new Date().toISOString())));
        ratingWrites = write.catch(() => undefined);
        try { await write; } catch { post({ type: 'error', text: 'The rating could not be saved. Nothing was changed.' }); return; }
        if (message.rating) team.rating = message.rating; else delete team.rating;
        await postLibrary(lastDashboard ?? await dashboardOf());
        post({ type: 'rated', id: message.id, rating: message.rating, text: message.rating ? `Rated ${team.name} ${message.rating} out of 5.` : `Cleared your rating of ${team.name}.` });
        return;
      }
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
      case 'staff-room': {
        await deps.openStaffRoom?.();
        return;
      }
      case 'staff-setup': {
        if (!deps.setUpStaffTeam) return;
        await deps.setUpStaffTeam();
        await refresh();
        return;
      }
      case 'update-team': {
        const file = fileFor(message.id);
        if (file && deps.updateTeam) { await deps.updateTeam(file); await refreshLibrary(); }
        return;
      }
      case 'duplicate': {
        const file = fileFor(message.id);
        const team = teamFor(message.id);
        if (!file || !team || team.error) return;
        // A copy's name is one no team has, as for Clone and modify (owner, 2026-11-18): offered unique, checked while typing, and checked again here.
        const taken = () => takenTeamNames(library.teams, context?.startingPoints ?? []);
        // Checked on the name as it is saved (cut to TEAM_NAME_MAX), so a long name cannot be cut into one another team has (PR #90 review, round 2).
        const typed = await deps.ask('Name for the copy', cloneNameFor(team.name, taken()), (value) => cloneNameProblem(savedTeamName(value), taken()));
        const name = savedTeamName(typed ?? '');
        if (!name) return;
        // The listing as it is now, as create reads it (PR #90 review), so a team saved meanwhile is counted.
        if (!input || !context) await load(); else await listNow();
        const problem = cloneNameProblem(name, taken());
        if (problem) { post({ type: 'error', text: `Not duplicated: ${problem}` }); return; }
        const { file: copy, icon } = await deps.library.duplicateTeam(file, name);
        await moveKeptFor(userKey(copy), undefined);
        await refreshLibrary();
        // The copy is made even when its icon could not be copied: it shows the default icon, and the notice says so (PR #82 review).
        post({ type: 'notice', text: `Duplicated as "${name}".${icon === 'default' ? ' It was copied with the default icon, because the icon could not be copied. Upload it again on its Purpose tab.' : ''}`, focus: `user:${slugify(path.basename(copy, '.md'))}` });
        return;
      }
      case 'archive': {
        const file = fileFor(message.id, ['user']);
        if (!file) return;
        const name = teamFor(message.id)?.name ?? path.basename(file, '.md');
        const archived = await deps.library.archive(file);
        await moveKeptFor(userKey(file), `archived:${slugify(path.basename(archived, '.md'))}`);
        if (open?.id === message.id) open = undefined;
        await refreshLibrary();
        post({ type: 'notice', text: `Archived "${name}". Restore it from Archived teams.` });
        return;
      }
      case 'restore': {
        const file = fileFor(message.id, ['archived']);
        if (!file) return;
        const restored = await deps.library.restore(file);
        await moveKeptFor(`archived:${slugify(path.basename(file, '.md'))}`, userKey(restored));
        await refreshLibrary();
        post({ type: 'notice', text: `Restored "${path.basename(restored, '.md')}".`, focus: `user:${slugify(path.basename(restored, '.md'))}` });
        return;
      }
      case 'import': {
        const source = await deps.pickImportSource();
        if (!source) return;
        // Checked before anything is written, then shown to the person, who decides. A refused file says why in plain words and changes nothing.
        let read: ReadPackage;
        try {
          const size = (await stat(source)).size;
          if (size > MAX_TEAM_PACKAGE_BYTES) throw new TeamPackageError('This file is too large to be a SovAI agent team, so it was not imported.');
          const textIn = await readFile(source, 'utf8');
          read = source.toLowerCase().endsWith('.md') ? readTeamMarkdown(textIn) : readTeamPackage(textIn);
        } catch (error) {
          post({ type: 'error', text: error instanceof TeamPackageError ? error.message : `The file could not be read: ${(error as Error).message}` });
          return;
        }
        if (await choose(importQuestion(read), 'Add to my teams') !== 'Add to my teams') { post({ type: 'notice', text: 'Nothing was imported.' }); return; }
        // Someone else's rating is not the person's own: it is left out, so the card shows only ratings they gave.
        const file = await deps.library.importTeam(read.team.name, withTeamRating(read.markdown, undefined));
        await moveKeptFor(userKey(file), undefined);
        // 0.4.30: the icon the file carried, checked when it was read, goes beside the new team under its own name. Without one, the imported text's
        // icon line is removed, so it can never show an icon file it happens to name (one left in the library folder, say).
        let iconNote = '';
        // The team is in the library by now: an icon that cannot be written is reported in the notice, never as an error after the fact (PR #82 review,
        // round 2), and the list is still refreshed below. The file-system error names a path, so it is not passed on.
        if (read.icon) {
          try { await deps.library.setIcon(file, read.icon); iconNote = ' Its icon was added too.'; } catch { iconNote = ' Its icon could not be saved, so it shows the default icon. You can upload it again from its Purpose tab.'; }
        } else {
          try { await deps.library.removeIcon(file); } catch { iconNote = ' Its team file could not be cleaned of the icon it names; check its icon on its Purpose tab.'; }
          if (read.iconProblem) iconNote = ` Its icon was left out: ${read.iconProblem}${iconNote}`;
        }
        let knowledgeNote = '';
        if (read.knowledge) {
          const target = knowledgeFile(deps.library.directory, teamKnowledgeKey(file));
          if (await exists(target)) knowledgeNote = ' Its knowledge graph was not added, because a graph for that name is already here.';
          else {
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, `${JSON.stringify({ ...read.knowledge, team: teamKnowledgeKey(file) })}\n`, { encoding: 'utf8', flag: 'wx' });
            knowledgeNote = ` Its knowledge graph (${read.facts} fact${read.facts === 1 ? '' : 's'}) was added too.`;
          }
        }
        await refreshLibrary();
        await sendTeam(`user:${slugify(path.basename(file, '.md'))}`, file, `Added "${read.team.name}" to your teams. It is not trusted yet: the first time it runs, you are asked to approve it.${knowledgeNote}${iconNote}`);
        return;
      }
      case 'share': {
        const file = fileFor(message.id);
        const entry = teamFor(message.id);
        if (!file || !entry || entry.error) return;
        if (!deps.pickShareTarget) { post({ type: 'error', text: 'Sharing is not available here.' }); return; }
        // The person's own rating stays here: it is their opinion, not part of the team (a version 1 file read by any build).
        const markdown = withTeamRating(await readFile(file, 'utf8'), undefined);
        const problems = shareProblems(markdown, file, deps.home);
        if (problems.refused) { post({ type: 'error', text: problems.refused }); return; }
        if (problems.paths.length && !await deps.confirm(`${problems.paths.join(', ')} ${problems.paths.length === 1 ? 'names' : 'name'} a folder on this computer. Anyone you send the team to will see it. Share it anyway?`, 'Share anyway')) return;
        // The knowledge graph stays here unless the person includes it (off by default); a graph is cleaned of local paths and secrets first.
        let knowledge: TeamKnowledge | undefined;
        const loaded = await loadKnowledge(deps.library.directory, teamKnowledgeKey(file)).catch(() => undefined);
        const facts = loaded ? loaded.knowledge.nodes.reduce((total, node) => total + node.facts.length, 0) : 0;
        if (loaded && !loaded.problem && facts > 0) {
          const choice = await choose(`Include this team's knowledge graph (${facts} fact${facts === 1 ? '' : 's'})? It stays on this computer unless you include it. Facts can hold what the team learned in your projects; local paths and anything that looks like a key are removed first.`, 'Share without it', 'Include it');
          if (choice === undefined) return;
          if (choice === 'Include it') {
            knowledge = cleanKnowledge(loaded.knowledge, deps.home);
            if (!knowledge) { post({ type: 'error', text: 'The knowledge graph holds something that looks like a key or password even after cleaning, so it was not included. Share the team without it.' }); return; }
          }
        }
        const target = await deps.pickShareTarget(`${message.id === 'project' ? 'project-team' : path.basename(file, '.md')}${TEAM_PACKAGE_EXTENSION}`);
        if (!target) return;
        // 0.4.30: the team's icon goes with it (checked again as it is read); a team without one is shared as a version 1 file every build reads.
        const icon = await deps.library.readIcon(file, markdown);
        await writeFile(target, buildTeamPackage(markdown, file, knowledge, icon), 'utf8');
        const extras = [...(knowledge ? ['its knowledge graph'] : []), ...(icon ? ['its icon'] : [])];
        post({ type: 'notice', text: `Saved "${entry.name}" to ${path.basename(target)}${extras.length ? ` with ${extras.join(' and ')}` : ''}. Send that file to share the team; whoever imports it sees what it contains and is asked before it is added or run.` });
        return;
      }
      case 'versions': {
        const file = fileFor(message.id);
        // The earlier icons go with the History tab, which asks for this when it opens (PR #82 review): a team opened on another tab is not sent up to
        // 20 pictures it does not show.
        if (file) post({ type: 'versions', id: message.id, versions: await versionsOf(file), iconHistory: await iconHistoryOf(file) });
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
      case 'icon-upload': {
        const file = fileFor(message.id);
        if (!file) { post({ type: 'error', text: 'That team is no longer in your teams.' }); return; }
        if (iconWorking) { post({ type: 'error', text: 'Still working on an icon. Wait for it to finish.' }); return; }
        if (!deps.pickIconSource) { post({ type: 'error', text: 'Uploading an icon is not available here.' }); return; }
        // The latest request wins, as for Remove and Restore: a picture still on its way from the page for an earlier one is not used after this.
        iconWaiting = undefined;
        iconWorking = true;
        try {
          const source = await deps.pickIconSource();
          if (!source) { post({ type: 'icon-done', id: message.id }); return; }
          // Its size first, so a huge file is never read; then its bytes decide what it is, never its name. Its path is never sent or shown.
          const size = (await stat(source)).size;
          if (size > MAX_ICON_SOURCE_BYTES) { post({ type: 'error', text: 'The image is larger than 2 MB. Choose a smaller one.' }); return; }
          const bytes = await readFile(source);
          const problem = iconSourceProblem(bytes);
          if (problem) { post({ type: 'error', text: problem }); return; }
          sendIconSource(message.id, file, iconSourceType(bytes)!, bytes);
        } catch {
          // A file-system error names the file's path, so it is not passed on.
          post({ type: 'error', text: 'The image could not be read. Choose another one.' });
        } finally { iconWorking = false; }
        return;
      }
      case 'icon-generate': {
        // An icon made by an image model from the team's name and what it is for (nothing else from the team). The model, the privacy rule and the
        // outbound check are decided here, before the person is asked about the cost; the check runs again just before the call (teamImageCall).
        const file = fileFor(message.id);
        if (!file) { post({ type: 'error', text: 'That team is no longer in your teams.' }); return; }
        if (iconWorking) { post({ type: 'error', text: 'Still working on an icon. Wait for it to finish.' }); return; }
        if (!deps.teamAi) { post({ type: 'error', text: 'No model is available here. Set up an AI profile for this project first.' }); return; }
        iconWaiting = undefined;
        iconWorking = true;
        const stop = new AbortController();
        const stopping = deps.onStop?.(() => stop.abort());
        try {
          const team = parseTeam(await readFile(file, 'utf8'), file);
          let ai: TeamAiDeps;
          try { ai = await deps.teamAi(); } catch (error) { post({ type: 'error', text: (error as Error).message }); return; }
          const { need, why } = await iconNeed(team);
          const variation = Math.floor(random() * ICON_VARIATIONS);
          const prompt = teamIconPrompt(team, variation);
          const choice = chooseImageModel(need, ai, why);
          if (!choice.ok) { post({ type: 'error', text: choice.reason }); return; }
          const blocked = await imageCallBlocked(ai, choice, prompt);
          if (blocked) { post({ type: 'error', text: `The icon was not made: ${blocked}` }); return; }
          const shown = team.name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, 80);
          const where = choice.private ? `${choice.model}, a private model (NEAR TEE or this computer)` : `${choice.model}, which is not a private model`;
          if (await choose(`Make an icon for "${shown}" with ${choice.model} (${imageEstimate(choice.info)})? It sends the team's name and what it is for to ${where}; nothing else from the team. If the picture comes out the same as another team's icon, one more is made, at the same cost again. You can still change or remove the icon afterwards.`, 'Generate icon') !== 'Generate icon') {
            post({ type: 'icon-done', id: message.id, text: 'Nothing was generated.' });
            return;
          }
          await makeIcon(message.id, file, { model: choice.model, variation, attempt: 1 }, stop.signal);
        } catch (error) {
          post({ type: 'error', text: `The icon was not made: ${stop.signal.aborted ? 'it was cancelled.' : (error as Error).message}` });
        } finally {
          stopping?.dispose();
          iconWorking = false;
        }
        return;
      }
      case 'icon-set': {
        const waiting = iconWaiting;
        if (!waiting || waiting.seq !== message.seq || waiting.id !== message.id || fileFor(message.id) !== waiting.file) {
          post({ type: 'error', text: 'Not saved: the studio is no longer waiting for an icon for this team. Try again.' });
          return;
        }
        iconWaiting = undefined;
        const problem = checkTeamIcon(message.png);
        if (problem) { post({ type: 'error', text: `Not saved: ${problem}` }); return; }
        // A generated icon is the team's own (owner, 2026-11-18): one byte for byte the same as another team's icon (the team it was cloned from, say)
        // is made once more with another variation, and if that is the same too, the person is told and nothing changes.
        const twin = waiting.generated ? library.teams.find((team) => team.id !== message.id && team.icon === iconDataUri(message.png)) : undefined;
        if (twin && waiting.generated) {
          const shownTwin = twin.name.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, 80);
          if (waiting.generated.attempt > 1) {
            post({ type: 'error', text: `The icon was not changed: the image model made the same picture as the icon of "${shownTwin}" twice. Upload a picture instead, or change the team's name or what it is for and generate again.` });
            return;
          }
          // No other icon request can be running here: each one starts by dropping the picture still awaited (iconWaiting), so this reply was
          // refused above if one had started since.
          iconWorking = true;
          const stop = new AbortController();
          const stopping = deps.onStop?.(() => stop.abort());
          try {
            const first = waiting.generated.variation;
            const variation = (first + 1 + Math.floor(random() * (ICON_VARIATIONS - 1))) % ICON_VARIATIONS;
            await makeIcon(message.id, waiting.file, { ...waiting.generated, variation, attempt: 2 }, stop.signal);
          } catch (error) {
            post({ type: 'error', text: `The icon was not made: ${stop.signal.aborted ? 'it was cancelled.' : (error as Error).message}` });
          } finally {
            stopping?.dispose();
            iconWorking = false;
          }
          return;
        }
        await changeIcon(message.id, waiting.file, (file) => deps.library.setIcon(file, message.png), (result) => `The icon is saved.${result.kept ? ' The one before it is in History.' : ''}`);
        return;
      }
      case 'icon-failed': if (iconWaiting?.seq === message.seq) iconWaiting = undefined; return;
      case 'icon-remove': {
        const file = fileFor(message.id);
        if (!file) { post({ type: 'error', text: 'That team is no longer in your teams.' }); return; }
        if (iconWorking) { post({ type: 'error', text: 'Still working on an icon. Wait for it to finish.' }); return; }
        // The latest request wins: a picture still on its way from the page for an earlier one is not used after this.
        iconWaiting = undefined;
        // History holds the old icon only when there was an icon file to move there; a lone icon line is only taken away (PR #82 review, round 2).
        await changeIcon(message.id, file, (teamFile) => deps.library.removeIcon(teamFile), (result) => result.removed ? 'Removed the icon. The team shows its default icon again; the old one is in History.' : 'Removed the icon line, which named no icon file. The team shows its default icon.');
        return;
      }
      case 'icon-restore': {
        const file = fileFor(message.id);
        if (!file) { post({ type: 'error', text: 'That team is no longer in your teams.' }); return; }
        if (iconWorking) { post({ type: 'error', text: 'Still working on an icon. Wait for it to finish.' }); return; }
        iconWaiting = undefined;
        await changeIcon(message.id, file, (teamFile) => deps.library.restoreIcon(teamFile, message.ref), (result) => `Restored the icon from ${versionLabel(message.ref)}.${result.kept ? ' The one before it is in History.' : ''}`);
        return;
      }
      case 'open-setting': await deps.openSetting(message.key); return;
    }
  };

  const random = () => { const value = (deps.random ?? Math.random)(); return Number.isFinite(value) && value >= 0 && value < 1 ? value : 0; };
  /**
   * The one gate every icon picture goes through, the first one and a retry alike (PR #90 review): the profile's settings and today's spend are read
   * again (teamAi), the team is read again from its file to decide whether it needs a private model, and teamImageCall runs the outbound check (Emergency
   * stop, the daily spend limit, TEE-only mode, the privacy check) on exactly the prompt it sends. A call that would now use another model than the one
   * the person agreed to is refused, not sent.
   */
  const iconImageCall = async (file: string, job: IconJob, signal: AbortSignal): Promise<TeamImageResult> => {
    if (!deps.teamAi) return { ok: false, reason: 'No model is available here. Set up an AI profile for this project first.' };
    let ai: TeamAiDeps;
    try { ai = await deps.teamAi(); } catch (error) { return { ok: false, reason: (error as Error).message }; }
    const team = parseTeam(await readFile(file, 'utf8'), file);
    const { need, why } = await iconNeed(team);
    return teamImageCall(ai, { need, prompt: teamIconPrompt(team, job.variation), signal, model: job.model, ...(why ? { why } : {}) });
  };
  /**
   * One image model call for a team's icon, after the person agreed: the team's name and what it is for, with this variation. A picture that passes the
   * checks goes to the page (icon-source), which answers with the PNG it made; anything else is said and nothing changes. Throws only what the caller
   * reports as "The icon was not made".
   */
  const makeIcon = async (id: string, file: string, job: IconJob, signal: AbortSignal) => {
    const result = await iconImageCall(file, job, signal);
    if (!result.ok) { post({ type: 'error', text: `The icon was not made: ${result.reason}` }); return; }
    if (fileFor(id) !== file) { post({ type: 'error', text: 'That team is no longer in your teams, so the icon was not used.' }); return; }
    const type = iconSourceType(result.bytes);
    if (!type || result.bytes.length > MAX_GENERATED_IMAGE_BYTES) { post({ type: 'error', text: 'The image model returned something that is not a PNG, JPEG or WebP picture, so the icon was not changed.' }); return; }
    // Its size is checked before the page decodes it, as for an uploaded picture (a small file can state a huge picture).
    const pixels = iconPixelProblem(result.bytes);
    if (pixels) { post({ type: 'error', text: `The image model's picture was not used, so the icon was not changed: ${pixels}` }); return; }
    sendIconSource(id, file, type, result.bytes, job);
  };

  /** Sends a checked picture to the page, which makes it a 128 x 128 PNG and answers with icon-set for this number. */
  const sendIconSource = (id: string, file: string, mime: IconSourceType, bytes: Uint8Array, generated?: IconJob) => {
    iconSeq += 1;
    iconWaiting = { seq: iconSeq, id, file, ...(generated ? { generated } : {}) };
    post({ type: 'icon-source', seq: iconSeq, id, mime, data: Buffer.from(bytes).toString('base64') });
  };

  /**
   * Changes a team's icon and tells the page: the cards (listed again) and the open team (icon-updated). The team file gains or loses its icon line, so a
   * team open in the editor moves to the new version (`base`) when it was on the one before, and a later save is not taken for an outside edit. Nothing
   * changed (no icon to remove) gets icon-done. A refusal says why in plain words, never with a path.
   */
  /** What a change did, to choose its words: `kept`, an icon went into the history on the way; `removed`, an icon file was there to remove. */
  type IconChange = { text: string; textChanged: boolean; removed?: boolean; kept?: boolean };
  const changeIcon = async (id: string, file: string, change: (file: string) => Promise<IconChange>, text: (result: IconChange) => string) => {
    let result: IconChange;
    let before: string;
    try {
      before = await readFile(file, 'utf8');
      result = await change(file);
    } catch (error) {
      // The library undoes a half-done change (PR #82 review), so "nothing was changed" is true unless it says otherwise, and then it says what is left.
      post({ type: 'error', text: error instanceof TeamIconPartialError ? error.message : error instanceof TeamIconError ? `Not changed: ${error.message}` : 'The icon could not be changed. Nothing was changed.' });
      return;
    }
    if (result.removed === false && !result.textChanged) { post({ type: 'icon-done', id }); return; }
    const rebase = open?.file === file && hash(before) === open.base;
    if (rebase && result.textChanged) open = { ...open!, text: result.text, base: hash(result.text) };
    await refreshLibrary();
    const icon = await iconOf(file, result.text);
    // The earlier icons are not sent here: the page asks for them again when its History tab is open (versions).
    post({ type: 'icon-updated', id, ...(icon ? { icon } : {}), ...(rebase ? { base: open!.base } : {}), text: text(result) });
  };

  const subscriptions = [
    deps.watch((file) => { void onWatch(file); }),
    // Emergency stop cancels an AI review in progress, as it cancels the role tests.
    ...(deps.onStop ? [deps.onStop(() => cancelRefine())] : []),
    ...(deps.onDidChangeSettings ? [deps.onDidChangeSettings(() => { void refresh(); })] : []),
    ...(deps.onDidChangeFolder ? [deps.onDidChangeFolder(() => { deps.staffSetupPreview?.invalidate(); void refresh(); })] : []),
    ...(deps.onDidChangeRuns ? [deps.onDidChangeRuns(() => { forgetHistory(); if (pageReady) { dashboardSoon(); liveSoon(); } })] : []),
    host.webview.onDidReceiveMessage(async (value) => {
      const message = parseStudioMessage(value);
      try { if (message) await handle(message); else await deps.staffSetupPreview?.receive(value); } catch (error) { post({ type: 'error', text: (error as Error).message }); }
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
    if (dashboardTimer) clearTimeout(dashboardTimer);
    cancelRefine();
    deps.staffSetupPreview?.dispose();
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

/** A drafted team waiting for review: the proposal the page shows, the draft Use this team starts from, and what was repaired in it. */
export interface KeptProposal { proposal: Record<string, unknown>; draft: TeamDraft; problems: string[] }

/** A kept drafted team read back, checked: the draft as strictly as one from the page, and the proposal's shape; anything else is not offered. */
export function keptProposal(value: unknown): KeptProposal | undefined {
  if (!isPlain(value) || !exactKeys(value, ['proposal', 'draft', 'problems'])) return undefined;
  const proposal = value.proposal;
  if (!isPlain(proposal) || !text(proposal.name, 120) || !Array.isArray(proposal.members) || !Array.isArray(proposal.outputs ?? [])) return undefined;
  if (!(proposal.members as unknown[]).every((member) => isPlain(member) && ['name', 'role', 'model', 'produces'].every((key) => member[key] === undefined || text(member[key], 12_000)))) return undefined;
  const draft = parseDraft(value.draft);
  const problems = value.problems;
  if (!draft || !Array.isArray(problems) || problems.length > 40 || !problems.every((problem) => text(problem, 600))) return undefined;
  return { proposal, draft, problems: problems as string[] };
}

function savedWizard(value: unknown): SavedWizard | undefined {
  if (!isPlain(value)) return undefined;
  const parsed = parseStudioMessage({ ...value, type: 'save-draft' });
  return parsed?.type === 'save-draft' ? { draft: parsed.draft, step: parsed.step, target: parsed.target, ...(parsed.startingPoint ? { startingPoint: parsed.startingPoint } : {}), ...(parsed.path ? { path: parsed.path } : {}) } : undefined;
}

/** "2026-10-29T14-03-12-345Z.md" (or "...-345Z-2.md", the second taken in that millisecond) → "2026-10-29 14:03:12 UTC". */
export function versionLabel(ref: string): string {
  // Versions taken in the same millisecond carry a number (-2, -3); the label keeps it, so History never shows two identical entries (PR #75 review).
  // 0.4.30: an earlier icon's name in the history (.png) reads the same way.
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-\d+Z(?:-(\d+))?\.(?:md|png)$/.exec(ref);
  return match ? `${match[1]} ${match[2]}:${match[3]}:${match[4]} UTC${match[5] ? ` (${match[5]})` : ''}` : ref.replace(/\.(?:md|png)$/, '');
}

/** A step after the project's team file was written failed: the file is the new team, and the message says which step did not happen. */
export class ProjectTeamWrittenError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProjectTeamWrittenError';
  }
}
export const PROJECT_TEAM_WRITTEN_HINT = 'The new team is this project\'s team now; open it from Team Studio to check it.';

/**
 * Whether two team files are the same team, set up again: the same text once the lines the studio itself manages (the icon line, an old rating line) and
 * the line endings are set aside.
 */
export function sameTeamText(one: string, two: string): boolean {
  const plainText = (value: string) => withTeamRating(withIconReference(value, undefined), undefined).replace(/\r\n/g, '\n').trim();
  return plainText(one) === plainText(two);
}

/** A file-system error in plain words, without the path its message carries: " (permission was denied)", or nothing when the cause is not one of these. */
export function fileProblem(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const words: Record<string, string> = { EACCES: 'permission was denied', EPERM: 'permission was denied', ENOSPC: 'the disk is full', EROFS: 'the disk is read-only', ENOENT: 'a folder it needs is missing', EISDIR: 'a folder is in its place', EBUSY: 'the file is in use' };
  return code && words[code] ? ` (${words[code]})` : '';
}

function displayPath(file: string, root: string | undefined): string {
  return root && file.startsWith(root + path.sep) ? path.relative(root, file) : `My teams/${path.basename(file)}`;
}

export type { TeamDefinition };

/**
 * The page's HTML: one nonce script and two stylesheets (the shared base, then its own); everything else is rendered by the script with textContent.
 * Images (0.4.30, team icons) only as data: URIs, which the host builds from icons it checked; the page never loads a path or a web address.
 */
export function teamStudioHtml(options: { cspSource: string; nonce: string; script: string; style: string; network: string; base: string; probe?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}'; img-src data:;">
<link rel="stylesheet" href="${options.base}"><link rel="stylesheet" href="${options.style}"><link rel="stylesheet" href="${options.network}"><title>SovAI Team Studio</title></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="title"><h1 id="title">Team Studio</h1><p id="subtitle" class="hint">Build and manage agent teams. Each team is a Markdown file; the studio reads and writes it for you.</p></div><nav id="crumbs" aria-label="Breadcrumb"></nav></header>
<div id="announce" class="visually-hidden" aria-live="polite" role="status"></div>
<div id="banner" class="banner" hidden role="alert"></div>
<div id="suggestion" class="suggestion" hidden></div>
<main id="main" tabindex="-1"><p class="hint">Loading…</p></main>
${options.probe ? `<script nonce="${options.nonce}" src="${options.probe}"></script>` : ''}<script nonce="${options.nonce}" src="${options.script}"></script></body></html>`;
}

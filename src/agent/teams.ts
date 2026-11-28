import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDiscoveryAnswers } from '../domain/agents';
import { readStaffTeamBlock, renderStaffTeamBlock } from '../domain/staff/teamBlock';
import type { StaffTeamBlock } from '../domain/staff/teamBlock';
import { staffWriteLimit } from '../domain/staff/writeLimits';
import { parseFrontmatter, type GsdAgent } from '../gsd/library';
import { recommendAgentTeam } from '../services/agentTeams';
import { checkTeamIcon, iconReference, MAX_TEAM_ICON_BYTES, TEAM_ICON_SUFFIX, TeamIconError, TeamIconPartialError, withIconReference } from './teamIcon';

// Agent teams as Markdown files the user edits in VS Code. Frontmatter names the team; each
// `## member` section is a member with optional `role:`, `model:`, and `tools:` lines followed by
// its instructions. Running a team gives a lead agent the members as sub-agents.

export interface TeamMember {
  name: string;
  role?: string;
  model?: string;
  tools: string[];
  instructions: string;
  /**
   * The member this one reports to (owner, 2026-11-08: "should show hierarchy if one exists"). Optional and absent in every existing team, so a team
   * without it still runs and still draws, as a lead with its members. A member naming one that does not exist is drawn at the top, never dropped.
   */
  reportsTo?: string;
  /**
   * `private`: the member runs only on a private model, one in a NEAR TEE or on this machine, never one forwarded to an outside provider. From a
   * `privacy: private` line; `privacy: any` (or no line) lets it use any model the run may use. A run fails for this member, rather than falling
   * back to a forwarded model, when no private model is available.
   */
  privacy?: 'private';
}
/**
 * `private` (0.4.27, owner 2026-11-16): the team is marked private (`privacy: private` in its frontmatter). Every member then runs only on a private model,
 * as if each had its own `privacy: private` line, and Team Studio sends the team only to a private model. A team whose members are all private counts as
 * private too (see teamIsPrivate).
 */
export interface TeamDefinition {
  slug: string; name: string; description: string; members: TeamMember[]; file: string; private?: boolean;
  /** The optional `staff:` frontmatter block of a military staff section team (staff contract, WP-0); absent in every other team. */
  staff?: StaffTeamBlock;
}

const MEMBER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The tools a member gets when its section has no `tools:` line. */
export const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite', 'Remember', 'Recall', 'VectorizeImage', 'RenderSvg', 'CreatePresentation', 'CreatePdf', 'CreateDocument'];

/**
 * The document-output family: a member that can make one kind of deliverable can make all of them.
 * Team files written before CreatePdf and CreateDocument existed list their tools explicitly, and
 * their writers list CreatePresentation. So that those teams can deliver a PDF or Word file
 * without anyone editing their team.md, a member whose tools include CreatePresentation also gets
 * CreatePdf and CreateDocument when the file is loaded. The file on disk is never rewritten.
 */
export const DOCUMENT_OUTPUT_TOOLS = ['CreatePresentation', 'CreatePdf', 'CreateDocument'];

/** A member's tools with the document-output compatibility rule applied (see DOCUMENT_OUTPUT_TOOLS). */
export function resolveMemberTools(tools: string[]): string[] {
  if (!tools.includes('CreatePresentation')) return tools;
  return [...tools, ...DOCUMENT_OUTPUT_TOOLS.filter((tool) => !tools.includes(tool))];
}
const MAX_VERSIONS = 20;
/** Earlier icons kept per team (0.4.30), as many as team versions. */
const MAX_ICON_VERSIONS = 20;

export function slugify(value: string): string {
  return slugWhole(value).slice(0, SLUG_MAX) || 'team';
}

/** The longest file name (without `.md`) slugify gives: a longer name is cut to this. */
export const SLUG_MAX = 40;

/** A name as slugify spells it, before it is cut to SLUG_MAX characters: so a caller can tell whether the cut would drop part of it. */
export function slugWhole(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Which knowledge graph a team file reads and feeds. A library team's is its slug. A project team's file is always `.planning/.near-ai/team.md`, so its
 * slug is "team" in every project: keyed by that, every project's team (and a library team saved as team.md) shared one graph (0.4.19 review). It is
 * keyed by its project folder instead, and the double hyphen means no slug can ever equal it, since slugify never leaves two in a row. The folder is
 * normalised first so one project never gets two graphs: resolved (which also drops a trailing separator), and on Windows, where paths ignore case,
 * lowercased, since VS Code hands out `c:\…` where a terminal says `C:\…`. `platform` is for tests.
 */
export function teamKnowledgeKey(file: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const dir = paths.dirname(file);
  if (paths.basename(file) === 'team.md' && paths.basename(dir) === '.near-ai' && paths.basename(paths.dirname(dir)) === '.planning') {
    const resolved = paths.resolve(dir, '..', '..');
    const root = platform === 'win32' ? resolved.toLowerCase() : resolved;
    return `project--${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  }
  return slugify(paths.basename(file, '.md'));
}

/**
 * The one way a reports-to value is compared (PR #69 review): `Lead`, `Team Lead` and `team-lead` all name the member team-lead. The parser, the
 * studio's save and round trip, the local check and Improve with AI all use it, so a hand-written spelling never makes them disagree. Empty is none.
 */
export function reportsToKey(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed ? slugify(trimmed) : '';
}

/** A member's privacy setting line: `privacy:`, any case, a one-word value, and an optional `# note`. Team Studio finds the line with the same pattern. */
export const MEMBER_PRIVACY_LINE = /^(privacy):\s*([^\s#]*)\s*(?:#.*)?$/i;

/** Parses a team file; throws with a message that says what to fix. */
export function parseTeam(text: string, file: string): TeamDefinition {
  const { data, body } = parseFrontmatter(text);
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '';
  if (!name) throw new Error('The team needs a name in its frontmatter (name: My team).');
  const members: TeamMember[] = [];
  const sections = body.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const [heading, ...rest] = section.split(/\r?\n/);
    const memberName = slugify(heading.trim());
    if (!MEMBER_NAME.test(memberName)) throw new Error(`"${heading.trim()}" is not a usable member name.`);
    if (members.some((member) => member.name === memberName)) throw new Error(`Two members are named ${memberName}.`);
    const fields: Record<string, string> = {};
    let index = 0;
    while (index < rest.length) {
      // `privacy:` counts as a setting only with a one-word value: an existing member's instructions may open with a sentence such as "Privacy: handle
      // client data carefully", which must stay instructions rather than fail as an unknown privacy value and make the whole team unloadable. A note
      // after a `#` is allowed, as in the frontmatter (0.4.28, PR #69 review): `privacy: private  # client data` is a private member, not instructions.
      const field = /^(role|model|tools|reports-to):\s*(.*)$/i.exec(rest[index].trim()) ?? MEMBER_PRIVACY_LINE.exec(rest[index].trim());
      if (!field) { if (rest[index].trim()) break; index += 1; continue; }
      fields[field[1].toLowerCase()] = field[2].trim();
      index += 1;
    }
    const instructions = rest.slice(index).join('\n').trim();
    if (!instructions) throw new Error(`Member ${memberName} needs instructions under its heading.`);
    const reportsTo = reportsToKey(fields['reports-to']) || undefined;
    const privacy = parsePrivacy(fields.privacy, memberName);
    members.push({ name: memberName, ...(fields.role ? { role: fields.role } : {}), ...(fields.model ? { model: fields.model } : {}), ...(reportsTo ? { reportsTo } : {}), ...(privacy ? { privacy } : {}), tools: fields.tools ? resolveMemberTools(fields.tools.split(',').map((tool) => tool.trim()).filter(Boolean)) : DEFAULT_TOOLS, instructions });
  }
  if (!members.length) throw new Error('Add at least one member as a "## member-name" section.');
  if (members.length > 12) throw new Error('A team can have at most 12 members.');
  const teamPrivacy = parseTeamPrivacy(data.privacy);
  // A staff section team's `staff:` block is read strictly: a bad block makes the file unloadable with the field named, rather than half-read.
  const staff = readStaffTeamBlock(text);
  if (!staff.ok) throw new Error(`The team's staff: block is not valid. ${staff.message}`);
  return { slug: slugify(path.basename(file, '.md')), name, description: typeof data.description === 'string' ? data.description : '', members, file, ...(teamPrivacy ? { private: true } : {}), ...(staff.value ? { staff: staff.value } : {}) };
}

/** The team's own `privacy:` frontmatter line: private (also tee or local) or any (also default or cloud, the same as no line). */
export function parseTeamPrivacy(value: unknown): 'private' | undefined {
  if (value === undefined || value === null) return undefined;
  const privacy = String(value).trim().toLowerCase();
  if (!privacy || privacy === 'any' || privacy === 'default' || privacy === 'cloud') return undefined;
  if (privacy === 'private' || privacy === 'tee' || privacy === 'local') return 'private';
  throw new Error(`The agent team has "privacy: ${String(value)}"; use privacy: private (private models only: verified private hardware or this computer) or privacy: any.`);
}

/** Whether a team counts as private: marked private, or every member is private (owner, 2026-11-16). */
export function teamIsPrivate(team: { private?: boolean; members: ReadonlyArray<{ privacy?: 'private' }> }): boolean {
  return team.private === true || (team.members.length > 0 && team.members.every((member) => member.privacy === 'private'));
}

/** A member's `privacy:` line: private (also tee or local) or any (also default or cloud, the same as no line). */
export function parsePrivacy(value: string | undefined, member: string): 'private' | undefined {
  const privacy = (value ?? '').trim().toLowerCase();
  if (!privacy || privacy === 'any' || privacy === 'default' || privacy === 'cloud') return undefined;
  if (privacy === 'private' || privacy === 'tee' || privacy === 'local') return 'private';
  throw new Error(`Member ${member} has "privacy: ${value}"; use privacy: private (verified private hardware or this computer) or privacy: any.`);
}

export function renderTeam(name: string, description: string, members: Array<Omit<TeamMember, 'tools'> & { tools?: string[] }>, options: { private?: boolean; staff?: StaffTeamBlock } = {}): string {
  const lines = ['---', `name: ${name}`, `description: ${description}`, ...(options.private ? ['privacy: private'] : []), ...(options.staff ? renderStaffTeamBlock(options.staff) : []), '---', '', '<!-- Each "## name" section is a team member. Optional lines: role, model (a NEAR model ID or deep/standard/fast), tools (comma-separated), reports-to (another member), and last, privacy (private: private models only, which means verified private hardware or this computer; any: whatever the run may use). Then the member\'s instructions. Save to create a new version. -->', ''];
  for (const listed of members) {
    // A team marked private writes privacy: private on every member too (0.4.27), so a build that reads only member lines keeps each one private.
    const member = options.private ? { ...listed, privacy: 'private' as const } : listed;
    lines.push(`## ${member.name}`);
    if (member.role) lines.push(`role: ${member.role}`);
    if (member.model) lines.push(`model: ${member.model}`);
    if (member.reportsTo) lines.push(`reports-to: ${member.reportsTo}`);
    if (member.tools?.length) lines.push(`tools: ${member.tools.join(', ')}`);
    // privacy is always the last metadata line: a build from before it existed reads role, model, and tools correctly and takes this line as
    // the first line of the instructions, rather than stopping before tools and giving the member the default tools.
    if (member.privacy) lines.push(`privacy: ${member.privacy}`);
    lines.push('', member.instructions, '');
  }
  return lines.join('\n');
}

export function newTeamTemplate(name: string): string {
  return renderTeam(name, 'What this team is for', [
    { name: 'planner', role: 'planner', model: 'standard', tools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall'], instructions: 'Read the relevant code and break the task into small, verifiable steps, each with its own area (the files it owns), and say which steps can run at the same time. Do not change files. Report the plan with the files each step touches.' },
    { name: 'implementer', role: 'implementer', model: 'deep', instructions: 'Make the changes in your part of the plan, matching the project\'s style, and leave other areas to their owners. When other members change files at the same time, work in your own git worktree and report your branch for the lead to merge. Run the relevant tests and fix what you broke. Report what changed and how you verified it.' },
    { name: 'reviewer', role: 'reviewer', model: 'standard', tools: ['Read', 'Glob', 'Grep', 'Bash'], instructions: 'Review the merged changes for correctness, regressions, and missing tests. Report concrete findings with file:line, most severe first. Do not edit files.' }
  ]);
}

/** A team's members as sub-agent definitions for the runner. */
export function teamAgents(team: TeamDefinition): GsdAgent[] {
  return team.members.map((member) => {
    // A staff team's red team and release guard may write only their own files (src/domain/staff/writeLimits.ts); the runtime refuses the rest.
    const writeOnly = staffWriteLimit(team.staff, member.name);
    return {
      name: member.name,
      description: member.role ?? member.name,
      tools: member.tools,
      model: member.model,
      // A team marked private keeps every member private, as if each had its own privacy: private line.
      ...(member.privacy || team.private ? { privacy: 'private' as const } : {}),
      ...(writeOnly ? { writeOnly } : {}),
      body: `You are ${member.name}${member.role ? `, the ${member.role},` : ''} on the "${team.name}" team.\n\n${member.instructions}`,
      file: team.file
    };
  });
}

/**
 * Which team a run that is not a /team run works with (0.4.21): the conversation's own (`conversationTeam`, its newest /team), else the project's team,
 * else none. `notice` is what the chat says, only when the team differs from the one it last said (`noticed`), so it is said once per conversation and
 * team. `find` looks a team up by slug, as TeamLibrary.find does (the slug "project" is the project's own team).
 */
export async function workingTeamFor(find: (slug: string) => Promise<TeamDefinition | undefined>, conversationTeam: string | undefined, noticed: string | undefined, allowProject: (team: TeamDefinition) => Promise<boolean> = async () => true, allowNamed: (team: TeamDefinition) => Promise<boolean> = async () => true): Promise<{ team?: TeamDefinition; notice?: string; noticed?: string }> {
  const quietly = (slug: string) => find(slug).catch(() => undefined);
  // A team with no members has no one to give work to: the conversation's falls back to the project's, and an empty project team is not used.
  const usable = (team: TeamDefinition | undefined) => team?.members.length ? team : undefined;
  const found = usable(conversationTeam ? await quietly(conversationTeam) : undefined);
  // 0.4.26: an imported team the person has not approved is not used (they are asked first; see libraryTeamAllowed), and the chat says why.
  const named = found && await allowNamed(found).catch(() => false) ? found : undefined;
  if (found && !named) {
    const key = `unapproved ${found.slug}`;
    return key === noticed ? { noticed } : { noticed: key, notice: `The imported team "${noTags(found.name).slice(0, 80)}" has not been approved, so this run continues without it. Run /team:${found.slug} again to be asked.` };
  }
  // The project's team comes with the repository, so it is used only once the person agreed to it (owner, 2026-11-14: ask once per project).
  const project = named ? undefined : usable(await quietly('project'));
  const team = named ?? (project && await allowProject(project).catch(() => false) ? project : undefined);
  const gone = conversationTeam !== undefined && !named;
  if (!team) {
    // The conversation's own team is gone and there is no project team to use: said once, rather than dropping the team without a word.
    if (!gone) return {};
    const none = `none (instead of ${conversationTeam})`;
    if (none === noticed) return { noticed };
    return { noticed: none, notice: `The team "${noTags(conversationTeam).slice(0, 80)}" this conversation started with could not be found or has no members, so this run continues without a team.` };
  }
  // What was said: the team, or that the conversation's team is gone and this one is used instead, which is news even when the team is the same.
  const key = gone ? `${team.slug} (instead of ${conversationTeam})` : team.slug;
  if (key === noticed) return { team, noticed };
  const why = gone ? ` (the ${conversationTeam} team this conversation started with is gone or empty, so the project's team is used)` : '';
  const which = named ? `the team "${noTags(team.name)}"` : `this project's team "${noTags(team.name)}" (from .planning/.near-ai/team.md)`;
  return { team, noticed: key, notice: `Working with ${which}: its members do the specialist work${why}.` };
}

/** Where the answers to "use this project's team?" are kept, per workspace: one per team file, as a multi-root workspace has one team file per folder. */
export const PROJECT_TEAM_CONSENT_KEY = 'nearAi.projectTeamConsent';
/**
 * The key an answer saved before 0.4.22 (one for the whole workspace) is kept under until a team file with its fingerprint claims it. Every other key is
 * a team file's absolute path, which never starts with "#".
 */
export const LEGACY_TEAM_CONSENT = '#legacy';
/** At most this many answers are kept, newest last; older ones are asked again. */
const MAX_TEAM_CONSENTS = 20;
export interface TeamConsent { fingerprint: string; use: boolean }
interface ConsentStore { get<T>(key: string): T | undefined; update(key: string, value: unknown): PromiseLike<void> | Promise<void> }

/** The question asking to use a project's team. Its member names and roles come from a repository file, so they are made plain and capped in length and number. */
export function projectTeamQuestion(team: TeamDefinition, derivedFrom?: string): string {
  const shown = team.members.slice(0, 6).map((member) => `${noTags(member.name).slice(0, 40)}${member.role ? ` (${noTags(member.role).slice(0, 40)})` : ''}`);
  const more = team.members.length > shown.length ? ` and ${team.members.length - shown.length} more` : '';
  // 0.4.26: a project team made from an imported team the person never approved says so, so the answer is an informed one.
  const origin = derivedFrom === undefined ? '' : ` It was made from the imported team "${noTags(derivedFrom).slice(0, 80)}", which you have not approved.`;
  return `This project has a team in .planning/.near-ai/team.md: ${shown.join(', ')}${more}.${origin} Use it for runs in this project? Its members do the specialist work, with the tools and models that file gives them.`;
}

/** The question asked before an imported team first runs. Its names and roles come from a file someone sent, so they are made plain and capped. */
export function importedTeamQuestion(team: TeamDefinition, pending: { kind: 'imported' | 'derived'; from?: string } = { kind: 'imported' }): string {
  const shown = team.members.slice(0, 6).map((member) => `${noTags(member.name).slice(0, 40)}${member.role ? ` (${noTags(member.role).slice(0, 40)})` : ''}`);
  const more = team.members.length > shown.length ? ` and ${team.members.length - shown.length} more` : '';
  const how = pending.kind === 'derived' ? `was made from the imported team${pending.from ? ` "${noTags(pending.from).slice(0, 80)}"` : ''}, which you have not approved,` : 'was imported from a file';
  return `The team "${noTags(team.name).slice(0, 80)}" ${how} and has not been approved yet: ${shown.join(', ')}${more}. Use it? Its members do the work with the tools and models that file gives them. Approving it makes it one of your teams.`;
}

/**
 * Whether a library team may run (0.4.26): any team the person made or approved may; one added with Import team is asked about first, and approving it
 * once makes it one of their teams. `ask` resolves true to use it, false not to, undefined when the question was closed (not this time; asked again).
 */
export async function libraryTeamAllowed(team: TeamDefinition, library: Pick<TeamLibrary, 'pendingKind' | 'approveImport'>, ask: (question: string) => Promise<boolean | undefined>): Promise<boolean> {
  const pending = await library.pendingKind(team.file);
  if (!pending) return true;
  if (await ask(importedTeamQuestion(team, pending)) !== true) return false;
  await library.approveImport(team.file);
  return true;
}

/**
 * Whether this project's team may be used (owner, 2026-11-14: ask once per project). The file comes with the repository, so a cloned repository could
 * otherwise choose the members, their tools and their models. Never in a window VS Code does not trust, and only `trusted === true` counts as trusted;
 * otherwise asked once per team file, and asked again when that file's team changes. `ask` resolves true to use it, false not to, undefined when the
 * question was closed: no team this time, and asked again next time. `fallback` keeps the answers when there is no workspace state.
 */
export async function projectTeamAllowed(team: TeamDefinition, options: { trusted: boolean | undefined; store?: ConsentStore; fallback: Map<string, TeamConsent>; ask: (question: string) => Promise<boolean | undefined>; derivedFrom?: () => Promise<string | undefined> }): Promise<boolean> {
  if (options.trusted !== true) return false;
  const fingerprint = createHash('sha256').update(JSON.stringify([team.name, team.members])).digest('hex');
  const stored = options.store?.get<unknown>(PROJECT_TEAM_CONSENT_KEY);
  // Before 0.4.22 one answer was kept for the whole workspace, as { fingerprint, use }; it still counts for a team with that fingerprint. Until a matching
  // team file claims it, it is kept under LEGACY_TEAM_CONSENT beside the per-file answers.
  const entries: Record<string, TeamConsent> = stored && typeof stored === 'object' && !isConsent(stored) ? Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter((entry): entry is [string, TeamConsent] => isConsent(entry[1]))) : {};
  const storedLegacy = isConsent(stored) ? stored : entries[LEGACY_TEAM_CONSENT];
  const byFile = { ...entries };
  delete byFile[LEGACY_TEAM_CONSENT];
  // The old single answer is bound to the first team file it is used for (#46 review): it is moved under that file and no longer applies to any other
  // folder's team, even one with the same name and members.
  if (storedLegacy && storedLegacy.fingerprint === fingerprint && byFile[team.file] === undefined) {
    await options.store?.update(PROJECT_TEAM_CONSENT_KEY, { ...byFile, [team.file]: storedLegacy });
    return storedLegacy.use;
  }
  // PR #55 review: once a team file with its fingerprint has an answer of its own, or is this file (whose own answer is newer), the old answer is claimed
  // and dropped. Before, it was written back on every answer for ever, outside the MAX_TEAM_CONSENTS cap.
  const claimed = !!storedLegacy && (storedLegacy.fingerprint === fingerprint || Object.values(byFile).some((consent) => consent.fingerprint === storedLegacy.fingerprint));
  const legacy = claimed ? undefined : storedLegacy;
  const saved = byFile[team.file] ?? options.fallback.get(team.file);
  if (saved?.fingerprint === fingerprint) {
    if (claimed) await options.store?.update(PROJECT_TEAM_CONSENT_KEY, byFile);
    return saved.use;
  }
  const answer = await options.ask(projectTeamQuestion(team, await options.derivedFrom?.().catch(() => undefined)));
  if (answer === undefined) {
    if (claimed) await options.store?.update(PROJECT_TEAM_CONSENT_KEY, byFile);
    return false;
  }
  const decision: TeamConsent = { fingerprint, use: answer };
  options.fallback.delete(team.file);
  options.fallback.set(team.file, decision);
  while (options.fallback.size > MAX_TEAM_CONSENTS) options.fallback.delete(options.fallback.keys().next().value as string);
  delete byFile[team.file];
  // An unclaimed old answer is kept (#46 review): before, asking about another folder's team first wrote the per-file answers alone and dropped it, so
  // the folder it belonged to was asked again. It counts toward the cap as the oldest answer (PR #55 review), so it is the first to go.
  const kept = [...(legacy ? [[LEGACY_TEAM_CONSENT, legacy] as [string, TeamConsent]] : []), ...Object.entries(byFile), [team.file, decision] as [string, TeamConsent]].slice(-MAX_TEAM_CONSENTS);
  await options.store?.update(PROJECT_TEAM_CONSENT_KEY, Object.fromEntries(kept));
  return decision.use;
}

function isConsent(value: unknown): value is TeamConsent {
  return !!value && typeof value === 'object' && typeof (value as TeamConsent).fingerprint === 'string' && typeof (value as TeamConsent).use === 'boolean';
}

/** Team text inside the note, with angle brackets made plain, so a line such as `</team>` in a member's instructions cannot end the note early. */
export function noTags(text: string): string {
  // Line breaks and control characters become spaces too, so a name or role cannot start a line of its own inside the note.
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/</g, '‹').replace(/>/g, '›');
}

/**
 * Owner, 2026-11-18: "teams should typically be built with preference to run agents in parallel vice sequential whenever possible keeping work separated
 * and then bring together to merge and sort out conflicts." What a run that works with a team (not led as one) is told about running members side by
 * side and bringing their work together; the lead's prompt says the same at more length.
 */
export const PARALLEL_MERGE_NOTE = `When members can work at the same time, start them together, each on its own area (files, modules, or sections) with what it must not touch, and give each member that changes files \`isolation: "worktree"\` so it reports a branch. Then merge their branches one at a time into the run's branch. Resolve a conflict yourself, or hand it to the member who owns that area with both sides. A member whose part fails does not block merging the others. Run the project's checks once after all the merges, and report which branches merged, which conflicts came up and how each was resolved.`;

/**
 * 0.4.21: the team a run works with when it is not led as a team: later messages of a conversation started with /team:<name>, or any run in a project
 * with its own team, GSD workflows included. Before, the team existed only for the one /team message, so a later "make the pictures" never saw the
 * designer and went to general-purpose. Owner, 2026-11-14: "GSD's role is to keep the project on track - like the project manager, contractor, and
 * quality control. GSD sub contracts teams when available to perform the specialist functions (unless a specialist functional role is missing)."
 */
export function teamMembersNote(team: TeamDefinition): string {
  return `<team name="${noTags(team.name).replace(/"/g, "'")}">
You work with the "${noTags(team.name)}" team. Its members, each available as an Agent subagent_type:
${team.members.map((member) => `- ${noTags(member.name)}${member.role ? ` (${noTags(member.role)})` : ''}: ${noTags(member.instructions.split('\n')[0].slice(0, 160))}`).join('\n')}
Open-GSD runs the project: like a project manager, contractor and quality control, it plans, tracks, checks and verifies. It subcontracts the specialist work to this team. So when a piece of work, or a workflow step, is something a member's role covers (for example building to an implementer, images to a designer, research to a researcher), spawn that member with the Agent tool instead of an Open-GSD agent or general-purpose. Its prompt must be complete: the step's task, everything the workflow requires of it (files to write, commits, checks to run) and the report you need back. Keep Open-GSD's own agents for keeping the project on track (planning, plan checking, verification, progress), and for specialist work no member covers. Use general-purpose only when neither fits.
${PARALLEL_MERGE_NOTE}
</team>`;
}

/** `addendum` is a team kind's own lead section (a staff section's, staffLead.ts), placed before the task. */
export function teamLeadPrompt(team: TeamDefinition, task: string, addendum?: string): string {
  // Owner, 2026-11-08: "ensure all our teams and default instructions prompt the orchestrating agent or team lead to allow use of parallelism where
  // appropriate". The old wording mentioned parallelism in a clause; this makes it a rule with the test for what may run together, and says to fan out in
  // ONE turn, because starting members across several turns is the measured way teams end up sequential (30 of 37 runs had one request in flight).
  return `You lead the "${team.name}" team${team.description ? ` (${team.description})` : ''}. Members, each available as an Agent subagent_type:
${team.members.map((member) => `- ${member.name}${member.role ? ` (${member.role})` : ''}: ${member.instructions.split('\n')[0].slice(0, 160)}`).join('\n')}

# How to lead
- **Split the task into the parts the members can do, and start every part that does not depend on another in the SAME turn**, each with run_in_background. A part may start together with another when it can finish without the other's answer. Starting members one turn at a time, or waiting for one before starting the next, is the slowest way to run a team and is the mistake to avoid.
- Then collect the reports, resolve what conflicts, and integrate. If a part's result changes what another part needs, run that second part afterwards and say why it had to wait.
- Give every member a complete, self-contained prompt: it sees nothing of this conversation. Name the exact output you want back from it.
- Do the coordination yourself; do not do the members' work for them.
- Give each part to the member whose role covers it, never to general-purpose or an Open-GSD agent while a member fits. Open-GSD's own agents keep the project on track (planning, checking, verification); the specialist work is the members'.
- When two or more members that change files run at the same time in a git repository, start each with \`isolation: "worktree"\` so they cannot overwrite each other; each reports its branch for you to merge. Members that only read or research need no worktree.

# Keep the work separate, then bring it together
- Give each member its own area: the files, modules, or sections of the deliverable it owns. Say in its prompt what it owns and what it must not touch, so members working at the same time rarely conflict.
- When the parallel members have finished, merge their branches into this run's branch (the branch checked out where you work) one at a time, not all at once.
- When a merge conflicts, resolve it yourself where the right answer is clear from both sides. Otherwise hand the conflict to the member who owns that area, with both sides of it and what each branch was for, and merge its answer.
- A member whose part failed, or that reported no branch, does not block the others: merge the rest, and report the failed part and why.
- After all the merges, run the project's checks (tests, type checks, linter) once on the merged result, and fix or hand back what they find.
- Parts that are not branches (findings, sections of a document) are brought together the same way: combine them, settle where they disagree, then check the whole.

Finish with a short summary of what each member did, what ran at the same time, which branches merged, which conflicts came up and how each was resolved, and the outcome.
${addendum ? `\n${addendum}\n` : ''}
Task: ${task}`;
}

/** Recommends a project team from the onboarding answers and renders it as a team file. */
export function recommendedProjectTeam(answers: AgentDiscoveryAnswers): string {
  const recommendation = recommendAgentTeam(answers);
  const tier: Record<string, string> = { planner: 'standard', implementer: 'deep', reviewer: 'standard', security: 'deep', tester: 'fast', researcher: 'standard' };
  const readOnly = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall', 'Remember'];
  return renderTeam('Project team', `${recommendation.rationale} Estimated cost: ${recommendation.estimatedCost}.`, recommendation.roles.map((role) => ({
    name: role.role,
    role: role.role,
    model: tier[role.role],
    tools: role.role === 'planner' || role.role === 'researcher' || role.role === 'security' ? readOnly : role.role === 'reviewer' || role.role === 'tester' ? [...readOnly, 'Bash'] : undefined,
    instructions: `${role.responsibility} ${role.coordination}\n\nProject goal: ${answers.goal}`
  })));
}

/**
 * Reusable teams in the extension's storage (independent of any project) plus each project's own
 * team at `.planning/.near-ai/team.md`. Saving a team file snapshots it as a new version.
 */
export class TeamLibrary {
  public constructor(private readonly storageDir: string) {}

  public get directory(): string { return path.join(this.storageDir, 'teams'); }
  private get archiveDir(): string { return path.join(this.directory, '.archived'); }
  /**
   * Teams added with Import team that the person has not yet approved to run (0.4.26): one marker file per team file, named after it. A marker, not a
   * list in one file, so a damaged list can never make an imported team look approved, and approving one team touches nothing else.
   */
  private get importsDir(): string { return path.join(this.directory, '.imported'); }
  /**
   * The marker for one team file, keyed by its place in the library: `<name>` for a live team, `.archived/<name>` for an archived one (PR #67 review: a
   * marker keyed by the file name alone was shared by a live and an archived team of the same name, so archiving one could approve the other).
   */
  private importMarker(file: string): string {
    const dir = path.dirname(path.resolve(file));
    return dir === path.resolve(this.archiveDir) ? path.join(this.importsDir, '.archived', path.basename(file)) : path.join(this.importsDir, path.basename(file));
  }
  private versionsDir(slug: string): string { return path.join(this.directory, '.versions', slug); }

  /** A project team's versions are kept per project, so one project's history never shows another's. */
  private versionKey(file: string): string {
    const dir = path.dirname(file);
    if (path.basename(file) === 'team.md' && path.basename(dir) === '.near-ai' && path.basename(path.dirname(dir)) === '.planning') return `project-${createHash('sha256').update(path.resolve(dir, '..', '..')).digest('hex').slice(0, 12)}`;
    return slugify(path.basename(file, '.md'));
  }

  public static projectTeamFile(root: string): string { return path.join(root, '.planning', '.near-ai', 'team.md'); }

  public async list(root?: string): Promise<Array<{ team?: TeamDefinition; file: string; error?: string; project: boolean }>> {
    const files = (await readdir(this.directory).catch(() => [])).filter((name) => name.endsWith('.md')).map((name) => ({ file: path.join(this.directory, name), project: false }));
    if (root && await exists(TeamLibrary.projectTeamFile(root))) files.unshift({ file: TeamLibrary.projectTeamFile(root), project: true });
    return Promise.all(files.map(async (entry) => {
      try { return { ...entry, team: parseTeam(await readFile(entry.file, 'utf8'), entry.file) }; } catch (error) { return { ...entry, error: (error as Error).message }; }
    }));
  }

  public async find(slug: string, root?: string): Promise<TeamDefinition | undefined> {
    if (slug === 'project' && root) return parseTeam(await readFile(TeamLibrary.projectTeamFile(root), 'utf8'), TeamLibrary.projectTeamFile(root));
    const file = path.join(this.directory, `${slugify(slug)}.md`);
    return await exists(file) ? parseTeam(await readFile(file, 'utf8'), file) : undefined;
  }

  /**
   * The team a run's `/team:<slug>` names, as the dashboard reads it (teamForSlug): `project` is the project's team, and so is `team`, its file's own name
   * (team.md), while the project has one; any other slug is a team in My teams. Team Live reads a run from the history this way (PR 86 review: it took
   * /team:team for a team in My teams named team).
   */
  public async findRunTeam(slug: string, root?: string): Promise<TeamDefinition | undefined> {
    if (root && (slug === 'project' || (slug === 'team' && await exists(TeamLibrary.projectTeamFile(root))))) return this.find('project', root);
    return this.find(slug, root);
  }

  public async create(name: string, content = newTeamTemplate(name)): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    let slug = slugify(name);
    for (let n = 2; await exists(path.join(this.directory, `${slug}.md`)); n += 1) slug = `${slugify(name)}-${n}`;
    const file = path.join(this.directory, `${slug}.md`);
    await writeFile(file, content, 'utf8');
    // A new team starts approved: a marker left at this place by a file removed outside the studio never carries over (importTeam marks after this).
    await rm(this.importMarker(file), { force: true });
    await this.snapshot(file);
    return file;
  }

  public async duplicate(file: string, name: string): Promise<string> {
    return (await this.duplicateTeam(file, name)).file;
  }

  /**
   * Duplicate, saying what happened to the icon: `copied`, `none` (the team had none), or `default` when its icon could not be copied. The copy is made
   * by then, so a failed icon copy leaves it with the default icon rather than failing the whole duplicate (and the caller says so).
   */
  public async duplicateTeam(file: string, name: string): Promise<{ file: string; icon: 'copied' | 'none' | 'default' }> {
    const text = await readFile(file, 'utf8');
    const team = parseTeam(text, file);
    const copy = await this.create(name, renderTeam(name, team.description, team.members, { private: team.private, ...(team.staff ? { staff: team.staff } : {}) }));
    // A copy of an imported team that was never approved is still that team: it stays unapproved, so copying it is never a way round the question.
    if (await this.isPendingImport(file)) await this.markImported(copy, 'derived', team.name);
    // The copy looks the same in the library: it gets its own copy of the icon (0.4.30).
    const icon = await this.readIcon(file, text);
    if (!icon) return { file: copy, icon: 'none' };
    try {
      await this.setIcon(copy, icon);
      return { file: copy, icon: 'copied' };
    } catch {
      // setIcon puts things back as they were when it fails, so the copy shows the default icon. When even that failed, the line is taken out here.
      await this.removeIcon(copy).catch(() => undefined);
      return { file: copy, icon: 'default' };
    }
  }

  // ---- icons (0.4.30) ----
  // A team's icon is `<team file name>.icon.png` beside the team file, named in its front matter. Only that file is ever read for the team, whatever the
  // line says, so a hand-edited or imported reference can never show another team's icon or reach outside the folder. Changing or removing an icon keeps
  // the old one in the team's icon history (the latest 20), the way every save keeps a version of the team file.

  /** The icon file name a team file may name: `web-team.icon.png` for `web-team.md`, `team.icon.png` for a project's `team.md`. */
  public static iconName(teamFile: string): string { return `${path.basename(teamFile, '.md')}${TEAM_ICON_SUFFIX}`; }
  public iconFile(teamFile: string): string { return path.join(path.dirname(teamFile), TeamLibrary.iconName(teamFile)); }
  /** Under `.versions/.icons/`: a slug never starts with a dot, so no team's versions folder can be this one. */
  private iconVersionsDir(teamFile: string): string { return path.join(this.directory, '.versions', '.icons', this.versionKey(teamFile)); }

  /** The team's icon, checked (checkTeamIcon), or undefined: no icon line, one naming any other file, or a file that is not a valid icon. Never throws. */
  public async readIcon(teamFile: string, text?: string): Promise<Buffer | undefined> {
    const content = text ?? await readFile(teamFile, 'utf8').catch(() => undefined);
    if (content === undefined || iconReference(content) !== TeamLibrary.iconName(teamFile)) return undefined;
    const file = this.iconFile(teamFile);
    const size = (await stat(file).catch(() => undefined))?.size;
    if (size === undefined || size > MAX_TEAM_ICON_BYTES) return undefined;
    const bytes = await readFile(file).catch(() => undefined);
    return bytes && checkTeamIcon(bytes) === undefined ? bytes : undefined;
  }

  /** The team's earlier icons, newest first. */
  public async iconVersions(teamFile: string): Promise<string[]> {
    const dir = this.iconVersionsDir(teamFile);
    return (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.png')).sort(compareVersionNames).reverse().map((name) => path.join(dir, name));
  }

  /**
   * Moves (or copies) whatever icon file the team has now into its icon history, and drops the oldest beyond the limit. Returns the copy in the history,
   * or undefined when there was no icon file.
   */
  private async keepIcon(teamFile: string, move: boolean): Promise<string | undefined> {
    const file = this.iconFile(teamFile);
    if (!await exists(file)) return undefined;
    const dir = this.iconVersionsDir(teamFile);
    await mkdir(dir, { recursive: true });
    const kept = await copyAsVersion(file, dir, '.png');
    // The icon file could not be taken away: the copy is dropped from History again, so History never shows an icon the team still has.
    if (move) await rm(file, { force: true }).catch(async (error) => { await rm(kept, { force: true }).catch(() => undefined); throw error; });
    const versions = (await readdir(dir)).filter((name) => name.endsWith('.png')).sort(compareVersionNames);
    for (const old of versions.slice(0, Math.max(0, versions.length - MAX_ICON_VERSIONS))) await rm(path.join(dir, old), { force: true });
    return kept;
  }

  /** Undoes placeIcon or retireIcon: the history copy goes back to being the icon file (so History is as it was), or the icon file goes when there was none. */
  private async restoreIconFile(teamFile: string, kept: string | undefined): Promise<void> {
    if (kept) await rename(kept, this.iconFile(teamFile));
    else await rm(this.iconFile(teamFile), { force: true });
  }

  /**
   * Puts this PNG in place as the team's icon file, without touching the team file: the one it replaces is kept in the history, and the new file is
   * written whole. Checked first (TeamIconError, nothing written). Returns how to undo it, for a caller whose next step fails (PR #82 review: a team file
   * that could not be written left an icon file nothing named).
   */
  public async placeIcon(teamFile: string, png: Uint8Array): Promise<() => Promise<void>> {
    const problem = checkTeamIcon(png);
    if (problem) throw new TeamIconError(problem);
    const file = this.iconFile(teamFile);
    const kept = await this.keepIcon(teamFile, false);
    const temporary = `${file}.${process.pid}-${Date.now()}.tmp`;
    try {
      await writeFile(temporary, png);
      await rename(temporary, file);
    } catch (error) {
      // The new icon is not in place, so the old one is still the team's icon: its copy in History goes again (PR #82 review), and so does the
      // half-written file.
      await rm(temporary, { force: true }).catch(() => undefined);
      if (kept) await rm(kept, { force: true }).catch(() => undefined);
      throw error;
    }
    return () => this.restoreIconFile(teamFile, kept);
  }

  /** Moves the team's icon file into its history, without touching the team file. Returns how to undo it, or undefined when there was none. */
  public async retireIcon(teamFile: string): Promise<(() => Promise<void>) | undefined> {
    const kept = await this.keepIcon(teamFile, true);
    return kept ? () => this.restoreIconFile(teamFile, kept) : undefined;
  }

  /** Writes the team file when its icon line changes, as a new version like any save. */
  private async setReference(teamFile: string, name: string | undefined): Promise<{ text: string; textChanged: boolean }> {
    const before = await readFile(teamFile, 'utf8');
    const text = withIconReference(before, name);
    if (text === before) return { text, textChanged: false };
    await writeFile(teamFile, text, 'utf8');
    await this.snapshot(teamFile);
    return { text, textChanged: true };
  }

  /**
   * Makes this PNG the team's icon. It is checked first (TeamIconError says why it is refused, and nothing is written); the icon it replaces is kept in
   * the history; the file is written whole, then the team file names it.
   */
  public async setIcon(teamFile: string, png: Uint8Array): Promise<{ text: string; textChanged: boolean; kept: boolean }> {
    // `kept`: an icon file was there and is now in the history, so a message may say so (PR #82 review, round 2).
    const kept = await exists(this.iconFile(teamFile));
    const undo = await this.placeIcon(teamFile, png);
    try {
      return { ...await this.setReference(teamFile, TeamLibrary.iconName(teamFile)), kept };
    } catch (error) {
      // The team file could not be changed: the icon goes back as it was, so a failure leaves neither change. When even that fails, say what is left.
      await undo().catch(() => { throw new TeamIconPartialError('The new icon file was written, but the team file could not be changed to name it, and the earlier icon file could not be put back. The team shows its default icon; set the icon again, or restore an earlier one from History.'); });
      throw error;
    }
  }

  /** Back to the default icon: the icon file moves into the history and the team file's icon line is removed. `removed` is false when there was none. */
  public async removeIcon(teamFile: string): Promise<{ text: string; textChanged: boolean; removed: boolean }> {
    const undo = await this.retireIcon(teamFile);
    try {
      return { ...await this.setReference(teamFile, undefined), removed: undo !== undefined };
    } catch (error) {
      if (undo) await undo().catch(() => { throw new TeamIconPartialError('The icon was moved to History, but the team file could not be changed, and the icon could not be put back. The team shows its default icon; restore the icon from History to get it back.'); });
      throw error;
    }
  }

  /** Makes an earlier icon (by its name in the history) the team's icon again; the current one goes into the history. */
  public async restoreIcon(teamFile: string, ref: string): Promise<{ text: string; textChanged: boolean; kept: boolean }> {
    const version = (await this.iconVersions(teamFile)).find((candidate) => path.basename(candidate) === ref);
    if (!version) throw new TeamIconError('There is no such icon in this team\'s history.');
    return this.setIcon(teamFile, await readFile(version));
  }

  /**
   * Moves a team's icon with the team file (archive and restore), keeping its reference right: a team renamed on the way (web-team.md archived as
   * web-team-2.md) has its icon renamed and its icon line rewritten. A file already at the target is kept in that name's history first.
   */
  private async moveIcon(from: string, to: string): Promise<void> {
    const source = this.iconFile(from);
    if (!await exists(source)) return;
    const target = this.iconFile(to);
    if (source === target) return;
    const kept = await this.keepIcon(to, true);
    // The move failed: the icon that was at the target comes back out of History, so neither team's icon changes.
    await rename(source, target).catch(async (error) => { if (kept) await rename(kept, target).catch(() => undefined); throw error; });
    const text = await readFile(to, 'utf8').catch(() => undefined);
    if (text !== undefined && iconReference(text) === TeamLibrary.iconName(from) && TeamLibrary.iconName(from) !== TeamLibrary.iconName(to)) await writeFile(to, withIconReference(text, TeamLibrary.iconName(to)), 'utf8');
  }

  /**
   * Records that this library team has not been approved to run: it came from Import team (`imported`), or it was made from one that is not approved
   * (`derived`: duplicated, built from it as a starting point, or with any member copied from it unchanged). `from` names the team it came from, for
   * the question asked before it runs. Approving one team never approves another: each asks once.
   */
  public async markImported(file: string, kind: 'imported' | 'derived' = 'imported', from?: string): Promise<void> {
    await mkdir(path.dirname(this.importMarker(file)), { recursive: true });
    await writeFile(this.importMarker(file), `${kind} ${new Date().toISOString()}${from ? ` ${noTags(from).slice(0, 80)}` : ''}\n`, 'utf8');
  }

  /** Whether this file is a library team added with Import team (or made from one) that the person has not yet approved. A project's own team never is. */
  public async isPendingImport(file: string): Promise<boolean> {
    const dir = path.dirname(path.resolve(file));
    if (dir !== path.resolve(this.directory) && dir !== path.resolve(this.archiveDir)) return false;
    return exists(this.importMarker(file));
  }

  /** Why a library team is unapproved: imported itself, or derived from an unapproved import (with that team's name). Undefined when it is approved. */
  public async pendingKind(file: string): Promise<{ kind: 'imported' | 'derived'; from?: string } | undefined> {
    if (!await this.isPendingImport(file)) return undefined;
    const text = (await readFile(this.importMarker(file), 'utf8').catch(() => '')).trim();
    const match = /^derived \S+(?: (.+))?$/.exec(text);
    return match ? { kind: 'derived', ...(match[1] ? { from: match[1] } : {}) } : { kind: 'imported' };
  }

  /** The library team files (by name) still waiting for approval. */
  public async pendingImports(): Promise<Set<string>> {
    return new Set((await readdir(this.importsDir).catch(() => [])).filter((name) => name.endsWith('.md')));
  }

  /**
   * The team file a marker stands for: the inverse of importMarker, kept beside it so the two cannot drift (PR #67 review: callers rebuilt team paths
   * from marker names themselves, and would silently read nothing if the naming ever changed).
   */
  private markerTeamFile(name: string, archived: boolean): string {
    return path.join(archived ? this.archiveDir : this.directory, name);
  }

  /** Every unapproved team file, live then archived, each found from its marker through markerTeamFile. */
  public async pendingImportFiles(): Promise<string[]> {
    const archived = (await readdir(path.join(this.importsDir, '.archived')).catch(() => [])).filter((name) => name.endsWith('.md'));
    return [...[...await this.pendingImports()].sort().map((name) => this.markerTeamFile(name, false)), ...archived.sort().map((name) => this.markerTeamFile(name, true))];
  }

  /**
   * The name of an unapproved team (imported, or derived from one; in the library or archived) that any of these members was copied from unchanged, or
   * undefined. A member counts as copied when its instructions are the same apart from spacing, so a team built from an unapproved import (as a builder
   * starting point, by copying a member, or from a resumed draft) is caught however it was made, and approving the original later changes nothing for it.
   */
  public async unapprovedSource(members: ReadonlyArray<{ instructions: string }>): Promise<string | undefined> {
    const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
    const wanted = new Set(members.map((member) => norm(member.instructions)).filter(Boolean));
    if (!wanted.size) return undefined;
    for (const file of await this.pendingImportFiles()) {
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      try {
        const team = parseTeam(text, file);
        if (team.members.some((member) => wanted.has(norm(member.instructions)))) return team.name;
      } catch { /* a team file that does not parse has no members to copy */ }
    }
    return undefined;
  }

  /**
   * A project team made from an unapproved import keeps that fact beside the library (a project's team.md comes with the repository, so the note is
   * kept on this computer, never in the file). The project's own consent is asked as always; its question says where the members came from.
   */
  private projectMarker(projectTeamFile: string): string { return path.join(this.importsDir, `${teamKnowledgeKey(projectTeamFile)}.project`); }

  public async setProjectDerived(projectTeamFile: string, from: string | undefined): Promise<void> {
    if (from === undefined) { await rm(this.projectMarker(projectTeamFile), { force: true }); return; }
    await mkdir(this.importsDir, { recursive: true });
    await writeFile(this.projectMarker(projectTeamFile), `derived ${new Date().toISOString()} ${noTags(from).slice(0, 80)}\n`, 'utf8');
  }

  /** The unapproved import this project's team was made from, or undefined. */
  public async projectDerivedFrom(projectTeamFile: string): Promise<string | undefined> {
    const text = (await readFile(this.projectMarker(projectTeamFile), 'utf8').catch(() => '')).trim();
    const match = /^derived \S+ (.+)$/.exec(text);
    return match?.[1];
  }

  /** The person approved this imported team: it is one of their teams like any other from now on. */
  public async approveImport(file: string): Promise<void> {
    await rm(this.importMarker(file), { force: true });
  }

  /** Records the file's current contents as a version; called on every save. */
  public async snapshot(file: string): Promise<number> {
    const dir = this.versionsDir(this.versionKey(file));
    await mkdir(dir, { recursive: true });
    await copyAsVersion(file, dir, '.md');
    const versions = (await readdir(dir)).sort(compareVersionNames);
    for (const old of versions.slice(0, Math.max(0, versions.length - MAX_VERSIONS))) await rm(path.join(dir, old), { force: true });
    return Math.min(versions.length, MAX_VERSIONS);
  }

  /** Copies any file (for example a project's AGENTS.md before Update Team changes it) into this team's backup folder; returns the copy's path. */
  public async backup(teamFile: string, file: string, label: string): Promise<string> {
    const dir = path.join(this.directory, '.versions', `${this.versionKey(teamFile)}-${label}`);
    await mkdir(dir, { recursive: true });
    return copyAsVersion(file, dir, path.extname(file) || '.md');
  }

  public async versions(file: string): Promise<string[]> {
    const dir = this.versionsDir(this.versionKey(file));
    return (await readdir(dir).catch(() => [])).sort(compareVersionNames).reverse().map((name) => path.join(dir, name));
  }

  /** Moves a team into the archive; an earlier archived team of the same name is kept, never overwritten. */
  public async archive(file: string): Promise<string> {
    await mkdir(this.archiveDir, { recursive: true });
    const base = path.basename(file, '.md');
    let target = path.join(this.archiveDir, `${base}.md`);
    for (let n = 2; await exists(target); n += 1) target = path.join(this.archiveDir, `${base}-${n}.md`);
    await rename(file, target);
    await this.moveImportMarker(file, target);
    await this.moveIcon(file, target);
    return target;
  }

  /**
   * Moves a file's marker with the file (archive, restore): the target's place gets exactly the moved file's state, marked or not, and no other file's
   * marker is touched.
   */
  private async moveImportMarker(from: string, to: string): Promise<void> {
    const source = this.importMarker(from);
    const target = this.importMarker(to);
    if (source === target) return;
    await rm(target, { force: true });
    if (!await exists(source)) return;
    await mkdir(path.dirname(target), { recursive: true });
    await rename(source, target);
  }

  public async archived(): Promise<string[]> {
    return (await readdir(this.archiveDir).catch(() => [])).filter((name) => name.endsWith('.md')).map((name) => path.join(this.archiveDir, name));
  }

  public async restore(archivedFile: string): Promise<string> {
    const target = path.join(this.directory, path.basename(archivedFile));
    if (await exists(target)) throw new Error(`A team named ${path.basename(target, '.md')} already exists.`);
    await rename(archivedFile, target);
    await this.moveImportMarker(archivedFile, target);
    await this.moveIcon(archivedFile, target);
    return target;
  }

  public async delete(file: string): Promise<void> {
    await rm(file, { force: true });
    await rm(this.importMarker(file), { force: true });
    await rm(this.versionsDir(this.versionKey(file)), { recursive: true, force: true });
    await rm(this.iconFile(file), { force: true });
    await rm(this.iconVersionsDir(file), { recursive: true, force: true });
  }

  /** Imports a team .md file from anywhere after checking it parses; like importTeam, it stays unapproved until the person approves it. */
  public async import(source: string): Promise<string> {
    const text = await readFile(source, 'utf8');
    return this.importTeam(parseTeam(text, source).name, text);
  }

  /**
   * Adds a team file's text to the library as an imported team: it is untrusted until the person approves it, the first time it would run. The caller has
   * already checked the text and asked the person (Team Studio's Import team).
   */
  public async importTeam(name: string, text: string): Promise<string> {
    parseTeam(text, 'imported.md');
    const file = await this.create(name, text);
    await this.markImported(file);
    return file;
  }
}

/** A version's file name: the millisecond it was taken, then its place within that millisecond (none for the first, as every name before 0.4.29). */
const VERSION_NAME = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)(?:-(\d+))?(\.[^.]+)$/;

/**
 * Orders version file names oldest first: by the millisecond each was taken, then by its place within it. A name is never moved to a later time to
 * make room (PR #75 review: bumping the millisecond named a burst of versions after times still to come, so a later version could sort before them).
 * A name that is not a version's sorts first, by its text.
 */
export function compareVersionNames(a: string, b: string): number {
  const one = VERSION_NAME.exec(a);
  const two = VERSION_NAME.exec(b);
  if (!one || !two) return one ? 1 : two ? -1 : a < b ? -1 : a > b ? 1 : 0;
  if (one[1] !== two[1]) return one[1]! < two[1]! ? -1 : 1;
  return Number(one[2] ?? 1) - Number(two[2] ?? 1);
}

/**
 * Copies a file into a versions folder under the time it was taken. Two copies in the same millisecond (the old project team kept just before it is
 * replaced, then the new one) used to share a name, so the second overwrote the first; the copy is exclusive, and the next takes the next place
 * (`<time>-2`, `<time>-3`...).
 */
async function copyAsVersion(file: string, dir: string, extension: string): Promise<string> {
  const stamp = new Date(Date.now()).toISOString().replace(/[:.]/g, '-');
  // After the highest place already used in this millisecond, not the first free one: a place freed when the oldest versions were dropped would
  // otherwise be taken again and sort as the oldest.
  const used = (await readdir(dir).catch(() => [] as string[])).map((name) => VERSION_NAME.exec(name)).filter((match) => match !== null && match[1] === stamp).map((match) => Number(match![2] ?? 1));
  for (let place = used.length ? Math.max(...used) + 1 : 1; ; place += 1) {
    const target = path.join(dir, `${stamp}${place === 1 ? '' : `-${place}`}${extension}`);
    try { await copyFile(file, target, fsConstants.COPYFILE_EXCL); return target; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}

async function exists(file: string): Promise<boolean> {
  return Boolean(await stat(file).catch(() => undefined));
}

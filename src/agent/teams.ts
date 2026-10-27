import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentDiscoveryAnswers } from '../domain/agents';
import { parseFrontmatter, type GsdAgent } from '../gsd/library';
import { recommendAgentTeam } from '../services/agentTeams';

// Agent teams as Markdown files the user edits in VS Code. Frontmatter names the team; each
// `## member` section is a member with optional `role:`, `model:`, and `tools:` lines followed by
// its instructions. Running a team gives a lead agent the members as sub-agents.

export interface TeamMember { name: string; role?: string; model?: string; tools: string[]; instructions: string }
export interface TeamDefinition { slug: string; name: string; description: string; members: TeamMember[]; file: string }

const MEMBER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite', 'Remember', 'Recall'];
const MAX_VERSIONS = 20;

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
}

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
      const field = /^(role|model|tools):\s*(.*)$/i.exec(rest[index].trim());
      if (!field) { if (rest[index].trim()) break; index += 1; continue; }
      fields[field[1].toLowerCase()] = field[2].trim();
      index += 1;
    }
    const instructions = rest.slice(index).join('\n').trim();
    if (!instructions) throw new Error(`Member ${memberName} needs instructions under its heading.`);
    members.push({ name: memberName, ...(fields.role ? { role: fields.role } : {}), ...(fields.model ? { model: fields.model } : {}), tools: fields.tools ? fields.tools.split(',').map((tool) => tool.trim()).filter(Boolean) : DEFAULT_TOOLS, instructions });
  }
  if (!members.length) throw new Error('Add at least one member as a "## member-name" section.');
  if (members.length > 12) throw new Error('A team can have at most 12 members.');
  return { slug: slugify(path.basename(file, '.md')), name, description: typeof data.description === 'string' ? data.description : '', members, file };
}

export function renderTeam(name: string, description: string, members: Array<Omit<TeamMember, 'tools'> & { tools?: string[] }>): string {
  const lines = ['---', `name: ${name}`, `description: ${description}`, '---', '', '<!-- Each "## name" section is a team member. Optional lines: role, model (a NEAR model ID or deep/standard/fast), tools (comma-separated). Then the member\'s instructions. Save to create a new version. -->', ''];
  for (const member of members) {
    lines.push(`## ${member.name}`);
    if (member.role) lines.push(`role: ${member.role}`);
    if (member.model) lines.push(`model: ${member.model}`);
    if (member.tools?.length) lines.push(`tools: ${member.tools.join(', ')}`);
    lines.push('', member.instructions, '');
  }
  return lines.join('\n');
}

export function newTeamTemplate(name: string): string {
  return renderTeam(name, 'What this team is for', [
    { name: 'planner', role: 'planner', model: 'standard', tools: ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall'], instructions: 'Read the relevant code and break the task into small, verifiable steps. Do not change files. Report the plan with the files each step touches.' },
    { name: 'implementer', role: 'implementer', model: 'deep', instructions: 'Make the changes in the plan, matching the project\'s style. Run the relevant tests and fix what you broke. Report what changed and how you verified it.' },
    { name: 'reviewer', role: 'reviewer', model: 'standard', tools: ['Read', 'Glob', 'Grep', 'Bash'], instructions: 'Review the changes for correctness, regressions, and missing tests. Report concrete findings with file:line, most severe first. Do not edit files.' }
  ]);
}

/** A team's members as sub-agent definitions for the runner. */
export function teamAgents(team: TeamDefinition): GsdAgent[] {
  return team.members.map((member) => ({
    name: member.name,
    description: member.role ?? member.name,
    tools: member.tools,
    model: member.model,
    body: `You are ${member.name}${member.role ? `, the ${member.role},` : ''} on the "${team.name}" team.\n\n${member.instructions}`,
    file: team.file
  }));
}

export function teamLeadPrompt(team: TeamDefinition, task: string): string {
  return `You lead the "${team.name}" team${team.description ? ` (${team.description})` : ''}. Members, each available as an Agent subagent_type:\n${team.members.map((member) => `- ${member.name}${member.role ? ` (${member.role})` : ''}: ${member.instructions.split('\n')[0].slice(0, 160)}`).join('\n')}\n\nAccomplish the task below by delegating to members with the Agent tool (give each a complete, self-contained prompt; run independent members in parallel), checking their reports, and integrating the result. Do the coordination yourself; do not do members' work for them. Finish with a short summary of what each member did and the outcome.\n\nTask: ${task}`;
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
  private versionsDir(slug: string): string { return path.join(this.directory, '.versions', slug); }

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

  public async create(name: string, content = newTeamTemplate(name)): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    let slug = slugify(name);
    for (let n = 2; await exists(path.join(this.directory, `${slug}.md`)); n += 1) slug = `${slugify(name)}-${n}`;
    const file = path.join(this.directory, `${slug}.md`);
    await writeFile(file, content, 'utf8');
    await this.snapshot(file);
    return file;
  }

  public async duplicate(file: string, name: string): Promise<string> {
    const team = parseTeam(await readFile(file, 'utf8'), file);
    return this.create(name, renderTeam(name, team.description, team.members));
  }

  /** Records the file's current contents as a version; called on every save. */
  public async snapshot(file: string): Promise<number> {
    const slug = slugify(path.basename(file, '.md'));
    const dir = this.versionsDir(slug);
    await mkdir(dir, { recursive: true });
    await copyFile(file, path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
    const versions = (await readdir(dir)).sort();
    for (const old of versions.slice(0, Math.max(0, versions.length - MAX_VERSIONS))) await rm(path.join(dir, old), { force: true });
    return Math.min(versions.length, MAX_VERSIONS);
  }

  public async versions(file: string): Promise<string[]> {
    const dir = this.versionsDir(slugify(path.basename(file, '.md')));
    return (await readdir(dir).catch(() => [])).sort().reverse().map((name) => path.join(dir, name));
  }

  public async archive(file: string): Promise<void> {
    await mkdir(this.archiveDir, { recursive: true });
    await rename(file, path.join(this.archiveDir, path.basename(file)));
  }

  public async archived(): Promise<string[]> {
    return (await readdir(this.archiveDir).catch(() => [])).filter((name) => name.endsWith('.md')).map((name) => path.join(this.archiveDir, name));
  }

  public async restore(archivedFile: string): Promise<string> {
    const target = path.join(this.directory, path.basename(archivedFile));
    if (await exists(target)) throw new Error(`A team named ${path.basename(target, '.md')} already exists.`);
    await rename(archivedFile, target);
    return target;
  }

  public async delete(file: string): Promise<void> {
    await rm(file, { force: true });
    await rm(this.versionsDir(slugify(path.basename(file, '.md'))), { recursive: true, force: true });
  }

  /** Imports a team file from anywhere after checking it parses. */
  public async import(source: string): Promise<string> {
    const text = await readFile(source, 'utf8');
    const team = parseTeam(text, source);
    return this.create(team.name, text);
  }
}

async function exists(file: string): Promise<boolean> {
  return Boolean(await stat(file).catch(() => undefined));
}

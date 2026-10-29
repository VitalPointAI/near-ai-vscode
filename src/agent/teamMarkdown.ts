import { parseFrontmatter } from '../gsd/library';
import { DEFAULT_TOOLS, parseTeam, renderTeam, slugify } from './teams';

// The Team Studio edits a team as a draft, but the Markdown file stays the source of truth: saving
// a draft over an existing file rewrites only what the draft changed. Unknown frontmatter keys,
// comments, the text before the first member, and every member section the draft left as it was
// are kept byte for byte. A new team is exactly what renderTeam writes.

/** A member as the studio edits it. `tools: null` means no `tools:` line (the default set). */
export interface DraftMember { name: string; role: string; model: string; tools: string[] | null; instructions: string }
export interface TeamDraft { name: string; description: string; members: DraftMember[] }

interface Section { raw: string; name: string; role?: string; model?: string; tools?: string[]; instructions: string }
interface TeamParts { frontmatter?: { open: string; inner: string; close: string }; preamble: string; sections: Section[] }

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SECTION_START = /^##\s+/gm;
const FIELD = /^(role|model|tools):\s*(.*)$/i;

/** Splits a team file the same way parseTeam reads it, keeping each part's exact text. */
function splitTeam(text: string): TeamParts {
  const match = FRONTMATTER.exec(text);
  let frontmatter: TeamParts['frontmatter'];
  let body = text;
  if (match) {
    const open = /^---\r?\n/.exec(match[0])![0];
    frontmatter = { open, inner: match[1], close: match[0].slice(open.length + match[1].length) };
    body = text.slice(match[0].length);
  }
  const starts = [...body.matchAll(SECTION_START)].map((found) => found.index ?? 0);
  const preamble = starts.length ? body.slice(0, starts[0]) : body;
  const sections = starts.map((start, index) => {
    const raw = body.slice(start, starts[index + 1] ?? body.length);
    const [heading, ...rest] = raw.replace(/^##\s+/, '').split(/\r?\n/);
    const fields: Record<string, string> = {};
    let line = 0;
    while (line < rest.length) {
      const field = FIELD.exec(rest[line].trim());
      if (!field) { if (rest[line].trim()) break; line += 1; continue; }
      fields[field[1].toLowerCase()] = field[2].trim();
      line += 1;
    }
    return {
      raw, name: slugify(heading.trim()),
      ...(fields.role ? { role: fields.role } : {}), ...(fields.model ? { model: fields.model } : {}),
      ...(fields.tools !== undefined && fields.tools ? { tools: fields.tools.split(',').map((tool) => tool.trim()).filter(Boolean) } : {}),
      instructions: rest.slice(line).join('\n').trim()
    };
  });
  return { ...(frontmatter ? { frontmatter } : {}), preamble, sections };
}

/** A team file as a draft; throws (with parseTeam's message) when the file is not a usable team. */
export function draftFromMarkdown(text: string, file: string): TeamDraft {
  const team = parseTeam(text, file);
  const sections = splitTeam(text).sections;
  return {
    name: team.name, description: team.description,
    members: team.members.map((member) => {
      const section = sections.find((candidate) => candidate.name === member.name);
      return { name: member.name, role: member.role ?? '', model: member.model ?? '', tools: section?.tools ? [...section.tools] : null, instructions: member.instructions };
    })
  };
}

function renderMembers(draft: TeamDraft) {
  return draft.members.map((member) => ({
    name: member.name, ...(member.role.trim() ? { role: member.role.trim() } : {}), ...(member.model.trim() ? { model: member.model.trim() } : {}),
    ...(member.tools ? { tools: member.tools } : {}), instructions: member.instructions.trim()
  }));
}

function renderSection(member: ReturnType<typeof renderMembers>[number]): string {
  const lines = [`## ${member.name}`];
  if (member.role) lines.push(`role: ${member.role}`);
  if (member.model) lines.push(`model: ${member.model}`);
  if (member.tools?.length) lines.push(`tools: ${member.tools.join(', ')}`);
  lines.push('', member.instructions, '', '');
  return lines.join('\n');
}

function sameMember(section: Section, member: ReturnType<typeof renderMembers>[number]): boolean {
  return section.name === member.name && (section.role ?? '') === (member.role ?? '') && (section.model ?? '') === (member.model ?? '')
    && JSON.stringify(section.tools ?? null) === JSON.stringify(member.tools ?? null) && section.instructions === member.instructions;
}

/** Sets one frontmatter key, keeping its line (and quoting) when the value is unchanged. */
function setFrontmatterKey(lines: string[], key: string, value: string, after?: string): void {
  let index = -1;
  for (let line = 0; line < lines.length; line += 1) if (new RegExp(`^${key}:`).test(lines[line])) index = line;
  const current = index >= 0 ? parseFrontmatter(`---\n${lines.slice(index, index + 1 + listLength(lines, index)).join('\n')}\n---\n`).data[key] : undefined;
  if (current === value) return;
  if (index >= 0) { lines.splice(index, 1 + listLength(lines, index), `${key}: ${value}`); return; }
  if (!value) return;
  const anchor = after ? lines.findIndex((line) => new RegExp(`^${after}:`).test(line)) : -1;
  lines.splice(anchor >= 0 ? anchor + 1 + listLength(lines, anchor) : lines.length, 0, `${key}: ${value}`);
}

function listLength(lines: string[], index: number): number {
  let count = 0;
  while (/^\s+-\s+/.test(lines[index + 1 + count] ?? '')) count += 1;
  return count;
}

/**
 * The Markdown a draft saves as. With no existing file it is exactly renderTeam's output; over an
 * existing file, only the parts the draft changed are rewritten.
 */
export function teamMarkdown(draft: TeamDraft, original?: string): string {
  const members = renderMembers(draft);
  const name = draft.name.trim();
  const description = draft.description.trim();
  if (original === undefined) return renderTeam(name, description, members);
  const parts = splitTeam(original);
  let head: string;
  if (parts.frontmatter) {
    const eol = parts.frontmatter.inner.includes('\r\n') ? '\r\n' : '\n';
    const lines = parts.frontmatter.inner.split(/\r?\n/);
    setFrontmatterKey(lines, 'name', name);
    setFrontmatterKey(lines, 'description', description, 'name');
    head = `${parts.frontmatter.open}${lines.join(eol)}${parts.frontmatter.close}`;
  } else {
    head = `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
  }
  const out: string[] = [];
  let lastGenerated = false;
  members.forEach((member) => {
    const kept = parts.sections.find((section) => sameMember(section, member));
    // A section that used to be last may need a blank line before the next one.
    if (out.length && !/\n\s*\n$/.test(out[out.length - 1])) out[out.length - 1] += out[out.length - 1].endsWith('\n') ? '\n' : '\n\n';
    out.push(kept ? kept.raw : renderSection(member));
    lastGenerated = !kept;
  });
  let body = out.join('');
  if (lastGenerated) body = body.replace(/\n\n$/, '\n');
  const preamble = parts.preamble && !parts.preamble.endsWith('\n') && body ? `${parts.preamble}\n` : parts.preamble;
  return `${head}${preamble}${body}`;
}

export interface DraftIssue { message: string; member?: number; field?: 'name' | 'description' | 'members' | 'role' | 'model' | 'tools' | 'instructions' }

/** Structural checks, then the real round trip: the saved text must parse back to the same team. */
export function checkDraft(draft: TeamDraft, original?: string): { markdown: string; errors: DraftIssue[] } {
  const errors: DraftIssue[] = [];
  if (!draft.name.trim()) errors.push({ field: 'name', message: 'Give the team a name.' });
  if (/[\r\n]/.test(draft.name) || /[\r\n]/.test(draft.description)) errors.push({ field: /[\r\n]/.test(draft.name) ? 'name' : 'description', message: 'The name and description must each be one line.' });
  if (!draft.members.length) errors.push({ field: 'members', message: 'Add at least one member.' });
  if (draft.members.length > 12) errors.push({ field: 'members', message: 'A team can have at most 12 members.' });
  const seen = new Map<string, number>();
  draft.members.forEach((member, index) => {
    const label = member.name || `Member ${index + 1}`;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(member.name)) errors.push({ member: index, field: 'name', message: `${label}: use lowercase letters, digits, and dashes (up to 40), starting with a letter or digit.` });
    else if (seen.has(member.name)) errors.push({ member: index, field: 'name', message: `Two members are named ${member.name}. Each needs its own name.` });
    seen.set(member.name, index);
    if (!member.instructions.trim()) errors.push({ member: index, field: 'instructions', message: `${label}: write what this member does (its instructions).` });
    if (/^##\s/m.test(member.instructions)) errors.push({ member: index, field: 'instructions', message: `${label}: a line in the instructions starts with "## ", which would start a new member. Use ### for headings.` });
    if (member.tools && !member.tools.length) errors.push({ member: index, field: 'tools', message: `${label}: choose at least one tool, or use the default set.` });
    if (/[\r\n,]/.test(member.role) || /[\r\n]/.test(member.model)) errors.push({ member: index, field: 'role', message: `${label}: the role and model must each be one line (no commas in the role).` });
  });
  const markdown = teamMarkdown(draft, original);
  if (errors.length) return { markdown, errors };
  try {
    const team = parseTeam(markdown, 'team.md');
    const expected = renderMembers(draft);
    const same = team.name === draft.name.trim() && team.description === draft.description.trim() && team.members.length === expected.length
      && team.members.every((member, index) => member.name === expected[index].name && (member.role ?? '') === (expected[index].role ?? '') && (member.model ?? '') === (expected[index].model ?? '')
        && JSON.stringify(member.tools) === JSON.stringify(expected[index].tools ?? DEFAULT_TOOLS) && member.instructions === expected[index].instructions);
    if (!same) errors.push({ message: 'The saved file would not read back as this team. Check that the name and description do not start and end with quotes, and that no instructions start with "role:", "model:", or "tools:".' });
  } catch (error) {
    errors.push({ message: `The saved file would not be a usable team: ${(error as Error).message}` });
  }
  return { markdown, errors };
}

export type DiffLine = { op: 'same' | 'add' | 'del'; text: string };

/** A simple line diff (longest common subsequence) from `before` to `after`. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))];
  const lengths: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i] }); i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) { out.push({ op: 'del', text: a[i] }); i += 1; }
    else { out.push({ op: 'add', text: b[j] }); j += 1; }
  }
  while (i < a.length) out.push({ op: 'del', text: a[i++] });
  while (j < b.length) out.push({ op: 'add', text: b[j++] });
  return out;
}

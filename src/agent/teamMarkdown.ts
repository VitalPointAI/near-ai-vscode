import { parseFrontmatter } from '../gsd/library';
import { DEFAULT_TOOLS, parsePrivacy, parseTeam, parseTeamPrivacy, renderTeam, reportsToKey, resolveMemberTools, slugify } from './teams';

// The Team Studio edits a team as a draft, but the Markdown file stays the source of truth: saving
// a draft over an existing file rewrites only what the draft changed. Unknown frontmatter keys,
// comments, the text before the first member, and every member section the draft left as it was
// are kept byte for byte. A new team is exactly what renderTeam writes.

/**
 * A member as the studio edits it. `tools: null` means no `tools:` line (the default set). `reportsTo` carries the team's hierarchy: without it in this
 * type the studio rewrote every save from a draft that had no such field and silently deleted the hierarchy (0.4.19 review).
 */
/** `privacy: 'private'` keeps the member on a NEAR TEE or local model (a `privacy: private` line); like reportsTo, it must be carried or a save drops it. */
export interface DraftMember { name: string; role: string; model: string; tools: string[] | null; instructions: string; reportsTo?: string; privacy?: 'private' }
/** `private`: the team's own `privacy: private` frontmatter line (0.4.27): every member runs only on a private model, and the studio sends it only to one. */
export interface TeamDraft { name: string; description: string; members: DraftMember[]; private?: boolean }

export interface Section { raw: string; name: string; role?: string; model?: string; tools?: string[]; reportsTo?: string; privacy?: 'private'; instructions: string }
export interface TeamParts { frontmatter?: { open: string; inner: string; close: string }; preamble: string; sections: Section[] }

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SECTION_START = /^##\s+/gm;
const FIELD = /^(role|model|tools|reports-to|privacy):\s*(.*)$/i;

/** Splits a team file the same way parseTeam reads it, keeping each part's exact text. */
function privacyOf(value: string | undefined): 'private' | undefined {
  try { return parsePrivacy(value, 'member'); } catch { return undefined; }
}

export function splitTeam(text: string): TeamParts {
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
      ...(reportsToKey(fields['reports-to']) ? { reportsTo: reportsToKey(fields['reports-to']) } : {}),
      ...(privacyOf(fields.privacy) ? { privacy: 'private' as const } : {}),
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
    name: team.name, description: team.description, ...(team.private ? { private: true } : {}),
    members: team.members.map((member) => {
      const section = sections.find((candidate) => candidate.name === member.name);
      return { name: member.name, role: member.role ?? '', model: member.model ?? '', tools: section?.tools ? [...section.tools] : null, instructions: member.instructions, ...(section?.reportsTo ? { reportsTo: section.reportsTo } : {}), ...(member.privacy ? { privacy: member.privacy } : {}) };
    })
  };
}

/**
 * The members as they are written. A team marked private writes privacy: private on every member too (0.4.27), so a build that reads only member lines
 * (one from before the team marking) still keeps every member private. Removing the team marking leaves those member lines: each is removed on its own.
 */
function renderMembers(draft: TeamDraft) {
  return draft.members.map((member) => ({
    name: member.name, ...(member.role.trim() ? { role: member.role.trim() } : {}), ...(member.model.trim() ? { model: member.model.trim() } : {}),
    ...(member.tools ? { tools: member.tools } : {}), ...(member.reportsTo?.trim() ? { reportsTo: member.reportsTo.trim() } : {}), ...(member.privacy === 'private' || draft.private === true ? { privacy: 'private' as const } : {}), instructions: member.instructions.trim()
  }));
}

function renderSection(member: ReturnType<typeof renderMembers>[number]): string {
  const lines = [`## ${member.name}`];
  if (member.role) lines.push(`role: ${member.role}`);
  if (member.model) lines.push(`model: ${member.model}`);
  // The hierarchy is written back, so a save keeps it (0.4.19 review: it was read but never written, so every save deleted it).
  if (member.reportsTo) lines.push(`reports-to: ${member.reportsTo}`);
  if (member.tools?.length) lines.push(`tools: ${member.tools.join(', ')}`);
  // privacy is always the last metadata line: a build from before it existed reads role, model, and tools correctly and takes this line as
  // the first line of the instructions, rather than stopping before tools and giving the member the default tools.
  if (member.privacy) lines.push(`privacy: ${member.privacy}`);
  lines.push('', member.instructions, '', '');
  return lines.join('\n');
}

const MEMBER_FIELD = /^(?:role|model|tools|reports-to):\s*.*$/i;
const PRIVACY_FIELD = /^privacy:\s*\S*\s*$/i;

/** A member section with privacy: private as its last setting line (an existing privacy line is replaced in place); every other byte is kept. */
function withPrivateLine(raw: string): string {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  let last = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (PRIVACY_FIELD.test(line)) { lines[index] = 'privacy: private'; return lines.join(eol); }
    if (MEMBER_FIELD.test(line)) { last = index; continue; }
    if (line) break;
  }
  lines.splice(last + 1, 0, 'privacy: private');
  return lines.join(eol);
}

function sameMember(section: Section, member: ReturnType<typeof renderMembers>[number]): boolean {
  // reports-to is compared too (0.4.27): without it, a draft that changed only who a member reports to kept the old section, so the change was lost.
  return section.name === member.name && (section.role ?? '') === (member.role ?? '') && (section.model ?? '') === (member.model ?? '') && reportsToKey(section.reportsTo) === reportsToKey(member.reportsTo)
    && JSON.stringify(section.tools ?? null) === JSON.stringify(member.tools ?? null) && (section.privacy ?? '') === (member.privacy ?? '') && section.instructions === member.instructions;
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

/**
 * The team's privacy line: written when the draft is private, removed when it is not and the file says private. A `privacy: any` line the person wrote is
 * left as it is when the team is not private, so a save never rewrites what already says the same thing.
 */
function setTeamPrivacy(lines: string[], isPrivate: boolean): void {
  // One case-insensitive matcher finds the line and decides what it says (PR #69 review: the line was found case-sensitively, so `Privacy: private`
  // gained a second key). The team reads only a lowercase key, so a capitalised line is rewritten in place rather than left beside a new one.
  const index = lines.findIndex((line) => PRIVACY_KEY.test(line));
  const value = index >= 0 ? lines[index].replace(PRIVACY_KEY, '') : undefined;
  let current: 'private' | undefined;
  try { current = value !== undefined ? parseTeamPrivacy(parseFrontmatter(`---\nprivacy:${value}\n---\n`).data.privacy) : undefined; } catch { current = undefined; }
  if (isPrivate) {
    if (current === 'private' && /^privacy:/.test(lines[index])) return;
    if (index >= 0) { lines.splice(index, 1 + listLength(lines, index), current === 'private' ? `privacy:${value}` : 'privacy: private'); return; }
    setFrontmatterKey(lines, 'privacy', 'private', 'description');
    return;
  }
  // Only the line the checkbox writes is removed (PR #69 review): a hand-written tee or local line, or any other value, is the person's and stays.
  if (index >= 0 && CHECKBOX_PRIVACY.test(lines[index])) lines.splice(index, 1 + listLength(lines, index));
}

const PRIVACY_KEY = /^privacy:/i;
const CHECKBOX_PRIVACY = /^privacy:\s*private\s*$/i;

/**
 * The team's own privacy value when it is private but not the `private` the checkbox writes (a hand-written `tee` or `local`), or undefined. Such a line is
 * kept as written whatever the draft says, so the team stays private and its members keep their lines; the studio shows it rather than ticking the box.
 */
export function handWrittenTeamPrivacy(text: string | undefined): string | undefined {
  if (text === undefined || !FRONTMATTER.test(text)) return undefined;
  const value = parseFrontmatter(text).data.privacy;
  if (typeof value !== 'string' || CHECKBOX_PRIVACY.test(`privacy: ${value}`)) return undefined;
  try { return parseTeamPrivacy(value) === 'private' ? value.trim() : undefined; } catch { return undefined; }
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
export function teamMarkdown(input: TeamDraft, original?: string): string {
  // A hand-written private value (tee, local) keeps the team private whatever the draft says (PR #69 review).
  const draft = handWrittenTeamPrivacy(original) ? { ...input, private: true } : input;
  const members = renderMembers(draft);
  const name = draft.name.trim();
  const description = draft.description.trim();
  if (original === undefined) return renderTeam(name, description, members, { private: draft.private === true });
  const parts = splitTeam(original);
  let head: string;
  if (parts.frontmatter) {
    const eol = parts.frontmatter.inner.includes('\r\n') ? '\r\n' : '\n';
    const lines = parts.frontmatter.inner.split(/\r?\n/);
    setFrontmatterKey(lines, 'name', name);
    setFrontmatterKey(lines, 'description', description, 'name');
    setTeamPrivacy(lines, draft.private === true);
    head = `${parts.frontmatter.open}${lines.join(eol)}${parts.frontmatter.close}`;
  } else {
    head = `---\nname: ${name}\ndescription: ${description}\n${draft.private ? 'privacy: private\n' : ''}---\n\n`;
  }
  const out: string[] = [];
  let lastGenerated = false;
  members.forEach((member) => {
    // A section that differs only by becoming private gets the privacy line added in place, so the rest of it is kept byte for byte.
    const kept = parts.sections.find((section) => sameMember(section, member))
      ?? (member.privacy === 'private' ? parts.sections.filter((section) => !section.privacy && sameMember({ ...section, privacy: 'private' }, member)).map((section) => ({ ...section, raw: withPrivateLine(section.raw) }))[0] : undefined);
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
    const expected = renderMembers(handWrittenTeamPrivacy(original) ? { ...draft, private: true } : draft);
    const same = team.name === draft.name.trim() && team.description === draft.description.trim() && (team.private === true) === (draft.private === true || handWrittenTeamPrivacy(original) !== undefined) && team.members.length === expected.length
      && team.members.every((member, index) => member.name === expected[index].name && (member.role ?? '') === (expected[index].role ?? '') && (member.model ?? '') === (expected[index].model ?? '')
        // A tools line is read with the document-output rule applied (resolveMemberTools), so the expected list gets it too.
        && JSON.stringify(member.tools) === JSON.stringify(expected[index].tools ? resolveMemberTools(expected[index].tools!) : DEFAULT_TOOLS) && (member.privacy ?? '') === (expected[index].privacy ?? '') && reportsToKey(member.reportsTo) === reportsToKey(expected[index].reportsTo) && member.instructions === expected[index].instructions);
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

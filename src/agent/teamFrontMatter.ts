import { parseFrontmatter } from '../gsd/library';

// One-line keys in a team file's front matter: `icon:` (0.4.30), which the studio writes, and `rating:`, which only a development build wrote (PR 86
// review: a rating is kept on this computer now, never in a file); it is read once and taken out of shared and imported teams. Both follow one rule
// (PR #82 review): the first `<key>:` line is the value, any later one is a leftover that every write removes, a new line goes right after a description
// that is complete on its one line (never inside a block scalar or a quoted value left open), else at the end of the front matter, and every other byte,
// line endings included, is kept. No VS Code imports, and nothing here reads or writes a file.

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** A top-level key line as the team loader's front matter parser reads it (parseFrontmatter in gsd/library.ts): a key at the start of the line. */
const KEY_LINE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const KEY = /^[a-z][a-z0-9-]{0,30}$/;

function keyPattern(key: string): RegExp {
  if (!KEY.test(key)) throw new Error(`Not a front matter key the studio writes: ${key}`);
  return new RegExp(`^${key}:`);
}

function keyLines(text: string, key: string): { match: RegExpExecArray; lines: string[]; at: number[]; pattern: RegExp } | undefined {
  const pattern = keyPattern(key);
  const match = FRONTMATTER.exec(text);
  if (!match) return undefined;
  const lines = match[1]!.split(/\r?\n/);
  return { match, lines, at: lines.flatMap((line, index) => (pattern.test(line) ? [index] : [])), pattern };
}

/** The value of the first `<key>:` line in a team file's front matter, unquoted, or undefined. */
export function frontMatterValue(text: string, key: string): string | undefined {
  const found = keyLines(text, key);
  if (!found || !found.at.length) return undefined;
  const value = found.lines[found.at[0]!]!.replace(found.pattern, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  return value || undefined;
}

/**
 * The team file with exactly one `<key>: <value>` line (where the first one was, or after the description), or with none when `value` is undefined.
 * Every other byte is kept, line endings included; a file with no front matter (not a usable team) is returned as it is.
 */
export function withFrontMatterLine(text: string, key: string, value: string | undefined): string {
  const found = keyLines(text, key);
  if (!found) return text;
  if (value !== undefined && /[\r\n]/.test(value)) throw new Error('A front matter value the studio writes is one line.');
  const { match, lines, at } = found;
  const line = value === undefined ? undefined : `${key}: ${value}`;
  if (line === undefined ? !at.length : at.length === 1 && lines[at[0]!] === line) return text;
  const inner = match[1]!;
  const open = /^---\r?\n/.exec(match[0])![0];
  const close = match[0].slice(open.length + inner.length);
  const eol = inner.includes('\r\n') || open.includes('\r\n') ? '\r\n' : '\n';
  const kept = lines.filter((_, index) => !at.includes(index));
  if (line !== undefined) {
    if (at.length) kept.splice(at[0]!, 0, line);
    else kept.splice(linePlace(kept, key), 0, line);
  }
  return `${open}${kept.join(eol)}${close}${text.slice(match[0].length)}`;
}

/**
 * Where a new line goes (PR #82 review, round 2: it went after any `description:` line, which put it inside a hand-written `description: |` block). Right
 * after the description only when its value is complete on that one line (not a block scalar, not a quote left open, not continued on an indented line);
 * otherwise at the end of the front matter, which ends any value above it. The place is then checked with the loader's own parser: every key must read
 * as it did, or the line goes at the end.
 */
function linePlace(lines: string[], key: string): number {
  const description = lines.findIndex((entry) => /^description:/.test(entry));
  if (description < 0) return lines.length;
  const value = (KEY_LINE.exec(lines[description]!)?.[2] ?? '').trim();
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : undefined;
  const oneLine = value !== '' && !/^[|>]/.test(value) && (!quote || (value.length > 1 && value.endsWith(quote)))
    && !/^\s/.test(lines[description + 1] ?? '');
  if (!oneLine) return lines.length;
  const read = (entries: string[]) => JSON.stringify(parseFrontmatter(`---\n${entries.join('\n')}\n---\n`).data);
  const placed = [...lines.slice(0, description + 1), `${key}: x`, ...lines.slice(description + 1)];
  const { [key]: _placed, ...rest } = parseFrontmatter(`---\n${placed.join('\n')}\n---\n`).data;
  return JSON.stringify(rest) === read(lines) ? description + 1 : lines.length;
}

// ---- the person's own rating ----

/** The front matter key of the person's own rating of a team: a whole number of stars from 1 to 5. */
export const RATING_KEY = 'rating';

/** The team's rating from its front matter (its first rating line), or undefined when there is none or it is not a whole number from 1 to 5. */
export function teamRating(text: string): number | undefined {
  const value = frontMatterValue(text, RATING_KEY);
  return value !== undefined && /^[1-5]$/.test(value) ? Number(value) : undefined;
}

/** The team file with this rating as its one rating line, or with none (undefined). A rating is a whole number from 1 to 5. */
export function withTeamRating(text: string, rating: number | undefined): string {
  if (rating !== undefined && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw new Error('A rating is a whole number of stars from 1 to 5.');
  return withFrontMatterLine(text, RATING_KEY, rating === undefined ? undefined : String(rating));
}

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { isSensitivePath } from '../agent/tools';

// Reads Open-GSD's Claude-runtime files generically: any skill or agent in the installed
// version is discovered, frontmatter keys this runner does not know are ignored, and nothing
// GSD-specific is hard-coded, so new commands and agents in future releases appear on their own.

export interface Frontmatter { [key: string]: string | string[] | undefined }

export interface GsdSkill {
  name: string;
  description: string;
  argumentHint?: string;
  allowedTools: string[];
  body: string;
  file: string;
  /** Absolute paths of the files its `@` include lines reference. */
  includes: string[];
}

export interface GsdAgent {
  name: string;
  description: string;
  tools: string[];
  /** A tier ("opus", "sonnet", "haiku", "inherit") or a model ID, when the definition sets one. */
  model?: string;
  body: string;
  file: string;
}

/** A small YAML subset: `key: value`, quoted values, `key:` followed by `- item` lists. Anything else is skipped. */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Frontmatter = {};
  let listKey: string | undefined;
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      const list = (Array.isArray(data[listKey]) ? data[listKey] : []) as string[];
      list.push(unquote(item[1]));
      data[listKey] = list;
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!pair) { listKey = undefined; continue; }
    listKey = pair[2] ? undefined : pair[1];
    data[pair[1]] = pair[2] ? unquote(pair[2]) : undefined;
  }
  return { data, body: text.slice(match[0].length) };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1).replace(/\\"/g, '"');
  return trimmed;
}

function toolList(value: string | string[] | undefined): string[] {
  const items = Array.isArray(value) ? value : (value ?? '').split(',');
  return items.map((item) => item.trim()).filter(Boolean);
}

const INCLUDE_LINE = /^@(\S+)\s*$/;

/** Includes that point into the runtime itself; relative includes name project files and are not part of the runtime. */
function includePaths(body: string, home: string): string[] {
  return body.split(/\r?\n/).map((line) => INCLUDE_LINE.exec(line.trim())?.[1]?.replace(/[.,;:)]+$/, '')).filter((value): value is string => typeof value === "string" && (value.startsWith("/") || value.startsWith("~/")))
    .map((value) => resolveIncludePath(value, home, home)).filter((absolute) => absolute.startsWith(home + path.sep));
}

/** `~/.claude/…` maps to the runtime directory; other absolute paths stay; relative paths are project files. */
export function resolveIncludePath(value: string, home: string, root: string): string {
  if (value.startsWith('~/.claude/')) return path.join(home, value.slice('~/.claude/'.length));
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

/**
 * Where an include line points. Prose sometimes ends the line with punctuation ("…/probe.md."),
 * and relative paths may name a project file or a runtime file; the first existing candidate
 * wins, otherwise the literal path is returned so it reports as not found.
 */
async function locateInclude(value: string, home: string, root: string): Promise<string> {
  const bare = value.replace(/[.,;:)]+$/, '');
  const candidates = [value, bare].flatMap((item) => path.isAbsolute(item) || item.startsWith('~') ? [resolveIncludePath(item, home, root)] : [path.resolve(root, item), path.resolve(home, item)]);
  for (const candidate of candidates) if (await stat(candidate).then((info) => info.isFile(), () => false)) return candidate;
  return resolveIncludePath(bare, home, root);
}

/** Skills from `skills/<name>/SKILL.md`, plus legacy `commands/**\/*.md` slash commands. */
export async function loadSkills(home: string): Promise<GsdSkill[]> {
  const skills: GsdSkill[] = [];
  for (const entry of await readdir(path.join(home, 'skills'), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const file = path.join(home, 'skills', entry.name, 'SKILL.md');
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text) skills.push(skillFrom(text, file, entry.name, home));
  }
  const commandsDir = path.join(home, 'commands');
  const visit = async (directory: string, prefix: string[]): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, [...prefix, entry.name]);
      else if (entry.name.endsWith('.md')) {
        const name = [...prefix, entry.name.slice(0, -3)].join(':');
        if (skills.some((skill) => skill.name === name)) continue;
        const text = await readFile(absolute, 'utf8').catch(() => undefined);
        if (text) skills.push(skillFrom(text, absolute, name, home));
      }
    }
  };
  await visit(commandsDir, []);
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function skillFrom(text: string, file: string, fallbackName: string, home: string): GsdSkill {
  const { data, body } = parseFrontmatter(text);
  const name = typeof data.name === 'string' && data.name ? data.name : fallbackName;
  return {
    name,
    description: typeof data.description === 'string' ? data.description : '',
    argumentHint: typeof data['argument-hint'] === 'string' ? data['argument-hint'] : undefined,
    allowedTools: toolList(data['allowed-tools']),
    body,
    file,
    includes: includePaths(body, home)
  };
}

export async function loadAgents(home: string): Promise<GsdAgent[]> {
  const agents: GsdAgent[] = [];
  for (const entry of await readdir(path.join(home, 'agents'), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = path.join(home, 'agents', entry.name);
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (!text) continue;
    const { data, body } = parseFrontmatter(text);
    agents.push({
      name: typeof data.name === 'string' && data.name ? data.name : entry.name.slice(0, -3),
      description: typeof data.description === 'string' ? data.description : '',
      tools: toolList(data.tools),
      model: typeof data.model === 'string' && data.model ? data.model : undefined,
      body,
      file
    });
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Turns a skill or agent body into the prompt the model sees: each line that is only `@<path>` is
 * replaced by that file's contents (nested includes too, each file once), then `$ARGUMENTS` becomes
 * what the user typed. Includes are only read from the runtime directory or the workspace, by
 * real path, and never from credential-looking files; anything else is left as a visible note.
 */
export async function expandPrompt(body: string, options: { args?: string; home: string; root: string; maxDepth?: number }): Promise<string> {
  const seen = new Set<string>();
  const bases = await Promise.all([options.home, options.root].map((base) => realpath(base).catch(() => base)));
  const allowed = (absolute: string) => bases.some((base) => absolute === base || absolute.startsWith(base + path.sep));
  const expand = async (text: string, depth: number): Promise<string> => {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const include = INCLUDE_LINE.exec(line.trim())?.[1];
      if (!include) { lines.push(line); continue; }
      // Resolved through symlinks, so a link in a cloned repository can't pull in outside files.
      const absolute = await realpath(await locateInclude(include, options.home, options.root)).catch(() => undefined);
      if (!absolute) { lines.push(`[include not found: ${include}]`); continue; }
      if (isSensitivePath(absolute)) { lines.push(`[include skipped: ${include} looks like it may contain credentials]`); continue; }
      if (!allowed(absolute)) { lines.push(`[include skipped: ${include} is outside the Open-GSD runtime and the workspace]`); continue; }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const content = await readFile(absolute, 'utf8').catch(() => undefined);
      if (content === undefined) { lines.push(`[include not found: ${include}]`); continue; }
      lines.push(`<included-file path="${absolute}">`, depth < (options.maxDepth ?? 4) ? await expand(content, depth + 1) : content, '</included-file>');
    }
    return lines.join('\n');
  };
  // Arguments are substituted after includes are expanded, so text the user or model passes
  // as arguments can never add include lines.
  return (await expand(body, 0)).replace(/\$ARGUMENTS/g, () => options.args ?? '');
}

/** Maps a GSD model tier or ID onto the configured NEAR models; unknown values fall back to the run's model. */
/** Roles that mostly read and summarize large inputs in parallel: the cheaper fast tier by default. */
export const DEFAULT_ROLE_MODELS: Record<string, string> = {
  'gsd-*-researcher': 'fast',
  'gsd-research-synthesizer': 'fast',
  'gsd-codebase-mapper': 'fast',
  'gsd-pattern-mapper': 'fast'
};

/** The model or tier configured for an agent role: an exact name first, then the longest matching * pattern. */
export function roleModelFor(role: string, roleModels: Record<string, string>): string | undefined {
  if (typeof roleModels[role] === 'string') return roleModels[role];
  const matches = Object.entries(roleModels).filter(([pattern, value]) => pattern.includes('*') && typeof value === 'string' && new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(role));
  return matches.sort((a, b) => b[0].length - a[0].length)[0]?.[1];
}

export function modelForTier(value: string | undefined, tiers: { deep: string; standard: string; fast: string }, current: string): string {
  const tier = (value ?? '').trim().toLowerCase();
  if (!tier || tier === 'inherit' || tier === 'default') return current;
  if (tier.includes('opus') || tier.includes('fable') || tier === 'deep' || tier === 'quality') return tiers.deep;
  if (tier.includes('haiku') || tier === 'fast' || tier === 'budget') return tiers.fast;
  if (tier.includes('sonnet') || tier === 'standard' || tier === 'balanced') return tiers.standard;
  return value!.includes('/') ? value! : current;
}

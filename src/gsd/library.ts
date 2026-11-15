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
  /** `private`: this agent runs only on a model in a NEAR TEE or on this machine (a team member's `privacy: private` line). */
  privacy?: 'private';
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
  'gsd-pattern-mapper': 'fast',
  // PERF-03: judgement roles get the deep tier, bulk fetching and extraction the fast tier. These are the routing defaults only: a team member's own
  // model line still wins, so the tiers a project type gives its members decide those.
  '*planner*': 'deep',
  '*plan-checker*': 'deep',
  '*verifier*': 'deep',
  '*analyst*': 'deep',
  '*editor*': 'deep',
  '*red-team*': 'deep',
  '*fetch*': 'fast',
  '*extract*': 'fast'
};

/** PERF-03: the tier routing gives a role by default (deep, standard or fast), or undefined when the role follows its own definition. */
export function defaultRoleTier(role: string): string | undefined {
  return roleModelFor(role, DEFAULT_ROLE_MODELS);
}

/** The model or tier configured for an agent role: an exact name first, then the longest matching * pattern. */
export function roleModelFor(role: string, roleModels: Record<string, string>): string | undefined {
  if (typeof roleModels[role] === 'string') return roleModels[role];
  const matches = Object.entries(roleModels).filter(([pattern, value]) => pattern.includes('*') && typeof value === 'string' && new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(role));
  return matches.sort((a, b) => b[0].length - a[0].length)[0]?.[1];
}

/** The tier a model line names (deep, standard, or fast), or undefined for a model ID or "inherit". */
export function tierOf(value: string | undefined): 'deep' | 'standard' | 'fast' | undefined {
  const tier = (value ?? '').trim().toLowerCase();
  if (tier.includes('opus') || tier.includes('fable') || tier === 'deep' || tier === 'quality') return 'deep';
  if (tier.includes('haiku') || tier === 'fast' || tier === 'budget') return 'fast';
  if (tier.includes('sonnet') || tier === 'standard' || tier === 'balanced') return 'standard';
  return undefined;
}

/** What private-model resolution needs to know about a model from the catalog. */
export interface PrivacyCandidate { id: string; privacyBoundary?: string; outputPricePerMillion?: number; contextLength?: number; outputModalities?: string[] }

const isPrivateModel = (model: PrivacyCandidate | undefined) => model?.privacyBoundary === 'tee' || model?.privacyBoundary === 'local';
const canChat = (model: PrivacyCandidate) => !/(?:embed|rerank|whisper|tts|speech|moderation)/i.test(model.id) && (!model.outputModalities || model.outputModalities.includes('text'));

/**
 * The model for an agent that must stay private (`privacy: private`): one that runs in a NEAR TEE
 * or on this machine, never one forwarded to an outside provider. The wanted model when it is
 * private; otherwise the most capable private model for the agent's tier, trying the configured
 * tier models first from that tier upwards in capability (deep, then standard, then fast for a
 * deep agent) and then any other private chat model, the highest priced (a proxy for capability)
 * with the longest context first. Undefined when no private model is available: the caller must
 * then refuse to run the agent rather than fall back to a forwarded model.
 */
export function privateModelFor(wanted: string, tier: 'deep' | 'standard' | 'fast' | undefined, tiers: { deep: string; standard: string; fast: string }, catalog: PrivacyCandidate[]): string | undefined {
  const byId = new Map(catalog.map((model) => [model.id, model]));
  if (isPrivateModel(byId.get(wanted))) return wanted;
  const order = tier === 'fast' ? [tiers.fast, tiers.standard, tiers.deep] : tier === 'standard' ? [tiers.standard, tiers.deep, tiers.fast] : [tiers.deep, tiers.standard, tiers.fast];
  const configured = order.find((id) => isPrivateModel(byId.get(id)));
  if (configured) return configured;
  return catalog.filter((model) => isPrivateModel(model) && canChat(model))
    .sort((a, b) => (b.outputPricePerMillion ?? 0) - (a.outputPricePerMillion ?? 0) || (b.contextLength ?? 0) - (a.contextLength ?? 0) || a.id.localeCompare(b.id))[0]?.id;
}

export function modelForTier(value: string | undefined, tiers: { deep: string; standard: string; fast: string }, current: string): string {
  const tier = (value ?? '').trim().toLowerCase();
  if (!tier || tier === 'inherit' || tier === 'default') return current;
  if (tier.includes('opus') || tier.includes('fable') || tier === 'deep' || tier === 'quality') return tiers.deep;
  if (tier.includes('haiku') || tier === 'fast' || tier === 'budget') return tiers.fast;
  if (tier.includes('sonnet') || tier === 'standard' || tier === 'balanced') return tiers.standard;
  return value!.includes('/') ? value! : current;
}

/**
 * The model ID a name stands for among the model IDs on this key: the exact ID; else the one ID equal to it ignoring case; else the
 * one ID whose own name (the part after the last "/") equals it ignoring case, so "gpt-6.1-sol" finds "openai/gpt-6.1-sol".
 * Undefined when nothing matches or the name is ambiguous (several IDs share it).
 */
export function resolveModelId(value: string, available: readonly string[]): string | undefined {
  const name = value.trim();
  if (!name) return undefined;
  if (available.includes(name)) return name;
  const lower = name.toLowerCase();
  const whole = available.filter((id) => id.toLowerCase() === lower);
  if (whole.length) return whole.length === 1 ? whole[0] : undefined;
  const short = available.filter((id) => id.slice(id.lastIndexOf('/') + 1).toLowerCase() === lower);
  return short.length === 1 ? short[0] : undefined;
}

/** A bounded list of model IDs for a message: at most `max` IDs and about 1,200 characters, then how many more there are. */
export function modelList(ids: readonly string[], max = 30): string {
  const shown: string[] = [];
  let length = 0;
  for (const id of ids) {
    if (shown.length >= max || length + id.length > 1_200) break;
    shown.push(id);
    length += id.length + 2;
  }
  const more = ids.length - shown.length;
  return shown.length ? `${shown.join(', ')}${more > 0 ? ` (and ${more} more)` : ''}` : 'none';
}

/** The model a sub-agent runs on, and a note when it is not the model that was asked for. */
export type AgentModelChoice = { model: string; note?: string } | { error: string };

/**
 * The model for a sub-agent. The role's configured model wins, then the model the Agent call asked for, then the agent file's own line.
 * A tier word (deep, standard, fast and their aliases) maps to that tier's model; any other value is resolved against the model IDs on
 * this key (`resolveModelId`). A model the Agent call itself asked for that cannot be resolved, or is not on this key, is an error that
 * names it and lists the models that are: the caller must not run the agent on another model without saying so (a run once passed
 * "gpt-6.1-sol" and six agents silently ran on the chat's model). A role or agent-file model, or a tier whose model is not on this key,
 * keeps falling back to the chat's model, with a note saying so. `available` undefined means the list is not known: a full ID ("x/y")
 * is then used as given.
 */
export function agentModelFor(input: { roleModel?: string; requested?: string; agentModel?: string; tiers: { deep: string; standard: string; fast: string }; current: string; available?: readonly string[] }): AgentModelChoice {
  const { roleModel, requested, agentModel, tiers, current, available } = input;
  const value = roleModel ?? requested ?? agentModel;
  const source = roleModel !== undefined ? 'role' : requested !== undefined ? 'request' : 'agent';
  const trimmed = (value ?? '').trim();
  const lower = trimmed.toLowerCase();
  // The Agent call asked for a model, and the role's configured model replaced it: said, so the lead does not report the wrong one.
  const overridden = source === 'role' && requested?.trim() ? ` The role's configured model (${trimmed}) takes precedence over the requested ${requested.trim().slice(0, 120)}.` : '';
  if (!trimmed || lower === 'inherit' || lower === 'default') return { model: current, ...(overridden ? { note: overridden.trim() } : {}) };
  const tier = tierOf(trimmed);
  const wanted = tier ? tiers[tier] : available ? resolveModelId(trimmed, available) : trimmed.includes('/') ? trimmed : undefined;
  if (wanted && (!available || available.includes(wanted))) return { model: wanted, ...(overridden ? { note: overridden.trim() } : {}) };
  if (source === 'request' && !tier) {
    const ambiguous = available ? available.filter((id) => id.slice(id.lastIndexOf('/') + 1).toLowerCase() === lower) : [];
    const why = ambiguous.length > 1 ? `matches several models (${modelList(ambiguous, 10)})` : available ? 'is not a model on this key' : 'is not a full model ID, and the list of models on this key is not known';
    return { error: `The requested model "${trimmed.slice(0, 120)}" ${why}, so the agent was not started. Available models: ${modelList(available ?? [])}. Pass one of these IDs, a tier (deep, standard or fast), or leave model out to use the default.` };
  }
  const what = tier ? `the ${tier} tier's model (${wanted})` : source === 'request' ? `the requested model ${trimmed}` : source === 'role' ? `the role's configured model ${trimmed}` : `the agent's own model ${trimmed}`;
  return { model: current, note: `${what} is not available on this key, so it runs on ${current}.${overridden}`.replace(/^t/, 'T') };
}

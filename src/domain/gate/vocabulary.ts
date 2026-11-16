// Capability vocabulary v1 (GATE-01, D-03, D-35): the closed grammar every manifest, bundle, grant and decision record speaks.
// Pure: no I/O, no clock, no vscode, no package. Every input is checked in place and every unknown verb, field or version is refused with one plain
// reason from GATE_SHAPE_FAILURES, never ignored. Once a release ships a verb or field its meaning never changes in place: a change is a new
// vocabulary version added beside this one. No field anywhere accepts a non-integer number (money is whole nano-USD).
// Types are re-exported with `export type` so the relay's isolatedModules build can compile this folder unchanged (Pitfall 12).
import type { ActionCapability } from '../policy';
import { normalizeRelative } from '../protectedPaths';
import { findSecrets } from '../team/secrets';
import { checkKeys, childPath, isRecord, isSafeIntegerInRange, ownValue, refused } from './shape';
import type { Fields, Parsed } from './shape';

export type { Parsed, Refusal, GateShapeFailure } from './shape';

export const GATE_VOCABULARY_VERSION = 1;

export const CAPABILITY_VERBS = Object.freeze([
  'read', 'plan', 'workspaceWrite', 'shell', 'network', 'mcp', 'send', 'publish', 'destroy', 'spawn', 'schedule', 'skill.write', 'spend',
  'useSecret', 'infer', 'gpu'
] as const);
export type CapabilityVerb = (typeof CAPABILITY_VERBS)[number];

export const SHELL_CWDS = Object.freeze(['workspace', 'anywhere'] as const);
export type ShellCwd = (typeof SHELL_CWDS)[number];

export const PUBLISH_TARGETS = Object.freeze(['git-remote', 'registry', 'container-registry', 'release', 'deploy', 'chain', '*'] as const);
export type PublishTarget = (typeof PUBLISH_TARGETS)[number];

export const SKILL_SCOPES = Object.freeze(['run', 'project', 'team', 'user'] as const);
export type SkillScope = (typeof SKILL_SCOPES)[number];

/** `deny` is a decision, not a requestable tier, so it is not in this list. */
export const INFER_TIERS = Object.freeze(['any-cloud', 'attested-cloud', 'local-only'] as const);
export type InferTier = (typeof INFER_TIERS)[number];

/** A credential handle is a short lowercase name, never the credential. The pattern keeps it signable; a handle that still looks like a secret is refused too (Pitfall 9). */
export const CREDENTIAL_HANDLE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

/** `request` is a concrete call (no wildcards); `ceiling` is a grant or bundle pattern (a `*` is allowed where the grammar says so). */
export type CapabilityMode = 'request' | 'ceiling';

/** A project-relative POSIX glob (`*`, `**`, `?`, `[...]`, `{a,b}`), already normalised: no `./`, no `..`, no leading slash. */
export type PathPattern = string;

/** A lowercase host, `*.example.com`, or `*`; no scheme, port or path. Wildcards only in a ceiling. */
export type HostPattern = string;

export type Capability =
  | { readonly verb: 'read'; readonly paths: readonly PathPattern[] }
  | { readonly verb: 'plan' }
  | { readonly verb: 'workspaceWrite'; readonly paths: readonly PathPattern[] }
  | { readonly verb: 'shell'; readonly cwd: ShellCwd }
  | { readonly verb: 'network'; readonly hosts: readonly HostPattern[] }
  | { readonly verb: 'mcp'; readonly server: string; readonly tools: readonly string[] }
  | { readonly verb: 'send'; readonly channel: string }
  | { readonly verb: 'publish'; readonly target: PublishTarget }
  | { readonly verb: 'destroy'; readonly paths: readonly PathPattern[] }
  | { readonly verb: 'spawn'; readonly agent: string }
  | { readonly verb: 'schedule'; readonly maxPerDay?: number }
  | { readonly verb: 'skill.write'; readonly scope: SkillScope }
  | { readonly verb: 'spend'; readonly nanoUsdPerRun?: number; readonly nanoUsdPerDay?: number }
  | { readonly verb: 'useSecret'; readonly handle: string; readonly audience?: HostPattern }
  | { readonly verb: 'infer'; readonly tier: InferTier; readonly provider: string; readonly model: string }
  | { readonly verb: 'gpu'; readonly device: string };

export interface ParseOptions { readonly vocabulary: number; readonly mode: CapabilityMode }

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const PARENT_SEGMENT = /(?:^|[/{,])\.\.(?:$|[/},])/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST_LENGTH = 253;
const MAX_NAME_LENGTH = 128;
const WILDCARD = '*';

export function isCapabilityVerb(value: string): value is CapabilityVerb {
  return (CAPABILITY_VERBS as readonly string[]).includes(value);
}

function has(value: Fields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** A non-empty project-relative glob, normalised with normalizeRelative. A `..` segment, a leading `/`, a drive letter, a backslash and a control character are refused. */
export function parsePathPattern(value: unknown, path: string): Parsed<PathPattern> {
  if (typeof value !== 'string' || value === '') return refused('wrong-type', path);
  if (CONTROL_CHARACTERS.test(value) || value.includes('\\') || value.startsWith('/') || DRIVE_PREFIX.test(value) || PARENT_SEGMENT.test(value)) {
    return refused('not-allowed-here', path);
  }
  const normalised = normalizeRelative(value);
  if (normalised === '') return refused('wrong-type', path);
  return { ok: true, value: normalised };
}

function isHostName(host: string): boolean {
  return host.length > 0 && host.length <= MAX_HOST_LENGTH && host.split('.').every((label) => HOST_LABEL.test(label));
}

/** A lowercase host, `*.example.com` or `*`. Uppercase, a scheme, a port and a path are refused as the wrong form; any `*` is refused outside a ceiling. */
export function parseHostPattern(value: unknown, path: string, mode: CapabilityMode): Parsed<HostPattern> {
  if (typeof value !== 'string' || value === '') return refused('wrong-type', path);
  if (value === WILDCARD) return mode === 'ceiling' ? { ok: true, value } : refused('not-allowed-here', path);
  const wildcard = value.startsWith('*.');
  if (!isHostName(wildcard ? value.slice(2) : value)) return refused('wrong-type', path);
  if (wildcard && mode !== 'ceiling') return refused('not-allowed-here', path);
  return { ok: true, value };
}

/** A name (server, tool, channel, agent, provider, model, device). A `*` is allowed only as the whole value, only in a ceiling, and only where `wildcard` says so. */
function parseName(value: unknown, path: string, mode: CapabilityMode, wildcard: boolean): Parsed<string> {
  if (typeof value !== 'string' || value === '' || value.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(value)) return refused('wrong-type', path);
  if (value.includes(WILDCARD)) {
    return wildcard && value === WILDCARD && mode === 'ceiling' ? { ok: true, value } : refused('not-allowed-here', path);
  }
  return { ok: true, value };
}

function parseChoice<T extends string>(value: unknown, path: string, allowed: readonly T[]): Parsed<T> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

/** Whole numbers only (D-35): a fraction, a negative number, a number above Number.MAX_SAFE_INTEGER and a string are all the wrong form. */
function parseWholeNumber(value: unknown, path: string): Parsed<number> {
  // Negative zero is a whole number to JavaScript but has no canonical form, so it is refused with the other wrong forms.
  return isSafeIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER) && !Object.is(value, -0) ? { ok: true, value } : refused('wrong-type', path);
}

/** A non-empty list, each entry parsed by `item`; the same entry twice is refused so one grant has one canonical form. */
function parseList<T>(raw: unknown, path: string, item: (entry: unknown, entryPath: string) => Parsed<T>): Parsed<readonly T[]> {
  if (!Array.isArray(raw)) return refused('wrong-type', path);
  if (raw.length === 0) return refused('empty-list', path);
  const out: T[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    if (!(index in raw)) return refused('wrong-type', entryPath);
    const parsed = item(raw[index], entryPath);
    if (!parsed.ok) return parsed;
    if (out.includes(parsed.value)) return refused('duplicate', entryPath);
    out.push(parsed.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parsePaths(value: Fields): Parsed<readonly PathPattern[]> {
  return parseList(ownValue(value, 'paths'), childPath('', 'paths'), parsePathPattern);
}

function parseCredentialHandle(value: unknown, path: string): Parsed<string> {
  if (typeof value !== 'string' || !CREDENTIAL_HANDLE_PATTERN.test(value)) return refused('wrong-type', path);
  return findSecrets(value).length > 0 ? refused('not-allowed-here', path) : { ok: true, value };
}

function done(capability: Capability): Parsed<Capability> {
  return { ok: true, value: Object.freeze(capability) };
}

function parseMcp(value: Fields, mode: CapabilityMode): Parsed<Capability> {
  const keys = checkKeys(value, '', ['verb', 'server', 'tools']);
  if (keys !== undefined) return keys;
  const server = parseName(ownValue(value, 'server'), 'server', mode, true);
  if (!server.ok) return server;
  const tools = parseList(ownValue(value, 'tools'), 'tools', (entry, entryPath) => parseName(entry, entryPath, mode, true));
  if (!tools.ok) return tools;
  return done({ verb: 'mcp', server: server.value, tools: tools.value });
}

function parsePublish(value: Fields, mode: CapabilityMode): Parsed<Capability> {
  const keys = checkKeys(value, '', ['verb', 'target']);
  if (keys !== undefined) return keys;
  const target = parseChoice(ownValue(value, 'target'), 'target', PUBLISH_TARGETS);
  if (!target.ok) return target;
  if (target.value === WILDCARD && mode !== 'ceiling') return refused('not-allowed-here', 'target');
  return done({ verb: 'publish', target: target.value });
}

function parseSchedule(value: Fields): Parsed<Capability> {
  const keys = checkKeys(value, '', ['verb'], ['maxPerDay']);
  if (keys !== undefined) return keys;
  if (!has(value, 'maxPerDay')) return done({ verb: 'schedule' });
  const maxPerDay = parseWholeNumber(value.maxPerDay, 'maxPerDay');
  return maxPerDay.ok ? done({ verb: 'schedule', maxPerDay: maxPerDay.value }) : maxPerDay;
}

// Money is whole nano-USD (D-35): there is no `usd` field and no number with a fraction anywhere in the vocabulary.
function parseSpend(value: Fields): Parsed<Capability> {
  const keys = checkKeys(value, '', ['verb'], ['nanoUsdPerRun', 'nanoUsdPerDay']);
  if (keys !== undefined) return keys;
  if (!has(value, 'nanoUsdPerRun') && !has(value, 'nanoUsdPerDay')) return refused('missing-field', 'nanoUsdPerRun');
  const out: { verb: 'spend'; nanoUsdPerRun?: number; nanoUsdPerDay?: number } = { verb: 'spend' };
  if (has(value, 'nanoUsdPerRun')) {
    const perRun = parseWholeNumber(value.nanoUsdPerRun, 'nanoUsdPerRun');
    if (!perRun.ok) return perRun;
    out.nanoUsdPerRun = perRun.value;
  }
  if (has(value, 'nanoUsdPerDay')) {
    const perDay = parseWholeNumber(value.nanoUsdPerDay, 'nanoUsdPerDay');
    if (!perDay.ok) return perDay;
    out.nanoUsdPerDay = perDay.value;
  }
  return done(out);
}

function parseUseSecret(value: Fields, mode: CapabilityMode): Parsed<Capability> {
  const keys = checkKeys(value, '', ['verb', 'handle'], ['audience']);
  if (keys !== undefined) return keys;
  const handle = parseCredentialHandle(ownValue(value, 'handle'), 'handle');
  if (!handle.ok) return handle;
  if (!has(value, 'audience')) return done({ verb: 'useSecret', handle: handle.value });
  const audience = parseHostPattern(value.audience, 'audience', mode);
  return audience.ok ? done({ verb: 'useSecret', handle: handle.value, audience: audience.value }) : audience;
}

// A tier is a request for a kind of model route; `deny` is a decision the gate makes, so it is refused here. The provider and the model may be `*` in a
// ceiling, because the shorthand mapping for media generation knows neither.
function parseInfer(value: Fields, mode: CapabilityMode): Parsed<Capability> {
  const keys = checkKeys(value, '', ['verb', 'tier', 'provider', 'model']);
  if (keys !== undefined) return keys;
  const tier = parseChoice(ownValue(value, 'tier'), 'tier', INFER_TIERS);
  if (!tier.ok) return tier;
  const provider = parseName(ownValue(value, 'provider'), 'provider', mode, true);
  if (!provider.ok) return provider;
  const model = parseName(ownValue(value, 'model'), 'model', mode, true);
  if (!model.ok) return model;
  return done({ verb: 'infer', tier: tier.value, provider: provider.value, model: model.value });
}

// Reserved: the shape is checked so a typo is still reported as a typo, then every gpu capability is refused until a later version defines it.
function parseGpu(value: Fields, mode: CapabilityMode): Parsed<Capability> {
  const keys = checkKeys(value, '', ['verb', 'device']);
  if (keys !== undefined) return keys;
  const device = parseName(ownValue(value, 'device'), 'device', mode, false);
  if (!device.ok) return device;
  return refused('not-available-yet', 'verb');
}

/**
 * Parse one capability. Pure and synchronous with no module state, so the same input always gives the same canonical result.
 * `options.vocabulary` is the version the caller claims: anything but 1 is refused with `unknown-version`.
 */
export function parseCapability(value: unknown, options: ParseOptions): Parsed<Capability> {
  if (options.vocabulary !== GATE_VOCABULARY_VERSION) return refused('unknown-version', 'vocabulary');
  if (!isRecord(value)) return refused('wrong-type', '');
  const verb = ownValue(value, 'verb');
  if (verb === undefined) return refused('missing-field', 'verb');
  if (typeof verb !== 'string') return refused('wrong-type', 'verb');
  if (!isCapabilityVerb(verb)) return refused('unknown-verb', 'verb');
  const mode = options.mode;
  switch (verb) {
    case 'read':
    case 'workspaceWrite':
    case 'destroy': {
      const keys = checkKeys(value, '', ['verb', 'paths']);
      if (keys !== undefined) return keys;
      const paths = parsePaths(value);
      return paths.ok ? done({ verb, paths: paths.value }) : paths;
    }
    case 'plan': {
      const keys = checkKeys(value, '', ['verb']);
      return keys !== undefined ? keys : done({ verb: 'plan' });
    }
    case 'shell': {
      const keys = checkKeys(value, '', ['verb', 'cwd']);
      if (keys !== undefined) return keys;
      const cwd = parseChoice(ownValue(value, 'cwd'), 'cwd', SHELL_CWDS);
      return cwd.ok ? done({ verb: 'shell', cwd: cwd.value }) : cwd;
    }
    case 'network': {
      const keys = checkKeys(value, '', ['verb', 'hosts']);
      if (keys !== undefined) return keys;
      const hosts = parseList(ownValue(value, 'hosts'), 'hosts', (entry, entryPath) => parseHostPattern(entry, entryPath, mode));
      return hosts.ok ? done({ verb: 'network', hosts: hosts.value }) : hosts;
    }
    case 'mcp': return parseMcp(value, mode);
    case 'send': {
      const keys = checkKeys(value, '', ['verb', 'channel']);
      if (keys !== undefined) return keys;
      const channel = parseName(ownValue(value, 'channel'), 'channel', mode, false);
      return channel.ok ? done({ verb: 'send', channel: channel.value }) : channel;
    }
    case 'publish': return parsePublish(value, mode);
    case 'spawn': {
      const keys = checkKeys(value, '', ['verb', 'agent']);
      if (keys !== undefined) return keys;
      const agent = parseName(ownValue(value, 'agent'), 'agent', mode, true);
      return agent.ok ? done({ verb: 'spawn', agent: agent.value }) : agent;
    }
    case 'schedule': return parseSchedule(value);
    case 'skill.write': {
      const keys = checkKeys(value, '', ['verb', 'scope']);
      if (keys !== undefined) return keys;
      const scope = parseChoice(ownValue(value, 'scope'), 'scope', SKILL_SCOPES);
      return scope.ok ? done({ verb: 'skill.write', scope: scope.value }) : scope;
    }
    case 'spend': return parseSpend(value);
    case 'useSecret': return parseUseSecret(value, mode);
    case 'infer': return parseInfer(value, mode);
    case 'gpu': return parseGpu(value, mode);
  }
}

/** What today's nine-word shorthand says about one call, as vocabulary capabilities. Facts the caller does not know fall back to the widest honest pattern. */
export interface ActionFacts {
  readonly paths?: readonly string[];
  readonly hosts?: readonly string[];
  readonly cwd?: ShellCwd;
  readonly provider?: string;
  readonly model?: string;
}

export interface ActionMapping {
  readonly capabilities: readonly Capability[];
  /** Set when the shorthand names state the vocabulary cannot name by path; the floor still asks (D-04, D-16). */
  readonly floorRule?: 'floor.shared-write';
}

// A capability built from facts. If the facts do not parse (a stray `..` in a path, say), the widest form of the same capability is used instead, never nothing.
function ceilingOf(candidate: unknown, widest: unknown): Capability {
  for (const attempt of [candidate, widest]) {
    const parsed = parseCapability(attempt, { vocabulary: GATE_VOCABULARY_VERSION, mode: 'ceiling' });
    if (parsed.ok) return parsed.value;
  }
  throw new Error('The widest capability for a shorthand did not parse; this is a bug in the vocabulary.');
}

/**
 * The one-way mapping from today's ActionCapability shorthand into vocabulary capabilities (D-04). Nothing maps back: the settings layer keeps using the
 * shorthand and the manifest is the richer record. `sharedWrite` becomes `skill.write{scope: team}` plus the floor marker `floor.shared-write`, because the
 * shared team knowledge store lives outside the project, where a project-relative path pattern cannot name it.
 */
export function fromActionCapability(capability: ActionCapability, facts: ActionFacts = {}): ActionMapping {
  const widestPaths = ['**'];
  const paths = facts.paths ?? widestPaths;
  switch (capability) {
    case 'read':
      return { capabilities: [ceilingOf({ verb: 'read', paths }, { verb: 'read', paths: widestPaths })] };
    case 'plan':
      return { capabilities: [ceilingOf({ verb: 'plan' }, { verb: 'plan' })] };
    case 'workspaceWrite':
      return { capabilities: [ceilingOf({ verb: 'workspaceWrite', paths }, { verb: 'workspaceWrite', paths: widestPaths })] };
    case 'sharedWrite':
      return { capabilities: [ceilingOf({ verb: 'skill.write', scope: 'team' }, { verb: 'skill.write', scope: 'team' })], floorRule: 'floor.shared-write' };
    case 'shell':
      return { capabilities: [ceilingOf({ verb: 'shell', cwd: facts.cwd ?? 'anywhere' }, { verb: 'shell', cwd: 'anywhere' })] };
    case 'network':
      return { capabilities: [ceilingOf({ verb: 'network', hosts: facts.hosts ?? [WILDCARD] }, { verb: 'network', hosts: [WILDCARD] })] };
    case 'gitMutation':
      return {
        capabilities: [
          ceilingOf({ verb: 'shell', cwd: 'workspace' }, { verb: 'shell', cwd: 'anywhere' }),
          ceilingOf({ verb: 'workspaceWrite', paths: ['.git/**'] }, { verb: 'workspaceWrite', paths: widestPaths })
        ]
      };
    case 'mediaGeneration':
      return {
        capabilities: [
          ceilingOf(
            { verb: 'infer', tier: 'any-cloud', provider: facts.provider ?? WILDCARD, model: facts.model ?? WILDCARD },
            { verb: 'infer', tier: 'any-cloud', provider: WILDCARD, model: WILDCARD }
          ),
          ceilingOf({ verb: 'workspaceWrite', paths }, { verb: 'workspaceWrite', paths: widestPaths })
        ]
      };
    case 'mediaPublication':
      return { capabilities: [ceilingOf({ verb: 'publish', target: WILDCARD }, { verb: 'publish', target: WILDCARD })] };
  }
}

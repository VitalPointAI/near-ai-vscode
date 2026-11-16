// Tool manifests v1 (GATE-02, D-05): what a built-in tool says it can do, and how the gate fills the concrete effects of one call from that call's input.
// Pure: no I/O, no clock, no vscode, no package. A manifest is a declaration in code, not a signed payload; the gate never trusts a field of a call that a
// manifest did not ask for, and a missing or wrongly typed input field is a refusal, never an empty or wildcard effect (T-70-17).
// Types are re-exported with `export type` so the relay's isolatedModules build can compile this folder unchanged (Pitfall 12).
import type { ActionCapability } from '../policy';
import { GATE_CONTEXTS } from './bundle';
import type { GateContextName } from './bundle';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Fields, Parsed } from './shape';
import { contentsOf } from './pathCover';
import { CREDENTIAL_HANDLE_PATTERN, GATE_VOCABULARY_VERSION, isCapabilityVerb, parseCapability, parseHostPattern, parsePathPattern } from './vocabulary';
import type { Capability, CapabilityVerb, HostPattern } from './vocabulary';
import { findSecrets } from '../team/secrets';

export type { Parsed, Refusal } from './shape';
export type { GateContextName } from './bundle';

export const MANIFEST_VERSION = 1;

/** Where a tool's work happens: the person's own machine with their own permissions, or somewhere else. */
export const RUNS_ON = Object.freeze(['this-machine', 'remote'] as const);
export type RunsOn = (typeof RUNS_ON)[number];

/** The four contexts a tool may run in, named once in the bundle and re-exported here so a manifest and a bundle can never name them differently. */
export const GATE_RUN_CONTEXTS = GATE_CONTEXTS;

/** How an input value becomes part of an effect: a project path, the host of a URL, or the value as given. */
export const INPUT_AS = Object.freeze(['path', 'folder', 'url-host', 'literal'] as const);
export type InputAs = (typeof INPUT_AS)[number];

export interface InputFieldSource { readonly from: 'input'; readonly field: string; readonly as: InputAs }
export interface CommandSource { readonly from: 'command' }
/** Exactly two ways to fill an effect from a call: a named input field, or (Bash only) the command text itself. */
export type InputSource = InputFieldSource | CommandSource;

export type TemplateValue = string | number | InputFieldSource | readonly (string | InputFieldSource)[];

/** A capability in ceiling form whose constraint values (paths, hosts, an agent name, a channel) may be an input source. */
export interface EffectTemplate { readonly verb: CapabilityVerb; readonly [field: string]: TemplateValue }

/** A manifest effect: a template, or the `{ from: 'command' }` marker that says a command classifier adds the effects the command's text shows. */
export type EffectEntry = EffectTemplate | CommandSource;

export interface ToolManifest {
  readonly manifestVersion: 1;
  readonly tool: string;
  readonly effects: readonly EffectEntry[];
  readonly hosts: readonly HostPattern[];
  readonly credentials: readonly string[];
  readonly contexts: readonly GateContextName[];
  readonly untrusted: boolean;
  readonly runsOn: RunsOn;
}

const MANIFEST_KEYS = ['manifestVersion', 'tool', 'effects', 'hosts', 'credentials', 'contexts', 'untrusted', 'runsOn'] as const;
const MAX_NAME_LENGTH = 128;
const MAX_LIST_ENTRIES = 256;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const BASH_TOOL = 'Bash';

/** The constraint fields a manifest may fill from a call, which forms each accepts, and a stand-in value used to check the rest of the template in place. */
interface SourceField { readonly list: boolean; readonly as: readonly InputAs[]; readonly probe: (index: number) => string }
const SOURCE_FIELDS: ReadonlyMap<string, SourceField> = new Map<string, SourceField>([
  ['paths', { list: true, as: ['path', 'folder', 'literal'], probe: (index) => `probe${index}` }],
  ['hosts', { list: true, as: ['url-host', 'literal'], probe: (index) => `probe${index}.example` }],
  ['agent', { list: false, as: ['literal'], probe: (index) => `probe${index}` }],
  ['channel', { list: false, as: ['literal'], probe: (index) => `probe${index}` }]
]);

export function isCommandEffect(entry: EffectEntry): entry is CommandSource {
  return 'from' in entry && entry.from === 'command';
}

/** A name is a short string with no control character; a `*` is never part of a manifest's own name. */
export function parseManifestName(value: unknown, path: string): Parsed<string> {
  if (typeof value !== 'string' || value === '' || value.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(value) || value.includes('*')) {
    return refused('wrong-type', path);
  }
  return { ok: true, value };
}

function parseChoice<T extends string>(value: unknown, path: string, allowed: readonly T[]): Parsed<T> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

/** A list, each entry parsed by `item`, the same entry twice refused. An empty list is refused unless `allowEmpty`. */
function parseEntries<T>(raw: unknown, path: string, allowEmpty: boolean, item: (entry: unknown, entryPath: string) => Parsed<T>): Parsed<readonly T[]> {
  if (!Array.isArray(raw)) return refused('wrong-type', path);
  if (raw.length === 0 && !allowEmpty) return refused('empty-list', path);
  if (raw.length > MAX_LIST_ENTRIES) return refused('not-allowed-here', path);
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

/** A credential handle is a short lowercase name, never the credential; the vocabulary's own `useSecret` check refuses anything that still looks like a secret. */
export function parseCredentialHandleName(value: unknown, path: string): Parsed<string> {
  if (typeof value !== 'string' || !CREDENTIAL_HANDLE_PATTERN.test(value)) return refused('wrong-type', path);
  return findSecrets(value).length > 0 ? refused('not-allowed-here', path) : { ok: true, value };
}

export function parseContextNames(raw: unknown, path: string): Parsed<readonly GateContextName[]> {
  return parseEntries(raw, path, false, (entry, entryPath) => parseChoice(entry, entryPath, GATE_RUN_CONTEXTS));
}

export function parseHostList(raw: unknown, path: string): Parsed<readonly HostPattern[]> {
  return parseEntries(raw, path, true, (entry, entryPath) => parseHostPattern(entry, entryPath, 'ceiling'));
}

export function parseCredentialList(raw: unknown, path: string): Parsed<readonly string[]> {
  return parseEntries(raw, path, true, parseCredentialHandleName);
}

function parseInputField(value: Fields, path: string, allowed: readonly InputAs[]): Parsed<InputFieldSource> {
  const keys = checkKeys(value, path, ['from', 'field', 'as']);
  if (keys !== undefined) return keys;
  // `from` names the one place a value may come from; a source for anything else (the environment, a file) is not part of the format.
  if (ownValue(value, 'from') !== 'input') return refused('not-allowed-here', childPath(path, 'from'));
  const field = ownValue(value, 'field');
  if (typeof field !== 'string' || !FIELD_NAME.test(field)) return refused('wrong-type', childPath(path, 'field'));
  const as = parseChoice(ownValue(value, 'as'), childPath(path, 'as'), allowed);
  return as.ok ? { ok: true, value: Object.freeze({ from: 'input', field, as: as.value }) } : as;
}

function toTemplateValue(value: unknown): TemplateValue | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')) return Object.freeze(value.slice());
  return undefined;
}

/**
 * One effect template. The sources are replaced by stand-in values and the whole effect is checked by the vocabulary's own parser in ceiling form, so a
 * template that could never be a real capability (a typo, a `paths` on `shell`, a bad literal) is refused when it is read, not when a tool is called.
 */
function parseTemplate(value: unknown, path: string): Parsed<EffectTemplate> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const verb = ownValue(value, 'verb');
  if (verb === undefined) return refused('missing-field', childPath(path, 'verb'));
  if (typeof verb !== 'string') return refused('wrong-type', childPath(path, 'verb'));
  if (!isCapabilityVerb(verb)) return refused('unknown-verb', childPath(path, 'verb'));
  const probe: Fields = {};
  const sources = new Map<string, Map<number, InputFieldSource>>();
  for (const key of Object.keys(value)) {
    const raw = value[key];
    const spec = SOURCE_FIELDS.get(key);
    const fieldPath = childPath(path, key);
    if (spec === undefined) { probe[key] = raw; continue; }
    const found = new Map<number, InputFieldSource>();
    const read = (entry: unknown, index: number, entryPath: string): Parsed<string> => {
      if (typeof entry === 'string') return { ok: true, value: entry };
      if (!isRecord(entry)) return refused('wrong-type', entryPath);
      const source = parseInputField(entry, entryPath, spec.as);
      if (!source.ok) return source;
      found.set(index, source.value);
      return { ok: true, value: spec.probe(index) };
    };
    if (spec.list) {
      if (!Array.isArray(raw)) return refused('wrong-type', fieldPath);
      const items: string[] = [];
      for (let index = 0; index < raw.length; index += 1) {
        if (!(index in raw)) return refused('wrong-type', `${fieldPath}[${index}]`);
        const item = read(raw[index], index, `${fieldPath}[${index}]`);
        if (!item.ok) return item;
        items.push(item.value);
      }
      probe[key] = items;
    } else {
      const item = read(raw, 0, fieldPath);
      if (!item.ok) return item;
      probe[key] = item.value;
    }
    sources.set(key, found);
  }
  const parsed = parseCapability(probe, { vocabulary: GATE_VOCABULARY_VERSION, mode: 'ceiling' });
  if (!parsed.ok) return parsed.path === '' ? refused(parsed.reason, path) : refused(parsed.reason, childPath(path, parsed.path));
  const out: { verb: CapabilityVerb; [field: string]: TemplateValue } = { verb };
  for (const key of Object.keys(parsed.value)) {
    if (key === 'verb') continue;
    const fromParser: unknown = Reflect.get(parsed.value, key);
    const here = sources.get(key);
    const typed = toTemplateValue(fromParser);
    if (typed === undefined) return refused('wrong-type', childPath(path, key));
    if (here === undefined || here.size === 0) { out[key] = typed; continue; }
    if (Array.isArray(typed)) {
      const merged: (string | InputFieldSource)[] = typed.map((entry, index) => here.get(index) ?? entry);
      out[key] = Object.freeze(merged);
    } else {
      const only = here.get(0);
      if (only === undefined) return refused('wrong-type', childPath(path, key));
      out[key] = only;
    }
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseCommandMarker(value: Fields, path: string): Parsed<CommandSource> {
  const keys = checkKeys(value, path, ['from']);
  return keys !== undefined ? keys : { ok: true, value: Object.freeze({ from: 'command' }) };
}

function hasShellEffect(effects: readonly EffectEntry[]): boolean {
  return effects.some((entry) => !isCommandEffect(entry) && entry.verb === 'shell');
}

function parseEffectEntries(raw: unknown, path: string, tool: string): Parsed<readonly EffectEntry[]> {
  if (!Array.isArray(raw)) return refused('wrong-type', path);
  if (raw.length === 0) return refused('empty-list', path);
  if (raw.length > MAX_LIST_ENTRIES) return refused('not-allowed-here', path);
  const out: EffectEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    if (!(index in raw)) return refused('wrong-type', entryPath);
    const entry: unknown = raw[index];
    const isCommand = isRecord(entry) && ownValue(entry, 'from') === 'command';
    let parsed: Parsed<EffectEntry>;
    if (isCommand && isRecord(entry)) {
      // Only the Bash tool has command text to read; for any other tool the marker would promise effects nothing can fill.
      if (tool !== BASH_TOOL) return refused('not-allowed-here', entryPath);
      parsed = parseCommandMarker(entry, entryPath);
    } else {
      parsed = parseTemplate(entry, entryPath);
    }
    if (!parsed.ok) return parsed;
    const key = JSON.stringify(parsed.value);
    if (seen.has(key)) return refused('duplicate', entryPath);
    seen.add(key);
    out.push(parsed.value);
  }
  // The command marker adds to the shell effect the manifest itself names; it never stands alone, so effectsFor can never return nothing.
  if (out.some(isCommandEffect) && !hasShellEffect(out)) return refused('missing-field', path);
  return { ok: true, value: Object.freeze(out) };
}

/** Parse one tool manifest v1. Closed keys; at least one effect (a `plan` effect counts); empty `hosts` and `credentials` mean none; at least one context. */
export function parseToolManifest(value: unknown): Parsed<ToolManifest> {
  if (!isRecord(value)) return refused('wrong-type', '');
  const keys = checkKeys(value, '', MANIFEST_KEYS);
  if (keys !== undefined) return keys;
  const version = ownValue(value, 'manifestVersion');
  if (typeof version !== 'number') return refused('wrong-type', 'manifestVersion');
  if (version !== MANIFEST_VERSION) return refused('unknown-version', 'manifestVersion');
  const tool = parseManifestName(ownValue(value, 'tool'), 'tool');
  if (!tool.ok) return tool;
  const effects = parseEffectEntries(ownValue(value, 'effects'), 'effects', tool.value);
  if (!effects.ok) return effects;
  const hosts = parseHostList(ownValue(value, 'hosts'), 'hosts');
  if (!hosts.ok) return hosts;
  const credentials = parseCredentialList(ownValue(value, 'credentials'), 'credentials');
  if (!credentials.ok) return credentials;
  const contexts = parseContextNames(ownValue(value, 'contexts'), 'contexts');
  if (!contexts.ok) return contexts;
  const untrusted = ownValue(value, 'untrusted');
  if (typeof untrusted !== 'boolean') return refused('wrong-type', 'untrusted');
  const runsOn = parseChoice(ownValue(value, 'runsOn'), 'runsOn', RUNS_ON);
  if (!runsOn.ok) return runsOn;
  return {
    ok: true,
    value: Object.freeze({
      manifestVersion: MANIFEST_VERSION,
      tool: tool.value,
      effects: effects.value,
      hosts: hosts.value,
      credentials: credentials.value,
      contexts: contexts.value,
      untrusted,
      runsOn: runsOn.value
    })
  };
}

function ownField(input: unknown, field: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined;
  return Object.prototype.hasOwnProperty.call(input, field) ? Reflect.get(input, field) : undefined;
}

function resolveSource(source: InputFieldSource, input: unknown): Parsed<string> {
  const where = childPath('input', source.field);
  const raw = ownField(input, source.field);
  if (raw === undefined) return refused('missing-field', where);
  if (typeof raw !== 'string' || raw === '') return refused('wrong-type', where);
  // `folder` reads a path as the folder it names, and everything under it (`src` is `src/**`); the root in any form is `**`.
  if (source.as === 'folder') {
    // The same checks a `path` gets first, so an absolute path, a `..` or a backslash is refused here too and never read as a project folder.
    const folder = parsePathPattern(raw, where);
    return folder.ok ? { ok: true, value: contentsOf(folder.value) } : folder;
  }
  if (source.as !== 'url-host') return { ok: true, value: raw };
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return refused('wrong-type', where);
  }
  return host === '' ? refused('wrong-type', where) : { ok: true, value: host };
}

function isFieldSource(value: unknown): value is InputFieldSource {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Reflect.get(value, 'from') === 'input';
}

function fillEntry(entry: unknown, input: unknown): Parsed<string> {
  if (typeof entry === 'string') return { ok: true, value: entry };
  return isFieldSource(entry) ? resolveSource(entry, input) : refused('wrong-type', '');
}

/**
 * The concrete effects of one call: each template filled from `input` and checked by the vocabulary's own parser in request mode, so a wildcard, a path
 * that leaves the project and a host that is not a host are refused. A missing or wrongly typed input field is a refusal, never an empty or wildcard
 * effect (T-70-17). The `{ from: 'command' }` marker adds nothing here; the command classifier adds its effects in a later plan.
 */
export function effectsFor(manifest: ToolManifest, input: unknown): Parsed<readonly Capability[]> {
  const out: Capability[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < manifest.effects.length; index += 1) {
    const entry = manifest.effects[index];
    if (entry === undefined || isCommandEffect(entry)) continue;
    const path = `effects[${index}]`;
    const filled: Fields = {};
    for (const key of Object.keys(entry)) {
      const raw: unknown = entry[key];
      const spec = SOURCE_FIELDS.get(key);
      if (spec === undefined) { filled[key] = raw; continue; }
      if (spec.list && Array.isArray(raw)) {
        const items: string[] = [];
        for (const item of raw) {
          const one = fillEntry(item, input);
          if (!one.ok) return one;
          // Two fields can fill the same value; one effect names it once.
          if (!items.includes(one.value)) items.push(one.value);
        }
        filled[key] = items;
      } else {
        const one = fillEntry(raw, input);
        if (!one.ok) return one;
        filled[key] = one.value;
      }
    }
    const parsed = parseCapability(filled, { vocabulary: GATE_VOCABULARY_VERSION, mode: 'request' });
    if (!parsed.ok) return parsed.path === '' ? refused(parsed.reason, path) : refused(parsed.reason, childPath(path, parsed.path));
    const key = JSON.stringify(parsed.value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

/** The ActionCapability shorthand a manifest implies, so a test can check that every tool's own `capability` agrees with its manifest except a short named list (Pitfall 10, D-04). */
export function shorthandFor(manifest: { readonly effects: readonly (EffectEntry | Capability)[] }): ActionCapability {
  const verbs = new Set<CapabilityVerb>();
  let sharedSkill = false;
  for (const entry of manifest.effects) {
    if ('from' in entry) continue;
    const verb: unknown = Reflect.get(entry, 'verb');
    if (typeof verb !== 'string' || !isCapabilityVerb(verb)) continue;
    verbs.add(verb);
    if (verb === 'skill.write' && Reflect.get(entry, 'scope') === 'team') sharedSkill = true;
  }
  if (sharedSkill) return 'sharedWrite';
  if (verbs.has('shell')) return 'shell';
  if (verbs.has('publish')) return 'mediaPublication';
  if (verbs.has('workspaceWrite') && verbs.has('infer')) return 'mediaGeneration';
  if (verbs.has('workspaceWrite') || verbs.has('destroy')) return 'workspaceWrite';
  // Anything that reaches outside this run, or spends or sends, is at least a network action: the shorthand has no quieter word for it.
  const outward: readonly CapabilityVerb[] = ['network', 'mcp', 'send', 'infer', 'useSecret', 'spend', 'schedule'];
  if (outward.some((verb) => verbs.has(verb))) return 'network';
  if (verbs.has('read')) return 'read';
  return 'plan';
}

// MCP server manifests v1 (GATE-03, D-06, D-38). A manifest is a claim by the person or the server about what its tools do; the gate uses it to decide, and
// the words always say so (MANIFEST_IS_A_CLAIM_TEXT in words.ts). A tool the manifest does not declare gets the most restrictive effects under `restrictive`.

export const MCP_TOOL_DEFAULTS = Object.freeze(['restrictive', 'legacy'] as const);
export type McpToolDefaults = (typeof MCP_TOOL_DEFAULTS)[number];

export type McpTransport = 'http' | 'stdio';
/** The per-server approval setting as the MCP registry stores it; named here because this folder may not import src/mcp. */
export type McpApprovalSetting = 'ask-for-changes' | 'ask-every-call' | 'trusted';

export interface McpToolEntry { readonly effects: readonly Capability[]; readonly contexts?: readonly GateContextName[] }

export interface McpManifest {
  readonly manifestVersion: 1;
  readonly server: string;
  readonly runsOn: RunsOn;
  readonly hosts: readonly HostPattern[];
  readonly credentials: readonly string[];
  readonly contexts: readonly GateContextName[];
  readonly tools: Readonly<Record<string, McpToolEntry>>;
  readonly toolDefaults: McpToolDefaults;
}

const MCP_MANIFEST_KEYS = ['manifestVersion', 'server', 'runsOn', 'hosts', 'credentials', 'contexts', 'tools', 'toolDefaults'] as const;
const MAX_MCP_TOOLS = 512;

function ceilingCapability(candidate: unknown): Capability {
  const parsed = parseCapability(candidate, { vocabulary: GATE_VOCABULARY_VERSION, mode: 'ceiling' });
  if (!parsed.ok) throw new Error('A built-in capability did not parse; this is a bug in the manifest module.');
  return parsed.value;
}

/** What a tool the manifest does not declare may do: run commands anywhere, reach any site, change any file and delete any file (D-06). */
export const RESTRICTIVE_EFFECTS: readonly Capability[] = Object.freeze([
  ceilingCapability({ verb: 'shell', cwd: 'anywhere' }),
  ceilingCapability({ verb: 'network', hosts: ['*'] }),
  ceilingCapability({ verb: 'workspaceWrite', paths: ['**'] }),
  ceilingCapability({ verb: 'destroy', paths: ['**'] })
]);

/** A stdio server runs on this machine with the person's own permissions, so it only runs while the person is there unless a manifest names another context (D-06). */
export function defaultMcpContexts(transport: McpTransport): readonly GateContextName[] {
  return transport === 'stdio' ? Object.freeze(['interactive' as const]) : Object.freeze(['interactive' as const, 'unattended' as const]);
}

function parseEffectCapabilities(raw: unknown, path: string): Parsed<readonly Capability[]> {
  if (!Array.isArray(raw)) return refused('wrong-type', path);
  if (raw.length === 0) return refused('empty-list', path);
  if (raw.length > MAX_LIST_ENTRIES) return refused('not-allowed-here', path);
  const out: Capability[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    if (!(index in raw)) return refused('wrong-type', entryPath);
    const parsed = parseCapability(raw[index], { vocabulary: GATE_VOCABULARY_VERSION, mode: 'ceiling' });
    if (!parsed.ok) return parsed.path === '' ? refused(parsed.reason, entryPath) : refused(parsed.reason, childPath(entryPath, parsed.path));
    const key = JSON.stringify(parsed.value);
    if (seen.has(key)) return refused('duplicate', entryPath);
    seen.add(key);
    out.push(parsed.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseToolEntry(value: unknown, path: string): Parsed<McpToolEntry> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['effects'], ['contexts']);
  if (keys !== undefined) return keys;
  const effects = parseEffectCapabilities(ownValue(value, 'effects'), childPath(path, 'effects'));
  if (!effects.ok) return effects;
  if (!Object.prototype.hasOwnProperty.call(value, 'contexts')) return { ok: true, value: Object.freeze({ effects: effects.value }) };
  const contexts = parseContextNames(value.contexts, childPath(path, 'contexts'));
  return contexts.ok ? { ok: true, value: Object.freeze({ effects: effects.value, contexts: contexts.value }) } : contexts;
}

function parseToolTable(value: unknown, path: string): Parsed<Readonly<Record<string, McpToolEntry>>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const names = Object.keys(value);
  if (names.length > MAX_MCP_TOOLS) return refused('not-allowed-here', path);
  const entries: [string, McpToolEntry][] = [];
  for (const name of names) {
    const where = childPath(path, name.slice(0, 40));
    const checked = parseManifestName(name, where);
    if (!checked.ok) return checked;
    const entry = parseToolEntry(value[name], where);
    if (!entry.ok) return entry;
    entries.push([name, entry.value]);
  }
  // Built with fromEntries so a tool named `__proto__` is an ordinary own entry and no prototype changes.
  return { ok: true, value: Object.freeze(Object.fromEntries(entries)) };
}

/** Parse one MCP server manifest v1. Closed keys; `tools` maps exact tool names to their effects; an empty `tools` object is valid. */
export function parseMcpManifest(value: unknown): Parsed<McpManifest> {
  if (!isRecord(value)) return refused('wrong-type', '');
  const keys = checkKeys(value, '', MCP_MANIFEST_KEYS);
  if (keys !== undefined) return keys;
  const version = ownValue(value, 'manifestVersion');
  if (typeof version !== 'number') return refused('wrong-type', 'manifestVersion');
  if (version !== MANIFEST_VERSION) return refused('unknown-version', 'manifestVersion');
  const server = parseManifestName(ownValue(value, 'server'), 'server');
  if (!server.ok) return server;
  const runsOn = parseChoice(ownValue(value, 'runsOn'), 'runsOn', RUNS_ON);
  if (!runsOn.ok) return runsOn;
  const hosts = parseHostList(ownValue(value, 'hosts'), 'hosts');
  if (!hosts.ok) return hosts;
  const credentials = parseCredentialList(ownValue(value, 'credentials'), 'credentials');
  if (!credentials.ok) return credentials;
  const contexts = parseContextNames(ownValue(value, 'contexts'), 'contexts');
  if (!contexts.ok) return contexts;
  const tools = parseToolTable(ownValue(value, 'tools'), 'tools');
  if (!tools.ok) return tools;
  const toolDefaults = parseChoice(ownValue(value, 'toolDefaults'), 'toolDefaults', MCP_TOOL_DEFAULTS);
  if (!toolDefaults.ok) return toolDefaults;
  return {
    ok: true,
    value: Object.freeze({
      manifestVersion: MANIFEST_VERSION,
      server: server.value,
      runsOn: runsOn.value,
      hosts: hosts.value,
      credentials: credentials.value,
      contexts: contexts.value,
      tools: tools.value,
      toolDefaults: toolDefaults.value
    })
  };
}

/** The facts the MCP registry already has about one tool of one server. `readOnly` and `destructive` are the tool's own hints. */
export interface McpToolFacts {
  readonly server: string;
  readonly tool: string;
  /** The server's host for a remote server; empty or absent for a local command. */
  readonly host?: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly approval: McpApprovalSetting;
  readonly transport: McpTransport;
}

export type McpDefaultsUsed = 'declared' | 'restrictive' | 'legacy';

export interface McpToolEffects {
  readonly effects: readonly Capability[];
  readonly contexts: readonly GateContextName[];
  readonly shorthand: ActionCapability;
  readonly defaults: McpDefaultsUsed;
}

function legacyHost(host: string | undefined): string {
  const trimmed = (host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
  if (trimmed === '') return '*';
  const parsed = parseHostPattern(trimmed, 'host', 'ceiling');
  return parsed.ok ? parsed.value : '*';
}

function hasOwnTool(tools: Readonly<Record<string, McpToolEntry>>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(tools, name);
}

/**
 * The effects, contexts and shorthand of one MCP tool call. A declared tool uses its own entry (exact name only; a tool named differently by case is a
 * different tool, T-70-18). With no manifest, or `toolDefaults: 'legacy'`, an undeclared tool decides exactly as src/mcp/tools.ts does today: a read-only
 * tool on a server that is not set to ask every call is `read`; any other tool is `network` and also reaches the server's host (D-38). Under `restrictive`
 * an undeclared tool gets RESTRICTIVE_EFFECTS and may only run while the person is there (T-70-16). A server or tool name the vocabulary cannot hold
 * (a `*`, a control character, too long) is never matched loosely: it gets RESTRICTIVE_EFFECTS too.
 */
export function mcpToolEffects(manifest: McpManifest | undefined, facts: McpToolFacts): McpToolEffects {
  if (manifest !== undefined && hasOwnTool(manifest.tools, facts.tool)) {
    const entry = manifest.tools[facts.tool];
    if (entry !== undefined) {
      return { effects: entry.effects, contexts: entry.contexts ?? manifest.contexts, shorthand: shorthandFor({ effects: entry.effects }), defaults: 'declared' };
    }
  }
  if (manifest !== undefined && manifest.toolDefaults === 'restrictive') return restrictive(manifest);
  const readOnly = facts.readOnly && !facts.destructive;
  const quiet = readOnly && facts.approval !== 'ask-every-call';
  // A `*` in a name would read as a pattern in a ceiling: such a name is never matched, whatever it says, so it gets the restrictive effects.
  const call = parseCapability({ verb: 'mcp', server: facts.server, tools: [facts.tool] }, { vocabulary: GATE_VOCABULARY_VERSION, mode: 'ceiling' });
  if (!call.ok || facts.server.includes('*') || facts.tool.includes('*')) return restrictive(manifest);
  const effects: readonly Capability[] = quiet ? [call.value] : [call.value, ceilingCapability({ verb: 'network', hosts: [legacyHost(facts.host)] })];
  return { effects: Object.freeze(effects), contexts: manifest?.contexts ?? defaultMcpContexts(facts.transport), shorthand: quiet ? 'read' : 'network', defaults: 'legacy' };
}

function restrictive(manifest: McpManifest | undefined): McpToolEffects {
  // An undeclared tool never runs when nobody is watching: only `interactive` survives from the server's contexts, whatever they name (D-06).
  const contexts = manifest === undefined || manifest.contexts.includes('interactive') ? (['interactive'] as const) : ([] as const);
  return { effects: RESTRICTIVE_EFFECTS, contexts, shorthand: shorthandFor({ effects: RESTRICTIVE_EFFECTS }), defaults: 'restrictive' };
}

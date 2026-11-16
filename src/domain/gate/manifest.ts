// Tool manifests v1 (GATE-02, D-05): what a built-in tool says it can do, and how the gate fills the concrete effects of one call from that call's input.
// Pure: no I/O, no clock, no vscode, no package. A manifest is a declaration in code, not a signed payload; the gate never trusts a field of a call that a
// manifest did not ask for, and a missing or wrongly typed input field is a refusal, never an empty or wildcard effect (T-70-17).
// Types are re-exported with `export type` so the relay's isolatedModules build can compile this folder unchanged (Pitfall 12).
import { GATE_CONTEXTS } from './bundle';
import type { GateContextName } from './bundle';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Fields, Parsed } from './shape';
import { CREDENTIAL_HANDLE_PATTERN, GATE_VOCABULARY_VERSION, isCapabilityVerb, parseCapability, parseHostPattern } from './vocabulary';
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
export const INPUT_AS = Object.freeze(['path', 'url-host', 'literal'] as const);
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
  ['paths', { list: true, as: ['path', 'literal'], probe: (index) => `probe${index}` }],
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

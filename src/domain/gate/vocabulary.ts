// Capability vocabulary v1 (GATE-01, D-03): the closed grammar every manifest, bundle, grant and decision record speaks.
// Pure: no I/O, no clock, no vscode, no package. Every input is checked in place and every unknown verb, field or version is refused with one plain
// reason from GATE_SHAPE_FAILURES, never ignored. Once a release ships a verb or field its meaning never changes in place: a change is a new
// vocabulary version added beside this one.
// Types are re-exported with `export type` so the relay's isolatedModules build can compile this folder unchanged (Pitfall 12).
import { normalizeRelative } from '../protectedPaths';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Fields, Parsed } from './shape';

export type { Parsed, Refusal, GateShapeFailure } from './shape';

export const GATE_VOCABULARY_VERSION = 1;

export const CAPABILITY_VERBS = Object.freeze([
  'read', 'plan', 'workspaceWrite', 'shell', 'network', 'mcp', 'send', 'publish', 'destroy', 'spawn', 'schedule', 'skill.write', 'spend',
  'useSecret', 'infer', 'gpu'
] as const);
export type CapabilityVerb = (typeof CAPABILITY_VERBS)[number];

/** `request` is a concrete call (no wildcard verbs or hosts); `ceiling` is a grant or bundle pattern (wildcards allowed where the grammar says so). */
export type CapabilityMode = 'request' | 'ceiling';

/** A project-relative POSIX glob (`*`, `**`, `?`, `[...]`, `{a,b}`), already normalised: no `./`, no `..`, no leading slash. */
export type PathPattern = string;

export type Capability =
  | { readonly verb: 'read'; readonly paths: readonly PathPattern[] }
  | { readonly verb: 'plan' };

export interface ParseOptions { readonly vocabulary: number; readonly mode: CapabilityMode }

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const PARENT_SEGMENT = /(?:^|[/{,])\.\.(?:$|[/},])/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

export function isCapabilityVerb(value: string): value is CapabilityVerb {
  return (CAPABILITY_VERBS as readonly string[]).includes(value);
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

function parseRead(value: Fields): Parsed<Capability> {
  const keys = checkKeys(value, '', ['verb', 'paths']);
  if (keys !== undefined) return keys;
  const paths = parseList(ownValue(value, 'paths'), childPath('', 'paths'), parsePathPattern);
  if (!paths.ok) return paths;
  return { ok: true, value: Object.freeze({ verb: 'read', paths: paths.value }) };
}

function parsePlan(value: Fields): Parsed<Capability> {
  const keys = checkKeys(value, '', ['verb']);
  if (keys !== undefined) return keys;
  return { ok: true, value: Object.freeze({ verb: 'plan' }) };
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
  switch (verb) {
    case 'read': return parseRead(value);
    case 'plan': return parsePlan(value);
    default: return refused('not-available-yet', 'verb');
  }
}

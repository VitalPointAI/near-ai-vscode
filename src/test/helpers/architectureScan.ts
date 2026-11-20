// The scanner behind src/test/architecture.test.ts (FND-09, D-45, ADR-001). It places every source file under src in a layer of the table in
// DEVELOPER-STRUCTURE section 1 (domain below the engines and hosts, below the editor, below the composition root) and lists what breaks the rules,
// one line per file and target, with no line numbers, so moving code inside a file does not churn the baseline.
// The regular expressions are copied from teamBoundaries.test.ts; importing that file would register its tests twice.
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

export type LayerName = 'root' | 'editor' | 'engine' | 'domain';

export interface LayerEntry { layer: LayerName; rank: number }

/** The layer of each top-level entry under src (src/test is not scanned). A new folder must be placed here before the test passes. */
export const LAYERS: Readonly<Record<string, LayerEntry>> = {
  'extension.ts': { layer: 'root', rank: 3 },
  services: { layer: 'editor', rank: 2 },
  agent: { layer: 'engine', rank: 1 },
  benchmark: { layer: 'engine', rank: 1 },
  gate: { layer: 'engine', rank: 1 },
  gsd: { layer: 'engine', rank: 1 },
  mcp: { layer: 'engine', rank: 1 },
  security: { layer: 'engine', rank: 1 },
  staff: { layer: 'engine', rank: 1 },
  team: { layer: 'engine', rank: 1 },
  domain: { layer: 'domain', rank: 0 }
};

const EDITOR_RANK = 2;
const TEST_FOLDER = 'test';

export interface Seam { from: string; target: string; typeOnly: boolean; reason: string }

/** The declared seams through which an engine may reach the editor (the rule src/test/teamBoundaries.test.ts already holds for src/gate and src/team). */
export const SEAMS: readonly Seam[] = [
  { from: 'gate', target: 'services/auth', typeOnly: true, reason: 'the type-only SecretStorageLike interface' },
  { from: 'gate', target: 'services/stateMirrorLock', typeOnly: false, reason: 'the shared mirror lock, which imports only Node modules' },
  { from: 'team', target: 'services/auth', typeOnly: true, reason: 'the type-only SecretStorageLike interface' },
  { from: 'team', target: 'services/stateMirrorLock', typeOnly: false, reason: 'the shared mirror lock, which imports only Node modules' }
];

export const ARCHITECTURE_RULES = ['upward-import'] as const;
export type ArchitectureRule = (typeof ARCHITECTURE_RULES)[number];

interface ImportRef { line: number; specifier: string; typeOnly: boolean }

// Every static import, re-export, dynamic import() and require() with a string specifier. Statements are matched from the start of a line, so a
// word in a comment is not an import. A multi-line import is read up to its `from`.
const STATIC_FORM = /^[ \t]*(import|export)[ \t]+(type[ \t]+)?[^;'"]*?\bfrom[ \t]*['"]([^'"\n]+)['"]/gm;
const SIDE_EFFECT_FORM = /^[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gm;
const CALL_FORM = /(?:^|[^\w.$])(?:import|require)[ \t]*\([ \t]*['"]([^'"\n]+)['"]/gm;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export function importsOf(text: string): ImportRef[] {
  const found: ImportRef[] = [];
  for (const match of text.matchAll(STATIC_FORM)) {
    found.push({ line: lineOf(text, match.index ?? 0), specifier: match[3] as string, typeOnly: match[2] !== undefined });
  }
  for (const match of text.matchAll(SIDE_EFFECT_FORM)) found.push({ line: lineOf(text, match.index ?? 0), specifier: match[1] as string, typeOnly: false });
  for (const match of text.matchAll(CALL_FORM)) found.push({ line: lineOf(text, match.index ?? 0), specifier: match[1] as string, typeOnly: false });
  return found;
}

/** The layer of a file or module path under src (forward slashes, e.g. domain/auth.ts or services/chat), or undefined when it has none. */
export function layerOf(file: string): LayerEntry | undefined {
  const first = file.split('/')[0] ?? '';
  if (first === TEST_FOLDER) return undefined;
  if (!file.includes('/')) return first.endsWith('.ts') ? layerEntry(first) : layerEntry(`${first}.ts`) ?? layerEntry(first);
  return first.endsWith('.ts') ? undefined : layerEntry(first);
}

function layerEntry(key: string): LayerEntry | undefined {
  return Object.prototype.hasOwnProperty.call(LAYERS, key) ? LAYERS[key] : undefined;
}

/** Top-level entries under src (folder names and .ts file names) that have no layer, sorted. src/test is not scanned and needs none. */
export function unplacedTopLevel(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry !== TEST_FOLDER && layerEntry(entry) === undefined).sort();
}

/** The module path under src an import resolves to (no extension), or undefined for a package or Node module. */
export function resolveTarget(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.(?:js|ts)$/, '');
}

function under(target: string, folder: string): boolean {
  return target === folder || target.startsWith(`${folder}/`);
}

function isSeam(file: string, target: string, typeOnly: boolean): boolean {
  const from = file.split('/')[0];
  return SEAMS.some((seam) => seam.from === from && seam.target === target && (!seam.typeOnly || typeOnly));
}

/** Whether an import from `file` to the module `target` goes up the layer table. */
function isUpward(file: string, target: string, typeOnly: boolean): boolean {
  const source = layerOf(file);
  if (source === undefined) return false;
  if (source.layer === 'domain') return !under(target, 'domain');
  const destination = layerOf(target);
  if (destination === undefined || destination.rank <= source.rank) return false;
  return !(source.layer === 'engine' && destination.rank === EDITOR_RANK && isSeam(file, target, typeOnly));
}

export interface ArchitectureFindings {
  /** One sorted list of lines per rule. */
  rules: Record<ArchitectureRule, string[]>;
  /** The line count (newline characters, what `wc -l` prints) of every scanned file. */
  sizes: Record<string, number>;
  /** Scanned files with no layer. */
  unplaced: string[];
  files: number;
}

function sortedUnique(lines: Iterable<string>): string[] {
  return [...new Set(lines)].sort();
}

function lineCount(text: string): number {
  let count = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count += 1;
  return count;
}

/** Every rule over a set of sources keyed by their path under src (forward slashes). */
export function findViolations(sources: ReadonlyMap<string, string>): ArchitectureFindings {
  const upward = new Set<string>();
  const sizes: Record<string, number> = {};
  const unplaced: string[] = [];
  for (const [file, text] of sources) {
    sizes[file] = lineCount(text);
    if (layerOf(file) === undefined) {
      unplaced.push(file);
      continue;
    }
    for (const ref of importsOf(text)) {
      const target = resolveTarget(file, ref.specifier);
      if (target !== undefined && isUpward(file, target, ref.typeOnly)) upward.add(`${file} -> ${target}`);
    }
  }
  return { rules: { 'upward-import': sortedUnique(upward) }, sizes, unplaced: unplaced.sort(), files: sources.size };
}

/** Every .ts file under `srcRoot` except the test folder, keyed by its path under srcRoot with forward slashes. */
export function sourcesUnder(srcRoot: string): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(srcRoot, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (relative !== TEST_FOLDER) walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        sources.set(relative, readFileSync(full, 'utf8'));
      }
    }
  };
  walk(srcRoot);
  return new Map([...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Scan every non-test source under `srcRoot`; fewer than `minimumFiles` files is an error (an empty scan proves nothing). */
export function scanArchitecture(srcRoot: string, minimumFiles: number): ArchitectureFindings {
  const sources = sourcesUnder(srcRoot);
  if (sources.size < minimumFiles) {
    throw new Error(`expected at least ${minimumFiles} source files under ${path.basename(srcRoot)}, found ${sources.size}: an empty scan proves nothing`);
  }
  return findViolations(sources);
}

export interface ArchitectureBaseline {
  rules: Partial<Record<string, string[]>>;
  fileSizes: Record<string, number>;
}

export interface BaselineComparison {
  /** Lines found today that the baseline does not hold, as "<rule>: <line>". These always fail. */
  added: string[];
  /** Baseline lines not found today (and frozen files that are gone), as "<rule>: <line>". They fail only when the baseline must be tight. */
  stale: string[];
}

/** Compare today's findings with the baseline for the given rules. */
export function compareWithBaseline(found: ArchitectureFindings, baseline: ArchitectureBaseline, rules: readonly ArchitectureRule[] = ARCHITECTURE_RULES): BaselineComparison {
  const added: string[] = [];
  const stale: string[] = [];
  for (const rule of rules) {
    const today = new Set(found.rules[rule]);
    const recorded = new Set(baseline.rules[rule] ?? []);
    for (const line of today) if (!recorded.has(line)) added.push(`${rule}: ${line}`);
    for (const line of recorded) if (!today.has(line)) stale.push(`${rule}: ${line}`);
  }
  return { added: added.sort(), stale: stale.sort() };
}

/** The baseline file text for today's findings: sorted lists per rule, two-space indent, trailing newline. */
export function baselineText(found: ArchitectureFindings): string {
  const rules: Record<string, string[]> = {};
  for (const rule of ARCHITECTURE_RULES) rules[rule] = sortedUnique(found.rules[rule]);
  return `${JSON.stringify({ rules, fileSizes: {} }, null, 2)}\n`;
}

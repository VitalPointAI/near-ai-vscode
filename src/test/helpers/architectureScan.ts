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

/** The files outside src/domain/gate that may import SCALE_PRESETS, each with its reason (REVIEW S7: one label ranking, no second evaluator). */
export const SCALE_PRESETS_ALLOWED: Readonly<Record<string, string>> = {
  'gate/host.ts': "failed-closed fallback: the gate's own presets when no policy can be read (GateHost)",
  'agent/gateLabels.ts': "failed-closed fallback: the gate's own presets when no policy can be read (agent label check)"
};

/** The one file that reads editor settings (D-45). */
export const SETTINGS_FILE = 'services/settings.ts';

/** A file above this many lines gives a warning. */
export const WARN_ABOVE = 800;
/** A file above this many lines fails unless the baseline froze it at its size; a frozen file may not grow (DEVELOPER-STRUCTURE section 1). */
export const FROZEN_ABOVE = 1200;

export const ARCHITECTURE_RULES = ['vscode-below-editor', 'upward-import', 'folder-cycle', 'scale-presets', 'get-configuration'] as const;
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

function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

const SCALE_PRESETS_WORD = /\bSCALE_PRESETS\b/;
const SCALE_PRESETS_PROPERTY = /\.[ \t]*SCALE_PRESETS\b/;
const GET_CONFIGURATION = /\bgetConfiguration[ \t]*\(/;

/** Whether a file names SCALE_PRESETS in an import or re-export statement, or reads it as a property of a namespace import or require(). */
function usesScalePresets(text: string): boolean {
  for (const match of text.matchAll(STATIC_FORM)) if (SCALE_PRESETS_WORD.test(match[0])) return true;
  return text.split('\n').some((line) => !isComment(line) && SCALE_PRESETS_PROPERTY.test(line));
}

function readsConfiguration(text: string): boolean {
  return text.split('\n').some((line) => !isComment(line) && GET_CONFIGURATION.test(line));
}

function folderOf(module: string): string {
  return module.split('/')[0] ?? '';
}

function isEngineFolder(folder: string): boolean {
  return folder.includes('.') ? false : layerEntry(folder)?.layer === 'engine';
}

export interface FileEdge { file: string; target: string }

/**
 * The file edges that lie on a cycle of engine folders, as "<file> -> <target folder>", sorted. The folder graph has one node per engine folder and
 * an edge for each file import from one engine folder to another; Tarjan's algorithm finds the strongly connected components, and every edge whose
 * two folders share a component of more than one folder is a line. Edges to the domain or the editor are not cycles here (the upward-import rule
 * covers the editor).
 */
export function foldersInCycles(edges: readonly FileEdge[]): string[] {
  const engineEdges = edges
    .map((edge) => ({ file: edge.file, from: folderOf(edge.file), to: folderOf(edge.target) }))
    .filter((edge) => edge.from !== edge.to && isEngineFolder(edge.from) && isEngineFolder(edge.to));
  const next = new Map<string, Set<string>>();
  for (const edge of engineEdges) {
    if (!next.has(edge.from)) next.set(edge.from, new Set());
    if (!next.has(edge.to)) next.set(edge.to, new Set());
    next.get(edge.from)?.add(edge.to);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const component = new Map<string, number>();
  let counter = 0;
  let components = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const to of next.get(node) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node) as number, low.get(to) as number));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node) as number, index.get(to) as number));
      }
    }
    if (low.get(node) === index.get(node)) {
      for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
        onStack.delete(member);
        component.set(member, components);
        if (member === node) break;
      }
      components += 1;
    }
  };
  for (const node of [...next.keys()].sort()) if (!index.has(node)) visit(node);
  return sortedUnique(engineEdges.filter((edge) => component.get(edge.from) === component.get(edge.to)).map((edge) => `${edge.file} -> ${edge.to}`));
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
  const vscodeBelow = new Set<string>();
  const upward = new Set<string>();
  const edges: FileEdge[] = [];
  const scalePresets = new Set<string>();
  const configuration = new Set<string>();
  const sizes: Record<string, number> = {};
  const unplaced: string[] = [];
  for (const [file, text] of sources) {
    sizes[file] = lineCount(text);
    const layer = layerOf(file);
    if (layer === undefined) {
      unplaced.push(file);
      continue;
    }
    for (const ref of importsOf(text)) {
      if (ref.specifier === 'vscode' && layer.rank < EDITOR_RANK) vscodeBelow.add(`${file} -> vscode`);
      const target = resolveTarget(file, ref.specifier);
      if (target === undefined) continue;
      if (isUpward(file, target, ref.typeOnly)) upward.add(`${file} -> ${target}`);
      edges.push({ file, target });
    }
    if (!under(file, 'domain/gate') && !Object.prototype.hasOwnProperty.call(SCALE_PRESETS_ALLOWED, file) && usesScalePresets(text)) scalePresets.add(file);
    if (file !== SETTINGS_FILE && readsConfiguration(text)) configuration.add(file);
  }
  return {
    rules: {
      'vscode-below-editor': sortedUnique(vscodeBelow),
      'upward-import': sortedUnique(upward),
      'folder-cycle': foldersInCycles(edges),
      'scale-presets': sortedUnique(scalePresets),
      'get-configuration': sortedUnique(configuration)
    },
    sizes,
    unplaced: unplaced.sort(),
    files: sources.size
  };
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
  /** Frozen files above their recorded size. These always fail. */
  grown: string[];
  /** Frozen files below their recorded size (the baseline can be lowered). They fail only when the baseline must be tight. */
  shrunk: string[];
  /** Files not frozen above FROZEN_ABOVE lines. These always fail. */
  tooLarge: string[];
  /** Files not frozen above WARN_ABOVE lines. A warning only. */
  warnings: string[];
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
  const grown: string[] = [];
  const shrunk: string[] = [];
  const tooLarge: string[] = [];
  const warnings: string[] = [];
  for (const [file, frozen] of Object.entries(baseline.fileSizes)) {
    const size = found.sizes[file];
    if (size === undefined) stale.push(`fileSizes: ${file}`);
    else if (size > frozen) grown.push(`${file}: ${size} lines, frozen at ${frozen}; move the part you change out first`);
    else if (size < frozen) shrunk.push(`${file}: ${size} lines, frozen at ${frozen}`);
  }
  for (const [file, size] of Object.entries(found.sizes)) {
    if (Object.prototype.hasOwnProperty.call(baseline.fileSizes, file)) continue;
    if (size > FROZEN_ABOVE) tooLarge.push(`${file}: ${size} lines, new file above 1,200`);
    else if (size > WARN_ABOVE) warnings.push(`${file}: ${size} lines, above ${WARN_ABOVE}`);
  }
  return { added: added.sort(), stale: stale.sort(), grown: grown.sort(), shrunk: shrunk.sort(), tooLarge: tooLarge.sort(), warnings: warnings.sort() };
}

/** The baseline file text for today's findings: sorted lists per rule, two-space indent, trailing newline. */
export function baselineText(found: ArchitectureFindings): string {
  const rules: Record<string, string[]> = {};
  for (const rule of ARCHITECTURE_RULES) rules[rule] = sortedUnique(found.rules[rule]);
  const fileSizes: Record<string, number> = {};
  for (const file of Object.keys(found.sizes).sort()) {
    const size = found.sizes[file] as number;
    if (size > FROZEN_ABOVE) fileSizes[file] = size;
  }
  return `${JSON.stringify({ rules, fileSizes }, null, 2)}\n`;
}

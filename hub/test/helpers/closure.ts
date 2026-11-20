import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The hub's import boundary (D-27), shared by test/workspace.test.ts and the Docker context test (32-17), so both apply the same rules.
//
// The hub may reuse only the extension's pure hub-side replica code: the HUB_SIDE list in src/test/replicaBoundaries.test.ts and everything those
// modules import, value or type-only. That list is read from the file's text at run time, never imported (importing a test file would register its
// tests, and it is CommonJS), so the hub boundary always follows the extension's list. The import scanner uses the same line rules as importsOf in
// that file; workspace.test.ts checks the regular expressions below still equal the ones there.
//
// Paths in the closure are files under src with forward slashes, e.g. domain/replica/entry.ts.

export const BOUNDARY_TEST = 'src/test/replicaBoundaries.test.ts';
const REPLICA = 'domain/replica';
const MIN_HUB_SIDE_ENTRIES = 20;

export interface ImportRef {
  line: number;
  specifier: string;
  typeOnly: boolean;
}

// Every static import, re-export, dynamic import() and require() with a string specifier. Statements are matched from the start of a line, so a
// word in a comment is not an import. A multi-line import is read up to its `from`.
export const STATIC_FORM = /^[ \t]*(import|export)[ \t]+(type[ \t]+)?[^;'"]*?\bfrom[ \t]*['"]([^'"\n]+)['"]/gm;
export const SIDE_EFFECT_FORM = /^[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gm;
export const CALL_FORM = /(?:^|[^\w.$])(?:import|require)[ \t]*\([ \t]*['"]([^'"\n]+)['"]/gm;
// The vendored Yjs bundle path in any spelling the line forms cannot see: path.join(..., 'vendor', 'yjs', ...) or a literal vendor/yjs.
export const VENDOR_FORM = /['"`]vendor['"`][ \t\n]*,[ \t\n]*['"`]yjs['"`]|vendor[\\/]+yjs/g;

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
  return found.sort((a, b) => a.line - b.line);
}

/** The HUB_SIDE entries parsed from the text of src/test/replicaBoundaries.test.ts. Throws when the list cannot be found or is too short to be it. */
export function parseHubSide(text: string): string[] {
  const start = text.search(/export\s+const\s+HUB_SIDE\b/);
  if (start < 0) throw new Error(`${BOUNDARY_TEST} no longer declares HUB_SIDE; the hub boundary cannot be read.`);
  const open = text.indexOf('[', text.indexOf('=', start));
  const close = text.indexOf('];', open);
  if (open < 0 || close < 0) throw new Error(`The HUB_SIDE list in ${BOUNDARY_TEST} could not be read.`);
  const body = text
    .slice(open + 1, close)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const entries = [...body.matchAll(/'([^'\n]+)'|"([^"\n]+)"/g)].map((match) => (match[1] ?? match[2]) as string);
  if (entries.length < MIN_HUB_SIDE_ENTRIES) {
    throw new Error(`The HUB_SIDE list in ${BOUNDARY_TEST} has ${entries.length} entries, fewer than ${MIN_HUB_SIDE_ENTRIES}; it was not read correctly.`);
  }
  return entries;
}

export function readHubSide(repoRoot: string): string[] {
  return parseHubSide(readFileSync(path.join(repoRoot, BOUNDARY_TEST), 'utf8'));
}

const stemOf = (file: string): string => file.replace(/\.ts$/, '');

export function isHubSide(hubSide: readonly string[], stem: string): boolean {
  return hubSide.some((entry) => (entry.endsWith('/') ? stem.startsWith(entry) : stem === entry));
}

function sourcesUnder(repoRoot: string, folder: string): string[] {
  const src = path.join(repoRoot, 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path.relative(src, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(src, ...folder.split('/')));
  return files.sort();
}

/** A file under src for an import target (a path under src without extension), or undefined. */
export function resolveUnderSrc(repoRoot: string, target: string): string | undefined {
  for (const candidate of [`${target}.ts`, `${target}/index.ts`]) {
    if (existsSync(path.join(repoRoot, 'src', ...candidate.split('/')))) return candidate;
  }
  return undefined;
}

const targetOf = (file: string, specifier: string): string => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
const isNodeBuiltin = (specifier: string): boolean => specifier.startsWith('node:');

export interface Closure {
  /** Every file reached, sorted. */
  files: string[];
  /** What the reached files import or name that a hub may not bundle: vscode, yjs, any package, the vendored Yjs path, a file outside src. */
  problems: string[];
}

/** The files under src that `start` reaches through relative imports, value and type-only, and what they reach that a hub may not bundle. */
export function closureOf(repoRoot: string, start: readonly string[]): Closure {
  const seen = new Set<string>(start);
  const stack = [...start];
  const problems: string[] = [];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    const text = readFileSync(path.join(repoRoot, 'src', ...file.split('/')), 'utf8');
    for (const ref of importsOf(text)) {
      const where = `src/${file}:${ref.line} ${ref.specifier}`;
      if (isNodeBuiltin(ref.specifier)) continue;
      if (!ref.specifier.startsWith('.')) {
        problems.push(`${where}  imports ${ref.specifier === 'vscode' ? 'the editor API' : ref.specifier === 'yjs' ? 'Yjs' : 'a package'}`);
        continue;
      }
      const target = targetOf(file, ref.specifier);
      if (target.startsWith('../') || target === '..') {
        problems.push(`${where}  leaves src`);
        continue;
      }
      const resolved = resolveUnderSrc(repoRoot, target);
      if (resolved === undefined) {
        problems.push(`${where}  resolves to no file`);
        continue;
      }
      if (!seen.has(resolved)) {
        seen.add(resolved);
        stack.push(resolved);
      }
    }
    for (const match of text.matchAll(VENDOR_FORM)) problems.push(`src/${file}:${lineOf(text, match.index ?? 0)} vendor/yjs  names the vendored Yjs path`);
  }
  return { files: [...seen].sort(), problems };
}

/** The hub-side modules and everything they import, value or type-only, as files under src. */
export function hubSideClosure(repoRoot: string): string[] {
  const hubSide = readHubSide(repoRoot);
  const start = sourcesUnder(repoRoot, REPLICA).filter((file) => isHubSide(hubSide, stemOf(file)));
  return closureOf(repoRoot, start).files;
}

/** The file under src an `@ext/...` specifier names, or undefined when it names none. */
export function extFileOf(repoRoot: string, specifier: string): string | undefined {
  if (!specifier.startsWith('@ext/')) return undefined;
  const target = path.posix.normalize(specifier.slice('@ext/'.length));
  if (target.startsWith('../') || target === '..') return undefined;
  return resolveUnderSrc(repoRoot, target);
}

export interface HubImportRules {
  /** The hub workspace folder. */
  hubRoot: string;
  repoRoot: string;
  /** The files under src that an @ext import may name. */
  allowedExt: ReadonlySet<string>;
}

/**
 * Violations in one hub file (absolute path) as "hub/file:line specifier  reason". Allowed: a node: builtin, a relative path that stays inside hub/,
 * and an @ext/ import of an allowed file. Everything else (vscode, yjs, any package, a bare builtin without node:, a relative path leaving hub/, an
 * @ext import of anything else) is reported.
 */
export function hubImportViolations(rules: HubImportRules, file: string, text: string): string[] {
  const relative = path.relative(rules.repoRoot, file).split(path.sep).join('/');
  const hubPrefix = `${path.resolve(rules.hubRoot)}${path.sep}`;
  const problems: string[] = [];
  for (const ref of importsOf(text)) {
    const where = `${relative}:${ref.line} ${ref.specifier}`;
    if (isNodeBuiltin(ref.specifier)) continue;
    if (ref.specifier.startsWith('@ext/')) {
      const target = extFileOf(rules.repoRoot, ref.specifier);
      if (target === undefined) problems.push(`${where}  names no file under src`);
      else if (!rules.allowedExt.has(target)) problems.push(`${where}  is not in the hub-side closure`);
      continue;
    }
    if (ref.specifier.startsWith('.')) {
      if (!path.resolve(path.dirname(file), ref.specifier).startsWith(hubPrefix)) problems.push(`${where}  leaves hub/`);
      continue;
    }
    if (ref.specifier === 'vscode') problems.push(`${where}  the hub may not import the editor API`);
    else if (ref.specifier === 'yjs') problems.push(`${where}  the hub may not import Yjs`);
    else problems.push(`${where}  the hub imports only node: builtins, no package`);
  }
  for (const match of text.matchAll(VENDOR_FORM)) problems.push(`${relative}:${lineOf(text, match.index ?? 0)} vendor/yjs  the hub may not name the vendored Yjs path`);
  return problems;
}

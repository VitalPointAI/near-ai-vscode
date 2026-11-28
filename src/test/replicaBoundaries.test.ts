// The import boundary of the replication core (D-01, D-17, T-30-44). src/domain/replica is pure domain code: it imports no editor API and no package,
// only doc.ts loads Yjs (a type-only import plus the vendor path), and the hub-side modules reach no other replica file, even through a type-only
// import, so the hub can compile them without Yjs. The scan is line based like src/test/teamBoundaries.test.ts, which it does not import (importing it
// would register its tests twice). The test reads the TypeScript sources under src (compiled tests run from dist/test, so the sources are found from
// the repository root).
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'src');
const REPLICA = 'domain/replica';
const DOC_FILE = 'domain/replica/doc.ts';

// The modules a hub compiles without Yjs (D-17): module paths under src without the extension. A folder entry (trailing slash) covers every file in it.
export const HUB_SIDE: readonly string[] = [
  'domain/replica/entry',
  'domain/replica/rosterView',
  'domain/replica/kinds',
  'domain/replica/kindSchemas/',
  'domain/replica/verify',
  'domain/replica/causal',
  'domain/replica/chain',
  'domain/replica/equivocation',
  'domain/replica/order',
  'domain/replica/checkpoint',
  'domain/replica/transport',
  'domain/replica/digest',
  'domain/replica/clientIds',
  'domain/replica/updateGuard',
  // The roster fold and its key modules (31-12): the hub folds the roster to know who may write, without Yjs. invite.ts derives the safety code
  // (31-16), so safetyCode and its word list (node:crypto and data only) are hub-side with it.
  'domain/replica/safetyCode', 'domain/replica/safetyWords',
  'domain/replica/roster',
  'domain/replica/rosterMembers',
  'domain/replica/rosterCells',
  'domain/replica/rotationProof',
  'domain/replica/rotationGrants',
  // Positions and postings (Phase 33.1): folded with the roster, so the hub judges posting writes with the same rule.
  'domain/replica/rosterPositions',
  'domain/replica/cellKeys',
  'domain/replica/invite',
  // The hub file, the session answer and the enrolment MAC (32-15): the hub signs and checks them, so they compile without Yjs.
  'domain/replica/hubFile',
  // The feature registry and id rule (POST-01, 33-18): the session answer signs a device's features, and the hub checks a project's required set
  // against the same registry it compiles, so features.ts is data and pure functions with no import.
  'domain/replica/features',
  // Session key certificates (Phase 33 D-62): the hub folds them with the roster and checks session writers with the same rules as every client.
  'domain/replica/sessionKeys',
  // Post-quantum cell keys (33.2): the v2 wrap, the device key binding the hub checks on append, and the grant pages the hub keeps and folds.
  'domain/replica/cellWrapV2', 'domain/replica/deviceKem', 'domain/replica/grantPages', 'domain/replica/wrapFormat'
];

interface ImportRef { line: number; specifier: string; typeOnly: boolean }

// Every static import, re-export, dynamic import() and require() with a string specifier. Statements are matched from the start of a line, so a
// word in a comment is not an import. A multi-line import is read up to its `from`.
const STATIC_FORM = /^[ \t]*(import|export)[ \t]+(type[ \t]+)?[^;'"]*?\bfrom[ \t]*['"]([^'"\n]+)['"]/gm;
const SIDE_EFFECT_FORM = /^[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gm;
const CALL_FORM = /(?:^|[^\w.$])(?:import|require)[ \t]*\([ \t]*['"]([^'"\n]+)['"]/gm;
// The vendored Yjs bundle path in any spelling the line forms cannot see: path.join(..., 'vendor', 'yjs', ...) or a literal vendor/yjs.
const VENDOR_FORM = /['"`]vendor['"`][ \t\n]*,[ \t\n]*['"`]yjs['"`]|vendor[\\/]+yjs/g;

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

function isNodeModule(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier);
}

function under(target: string, folder: string): boolean {
  return target === folder || target.startsWith(`${folder}/`);
}

function isHubSide(stem: string): boolean {
  return HUB_SIDE.some((entry) => (entry.endsWith('/') ? stem.startsWith(entry) : stem === entry));
}

const stemOf = (file: string): string => file.replace(/\.ts$/, '');
const targetOf = (file: string, specifier: string): string => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));

// Violations in one file's text, as "file:line specifier  reason". `file` is the path under src with forward slashes, e.g. domain/replica/doc.ts.
export function replicaBoundaryViolations(file: string, text: string): string[] {
  const problems: string[] = [];
  const isDoc = file === DOC_FILE;
  const hubSide = isHubSide(stemOf(file));
  let yjsImports = 0;
  for (const ref of importsOf(text)) {
    const where = `${file}:${ref.line} ${ref.specifier}`;
    if (ref.specifier === 'vscode') {
      problems.push(`${where}  src/domain/replica must not import vscode`);
    } else if (ref.specifier === 'yjs') {
      yjsImports += 1;
      if (!isDoc) problems.push(`${where}  only doc.ts may import yjs`);
      else if (!ref.typeOnly) problems.push(`${where}  the yjs import in doc.ts must be type-only (the code is loaded from the vendor bundle)`);
      else if (yjsImports > 1) problems.push(`${where}  doc.ts has more than one yjs import`);
    } else if (isNodeModule(ref.specifier)) {
      continue;
    } else if (!ref.specifier.startsWith('.')) {
      problems.push(`${where}  src/domain/replica may import only Node modules, no package`);
    } else {
      const target = targetOf(file, ref.specifier);
      if (!under(target, 'domain')) {
        problems.push(`${where}  src/domain/replica may not import ${target}`);
      } else if (hubSide && under(target, REPLICA) && !isHubSide(target)) {
        problems.push(`${where}  hub-side module may not reach ${target}, which a hub cannot compile without Yjs`);
      }
    }
  }
  if (!isDoc) {
    for (const match of text.matchAll(VENDOR_FORM)) problems.push(`${file}:${lineOf(text, match.index ?? 0)} vendor/yjs  only doc.ts may name the vendored Yjs path`);
  }
  return problems;
}

function sourcesUnder(folder: string): string[] {
  const root = path.join(SRC, ...folder.split('/'));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path.relative(SRC, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}

const read = (file: string): string => readFileSync(path.join(SRC, ...file.split('/')), 'utf8');

function resolveFile(target: string): string | undefined {
  for (const candidate of [`${target}.ts`, `${target}/index.ts`]) if (existsSync(path.join(SRC, ...candidate.split('/')))) return candidate;
  return undefined;
}

// Every file a hub must compile: the hub-side modules and everything they import, value or type-only, as files under src.
export function hubSideClosure(): string[] {
  const start = sourcesUnder(REPLICA).filter((file) => isHubSide(stemOf(file)));
  const seen = new Set<string>(start);
  const stack = [...start];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    for (const ref of importsOf(read(file))) {
      if (!ref.specifier.startsWith('.')) continue;
      const resolved = resolveFile(targetOf(file, ref.specifier));
      if (resolved !== undefined && !seen.has(resolved)) {
        seen.add(resolved);
        stack.push(resolved);
      }
    }
  }
  return [...seen].sort();
}

test('no file under src/domain/replica imports the editor API, a package, or anything outside src/domain', () => {
  const files = sourcesUnder(REPLICA);
  assert.ok(files.length >= 25, `expected at least 25 files under src/${REPLICA}, found ${files.length}: an empty scan proves nothing`);
  assert.deepEqual(files.flatMap((file) => replicaBoundaryViolations(file, read(file))), []);
});

test('only doc.ts has a yjs import, and it is the one type-only import', () => {
  const importing = sourcesUnder(REPLICA).filter((file) => importsOf(read(file)).some((ref) => ref.specifier === 'yjs'));
  assert.deepEqual(importing, [DOC_FILE]);
  const refs = importsOf(read(DOC_FILE)).filter((ref) => ref.specifier === 'yjs');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].typeOnly, true);
});

test('only doc.ts contains the vendor/yjs path segments, so a require(path.join(...)) form elsewhere is caught too', () => {
  const naming = sourcesUnder(REPLICA).filter((file) => new RegExp(VENDOR_FORM.source).test(read(file)));
  assert.deepEqual(naming, [DOC_FILE]);
});

test('the hub-side closure, following type-only imports too, contains no replica file that is not hub-side', () => {
  const hubFiles = sourcesUnder(REPLICA).filter((file) => isHubSide(stemOf(file)));
  assert.ok(hubFiles.length >= 20, `expected the hub-side modules and kindSchemas, found ${hubFiles.length}`);
  for (const entry of HUB_SIDE) {
    assert.ok(entry.endsWith('/') ? hubFiles.some((file) => file.startsWith(entry)) : hubFiles.includes(`${entry}.ts`), `${entry} is listed as hub-side but no such file exists`);
  }
  const closure = hubSideClosure();
  assert.deepEqual(closure.filter((file) => under(file, REPLICA) && !isHubSide(stemOf(file))), []);
  assert.deepEqual(closure.filter((file) => !under(file, 'domain')), []);
  // The closure follows imports across folders, so it also holds the pure domain files a hub copies along with the replica modules.
  assert.ok(closure.some((file) => file === 'domain/team/canonical.ts'));
  assert.ok(!closure.includes(DOC_FILE));
});

test('32-15: the hub file and session module is hub-side, and its closure reaches no Yjs, no doc.ts and nothing outside src/domain (D-27)', () => {
  const closure = hubSideClosure();
  assert.ok(closure.includes('domain/replica/hubFile.ts'), 'hubFile.ts is in the hub-side closure');
  assert.ok(isHubSide(stemOf('domain/replica/hubFile.ts')), 'hubFile is listed as hub-side');
  assert.ok(!closure.includes(DOC_FILE));
  assert.deepEqual(replicaBoundaryViolations('domain/replica/hubFile.ts', read('domain/replica/hubFile.ts')), []);
  assert.deepEqual(closure.filter((file) => importsOf(read(file)).some((ref) => ref.specifier === 'yjs')), []);
});

test('the scanner has teeth: an editor import, a package import, a second or value yjs import, the vendor path outside doc.ts and a hub-side import of fold.ts are all reported', () => {
  const found = (file: string, lines: string[]): string[] => replicaBoundaryViolations(file, lines.join('\n')).map((entry) => entry.split('  ')[0]);
  assert.deepEqual(found('domain/replica/planted.ts', [
    "import { ok } from './entry';",
    "import * as vscode from 'vscode';",
    "import { thing } from 'left-pad';",
    "import { createHash } from 'node:crypto';",
    "import { agent } from '../../agent/tools';",
    "import type * as Y from 'yjs';",
    "const lazy = await import('vscode');",
    "export { y } from '../../services/chat';"
  ]), [
    'domain/replica/planted.ts:2 vscode',
    'domain/replica/planted.ts:3 left-pad',
    'domain/replica/planted.ts:5 ../../agent/tools',
    'domain/replica/planted.ts:6 yjs',
    'domain/replica/planted.ts:7 vscode',
    'domain/replica/planted.ts:8 ../../services/chat'
  ]);
  // The one place a yjs import is allowed: doc.ts, once, type-only, with the vendor path.
  assert.deepEqual(found(DOC_FILE, ["import type * as YTypes from 'yjs';", "const bundle = require(path.join(__dirname, '..', '..', '..', 'vendor', 'yjs', 'yjs.cjs'));"]), []);
  assert.deepEqual(found(DOC_FILE, ["import type * as YTypes from 'yjs';", "import type { Doc } from 'yjs';"]), ['domain/replica/doc.ts:2 yjs']);
  assert.deepEqual(found(DOC_FILE, ["import * as Y from 'yjs';"]), ['domain/replica/doc.ts:1 yjs']);
  assert.deepEqual(found(DOC_FILE, ["import type * as YTypes from 'yjs';", "import { Doc } from 'yjs';"]), ['domain/replica/doc.ts:2 yjs']);
  // The vendor path outside doc.ts, in both spellings.
  assert.deepEqual(found('domain/replica/textFold.ts', ["const bundle = require(path.join(__dirname, '..', 'vendor', 'yjs', 'yjs.cjs'));"]), ['domain/replica/textFold.ts:1 vendor/yjs']);
  assert.deepEqual(found('domain/replica/textFold.ts', ["const bundle = require('../../../vendor/yjs/yjs.cjs');"]).includes('domain/replica/textFold.ts:1 vendor/yjs'), true);
  // A hub-side module reaching a file a hub cannot compile, by value or by type, and one that stays inside the hub-side set.
  assert.deepEqual(found('domain/replica/verify.ts', [
    "import { foldEntries } from './fold';",
    "import type { TextState } from './textFold';",
    "import type { Doc } from './doc';",
    "import { validateBody } from './kinds';",
    "import { validateDocData } from './kindSchemas/doc';",
    "import { canonicalBytes } from '../team/canonical';"
  ]), [
    'domain/replica/verify.ts:1 ./fold',
    'domain/replica/verify.ts:2 ./textFold',
    'domain/replica/verify.ts:3 ./doc'
  ]);
  assert.deepEqual(found('domain/replica/kindSchemas/planted.ts', ["import type { VerifiedEntry } from '../verify';", "import { applyUpdate } from '../doc';"]), ['domain/replica/kindSchemas/planted.ts:2 ../doc']);
  // A file that is not hub-side may import any other replica file.
  assert.deepEqual(found('domain/replica/fold.ts', ["import { applyUpdate } from './doc';", "import { verifyEntry } from './verify';"]), []);
});

test('comments that mention an import or the vendor path in prose are not imports', () => {
  const text = [
    "// this module never imports vscode, see import { x } from 'vscode' in the old code",
    ' * import * as vscode from \'vscode\';',
    "const note = 'x';"
  ].join('\n');
  assert.deepEqual(replicaBoundaryViolations('domain/replica/note.ts', text), []);
});

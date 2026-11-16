// The import boundary of the team core (D-18, TMR-02). src/domain/team is pure domain code and src/team is the headless team engine: neither may
// import vscode, neither may use a package outside Node, and src/team reaches the editor-side services only through the type-only SecretStorageLike
// from src/services/auth and the shared mirror lock src/services/stateMirrorLock (which itself imports only Node modules). The test reads the
// TypeScript sources under src (the compiled tests run from dist/test, so the sources are found from the repository root).
import assert from 'node:assert/strict';
import { builtinModules } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'src');
const DOMAIN_TEAM = 'domain/team';
const TEAM = 'team';
const LOCK_MODULE = 'services/stateMirrorLock';
const AUTH_MODULE = 'services/auth';

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

function isNodeModule(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier);
}

function under(target: string, folder: string): boolean {
  return target === folder || target.startsWith(`${folder}/`);
}

interface Rule { name: string; allows(target: string, typeOnly: boolean): boolean }

const RULES: Readonly<Record<string, Rule>> = {
  [DOMAIN_TEAM]: {
    name: 'src/domain/team',
    allows: (target) => under(target, DOMAIN_TEAM) || under(target, 'domain/redaction')
  },
  [TEAM]: {
    name: 'src/team',
    allows: (target, typeOnly) => under(target, TEAM) || under(target, 'domain')
      || (target === AUTH_MODULE && typeOnly) || target === LOCK_MODULE
  }
};

// Violations in one file's text, as "file:line specifier  reason". `file` is the path under src with forward slashes, e.g. team/gitTransport.ts.
export function boundaryViolations(file: string, text: string): string[] {
  const folder = file.startsWith(`${DOMAIN_TEAM}/`) ? DOMAIN_TEAM : TEAM;
  const rule = RULES[folder] as Rule;
  const problems: string[] = [];
  for (const ref of importsOf(text)) {
    const where = `${file}:${ref.line} ${ref.specifier}`;
    if (ref.specifier === 'vscode') {
      problems.push(`${where}  ${rule.name} must not import vscode`);
    } else if (isNodeModule(ref.specifier)) {
      continue;
    } else if (!ref.specifier.startsWith('.')) {
      problems.push(`${where}  ${rule.name} may import only Node modules, no package`);
    } else {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref.specifier));
      if (!rule.allows(target, ref.typeOnly)) {
        const hint = target === AUTH_MODULE ? ' (src/services/auth is allowed as a type-only import)' : '';
        problems.push(`${where}  ${rule.name} may not import ${target}${hint}`);
      }
    }
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

function scan(folder: string, minimumFiles: number): void {
  const files = sourcesUnder(folder);
  assert.ok(files.length >= minimumFiles, `expected at least ${minimumFiles} files under src/${folder}, found ${files.length}: an empty scan proves nothing`);
  const problems = files.flatMap((file) => boundaryViolations(file, readFileSync(path.join(SRC, file), 'utf8')));
  assert.deepEqual(problems, []);
}

test('no file under src/domain/team imports vscode, a package, or anything beyond itself and src/domain/redaction', () => {
  scan(DOMAIN_TEAM, 7);
});

test('no file under src/team imports vscode, a package, or a service other than the type-only auth import and the shared mirror lock', () => {
  scan(TEAM, 9);
});

test('src/services/stateMirrorLock.ts imports only Node modules, so the shared lock pulls no editor code into the team core', () => {
  const text = readFileSync(path.join(SRC, 'services', 'stateMirrorLock.ts'), 'utf8');
  const refs = importsOf(text);
  assert.ok(refs.length >= 1, 'the lock imports at least one Node module');
  assert.deepEqual(refs.filter((ref) => !isNodeModule(ref.specifier)).map((ref) => `${ref.line} ${ref.specifier}`), []);
});

test('the scanner has teeth: vscode, a package, an editor service and a value import of auth are all reported', () => {
  const planted = [
    "import * as vscode from 'vscode';",
    "import { thing } from 'left-pad';",
    "import { AuditStore } from '../services/auditStore';",
    "import { loginFlow } from '../services/auth';",
    "import type { SecretStorageLike } from '../services/auth';",
    "import { MirrorBusyError } from '../services/stateMirrorLock';",
    "import { x } from '../domain/team/types';",
    "const lazy = await import('vscode');",
    "const old = require('vscode');",
    "export { y } from '../services/chat';",
    "import {",
    "  a,",
    "  b",
    "} from '../services/spend';"
  ].join('\n');
  const found = boundaryViolations('team/planted.ts', planted).map((entry) => entry.split('  ')[0]);
  assert.deepEqual(found, [
    'team/planted.ts:1 vscode',
    'team/planted.ts:2 left-pad',
    'team/planted.ts:3 ../services/auditStore',
    'team/planted.ts:4 ../services/auth',
    'team/planted.ts:10 ../services/chat',
    'team/planted.ts:11 ../services/spend',
    'team/planted.ts:8 vscode',
    'team/planted.ts:9 vscode'
  ]);
  const domain = boundaryViolations('domain/team/planted.ts', [
    "import { ok } from './types';",
    "import { redactSecrets } from '../redaction';",
    "import { bad } from '../approval';",
    "import type { SecretStorageLike } from '../../services/auth';",
    "import { lock } from '../../services/stateMirrorLock';",
    "import * as fs from 'node:fs/promises';",
    "import { createHash } from 'crypto';"
  ].join('\n')).map((entry) => entry.split('  ')[0]);
  assert.deepEqual(domain, ['domain/team/planted.ts:3 ../approval', 'domain/team/planted.ts:4 ../../services/auth', 'domain/team/planted.ts:5 ../../services/stateMirrorLock']);
});

test('comments that mention an import are not imports', () => {
  const text = [
    "// this module never imports vscode, see import { x } from 'vscode' in the old code",
    " * import * as vscode from 'vscode';",
    "const note = 'x';"
  ].join('\n');
  assert.deepEqual(boundaryViolations('team/note.ts', text), []);
});

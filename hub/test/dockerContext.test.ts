import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hubSideClosure, replicaSideClosure } from './helpers/closure';
import { hubRoot } from './helpers/hubProcess';

// Phase 32, plan 17 (D-26, D-33): the root .dockerignore is the build context allow-list for both images. After '*' it lets in the relay's six
// lines, the hub's six lines and one '!src/...' line per file of the hub-side closure (helpers/closure.ts), and nothing else. The src lines are
// computed here from the tree, so a change to the closure fails this test until the list follows, and a file the app bundle really uses
// (dist/meta.json, written by scripts/build.mjs) can never be missing from the image build.

const HUB_ROOT = hubRoot();
const REPO_ROOT = path.dirname(HUB_ROOT);

export const RELAY_LINES = ['!relay/package.json', '!relay/package-lock.json', '!relay/.npmrc', '!relay/tsconfig.json', '!relay/scripts', '!relay/src'];
export const HUB_LINES = ['!hub/package.json', '!hub/package-lock.json', '!hub/.npmrc', '!hub/tsconfig.json', '!hub/scripts', '!hub/src'];
// Paths that must never enter a build context: service state and secret files, the hub's tests, git and planning files.
const NEVER_IN = ['relay/state', 'relay/secrets', 'relay/secrets/hub', 'hub/state', 'hub/secrets', 'hub/test', '.git', '.planning'];

function dockerignoreLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Why an allow-list line could let `target` (a path relative to the context root) into the build context, or undefined when it cannot. Only
 * literal '!path' lines are accepted: a pattern with a wildcard or a parent step is reported on its own, because it can match more than it says.
 */
export function letsIn(line: string, target: string): string | undefined {
  if (!line.startsWith('!')) return undefined;
  const pattern = line.slice(1).replace(/^\/+/, '').replace(/\/+$/, '');
  if (/[*?[\\]/.test(pattern) || pattern.split('/').includes('..') || pattern === '' || pattern === '.') return `${line} is not a literal path`;
  if (pattern === target || target.startsWith(`${pattern}/`) || pattern.startsWith(`${target}/`)) return `${line} lets in ${target}`;
  return undefined;
}

export function allowListProblems(lines: readonly string[]): string[] {
  const problems: string[] = [];
  for (const line of lines) {
    for (const target of NEVER_IN) {
      const why = letsIn(line, target);
      if (why !== undefined) problems.push(why);
    }
  }
  return [...new Set(problems)];
}

const closure = hubSideClosure(REPO_ROOT);
const lines = dockerignoreLines(readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8'));

test('the hub-side closure the image needs is at least the 40 files the plan was checked against, all under src/domain', () => {
  console.log(`hub-side closure: ${closure.length} files`);
  assert.ok(closure.length >= 40, `the closure has ${closure.length} files; it was not read correctly`);
  for (const file of closure) assert.ok(file.startsWith('domain/'), `${file} is outside src/domain`);
  for (const folder of ['staff/', 'services/', 'agent/']) {
    assert.ok(!closure.some((file) => file.startsWith(folder)), `the closure reaches src/${folder}, which the hub must never bundle`);
  }
  // Phase 71 (71-09): the hub checks credentials against your organization's signed rules, so the credential code (HUB_TRUST_SIDE) reaches the
  // pure policy readers under src/domain/gate/. The replica side still never does.
  const replica = replicaSideClosure(REPO_ROOT);
  assert.ok(!replica.some((file) => file.startsWith('domain/gate/')), 'the replica hub-side closure reaches src/domain/gate/, which it must never bundle');
});

test('.dockerignore is exactly *, the relay lines, the hub lines and one sorted src line per closure file', () => {
  const expected = ['*', ...RELAY_LINES, ...HUB_LINES, ...[...closure].sort().map((file) => `!src/${file}`)];
  assert.deepEqual(lines, expected, 'regenerate the !src/ lines of .dockerignore from hubSideClosure (one line per file, sorted)');
});

test('every input of the hub app bundle is a hub source or a closure file the allow-list lets in', () => {
  const meta = JSON.parse(readFileSync(path.join(HUB_ROOT, 'dist', 'meta.json'), 'utf8')) as { inputs: Record<string, unknown> };
  const inputs = Object.keys(meta.inputs);
  assert.ok(inputs.length > 0, 'dist/meta.json lists the bundle inputs');
  const allowed = new Set(lines.filter((line) => line.startsWith('!src/')).map((line) => line.slice('!src/'.length)));
  const extInputs = inputs.filter((input) => input.startsWith('../src/'));
  assert.ok(extInputs.length > 0, 'the app bundle uses extension files, so the check below has something to check');
  for (const input of inputs) {
    if (input.startsWith('src/')) continue;
    assert.ok(input.startsWith('../src/'), `bundle input ${input} is neither a hub source nor an extension file`);
    const file = input.slice('../src/'.length);
    assert.ok(allowed.has(file), `bundle input ${input} is not let in by .dockerignore, so the image build would fail`);
    assert.ok(closure.includes(file), `bundle input ${input} is outside the hub-side closure`);
  }
});

test('no .dockerignore line lets in service state or secrets, the hub tests, git or planning files', () => {
  assert.equal(lines[0], '*', 'the file starts by leaving everything out');
  assert.deepEqual(allowListProblems(lines), []);
  assert.ok(lines.slice(1).every((line) => line.startsWith('!')), 'after * every line lets a path in; a later exclusion would make the list hard to read');
});

test('the allow-list check reports wide, wildcard and secret lines (teeth)', () => {
  const planted = ['*', '!relay', '!hub', '!relay/secrets/hub', '!hub/test/helpers', '!src/**', '!.planning', '!hub/../relay/state', '!.git/config'];
  const problems = allowListProblems(planted);
  for (const line of planted.slice(1)) assert.ok(problems.some((problem) => problem.startsWith(`${line} `)), `the check missed ${line}`);
  assert.deepEqual(allowListProblems(['*', ...RELAY_LINES, ...HUB_LINES, '!src/domain/redaction.ts']), []);
});

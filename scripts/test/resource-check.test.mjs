// The compliance fit check (scripts/resource-check.mjs): every third-party resource needs a reviewed register entry before it is used.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { check, discover, knownIds, main } from '../resource-check.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'resource-check-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const entry = (id, kind, where, extra = {}) => ({
  id, kind, where, component: 'extension', scope: 'build', purpose: 'p', licence: 'MIT', controls: ['sa-15'], evidence: 'none', crypto: 'none',
  cveResponse: 'npm audit', airGap: 'ok', fit: 'pass', reviewer: 'r', reviewedAt: '2026-11-23', ...extra
});

const REPO = {
  'package.json': { devDependencies: { typescript: '5.9.3' } },
  'relay/Dockerfile': `FROM docker.io/library/node:26-slim@${DIGEST} AS build\nFROM build\n`,
  '.github/workflows/ci.yml': `jobs:\n  lint:\n    permissions:\n      statuses: read\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n      - uses: ./local-action\n`,
};
const CLEAN = [
  entry('npm:typescript', 'npm', ['package.json']),
  entry('image:docker.io/library/node', 'image', ['relay/Dockerfile'], { component: 'relay', fit: 'pass-with-conditions', conditions: ['Mirror it.'] }),
  entry('action:actions/checkout', 'action', ['.github/workflows/ci.yml'], { component: 'release-pipeline' }),
];
const run = (files, resources) => {
  const root = fixture(files);
  return check({ resources }, discover(root), { controls: new Set(['sa-15']), components: new Set(['extension', 'relay', 'release-pipeline']) });
};

test('a clean fixture passes: stage references, local actions and non-uses keys are not resources', () => {
  assert.deepEqual(run(REPO, CLEAN), []);
});

test('a resource with no register entry fails, naming where it is used', () => {
  const problems = run({ ...REPO, 'package.json': { dependencies: { leftpad: '1.0.0' }, devDependencies: { typescript: '5.9.3' } } }, CLEAN);
  assert.deepEqual(problems, ['npm:leftpad (used in package.json) has no entry in compliance/resources.json. Check its compliance fit and add an entry before using it.']);
});

test('a register entry nothing uses any more is stale and fails', () => {
  assert.match(run(REPO, [...CLEAN, entry('npm:gone', 'npm', ['package.json'])]).join('\n'), /npm:gone: nothing in the repository uses it any more/);
});

test('an entry whose fit is fail fails, and the check names the reason', () => {
  const problems = run(REPO, [entry('npm:typescript', 'npm', ['package.json'], { fit: 'fail', conditions: ['Unlicensed.'] }), ...CLEAN.slice(1)]);
  assert.match(problems.join('\n'), /npm:typescript: is marked fail.*Reason: Unlicensed\./);
});

test('pass-with-conditions needs conditions, and a runtime resource that needs the internet or unvalidated crypto cannot be a plain pass', () => {
  const [, image, action] = CLEAN;
  assert.match(run(REPO, [CLEAN[0], { ...image, conditions: [] }, action]).join('\n'), /pass-with-conditions but lists no conditions/);
  const runtime = { ...image, scope: 'runtime', fit: 'pass', conditions: undefined, airGap: 'needs-mirror:registry', crypto: 'unvalidated' };
  const problems = run(REPO, [CLEAN[0], runtime, action]).join('\n');
  assert.match(problems, /not ok air-gapped/);
  assert.match(problems, /unvalidated cryptography/);
});

test('missing or invalid fields, unknown controls and components, and an out-of-date where list fail', () => {
  const bad = { ...CLEAN[0], where: ['relay/package.json'], licence: '', controls: ['zz-99'], component: 'nowhere', reviewedAt: '23/11/2026', crypto: 'strong' };
  const problems = run(REPO, [bad, ...CLEAN.slice(1)]).join('\n');
  for (const expected of [/needs licence/, /control "zz-99" is not in the catalogues/, /component "nowhere"/, /reviewedAt must be a date/, /crypto must be/, /where lists relay\/package.json but it is used in package.json/]) {
    assert.match(problems, expected);
  }
});

test('an action not pinned to a full commit SHA, or an image without a digest, fails', () => {
  const files = { ...REPO, '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n', 'relay/Dockerfile': 'FROM docker.io/library/node:26-slim\n' };
  const problems = run(files, CLEAN).join('\n');
  assert.match(problems, /the action actions\/checkout@v7 is not pinned to a full 40-character commit SHA/);
  assert.match(problems, /the image docker.io\/library\/node:26-slim is not pinned by a sha256 digest/);
});

test('the repository itself passes the check, against the real catalogues and components', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  assert.ok(knownIds(root).controls.has('sr-03'), 'the control catalogues are loaded');
  const errors = [];
  const write = process.stderr.write;
  process.stderr.write = (text) => { errors.push(text); return true; };
  const stdout = process.stdout.write;
  process.stdout.write = () => true;
  try { assert.equal(main([], root), 0, errors.join('')); } finally { process.stderr.write = write; process.stdout.write = stdout; }
});

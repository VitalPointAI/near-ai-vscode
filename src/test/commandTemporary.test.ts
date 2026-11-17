// PR #74 review, round 1: a delete in the system's temporary folder is scratch work, not destruction, wherever that folder is. On macOS it is under
// /var/folders (and /private/var/folders, its real path), not /tmp. The caller hands the classifier the resolved temporary folders (os.tmpdir(), its real
// path, TMPDIR when set), so the pure classifier reads no environment for them. Nothing here runs a command, and every folder made is under the test run's
// own temporary folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyCommand } from '../agent/commandSafety';
import type { CommandContext } from '../agent/commandSafety';
import { floorFactsFor, systemTemporaryRoots } from '../agent/gateAdapter';

const MAC_TEMP = '/var/folders/ab/c1d2e3/T';
const context: CommandContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev', temporaryRoots: [MAC_TEMP, `/private${MAC_TEMP}`] };
const destroys = (command: string, extra: Partial<CommandContext> = {}): boolean =>
  (classifyCommand(command, { ...context, ...extra }).effects ?? []).some((effect) => effect.verb === 'destroy');

test('a delete inside a temporary folder the caller names is not destruction, by the folder as written or as it resolves', () => {
  for (const command of [`rm -rf ${MAC_TEMP}/build-1234`, `rm -r /private${MAC_TEMP}/x`, `rm ${MAC_TEMP}/notes.txt`, `rm -rf ${MAC_TEMP}/a ${MAC_TEMP}/b`]) {
    assert.equal(destroys(command), false, command);
  }
});

test('outside the named temporary folders, the folder itself, and a temporary folder that holds the project are still destruction', () => {
  for (const command of [`rm -rf ${MAC_TEMP}`, '/var/folders/ab/other', 'rm -rf /var/folders', `rm -rf ${MAC_TEMP}/../x`].map((text) => (text.startsWith('rm') ? text : `rm -rf ${text}`))) {
    assert.equal(destroys(command), true, command);
  }
  // The project inside the temporary folder: deleting it (or the folder above it) is destruction, deleting a neighbour is not.
  const inside = { root: `${MAC_TEMP}/project`, cwd: `${MAC_TEMP}/project` };
  assert.equal(destroys(`rm -rf ${MAC_TEMP}/project`, inside), true, 'the project itself');
  assert.equal(destroys(`rm -rf ${MAC_TEMP}/other-scratch`, inside), false, 'a neighbour in the temporary folder');
});

test('the classifier reads the temporary folders it is given, not the environment: /tmp is only temporary when named', () => {
  assert.equal(destroys('rm -rf /tmp/build-1234'), true, 'the caller named only the macOS folders');
  assert.equal(destroys('rm -rf /tmp/build-1234', { temporaryRoots: ['/tmp'] }), false);
  // With none given, the classifier keeps its old fallback (/tmp, /var/tmp and TMPDIR), as every caller that does not pass them always had.
  const { temporaryRoots: _given, ...fallback } = context;
  assert.equal(classifyCommand('rm -rf /tmp/build-1234', fallback).effects, undefined);
});

test('systemTemporaryRoots gives the temporary folder, its real path and TMPDIR, from a stand-in', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'near-ai-tmproots-'));
  const real = path.join(base, 'real-temp');
  mkdirSync(real);
  const link = path.join(base, 'linked-temp');
  symlinkSync(real, link);
  const roots = systemTemporaryRoots({ tmpdir: () => link, env: { TMPDIR: path.join(base, 'from-env') } });
  for (const expected of [link, realpathSync(real), path.join(base, 'from-env'), '/tmp']) assert.ok(roots.includes(expected), `${expected} in ${roots.join(', ')}`);
  assert.equal(new Set(roots).size, roots.length, 'each once');
  assert.ok(roots.every((root) => path.isAbsolute(root)));
});

test('the floor reads deletes in the stand-in temporary folder as scratch, and the real system folder by default', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'near-ai-tmpfloor-'));
  const root = path.join(base, 'project');
  mkdirSync(root);
  const standIn = path.join(base, 'stand-in-temp');
  const scratch = await floorFactsFor({ command: `rm -rf ${standIn}/build-1`, root, temporaryRoots: [standIn] });
  assert.deepEqual(scratch.effects, [], 'a delete in the stand-in temporary folder');
  const elsewhere = await floorFactsFor({ command: `rm -rf ${base}/elsewhere`, root, temporaryRoots: [standIn] });
  assert.ok(elsewhere.effects.some((effect) => effect.verb === 'destroy'), 'outside it');
  // By default the floor asks the system: os.tmpdir() here is the test run's own folder.
  const system = await floorFactsFor({ command: `rm -rf ${path.join(tmpdir(), 'near-ai-scratch-x')}`, root });
  assert.deepEqual(system.effects, [], 'a delete in the system temporary folder');
});

// PR #74 review round 4: the temporary folders are resolved once, not with four realpath calls on every shell call. The cache is asked again only when
// the temporary folder or TMPDIR it was worked out from changes; a test still hands in its own stand-in.
test('the temporary folders are worked out once and again only when the temporary folder or TMPDIR changes', async () => {
  const { temporaryRootsCache } = await import('../agent/gateAdapter');
  const env: Record<string, string | undefined> = { TMPDIR: '/stand-in/tmp-a' };
  let tmp = '/stand-in/os-tmp';
  let resolved = 0;
  const roots = temporaryRootsCache({ tmpdir: () => tmp, env, realpath: (folder: string) => { resolved += 1; return folder; } });
  const first = roots();
  for (let call = 0; call < 100; call += 1) assert.equal(roots(), first, 'the same answer, not worked out again');
  assert.equal(resolved, 4, 'four folders resolved once');
  assert.ok(first.includes('/stand-in/os-tmp') && first.includes('/stand-in/tmp-a'));
  env.TMPDIR = '/stand-in/tmp-b';
  assert.ok(roots().includes('/stand-in/tmp-b'), 'a new TMPDIR is seen');
  tmp = '/stand-in/os-tmp-2';
  assert.ok(roots().includes('/stand-in/os-tmp-2'), 'a new temporary folder is seen');
  assert.equal(resolved, 12, 'worked out once per change');
});

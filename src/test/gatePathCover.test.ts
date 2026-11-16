// A folder name in gate path matching covers everything under it (owner-confirmed 2026-11-16, PR #70 review): `src` covers `src/**`, as `src/` does, and
// never a sibling that only shares the prefix (`srcx/...`). The project root (`.`, `./`, `**`) is unchanged. A Glob or Grep given a folder names its contents,
// and the floor's protected-write check treats a folder that holds a protected place as that place.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { effectsOfCall, manifestArguments } from '../agent/gateAdapter';
import { CORE_TOOLS } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { bundleHash, defaultBundlePayload } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { decide } from '../domain/gate/decide';
import type { ActorRef, GateRequest, SettingsLayer } from '../domain/gate/decide';
import { floorFor, isFloorProtectedWrite } from '../domain/gate/floor';
import { contentsOf, coversPath } from '../domain/gate/pathCover';
import { globToRegExp } from '../domain/glob';
import type { Capability } from '../domain/gate/vocabulary';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: 'dev-00000000000000000000000000000000', sessionId: 'session-1', agentId: 'agent-1' };
const tool = (name: string): AgentTool<any> => CORE_TOOLS.find((candidate) => candidate.name === name) as AgentTool<any>;
const SHADOW = { floorMode: 'shadow' } as const;
const ROOT = path.join(tmpdir(), 'near-ai-gate-cover');

function validState(): BundleState {
  const payload = defaultBundlePayload({ issuer: { fingerprint: ACTOR.deviceFingerprint, publicKey: 'A'.repeat(43) }, now: NOW });
  return { state: 'valid', bundle: payload, hash: bundleHash(payload), signer: { fingerprint: ACTOR.deviceFingerprint, publicKey: 'A'.repeat(43) }, expiresAt: payload.expiresAt, renewDue: false };
}

function requestFor(effects: readonly Capability[], overrides: Partial<GateRequest> = {}): GateRequest {
  return { actor: ACTOR, tool: 'Tool', callId: 'call-1', effects, context: 'interactive', presence: 'person', policy: { mode: 'fully-autonomous', emergencyStop: false }, ...overrides };
}

const reads = (effects: readonly Capability[]): string[] => effects.flatMap((effect) => (effect.verb === 'read' ? [...effect.paths] : []));

test('a folder name covers everything under it and never a sibling that shares its prefix', () => {
  for (const folder of ['src', 'src/']) {
    assert.equal(coversPath(folder, 'src/a.ts'), true, `${folder} covers src/a.ts`);
    assert.equal(coversPath(folder, 'src/deep/b.ts'), true, `${folder} covers src/deep/b.ts`);
    assert.equal(coversPath(folder, 'src'), true, `${folder} covers itself`);
    assert.equal(coversPath(folder, 'src/'), true, `${folder} covers itself with a slash`);
    assert.equal(coversPath(folder, 'srcx/a.ts'), false, `${folder} does not cover srcx/a.ts`);
    assert.equal(coversPath(folder, 'srcx'), false, `${folder} does not cover srcx`);
    assert.equal(coversPath(folder, 'other/src/a.ts'), false, `${folder} is anchored at the project root`);
    assert.equal(coversPath(folder, 'sr'), false);
  }
  assert.equal(coversPath('src/deep', 'src/a.ts'), false, 'a deeper folder covers only its own contents');
  assert.equal(coversPath('src/deep', 'src/deep/b.ts'), true);
  assert.equal(coversPath('./src/./', 'src/a.ts'), true, 'the form is folded the way every other path is');
  // A glob keeps meaning what it says: `src/*.ts` is one level, and `src/**` is the folder's contents.
  assert.equal(coversPath('src/*.ts', 'src/a.ts'), true);
  assert.equal(coversPath('src/*.ts', 'src/deep/b.ts'), false);
  assert.equal(coversPath('src/**', 'src/deep/b.ts'), true);
  assert.equal(coversPath('src/**', 'srcx/a.ts'), false);
});

test('the project root is unchanged: `.`, `./`, an empty name and `**` cover everything, and `**` stays `**`', () => {
  for (const root of ['.', './', '', '**']) {
    assert.equal(contentsOf(root), '**', `contents of ${JSON.stringify(root)}`);
    assert.equal(coversPath(root, 'src/a.ts'), true, `${JSON.stringify(root)} covers a file`);
    assert.equal(coversPath(root, 'a.ts'), true);
  }
  assert.equal(contentsOf('src'), 'src/**');
  assert.equal(contentsOf('src/'), 'src/**');
  assert.equal(contentsOf('./src//deep'), 'src/deep/**');
  assert.equal(contentsOf('src/**'), 'src/**', 'a pattern that already says contents is left alone');
  assert.equal(contentsOf('src/*.ts'), 'src/*.ts', 'a glob is not turned into a folder');
  assert.equal(contentsOf('src/a.ts'), 'src/a.ts/**', 'a file name is a folder name too; it has no contents, so this covers nothing more');
  assert.equal(globToRegExp(contentsOf('src')).test('src/a.ts'), true);
});

test('a Glob or Grep given a folder names the folder and its contents; with no folder it names the whole project as before', () => {
  for (const name of ['Glob', 'Grep']) {
    const call = (raw: Record<string, unknown>): string[] => reads(effectsOfCall(SHADOW, tool(name), { pattern: 'x', ...raw }, ROOT));
    assert.deepEqual(call({ path: 'src' }), ['src', 'src/**'], `${name} src`);
    assert.deepEqual(call({ path: 'src/' }), ['src', 'src/**'], `${name} src/`);
    assert.deepEqual(call({ path: 'src/deep' }), ['src/deep', 'src/deep/**'], `${name} src/deep`);
    assert.deepEqual(call({ path: 'src/**' }), ['src/**'], `${name} src/**`);
    assert.deepEqual(call({ path: '**' }), ['**'], `${name} root as **`);
    assert.deepEqual(call({}), ['**'], `${name} no path`);
    assert.deepEqual(call({ path: '' }), ['**'], `${name} empty path`);
    assert.deepEqual(call({ path: '.' }), ['**'], `${name} root as .`);
    assert.deepEqual(call({ path: './' }), ['**'], `${name} root as ./`);
    assert.deepEqual(call({ path: path.join(ROOT, 'src') }), ['src', 'src/**'], `${name} absolute folder inside the project`);
    assert.deepEqual(call({ path: ROOT }), ['**'], `${name} the project folder itself`);
    // A folder outside the project is still refused, as is one that climbs out.
    assert.deepEqual(effectsFor(name, { pattern: 'x', path: '../elsewhere' }), undefined, `${name} outside`);
    assert.deepEqual(effectsFor(name, { pattern: 'x', path: path.join(ROOT, '..', 'elsewhere') }), undefined, `${name} absolute outside`);
  }
});

function effectsFor(name: string, raw: Record<string, unknown>): readonly Capability[] | undefined {
  // Enforced mode returns no effects for a call it cannot fill, which is what "refused" means here.
  const effects = effectsOfCall({ floorMode: 'enforce' }, tool(name), raw, ROOT);
  return effects.length === 0 ? undefined : effects;
}

test('manifestArguments writes an absolute folder relative to the project and the project root as `**`, and the manifest reads the contents from the same field', () => {
  const glob = tool('Glob');
  assert.deepEqual(manifestArguments(glob, { pattern: '*.ts' }, ROOT), { pattern: '*.ts', path: '**' });
  assert.deepEqual(manifestArguments(glob, { pattern: '*.ts', path: '.' }, ROOT), { pattern: '*.ts', path: '**' });
  assert.deepEqual(manifestArguments(glob, { pattern: '*.ts', path: path.join(ROOT, 'src') }, ROOT), { pattern: '*.ts', path: 'src' });
  assert.deepEqual(manifestArguments(glob, { pattern: '*.ts', path: '/' }, ROOT), { pattern: '*.ts', path: '/' }, 'the machine\'s root is not the project\'s');
  assert.deepEqual(reads(effectsOfCall(SHADOW, glob, { pattern: '*.ts', path: '/' }, ROOT)), ['**'], 'it is never read as the project root; shadow mode keeps today\'s widest stand-in');
  assert.equal(effectsFor('Glob', { pattern: '*.ts', path: '/' }), undefined, 'enforced, it is a call whose effects are unknown');
  assert.equal(effectsFor('Glob', { pattern: '*.ts', path: 'C:\\' }), undefined);
});

test('a call on `src` reaches decide() with effects a rule on `src/**` covers, and not one on `srcx/**`', async () => {
  let seen: readonly Capability[] = [];
  const spy: SettingsLayer = async (request) => { seen = request.effects; return { decision: 'allow', rule: 'settings.mode.fully-autonomous' }; };
  for (const name of ['Glob', 'Grep']) {
    const effects = effectsOfCall(SHADOW, tool(name), { pattern: 'x', path: 'src' }, ROOT);
    const decided = await decide(requestFor(effects, { tool: name }), validState(), spy, { floorMode: 'shadow' });
    assert.equal(decided.outcome, 'allow', name);
    const applies = (rule: string): boolean => seen.some((effect) => effect.verb === 'read' && effect.paths.some((shown) => globToRegExp(rule).test(shown)));
    assert.equal(applies('src/**'), true, `${name}: a rule on src/** applies to a call on src`);
    assert.equal(applies('srcx/**'), false, `${name}: a rule on srcx/** does not`);
    assert.equal(applies('docs/**'), false);
  }
});

test('a Glob or Grep on the key folder is still refused by the floor whether the folder or its contents is named', async () => {
  for (const name of ['Glob', 'Grep']) {
    const effects = effectsOfCall(SHADOW, tool(name), { pattern: 'x', path: '.near-ai/state/keys' }, ROOT);
    assert.deepEqual(reads(effects), ['.near-ai/state/keys', '.near-ai/state/keys/**']);
    const decided = await decide(requestFor(effects, { tool: name }), validState(), async () => ({ decision: 'allow', rule: 'settings.mode.fully-autonomous' }), { floorMode: 'shadow' });
    assert.equal(decided.outcome, 'deny', name);
    assert.equal(decided.rule, 'floor.state-keys', name);
  }
});

test('the floor treats a folder that holds a protected place as that place when it is written or destroyed', () => {
  const asks = (effect: Capability): boolean => floorFor({ effects: [effect] })?.rule === 'floor.protected-write';
  for (const folder of ['.planning', '.planning/', '.near-ai', '.near-ai/state', '.planning/.near-ai', '.git', 'vendor/mirror.git']) {
    assert.equal(asks({ verb: 'destroy', paths: [folder] }), true, `destroy ${folder}`);
    assert.equal(asks({ verb: 'workspaceWrite', paths: [folder] }), true, `write ${folder}`);
  }
  // Folders that hold nothing protected, a sibling that shares a prefix, the team file's exemption and the project root stay as they were.
  for (const folder of ['src', 'build/**', '.planning/phases', '.planningx', '.near-aix', '.near-ai/scratch', '.near-ai/attachments', '.planning/.near-ai/team.md', '**', '.']) {
    assert.equal(asks({ verb: 'destroy', paths: [folder] }), false, `destroy ${folder}`);
  }
  assert.equal(isFloorProtectedWrite('.planning'), true, 'the folder form is the same answer the path check gives');
  assert.equal(isFloorProtectedWrite('.planningx'), false);
  assert.equal(floorFor({ effects: [{ verb: 'read', paths: ['.planning'] }] }), undefined, 'a read of the folder is not a write');
});

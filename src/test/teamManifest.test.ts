// package.json contributions for Team Mode and their registration: both commands, the pollSeconds setting, and no new dependency.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
const barModule = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
test.after(() => { uninstall(); });

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  contributes: {
    commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
    configuration: { properties: Record<string, { type?: string; default?: unknown; minimum?: number; maximum?: number; scope?: string; description?: string }> };
  };
}

const ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;
const EM_DASH = '—';

test('package.json contributes Enable Team Mode and Verify Team Log under the NEAR AI category', () => {
  const byId = new Map(manifest.contributes.commands.map((entry) => [entry.command, entry]));
  const enable = byId.get('nearAi.team.enable');
  const verify = byId.get('nearAi.team.verifyLog');
  assert.deepEqual([enable?.title, enable?.category], ['Enable Team Mode', 'NEAR AI']);
  assert.deepEqual([verify?.title, verify?.category], ['Verify Team Log', 'NEAR AI']);
  assert.equal(commandsModule.ENABLE_COMMAND, 'nearAi.team.enable');
  assert.equal(commandsModule.VERIFY_LOG_COMMAND, 'nearAi.team.verifyLog');
  assert.equal(barModule.VERIFY_LOG_COMMAND, commandsModule.VERIFY_LOG_COMMAND, 'the status bar item points at the registered command');
});

test('nearAi.team.pollSeconds is a number 5..3600, default 15, application scope, with a plain description', () => {
  const setting = manifest.contributes.configuration.properties['nearAi.team.pollSeconds'];
  assert.ok(setting !== undefined, 'the setting is contributed');
  assert.equal(setting.type, 'number');
  assert.equal(setting.default, 15);
  assert.equal(setting.minimum, 5);
  assert.equal(setting.maximum, 3600);
  assert.equal(setting.scope, 'application', 'a repository cannot change how often clients poll its remote');
  assert.ok((setting.description ?? '').length > 0);
  assert.equal((setting.description ?? '').includes(EM_DASH), false);
});

test('the command titles and descriptions contain no em-dash', () => {
  const text = JSON.stringify(manifest.contributes.commands.filter((entry) => entry.command.startsWith('nearAi.team.')));
  assert.equal(text.includes(EM_DASH), false);
});

test('registerTeamMode registers every contributed nearAi.team command', async () => {
  const contributed = manifest.contributes.commands.map((entry) => entry.command).filter((id) => id.startsWith('nearAi.team.'));
  assert.deepEqual([...contributed].sort(), ['nearAi.team.enable', 'nearAi.team.verifyLog']);
  const context = createFakeContext(path.join(ROOT, 'does-not-exist'), {});
  const handle = commandsModule.registerTeamMode(context as never);
  await handle.ready;
  const registered = new Set(stub.commands.keys());
  assert.deepEqual(contributed.filter((id) => !registered.has(id)), [], 'contributed commands without a handler');
  for (const subscription of context.subscriptions) subscription.dispose();
  assert.equal(stub.commands.size, 0, 'disposing the context unregisters the commands');
});

test('package.json dependencies and devDependencies equal those at the merge base with main', (t) => {
  let base: string;
  let before: Manifest;
  try {
    base = execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    before = JSON.parse(execFileSync('git', ['show', `${base}:package.json`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as Manifest;
  } catch {
    // A checkout without a local main branch (for example a packaged or shallow copy) has no merge base to compare with.
    t.skip('no merge base with main is available in this checkout');
    return;
  }
  assert.deepEqual(manifest.dependencies, before.dependencies);
  assert.deepEqual(manifest.devDependencies, before.devDependencies);
});

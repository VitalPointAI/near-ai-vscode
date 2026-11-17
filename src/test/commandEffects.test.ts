// The shell classifier's effect tags (GATE-05, D-17, D-44, D-45, D-46): what a command publishes, destroys or writes in a protected place, in structure
// rather than in its reason's words (research 4.1), kept through every wrapper (Pitfall 2), and handed to the gate for every shell call in every mode
// (Pitfall 5). Nothing here runs a command: the classifier and the gate only read the command's text.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyCommand } from '../agent/commandSafety';
import type { CommandContext, CommandEffect } from '../agent/commandSafety';
import { gateToolCall } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { bashTool } from '../agent/tools';
import type { GateRuntime } from '../domain/gate/decide';
import { testGateRuntime } from './helpers/gatedRuns';

const context: CommandContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev' };
const classify = (command: string, extra: Partial<CommandContext> = {}) => classifyCommand(command, { ...context, ...extra });
const PUSH: CommandEffect = { verb: 'publish', target: 'git-remote' };

test('git push is tagged publish to a git remote, and its verdict and reason are what they were', () => {
  const result = classify('git push origin main');
  assert.equal(result.verdict, 'risky');
  assert.equal(result.reason, 'git push changes a remote repository');
  assert.deepEqual(result.effects, [PUSH]);
});

test('npm run of a script that pushes carries the push through, whatever the script is called', () => {
  const ship = classify('npm run ship', { packageScripts: { ship: 'git push' } });
  assert.equal(ship.verdict, 'risky');
  assert.equal(ship.reason, 'npm run ship looks like a publish, release, or deploy script');
  assert.deepEqual(ship.effects, [PUSH], 'the script body says where it publishes, so the tag is the same as git push');
  const named = classify('npm run sync', { packageScripts: { sync: 'git add -A && git push' } });
  assert.equal(named.verdict, 'risky');
  assert.equal(named.reason, 'npm run sync runs the "sync" script (git add -A && git push), and git push changes a remote repository');
  assert.deepEqual(named.effects, [PUSH]);
});

test('a command that does nothing of the kind has no effects', () => {
  for (const command of ['git status', 'npm test', 'ls -la', '']) assert.equal(classify(command).effects, undefined, command);
});

function project(): string {
  return mkdtempSync(path.join(tmpdir(), 'near-ai-effects-'));
}

test('the gate sees git push as a shadow publish in fully-autonomous, with a person or none, and decides exactly as today', async () => {
  const root = project();
  for (const presence of ['person', 'none'] as const) {
    const runtime: GateRuntime & { records: unknown[] } = testGateRuntime({ presence, context: presence === 'none' ? 'unattended' : 'interactive' });
    let asked = 0;
    for (const [command, scripts] of [['git push origin main', undefined], ['npm run ship', { ship: 'git push' }]] as const) {
      const gated = await gateToolCall(runtime, {
        tool: bashTool, raw: { command }, root, callId: `${presence}-${command}`, command,
        policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(),
        shell: { cwd: root, ...(scripts === undefined ? {} : { packageScripts: scripts }) },
        buildAuto: async () => { asked += 1; return undefined; }
      });
      assert.equal(gated.decision.outcome, 'allow', `${presence} ${command}: today's fully-autonomous allows it`);
      assert.equal(gated.decision.rule, 'settings.mode.fully-autonomous');
      assert.equal(gated.decision.floor, false);
      assert.equal(gated.decision.shadowFloor?.rule, 'floor.publish', `${presence} ${command}: the floor would ask`);
      assert.ok(gated.effects.some((effect) => effect.verb === 'publish' && effect.target === 'git-remote'), 'the request carries the tag');
      assert.equal(gated.effects[0]?.verb, 'shell', 'the manifest\'s own effect stays first, so the record names it as before');
    }
    assert.equal(asked, 2, 'the settings layer was asked as today');
  }
});

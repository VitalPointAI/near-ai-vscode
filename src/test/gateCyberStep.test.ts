// PR #74 review round 7: a step the cyber panel runs with a command is read by the floor the same way a chat's shell call is, through floorFactsFor, so
// a step whose command publishes or destroys asks with a person and is refused with nobody, in Full auto too. Before, gateStep never read the command, so
// its tags were missing. Nothing runs: the gate only decides, in a project under the test run's temporary folder.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gateStep } from '../agent/gateAdapter';
import type { Capability } from '../domain/gate/vocabulary';
import { testGateRuntime } from './helpers/gatedRuns';

const SHELL: Capability = { verb: 'shell', cwd: 'workspace' } as Capability;

test('a cyber step whose command pushes or deletes is a floor ask with a person and refused with nobody, in Full auto', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-cyberstep-'));
  for (const [command, rule] of [['git push origin main', 'floor.publish'], ['rm -rf src', 'floor.destroy']] as const) {
    for (const presence of ['person', 'none'] as const) {
      const runtime = testGateRuntime({ presence, context: presence === 'none' ? 'unattended' : 'interactive' });
      const gated = await gateStep(runtime, {
        tool: 'shell-step', callId: `${presence}-${command}`, effects: [SHELL], command, root, policy: { mode: 'fully-autonomous', emergencyStop: false },
        settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }
      });
      assert.equal(gated.decision.outcome, presence === 'person' ? 'ask' : 'deny', `${presence}: ${command}`);
      assert.equal(gated.decision.rule, rule, `${presence}: ${command}`);
      assert.ok(gated.effects.some((effect) => effect.verb === (rule === 'floor.publish' ? 'publish' : 'destroy')), 'the step carries the command\'s tag');
    }
  }
});

test('a cyber step whose command the floor cannot read whole has unknown effects, and a harmless one runs as before', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-cyberstep-'));
  const runtime = testGateRuntime({ presence: 'none', context: 'unattended' });
  const deep = await gateStep(runtime, {
    tool: 'shell-step', callId: 'deep', effects: [SHELL], command: `${'if '.repeat(10)}git push`, root, policy: { mode: 'fully-autonomous', emergencyStop: false },
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }
  });
  assert.equal(deep.decision.rule, 'manifest.effects-unknown');
  const plain = await gateStep(runtime, {
    tool: 'shell-step', callId: 'plain', effects: [SHELL], command: 'nmap -sV scanme.example', root, policy: { mode: 'fully-autonomous', emergencyStop: false },
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }
  });
  assert.notEqual(plain.decision.rule, 'manifest.effects-unknown');
  // A command with no folder to read it in cannot be read: its effects are unknown.
  const nowhere = await gateStep(runtime, {
    tool: 'shell-step', callId: 'nowhere', effects: [SHELL], command: 'git push', policy: { mode: 'fully-autonomous', emergencyStop: false },
    settings: { decision: 'allow', rule: 'settings.mode.fully-autonomous' }
  });
  assert.equal(nowhere.decision.outcome, 'deny');
});

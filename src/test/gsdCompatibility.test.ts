import assert from 'node:assert/strict';
import test from 'node:test';
import { selfTest } from '../gsd/runtime';
import { expandPrompt, loadAgents, loadSkills } from '../gsd/library';

// Compatibility with a real Open-GSD release. Opt-in: set NEAR_GSD_HOME to an installed Claude
// runtime (npx @opengsd/gsd-core@<version> --claude --global with CLAUDE_CONFIG_DIR=<dir>).
// Run it against each new Open-GSD release before relying on it.
const home = process.env.NEAR_GSD_HOME;

test('a real Open-GSD runtime passes the self-test and every skill and agent loads and expands', { skip: home ? false : 'set NEAR_GSD_HOME to an installed Open-GSD Claude runtime' }, async () => {
  const report = await selfTest(home!);
  assert.deepEqual(report.problems, []);
  const skills = await loadSkills(home!);
  const agents = await loadAgents(home!);
  assert.ok(skills.length > 0 && agents.length > 0);
  for (const skill of skills) {
    assert.ok(skill.name && skill.description, `${skill.file} has a name and description`);
    const expanded = await expandPrompt(skill.body, { args: 'test-args', home: home!, root: process.cwd() });
    assert.doesNotMatch(expanded, /\[include not found: [~/]/, `${skill.name}: every runtime include resolves`);
  }
  for (const agent of agents) {
    assert.ok(agent.name && agent.body.trim(), `${agent.file} has a name and instructions`);
    const expanded = await expandPrompt(agent.body, { home: home!, root: process.cwd() });
    assert.doesNotMatch(expanded, /\[include not found: [~/]/, `${agent.name}: every runtime include resolves`);
  }
});

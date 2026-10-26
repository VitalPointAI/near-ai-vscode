import assert from 'node:assert/strict';
import test from 'node:test';
import { GSD_COMMANDS, searchGsdCommands } from '../domain/gsdCommands';

test('GSD command catalog exposes start, workflow, context, review, and management paths', () => {
  const categories = new Set(GSD_COMMANDS.map((command) => command.category));
  assert.deepEqual([...categories].sort(), ['Context', 'Manage', 'Review', 'Start', 'Workflow']);
  assert.ok(GSD_COMMANDS.some((command) => command.command === 'next'));
  assert.ok(GSD_COMMANDS.some((command) => command.command === 'execute-phase'));
  assert.ok(GSD_COMMANDS.some((command) => command.command === 'update'));
});

test('command discovery searches command, title, category, and description', () => {
  assert.deepEqual(searchGsdCommands('review').map((command) => command.command), ['progress', 'verify-work', 'code-review', 'audit-uat']);
  assert.ok(searchGsdCommands('context').some((command) => command.command === 'map-codebase' && command.category === 'Context'));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AGENT_DEFAULTS } from '../domain/agentDefaults';
import { DEFAULT_ROLE_MODELS } from '../gsd/library';

// The defaults users see in Settings (package.json) are the ones the code and the live tests use.

test('package.json declares the same agent defaults the code and the live tests use', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const configuration = pkg.contributes.configuration;
  const props = (Array.isArray(configuration) ? configuration[0] : configuration).properties as Record<string, { default: unknown }>;
  const expected: Record<string, unknown> = {
    'nearAi.agent.deepModel': AGENT_DEFAULTS.tiers.deep, 'nearAi.agent.standardModel': AGENT_DEFAULTS.tiers.standard, 'nearAi.agent.fastModel': AGENT_DEFAULTS.tiers.fast,
    'nearAi.agent.maxTurns': AGENT_DEFAULTS.maxTurns, 'nearAi.agent.maxParallelAgents': AGENT_DEFAULTS.maxParallelAgents,
    'nearAi.agent.maxRunCostUsd': AGENT_DEFAULTS.maxRunCostUsd, 'nearAi.agent.maxRunTokens': AGENT_DEFAULTS.maxRunTokens,
    'nearAi.agent.maxOutputTokens': AGENT_DEFAULTS.maxOutputTokens, 'nearAi.agent.approvalTimeoutMinutes': AGENT_DEFAULTS.approvalTimeoutMinutes,
    'nearAi.agent.roleModels': DEFAULT_ROLE_MODELS
  };
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(props[key]?.default, value, key);
});

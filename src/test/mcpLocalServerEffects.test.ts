// What a local add-on server may do, declared once (owner decision after PR #74). A trusted server that runs on this computer (a command, no web address)
// had every data-changing tool ask before every call in every mode, because what it reaches could not be named. The person can now declare, in the user
// setting `nearAi.mcp.localServerEffects`, what that server's tools may do: read, write inside the project on named paths, and reach named hosts. Nothing
// declared can take a call off the floor: publishing, deleting, sending and writes into `.git/`, `.planning/.near-ai/` or `.near-ai/` cannot be declared,
// and the floor still decides the effects that are. A declaration that does not parse is ignored with a warning, and the server keeps asking.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gateToolCall } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import type { AgentTool } from '../agent/tools';
import { parseMcpServerEffects } from '../domain/gate/manifest';
import type { McpConnection, McpServerConfig, McpToolInfo } from '../mcp/client';
import { mcpAgentTools, newServerManifest } from '../mcp/tools';
import { McpRegistry } from '../services/mcpRegistry';
import { testGateRuntime } from './helpers/gatedRuns';

const ROOT = mkdtempSync(path.join(tmpdir(), 'near-ai-mcp-local-'));
const UPDATE: McpToolInfo = { name: 'update', description: 'Update', inputSchema: { type: 'object' }, readOnly: false, destructive: false };
const connection = { connected: true, tools: [UPDATE], connect: async () => undefined, close: async () => undefined, call: async () => 'ok' } as unknown as McpConnection;
const local = (approval: McpServerConfig['approval'] = 'trusted'): McpServerConfig => ({ id: 'notes', name: 'Notes', transport: 'stdio', command: 'notes-server', args: [], approval });

test('a declaration parses into effects: read, writes on named project paths, and named hosts', () => {
  const parsed = parseMcpServerEffects(['read', { workspaceWrite: ['docs/**', 'notes/today.md'] }, { network: ['api.example.test'] }]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value : undefined, [
    { verb: 'read', paths: ['**'] }, { verb: 'workspaceWrite', paths: ['docs/**', 'notes/today.md'] }, { verb: 'network', hosts: ['api.example.test'] }
  ]);
});

test('anything else is refused, whole: the floor\'s kinds, protected places, the whole project, wildcards and loose shapes', () => {
  for (const value of [
    undefined, null, 'read', {}, [], ['write'], ['publish'], [{ destroy: ['docs/**'] }], [{ publish: ['registry'] }], [{ send: ['email'] }], [{ shell: ['anywhere'] }],
    [{ workspaceWrite: [] }], [{ workspaceWrite: '**' }], [{ workspaceWrite: ['**'] }], [{ workspaceWrite: ['*'] }], [{ workspaceWrite: ['.git/hooks/**'] }], [{ workspaceWrite: ['.git'] }],
    [{ workspaceWrite: ['**/.git/**'] }], [{ workspaceWrite: ['.planning/**'] }], [{ workspaceWrite: ['.near-ai/state/meta.json'] }], [{ workspaceWrite: ['{docs,.git}/**'] }],
    [{ workspaceWrite: ['[.]git/config'] }], [{ workspaceWrite: ['../outside/**'] }], [{ workspaceWrite: ['/etc/**'] }], [{ workspaceWrite: ['docs/**'], network: ['x.test'] }],
    [{ network: ['*'] }], [{ network: ['*.example.test'] }], [{ network: ['https://api.example.test'] }], [{ network: ['API.example.test'] }], [{ network: ['api.example.test:443'] }],
    ['read', 'read'], [{ network: ['a.test'] }, { network: ['a.test'] }], Array.from({ length: 40 }, () => 'read'), [{ workspaceWrite: Array.from({ length: 40 }, (_, i) => `d${i}/**`) }]
  ]) {
    const parsed = parseMcpServerEffects(value);
    assert.equal(parsed.ok, false, JSON.stringify(value));
    if (!parsed.ok) assert.ok(parsed.reason.length > 0);
  }
});

/** The gate's decision, with the tool's own hold (its risky hook, as the loop evaluates it) handed in. */
async function decideTool(tool: AgentTool<any>, mode: 'approve-risky' | 'mostly-autonomous' | 'auto' | 'fully-autonomous', presence: 'person' | 'none' = 'person', grants = new RunGrants()) {
  const risky = await tool.risky?.({ id: 'x' }, { root: ROOT } as never);
  return gateToolCall(testGateRuntime(presence === 'none' ? { presence, context: 'unattended' } : {}), {
    tool, raw: { id: 'x' }, root: ROOT, callId: `${tool.name}-${mode}-${presence}`, policy: { mode, emergencyStop: false }, rules: DEFAULT_RULES, grants,
    ...(risky ? { risky } : {}), buildAuto: async () => undefined
  });
}

test('until declared, a trusted local server\'s data-changing tool asks before every call in every mode, as before', async () => {
  const [tool] = mcpAgentTools(local(), connection, '');
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const) {
    const gated = await decideTool(tool!, mode);
    assert.equal(gated.decision.outcome, 'ask', mode);
    assert.equal(gated.decision.rule, 'manifest.effects-unknown', mode);
  }
});

test('once declared, its calls are decided by what was declared, like any tool whose effects are known', async () => {
  const declared = (value: unknown): AgentTool<any> => {
    const parsed = parseMcpServerEffects(value);
    assert.ok(parsed.ok);
    return mcpAgentTools({ ...local(), localEffects: parsed.value }, connection, '')[0]!;
  };
  const reads = declared(['read']);
  for (const mode of ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'] as const) assert.equal((await decideTool(reads, mode)).decision.outcome, 'allow', `reads, ${mode}`);
  const writes = declared([{ workspaceWrite: ['docs/**'] }]);
  assert.equal((await decideTool(writes, 'approve-risky')).decision.outcome, 'ask', 'a write asks in approve-risky, as an edit does');
  assert.equal((await decideTool(writes, 'mostly-autonomous')).decision.outcome, 'allow');
  assert.equal((await decideTool(writes, 'fully-autonomous')).decision.outcome, 'allow');
  const network = declared([{ network: ['api.example.test'] }]);
  assert.equal((await decideTool(network, 'approve-risky')).decision.outcome, 'ask');
  assert.equal((await decideTool(network, 'fully-autonomous')).decision.outcome, 'allow');
  assert.deepEqual(network.manifest.hosts, ['api.example.test']);
  // After the run read a credential file, a declared host is a way out: it asks (taint.credential-read); a declared read does not.
  const afterRead = new RunGrants();
  afterRead.noteCredentialRead('.env');
  assert.equal((await decideTool(network, 'fully-autonomous', 'person', afterRead)).decision.rule, 'taint.credential-read');
  assert.equal((await decideTool(reads, 'fully-autonomous', 'person', afterRead)).decision.outcome, 'allow');
  // Not trusted: the server's own setting still holds every data-changing call, whatever was declared.
  const asking = mcpAgentTools({ ...local('ask-for-changes'), localEffects: [{ verb: 'read', paths: ['**'] }] }, connection, '')[0]!;
  assert.equal((await decideTool(asking, 'fully-autonomous')).decision.outcome, 'ask');
  // A server added from this version on starts with every tool undeclared and restrictive: the server's declaration decides those tools too.
  const fresh = mcpAgentTools({ ...local(), manifest: newServerManifest('notes', 'stdio'), localEffects: [{ verb: 'read', paths: ['**'] }] }, connection, '')[0]!;
  assert.equal((await decideTool(fresh, 'approve-risky')).decision.outcome, 'allow');
  // A server with a web address keeps its own host: a declaration for it is not used.
  const remote = mcpAgentTools({ id: 'cat', name: 'Cat', transport: 'http', approval: 'trusted', localEffects: [{ verb: 'read', paths: ['**'] }] }, connection, 'cat.example.test')[0]!;
  assert.ok(remote.manifest.effects.some((effect) => 'verb' in effect && effect.verb === 'network'));
});

function memory(values: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(values));
  return { get: <T>(key: string) => map.get(key) as T | undefined, update: async (key: string, value: unknown) => { map.set(key, value); } };
}
const secrets = { get: async () => undefined, store: async () => undefined, delete: async () => undefined };

test('the registry reads the user setting for each local server; an invalid declaration is ignored with a warning and the server keeps asking', async () => {
  const stored = { 'nearAi.mcp.servers': [local()] };
  const enabled = { 'nearAi.mcp.enabled': ['notes'] };
  const good = new McpRegistry(memory(stored), memory(enabled), secrets, undefined, () => connection, () => ({ notes: ['read'] }));
  const { tools, problems } = await good.agentTools();
  assert.deepEqual(problems, []);
  assert.equal((await decideTool(tools[0]!, 'approve-risky')).decision.outcome, 'allow');
  for (const setting of [{ notes: [{ destroy: ['docs/**'] }] }, { notes: [{ workspaceWrite: ['.git/**'] }] }, { notes: 'read' }, 'nonsense']) {
    const bad = new McpRegistry(memory(stored), memory(enabled), secrets, undefined, () => connection, () => setting);
    const result = await bad.agentTools();
    if (typeof setting === 'object' && setting !== null) {
      assert.equal(result.problems.length, 1, JSON.stringify(setting));
      assert.match(result.problems[0]!, /nearAi\.mcp\.localServerEffects.*Notes.*ignored.*still ask/, JSON.stringify(setting));
    }
    assert.equal((await decideTool(result.tools[0]!, 'fully-autonomous')).decision.rule, 'manifest.effects-unknown', JSON.stringify(setting));
  }
  // A declaration for a server with a web address is ignored with a warning too.
  const remoteStored = { 'nearAi.mcp.servers': [{ id: 'notes', name: 'Notes', transport: 'http', approval: 'trusted' }] };
  const remote = new McpRegistry(memory(remoteStored), memory(enabled), secrets, undefined, () => connection, () => ({ notes: ['read'] }));
  const remoteResult = await remote.agentTools();
  assert.equal(remoteResult.problems.length, 1);
  assert.match(remoteResult.problems[0]!, /web address/);
});

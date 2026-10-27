import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentEvent, AgentRun, ApprovalRequest } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { validateServerUrl } from '../mcp/client';
import { grantsMcpTool, mcpToolName } from '../mcp/tools';
import { McpRegistry } from '../services/mcpRegistry';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// MCP connections through the vendored SDK client, against a real stdio test server.

const SERVER = path.join(__dirname, '..', '..', 'test', 'fixtures', 'mcp', 'server.mjs');

function memory() {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: unknown) => { values.set(key, value); }, values };
}
function secretStore() {
  const values = new Map<string, string>();
  return { get: async (key: string) => values.get(key), store: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); }, values };
}

async function registryWithServer(approval: 'ask-for-changes' | 'ask-every-call' | 'trusted' = 'ask-for-changes') {
  const global = memory();
  const workspace = memory();
  const secrets = secretStore();
  const registry = new McpRegistry(global, workspace, secrets, path.join(__dirname, '..', '..'));
  await registry.save({ id: 'distributor', name: 'Test Distributor', transport: 'stdio', command: process.execPath, args: [SERVER], approval }, { env: { STOCK: '17' } });
  return { registry, global, workspace, secrets };
}

test('a real stdio MCP server connects, lists its tools, and runs only with the configured environment', async () => {
  const { registry, secrets, global } = await registryWithServer();
  try {
    assert.deepEqual((await registry.agentTools()).tools, [], 'nothing is offered until the server is switched on for the project');
    await registry.setEnabledHere('distributor', true);
    const { tools, problems } = await registry.agentTools();
    assert.deepEqual(problems, []);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['mcp__distributor__fail', 'mcp__distributor__lookup_part', 'mcp__distributor__place_order']);
    const lookup = tools.find((tool) => tool.name === 'mcp__distributor__lookup_part')!;
    assert.equal(lookup.capability, 'read', 'a read-only tool follows the normal rules for reads');
    assert.equal(tools.find((tool) => tool.name === 'mcp__distributor__place_order')!.capability, 'network');
    const status = (await registry.status())[0];
    assert.deepEqual([status.state, status.enabledHere, status.hasSecrets.env, status.serverInfo], ['connected', true, ['STOCK'], 'test-distributor 1.0.0']);
    assert.ok(!JSON.stringify(global.values.get('nearAi.mcp.servers')).includes('17'), 'secret values are not in ordinary storage');
    assert.match([...secrets.values.values()][0], /"STOCK":"17"/);
  } finally {
    await registry.dispose();
  }
});

test('calls ask by the server\'s approval setting even in fully-autonomous mode; results are fenced and injections reported', async () => {
  const { registry } = await registryWithServer('ask-for-changes');
  await registry.setEnabledHere('distributor', true);
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-mcp-'));
  const shell = new ShellSession(root);
  try {
    const { tools } = await registry.agentTools();
    const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const turns: Array<ToolCall[] | string> = [[call('l1', 'mcp__distributor__lookup_part', { sku: 'SW-24' })], [call('o1', 'mcp__distributor__place_order', { sku: 'SW-24', quantity: 2 })], [call('f1', 'mcp__distributor__fail', {})], 'done'];
    let turn = 0;
    const client = { async *streamCompletion(): AsyncGenerator<CompletionEvent> { const next = turns[turn++]; yield { type: 'done', message: typeof next === 'string' ? { role: 'assistant', content: next } : { role: 'assistant', content: null, tool_calls: next }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
    const approvals: ApprovalRequest[] = [];
    const events: AgentEvent[] = [];
    const run = new AgentRun({ client, model: 'm', tools, context: { root, checkpoints: new RunCheckpoints('mcp'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async (request) => { approvals.push(request); return { decision: 'allow' }; }, emit: (event) => events.push(event) });
    const result = await run.run([{ role: 'user', content: 'quote it' } as AgentMessage], new AbortController().signal);
    const outputs = result.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
    assert.match(outputs[0], /<untrusted-content id="[0-9a-f]{8}" source="MCP Test Distributor · lookup_part">\nSW-24: 24-port switch, \$1,299, 17 in stock/);
    // The read-only lookup ran without asking; place_order changes data, and fail declares no read-only hint, so both asked.
    assert.deepEqual(approvals.map((request) => request.tool), ['mcp__distributor__place_order', 'mcp__distributor__fail']);
    assert.match(approvals[0].preview?.kind === 'note' ? approvals[0].preview.text : '', /Call place_order on Test Distributor\. These arguments are sent to that server:\n\{\n {2}"sku": "SW-24",\n {2}"quantity": 2\n\}/);
    assert.match(outputs[1], /WARNING: this content tells the reader to ignore its instructions/);
    assert.match(outputs[2], /Test Distributor reported an error from fail: backend unavailable/);
    assert.ok(events.some((event) => event.type === 'security' && event.kind === 'injection' && /MCP Test Distributor · place_order/.test(event.source)));
    const status = (await registry.status())[0];
    assert.deepEqual([status.calls, status.errors], [3, 1]);
    assert.ok(status.lastUsed);
  } finally {
    shell.dispose();
    await registry.dispose();
  }
});

test('a server that cannot start is reported, not fatal; removing a server deletes its secrets', async () => {
  const global = memory();
  const workspace = memory();
  const secrets = secretStore();
  const registry = new McpRegistry(global, workspace, secrets);
  await registry.save({ id: 'broken', name: 'Broken', transport: 'stdio', command: '/nonexistent/mcp-server', args: [], approval: 'ask-every-call' }, { env: { TOKEN: 'secret' } });
  await registry.setEnabledHere('broken', true);
  const { tools, problems } = await registry.agentTools();
  assert.deepEqual(tools, []);
  assert.match(problems[0], /MCP server Broken is unavailable, so its tools are not offered this time/);
  assert.equal((await registry.status())[0].state, 'error');
  await registry.remove('broken');
  assert.equal(secrets.values.size, 0);
  assert.deepEqual(registry.servers(), []);
  await assert.rejects(() => registry.save({ id: 'Bad Id', name: 'x', transport: 'http', approval: 'trusted' }, {}), /server id/);
});

test('tool grants and URL rules', () => {
  assert.equal(mcpToolName('xvantage', 'search products'), 'mcp__xvantage__search_products');
  assert.ok(grantsMcpTool(['mcp:xvantage'], 'mcp__xvantage__search_products'));
  assert.ok(grantsMcpTool(['mcp__context7__*'], 'mcp__context7__resolve'));
  assert.ok(!grantsMcpTool(['mcp:xvantage', 'Read'], 'mcp__other__x'));
  assert.equal(validateServerUrl('https://mcp.example.com/mcp'), undefined);
  assert.equal(validateServerUrl('http://localhost:3000/mcp'), undefined);
  assert.match(validateServerUrl('http://mcp.example.com')!, /must use https/);
});

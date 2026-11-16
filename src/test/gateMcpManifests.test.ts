// MCP server manifests (GATE-03, D-06, D-07, D-38): a server added from now on starts restrictive and labelled, one configured before has no manifest and behaves as
// it always did, the person can declare what each tool does, and the words on the MCP and Tools pages say so in a fixed order and always end with the sentence
// that this is a declaration NEAR AI cannot check.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpConnection, McpServerConfig, McpToolInfo } from '../mcp/client';
import { mcpToolCapability, mcpToolName } from '../mcp/tools';
import { mcpToolEffects, parseMcpManifest, RESTRICTIVE_EFFECTS } from '../domain/gate/manifest';
import { MANIFEST_IS_A_CLAIM_TEXT, RUNS_ON_THIS_MACHINE_TEXT } from '../domain/gate/words';
import { McpRegistry } from '../services/mcpRegistry';

const SERVERS_KEY = 'nearAi.mcp.servers';

const TOOLS: McpToolInfo[] = [
  { name: 'search', description: 'Search', inputSchema: { type: 'object' }, readOnly: true, destructive: false },
  { name: 'update', description: 'Update', inputSchema: { type: 'object' }, readOnly: false, destructive: false },
  { name: 'zeta', description: 'Another', inputSchema: { type: 'object' }, readOnly: false, destructive: false },
  { name: 'Search', description: 'Different by case', inputSchema: { type: 'object' }, readOnly: false, destructive: false }
];

function memory() {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: unknown) => { values.set(key, value); }, values };
}
function secretStore() {
  const values = new Map<string, string>();
  return { get: async (key: string) => values.get(key), store: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); }, values };
}

function fakeConnection(): McpConnection {
  return { connected: true, tools: TOOLS, serverInfo: 'fake 1.0', connect: async () => undefined, close: async () => undefined, call: async () => 'ok' } as unknown as McpConnection;
}

function registry() {
  const global = memory();
  return { registry: new McpRegistry(global, memory(), secretStore(), undefined, () => fakeConnection()), global };
}

const stdio = (id = 'local', approval: McpServerConfig['approval'] = 'ask-for-changes'): McpServerConfig => ({ id, name: 'Local server', transport: 'stdio', command: 'server', args: [], approval });
const remote = (id = 'catalog', approval: McpServerConfig['approval'] = 'ask-for-changes'): McpServerConfig => ({ id, name: 'Catalog', transport: 'http', approval });

async function connected(id: string, config: McpServerConfig, secrets: { url?: string } = {}) {
  const made = registry();
  await made.registry.save(config, secrets);
  await made.registry.setEnabledHere(id, true);
  await made.registry.connectServer(id);
  return made;
}

/** A server stored the way one configured before manifests existed is: with no manifest at all (D-38). */
function storeLegacy(global: ReturnType<typeof memory>, config: McpServerConfig) {
  const { manifest: _manifest, ...legacy } = config;
  global.values.set(SERVERS_KEY, [...(global.get<McpServerConfig[]>(SERVERS_KEY) ?? []).filter((server) => server.id !== config.id), legacy]);
}

const toolNamed = async (made: { registry: McpRegistry }, id: string, name: string) => {
  const { tools } = await made.registry.agentTools();
  const found = tools.find((tool) => tool.name === mcpToolName(id, name));
  assert.ok(found, `${name} is offered`);
  return found;
};

// ---- Task 1: restrictive for new servers, legacy for existing ones, the stdio label ----

test('a stdio server saved for the first time is stored with a restrictive manifest that only runs while the person is there (D-06)', async () => {
  const { registry: made, global } = registry();
  await made.save(stdio(), {});
  const stored = global.get<McpServerConfig[]>(SERVERS_KEY)![0];
  assert.deepEqual(stored.manifest, { manifestVersion: 1, server: 'local', runsOn: 'this-machine', hosts: [], credentials: [], contexts: ['interactive'], tools: {}, toolDefaults: 'restrictive' });
  assert.equal(parseMcpManifest(stored.manifest).ok, true, 'what is stored is a valid manifest');
  await made.save(remote(), { url: 'https://catalog.example.com' });
  const http = global.get<McpServerConfig[]>(SERVERS_KEY)!.find((server) => server.id === 'catalog')!;
  assert.deepEqual([http.manifest?.runsOn, http.manifest?.contexts, http.manifest?.toolDefaults], ['remote', ['interactive'], 'restrictive']);
});

test('an undeclared tool of a new stdio server carries the most restrictive effects, the shorthand network, and only the interactive context (T-70-30)', async () => {
  const made = await connected('local', stdio());
  for (const name of ['search', 'update']) {
    const tool = await toolNamed(made, 'local', name);
    assert.deepEqual(tool.manifest.effects, RESTRICTIVE_EFFECTS, `${name}: effects`);
    assert.equal(tool.capability, 'network', `${name}: shorthand`);
    assert.deepEqual(tool.manifest.contexts, ['interactive'], `${name}: contexts`);
    assert.equal(tool.manifest.runsOn, 'this-machine');
  }
});

test('the words of a new stdio server lead with where it runs, say it only runs while you are there, and end with the declaration sentence', async () => {
  const made = await connected('local', stdio());
  const [status] = await made.registry.status();
  assert.equal(status.manifestWords[0], RUNS_ON_THIS_MACHINE_TEXT);
  assert.equal(status.manifestWords[0], 'Runs on this machine with your permissions');
  assert.equal(status.manifestWords.at(-1), MANIFEST_IS_A_CLAIM_TEXT);
  assert.ok(status.manifestWords.includes('Runs only while you are there'));
  assert.ok(status.manifestWords.some((line) => /^Tools it does not list are treated as able to run commands/.test(line)));
  assert.equal(status.manifestWords.some((line) => line.includes('—')), false, 'no long dash');
});

test('a server configured before manifests existed has no manifest and decides exactly as it did, for a read-only and for a changing tool (D-38)', async () => {
  const { registry: made, global } = registry();
  for (const approval of ['ask-for-changes', 'ask-every-call', 'trusted'] as const) {
    for (const config of [stdio('local', approval), remote('catalog', approval)]) {
      storeLegacy(global, config);
      await made.setEnabledHere(config.id, true);
      const { tools } = await made.agentTools();
      const readOnly = tools.find((tool) => tool.name === mcpToolName(config.id, 'search'))!;
      const changing = tools.find((tool) => tool.name === mcpToolName(config.id, 'update'))!;
      // Today's split, written out: a read-only tool on a server not set to ask every call is a read, anything else is network.
      assert.equal(readOnly.capability, approval === 'ask-every-call' ? 'network' : 'read', `${config.id}/${approval}: read-only tool`);
      assert.equal(changing.capability, 'network', `${config.id}/${approval}: changing tool`);
      const facts = (tool: McpToolInfo) => ({ server: config.id, tool: tool.name, host: '', readOnly: tool.readOnly, destructive: tool.destructive, approval, transport: config.transport });
      assert.deepEqual(readOnly.manifest.effects, mcpToolEffects(undefined, facts(TOOLS[0])).effects);
      assert.deepEqual(changing.manifest.effects, mcpToolEffects(undefined, facts(TOOLS[1])).effects);
      assert.equal(mcpToolCapability(config, TOOLS[0], ''), readOnly.capability);
    }
  }
  const [status] = (await made.status()).filter((entry) => entry.config.id === 'local');
  assert.equal(status.config.manifest, undefined);
  assert.equal(status.manifestWords[0], RUNS_ON_THIS_MACHINE_TEXT);
  assert.equal(status.manifestWords.at(-1), MANIFEST_IS_A_CLAIM_TEXT);
});

test('editing a server keeps the manifest it has: a stored one stays, and one it never had is not invented', async () => {
  const { registry: made, global } = registry();
  await made.save(stdio(), {});
  const first = global.get<McpServerConfig[]>(SERVERS_KEY)![0].manifest;
  await made.save({ ...stdio(), name: 'Renamed', approval: 'trusted' }, {});
  assert.deepEqual(global.get<McpServerConfig[]>(SERVERS_KEY)![0].manifest, first, 'the page\'s save message carries no manifest, and the stored one survives');
  storeLegacy(global, stdio('old'));
  await made.save({ ...stdio('old'), name: 'Old, edited' }, {});
  assert.equal(global.get<McpServerConfig[]>(SERVERS_KEY)!.find((server) => server.id === 'old')!.manifest, undefined, 'a legacy server stays legacy when edited');
  await made.update('old', { approval: 'ask-every-call' });
  assert.equal(global.get<McpServerConfig[]>(SERVERS_KEY)!.find((server) => server.id === 'old')!.manifest, undefined);
});

test('a server moved from a remote address to a local command is only for runs where the person is there (D-06)', async () => {
  const { registry: made, global } = registry();
  await made.save(remote('moving'), { url: 'https://catalog.example.com' });
  await made.save({ ...stdio('moving') }, {});
  const manifest = global.get<McpServerConfig[]>(SERVERS_KEY)![0].manifest!;
  assert.deepEqual([manifest.runsOn, manifest.contexts], ['this-machine', ['interactive']]);
});

test('a damaged stored manifest never widens what a server may do: it reads as the restrictive one (T-70-31)', async () => {
  const { registry: made, global } = registry();
  await made.save(stdio(), {});
  const servers = global.get<McpServerConfig[]>(SERVERS_KEY)!;
  global.values.set(SERVERS_KEY, [{ ...servers[0], manifest: { manifestVersion: 1, server: 'local', toolDefaults: 'anything-goes', extra: true } }]);
  await made.setEnabledHere('local', true);
  await made.connectServer('local');
  const tool = await toolNamed({ registry: made }, 'local', 'search');
  assert.deepEqual(tool.manifest.effects, RESTRICTIVE_EFFECTS);
  assert.deepEqual(tool.manifest.contexts, ['interactive']);
});

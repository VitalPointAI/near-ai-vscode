// MCP server manifests (GATE-03, D-06, D-07, D-38): a server added from now on starts restrictive and labelled, one configured before has no manifest and behaves as
// it always did, the person can declare what each tool does, and the words on the MCP and Tools pages say so in a fixed order and always end with the sentence
// that this is a declaration SovAI cannot check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import type { McpConnection, McpServerConfig, McpToolInfo } from '../mcp/client';
import { mcpToolCapability, mcpToolName } from '../mcp/tools';
import { mcpToolEffects, parseMcpManifest, RESTRICTIVE_EFFECTS } from '../domain/gate/manifest';
import { MANIFEST_IS_A_CLAIM_TEXT, RUNS_ON_THIS_MACHINE_TEXT } from '../domain/gate/words';
import { DECLARE_FAILED_TEXT, McpDeclareRefused, McpRegistry, declareOrReport } from '../services/mcpRegistry';
import { buildToolsDirectory } from '../services/toolsDirectory';
import type { DirectoryInput } from '../services/toolsDirectory';

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
  // A server from before this version also has no tool approval on record (WP-GATE review round 1); its first connection records one.
  global.values.set('nearAi.mcp.toolsApprovedOnce', (global.get<string[]>('nearAi.mcp.toolsApprovedOnce') ?? []).filter((id) => id !== config.id));
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

// ---- Task 2: declare, contexts, words ----

test('declaring a tool as only reading makes it a call on the server and a read, and shows in the words and the page\'s choice', async () => {
  const made = await connected('local', stdio());
  await made.registry.declareMcpToolEffects('local', 'search', 'reads');
  const tool = await toolNamed(made, 'local', 'search');
  assert.deepEqual(tool.manifest.effects, [{ verb: 'mcp', server: 'local', tools: ['search'] }]);
  assert.equal(tool.capability, 'read');
  assert.deepEqual(tool.manifest.contexts, ['interactive'], 'still only while the person is there');
  const [status] = await made.registry.status();
  assert.equal(status.toolChoices.search, 'reads');
  assert.equal(status.toolChoices.update, 'unknown');
  assert.ok(status.manifestWords.includes('search: Only reads'));
  assert.equal(status.manifestWords.at(-1), MANIFEST_IS_A_CLAIM_TEXT);
  // The tool it did not declare stays restrictive.
  assert.deepEqual((await toolNamed(made, 'local', 'update')).manifest.effects, RESTRICTIVE_EFFECTS);
});

test('declaring a tool as changing data on the server adds the server\'s host, and names the shorthand network', async () => {
  const made = await connected('catalog', remote(), { url: 'https://Catalog.Example.com:8443/mcp' });
  await made.registry.declareMcpToolEffects('catalog', 'update', 'changes-remote');
  const tool = await toolNamed(made, 'catalog', 'update');
  assert.deepEqual(tool.manifest.effects, [{ verb: 'mcp', server: 'catalog', tools: ['update'] }, { verb: 'network', hosts: ['catalog.example.com'] }]);
  assert.equal(tool.capability, 'network');
  assert.equal(tool.manifest.runsOn, 'remote');
  const [status] = await made.registry.status();
  assert.equal(status.toolChoices.update, 'changes-remote');
  assert.ok(status.manifestWords.includes('update: Changes data on the server'));
  assert.ok(status.manifestWords.includes('Connects to catalog.example.com'));
});

test('declaring a tool as not known takes the declaration away, so the server\'s default for undeclared tools applies again', async () => {
  const made = await connected('local', stdio());
  await made.registry.declareMcpToolEffects('local', 'search', 'reads');
  await made.registry.declareMcpToolEffects('local', 'search', 'unknown');
  const tool = await toolNamed(made, 'local', 'search');
  assert.deepEqual(tool.manifest.effects, RESTRICTIVE_EFFECTS);
  const [status] = await made.registry.status();
  assert.equal(status.toolChoices.search, 'unknown');
  assert.deepEqual(status.config.manifest!.tools, {});
  assert.equal(status.config.manifest!.toolDefaults, 'restrictive', 'the default is unchanged by declaring and un-declaring');
});

test('the first declaration on a server with no manifest gives it toolDefaults legacy, so its other tools keep today\'s behaviour (D-38)', async () => {
  const { registry: made, global } = registry();
  storeLegacy(global, remote());
  await made.setEnabledHere('catalog', true);
  await made.connectServer('catalog');
  await made.declareMcpToolEffects('catalog', 'zeta', 'reads');
  const stored = global.get<McpServerConfig[]>(SERVERS_KEY)![0].manifest!;
  assert.equal(stored.toolDefaults, 'legacy');
  assert.deepEqual([stored.runsOn, Object.keys(stored.tools)], ['remote', ['zeta']]);
  const { tools } = await made.agentTools();
  const byName = (name: string) => tools.find((tool) => tool.name === mcpToolName('catalog', name))!;
  assert.equal(byName('zeta').capability, 'read', 'the declared tool');
  assert.equal(byName('search').capability, 'read', 'a read-only tool it did not declare is still a read, as before');
  assert.equal(byName('update').capability, 'network', 'a changing tool it did not declare is still network, as before');
  // Un-declaring on a server with no manifest has nothing to remove and does not invent a manifest.
  const other = registry();
  storeLegacy(other.global, remote());
  await other.registry.setEnabledHere('catalog', true);
  await other.registry.connectServer('catalog');
  await other.registry.declareMcpToolEffects('catalog', 'zeta', 'unknown');
  assert.equal(other.global.get<McpServerConfig[]>(SERVERS_KEY)![0].manifest, undefined);
});

test('a declaration for a tool the server does not list, a bad choice, an unknown server, or a server that is not connected is refused and nothing is stored (T-70-31)', async () => {
  const made = await connected('local', stdio());
  const before = JSON.stringify(made.global.get(SERVERS_KEY));
  await assert.rejects(() => made.registry.declareMcpToolEffects('local', 'delete_everything', 'reads'), /does not list a tool called delete_everything/);
  await assert.rejects(() => made.registry.declareMcpToolEffects('local', 'search', 'harmless' as never), /Choose what the tool does/);
  await assert.rejects(() => made.registry.declareMcpToolEffects('nobody', 'search', 'reads'), /No MCP server nobody/);
  await assert.rejects(() => made.registry.declareMcpToolEffects('local', '__proto__', 'reads'), /does not list a tool/);
  await made.registry.disconnect('local');
  await assert.rejects(() => made.registry.declareMcpToolEffects('local', 'search', 'reads'), /Connect it to see its tools/);
  assert.equal(JSON.stringify(made.global.get(SERVERS_KEY)), before);
});

test('a tool name with a * cannot be declared and stays treated as able to do anything', async () => {
  const made = registry();
  const wild: McpToolInfo = { name: 'wild*card', description: 'x', inputSchema: { type: 'object' }, readOnly: true, destructive: false };
  const reg = new McpRegistry(made.global, memory(), secretStore(), undefined, () => ({ connected: true, tools: [wild], connect: async () => undefined, close: async () => undefined, call: async () => '' } as unknown as McpConnection));
  await reg.save(stdio(), {});
  await reg.setEnabledHere('local', true);
  await reg.connectServer('local');
  await assert.rejects(() => reg.declareMcpToolEffects('local', 'wild*card', 'reads'), /name a declaration cannot hold/);
});

test('a tool is found by its exact name only: declaring search does not cover Search, and a tool switched off stays off even when declared (edge GATE-03)', async () => {
  const made = await connected('local', stdio());
  await made.registry.declareMcpToolEffects('local', 'search', 'reads');
  assert.deepEqual((await toolNamed(made, 'local', 'search')).manifest.effects, [{ verb: 'mcp', server: 'local', tools: ['search'] }]);
  const upper = (await made.registry.agentTools()).tools.find((tool) => tool.name === mcpToolName('local', 'Search'));
  // mcpToolName keeps case, so the two names are two different tools.
  assert.notEqual(mcpToolName('local', 'Search'), mcpToolName('local', 'search'));
  assert.deepEqual(upper!.manifest.effects, RESTRICTIVE_EFFECTS, 'a different case is a different, undeclared tool');
  await made.registry.update('local', { disabledTools: ['search'] });
  const names = (await made.registry.agentTools()).tools.map((tool) => tool.name);
  assert.equal(names.includes(mcpToolName('local', 'search')), false, 'switched off stays off although the manifest declares it');
  const [status] = await made.registry.status();
  assert.equal(status.toolChoices.search, 'reads', 'the declaration is kept for when it is switched on again');
});

test('a server\'s words come in a fixed order whatever order the tools were declared in (edge GATE-03 ordering)', async () => {
  const one = await connected('local', stdio());
  await one.registry.declareMcpToolEffects('local', 'zeta', 'changes-remote');
  await one.registry.declareMcpToolEffects('local', 'search', 'reads');
  await one.registry.declareMcpToolEffects('local', 'update', 'reads');
  const two = await connected('local', stdio());
  await two.registry.declareMcpToolEffects('local', 'update', 'reads');
  await two.registry.declareMcpToolEffects('local', 'search', 'reads');
  await two.registry.declareMcpToolEffects('local', 'zeta', 'changes-remote');
  const [a] = await one.registry.status();
  const [b] = await two.registry.status();
  assert.deepEqual(a.manifestWords, b.manifestWords);
  const toolLines = a.manifestWords.filter((line) => /^(search|update|zeta): /.test(line));
  assert.deepEqual(toolLines, ['search: Only reads', 'update: Only reads', 'zeta: Changes data on the server'], 'declared tools by name in sorted order');
  assert.equal(a.manifestWords[0], RUNS_ON_THIS_MACHINE_TEXT, 'where it runs first');
  assert.equal(a.manifestWords.at(-1), MANIFEST_IS_A_CLAIM_TEXT, 'the declaration sentence last');
  assert.ok(a.manifestWords.indexOf(toolLines[0]) < a.manifestWords.length - 1);
  assert.deepEqual(Object.keys(a.config.manifest!.tools), ['search', 'update', 'zeta'], 'stored in sorted order too');
});

test('a stdio server runs outside the interactive context only if its manifest names one, and its words then say it can run when nobody is watching', async () => {
  const { registry: made, global } = registry();
  await made.save(stdio(), {});
  const [quiet] = await made.status();
  assert.ok(quiet.manifestWords.includes('Runs only while you are there'));
  assert.equal(quiet.manifestWords.includes('Can also run when nobody is watching'), false);
  const servers = global.get<McpServerConfig[]>(SERVERS_KEY)!;
  global.values.set(SERVERS_KEY, [{ ...servers[0], manifest: { ...servers[0].manifest!, contexts: ['interactive', 'unattended'], toolDefaults: 'legacy', tools: { search: { effects: [{ verb: 'mcp', server: 'local', tools: ['search'] }] } } } }]);
  await made.setEnabledHere('local', true);
  await made.connectServer('local');
  const [named] = await made.status();
  assert.ok(named.manifestWords.includes('Can also run when nobody is watching'));
  assert.equal(named.manifestWords.at(-1), MANIFEST_IS_A_CLAIM_TEXT);
  assert.deepEqual((await toolNamed({ registry: made }, 'local', 'search')).manifest.contexts, ['interactive', 'unattended']);
  // An undeclared tool of that server still never runs when nobody is watching, whatever the server's contexts name.
  // The stored server as it is now, so its tool approval (recorded at its first connection, WP-GATE) is kept: a lost one would hold every tool.
  const current = global.get<McpServerConfig[]>(SERVERS_KEY)!;
  global.values.set(SERVERS_KEY, [{ ...current[0], manifest: { ...servers[0].manifest!, contexts: ['interactive', 'unattended'] } }]);
  assert.deepEqual((await toolNamed({ registry: made }, 'local', 'update')).manifest.contexts, ['interactive']);
});

test('a server set to ask before every call is never quieter than network, even for a tool declared as only reading', async () => {
  const made = await connected('local', stdio('local', 'ask-every-call'));
  await made.registry.declareMcpToolEffects('local', 'search', 'reads');
  const tool = await toolNamed(made, 'local', 'search');
  assert.equal(tool.capability, 'network');
  assert.ok(await tool.risky?.({}, {} as never), 'and the call still asks');
});

// ---- The pages ----

test('the Tools page directory carries each server\'s words and the status of a restrictive tool is the one network gives', async () => {
  const made = await connected('local', stdio());
  const servers = await made.registry.status();
  const directory = buildToolsDirectory({
    teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: false, securityConsented: true, mcp: servers,
    settings: { mainModel: 'm', tiers: { deep: 'm', standard: 'm', fast: 'm' }, roleModels: {}, visionModel: 'm', transcriptionModel: 'm', imageModel: 'm', safetyModel: 'm' }
  } as DirectoryInput);
  const entry = directory.mcp[0];
  assert.equal(entry.words[0], 'Runs on this machine with your permissions');
  assert.equal(entry.words.at(-1), MANIFEST_IS_A_CLAIM_TEXT);
  const search = entry.tools.find((tool) => tool.name === 'search')!;
  assert.notEqual(search.status, 'runs', 'a read-only hint no longer makes an undeclared tool of a new server run quietly');
  await made.registry.declareMcpToolEffects('local', 'search', 'reads');
  const after = buildToolsDirectory({
    teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: false, securityConsented: true, mcp: await made.registry.status(),
    settings: { mainModel: 'm', tiers: { deep: 'm', standard: 'm', fast: 'm' }, roleModels: {}, visionModel: 'm', transcriptionModel: 'm', imageModel: 'm', safetyModel: 'm' }
  } as DirectoryInput);
  assert.equal(after.mcp[0].tools.find((tool) => tool.name === 'search')!.status, 'runs', 'declared as only reading, it follows the normal rules for reads');
});

test('the MCP page sets everything a server provided with textContent, posts the declare message, and shows the claim sentence beside the choice (T-70-32)', () => {
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'mcp', 'mcp.js'), 'utf8');
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script), false, 'no markup is ever built from text');
  assert.match(script, /type: 'declare'/);
  assert.match(script, /manifestWords/);
  assert.match(script, /words\[words\.length - 1\]/, 'the last line of the words is the declaration sentence and sits beside the choice');
  const tools = readFileSync(path.join(__dirname, '..', '..', 'media', 'tools', 'tools.js'), 'utf8');
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(tools), false);
  assert.match(tools, /server\.words/);
});

test('the declare message is checked before the registry is called: a stored server, a short tool name and one of the three choices', () => {
  const view = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'mcpView.ts'), 'utf8');
  const at = view.indexOf("case 'declare'");
  assert.ok(at > 0, 'the message switch has a declare case');
  const block = view.slice(at, view.indexOf('case \'connect\'', at));
  assert.match(block, /!known/);
  assert.match(block, /typeof message\.tool !== 'string'/);
  assert.match(block, /MCP_DECLARE_CHOICES\.find/);
  assert.ok(block.indexOf('!known') < block.indexOf('declareMcpToolEffects'), 'validated before it is called');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// A declaration that fails is reported on the page and never rejects the message handler (PR #70 second review)

test('declareOrReport: a failure never rejects, shows the fixed sentence once, and never echoes the raw error text', async () => {
  const shown: string[] = [];
  await declareOrReport(async () => { throw new Error('write failed for token sk-live-0123456789 at /var/lib/private'); }, (text) => { shown.push(text); });
  assert.deepEqual(shown, [DECLARE_FAILED_TEXT]);
  assert.ok(!shown[0]?.includes('sk-live') && !shown[0]?.includes('/var'));
  await assert.doesNotReject(declareOrReport(async () => { throw new Error('x'); }, () => { throw new Error('the page is gone'); }), 'a message that cannot be shown changes nothing');
  const none: string[] = [];
  await declareOrReport(async () => undefined, (text) => { none.push(text); });
  assert.deepEqual(none, [], 'a declaration that worked shows nothing');
});

test('declareOrReport: a plain refusal of ours is shown as it is', async () => {
  const shown: string[] = [];
  await declareOrReport(async () => { throw new McpDeclareRefused('Catalog does not list a tool called x. Connect it to see its tools.'); }, (text) => { shown.push(text); });
  assert.deepEqual(shown, ['Catalog does not list a tool called x. Connect it to see its tools.']);
});

test('a real registry: a refused declaration shows its plain refusal, and a storage failure shows the fixed sentence with the stored servers unchanged', async () => {
  const { registry: reg, global } = await connected('catalog', remote(), { url: 'https://catalog.example/mcp' });
  const shown: string[] = [];
  await declareOrReport(() => reg.declareMcpToolEffects('catalog', 'no-such-tool', 'reads'), (text) => { shown.push(text); });
  assert.equal(shown.length, 1);
  assert.match(shown[0] as string, /does not list a tool called no-such-tool/);
  const tool = TOOLS[0] as McpToolInfo;
  const before = JSON.stringify(global.get(SERVERS_KEY));
  const update = global.update;
  global.update = async () => { throw new Error('EACCES: permission denied, open /var/lib/secret-state.json'); };
  shown.length = 0;
  await declareOrReport(() => reg.declareMcpToolEffects('catalog', tool.name, 'reads'), (text) => { shown.push(text); });
  global.update = update;
  assert.deepEqual(shown, [DECLARE_FAILED_TEXT]);
  assert.equal(JSON.stringify(global.get(SERVERS_KEY)), before);
});

test('the declare case of the MCP page routes the call through declareOrReport and posts the text as an error message, never a bare await', () => {
  const view = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'mcpView.ts'), 'utf8');
  const at = view.indexOf("case 'declare'");
  const block = view.slice(at, view.indexOf("case 'connect'", at));
  assert.match(block, /declareOrReport\(\(\) => mcp\.declareMcpToolEffects\(/);
  assert.match(block, /type: 'error', text/);
  assert.ok(!/await mcp\.declareMcpToolEffects/.test(block), 'no bare await of the registry call');
});

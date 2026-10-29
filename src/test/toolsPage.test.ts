import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { decidePermission, DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { CORE_TOOLS } from '../agent/tools';
import type { ActionPolicyMode } from '../domain/policy';
import { AuthService, SecretStorageLike } from '../services/auth';
import { deriveProfileId } from '../domain/auth';
import { ProfileStore } from '../services/profileStore';
import type { McpServerStatus } from '../services/mcpRegistry';
import { buildToolsDirectory, DirectoryInput, firstSentence, parseToolsPageMessage, skillGroup, ToolsDirectory, toolsPageHtml } from '../services/toolsDirectory';

// The NEAR AI Tools tab: a directory of what agents can use, replacing the old second chat page.

const MODES: ActionPolicyMode[] = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'];
const SCRIPT = path.join(__dirname, '..', '..', 'media', 'tools', 'tools.js');

const server = (overrides: Partial<McpServerStatus> = {}): McpServerStatus => ({
  config: { id: 'catalog', name: 'Catalog', transport: 'http', approval: 'ask-for-changes', disabledTools: ['drop'] },
  host: 'mcp.example.com', hasSecrets: { url: true, headers: [], env: [] }, enabledHere: true, state: 'connected', calls: 0, errors: 0,
  tools: [
    { name: 'search', description: 'Search the catalog. Returns items.', inputSchema: {}, readOnly: true, destructive: false },
    { name: 'update', description: 'Change an item.', inputSchema: {}, readOnly: false, destructive: true },
    { name: 'drop', description: 'Delete everything.', inputSchema: {}, readOnly: false, destructive: true }
  ],
  ...overrides
});

function input(overrides: Partial<DirectoryInput> = {}): DirectoryInput {
  return {
    gsd: {
      version: '1.40.0',
      skills: [
        { name: 'gsd-plan-phase', description: 'Plan a phase.', argumentHint: '<phase>' },
        { name: 'gsd-execute-phase', description: 'Execute a phase.' },
        { name: 'gsd-code-review', description: 'Review code.' },
        { name: 'gsd-new-project', description: 'Start a project.' },
        { name: 'gsd-map-codebase', description: 'Map it.' }
      ],
      agents: [
        { name: 'gsd-planner', description: 'Creates plans.', tools: ['Read', 'Write'], model: 'opus' },
        { name: 'gsd-phase-researcher', description: 'Researches.', tools: [], model: 'sonnet' },
        { name: 'gsd-verifier', description: 'Verifies.', tools: [] }
      ]
    },
    teams: [
      { file: '/s/teams/web.md', project: false, team: { slug: 'web', name: 'Web team', description: 'Builds pages', file: '/s/teams/web.md', members: [{ name: 'lead', role: 'planner', model: 'deep', tools: ['Read'], instructions: 'x' }, { name: 'dev', tools: ['Read', 'Edit'], instructions: 'y' }] } },
      { file: '/s/teams/broken.md', project: false, error: 'The team needs a name.' }
    ],
    policy: { mode: 'approve-risky', emergencyStop: false },
    rules: DEFAULT_RULES,
    webSearch: false,
    securityConsented: true,
    mcp: [server()],
    models: [
      { id: 'z-ai/glm-5.3', privacyBoundary: 'tee', contextLength: 200_000, inputPricePerMillion: 1.8, outputPricePerMillion: 5.75 },
      { id: 'deepseek/flash', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai', inputPricePerMillion: 0.3, outputPricePerMillion: 1.2 },
      { id: 'local/qwen', privacyBoundary: 'local' },
      { id: 'black-forest-labs/FLUX.2-klein-4B', privacyBoundary: 'tee', outputModalities: ['image'], imagePricePerUnit: 0.01 }
    ],
    settings: { mainModel: 'z-ai/glm-5.3', tiers: { deep: 'z-ai/glm-5.3', standard: 'deepseek/flash', fast: 'local/qwen' }, roleModels: { 'gsd-*-researcher': 'fast' }, visionModel: 'z-ai/glm-5.3', transcriptionModel: 'openai/whisper', imageModel: 'black-forest-labs/FLUX.2-klein-4B', safetyModel: 'local/qwen' },
    ...overrides
  };
}

test('the Tools page is a directory: no composer, messages, or second chat', async () => {
  const html = toolsPageHtml({ cspSource: 'vscode-webview://test', nonce: 'abc123nonce', script: 'tools.js', style: 'tools.css' });
  for (const id of ['messages', 'input', 'send', 'stop', 'model', 'attach', 'team-studio', 'fleet', 'history']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), `no #${id}`);
  assert.doesNotMatch(html, /<textarea|<style|\son[a-z]+=|unsafe-inline/);
  assert.match(html, /default-src 'none'/);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  assert.match(html, /<script nonce="abc123nonce" src="tools\.js">/);
  for (const heading of ['Skills &amp; workflows', 'Agents &amp; teams', 'Tools', 'MCP servers', 'Models']) assert.match(html, new RegExp(`<h2 id="[a-z]+-title">${heading}</h2>`));
  assert.match(html, /<input id="filter" type="search"[^>]*aria-label="[^"]+"/);
  // The page's script never sends chat turns.
  const script = await readFile(SCRIPT, 'utf8');
  assert.doesNotMatch(script, /type: ?'(?:send|open-command|steer|stop)'/);
});

test('the directory lists workflows, agents, teams, tools, MCP servers, and models from their sources', () => {
  const directory = buildToolsDirectory(input());
  assert.deepEqual(directory.gsd, { installed: true, version: '1.40.0' });
  assert.deepEqual(directory.skills.map((skill) => [skill.name, skill.group, skill.insert]), [
    ['gsd-plan-phase', 'Planning', '/gsd-plan-phase '], ['gsd-execute-phase', 'Execution', '/gsd-execute-phase '], ['gsd-code-review', 'Review and quality', '/gsd-code-review '], ['gsd-new-project', 'Project lifecycle', '/gsd-new-project '], ['gsd-map-codebase', 'Research and context', '/gsd-map-codebase ']
  ]);
  assert.equal(directory.skills[0].argumentHint, '<phase>');
  // Tier → model through the real mapping; a role setting wins over the definition's tier.
  assert.deepEqual(directory.agents.map((agent) => [agent.name, agent.tier, agent.model, agent.source]), [
    ['gsd-planner', 'deep', 'z-ai/glm-5.3', 'definition'], ['gsd-phase-researcher', 'fast', 'local/qwen', 'role setting'], ['gsd-verifier', 'inherit', 'z-ai/glm-5.3', 'default']
  ]);
  assert.equal(directory.teams.length, 1);
  assert.deepEqual(directory.teams[0].members.map((member) => [member.name, member.tier, member.model]), [['lead', 'deep', 'z-ai/glm-5.3'], ['dev', 'inherit', 'z-ai/glm-5.3']]);
  assert.equal(directory.teams[0].insert, '/team:web ');
  assert.match(directory.teamProblems[0], /broken\.md: The team needs a name/);
  // Every built-in tool a run is given, with its capability.
  const tools = new Map(directory.tools.map((tool) => [tool.name, tool]));
  for (const name of [...CORE_TOOLS.map((tool) => tool.name), 'WebFetch', 'WebSearch', 'CheckCitations', 'GenerateImage', 'SecurityScan', 'Remember', 'Recall', 'Skill', 'SlashCommand', 'AskUserQuestion', 'Agent', 'Task']) assert.ok(tools.has(name), `lists ${name}`);
  assert.equal(tools.get('Read')?.capability, 'read');
  assert.equal(tools.get('Edit')?.capability, 'edit');
  assert.equal(tools.get('Bash')?.capability, 'shell');
  assert.equal(tools.get('WebFetch')?.capability, 'network');
  assert.equal(tools.get('GenerateImage')?.capability, 'generate');
  assert.ok(!tools.get('Read')!.description.includes('\n') && tools.get('Read')!.description.length <= 240);
  // Off when not set up, with the existing setup command.
  assert.equal(tools.get('WebSearch')?.status, 'off');
  assert.deepEqual(tools.get('WebSearch')?.setup, { label: 'Set up web search', command: 'nearAi.setUpWebSearch' });
  assert.equal(tools.get('GenerateImage')?.status, 'asks');
  // MCP: read-only follows the normal rules; changes ask under "ask for changes"; switched-off tools are off.
  const mcp = directory.mcp[0];
  assert.deepEqual(mcp.tools.map((tool) => [tool.agentName, tool.status, tool.enabled]), [['mcp__catalog__search', 'runs', true], ['mcp__catalog__update', 'asks', true], ['mcp__catalog__drop', 'off', false]]);
  // Models: privacy, context, prices, and which settings use each.
  const models = new Map(directory.models.map((model) => [model.id, model]));
  assert.equal(models.get('z-ai/glm-5.3')?.privacy, 'tee');
  assert.equal(models.get('deepseek/flash')?.privacy, 'forwarded');
  assert.match(models.get('deepseek/flash')!.privacyText, /openrouter\.ai/);
  assert.equal(models.get('local/qwen')?.privacy, 'local');
  assert.equal(models.get('z-ai/glm-5.3')?.contextLength, 200_000);
  assert.equal(models.get('z-ai/glm-5.3')?.inputPerMillion, 1.8);
  assert.deepEqual(models.get('z-ai/glm-5.3')?.usedFor, ['main', 'deep', 'vision']);
  assert.deepEqual(models.get('local/qwen')?.usedFor, ['fast', 'safety']);
  assert.deepEqual(models.get('black-forest-labs/FLUX.2-klein-4B')?.kinds, ['image out']);
  assert.equal(directory.settingsModels.find((use) => use.use === 'transcription')?.available, false);
});

test('before Open-GSD is installed the core workflows show and the GSD tools are off', () => {
  const directory = buildToolsDirectory(input({ gsd: undefined, models: undefined, modelsProblem: 'Set up a profile.' }));
  assert.equal(directory.gsd.installed, false);
  assert.ok(directory.skills.some((skill) => skill.name === 'gsd-new-project' && skill.group === 'Project lifecycle'));
  assert.equal(directory.agents.length, 0);
  for (const name of ['Skill', 'Agent', 'Task']) assert.equal(directory.tools.find((tool) => tool.name === name)?.status, 'off');
  assert.equal(directory.models.length, 0);
  assert.equal(directory.modelsProblem, 'Set up a profile.');
  assert.equal(directory.settingsModels[0].available, undefined);
  assert.equal(directory.tools.find((tool) => tool.name === 'GenerateImage')?.status, 'off');
});

test('each tool\'s runs/asks column follows decidePermission in every approval mode, and the emergency stop', () => {
  for (const mode of MODES) {
    for (const stopped of [false, true]) {
      const policy = { mode, emergencyStop: stopped };
      const directory = buildToolsDirectory(input({ policy, webSearch: true }));
      assert.equal(directory.policy.mode, mode);
      assert.equal(directory.policy.stopped, stopped);
      const capabilityOf = new Map([...CORE_TOOLS].map((tool) => [tool.name, tool.capability]));
      for (const tool of directory.tools) {
        if (tool.status === 'off') continue;
        const capability = capabilityOf.get(tool.name) ?? ({ read: 'read', plan: 'plan', edit: 'workspaceWrite', shell: 'shell', network: 'network', generate: 'mediaGeneration' } as const)[tool.capability as 'read'];
        const decided = decidePermission(capability, undefined, policy, DEFAULT_RULES, new RunGrants());
        const expected = decided.decision === 'deny' ? 'stopped' : decided.decision === 'allow' ? 'runs' : capability === 'shell' && mode === 'auto' ? 'auto-checked' : 'asks';
        assert.equal(tool.status, expected, `${tool.name} under ${mode}${stopped ? ' (stopped)' : ''}`);
      }
      const by = (name: string) => directory.tools.find((tool) => tool.name === name)!.status;
      if (stopped) assert.ok(directory.tools.every((tool) => tool.status === 'stopped'), 'emergency stop blocks everything');
      else {
        assert.equal(by('Read'), 'runs');
        assert.equal(by('Edit'), mode === 'approve-risky' ? 'asks' : 'runs');
        assert.equal(by('Bash'), mode === 'fully-autonomous' ? 'runs' : mode === 'auto' ? 'auto-checked' : 'asks');
        assert.equal(by('WebFetch'), mode === 'fully-autonomous' ? 'runs' : 'asks');
        // An MCP tool that changes data asks under "ask for changes" even in full auto (it is flagged risky).
        assert.equal(directory.mcp[0].tools.find((tool) => tool.name === 'update')?.status, 'asks');
      }
    }
  }
  // MCP server off for this project: its tools are off.
  assert.ok(buildToolsDirectory(input({ mcp: [server({ enabledHere: false })] })).mcp[0].tools.every((tool) => tool.status === 'off'));
});

test('skill groups come from the words in the name', () => {
  assert.equal(skillGroup('gsd-discuss-phase'), 'Planning');
  assert.equal(skillGroup('gsd-verify-work'), 'Review and quality');
  assert.equal(skillGroup('gsd-autonomous'), 'Execution');
  assert.equal(skillGroup('gsd-complete-milestone'), 'Project lifecycle');
  assert.equal(skillGroup('gsd-settings'), 'Settings and workspace');
  assert.equal(skillGroup('something-new'), 'Other');
});

test('page messages are strictly validated', () => {
  assert.deepEqual(parseToolsPageMessage({ type: 'use-in-chat', text: '/gsd-plan-phase ' }), { type: 'use-in-chat', text: '/gsd-plan-phase ' });
  assert.equal(parseToolsPageMessage({ type: 'use-in-chat', text: '/gsd-plan-phase 1 && rm -rf /' }), undefined);
  assert.equal(parseToolsPageMessage({ type: 'use-in-chat', text: 'hello ' }), undefined);
  assert.deepEqual(parseToolsPageMessage({ type: 'run-command', command: 'nearAi.manageMcp' }), { type: 'run-command', command: 'nearAi.manageMcp' });
  assert.equal(parseToolsPageMessage({ type: 'run-command', command: 'workbench.action.terminal.sendSequence' }), undefined);
  assert.equal(parseToolsPageMessage({ type: 'run-command', command: 'nearAi.emergencyStop' }), undefined);
  assert.equal(parseToolsPageMessage({ type: 'open-setting', key: 'nearAi.agent.deepModel' })?.type, 'open-setting');
  assert.equal(parseToolsPageMessage({ type: 'open-setting', key: 'editor.fontSize' }), undefined);
  assert.equal(parseToolsPageMessage({ type: 'mcp-enable', id: 'catalog', enabled: true, extra: 1 }), undefined);
  assert.equal(parseToolsPageMessage({ type: 'set-action-policy', mode: 'fully-autonomous' }), undefined);
});

// A tiny DOM, enough to run the page's real script and press its buttons.
class Node_ {
  children: Node_[] = [];
  parent?: Node_;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, Array<() => void>>();
  hidden = false; id = ''; className = ''; type = ''; value = ''; title = '';
  private text = '';
  constructor(public tagName: string, private readonly doc: Doc) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: Array<Node_ | string>) { for (const node of nodes) { const child = typeof node === 'string' ? this.doc.createTextNode(node) : node; child.parent = this; this.children.push(child); } }
  replaceChildren() { this.children = []; this.text = ''; }
  after(node: Node_) { const siblings = this.parent!.children; node.parent = this.parent; siblings.splice(siblings.indexOf(this) + 1, 0, node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  click() { for (const listener of this.listeners.get('click') ?? []) listener(); }
  all(): Node_[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelector(selector: string) { return selector === '.item:not([hidden])' ? this.all().find((node) => node.className.split(' ').includes('item') && !node.hidden) : undefined; }
}
class Doc {
  body = new Node_('body', this);
  constructor() { for (const id of ['policy', 'filter', 'refresh', 'skills', 'agents', 'tools', 'mcp', 'models', 'elsewhere', 'empty-search']) { const node = new Node_('div', this); node.id = id; this.body.append(node); } }
  getElementById(id: string) { return this.body.all().find((node) => node.id === id); }
  createElement(tag: string) { return new Node_(tag, this); }
  createTextNode(text: string) { const node = new Node_('#text', this); node.textContent = text; return node; }
  querySelectorAll(selector: string) { const className = selector.slice(1); return this.body.all().filter((node) => node.className.split(' ').includes(className)); }
}

async function runPageScript(): Promise<{ doc: Doc; posts: Array<Record<string, unknown>>; dispatch(data: unknown): void }> {
  const doc = new Doc();
  const posts: Array<Record<string, unknown>> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const context = vm.createContext({ document: doc, window: { addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener) }, acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posts.push(message) }), setTimeout, String, Map, Boolean });
  vm.runInContext(await readFile(SCRIPT, 'utf8'), context, { timeout: 1000 });
  return { doc, posts, dispatch: (data) => listeners.forEach((listener) => listener({ data })) };
}

test('the page script renders the directory, searches it, and "Use in chat" asks for the prefill', async () => {
  const page = await runPageScript();
  const posts = () => JSON.parse(JSON.stringify(page.posts)) as Array<Record<string, unknown>>;
  assert.deepEqual(posts(), [{ type: 'ready' }]);
  page.dispatch({ type: 'directory', directory: buildToolsDirectory(input()) });
  assert.match(page.doc.getElementById('skills')!.textContent, /\/gsd-plan-phase.*<phase>.*Plan a phase\./);
  assert.match(page.doc.getElementById('tools')!.textContent, /Bash.*shell.*Asks you first/);
  assert.match(page.doc.getElementById('mcp')!.textContent, /mcp__catalog__update/);
  assert.match(page.doc.getElementById('models')!.textContent, /z-ai\/glm-5\.3.*TEE/);
  assert.match(page.doc.getElementById('policy')!.textContent, /Ask before edits/);
  const use = page.doc.body.all().find((node) => node.tagName === 'button' && node.getAttribute('aria-label') === 'Use /gsd-execute-phase in chat')!;
  use.click();
  assert.deepEqual(posts().at(-1), { type: 'use-in-chat', text: '/gsd-execute-phase ' });
  page.doc.body.all().find((node) => node.tagName === 'button' && node.getAttribute('aria-label') === 'Use /team:web in chat')!.click();
  assert.deepEqual(posts().at(-1), { type: 'use-in-chat', text: '/team:web ' });
  const filter = page.doc.getElementById('filter')!;
  filter.value = 'execute';
  for (const listener of filter.listeners.get('input') ?? []) listener();
  const items = page.doc.querySelectorAll('.item');
  assert.ok(items.filter((item) => !item.hidden).length >= 1);
  assert.ok(items.filter((item) => !item.hidden).every((item) => item.dataset.search.includes('execute')));
  filter.value = 'zzz-nothing';
  for (const listener of filter.listeners.get('input') ?? []) listener();
  assert.equal(page.doc.getElementById('empty-search')!.hidden, false);
});

test('the Elsewhere row links to the usage reporting token and asks the host to run its command', async () => {
  const { reportingTokenHint, SET_REPORTING_TOKEN_COMMAND, TOKEN_MISSING_TEXT, USE_NEAR_TOTAL_SETTING } = await import('../services/reportingToken');
  const page = await runPageScript();
  page.dispatch({ type: 'directory', directory: buildToolsDirectory(input({ reportingToken: reportingTokenHint('missing') })) });
  const elsewhere = page.doc.getElementById('elsewhere')!;
  assert.match(elsewhere.textContent, /Spending limits.*Match the NEAR console exactly: set a usage reporting token/);
  const link = elsewhere.all().find((node) => node.tagName === 'button' && node.textContent === TOKEN_MISSING_TEXT)!;
  assert.match(link.title, /reporting-tokens/);
  link.click();
  assert.deepEqual(JSON.parse(JSON.stringify(page.posts.at(-1))), { type: 'run-command', command: SET_REPORTING_TOKEN_COMMAND });
  page.dispatch({ type: 'directory', directory: buildToolsDirectory(input({ reportingToken: reportingTokenHint('off') })) });
  page.doc.getElementById('elsewhere')!.all().find((node) => node.tagName === 'button' && /turn on NEAR's total/.test(node.textContent))!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(page.posts.at(-1))), { type: 'open-setting', key: USE_NEAR_TOTAL_SETTING });
  page.dispatch({ type: 'directory', directory: buildToolsDirectory(input()) });
  assert.doesNotMatch(page.doc.getElementById('elsewhere')!.textContent, /usage reporting token/, 'no row without a NEAR AI Cloud key');
});

// The host path: openTools with VS Code stubbed and a fake NEAR that would fail on any completion.
class MemorySecrets implements SecretStorageLike {
  private readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

class Memento { private values = new Map<string, unknown>(); get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; } async update(key: string, value: unknown) { this.values.set(key, value); } keys() { return [...this.values.keys()]; } }

test('host path: the Tools tab loads real data, prefills the sidebar, and refreshes on settings, MCP, and stop changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-tools-'));
  const storage = path.join(root, '.global');
  const home = path.join(storage, 'gsd', '1.40.0');
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  await writeFile(path.join(home, 'gsd-core', 'VERSION'), '1.40.0');
  await writeFile(path.join(storage, 'gsd', 'current.json'), JSON.stringify({ version: '1.40.0' }));
  await mkdir(path.join(home, 'skills', 'gsd-plan-phase'), { recursive: true });
  await writeFile(path.join(home, 'skills', 'gsd-plan-phase', 'SKILL.md'), '---\nname: gsd-plan-phase\ndescription: Create a phase plan.\nargument-hint: "<phase>"\n---\nPlan it.');
  await mkdir(path.join(home, 'agents'), { recursive: true });
  await writeFile(path.join(home, 'agents', 'gsd-planner.md'), '---\nname: gsd-planner\ndescription: Creates plans.\nmodel: opus\n---\nYou plan.');
  await mkdir(path.join(storage, 'teams'), { recursive: true });
  await writeFile(path.join(storage, 'teams', 'web.md'), '---\nname: Web team\ndescription: Builds pages\n---\n## lead\nrole: planner\nmodel: fast\n\nLead it.\n');
  const auth = new AuthService(new MemorySecrets());
  await new ProfileStore(root, auth, { validator: async () => undefined }).configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');

  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: string | URL | Request) => {
    const url = String(request);
    calls.push(url);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'z-ai/glm-5.3', pricing: { input: 1.8, output: 5.75 } }] });
    if (url.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'z-ai/glm-5.3', metadata: { attestationSupported: true, providerType: 'tinfoil' } }] });
    if (/completions|images|responses/.test(url)) throw new Error(`the Tools tab must not call a model: ${url}`);
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const settings: Record<string, unknown> = { defaultModel: 'z-ai/glm-5.3', actionPolicy: 'approve-risky' };
  const configListeners: Array<(event: { affectsConfiguration(section: string): boolean }) => void> = [];
  const posted: Array<Record<string, unknown>> = [];
  const executed: unknown[][] = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  let created = 0;
  const panel = {
    webview: { html: '', cspSource: 'vscode-webview://test', asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => uri.fsPath }), postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }), reveal: () => undefined, iconPath: undefined as unknown
  };
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root }, name: 'demo' }], name: 'demo',
      getConfiguration: () => ({ get: (key: string, fallback?: unknown) => key in settings ? settings[key] : fallback, inspect: () => undefined }),
      onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => void) => { configListeners.push(listener); return { dispose() {} }; }
    },
    window: { createWebviewPanel: () => { created += 1; return panel; }, createStatusBarItem: () => ({ show() {}, hide() {} }), showInformationMessage: () => undefined, showWarningMessage: () => undefined },
    ThemeColor: class {}, StatusBarAlignment: { Left: 1, Right: 2 },
    commands: { executeCommand: async (...args: unknown[]) => { executed.push(args); } },
    ViewColumn: { Active: -1 },
    Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  const prefills: string[] = [];
  try {
    const { openTools } = require('../services/toolsPage') as typeof import('../services/toolsPage');
    const { initEmergencyStop, setEmergencyStop } = require('../services/emergencyStop') as typeof import('../services/emergencyStop');
    const { mcpRegistry } = require('../services/mcpView') as typeof import('../services/mcpView');
    const context = { subscriptions: [], globalStorageUri: { fsPath: storage }, extensionUri: { fsPath: root }, secrets: new MemorySecrets(), globalState: new Memento(), workspaceState: new Memento() };
    initEmergencyStop(context as never);
    openTools(context as never, auth, { prefill: async (text) => { prefills.push(text); } });
    assert.match(panel.webview.html, /<h1>NEAR AI Tools<\/h1>/);
    assert.doesNotMatch(panel.webview.html, /id="(?:messages|input|send)"/);
    assert.match(panel.webview.html, /media\/tools\/tools\.js/);
    openTools(context as never, auth, { prefill: async () => undefined });
    assert.equal(created, 1, 'a second open shows the same tab');

    const directories = () => posted.filter((message) => message.type === 'directory').map((message) => message.directory as ToolsDirectory);
    await receive!({ type: 'ready' });
    const first = directories().at(-1)!;
    assert.deepEqual(first.skills.map((skill) => [skill.name, skill.argumentHint]), [['gsd-plan-phase', '<phase>']]);
    assert.deepEqual(first.agents.map((agent) => [agent.name, agent.tier]), [['gsd-planner', 'deep']]);
    assert.deepEqual(first.teams.map((team) => [team.command, team.members[0].tier]), [['team:web', 'fast']]);
    assert.deepEqual(first.models.map((model) => [model.id, model.privacy, model.usedFor.includes('main')]), [['z-ai/glm-5.3', 'tee', true]]);
    assert.equal(first.tools.find((tool) => tool.name === 'Edit')?.status, 'asks');

    // "Use in chat" puts a listed command in the sidebar composer; anything unlisted is ignored.
    await receive!({ type: 'use-in-chat', text: '/gsd-plan-phase ' });
    await receive!({ type: 'use-in-chat', text: '/team:web ' });
    await receive!({ type: 'use-in-chat', text: '/gsd-not-installed ' });
    assert.deepEqual(prefills, ['/gsd-plan-phase ', '/team:web ']);
    await receive!({ type: 'run-command', command: 'nearAi.manageMcp' });
    await receive!({ type: 'open-setting', key: 'nearAi.agent.deepModel' });
    assert.deepEqual(executed, [['nearAi.manageMcp'], ['workbench.action.openSettings', 'nearAi.agent.deepModel']]);

    const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
    // A settings change elsewhere (here: the approval mode) refreshes the page.
    settings.actionPolicy = 'mostly-autonomous';
    configListeners.forEach((listener) => listener({ affectsConfiguration: (section) => section === 'nearAi' }));
    await settle();
    assert.equal(directories().at(-1)!.tools.find((tool) => tool.name === 'Edit')?.status, 'runs');
    assert.equal(directories().at(-1)!.policy.mode, 'mostly-autonomous');
    const count = directories().length;
    configListeners.forEach((listener) => listener({ affectsConfiguration: (section) => section === 'editor' }));
    await settle();
    assert.equal(directories().length, count, 'unrelated settings do not refresh');
    // The emergency stop.
    await setEmergencyStop(true);
    await settle();
    assert.ok(directories().at(-1)!.tools.every((tool) => tool.status === 'stopped'));
    await setEmergencyStop(false);
    await settle();
    // An MCP server added in MCP Connections.
    await mcpRegistry(context as never).save({ id: 'catalog', name: 'Catalog', transport: 'http', approval: 'ask-for-changes' }, { url: 'https://mcp.example.com' });
    await mcpRegistry(context as never).setEnabledHere('catalog', true);
    await settle();
    assert.deepEqual(directories().at(-1)!.mcp.map((entry) => [entry.id, entry.enabledHere]), [['catalog', true]]);
    await receive!({ type: 'mcp-enable', id: 'catalog', enabled: false });
    await settle();
    assert.equal(directories().at(-1)!.mcp[0].enabledHere, false);
    assert.ok(!calls.some((url) => /completions|images|responses/.test(url)), 'no model calls');
  } finally {
    nodeModule._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});

test('the sidebar prefill posts to the chat view the way host requests do', async () => {
  const posted: unknown[] = [];
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  const executed: string[] = [];
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? { workspace: { workspaceFolders: undefined }, window: {}, commands: { executeCommand: async (command: string) => { executed.push(command); } }, Uri: { joinPath: () => ({}) } } : originalLoad(request, parent, isMain);
  try {
    const { NearAiPanelViewProvider } = require('../services/panelView') as typeof import('../services/panelView');
    const provider = new NearAiPanelViewProvider({} as never, {} as never);
    (provider as unknown as { view: unknown }).view = { webview: { postMessage: async (message: unknown) => { posted.push(message); return true; } } };
    await provider.prefill('/gsd-plan-phase ');
    assert.deepEqual(posted, [{ type: 'prefill', text: '/gsd-plan-phase ', insert: true }], 'an insert, so the composer keeps a draft');
    assert.deepEqual(executed, ['nearAiChatView.focus']);
  } finally {
    nodeModule._load = originalLoad;
  }
});

test('"Use in chat" keeps a draft: empty, plain draft, and a draft that starts with a command', () => {
  const { insertCommand } = require(path.join(__dirname, '..', '..', 'media', 'chat', 'composer.js')) as { insertCommand(draft: string, command: string): { text: string; caret: number } };
  // Empty (or only spaces): the command, caret after it.
  assert.deepEqual(insertCommand('', '/gsd-plan-phase '), { text: '/gsd-plan-phase ', caret: 16 });
  assert.deepEqual(insertCommand('   \n', '/gsd-plan-phase '), { text: '/gsd-plan-phase ', caret: 16 });
  // A draft: the command goes first and the draft is kept.
  assert.deepEqual(insertCommand('fix the login bug', '/gsd-debug '), { text: '/gsd-debug fix the login bug', caret: 11 });
  // A draft that starts with a command: only that command is replaced.
  assert.deepEqual(insertCommand('/gsd-progress phase 3 please', '/gsd-plan-phase '), { text: '/gsd-plan-phase phase 3 please', caret: 16 });
  assert.deepEqual(insertCommand('/team:web', '/gsd-debug '), { text: '/gsd-debug ', caret: 11 });
  assert.deepEqual(insertCommand('/team:web\nsecond line', '/gsd-debug '), { text: '/gsd-debug\nsecond line', caret: 10 });
  const chat = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(chat, /if \(m\.insert\) \{ const next = window\.nearComposer\.insertCommand\(input\.value, m\.text\); input\.value = next\.text; input\.focus\(\); input\.setSelectionRange\(next\.caret, next\.caret\);/);
  const panel = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'panelView.ts'), 'utf8');
  assert.ok(panel.indexOf("asset('composer.js')") < panel.indexOf("asset('chat.js')"), 'composer.js loads before chat.js');
});

test('a tool summary does not stop at an abbreviation such as "e.g."', () => {
  assert.equal(firstSentence('Run an installed slash command, e.g. "/gsd-plan-phase 1 --auto": loads its instructions to follow now.'), 'Run an installed slash command, e.g. "/gsd-plan-phase 1 --auto": loads its instructions to follow now.');
  assert.equal(firstSentence('Read a text file from the workspace. Lines are numbered.'), 'Read a text file from the workspace.');
  assert.equal(firstSentence('Short. But this continues for a while.'), 'Short. But this continues for a while.');
});

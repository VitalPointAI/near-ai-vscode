// Built-in tool manifests (GATE-02, GATE-03, D-04, D-05, D-07, Pitfall 10, Pitfall 11): every tool in the catalog declares a manifest the format accepts,
// the declared effects agree with the tool's own shorthand except where a reason is named, the manifest reads only arguments the tool really has, and the
// Tools page says the declaration in plain words. The tests walk `builtInTools()`, so a tool added to the catalog is checked without an edit here.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { braveSearch, searxngSearch, tavilySearch } from '../agent/webSearch';
import { webSearchTool } from '../agent/webTools';
import { imageTool } from '../agent/extraTools';
import type { NearAiClient } from '../services/nearAiClient';
import { INTEL_WORKBENCH_TOOL_NAMES } from '../agent/intelWorkbench';
import { COP_MAP_TOOL_NAMES } from '../agent/copMap';
import { LOGISTICS_TOOL_NAMES } from '../agent/logisticsTools';
import { OBSERVATIONS_TOOL_NAMES } from '../agent/observationsTools';
import { WATCH_TOOL_NAMES } from '../agent/watchTools';
import { builtInTools, CATALOG_TOOL_FILES, SHORTHAND_EXCEPTIONS, TOOL_DEFINING_FILES } from '../agent/toolCatalog';
import { effectsFor, parseToolManifest, shorthandFor } from '../domain/gate/manifest';
import { buildStudioContext, reviewDraft } from '../services/teamStudioPage';
import { mcpAgentTools, mcpToolName } from '../mcp/tools';
import type { McpConnection, McpServerConfig } from '../mcp/client';
import { mcpToolEffects } from '../domain/gate/manifest';
import { AgentConversation } from '../services/agentSession';
import type { AgentTurnRequest } from '../services/agentSession';
import { cyberExploitTools } from '../agent/cyberExploitTools';
import { cyberProbes } from '../agent/cyberProbes';
import { RunGrants } from '../agent/permissions';
import type { AgentTool } from '../agent/tools';
import type { GsdAgent } from '../gsd/library';
import { fakeHome, testManifest, testTool } from './helpers/gateFixtures';
import { describeManifest } from '../domain/gate/words';
import { buildToolsDirectory, capabilityStatus, STATUS_TEXT } from '../services/toolsDirectory';
import type { DirectoryInput } from '../services/toolsDirectory';


const EM_DASH = String.fromCharCode(0x2014);
/** The search provider directoryInput() says is set up, so the catalog compared with the page is built the same way. */
const CONFIGURED_SEARCH = { name: 'searxng', label: 'configured provider', host: 'search.example', search: async () => [] } as const;

function directoryInput(): DirectoryInput {
  return {
    teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: true, webSearchHost: 'search.example', securityConsented: true, mcp: [],
    settings: { mainModel: 'm', tiers: { deep: 'm', standard: 'm', fast: 'm' }, roleModels: {}, visionModel: 'm', transcriptionModel: 'm', imageModel: 'm', safetyModel: 'm' }
  };
}

test('every tool in the catalog declares a manifest the format accepts, under its own name', () => {
  const tools = builtInTools();
  assert.ok(tools.length > 0);
  const seen = new Set<string>();
  for (const tool of tools) {
    assert.ok(tool.manifest, `${tool.name} declares a manifest`);
    const parsed = parseToolManifest(JSON.parse(JSON.stringify(tool.manifest)));
    assert.equal(parsed.ok, true, `${tool.name}'s manifest parses`);
    assert.equal(tool.manifest.tool, tool.name, `${tool.name}'s manifest names the tool`);
    assert.equal(tool.manifest.runsOn, 'this-machine');
    assert.ok(tool.manifest.contexts.includes('interactive'), `${tool.name} exists in an interactive run, as it does today`);
    assert.equal(seen.has(tool.name), false, `${tool.name} is in the catalog once`);
    seen.add(tool.name);
  }
});

test('a manifest is frozen deeply, so nothing can widen it after the tool is built', () => {
  for (const tool of builtInTools()) {
    const manifest = tool.manifest!;
    assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.effects) && Object.isFrozen(manifest.hosts) && Object.isFrozen(manifest.contexts), `${tool.name}: lists frozen`);
    for (const effect of manifest.effects) {
      assert.ok(Object.isFrozen(effect), `${tool.name}: each effect frozen`);
      for (const value of Object.values(effect)) if (typeof value === 'object') assert.ok(Object.isFrozen(value), `${tool.name}: effect values frozen`);
    }
  }
});

test('a manifest agrees with the tool\'s own shorthand unless the tool is named with a reason (Pitfall 10)', () => {
  const names = new Set(builtInTools().map((tool) => tool.name));
  for (const [name, reason] of SHORTHAND_EXCEPTIONS) {
    assert.ok(reason.trim().length >= 20, `${name}: the reason is a sentence`);
    assert.ok(names.has(name), `${name}: an exception names a tool in the catalog`);
  }
  for (const tool of builtInTools()) {
    const implied = shorthandFor(tool.manifest!);
    if (SHORTHAND_EXCEPTIONS.has(tool.name)) assert.notEqual(implied, tool.capability, `${tool.name}: an exception that agrees is not an exception, remove it`);
    else assert.equal(implied, tool.capability, `${tool.name}: manifest implies ${implied}, the tool says ${tool.capability}`);
  }
});

test('a manifest reads only arguments the tool has, so a renamed argument cannot silently refuse every call', () => {
  for (const tool of builtInTools()) {
    const properties = (tool.parameters.properties ?? {}) as Record<string, unknown>;
    for (const effect of tool.manifest!.effects) {
      if ('from' in effect) continue;
      for (const value of Object.values(effect)) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (typeof entry === 'object' && entry !== null && 'field' in entry) assert.ok(typeof entry.field === 'string' && entry.field in properties, `${tool.name} reads ${String(entry.field)}`);
        }
      }
    }
  }
});

test('the core tools\' effects are filled from the call, with the whole project for a Glob or Grep that names no path', () => {
  const byName = new Map(builtInTools().map((tool) => [tool.name, tool]));
  const effects = (name: string, raw: Record<string, unknown>) => {
    const tool = byName.get(name)!;
    const filled = effectsFor(tool.manifest!, tool.manifestInput?.(raw) ?? raw);
    assert.equal(filled.ok, true, `${name} ${JSON.stringify(raw)}`);
    return filled.ok ? filled.value : [];
  };
  assert.deepEqual(effects('Read', { file_path: 'src/a.ts' }), [{ verb: 'read', paths: ['src/a.ts'] }]);
  assert.deepEqual(effects('Write', { file_path: 'src/a.ts', content: 'x' }), [{ verb: 'workspaceWrite', paths: ['src/a.ts'] }]);
  assert.deepEqual(effects('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }), [{ verb: 'workspaceWrite', paths: ['src/a.ts'] }]);
  assert.deepEqual(effects('Glob', { pattern: '**/*.ts' }), [{ verb: 'read', paths: ['**'] }]);
  // A folder name covers everything under it (owner-confirmed, PR #70 review), so a Glob or Grep given a folder names the folder and its contents.
  assert.deepEqual(effects('Glob', { pattern: '*.ts', path: 'src' }), [{ verb: 'read', paths: ['src', 'src/**'] }]);
  assert.deepEqual(effects('Grep', { pattern: 'x', path: 'src/' }), [{ verb: 'read', paths: ['src', 'src/**'] }]);
  assert.deepEqual(effects('Grep', { pattern: 'x' }), [{ verb: 'read', paths: ['**'] }]);
  assert.deepEqual(effects('Bash', { command: 'ls' }), [{ verb: 'shell', cwd: 'workspace' }]);
  for (const name of ['BashOutput', 'KillShell', 'TodoWrite']) assert.deepEqual(effects(name, {}), [{ verb: 'plan' }]);
  // A missing or wrongly typed argument is a refusal, never an empty or wildcard effect (T-70-17).
  assert.equal(effectsFor(byName.get('Read')!.manifest!, {}).ok, false);
  assert.equal(effectsFor(byName.get('Write')!.manifest!, { file_path: 3 }).ok, false);
  assert.equal(effectsFor(byName.get('Read')!.manifest!, { file_path: '../outside' }).ok, false);
});

test('the Tools page lists the catalog and each tool\'s notes carry its manifest words after today\'s notes', () => {
  const directory = buildToolsDirectory(directoryInput());
  const listed = new Map(directory.tools.map((entry) => [entry.name, entry]));
  for (const tool of builtInTools({ webSearch: CONFIGURED_SEARCH })) {
    const entry = listed.get(tool.name);
    assert.ok(entry, `${tool.name} is on the page`);
    const words = describeManifest(tool.manifest!);
    assert.deepEqual(entry.notes.slice(entry.notes.length - words.length), words, `${tool.name}: the manifest words come last`);
    for (const line of entry.notes) assert.equal(line.includes(EM_DASH), false);
  }
  assert.ok(listed.get('Write')!.notes.includes('Can change files in this project'));
  assert.ok(listed.get('Bash')!.notes.includes('Runs commands in a terminal'));
  assert.ok(listed.get('Read')!.notes.includes('Reads files in this project'));
  assert.ok(listed.get('TodoWrite')!.notes.includes('Changes nothing outside this run'));
});

test('the page\'s status still comes from the settings layer\'s shorthand, not from the manifest (Pitfall 11)', () => {
  const directory = buildToolsDirectory(directoryInput());
  const status = new Map(directory.tools.map((entry) => [entry.name, entry.status]));
  assert.equal(status.get('Read'), 'runs');
  assert.equal(status.get('BashOutput'), 'runs', 'BashOutput stays a read for the settings layer although its manifest says plan');
  assert.equal(status.get('Write'), 'asks');
  assert.equal(status.get('Bash'), 'asks');
});

// The order `agentSession.toolsFor` gives them to a run: the core, web, graphics, image and scan tools, a cyber engagement's probes and exploit steps, a team's
// staff team's staff-products and guard-scan tools, its knowledge graph, memory, and last the gsd tools (MCP tools sit between the staff and knowledge tools
// in a run and are not built-in).
const CYBER_TOOLS = ['CyberHttpProbe', 'CyberTlsProbe', 'CyberDnsProbe', 'CyberTcpProbe', 'CyberRobotsProbe', 'CyberSecretsProbe', 'CyberIacProbe', 'CyberDependencyProbe', 'CyberFingerprintProbe', 'CyberExploitTool', 'CyberPostExploitTool'];
// A staff section team's run (design 10, 6.2): the staff-products and guard-scan tools, between the cyber and the knowledge tools.
const STAFF_TOOLS = [
  'mcp__staff-products__propose', 'mcp__staff-products__verdict', 'mcp__staff-products__submit', 'mcp__staff-products__withdraw', 'mcp__staff-products__status',
  'mcp__staff-products__list', 'mcp__staff-products__register', 'mcp__staff-products__register_read', 'mcp__staff-products__wargame', 'mcp__staff-products__wargame_read', 'mcp__staff-products__step', 'mcp__staff-products__lint',
  'mcp__guard-scan__scan'
];
const EXPECTED_ORDER = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell', 'TodoWrite',
  'WebFetch', 'WebSearch', 'CheckCitations', 'CheckOriginality',
  'VectorizeImage', 'RenderSvg', 'CreatePresentation', 'CreatePdf', 'CreateDocument',
  'GenerateImage', 'SecurityScan',
  ...CYBER_TOOLS,
  ...STAFF_TOOLS,
  'TeamKnowledge', 'Learn',
  'Remember', 'Recall',
  'Skill', 'SlashCommand', 'AskUserQuestion', 'Agent', 'Task'
];

test('the catalog holds all 53 built-in tools, once each, in the order a run is given them, and the page lists every one of them in that order', () => {
  const names = builtInTools().map((tool) => tool.name);
  assert.equal(names.length, 53);
  assert.equal(new Set(names).size, 53, 'a duplicate name fails the catalog');
  assert.deepEqual(names, EXPECTED_ORDER);
  const listed = buildToolsDirectory(directoryInput()).tools.map((entry) => entry.name);
  assert.deepEqual(listed, EXPECTED_ORDER, 'the page lists all 53, the cyber, staff, TeamKnowledge and Learn tools included (owner-confirmed, PR #70 review)');
});

test('the 13 tools a run has only in a special setting are on the Tools page with their manifest words, in catalog order, and say whether they need a person', () => {
  const context = ['CyberHttpProbe', 'CyberTlsProbe', 'CyberDnsProbe', 'CyberTcpProbe', 'CyberRobotsProbe', 'CyberSecretsProbe', 'CyberIacProbe', 'CyberDependencyProbe', 'CyberFingerprintProbe', 'CyberExploitTool', 'CyberPostExploitTool', 'TeamKnowledge', 'Learn'];
  assert.equal(context.length, 13);
  const directory = buildToolsDirectory(directoryInput());
  const listed = directory.tools.map((entry) => entry.name);
  assert.deepEqual(listed.filter((name) => context.includes(name)), context, 'all 13, once each, in catalog order');
  assert.equal(listed.indexOf('SecurityScan') + 1, listed.indexOf('CyberHttpProbe'), 'the probes follow the scan tool');
  assert.equal(listed.indexOf('Learn') + 1, listed.indexOf('Remember'), 'the knowledge tools sit before memory');
  const byName = new Map(builtInTools().map((tool) => [tool.name, tool]));
  for (const name of context) {
    const entry = directory.tools.find((tool) => tool.name === name)!;
    const words = describeManifest(byName.get(name)!.manifest!);
    assert.ok(words.length > 0, `${name} has words`);
    assert.deepEqual(entry.words, words, `${name} shows its manifest words`);
    assert.deepEqual(entry.notes.slice(entry.notes.length - words.length), words, `${name}: the words come last in its notes`);
    // Its status comes from the same shorthand logic as every other tool: the entry's status is what capabilityStatus says for the tool's own capability.
    assert.equal(entry.status, capabilityStatus(byName.get(name)!.capability, { mode: 'approve-risky', emergencyStop: false }, DEFAULT_RULES, byName.get(name)!.autoSafe === true), `${name} status`);
    assert.equal(entry.statusText, STATUS_TEXT[entry.status]);
    // The interactive-only ones never claim they can run unattended; their words say they run only while a person is there.
    const interactiveOnly = INTERACTIVE_ONLY_TOOLS.includes(name);
    assert.equal(byName.get(name)!.manifest!.contexts.includes('unattended'), !interactiveOnly, `${name} contexts`);
    assert.equal(words.includes('Can also run when nobody is watching'), !interactiveOnly, `${name} words about running unattended`);
    assert.equal(words.includes('Runs only while you are there'), interactiveOnly, `${name} words about needing a person`);
  }
  assert.ok(directory.tools.find((tool) => tool.name === 'TeamKnowledge')!.words.includes('Can also run when nobody is watching'), 'TeamKnowledge also works with no person');
});

test('the team studio pickers offer the 13 tools with their words, and TeamKnowledge is no longer warned about as not built in', () => {
  const studio = buildStudioContext(directoryInput(), { hasProject: true, knowledgeBase: false });
  const names = studio.tools.map((tool) => tool.name);
  assert.deepEqual(names.slice(0, EXPECTED_ORDER.length), EXPECTED_ORDER, 'the picker lists the whole catalog in catalog order');
  // After the catalog: each built-in staff server's whole-server grant, and the staff tools that are not catalog tools (the intel-workbench's, the
  // observations server's, cop-map's, the logistics server's, the orders server's and the battle-rhythm server's).
  assert.ok(names.slice(EXPECTED_ORDER.length).every((name) => /^mcp:(?:staff-products|guard-scan|intel-workbench|observations|cop-map|logistics|orders|battle-rhythm)$/.test(name) || /^mcp__(?:intel-workbench|observations|cop-map|logistics|orders|battle-rhythm)__/.test(name)), 'only staff server entries follow the catalog');
  const byName = new Map(builtInTools().map((tool) => [tool.name, tool]));
  for (const name of [...CYBER_TOOLS, 'TeamKnowledge', 'Learn']) assert.deepEqual(studio.tools.find((tool) => tool.name === name)!.words, describeManifest(byName.get(name)!.manifest!), `${name} words in the picker`);
  const draft = { name: 'k', description: '', members: [{ name: 'a', role: '', model: '', tools: ['TeamKnowledge', 'Learn', 'CyberHttpProbe', 'Teleport'], instructions: 'x' }] } as unknown as Parameters<typeof reviewDraft>[0];
  const review = reviewDraft(draft, undefined, directoryInput(), studio);
  const text = review.warnings.map((issue) => issue.message).join('\n');
  assert.match(text, /Teleport is not a built-in tool/, 'a name no tool has still warns');
  assert.doesNotMatch(text, /TeamKnowledge|Learn|CyberHttpProbe/, 'a tool in the catalog is not warned about');
});

test('two tools with equal manifests stay separate catalog entries', () => {
  const byName = new Map(builtInTools().map((tool) => [tool.name, tool]));
  assert.deepEqual({ ...byName.get('Agent')!.manifest!, tool: '' }, { ...byName.get('Task')!.manifest!, tool: '' }, 'Agent and Task declare the same effects');
  assert.notEqual(byName.get('Agent'), byName.get('Task'));
});

// The tools that need a person: they do not exist in a run with nobody there (the image and scan tools, a question for a person, a write to the team's shared graph, and an engagement's probes).
const INTERACTIVE_ONLY_TOOLS = ['GenerateImage', 'SecurityScan', 'AskUserQuestion', 'Learn', ...CYBER_TOOLS];

test('unattended runs keep exactly the tools they have today: never the image or scan tools, and never a question for a person', () => {
  const unattended = builtInTools().filter((tool) => tool.manifest!.contexts.includes('unattended')).map((tool) => tool.name);
  assert.deepEqual(unattended, EXPECTED_ORDER.filter((name) => !INTERACTIVE_ONLY_TOOLS.includes(name)));
});

test('the effects of the web, graphics, image, memory and security tools are filled from the call', () => {
  const byName = new Map(builtInTools().map((tool) => [tool.name, tool]));
  const effects = (name: string, raw: Record<string, unknown>) => {
    const tool = byName.get(name)!;
    const filled = effectsFor(tool.manifest!, tool.manifestInput?.(raw) ?? raw);
    assert.equal(filled.ok, true, `${name} ${JSON.stringify(raw)}`);
    return filled.ok ? filled.value : [];
  };
  assert.deepEqual(effects('WebFetch', { url: 'https://Example.com/a?b=1' }), [{ verb: 'network', hosts: ['example.com'] }]);
  assert.equal(effectsFor(byName.get('WebFetch')!.manifest!, { url: 'not a url' }).ok, false);
  // With no provider set up, WebSearch reaches no host (it says search is not set up); with one, the provider's own host, never a placeholder.
  assert.deepEqual(effects('WebSearch', { query: 'x' }), [{ verb: 'plan' }]);
  const configured = builtInTools({ webSearch: { name: 'brave', label: 'Brave Search', host: 'api.search.brave.com', search: async () => [] } }).find((tool) => tool.name === 'WebSearch')!;
  assert.deepEqual(effectsFor(configured.manifest!, { query: 'x' }), { ok: true, value: [{ verb: 'network', hosts: ['api.search.brave.com'] }] });
  assert.deepEqual(effects('CheckCitations', { citations: [] }), [{ verb: 'plan' }]);
  assert.deepEqual(effects('CheckOriginality', { path: 'draft.md' }), [{ verb: 'plan' }, { verb: 'read', paths: ['draft.md'] }]);
  assert.deepEqual(effects('CheckOriginality', { text: 'a draft' }), [{ verb: 'plan' }, { verb: 'read', paths: ['**'] }]);
  assert.deepEqual(effects('VectorizeImage', { image_path: 'a.png', output_path: 'a.svg' }), [{ verb: 'workspaceWrite', paths: ['a.svg'] }, { verb: 'read', paths: ['a.png'] }]);
  assert.deepEqual(effects('RenderSvg', { svg_path: 'a.svg', output_path: 'a.png' }), [{ verb: 'workspaceWrite', paths: ['a.png'] }, { verb: 'read', paths: ['a.svg'] }]);
  for (const name of ['CreatePresentation', 'CreatePdf', 'CreateDocument']) assert.deepEqual(effects(name, { output_path: 'out/file' }), [{ verb: 'workspaceWrite', paths: ['out/file'] }]);
  assert.deepEqual(effects('GenerateImage', { path: 'assets/a.png', prompt: 'x' }), [{ verb: 'workspaceWrite', paths: ['assets/a.png'] }, { verb: 'network', hosts: ['cloud-api.near.ai'] }]);
  assert.deepEqual(effects('Remember', { label: 'a', fact: 'b' }), [{ verb: 'skill.write', scope: 'project' }]);
  assert.deepEqual(effects('Recall', { query: 'a' }), [{ verb: 'plan' }]);
  assert.deepEqual(effects('SecurityScan', {}), [
    { verb: 'read', paths: ['**/package.json', '**/*lock*'] },
    { verb: 'workspaceWrite', paths: ['sbom.cdx.json'] },
    { verb: 'network', hosts: ['api.osv.dev', 'endoflife.date'] }
  ]);
});

test('WebSearch names the host of the provider it was built with, and reaches nothing when there is none', () => {
  const hosts = [braveSearch('k'), tavilySearch('k'), searxngSearch('https://Search.Example.org/'), searxngSearch('http://[::1]:8080')].map((provider) => provider.host);
  assert.deepEqual(hosts, ['api.search.brave.com', 'api.tavily.com', 'search.example.org', 'localhost']);
  for (const provider of [braveSearch('k'), tavilySearch('k'), searxngSearch('https://search.example.org')]) {
    const tool = webSearchTool(provider);
    assert.equal(shorthandFor(tool.manifest!), tool.capability);
    const filled = effectsFor(tool.manifest!, { query: 'x' });
    assert.deepEqual(filled.ok ? filled.value : undefined, [{ verb: 'network', hosts: [provider.host!] }]);
    assert.deepEqual(tool.manifest!.hosts, [provider.host]);
  }
  const none = webSearchTool(undefined);
  assert.deepEqual(none.manifest!.effects, [{ verb: 'plan' }]);
  assert.equal(none.capability, shorthandFor(none.manifest!), 'with no provider the shorthand is plan, as the manifest says');
  assert.deepEqual(none.manifest!.hosts, []);
  assert.equal(none.manifest!.untrusted, true, 'its results are outside content either way');
});

test('GenerateImage names its client\'s host, and a host the format cannot hold becomes localhost', () => {
  const host = (baseHost: string | undefined) => imageTool({ baseHost } as unknown as NearAiClient, { id: 'img' }).manifest!.hosts;
  assert.deepEqual(host('cloud-api.near.ai'), ['cloud-api.near.ai']);
  assert.deepEqual(host('localhost'), ['localhost']);
  assert.deepEqual(host('127.0.0.1'), ['127.0.0.1']);
  assert.deepEqual(host('[::1]'), ['localhost']);
  assert.deepEqual(host(undefined), ['cloud-api.near.ai']);
});

test('the words say what each of these tools does, and say it only once', () => {
  const words = (name: string) => describeManifest(builtInTools().find((tool) => tool.name === name)!.manifest!);
  assert.deepEqual(words('WebFetch'), ['Connects to any site', 'Can also run when nobody is watching']);
  assert.deepEqual(words('SecurityScan'), ['Reads files in this project', 'Can change files in this project', 'Connects to api.osv.dev, endoflife.date', 'Runs only while you are there']);
  assert.deepEqual(words('GenerateImage'), ['Can change files in this project', 'Connects to cloud-api.near.ai', 'Runs only while you are there']);
  for (const tool of builtInTools()) {
    const lines = describeManifest(tool.manifest!);
    assert.equal(new Set(lines).size, lines.length, `${tool.name}: no sentence twice`);
  }
});

test('the gsd tools\' effects: Skill, SlashCommand and AskUserQuestion change nothing outside the run, and Agent and Task start the agent the call names', () => {
  const byName = new Map(builtInTools().map((tool) => [tool.name, tool]));
  const effects = (name: string, raw: Record<string, unknown>) => {
    const tool = byName.get(name)!;
    const filled = effectsFor(tool.manifest!, tool.manifestInput?.(raw) ?? raw);
    assert.equal(filled.ok, true, `${name} ${JSON.stringify(raw)}`);
    return filled.ok ? filled.value : [];
  };
  for (const name of ['Skill', 'SlashCommand', 'AskUserQuestion']) assert.deepEqual(effects(name, {}), [{ verb: 'plan' }], name);
  for (const name of ['Agent', 'Task']) {
    assert.deepEqual(effects(name, { prompt: 'x', subagent_type: 'gsd-planner' }), [{ verb: 'spawn', agent: 'gsd-planner' }], name);
    assert.deepEqual(effects(name, { prompt: 'x', subagent_type: '  gsd-planner ' }), [{ verb: 'spawn', agent: 'gsd-planner' }], `${name} with spaces around the name`);
    assert.deepEqual(effects(name, { prompt: 'x' }), [{ verb: 'spawn', agent: 'general-purpose' }], `${name} with no agent named starts general-purpose`);
    assert.deepEqual(effects(name, { prompt: 'x', subagent_type: '' }), [{ verb: 'spawn', agent: 'general-purpose' }], `${name} with an empty name`);
    // A name the format cannot hold is a refusal, never a wildcard spawn (T-70-17).
    assert.equal(effectsFor(byName.get(name)!.manifest!, byName.get(name)!.manifestInput!({ prompt: 'x', subagent_type: '*' })).ok, false, `${name} with a wildcard`);
    assert.equal(effectsFor(byName.get(name)!.manifest!, byName.get(name)!.manifestInput!({ prompt: 'x', subagent_type: 7 })).ok, true, `${name} with a number falls back to general-purpose`);
  }
  assert.equal(byName.get('Task')!.manifest!.tool, 'Task');
  assert.equal(byName.get('SlashCommand')!.manifest!.tool, 'SlashCommand');
});

test('a team member card says, in the manifest\'s words, what each of its tools can do (D-07)', () => {
  const studio = buildStudioContext(directoryInput(), { hasProject: true, knowledgeBase: false });
  const byName = new Map(studio.tools.map((tool) => [tool.name, tool]));
  assert.ok(byName.get('Agent')!.words.includes('Starts other agents'));
  assert.ok(byName.get('Task')!.words.includes('Starts other agents'));
  assert.ok(byName.get('Write')!.words.includes('Can change files in this project'));
  for (const tool of builtInTools({ webSearch: CONFIGURED_SEARCH })) {
    const entry = byName.get(tool.name);
    if (entry) assert.deepEqual(entry.words, describeManifest(tool.manifest!), `${tool.name}: the card and the Tools page use the same sentences`);
  }
});

test('the cyber probes\' effects: a target they connect to, or a folder they read, filled from the call', () => {
  const byName = new Map(builtInTools().map((tool) => [tool.name, tool]));
  const effects = (name: string, raw: Record<string, unknown>) => {
    const tool = byName.get(name)!;
    const filled = effectsFor(tool.manifest!, tool.manifestInput?.(raw) ?? raw);
    assert.equal(filled.ok, true, `${name} ${JSON.stringify(raw)}`);
    return filled.ok ? filled.value : [];
  };
  for (const name of ['CyberHttpProbe', 'CyberFingerprintProbe', 'CyberTlsProbe', 'CyberRobotsProbe']) {
    assert.deepEqual(effects(name, { url: ' https://Target.example:8443/a ' }), [{ verb: 'network', hosts: ['target.example'] }], name);
    assert.equal(effectsFor(byName.get(name)!.manifest!, { url: 'not a url' }).ok, false, `${name}: a call with no usable target is refused, not widened`);
  }
  assert.deepEqual(effects('CyberDnsProbe', { hostname: ' target.example ' }), [{ verb: 'network', hosts: ['target.example'] }]);
  assert.deepEqual(effects('CyberTcpProbe', { host: '10.0.0.5', ports: [80] }), [{ verb: 'network', hosts: ['10.0.0.5'] }]);
  for (const name of ['CyberSecretsProbe', 'CyberIacProbe', 'CyberDependencyProbe']) {
    assert.deepEqual(effects(name, { root: 'services/api' }), [{ verb: 'read', paths: ['services/api'] }], name);
    assert.deepEqual(effects(name, {}), [{ verb: 'read', paths: ['**'] }], `${name} with no folder reads the project`);
    assert.deepEqual(effects(name, { root: '   ' }), [{ verb: 'read', paths: ['**'] }], `${name} with a blank folder`);
    assert.equal(effectsFor(byName.get(name)!.manifest!, byName.get(name)!.manifestInput!({ root: '../outside' })).ok, false, `${name}: a folder outside the project is refused`);
  }
  for (const name of ['CyberExploitTool', 'CyberPostExploitTool']) {
    assert.deepEqual(effects(name, { payload: 'curl x', command: 'id', target: 'target.example' }), [{ verb: 'shell', cwd: 'workspace' }, { verb: 'network', hosts: ['target.example'] }], `${name} with a bare host`);
    assert.deepEqual(effects(name, { payload: 'curl x', command: 'id', target: 'https://target.example:8443/x' }), [{ verb: 'shell', cwd: 'workspace' }, { verb: 'network', hosts: ['target.example'] }], `${name} with a URL`);
    assert.deepEqual(effects(name, { payload: 'curl x', command: 'id', target: 'target.example:8080' }), [{ verb: 'shell', cwd: 'workspace' }, { verb: 'network', hosts: ['target.example'] }], `${name} with a host and a port`);
    assert.equal(effectsFor(byName.get(name)!.manifest!, byName.get(name)!.manifestInput!({ payload: 'curl x' })).ok, false, `${name}: no target is a refusal`);
  }
  assert.deepEqual(effects('TeamKnowledge', { query: 'x' }), [{ verb: 'plan' }]);
  assert.deepEqual(effects('Learn', { nodes: [] }), [{ verb: 'skill.write', scope: 'team' }]);
  assert.equal(shorthandFor(byName.get('Learn')!.manifest!), 'sharedWrite', 'Learn still asks in every mode, as the floor\'s shared-write rule will');
});

test('the six network probes are the named shorthand exceptions, each with a reason, and nothing else about the cyber tools differs', () => {
  const probes = ['CyberHttpProbe', 'CyberFingerprintProbe', 'CyberTlsProbe', 'CyberDnsProbe', 'CyberTcpProbe', 'CyberRobotsProbe'];
  for (const name of probes) {
    assert.ok(SHORTHAND_EXCEPTIONS.get(name)!.trim().length >= 20, name);
    const tool = builtInTools().find((candidate) => candidate.name === name)!;
    assert.equal(tool.capability, 'read', `${name} stays a silent, scope-checked read for the settings layer`);
    assert.equal(shorthandFor(tool.manifest!), 'network');
  }
  assert.deepEqual([...SHORTHAND_EXCEPTIONS.keys()].filter((name) => name.startsWith('Cyber')).sort(), probes.sort());
});

test('a manifest says untrusted exactly when the tool\'s results are outside content', () => {
  for (const tool of builtInTools()) assert.equal(tool.manifest!.untrusted, tool.untrusted === true, tool.name);
});

test('every manifest is a constant on the tool: it cannot be changed at run time, and every call reads the same object', () => {
  for (const tool of builtInTools()) {
    const manifest = tool.manifest! as unknown as { tool: string; effects: unknown[]; contexts: string[]; hosts: string[] };
    assert.throws(() => { manifest.tool = 'Other'; }, TypeError, `${tool.name}: name`);
    assert.throws(() => { manifest.effects.push({ verb: 'shell', cwd: 'anywhere' }); }, TypeError, `${tool.name}: effects`);
    assert.throws(() => { manifest.contexts.push('unattended'); }, TypeError, `${tool.name}: contexts`);
    assert.throws(() => { manifest.hosts.push('*'); }, TypeError, `${tool.name}: hosts`);
    assert.equal(tool.manifest!.tool, tool.name);
  }
});

function mcpConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id: 'catalog', name: 'Catalog', transport: 'http', approval: 'ask-for-changes', ...overrides };
}

function mcpTools(config: McpServerConfig, host: string) {
  const connection = {
    tools: [
      { name: 'search', description: 'Search', inputSchema: { type: 'object' }, readOnly: true, destructive: false },
      { name: 'update', description: 'Update', inputSchema: { type: 'object' }, readOnly: false, destructive: false },
      { name: 'drop', description: 'Drop', inputSchema: { type: 'object' }, readOnly: true, destructive: true }
    ],
    call: async () => ''
  } as unknown as McpConnection;
  return mcpAgentTools(config, connection, host);
}

test('every MCP tool carries the legacy manifest built from the facts its capability comes from, so nothing it decides changes (D-38)', () => {
  for (const approval of ['ask-for-changes', 'ask-every-call', 'trusted'] as const) {
    for (const transport of ['http', 'stdio'] as const) {
      const config = mcpConfig({ approval, transport, ...(transport === 'stdio' ? { command: 'server' } : {}) });
      const host = transport === 'http' ? 'Catalog.Example:8443' : '';
      for (const tool of mcpTools(config, host)) {
        const manifest = tool.manifest!;
        assert.ok(manifest, `${tool.name} has a manifest`);
        assert.equal(manifest.tool, tool.name);
        assert.equal(manifest.untrusted, true, 'its results are outside content');
        assert.equal(manifest.runsOn, transport === 'http' ? 'remote' : 'this-machine');
        const bare = tool.name.slice(`mcp__catalog__`.length);
        const facts = { server: 'catalog', tool: bare, host, readOnly: bare !== 'update', destructive: bare === 'drop', approval, transport };
        const legacy = mcpToolEffects(undefined, facts);
        assert.equal(tool.capability, legacy.shorthand, `${tool.name}: the shorthand the settings layer uses is what the legacy manifest implies`);
        assert.deepEqual(manifest.effects, legacy.effects, `${tool.name}: effects`);
        assert.deepEqual(manifest.contexts, legacy.contexts, `${tool.name}: contexts`);
        assert.equal(Object.isFrozen(manifest) && Object.isFrozen(manifest.effects), true);
      }
    }
  }
});

test('an MCP tool that only reads is a call on its server; one that changes things also reaches the server\'s host; a stdio server only runs while a person is there', () => {
  const [search, update, drop] = mcpTools(mcpConfig(), 'catalog.example');
  assert.deepEqual(search.manifest!.effects, [{ verb: 'mcp', server: 'catalog', tools: ['search'] }]);
  assert.deepEqual(update.manifest!.effects, [{ verb: 'mcp', server: 'catalog', tools: ['update'] }, { verb: 'network', hosts: ['catalog.example'] }]);
  assert.deepEqual(update.manifest!.hosts, ['catalog.example']);
  assert.deepEqual(drop.manifest!.effects, update.manifest!.effects.map((effect) => ('tools' in effect ? { ...effect, tools: ['drop'] } : effect)));
  assert.deepEqual(search.manifest!.contexts, ['interactive', 'unattended']);
  const [stdioSearch] = mcpTools(mcpConfig({ transport: 'stdio', command: 'server' }), '');
  assert.deepEqual(stdioSearch.manifest!.contexts, ['interactive']);
  assert.deepEqual(describeManifest(update.manifest!).slice(-2), ['Connects to catalog.example', 'Can also run when nobody is watching']);
  // A server with no host reaches any site, the widest reading today's behaviour allows.
  assert.deepEqual(mcpTools(mcpConfig({ approval: 'ask-every-call' }), '')[0].manifest!.hosts, ['*']);
});

test('an MCP tool whose name the format cannot hold gets the restrictive manifest instead of stopping the server connecting', () => {
  const connection = { tools: [{ name: 'wild*card', description: 'x', inputSchema: { type: 'object' }, readOnly: true, destructive: false }, { name: 'x'.repeat(200), description: 'y', inputSchema: { type: 'object' }, readOnly: true, destructive: false }], call: async () => '' } as unknown as McpConnection;
  const tools = mcpAgentTools(mcpConfig(), connection, 'catalog.example');
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    const verbs = tool.manifest!.effects.map((effect) => ('verb' in effect ? effect.verb : 'command'));
    assert.deepEqual(verbs, ['shell', 'network', 'workspaceWrite', 'destroy'], tool.name);
    assert.deepEqual(tool.manifest!.contexts, ['interactive']);
    assert.equal(tool.capability, 'read', 'the settings layer\'s answer is unchanged');
  }
  assert.equal(mcpToolName('catalog', 'search'), 'mcp__catalog__search');
});

// ---------- the catalog is the whole set, and no tool can exist without a manifest (GATE-02, T-70-27) ----------

/** The tools a run is given when every option is on: the real `toolsFor`, asked with stand-ins for what it only passes along. */
function toolsOfARunWithEverythingOn(): AgentTool<any>[] {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-gate-run-'));
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
  const agent: GsdAgent = { name: 'helper', description: 'helps', tools: [], body: 'help', file: path.join(root, 'helper.md') };
  const request = {
    text: 'x', client: {}, model: 'm', privacy: 'private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES,
    gsd: { home: path.join(root, 'gsd'), skills: [], agents: [agent], shellEnv: {} },
    memory: { store: {}, projectScope: { kind: 'project', id: 'p' } },
    imageModel: { id: 'image-model' },
    security: { consented: () => true, scan: async () => undefined },
    cyber: { engagement: {}, tools: () => [...cyberProbes({ inScope: () => false }), ...cyberExploitTools({ inScope: () => false, engagementId: 'e', sandboxTier: 'disabled' })], limiter: () => undefined, grant: () => undefined },
    webSearch: { name: 'searxng', label: 'x', host: 'search.example', search: async () => [] },
    team: { slug: 'team', name: 'Team', description: 'd', file: path.join(root, 'team.md'), members: [{ name: 'j2-chief', tools: ['mcp:intel-workbench', 'mcp:observations', 'mcp__observations__watch_*', 'mcp:cop-map', 'mcp:logistics'], instructions: 'x' }], staff: { section: 'j2' } }
  } as unknown as AgentTurnRequest;
  const toolsFor = (conversation as unknown as { toolsFor(...args: unknown[]): AgentTool<any>[] }).toolsFor.bind(conversation);
  return toolsFor(request, { root, cwd: root }, new RunGrants(), [], async () => undefined, new AbortController().signal, 'run-1');
}

test('a run with every option on is given exactly the catalog\'s tools, in the catalog\'s order, so a tool added to a run but not to the catalog fails here', () => {
  const given = toolsOfARunWithEverythingOn().map((tool) => tool.name);
  // The run is a staff team's, so it also gets the built-in local staff servers a member is granted: the intel-workbench, observations, cop-map and
  // logistics (with the observations server's standing watch tools, WP-WATCH, which only their own grant gives). Their tools, like a connected server's, are not catalog entries (intelWorkbench.test.ts, staffObservations.test.ts, staffCopMap.test.ts,
  // staffLogistics.test.ts). They come right after the staff tools; everything else is exactly the catalog.
  const catalog = builtInTools().map((tool) => tool.name);
  const after = catalog.indexOf('mcp__guard-scan__scan') + 1;
  assert.ok(after > 0);
  assert.deepEqual(given, [...catalog.slice(0, after), ...INTEL_WORKBENCH_TOOL_NAMES, ...OBSERVATIONS_TOOL_NAMES, ...WATCH_TOOL_NAMES, ...COP_MAP_TOOL_NAMES, ...LOGISTICS_TOOL_NAMES, ...catalog.slice(after)]);
});

function sourceFilesUnder(folder: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(folder)) {
    const full = path.join(folder, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'test') out.push(...sourceFilesUnder(full)); } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const REPO = path.resolve(__dirname, '..', '..');

test('every source file that mentions AgentTool< is in CATALOG_TOOL_FILES, and every listed file exists, so a new tool file fails until it is catalogued', () => {
  const mentioning = sourceFilesUnder(path.join(REPO, 'src')).filter((file) => readFileSync(file, 'utf8').includes('AgentTool<')).map((file) => path.relative(REPO, file).split(path.sep).join('/')).sort();
  assert.deepEqual(mentioning, [...CATALOG_TOOL_FILES].sort());
  for (const file of CATALOG_TOOL_FILES) assert.ok(statSync(path.join(REPO, file)).isFile(), `${file} exists`);
  // A file that defines tools says what each does next to it.
  for (const file of TOOL_DEFINING_FILES) assert.match(readFileSync(path.join(REPO, file), 'utf8'), /manifest/, `${file} defines tools and declares their manifests`);
});

test('AgentTool declares its manifest as required: a tool without one does not compile', () => {
  const text = readFileSync(path.join(REPO, 'src', 'agent', 'tools.ts'), 'utf8');
  assert.match(text, /^ {2}manifest: ToolManifest;$/m);
  assert.doesNotMatch(text, /manifest\?:/);
});

test('the fixtures give a hand-built tool the manifest its shorthand implies, and never the real home', () => {
  for (const capability of ['read', 'plan', 'workspaceWrite', 'sharedWrite', 'shell', 'network', 'mediaGeneration', 'mediaPublication'] as const) {
    assert.equal(shorthandFor(testManifest('T', capability)), capability, capability);
  }
  const tool = testTool({ name: 'Fixture', description: 'd', parameters: {}, capability: 'workspaceWrite', parse: (raw) => raw, title: () => 't', run: async () => 'ok' });
  assert.equal(tool.manifest.tool, 'Fixture');
  assert.equal(shorthandFor(tool.manifest), 'workspaceWrite');
  const given = testManifest('Own', 'read');
  assert.equal(testTool({ name: 'X', description: 'd', parameters: {}, capability: 'shell', manifest: given, parse: (raw) => raw, title: () => 't', run: async () => 'ok' }).manifest, given, 'a manifest the test gives is kept');
  const home = fakeHome();
  assert.notEqual(home, process.env.HOME);
  assert.ok(path.resolve(home).startsWith(path.resolve(tmpdir()) + path.sep));
});

// PR #70 review carry-over: the catalog built WebSearch with a stand-in provider on a placeholder host when no search was set up, so that host could reach
// a manifest, the Tools page and a decision record. There is no stand-in now; the absence of a provider is explicit (no host at all).
/** A name reserved for examples and tests (RFC 2606, RFC 6761): never a host a real tool reaches. */
const PLACEHOLDER_HOST = /(?:^|\.)(?:example|invalid|test)$|(?:^|\.)example\.(?:com|net|org)$/i;

function declaredHosts(tool: AgentTool<any>): string[] {
  const manifest = tool.manifest!;
  const fromEffects = manifest.effects.flatMap((entry) => ('hosts' in entry && Array.isArray(entry.hosts) ? entry.hosts as string[] : []));
  return [...(manifest.hosts ?? []), ...fromEffects];
}

test('no tool the catalog builds without a configured provider names a placeholder host, and WebSearch then names no host at all', () => {
  for (const stubs of [{}, { webSearch: null }] as const) {
    for (const tool of builtInTools(stubs)) {
      for (const host of declaredHosts(tool)) assert.ok(!PLACEHOLDER_HOST.test(host), `${tool.name} names ${host}`);
    }
    const search = builtInTools(stubs).find((tool) => tool.name === 'WebSearch')!;
    assert.deepEqual(declaredHosts(search), [], 'no provider, no host');
    assert.deepEqual(effectsFor(search.manifest!, { query: 'x' }), { ok: true, value: [{ verb: 'plan' }] });
  }
  assert.ok(PLACEHOLDER_HOST.test('search.example') && PLACEHOLDER_HOST.test('api.example.com') && !PLACEHOLDER_HOST.test('api.search.brave.com'), 'the check knows a placeholder');
});

test('the Tools page with web search off, or on with no host, lists WebSearch with no host and its set-up step', () => {
  for (const extra of [{ webSearch: false }, { webSearch: true, webSearchHost: undefined }] as const) {
    const directory = buildToolsDirectory({ ...directoryInput(), ...extra } as DirectoryInput);
    const entry = directory.tools.find((tool) => tool.name === 'WebSearch')!;
    assert.ok(!entry.notes.some((line) => line.includes('search.example')), entry.notes.join(' | '));
    assert.ok(!entry.words.some((line) => /search\.example/.test(line)), entry.words.join(' | '));
  }
});

test('the source of the catalog and the Tools page names no placeholder host, so none can come back as a default', () => {
  for (const file of ['src/agent/toolCatalog.ts', 'src/services/toolsDirectory.ts']) {
    const text = readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    const hosts = [...text.matchAll(/host:\s*['"`]([^'"`]+)['"`]/g)].map((match) => match[1] as string);
    for (const host of hosts) assert.ok(!PLACEHOLDER_HOST.test(host), `${file} names ${host}`);
  }
});

test('a WebSearch call with no provider set up is recorded as a plan that reaches no host, and is not asked about', async () => {
  const { gateToolCall } = await import('../agent/gateAdapter');
  const { testGateRuntime } = await import('./helpers/gatedRuns');
  const runtime = testGateRuntime();
  const search = builtInTools().find((tool) => tool.name === 'WebSearch')!;
  const gated = await gateToolCall(runtime, {
    tool: search, raw: { query: 'x' }, root: mkdtempSync(path.join(tmpdir(), 'near-ai-search-none-')), callId: 'c1',
    policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(), buildAuto: async () => undefined
  });
  assert.equal(gated.decision.outcome, 'allow');
  const record = runtime.records[0]!;
  assert.equal(record.api.operation, 'plan');
  assert.ok(!JSON.stringify(record).includes('search.example'));
  assert.deepEqual(record.resources, [{ name: 'WebSearch', type: 'tool' }]);
});

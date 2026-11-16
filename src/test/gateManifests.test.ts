// Built-in tool manifests (GATE-02, GATE-03, D-04, D-05, D-07, Pitfall 10, Pitfall 11): every tool in the catalog declares a manifest the format accepts,
// the declared effects agree with the tool's own shorthand except where a reason is named, the manifest reads only arguments the tool really has, and the
// Tools page says the declaration in plain words. The tests walk `builtInTools()`, so a tool added to the catalog is checked without an edit here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { braveSearch, searxngSearch, tavilySearch } from '../agent/webSearch';
import { webSearchTool } from '../agent/webTools';
import { imageTool } from '../agent/extraTools';
import type { NearAiClient } from '../services/nearAiClient';
import { builtInTools, SHORTHAND_EXCEPTIONS } from '../agent/toolCatalog';
import { effectsFor, parseToolManifest, shorthandFor } from '../domain/gate/manifest';
import { buildStudioContext } from '../services/teamStudioPage';
import { describeManifest } from '../domain/gate/words';
import { buildToolsDirectory } from '../services/toolsDirectory';
import type { DirectoryInput } from '../services/toolsDirectory';

const EM_DASH = String.fromCharCode(0x2014);

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
  assert.deepEqual(effects('Glob', { pattern: '*.ts', path: 'src' }), [{ verb: 'read', paths: ['src'] }]);
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
  for (const tool of builtInTools()) {
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

const EXPECTED_ORDER = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell', 'TodoWrite',
  'WebFetch', 'WebSearch', 'CheckCitations', 'CheckOriginality',
  'VectorizeImage', 'RenderSvg', 'CreatePresentation', 'CreatePdf', 'CreateDocument',
  'GenerateImage', 'SecurityScan', 'Remember', 'Recall',
  'Skill', 'SlashCommand', 'AskUserQuestion', 'Agent', 'Task'
];

test('the catalog holds the built-in tools in the order a run is given them, and the page lists them in that order', () => {
  assert.deepEqual(builtInTools().map((tool) => tool.name), EXPECTED_ORDER);
  const listed = buildToolsDirectory(directoryInput()).tools.map((entry) => entry.name);
  assert.deepEqual(listed.slice(0, EXPECTED_ORDER.length), EXPECTED_ORDER);
});

// The tools that need a person: they do not exist in a run with nobody there (today the image and scan tools, and AskUserQuestion).
const INTERACTIVE_ONLY_TOOLS = ['GenerateImage', 'SecurityScan', 'AskUserQuestion'];

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
  assert.deepEqual(effects('WebSearch', { query: 'x' }), [{ verb: 'network', hosts: ['search.example'] }]);
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
  for (const tool of builtInTools()) {
    const entry = byName.get(tool.name);
    if (entry) assert.deepEqual(entry.words, describeManifest(tool.manifest!), `${tool.name}: the card and the Tools page use the same sentences`);
  }
});

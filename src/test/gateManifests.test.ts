// Built-in tool manifests (GATE-02, GATE-03, D-04, D-05, D-07, Pitfall 10, Pitfall 11): every tool in the catalog declares a manifest the format accepts,
// the declared effects agree with the tool's own shorthand except where a reason is named, the manifest reads only arguments the tool really has, and the
// Tools page says the declaration in plain words. The tests walk `builtInTools()`, so a tool added to the catalog is checked without an edit here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { builtInTools, SHORTHAND_EXCEPTIONS } from '../agent/toolCatalog';
import { effectsFor, parseToolManifest, shorthandFor } from '../domain/gate/manifest';
import { describeManifest } from '../domain/gate/words';
import { buildToolsDirectory } from '../services/toolsDirectory';
import type { DirectoryInput } from '../services/toolsDirectory';

const EM_DASH = String.fromCharCode(0x2014);

function directoryInput(): DirectoryInput {
  return {
    teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: true, securityConsented: true, mcp: [],
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

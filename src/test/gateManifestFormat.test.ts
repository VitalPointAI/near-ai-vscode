// Tool and MCP manifests v1 (GATE-02, GATE-03, D-05, D-06, D-07, D-38): the format, how the gate fills effects from a call, the restrictive and legacy MCP
// defaults, the shorthand a manifest implies, and the plain words built from the same declaration. No key material or token literal is written here.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANIFEST_VERSION,
  MCP_TOOL_DEFAULTS,
  RESTRICTIVE_EFFECTS,
  RUNS_ON,
  defaultMcpContexts,
  effectsFor,
  mcpToolEffects,
  parseMcpManifest,
  parseToolManifest,
  shorthandFor
} from '../domain/gate/manifest';
import type { McpManifest, McpToolFacts, ToolManifest } from '../domain/gate/manifest';
import { MANIFEST_IS_A_CLAIM_TEXT, RUNS_ON_THIS_MACHINE_TEXT, describeManifest, describeMcpManifest } from '../domain/gate/words';

const EM_DASH = String.fromCharCode(0x2014);

function source(field: string, as: 'path' | 'url-host' | 'literal'): { from: 'input'; field: string; as: string } {
  return { from: 'input', field, as };
}

function toolManifest(tool: string, effects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { manifestVersion: 1, tool, effects, hosts: [], credentials: [], contexts: ['interactive', 'unattended'], untrusted: false, runsOn: 'this-machine', ...extra };
}

const WRITE = toolManifest('Write', [{ verb: 'workspaceWrite', paths: [source('file_path', 'path')] }]);

function parsed(value: unknown): ToolManifest {
  const result = parseToolManifest(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function refusedWith(value: unknown): string {
  const result = parseToolManifest(value);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.ok ? '' : result.reason;
}

function mcpManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { manifestVersion: 1, server: 'files', runsOn: 'this-machine', hosts: [], credentials: [], contexts: ['interactive'], tools: {}, toolDefaults: 'restrictive', ...extra };
}

function mcpParsed(value: unknown): McpManifest {
  const result = parseMcpManifest(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function facts(extra: Partial<McpToolFacts> = {}): McpToolFacts {
  return { server: 'files', tool: 'list', host: 'api.example.com', readOnly: true, destructive: false, approval: 'ask-for-changes', transport: 'http', ...extra };
}

function assertPlainWords(lines: readonly string[]): void {
  for (const sentence of lines) {
    assert.equal(sentence.includes(EM_DASH), false, sentence);
    assert.equal(sentence.includes('NEAR organization'), false, sentence);
    assert.notEqual(sentence.trim(), '', 'a sentence is never empty');
  }
}

test('tracer: the Write manifest parses, fills its path from one call and is described in plain words', () => {
  const manifest = parsed(WRITE);
  assert.equal(manifest.tool, 'Write');
  const filled = effectsFor(manifest, { file_path: 'src/a.ts' });
  assert.deepEqual(filled.ok && filled.value, [{ verb: 'workspaceWrite', paths: ['src/a.ts'] }]);
  const missing = effectsFor(manifest, {});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'missing-field');
  const words = describeManifest(manifest);
  assert.ok(words.includes('Can change files in this project'));
  assert.ok(words.includes('Can also run when nobody is watching'));
  assertPlainWords(words);
});

test('the format constants are the ones the plan names', () => {
  assert.equal(MANIFEST_VERSION, 1);
  assert.deepEqual([...RUNS_ON], ['this-machine', 'remote']);
  assert.deepEqual([...MCP_TOOL_DEFAULTS], ['restrictive', 'legacy']);
});

test('GATE-02 closed keys: an unknown key, a missing key, a wrong version and a wrong type are each refused with their own reason', () => {
  assert.equal(refusedWith({ ...WRITE, extra: 1 }), 'unknown-field');
  const { runsOn: _runsOn, ...withoutRunsOn } = WRITE;
  assert.equal(refusedWith(withoutRunsOn), 'missing-field');
  assert.equal(refusedWith({ ...WRITE, manifestVersion: 2 }), 'unknown-version');
  assert.equal(refusedWith({ ...WRITE, manifestVersion: '1' }), 'wrong-type');
  assert.equal(refusedWith({ ...WRITE, untrusted: 'no' }), 'wrong-type');
  assert.equal(refusedWith({ ...WRITE, runsOn: 'cloud' }), 'not-allowed-here');
  assert.equal(refusedWith({ ...WRITE, tool: '' }), 'wrong-type');
  assert.equal(refusedWith('Write'), 'wrong-type');
  assert.equal(refusedWith(null), 'wrong-type');
});

test('GATE-02 empty edges: an empty effects list is refused, a plan effect counts, and empty hosts and credentials mean none', () => {
  assert.equal(refusedWith({ ...WRITE, effects: [] }), 'empty-list');
  const planOnly = parsed(toolManifest('TodoWrite', [{ verb: 'plan' }]));
  assert.deepEqual(planOnly.hosts, []);
  assert.deepEqual(planOnly.credentials, []);
  assert.equal(refusedWith({ ...WRITE, contexts: [] }), 'empty-list');
  assert.equal(refusedWith({ ...WRITE, contexts: ['interactive', 'someday'] }), 'not-allowed-here');
  assert.equal(refusedWith({ ...WRITE, contexts: ['interactive', 'interactive'] }), 'duplicate');
  const reserved = parsed({ ...WRITE, contexts: ['interactive', 'unattended', 'relay', 'routine'] });
  assert.equal(reserved.contexts.length, 4);
});

test('GATE-02 hosts and credentials: a host is a HostPattern, a credential is a handle and never a secret', () => {
  assert.equal(refusedWith({ ...WRITE, hosts: ['https://api.example.com'] }), 'wrong-type');
  assert.equal(refusedWith({ ...WRITE, hosts: ['API.example.com'] }), 'wrong-type');
  assert.equal(refusedWith({ ...WRITE, hosts: ['a.example.com', 'a.example.com'] }), 'duplicate');
  assert.deepEqual(parsed({ ...WRITE, hosts: ['*.example.com', '*'] }).hosts, ['*.example.com', '*']);
  assert.equal(refusedWith({ ...WRITE, credentials: ['Has Space'] }), 'wrong-type');
  assert.equal(refusedWith({ ...WRITE, credentials: ['sk-abcdefghijklmnop'] }), 'not-allowed-here');
  assert.deepEqual(parsed({ ...WRITE, credentials: ['github.token'] }).credentials, ['github.token']);
});

test('GATE-02 templates: a typo, a field on the wrong verb, an unknown verb and a bad source are refused when the manifest is read', () => {
  assert.equal(refusedWith(toolManifest('X', [{ verb: 'workspaceWrite', path: ['a'] }])), 'unknown-field');
  assert.equal(refusedWith(toolManifest('X', [{ verb: 'shell', cwd: 'workspace', paths: ['a'] }])), 'unknown-field');
  assert.equal(refusedWith(toolManifest('X', [{ verb: 'fly' }])), 'unknown-verb');
  assert.equal(refusedWith(toolManifest('X', [{ verb: 'workspaceWrite', paths: [source('file_path', 'url-host')] }])), 'not-allowed-here');
  assert.equal(refusedWith(toolManifest('X', [{ verb: 'network', hosts: [source('url', 'path')] }])), 'not-allowed-here');
  assert.equal(refusedWith(toolManifest('X', [{ verb: 'workspaceWrite', paths: [{ from: 'env', field: 'HOME', as: 'path' }] }])), 'not-allowed-here');
  assert.equal(refusedWith(toolManifest('X', [{ verb: 'workspaceWrite', paths: [{ from: 'input', field: 'bad field', as: 'path' }] }])), 'wrong-type');
  assert.equal(refusedWith(toolManifest('X', [{ verb: 'workspaceWrite', paths: [{ from: 'input', field: 'a', as: 'path', extra: 1 }] }])), 'unknown-field');
  assert.equal(refusedWith(toolManifest('X', [{ verb: 'workspaceWrite', paths: [source('a', 'path')] }, { verb: 'workspaceWrite', paths: [source('a', 'path')] }])), 'duplicate');
});

test('the command source is Bash only, never stands alone, and effectsFor gives the shell effect only', () => {
  const bash = toolManifest('Bash', [{ verb: 'shell', cwd: 'workspace' }, { from: 'command' }]);
  const manifest = parsed(bash);
  const filled = effectsFor(manifest, { command: 'ls' });
  assert.deepEqual(filled.ok && filled.value, [{ verb: 'shell', cwd: 'workspace' }]);
  assert.equal(refusedWith(toolManifest('Write', [{ verb: 'shell', cwd: 'workspace' }, { from: 'command' }])), 'not-allowed-here');
  assert.equal(refusedWith(toolManifest('Bash', [{ from: 'command' }])), 'missing-field');
  assert.equal(refusedWith(toolManifest('Bash', [{ verb: 'shell', cwd: 'workspace' }, { from: 'command', field: 'command' }])), 'unknown-field');
});

test('GATE-02 effectsFor never widens (T-70-17): a missing, empty, wrongly typed or escaping field is a refusal, not an empty or wildcard effect', () => {
  const manifest = parsed(WRITE);
  const cases: [unknown, string][] = [
    [{}, 'missing-field'],
    [undefined, 'missing-field'],
    [null, 'missing-field'],
    [{ file_path: 42 }, 'wrong-type'],
    [{ file_path: '' }, 'wrong-type'],
    [{ file_path: ['a'] }, 'wrong-type'],
    [{ file_path: '../outside.ts' }, 'not-allowed-here'],
    [{ file_path: '/etc/passwd' }, 'not-allowed-here']
  ];
  for (const [input, reason] of cases) {
    const result = effectsFor(manifest, input);
    assert.equal(result.ok, false, JSON.stringify(input));
    if (!result.ok) assert.equal(result.reason, reason, JSON.stringify(input));
  }
  // An inherited property is not an input field.
  const inherited = Object.create({ file_path: 'src/a.ts' });
  assert.equal(effectsFor(manifest, inherited).ok, false);
});

test('GATE-02 effectsFor reads a URL host as lowercase and refuses an input that is not a URL', () => {
  const fetchTool = parsed(toolManifest('WebFetch', [{ verb: 'network', hosts: [source('url', 'url-host')] }], { hosts: ['*'], untrusted: true }));
  const filled = effectsFor(fetchTool, { url: 'https://API.GitHub.com/x?y=1' });
  assert.deepEqual(filled.ok && filled.value, [{ verb: 'network', hosts: ['api.github.com'] }]);
  for (const url of ['not a url', 'file:///etc/passwd', 'javascript:alert(1)', 'http://[::1]/x', 'https://']) {
    assert.equal(effectsFor(fetchTool, { url }).ok, false, url);
  }
});

test('GATE-02 effectsFor fills a literal as given, joins several fields into one effect and names a repeated value once', () => {
  const copier = parsed(toolManifest('Copy', [{ verb: 'workspaceWrite', paths: [source('from', 'path'), source('to', 'path'), 'out/log.txt'] }]));
  const filled = effectsFor(copier, { from: 'a.txt', to: 'b.txt' });
  assert.deepEqual(filled.ok && filled.value, [{ verb: 'workspaceWrite', paths: ['a.txt', 'b.txt', 'out/log.txt'] }]);
  const same = effectsFor(copier, { from: 'a.txt', to: 'a.txt' });
  assert.deepEqual(same.ok && same.value, [{ verb: 'workspaceWrite', paths: ['a.txt', 'out/log.txt'] }]);
  const agent = parsed(toolManifest('Agent', [{ verb: 'spawn', agent: source('subagent_type', 'literal') }]));
  const spawned = effectsFor(agent, { subagent_type: 'reviewer' });
  assert.deepEqual(spawned.ok && spawned.value, [{ verb: 'spawn', agent: 'reviewer' }]);
  assert.equal(effectsFor(agent, { subagent_type: '*' }).ok, false);
});

test('GATE-02 effectsFor in request mode refuses a wildcard literal a ceiling would allow', () => {
  const wide = parsed(toolManifest('Wide', [{ verb: 'network', hosts: ['*'] }]));
  const result = effectsFor(wide, {});
  assert.equal(result.ok, false);
});

test('GATE-02 a manifest with a plan effect and a read effect gives both, in the order declared', () => {
  const both = parsed(toolManifest('CheckOriginality', [{ verb: 'plan' }, { verb: 'read', paths: [source('path', 'path')] }]));
  const filled = effectsFor(both, { path: 'docs/a.md' });
  assert.deepEqual(filled.ok && filled.value, [{ verb: 'plan' }, { verb: 'read', paths: ['docs/a.md'] }]);
});

test('GATE-03 RESTRICTIVE_EFFECTS is exactly the four effects of D-06', () => {
  assert.deepEqual(
    [...RESTRICTIVE_EFFECTS],
    [
      { verb: 'shell', cwd: 'anywhere' },
      { verb: 'network', hosts: ['*'] },
      { verb: 'workspaceWrite', paths: ['**'] },
      { verb: 'destroy', paths: ['**'] }
    ]
  );
});

test('GATE-03 a restrictive stdio manifest with an empty tools object gives every tool RESTRICTIVE_EFFECTS, interactive only, and says it is a claim', () => {
  const manifest = mcpParsed(mcpManifest());
  for (const tool of ['list', 'read_file', 'anything']) {
    const result = mcpToolEffects(manifest, facts({ tool, transport: 'stdio', host: '' }));
    assert.deepEqual([...result.effects], [...RESTRICTIVE_EFFECTS]);
    assert.deepEqual([...result.contexts], ['interactive']);
    assert.equal(result.defaults, 'restrictive');
    assert.equal(result.shorthand, 'shell');
  }
  const words = describeMcpManifest(manifest, 'stdio', '');
  assert.equal(words[0], RUNS_ON_THIS_MACHINE_TEXT);
  assert.equal(words[words.length - 1], MANIFEST_IS_A_CLAIM_TEXT);
  assert.ok(words.some((line) => line.includes('never run when nobody is watching')));
  assert.equal(words.filter((line) => line === MANIFEST_IS_A_CLAIM_TEXT).length, 1);
  assertPlainWords(words);
});

test('GATE-03 restrictive never lets an undeclared tool run unattended, even when the server names unattended', () => {
  const manifest = mcpParsed(mcpManifest({ contexts: ['interactive', 'unattended'], tools: { list: { effects: [{ verb: 'read', paths: ['**'] }] } } }));
  assert.deepEqual([...mcpToolEffects(manifest, facts({ tool: 'other' })).contexts], ['interactive']);
  assert.deepEqual([...mcpToolEffects(manifest, facts({ tool: 'list' })).contexts], ['interactive', 'unattended']);
  const unattendedOnly = mcpParsed(mcpManifest({ contexts: ['unattended'] }));
  assert.deepEqual([...mcpToolEffects(unattendedOnly, facts({ tool: 'other' })).contexts], []);
});

test('GATE-03 an absent manifest is legacy, never restrictive (D-38)', () => {
  const result = mcpToolEffects(undefined, facts());
  assert.equal(result.defaults, 'legacy');
  assert.notDeepEqual([...result.effects], [...RESTRICTIVE_EFFECTS]);
});

test('GATE-03 legacy split: readOnly with ask-for-changes implies read, a non-read-only tool or an ask-every-call server implies network (src/mcp/tools.ts today)', () => {
  const quiet = mcpToolEffects(undefined, facts({ readOnly: true, approval: 'ask-for-changes' }));
  assert.equal(quiet.shorthand, 'read');
  assert.deepEqual([...quiet.effects], [{ verb: 'mcp', server: 'files', tools: ['list'] }]);
  const trusted = mcpToolEffects(undefined, facts({ readOnly: true, approval: 'trusted' }));
  assert.equal(trusted.shorthand, 'read');
  const changes = mcpToolEffects(undefined, facts({ readOnly: false, approval: 'ask-for-changes' }));
  assert.equal(changes.shorthand, 'network');
  assert.deepEqual([...changes.effects], [{ verb: 'mcp', server: 'files', tools: ['list'] }, { verb: 'network', hosts: ['api.example.com'] }]);
  const everyCall = mcpToolEffects(undefined, facts({ readOnly: true, approval: 'ask-every-call' }));
  assert.equal(everyCall.shorthand, 'network');
  const destructive = mcpToolEffects(undefined, facts({ readOnly: true, destructive: true }));
  assert.equal(destructive.shorthand, 'network');
  const local = mcpToolEffects(undefined, facts({ readOnly: false, host: '', transport: 'stdio' }));
  assert.deepEqual([...local.effects], [{ verb: 'mcp', server: 'files', tools: ['list'] }, { verb: 'network', hosts: ['*'] }]);
  const withPort = mcpToolEffects(undefined, facts({ readOnly: false, host: 'API.Example.com:8443' }));
  assert.deepEqual(withPort.effects[1], { verb: 'network', hosts: ['api.example.com'] });
});

test('GATE-03 legacy contexts follow the transport: a stdio server is interactive only, a remote server may also run unattended', () => {
  assert.deepEqual([...mcpToolEffects(undefined, facts({ transport: 'stdio' })).contexts], ['interactive']);
  assert.deepEqual([...mcpToolEffects(undefined, facts({ transport: 'http' })).contexts], ['interactive', 'unattended']);
  assert.deepEqual([...defaultMcpContexts('stdio')], ['interactive']);
});

test('GATE-03 toolDefaults legacy on a manifest decides an undeclared tool as an absent manifest does', () => {
  const legacy = mcpParsed(mcpManifest({ toolDefaults: 'legacy', contexts: ['interactive', 'unattended'] }));
  const result = mcpToolEffects(legacy, facts({ readOnly: false }));
  const absent = mcpToolEffects(undefined, facts({ readOnly: false }));
  assert.deepEqual([...result.effects], [...absent.effects]);
  assert.equal(result.shorthand, absent.shorthand);
  assert.equal(result.defaults, 'legacy');
});

test('GATE-03 a declared tool entry overrides the defaults for that tool only, and the name match is exact (T-70-18)', () => {
  const manifest = mcpParsed(
    mcpManifest({ tools: { list: { effects: [{ verb: 'read', paths: ['docs/**'] }], contexts: ['interactive', 'unattended'] } }, contexts: ['interactive'] })
  );
  const declared = mcpToolEffects(manifest, facts({ tool: 'list' }));
  assert.equal(declared.defaults, 'declared');
  assert.deepEqual([...declared.effects], [{ verb: 'read', paths: ['docs/**'] }]);
  assert.equal(declared.shorthand, 'read');
  assert.deepEqual([...declared.contexts], ['interactive', 'unattended']);
  for (const tool of ['List', 'LIST', 'list ', ' list', 'lis', 'list2']) {
    assert.equal(mcpToolEffects(manifest, facts({ tool })).defaults, 'restrictive', tool);
  }
});

test('GATE-03 a tool entry without its own contexts uses the server contexts; a tool named __proto__ is an ordinary entry', () => {
  const manifest = mcpParsed(JSON.parse('{"manifestVersion":1,"server":"files","runsOn":"remote","hosts":["api.example.com"],"credentials":[],"contexts":["interactive","unattended"],"tools":{"__proto__":{"effects":[{"verb":"plan"}]}},"toolDefaults":"restrictive"}'));
  const result = mcpToolEffects(manifest, facts({ tool: '__proto__' }));
  assert.equal(result.defaults, 'declared');
  assert.deepEqual([...result.contexts], ['interactive', 'unattended']);
  assert.equal(result.shorthand, 'plan');
  assert.equal(Object.getPrototypeOf(manifest.tools), Object.prototype);
  assert.equal(mcpToolEffects(manifest, facts({ tool: 'constructor' })).defaults, 'restrictive');
});

test('GATE-03 a server or tool name the vocabulary cannot hold gets the restrictive effects, never a looser match', () => {
  for (const tool of ['a*b', '*', 'a\nb', 'x'.repeat(200)]) {
    const result = mcpToolEffects(undefined, facts({ tool }));
    assert.deepEqual([...result.effects], [...RESTRICTIVE_EFFECTS], tool);
    assert.equal(result.defaults, 'restrictive');
  }
  const badServer = mcpToolEffects(undefined, facts({ server: 'a*b' }));
  assert.deepEqual([...badServer.effects], [...RESTRICTIVE_EFFECTS]);
});

test('GATE-03 parseMcpManifest: closed keys, exact version, tools entries checked by the vocabulary, a duplicate or empty effects list refused', () => {
  const refusedMcp = (value: unknown): string => {
    const result = parseMcpManifest(value);
    assert.equal(result.ok, false);
    return result.ok ? '' : result.reason;
  };
  assert.equal(refusedMcp(mcpManifest({ extra: 1 })), 'unknown-field');
  assert.equal(refusedMcp(mcpManifest({ manifestVersion: 2 })), 'unknown-version');
  assert.equal(refusedMcp(mcpManifest({ toolDefaults: 'permissive' })), 'not-allowed-here');
  assert.equal(refusedMcp(mcpManifest({ runsOn: 'cloud' })), 'not-allowed-here');
  assert.equal(refusedMcp(mcpManifest({ tools: [] })), 'wrong-type');
  assert.equal(refusedMcp(mcpManifest({ tools: { a: { effects: [] } } })), 'empty-list');
  assert.equal(refusedMcp(mcpManifest({ tools: { a: { effects: [{ verb: 'fly' }] } } })), 'unknown-verb');
  assert.equal(refusedMcp(mcpManifest({ tools: { a: { effects: [{ verb: 'plan' }, { verb: 'plan' }] } } })), 'duplicate');
  assert.equal(refusedMcp(mcpManifest({ tools: { a: { effects: [{ verb: 'plan' }], extra: 1 } } })), 'unknown-field');
  assert.equal(refusedMcp(mcpManifest({ tools: { a: { effects: [{ verb: 'plan' }], contexts: [] } } })), 'empty-list');
  assert.equal(refusedMcp(mcpManifest({ tools: { 'a*': { effects: [{ verb: 'plan' }] } } })), 'wrong-type');
  assert.equal(refusedMcp(mcpManifest({ contexts: [] })), 'empty-list');
  assert.equal(refusedMcp(null), 'wrong-type');
  const empty = mcpParsed(mcpManifest());
  assert.deepEqual(empty.tools, {});
});

test('shorthandFor gives the ActionCapability a manifest implies', () => {
  const of = (effects: unknown[]): string => shorthandFor(parsed(toolManifest('T', effects)));
  assert.equal(of([{ verb: 'skill.write', scope: 'team' }]), 'sharedWrite');
  assert.equal(of([{ verb: 'workspaceWrite', paths: [source('p', 'path')] }]), 'workspaceWrite');
  assert.equal(
    of([{ verb: 'workspaceWrite', paths: [source('p', 'path')] }, { verb: 'network', hosts: ['api.example.com'] }, { verb: 'infer', tier: 'any-cloud', provider: 'p', model: 'm' }]),
    'mediaGeneration'
  );
  assert.equal(of([{ verb: 'shell', cwd: 'workspace' }]), 'shell');
  assert.equal(of([{ verb: 'shell', cwd: 'workspace' }, { verb: 'network', hosts: [source('target', 'url-host')] }]), 'shell');
  assert.equal(of([{ verb: 'network', hosts: [source('url', 'url-host')] }]), 'network');
  assert.equal(of([{ verb: 'read', paths: ['**/package.json'] }]), 'read');
  assert.equal(of([{ verb: 'read', paths: ['**/package.json'] }, { verb: 'network', hosts: ['osv.dev'] }]), 'network');
  assert.equal(of([{ verb: 'plan' }]), 'plan');
  assert.equal(of([{ verb: 'plan' }, { verb: 'spawn', agent: source('subagent_type', 'literal') }]), 'plan');
  for (const scope of ['run', 'project', 'user']) assert.equal(of([{ verb: 'plan' }, { verb: 'skill.write', scope }]), 'plan', scope);
  assert.equal(of([{ verb: 'publish', target: 'registry' }]), 'mediaPublication');
  assert.equal(shorthandFor({ effects: RESTRICTIVE_EFFECTS }), 'shell');
  assert.equal(shorthandFor({ effects: [{ verb: 'mcp', server: 's', tools: ['t'] }] }), 'network');
});

test('describeManifest: a WebFetch-like manifest says which sites it connects to, sorted, and leaves the effect line to the hosts line', () => {
  const fetchTool = parsed(toolManifest('WebFetch', [{ verb: 'network', hosts: [source('url', 'url-host')] }], { hosts: ['api.github.com'], untrusted: true }));
  const words = describeManifest(fetchTool);
  assert.ok(words.includes('Connects to api.github.com'));
  assert.equal(words.filter((line) => line.startsWith('Connects to')).length, 1);
  const several = parsed(toolManifest('Many', [{ verb: 'network', hosts: ['osv.dev', 'api.osv.dev'] }], { hosts: ['nvd.nist.gov'] }));
  assert.ok(describeManifest(several).includes('Connects to api.osv.dev, nvd.nist.gov, osv.dev'));
  const anywhere = parsed(toolManifest('Any', [{ verb: 'network', hosts: [source('url', 'url-host')] }], { hosts: ['*'] }));
  assert.ok(describeManifest(anywhere).includes('Connects to any site'));
  const named = parsed(toolManifest('Probe', [{ verb: 'network', hosts: [source('target', 'url-host')] }]));
  assert.ok(describeManifest(named).includes('Connects to sites named in each call'));
});

test('describeManifest writes one sentence for every verb, in the vocabulary verb order, with where it runs first and the contexts sentence last', () => {
  const every = parsed(
    toolManifest(
      'Everything',
      [
        { verb: 'infer', tier: 'any-cloud', provider: 'p', model: 'm' },
        { verb: 'useSecret', handle: 'github.token' },
        { verb: 'spend', nanoUsdPerRun: 1000 },
        { verb: 'skill.write', scope: 'team' },
        { verb: 'schedule' },
        { verb: 'spawn', agent: 'reviewer' },
        { verb: 'destroy', paths: ['tmp/**'] },
        { verb: 'publish', target: 'registry' },
        { verb: 'send', channel: 'alerts' },
        { verb: 'mcp', server: 'files', tools: ['list'] },
        { verb: 'network', hosts: ['api.example.com'] },
        { verb: 'shell', cwd: 'workspace' },
        { verb: 'workspaceWrite', paths: ['src/**'] },
        { verb: 'plan' },
        { verb: 'read', paths: ['**'] }
      ],
      { credentials: ['deploy.key'], contexts: ['interactive'] }
    )
  );
  assert.deepEqual(describeManifest(every), [
    RUNS_ON_THIS_MACHINE_TEXT,
    'Reads files in this project',
    'Changes nothing outside this run',
    'Can change files in this project',
    'Runs commands in a terminal',
    'Calls tools on files',
    'Sends messages to alerts',
    'Can publish to a package registry',
    'Can delete files',
    'Starts other agents',
    'Can schedule work to run later',
    'Can change skills your whole team shares',
    'Can spend money on your account',
    'Uses the stored credential deploy.key',
    'Uses the stored credential github.token',
    'Asks a model',
    'Connects to api.example.com',
    'Runs only while you are there'
  ]);
  assertPlainWords(describeManifest(every));
});

test('describeManifest: a remote tool says it runs on another machine; a tool without a shell effect does not claim the local-permissions sentence', () => {
  const remote = parsed(toolManifest('Remote', [{ verb: 'plan' }], { runsOn: 'remote' }));
  assert.equal(describeManifest(remote)[0], 'Runs on another machine');
  const local = parsed(WRITE);
  assert.equal(describeManifest(local).includes(RUNS_ON_THIS_MACHINE_TEXT), false);
  const shell = parsed(toolManifest('Bash', [{ verb: 'shell', cwd: 'workspace' }, { from: 'command' }]));
  assert.equal(describeManifest(shell)[0], RUNS_ON_THIS_MACHINE_TEXT);
});

test('describeManifest: contexts other than interactive say it can run when nobody is watching', () => {
  const interactive = parsed({ ...WRITE, contexts: ['interactive'] });
  assert.equal(describeManifest(interactive).at(-1), 'Runs only while you are there');
  for (const context of ['unattended', 'relay', 'routine']) {
    const other = parsed({ ...WRITE, contexts: ['interactive', context] });
    assert.equal(describeManifest(other).at(-1), 'Can also run when nobody is watching', context);
  }
});

test('describeMcpManifest: a stdio server leads with where it runs, a remote one does not claim it, and every result ends with the claim sentence', () => {
  const stdio = describeMcpManifest(mcpParsed(mcpManifest({ toolDefaults: 'legacy' })), 'stdio', '');
  assert.equal(stdio[0], RUNS_ON_THIS_MACHINE_TEXT);
  const remote = describeMcpManifest(undefined, 'http', 'API.Example.com');
  assert.equal(remote[0], 'Runs on another machine');
  assert.ok(remote.includes('Connects to api.example.com'));
  assert.ok(remote.includes('Calls tools on this server'));
  assert.ok(remote.includes('Can also run when nobody is watching'));
  const localAbsent = describeMcpManifest(undefined, 'stdio', '');
  assert.equal(localAbsent[0], RUNS_ON_THIS_MACHINE_TEXT);
  assert.ok(localAbsent.includes('Runs only while you are there'));
  for (const words of [stdio, remote, localAbsent]) {
    assert.equal(words.at(-1), MANIFEST_IS_A_CLAIM_TEXT);
    assertPlainWords(words);
  }
  assert.ok(MANIFEST_IS_A_CLAIM_TEXT.includes('NEAR AI cannot check what a server does inside itself'));
});

test('describeMcpManifest: declared tool effects appear once, in verb order, and a hostile server name cannot add a dash, a line break or unbounded text', () => {
  const manifest = mcpParsed(
    mcpManifest({
      server: `evil${EM_DASH}name ${'x'.repeat(100)}`,
      hosts: ['api.example.com'],
      tools: {
        a: { effects: [{ verb: 'workspaceWrite', paths: ['**'] }, { verb: 'network', hosts: ['api.example.com'] }] },
        b: { effects: [{ verb: 'workspaceWrite', paths: ['src/**'] }, { verb: 'read', paths: ['**'] }] }
      },
      contexts: ['interactive', 'unattended']
    })
  );
  const words = describeMcpManifest(manifest, 'http', 'api.example.com');
  assert.deepEqual(words.slice(2, 4), ['Reads files in this project', 'Can change files in this project']);
  assert.equal(words.filter((line) => line === 'Can change files in this project').length, 1);
  assert.equal(words.filter((line) => line.startsWith('Connects to')).length, 1);
  assertPlainWords(words);
  assert.ok((words[1] ?? '').length < 100);
  assert.equal(parseMcpManifest(mcpManifest({ server: 'a\nb' })).ok, false);
});

test('every sentence this module writes is free of em-dashes and of the words "NEAR organization"', () => {
  const samples: string[][] = [
    describeManifest(parsed(WRITE)),
    describeMcpManifest(undefined, 'stdio', ''),
    describeMcpManifest(undefined, 'http', 'api.example.com'),
    describeMcpManifest(mcpParsed(mcpManifest()), 'stdio', ''),
    describeMcpManifest(mcpParsed(mcpManifest({ toolDefaults: 'legacy', runsOn: 'remote' })), 'http', 'x.example.com')
  ];
  for (const words of samples) assertPlainWords(words);
  assert.equal(RUNS_ON_THIS_MACHINE_TEXT.includes(EM_DASH), false);
  assert.equal(MANIFEST_IS_A_CLAIM_TEXT.includes(EM_DASH), false);
});

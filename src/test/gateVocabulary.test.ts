// Capability vocabulary v1 (GATE-01, D-03, D-35). The frozen canonical vectors below are literal strings on purpose: changing the meaning of a v1
// verb or field must fail here loudly, because vocabulary v1 ends up in signed bundles and a change is a new version beside v1.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize } from '../domain/team/canonical';
import { GATE_SHAPE_FAILURES } from '../domain/gate/shape';
import type { GateShapeFailure } from '../domain/gate/shape';
import {
  CAPABILITY_VERBS, CREDENTIAL_HANDLE_PATTERN, GATE_VOCABULARY_VERSION, INFER_TIERS, PUBLISH_TARGETS, SHELL_CWDS, SKILL_SCOPES, fromActionCapability,
  parseCapability, parseHostPattern, parsePathPattern
} from '../domain/gate/vocabulary';
import type { ActionMapping } from '../domain/gate/vocabulary';
import { matchesGlob as agentMatchesGlob } from '../agent/glob';
import { globToRegExp, matchesGlob } from '../domain/glob';
import type { ActionCapability } from '../domain/policy';
import type { CapabilityMode } from '../domain/gate/vocabulary';

function request(value: unknown, mode: CapabilityMode = 'request') {
  return parseCapability(value, { vocabulary: GATE_VOCABULARY_VERSION, mode });
}

function canonicalOf(value: unknown, mode: CapabilityMode = 'request'): string {
  const parsed = request(value, mode);
  assert.ok(parsed.ok, parsed.ok ? '' : `${parsed.reason} ${parsed.path}`);
  return canonicalize(parsed.value);
}

function reasonOf(value: unknown, mode: CapabilityMode = 'request'): GateShapeFailure | 'accepted' {
  const parsed = request(value, mode);
  return parsed.ok ? 'accepted' : parsed.reason;
}

test('the vocabulary is version 1 and the shape failures are a closed list of plain sentences', () => {
  assert.equal(GATE_VOCABULARY_VERSION, 1);
  assert.deepEqual(Object.keys(GATE_SHAPE_FAILURES).sort(), [
    'duplicate', 'empty-list', 'missing-field', 'not-allowed-here', 'not-available-yet', 'not-sorted', 'unknown-field', 'unknown-verb',
    'unknown-version', 'wrong-type'
  ]);
  for (const sentence of Object.values(GATE_SHAPE_FAILURES)) {
    assert.match(sentence, /^[A-Z][^\u2014\u2013]*\.$/, 'one plain sentence, no em-dash');
  }
  assert.equal(CAPABILITY_VERBS.length, 16);
});

test('read parses with project-relative patterns and plan parses with no fields', () => {
  assert.equal(canonicalOf({ verb: 'read', paths: ['src/**'] }), '{"paths":["src/**"],"verb":"read"}');
  assert.equal(canonicalOf({ verb: 'plan' }), '{"verb":"plan"}');
  assert.equal(canonicalOf({ verb: 'read', paths: ['./src//a.ts', 'docs/'] }), '{"paths":["src/a.ts","docs"],"verb":"read"}');
});

test('an unknown verb, an unknown field, a missing field and a wrong type are each refused with one reason', () => {
  assert.equal(reasonOf({ verb: 'delete' }), 'unknown-verb');
  assert.equal(reasonOf({ verb: 'read', paths: ['src/**'], mode: 'write' }), 'unknown-field');
  assert.equal(reasonOf({ verb: 'plan', paths: ['src/**'] }), 'unknown-field');
  assert.equal(reasonOf({ paths: ['src/**'] }), 'missing-field');
  assert.equal(reasonOf({ verb: 'read' }), 'missing-field');
  assert.equal(reasonOf({ verb: 7 }), 'wrong-type');
  assert.equal(reasonOf({ verb: 'read', paths: 'src/**' }), 'wrong-type');
  assert.equal(reasonOf({ verb: 'read', paths: [3] }), 'wrong-type');
  assert.equal(reasonOf('read'), 'wrong-type');
  assert.equal(reasonOf(null), 'wrong-type');
  assert.equal(reasonOf(['read']), 'wrong-type');
});

test('an empty list is refused and so is the same pattern twice', () => {
  assert.equal(reasonOf({ verb: 'read', paths: [] }), 'empty-list');
  assert.equal(reasonOf({ verb: 'read', paths: ['src/a', './src/a'] }), 'duplicate');
});

test('path patterns refuse a parent segment, a leading slash, a backslash, a drive letter and control characters', () => {
  for (const bad of ['../x', 'a/../b', '/etc', '//x', '..', '{a,../b}', 'a\\b', 'C:/x', 'a\u0000b', 'a\nb']) {
    assert.equal(reasonOf({ verb: 'read', paths: [bad] }), 'not-allowed-here', JSON.stringify(bad));
  }
  for (const bad of ['', '.', './', '././']) {
    assert.equal(reasonOf({ verb: 'read', paths: [bad] }), 'wrong-type', JSON.stringify(bad));
  }
  const kept = parsePathPattern('src/**/{a,b}.ts', 'p');
  assert.ok(kept.ok);
  assert.equal(kept.value, 'src/**/{a,b}.ts');
});

test('a vocabulary version other than 1 is refused, in both modes', () => {
  for (const vocabulary of [0, 2, 1.5, Number.NaN]) {
    const parsed = parseCapability({ verb: 'plan' }, { vocabulary, mode: 'request' });
    assert.ok(!parsed.ok);
    assert.equal(parsed.reason, 'unknown-version');
  }
});

test('a refusal names its reason in plain words and a safe path', () => {
  const parsed = request({ verb: 'read', paths: ['ok', '../x\u0000'] });
  assert.ok(!parsed.ok);
  assert.equal(parsed.reason, 'not-allowed-here');
  assert.equal(parsed.path, 'paths[1]');
  assert.equal(parsed.message, `${GATE_SHAPE_FAILURES['not-allowed-here']} (at paths[1])`);
  const hostile = request({ verb: 'plan', ['bad\nkey<script>']: 1 });
  assert.ok(!hostile.ok);
  assert.match(hostile.path, /^[A-Za-z0-9_.[\]?-]*$/);
});

test('hostile prototype keys are refused as unknown fields and never reach the result', () => {
  const polluted = JSON.parse('{"verb":"read","paths":["src/**"],"__proto__":{"verb":"plan"}}') as unknown;
  assert.equal(reasonOf(polluted), 'unknown-field');
  const constructorKey = JSON.parse('{"verb":"plan","constructor":{"prototype":{"x":1}}}') as unknown;
  assert.equal(reasonOf(constructorKey), 'unknown-field');
  assert.equal(({} as Record<string, unknown>).x, undefined);
  class Custom { public verb = 'plan'; }
  assert.equal(reasonOf(new Custom()), 'wrong-type');
});

test('parsing is pure: the same input twice, interleaved, or after a refused call gives a byte-identical result', () => {
  const input = { verb: 'read', paths: ['src/**', 'docs/*.md'] };
  const first = canonicalOf(input);
  assert.equal(reasonOf({ verb: 'read', paths: [] }), 'empty-list');
  const second = canonicalOf(input);
  const results = [1, 2, 3, 4].map(() => canonicalOf(JSON.parse(JSON.stringify(input))));
  assert.deepEqual([first, second, ...results].filter((one) => one !== first), []);
  assert.equal(first, '{"paths":["src/**","docs/*.md"],"verb":"read"}');
});

interface VerbCase {
  readonly verb: string;
  readonly valid: unknown;
  readonly mode?: CapabilityMode;
  /** Frozen canonical vector: a literal, so any change to what v1 means fails loudly. */
  readonly canonical: string;
  readonly refused: ReadonlyArray<readonly [unknown, GateShapeFailure]>;
}

const VERB_CASES: readonly VerbCase[] = [
  { verb: 'read', valid: { verb: 'read', paths: ['src/**'] }, canonical: '{"paths":["src/**"],"verb":"read"}',
    refused: [[{ verb: 'read', paths: [] }, 'empty-list'], [{ verb: 'read', paths: ['../x'] }, 'not-allowed-here']] },
  { verb: 'plan', valid: { verb: 'plan' }, canonical: '{"verb":"plan"}',
    refused: [[{ verb: 'plan', note: 'x' }, 'unknown-field'], [{ verb: 'plan', paths: [] }, 'unknown-field']] },
  { verb: 'workspaceWrite', valid: { verb: 'workspaceWrite', paths: ['src/**', 'docs/*.md'] },
    canonical: '{"paths":["src/**","docs/*.md"],"verb":"workspaceWrite"}',
    refused: [[{ verb: 'workspaceWrite', paths: [] }, 'empty-list'], [{ verb: 'workspaceWrite', paths: ['/etc/passwd'] }, 'not-allowed-here'], [{ verb: 'workspaceWrite' }, 'missing-field']] },
  { verb: 'shell', valid: { verb: 'shell', cwd: 'workspace' }, canonical: '{"cwd":"workspace","verb":"shell"}',
    refused: [[{ verb: 'shell', cwd: 'home' }, 'not-allowed-here'], [{ verb: 'shell' }, 'missing-field'], [{ verb: 'shell', cwd: 3 }, 'wrong-type']] },
  { verb: 'network', valid: { verb: 'network', hosts: ['api.example.com'] }, canonical: '{"hosts":["api.example.com"],"verb":"network"}',
    refused: [[{ verb: 'network', hosts: [] }, 'empty-list'], [{ verb: 'network', hosts: ['https://example.com'] }, 'wrong-type'], [{ verb: 'network', hosts: ['Example.com'] }, 'wrong-type']] },
  { verb: 'mcp', valid: { verb: 'mcp', server: 'files', tools: ['read_file'] }, canonical: '{"server":"files","tools":["read_file"],"verb":"mcp"}',
    refused: [[{ verb: 'mcp', server: 'files', tools: [] }, 'empty-list'], [{ verb: 'mcp', server: '', tools: ['a'] }, 'wrong-type'], [{ verb: 'mcp', server: 'files' }, 'missing-field']] },
  { verb: 'send', valid: { verb: 'send', channel: 'team-chat' }, canonical: '{"channel":"team-chat","verb":"send"}',
    refused: [[{ verb: 'send', channel: 5 }, 'wrong-type'], [{ verb: 'send', channel: '*' }, 'not-allowed-here']] },
  { verb: 'publish', valid: { verb: 'publish', target: 'git-remote' }, canonical: '{"target":"git-remote","verb":"publish"}',
    refused: [[{ verb: 'publish', target: 'mailing-list' }, 'not-allowed-here'], [{ verb: 'publish', target: 1 }, 'wrong-type']] },
  { verb: 'destroy', valid: { verb: 'destroy', paths: ['build/**'] }, canonical: '{"paths":["build/**"],"verb":"destroy"}',
    refused: [[{ verb: 'destroy', paths: [] }, 'empty-list'], [{ verb: 'destroy', paths: ['a/../../b'] }, 'not-allowed-here']] },
  { verb: 'spawn', valid: { verb: 'spawn', agent: 'reviewer' }, canonical: '{"agent":"reviewer","verb":"spawn"}',
    refused: [[{ verb: 'spawn' }, 'missing-field'], [{ verb: 'spawn', agent: 'rev*' }, 'not-allowed-here']] },
  { verb: 'schedule', valid: { verb: 'schedule', maxPerDay: 4 }, canonical: '{"maxPerDay":4,"verb":"schedule"}',
    refused: [[{ verb: 'schedule', maxPerDay: 2.5 }, 'wrong-type'], [{ verb: 'schedule', every: 'day' }, 'unknown-field']] },
  { verb: 'skill.write', valid: { verb: 'skill.write', scope: 'team' }, canonical: '{"scope":"team","verb":"skill.write"}',
    refused: [[{ verb: 'skill.write', scope: 'world' }, 'not-allowed-here'], [{ verb: 'skill.write' }, 'missing-field']] },
  { verb: 'spend', valid: { verb: 'spend', nanoUsdPerRun: 5_000_000_000, nanoUsdPerDay: Number.MAX_SAFE_INTEGER },
    canonical: '{"nanoUsdPerDay":9007199254740991,"nanoUsdPerRun":5000000000,"verb":"spend"}',
    refused: [[{ verb: 'spend' }, 'missing-field'], [{ verb: 'spend', usd: 5 }, 'unknown-field']] },
  { verb: 'useSecret', valid: { verb: 'useSecret', handle: 'github.token', audience: 'api.example.com' },
    canonical: '{"audience":"api.example.com","handle":"github.token","verb":"useSecret"}',
    refused: [[{ verb: 'useSecret', handle: 'GitHub Token' }, 'wrong-type'], [{ verb: 'useSecret' }, 'missing-field']] },
  { verb: 'infer', valid: { verb: 'infer', tier: 'attested-cloud', provider: 'near-ai', model: 'deepseek-v3' },
    canonical: '{"model":"deepseek-v3","provider":"near-ai","tier":"attested-cloud","verb":"infer"}',
    refused: [[{ verb: 'infer', tier: 'deny', provider: 'near-ai', model: 'm' }, 'not-allowed-here'], [{ verb: 'infer', tier: 'local-only', provider: 'near-ai' }, 'missing-field']] },
  { verb: 'gpu', valid: { verb: 'gpu', device: 'cuda:0' }, canonical: 'not-available-yet',
    refused: [[{ verb: 'gpu' }, 'missing-field'], [{ verb: 'gpu', device: 'cuda:0', count: 2 }, 'unknown-field']] }
];

test('every one of the sixteen verbs has a case, one valid input with a frozen canonical vector, and at least two refusals', () => {
  assert.deepEqual(VERB_CASES.map((one) => one.verb), [...CAPABILITY_VERBS]);
  assert.equal(VERB_CASES.length, 16);
  for (const one of VERB_CASES) {
    assert.ok(one.refused.length >= 2, one.verb);
    if (one.verb === 'gpu') {
      assert.equal(reasonOf(one.valid, 'request'), 'not-available-yet');
      assert.equal(reasonOf(one.valid, 'ceiling'), 'not-available-yet');
    } else {
      assert.equal(canonicalOf(one.valid, one.mode ?? 'request'), one.canonical, one.verb);
      assert.equal(canonicalOf(one.valid, 'ceiling'), one.canonical, `${one.verb} in a ceiling`);
    }
    for (const [input, reason] of one.refused) assert.equal(reasonOf(input), reason, `${one.verb}: ${JSON.stringify(input)}`);
  }
});

test('the closed lists of v1 are exactly as written', () => {
  assert.deepEqual([...SHELL_CWDS], ['workspace', 'anywhere']);
  assert.deepEqual([...PUBLISH_TARGETS], ['git-remote', 'registry', 'container-registry', 'release', 'deploy', 'chain', '*']);
  assert.deepEqual([...SKILL_SCOPES], ['run', 'project', 'team', 'user']);
  assert.deepEqual([...INFER_TIERS], ['any-cloud', 'attested-cloud', 'local-only']);
  assert.deepEqual([...CAPABILITY_VERBS], [
    'read', 'plan', 'workspaceWrite', 'shell', 'network', 'mcp', 'send', 'publish', 'destroy', 'spawn', 'schedule', 'skill.write', 'spend', 'useSecret', 'infer', 'gpu'
  ]);
  for (const cwd of SHELL_CWDS) assert.equal(canonicalOf({ verb: 'shell', cwd }), `{"cwd":"${cwd}","verb":"shell"}`);
  for (const scope of SKILL_SCOPES) assert.equal(canonicalOf({ verb: 'skill.write', scope }, 'ceiling'), `{"scope":"${scope}","verb":"skill.write"}`);
  for (const tier of INFER_TIERS) assert.equal(reasonOf({ verb: 'infer', tier, provider: 'p', model: 'm' }), 'accepted');
  for (const target of PUBLISH_TARGETS.filter((one) => one !== '*')) assert.equal(reasonOf({ verb: 'publish', target }), 'accepted');
});

test('spend takes whole nano-USD only: a fraction, a negative number, negative zero, a number past 2^53 and a string are refused', () => {
  assert.equal(canonicalOf({ verb: 'spend', nanoUsdPerRun: 5_000_000_000 }), '{"nanoUsdPerRun":5000000000,"verb":"spend"}');
  assert.equal(canonicalOf({ verb: 'spend', nanoUsdPerDay: 0 }), '{"nanoUsdPerDay":0,"verb":"spend"}');
  for (const bad of [1.5, -1, -0, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
    assert.equal(reasonOf({ verb: 'spend', nanoUsdPerRun: bad }), 'wrong-type', `per run ${String(bad)}`);
    assert.equal(reasonOf({ verb: 'spend', nanoUsdPerDay: bad }), 'wrong-type', `per day ${String(bad)}`);
    assert.equal(reasonOf({ verb: 'spend', nanoUsdPerRun: 1, nanoUsdPerDay: bad }), 'wrong-type');
  }
  assert.equal(reasonOf({ verb: 'spend', nanoUsdPerRun: undefined }), 'wrong-type');
  assert.equal(reasonOf({ verb: 'spend', usd: 0.5 }), 'unknown-field');
  assert.equal(reasonOf({ verb: 'schedule', maxPerDay: 0.5 }), 'wrong-type');
  assert.equal(reasonOf({ verb: 'schedule', maxPerDay: -3 }), 'wrong-type');
});

test('a useSecret handle must be a short lowercase name and must not look like a secret', () => {
  assert.equal(reasonOf({ verb: 'useSecret', handle: 'sk-live-abc' }), 'not-allowed-here');
  assert.equal(reasonOf({ verb: 'useSecret', handle: 'sk-live-abc', audience: 'api.example.com' }), 'not-allowed-here');
  assert.equal(reasonOf({ verb: 'useSecret', handle: 'github.token' }), 'accepted');
  assert.equal(reasonOf({ verb: 'useSecret', handle: 'Github' }), 'wrong-type');
  assert.equal(reasonOf({ verb: 'useSecret', handle: '1token' }), 'wrong-type');
  assert.equal(reasonOf({ verb: 'useSecret', handle: 'a'.repeat(65) }), 'wrong-type');
  assert.equal(reasonOf({ verb: 'useSecret', handle: 'a'.repeat(64) }), 'accepted');
  assert.equal(CREDENTIAL_HANDLE_PATTERN.source, '^[a-z][a-z0-9._-]{0,63}$');
});

test('every wildcard is refused in a concrete request and accepted in a ceiling', () => {
  const wildcards: unknown[] = [
    { verb: 'network', hosts: ['*'] },
    { verb: 'network', hosts: ['*.example.com'] },
    { verb: 'mcp', server: '*', tools: ['a'] },
    { verb: 'mcp', server: 'files', tools: ['*'] },
    { verb: 'spawn', agent: '*' },
    { verb: 'publish', target: '*' },
    { verb: 'infer', tier: 'any-cloud', provider: '*', model: 'm' },
    { verb: 'infer', tier: 'any-cloud', provider: 'p', model: '*' },
    { verb: 'useSecret', handle: 'github.token', audience: '*' }
  ];
  for (const wildcard of wildcards) {
    assert.equal(reasonOf(wildcard, 'request'), 'not-allowed-here', JSON.stringify(wildcard));
    assert.equal(reasonOf(wildcard, 'ceiling'), 'accepted', JSON.stringify(wildcard));
  }
  // A star inside a longer name, or in a place the grammar gives no wildcard, is refused in both modes.
  for (const mode of ['request', 'ceiling'] as const) {
    assert.equal(reasonOf({ verb: 'mcp', server: 'fi*', tools: ['a'] }, mode), 'not-allowed-here');
    assert.equal(reasonOf({ verb: 'send', channel: '*' }, mode), 'not-allowed-here');
    assert.equal(reasonOf({ verb: 'gpu', device: '*' }, mode), 'not-allowed-here');
    assert.equal(reasonOf({ verb: 'network', hosts: ['a.*.com'] }, mode), 'wrong-type');
  }
  // Path patterns are globs in both modes: a concrete file path is also a valid pattern.
  assert.equal(reasonOf({ verb: 'read', paths: ['src/**'] }, 'request'), 'accepted');
});

test('host patterns are lowercase hosts with no scheme, port or path', () => {
  const host = (value: unknown, mode: CapabilityMode = 'ceiling') => parseHostPattern(value, 'h', mode);
  for (const good of ['example.com', 'api.example.com', 'localhost', '127.0.0.1', 'a-b.example.com', '*', '*.example.com']) assert.ok(host(good).ok, good);
  for (const bad of ['', 'Example.com', 'example.com:443', 'https://example.com', 'example.com/path', '-a.com', 'a..com', 'a b.com', '*.', 'a'.repeat(64) + '.com', 7]) {
    const parsed = host(bad);
    assert.ok(!parsed.ok && parsed.reason === 'wrong-type', String(bad));
  }
});

test('gpu parses its shape and is then always refused as not available yet', () => {
  const parsed = request({ verb: 'gpu', device: 'cuda:0' });
  assert.ok(!parsed.ok);
  assert.equal(parsed.reason, 'not-available-yet');
  assert.equal(parsed.message, `${GATE_SHAPE_FAILURES['not-available-yet']} (at verb)`);
});

test('the glob matcher moved under src/domain and src/agent still re-exports the same functions', () => {
  assert.equal(agentMatchesGlob, matchesGlob);
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'));
  assert.equal(matchesGlob('**/*.ts', 'src/agent/loop.ts'), true);
  assert.equal(matchesGlob('*.{ts,js}', 'media/chat/chat.js'), true);
  assert.equal(matchesGlob('src/*.ts', 'src/agent/loop.ts'), false);
});

function canonicalMapping(mapping: ActionMapping): string {
  return JSON.stringify({ capabilities: mapping.capabilities.map((one) => canonicalize(one)), floorRule: mapping.floorRule ?? null });
}

test('fromActionCapability maps all nine shorthands one way into vocabulary capabilities, in the widest honest ceiling form', () => {
  const expected: Record<ActionCapability, { capabilities: string[]; floorRule: string | null }> = {
    read: { capabilities: ['{"paths":["**"],"verb":"read"}'], floorRule: null },
    plan: { capabilities: ['{"verb":"plan"}'], floorRule: null },
    workspaceWrite: { capabilities: ['{"paths":["**"],"verb":"workspaceWrite"}'], floorRule: null },
    sharedWrite: { capabilities: ['{"scope":"team","verb":"skill.write"}'], floorRule: 'floor.shared-write' },
    shell: { capabilities: ['{"cwd":"anywhere","verb":"shell"}'], floorRule: null },
    network: { capabilities: ['{"hosts":["*"],"verb":"network"}'], floorRule: null },
    gitMutation: { capabilities: ['{"cwd":"workspace","verb":"shell"}', '{"paths":[".git/**"],"verb":"workspaceWrite"}'], floorRule: null },
    mediaGeneration: {
      capabilities: ['{"model":"*","provider":"*","tier":"any-cloud","verb":"infer"}', '{"paths":["**"],"verb":"workspaceWrite"}'],
      floorRule: null
    },
    mediaPublication: { capabilities: ['{"target":"*","verb":"publish"}'], floorRule: null }
  };
  assert.deepEqual(Object.keys(expected).sort(), [
    'gitMutation', 'mediaGeneration', 'mediaPublication', 'network', 'plan', 'read', 'sharedWrite', 'shell', 'workspaceWrite'
  ]);
  for (const [shorthand, want] of Object.entries(expected) as Array<[ActionCapability, { capabilities: string[]; floorRule: string | null }]>) {
    assert.equal(canonicalMapping(fromActionCapability(shorthand)), JSON.stringify(want), shorthand);
  }
});

test('fromActionCapability uses the facts it is given, and falls back to the widest form when a fact does not parse, never to nothing', () => {
  const specific = fromActionCapability('workspaceWrite', { paths: ['src/**'] });
  assert.equal(canonicalize(specific.capabilities[0]), '{"paths":["src/**"],"verb":"workspaceWrite"}');
  assert.equal(canonicalize(fromActionCapability('network', { hosts: ['api.example.com'] }).capabilities[0]), '{"hosts":["api.example.com"],"verb":"network"}');
  assert.equal(canonicalize(fromActionCapability('shell', { cwd: 'workspace' }).capabilities[0]), '{"cwd":"workspace","verb":"shell"}');
  assert.equal(canonicalize(fromActionCapability('mediaGeneration', { provider: 'near-ai', model: 'flux' }).capabilities[0]),
    '{"model":"flux","provider":"near-ai","tier":"any-cloud","verb":"infer"}');
  assert.equal(canonicalize(fromActionCapability('read', { paths: ['../escape'] }).capabilities[0]), '{"paths":["**"],"verb":"read"}');
  assert.equal(canonicalize(fromActionCapability('network', { hosts: ['Not A Host'] }).capabilities[0]), '{"hosts":["*"],"verb":"network"}');
  for (const shorthand of ['read', 'plan', 'workspaceWrite', 'sharedWrite', 'shell', 'network', 'gitMutation', 'mediaGeneration', 'mediaPublication'] as const) {
    assert.ok(fromActionCapability(shorthand).capabilities.length >= 1, shorthand);
  }
});

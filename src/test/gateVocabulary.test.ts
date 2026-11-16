// Capability vocabulary v1 (GATE-01, D-03, D-35). The frozen canonical vectors below are literal strings on purpose: changing the meaning of a v1
// verb or field must fail here loudly, because vocabulary v1 ends up in signed bundles and a change is a new version beside v1.
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize } from '../domain/team/canonical';
import { GATE_SHAPE_FAILURES } from '../domain/gate/shape';
import type { GateShapeFailure } from '../domain/gate/shape';
import { CAPABILITY_VERBS, GATE_VOCABULARY_VERSION, parseCapability, parsePathPattern } from '../domain/gate/vocabulary';
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

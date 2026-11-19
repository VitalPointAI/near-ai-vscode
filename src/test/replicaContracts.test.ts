// Shared contracts the wave-3 plans build on (plan 30-02, tasks 2 and 3): the schema dispatch, the causal relations, the static roster view and
// the Yjs snapshot functions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_UPDATE_BYTES } from '../domain/replica/kindSchemas/doc';
import { REPLICA_KINDS, SCHEMA_PENDING, validateData } from '../domain/replica/kinds';
import { createWorld, updateData } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';

test('every known kind except doc.client and doc.update fails closed with the schema-pending reason', () => {
  const others = REPLICA_KINDS.filter((kind) => kind !== 'doc.client' && kind !== 'doc.update');
  assert.equal(others.length, 48);
  for (const kind of others) {
    const check = validateData(kind, {});
    assert.equal(check.ok, false, kind);
    if (!check.ok) assert.ok(check.reason.startsWith(SCHEMA_PENDING), `${kind}: ${check.reason}`);
  }
});

test('valid doc.client and doc.update samples still validate, and the invalid ones fail with a path in the reason', () => {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }] });
  const update = updateData(PRODUCT, world.editor('A', PRODUCT, 101).insertUpdate(0, 'Hello'));
  assert.deepEqual(validateData('doc.client', { product: PRODUCT, clientId: 101, actor: { kind: 'person' } }), { ok: true });
  assert.deepEqual(validateData('doc.update', update), { ok: true });
  const refusals: Array<[string, unknown, string]> = [
    ['doc.client', { product: PRODUCT, clientId: 101, actor: { kind: 'person' }, extra: 1 }, 'data'],
    ['doc.client', { product: PRODUCT, actor: { kind: 'person' } }, 'data'],
    ['doc.client', { product: PRODUCT, clientId: 0, actor: { kind: 'person' } }, 'data.clientId'],
    ['doc.client', { product: PRODUCT, clientId: 4294967296, actor: { kind: 'person' } }, 'data.clientId'],
    ['doc.client', { product: 'Bad Name', clientId: 5, actor: { kind: 'person' } }, 'data.product'],
    ['doc.update', { product: PRODUCT, update: update.update, extra: true }, 'data'],
    ['doc.update', { product: PRODUCT }, 'data'],
    ['doc.update', { product: PRODUCT, update: 'not base64url!' }, 'data.update'],
    ['doc.update', { product: PRODUCT, update: '' }, 'data.update'],
    ['doc.update', 'text', 'data']
  ];
  for (const [kind, data, path] of refusals) {
    const check = validateData(kind, data);
    assert.equal(check.ok, false, `${kind} ${JSON.stringify(data).slice(0, 60)}`);
    if (!check.ok) {
      assert.ok(check.reason.startsWith('bad-data:'), check.reason);
      assert.ok(check.reason.includes(path), `${check.reason} should name ${path}`);
    }
  }
  const huge = Buffer.alloc(MAX_UPDATE_BYTES + 1, 1).toString('base64url');
  assert.equal(validateData('doc.update', { product: PRODUCT, update: huge }).ok, false);
});

test('validateData dispatches each family to its own file: the reason names the family of the kind', () => {
  const expected: Array<[string, string]> = [
    ['project.genesis', 'project'], ['member.admit', 'roster'], ['doc.compact', 'doc'], ['product.create', 'versions'], ['register.row', 'registers'],
    ['watch.define', 'watches'], ['run.start', 'runs'], ['obs.segment', 'obs'], ['digest.report', 'integrity']
  ];
  for (const [kind, family] of expected) {
    const check = validateData(kind, {});
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.reason, `${SCHEMA_PENDING}: ${family} ${kind}`);
  }
  assert.equal(validateData('no.such.kind', {}).ok, false);
});

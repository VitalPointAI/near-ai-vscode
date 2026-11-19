// Attribution of co-edited text (plan 30-06, D-20): every character names the writer, person, agent and run that typed it, from signed client
// registrations only, in any delivery order. The tracer test is the J2 scene; the property test at the end runs random concurrent histories.
import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeText, summariseAuthors, UNATTRIBUTED_WRITER } from '../domain/replica/attribution';
import type { AttributionRegistration, AuthorSpan } from '../domain/replica/attribution';
import { applyRemote, applyUpdate, attributionAtSnapshot, attributionRuns, createFoldDoc, createLocalDoc, docText, encodeFullState, localDelete, localInsert, snapshotOf } from '../domain/replica/doc';
import type { Actor } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { createWorld, rng, shuffled } from './helpers/replicaWorld';
import type { Editor, Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const AGENT: Actor = { kind: 'agent', member: 'j2-analyst', run: 'r-14' };

function productOf(result: ReturnType<typeof foldEntries>): ProductTextOutput {
  const products = result.families.doc as ProductTextOutput[];
  assert.equal(products.length, 1);
  return products[0];
}

// The J2 scene: the chief types, an agent run on the chief's machine continues, and a second person types at the end at the same time.
function j2Scene() {
  const world = createWorld({ members: [{ member: 'mbr-pppp', name: 'Chief', devices: ['P'] }, { member: 'mbr-qqqq', name: 'Analyst', devices: ['Q'] }] });
  const person = world.editor('P', PRODUCT, 11);
  const agent = world.editor('P', PRODUCT, 12);
  const other = world.editor('Q', PRODUCT, 21);
  const registrations = [person.register(), agent.register({ actor: AGENT }), other.register()];
  const first = person.insert(0, 'Estimate: ');
  applyRemote(agent.doc, encodeFullState(person.doc));
  applyRemote(other.doc, encodeFullState(person.doc));
  const second = agent.insert(10, 'enemy holds the ridge', { actor: AGENT });
  const third = other.insert(10, ' (confirmed)');
  return { world, registrations, updates: [first, second, third] };
}

const sealed = (items: readonly Written[]) => items.map((item) => item.entry);

test('a person and an agent run co-edit one product and every character names the writer, member and run that typed it', () => {
  const { world, registrations, updates } = j2Scene();
  const result = foldEntries(sealed([...registrations, ...updates]), world.ctx());
  assert.deepEqual([result.held, result.rejected, result.refused, result.kept], [[], [], [], []]);
  const product = productOf(result);
  assert.equal(product.text, 'Estimate: enemy holds the ridge (confirmed)');
  const writerP = world.writerOf('P');
  const writerQ = world.writerOf('Q');
  assert.deepEqual(product.attribution, [
    { start: 0, length: 10, clientId: 11, writer: writerP, member: 'mbr-pppp', actor: 'person' },
    { start: 10, length: 21, clientId: 12, writer: writerP, member: 'mbr-pppp', actor: 'agent', agentMember: 'j2-analyst', run: 'r-14' },
    { start: 31, length: 12, clientId: 21, writer: writerQ, member: 'mbr-qqqq', actor: 'person' }
  ]);
  assert.equal(product.attribution.reduce((sum, span) => sum + span.length, 0), product.text.length);
  assert.equal(product.attribution.some((span) => span.writer === UNATTRIBUTED_WRITER), false);
});

test('summariseAuthors gives three rows whose character counts add up to the text length', () => {
  const { world, registrations, updates } = j2Scene();
  const product = productOf(foldEntries(sealed([...registrations, ...updates]), world.ctx()));
  const rows = summariseAuthors(product.attribution);
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((sum, row) => sum + row.characters, 0), product.text.length);
  const byRun = Object.fromEntries(rows.map((row) => [row.run ?? row.actor, row]));
  assert.equal(byRun['r-14'].characters, 21);
  assert.equal(byRun['r-14'].agentMember, 'j2-analyst');
  assert.equal(byRun['r-14'].member, 'mbr-pppp');
  assert.equal(rows.filter((row) => row.actor === 'person').map((row) => row.characters).sort((a, b) => a - b).join(','), '10,12');
});

test('the attribution and digest are identical when the entries are delivered in reverse, shuffled and doubled order', () => {
  const { world, registrations, updates } = j2Scene();
  const all = [...registrations, ...updates];
  const reference = foldEntries(sealed(all), world.ctx());
  const random = rng(14);
  const variants = [sealed([...all].reverse()), sealed(shuffled(all, random)), [...sealed(shuffled(all, random)), ...sealed(shuffled(all, random))]];
  for (const variant of variants) {
    const result = foldEntries(variant, world.ctx());
    assert.deepEqual(productOf(result).attribution, productOf(reference).attribution);
    assert.deepEqual(result.digests, reference.digests);
    assert.equal(productOf(result).text, productOf(reference).text);
  }
});

test('attributeText joins neighbouring runs of one client, covers every character once, and marks a client nobody registered', () => {
  const registrations: AttributionRegistration[] = [
    { clientId: 1, writer: 'w-a', member: 'mbr-a', actor: { kind: 'person' } },
    { clientId: 2, writer: 'w-b', member: 'mbr-b', actor: { kind: 'agent', member: 'agent-x', run: 'run-9' } }
  ];
  const spans = attributeText([{ client: 1, length: 3 }, { client: 1, length: 2 }, { client: 2, length: 4 }, { client: 1, length: 1 }, { client: 9, length: 2 }], registrations);
  assert.deepEqual(spans.map((span) => [span.start, span.length, span.clientId]), [[0, 5, 1], [5, 4, 2], [9, 1, 1], [10, 2, 9]]);
  assert.equal(spans[1].run, 'run-9');
  assert.equal(spans[3].writer, UNATTRIBUTED_WRITER);
  assert.deepEqual(attributeText([], registrations), []);
});

test('the walk over a document reads only visible text and joins items of one client with consecutive clocks', () => {
  const doc = createLocalDoc(5);
  localInsert(doc, 0, 'hello ');
  localInsert(doc, 6, 'world');
  localDelete(doc, 0, 2);
  assert.deepEqual(attributionRuns(doc), [{ client: 5, clock: 2, length: 9, text: 'llo world' }]);
  assert.equal(docText(doc), 'llo world');
});

test('attributionAtSnapshot names the authors of the text as it was, and is undefined when the updates do not reach the snapshot', () => {
  const a = createLocalDoc(31);
  const b = createLocalDoc(32);
  const u1 = localInsert(a, 0, 'one ');
  applyRemote(b, u1);
  const u2 = localInsert(b, 4, 'two');
  applyRemote(a, u2);
  const before = snapshotOf(a);
  const u3 = localDelete(a, 0, 4);
  const runsThen = attributionAtSnapshot([u1, u2, u3], before);
  assert.deepEqual(runsThen?.map((run) => [run.client, run.text]), [[31, 'one '], [32, 'two']]);
  assert.equal(attributionAtSnapshot([u1], before), undefined);
  const now = createFoldDoc();
  for (const update of [u1, u2, u3]) applyUpdate(now, update);
  assert.deepEqual(attributionRuns(now).map((run) => [run.client, run.text]), [[32, 'two']]);
});

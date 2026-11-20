// The whole replica core through the default fold (plan 30-12, D-07, D-09): one staff scenario that touches every family Phase 30 folds, and the gate that
// no kind is still answered by the 30-02 schema-pending stub. The fold is called with no reducers option, so DEFAULT_REDUCERS decides what is folded.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRemote, encodeFullState, snapshotOf, docText } from '../domain/replica/doc';
import type { Actor, SealedEntry } from '../domain/replica/entry';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { REPLICA_KINDS, SCHEMA_PENDING, validateData } from '../domain/replica/kinds';
import { DEFAULT_REDUCERS } from '../domain/replica/reducers';
import type { ProductTextOutput } from '../domain/replica/textFold';
import type { ProductVersions } from '../domain/replica/versions';
import { replicaVersionHash } from '../domain/replica/versions';
import type { ProjectOutput } from '../domain/replica/projectFold';
import type { IntegrityOutput } from '../domain/replica/integrityFold';
import { canonicalBytes } from '../domain/team/canonical';
import { sealBlob } from '../domain/replica/entry';
import { createWorld, shuffled, rng, streamId } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const COMMANDER = 'commander';
const OWNER: Actor = { kind: 'agent', member: 'j2-chief', run: 'r-1' };
const TRADECRAFT: Actor = { kind: 'agent', member: 'tradecraft', run: 'r-t' };
const GUARD: Actor = { kind: 'agent', member: 'release-guard', run: 'r-g' };
const ANALYST: Actor = { kind: 'agent', member: 'j2-analyst', run: 'r-14' };
const PERSON: Actor = { kind: 'person' };

interface Scenario { world: ReturnType<typeof createWorld>; entries: SealedEntry[]; hashes: { propose: string; release: string }; text: string; stream: string }

// Two persons and an agent run co-edit one product; the owner's agent proposes v1; the tradecraft and guard agents pass it; the owner side submits it
// for the commander; person C approves and releases it.
function scenario(): Scenario {
  const world = createWorld({
    members: [
      { member: 'mbr-lead', roles: ['member', 'staff_lead'], devices: ['LEAD'] },
      { member: 'mbr-p', name: 'Pat', roles: ['member', 'answers_for:j2'], devices: ['P'] },
      { member: 'mbr-q', name: 'Quinn', roles: ['member'], devices: ['Q'] },
      { member: 'mbr-sl', roles: ['member', 'section_lead:j2'], devices: ['SL'] },
      { member: 'mbr-c', name: 'Col Cee', roles: ['member', `decision_for:${COMMANDER}`], devices: ['C'] }
    ]
  });
  const genesis = world.write('LEAD', {
    kind: 'project.genesis',
    data: { project: world.stream, name: 'Staff exercise', profile: 'staff', labelMapHash: 'a'.repeat(64), lead: { member: 'mbr-lead', writer: world.writerOf('LEAD') } }
  });
  const create = world.write('LEAD', {
    kind: 'product.create',
    deps: [genesis],
    data: { product: PRODUCT, section: 'j2', roles: { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard', tradecraftReviewer: 'tradecraft' }, title: 'Intel estimate' }
  });
  const p = world.editor('P', PRODUCT, 101);
  const q = world.editor('Q', PRODUCT, 202);
  const agent = world.editor('P', PRODUCT, 303);
  const pReg = p.register({ deps: [create] });
  const pTyped = p.insert(0, 'Hello world', { deps: [pReg] });
  // Q and the agent run start from P's text; the agent run is on P's device under its own client id.
  applyRemote(q.doc, encodeFullState(p.doc));
  applyRemote(agent.doc, encodeFullState(p.doc));
  const qReg = q.register({ deps: [pTyped] });
  const qTyped = q.insert(11, ' today', { deps: [qReg] });
  const aReg = agent.register({ deps: [pTyped], actor: ANALYST });
  const aTyped = agent.insert(0, '> ', { deps: [aReg], actor: ANALYST });
  applyRemote(p.doc, encodeFullState(q.doc));
  applyRemote(p.doc, encodeFullState(agent.doc));
  const text = docText(p.doc);
  const textBlob = sealBlob(world.keyFor(world.stream, 0), world.stream, 0, canonicalBytes({ text, header: { title: 'Intel estimate' } }));
  world.blobs.set(textBlob.hash, textBlob);
  const hash = replicaVersionHash(text, []);
  const propose = world.write('P', {
    kind: 'version.propose',
    actor: OWNER,
    deps: [qTyped, aTyped],
    data: { product: PRODUCT, hash, textBlob: textBlob.hash, snapshot: Buffer.from(snapshotOf(p.doc)).toString('base64url'), pins: [] }
  });
  const verdict = (gate: 'guard' | 'tradecraft', word: string): Record<string, unknown> => ({ product: PRODUCT, hash, gate, verdict: word, reasons: [] });
  const signOff = world.write('SL', { kind: 'version.verdict', actor: TRADECRAFT, deps: [propose], data: verdict('tradecraft', 'SIGN-OFF') });
  const cleared = world.write('SL', { kind: 'version.verdict', actor: GUARD, deps: [signOff], data: verdict('guard', 'CLEARED') });
  const submit = world.write('P', { kind: 'version.submit', actor: OWNER, deps: [cleared], data: { product: PRODUCT, hash, decisionFor: COMMANDER } });
  const approve = world.write('C', { kind: 'version.decide', actor: PERSON, deps: [submit], data: { product: PRODUCT, hash, outcome: 'approve', reasons: [], decisionsSeen: [] } });
  const done: Written = world.write('C', { kind: 'version.release', actor: PERSON, deps: [approve], data: { product: PRODUCT, hash, decisionsSeen: [approve.hash] } });
  return { world, entries: world.entries, hashes: { propose: propose.hash, release: done.hash }, text, stream: world.stream };
}

const versionsOf = (result: FoldResult): ProductVersions => (result.families.versions as ProductVersions[])[0];

test('the default reducers are the four families Phase 30 folds, doc first so versions can read its state', () => {
  assert.deepEqual(DEFAULT_REDUCERS.map((reducer) => reducer.family), ['doc', 'project', 'versions', 'integrity']);
});

test('a whole staff scenario folds through the default reducers to every family, and to the same families and digests in forward and reverse order', () => {
  const s = scenario();
  const ctx = s.world.ctx();
  const forward = foldEntries(s.entries, ctx);
  const backward = foldEntries([...s.entries].reverse(), ctx);
  const incremental = createFoldState(ctx);
  const arrival = shuffled(s.entries, rng(7));
  let state = incremental;
  for (const entry of arrival) state = addEntries(state, [entry]);

  assert.deepEqual([forward.held, forward.rejected, forward.refused, forward.kept, forward.excluded, forward.quarantined], [[], [], [], [], [], []]);
  assert.equal(forward.applied.length, s.entries.length);
  assert.deepEqual(Object.keys(forward.families).sort(), ['doc', 'integrity', 'project', 'versions']);

  const project = forward.families.project as ProjectOutput;
  assert.equal(project.length, 1);
  assert.equal(project[0].project, s.stream);
  assert.equal(project[0].name, 'Staff exercise');
  assert.equal(project[0].lead?.member, 'mbr-lead');

  const text = (forward.families.doc as ProductTextOutput[])[0];
  assert.equal(text.text, s.text);
  assert.ok(text.text.includes('Hello world') && text.text.includes('today') && text.text.includes('> '));

  const product = versionsOf(forward);
  assert.equal(product.product, PRODUCT);
  assert.deepEqual(product.refusals, []);
  assert.equal(product.versions.length, 1);
  const v1 = product.versions[0];
  assert.equal(v1.state, 'released');
  assert.equal(v1.decision.outcome, 'APPROVE');
  assert.deepEqual(v1.decision.names, ['Col Cee']);
  assert.equal(v1.entry, s.hashes.propose);
  // The attribution summary names both persons and the agent run, and counts every character once.
  const rows = v1.attribution.map((row) => [row.member, row.actor, row.run ?? null]);
  assert.deepEqual(new Set(rows.map((row) => row.join('/'))), new Set(['mbr-p/person/', 'mbr-q/person/', 'mbr-p/agent/r-14']));
  assert.equal(v1.attribution.reduce((sum, row) => sum + row.characters, 0), s.text.length);

  assert.deepEqual(forward.families.integrity as IntegrityOutput, []);

  for (const other of [backward, state.result]) {
    assert.deepEqual(other.families, forward.families);
    assert.deepEqual(other.digests, forward.digests);
    assert.deepEqual(other.applied, forward.applied);
    assert.deepEqual(other.order, forward.order);
  }
  assert.equal(Object.keys(forward.digests).length, 1);
  assert.match(forward.digests[s.stream], /^[0-9a-f]{64}$/);
});

test('a later phase kind and an unknown kind are kept beside the scenario and change no digest; another stream changes no family output at all', () => {
  const s = scenario();
  const ctx = s.world.ctx();
  const before = foldEntries(s.entries, ctx);
  const other = s.world.write('Q', { kind: 'future.thing', data: { anything: 2 }, stream: streamId('other') });
  const elsewhere = foldEntries(s.entries, ctx);
  assert.deepEqual(elsewhere.kept.map((item) => item.hash), [other.hash]);
  assert.deepEqual(elsewhere.families, before.families, 'an unrelated stream changes nothing a reducer reports, positions included');
  assert.equal(elsewhere.digests[s.stream], before.digests[s.stream]);

  const claim = s.world.write('P', { kind: 'run.claim', actor: OWNER, data: { run: 'r-1', member: 'j2-chief', target: 'intel-estimate', purpose: 'edit', leaseSeconds: 1200 } });
  const odd = s.world.write('Q', { kind: 'future.thing', data: { anything: 1 } });
  const after = foldEntries(s.entries, ctx);
  assert.deepEqual(after.kept.map((item) => item.hash).sort(), [claim.hash, odd.hash, other.hash].sort());
  assert.equal(after.digests[s.stream], before.digests[s.stream]);
  assert.equal(after.order.length, before.order.length + 3);
});

test('no kind in REPLICA_KINDS is answered by the schema-pending stub', () => {
  for (const kind of REPLICA_KINDS) {
    const check = validateData(kind, {});
    if (!check.ok) assert.ok(!check.reason.startsWith(SCHEMA_PENDING), `${kind} still answers ${check.reason}`);
  }
  assert.ok(REPLICA_KINDS.length >= 40, 'the closed list is the whole list');
});

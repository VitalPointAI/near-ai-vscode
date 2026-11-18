// The release state machine wired to real product files, tested through the real tool surface (design 10, 4.1 tests; WP-SHARED): every allowed
// transition succeeds and is recorded once in the signed ledger and once as events; every forbidden one is refused; tampering with a header or the
// ledger is caught; the state survives a reload; and a changed source marks what depends on it. Members act through the staff tools, a person through
// the host's decide (what the commands call), and nothing else.
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { signPayload } from '../domain/team/signedPayload';
import { LEDGER_DIR, LEDGER_FILE, productPath } from '../staff/staffHost';
import { parseProductFile } from '../domain/staff/products';
import type { StaffEvent } from '../domain/staff/events';
import {
  callTool, CLEAN_BODY, hashIn, J2_TEAM, J5_TEAM, readProductFile, staffWorld, testSigner, writeBody
} from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const PROPOSE = 'mcp__staff-products__propose';
const VERDICT = 'mcp__staff-products__verdict';
const SUBMIT = 'mcp__staff-products__submit';
const WITHDRAW = 'mcp__staff-products__withdraw';
const STATUS = 'mcp__staff-products__status';
const LIST = 'mcp__staff-products__list';
const SCAN = 'mcp__guard-scan__scan';

async function ledgerLines(world: StaffWorld): Promise<string[]> {
  try { return (await readFile(path.join(world.root, LEDGER_DIR, LEDGER_FILE), 'utf8')).split('\n').filter(Boolean); } catch { return []; }
}

async function stateOf(world: StaffWorld, product: string): Promise<string> {
  const snapshot = await world.host.snapshot();
  return snapshot.registry.find((view) => view.product === product)?.display ?? 'none';
}

/** A J5 plan proposed by its owner: version 1, draft. Returns its hash. */
async function proposed(world: StaffWorld, product = 'concept-of-operations', body = CLEAN_BODY): Promise<string> {
  await writeBody(world.root, 'j5', product, body);
  const result = await callTool(world, J5_TEAM, PROPOSE, { product, kind: 'plan' }, 'lead-planner');
  assert.ok(result.ok, result.text);
  return hashIn(result.text);
}

async function cleared(world: StaffWorld, product = 'concept-of-operations'): Promise<string> {
  const hash = await proposed(world, product);
  const verdict = await callTool(world, J5_TEAM, VERDICT, { product, gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard');
  assert.ok(verdict.ok, verdict.text);
  return hash;
}

async function awaiting(world: StaffWorld, product = 'concept-of-operations'): Promise<string> {
  const hash = await cleared(world, product);
  const submit = await callTool(world, J5_TEAM, SUBMIT, { product, decisionFor: 'commander', options: [{ label: 'COA 1', risk: 'Moderate risk to the flank' }], dissent: ['The red team holds COA 2 is safer.'] }, 'lead-planner');
  assert.ok(submit.ok, submit.text);
  return hash;
}

function collect(world: StaffWorld): StaffEvent[] {
  const events: StaffEvent[] = [];
  world.host.onEvent((event) => events.push(event));
  return events;
}

// ---- Every row of the table: the allowed transition succeeds and is recorded -----------------------------------------------------------------

test('(none) to draft: the owner proposes the file it wrote; the ledger records it, the header is written, one event is sent', async () => {
  const world = await staffWorld();
  const events = collect(world);
  const hash = await proposed(world);
  assert.equal((await ledgerLines(world)).length, 1);
  const file = parseProductFile(await readProductFile(world.root, 'j5', 'concept-of-operations'));
  assert.ok(file.ok);
  if (file.ok) {
    assert.equal(file.value.header.state, 'draft');
    assert.equal(file.value.header.version, 1);
    assert.equal(file.value.header.owner, 'lead-planner');
    assert.equal(file.value.header.profile, 'us-joint');
    assert.equal(file.value.body, CLEAN_BODY, 'the body is kept exactly');
  }
  assert.deepEqual(events.map((event) => event.type), ['staff.product.state']);
  assert.equal((events[0] as { to: string }).to, 'draft');
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('draft to guard-checked: CLEARED on the exact hash; the guard report is written beside the product', async () => {
  const world = await staffWorld();
  const events = collect(world);
  await cleared(world);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'guard-checked');
  const report = await readFile(path.join(world.root, 'products/j5/guard/concept-of-operations-v1.md'), 'utf8');
  assert.match(report, /Verdict: CLEARED/);
  assert.deepEqual(events.map((event) => event.type), ['staff.product.state', 'staff.product.state', 'staff.gate.verdict'], 'one state event per transition, and one verdict event');
});

test('draft to draft (held): HOLD needs reasons, records them, and reads as draft (held)', async () => {
  const world = await staffWorld();
  const hash = await proposed(world);
  const bare = await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'HOLD', hash }, 'release-guard');
  assert.equal(bare.ok, false);
  const held = await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'HOLD', hash, reasons: ['Compilation: the annex and the matrix together reveal the main effort.'] }, 'release-guard');
  assert.ok(held.ok, held.text);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'draft (held)');
  const status = await callTool(world, J5_TEAM, STATUS, { product: 'concept-of-operations' }, 'lead-planner');
  assert.match(status.text, /Held: 1\. Compilation/);
});

test('guard-checked to awaiting decision: the owner or the section lead submits, naming who decides; others cannot', async () => {
  const world = await staffWorld();
  await cleared(world);
  const other = await callTool(world, J5_TEAM, SUBMIT, { product: 'concept-of-operations', decisionFor: 'commander' }, 'plans-writer');
  assert.equal(other.ok, false);
  const lead = await callTool(world, J5_TEAM, SUBMIT, { product: 'concept-of-operations', decisionFor: 'commander' }, 'j5-chief');
  assert.ok(lead.ok, lead.text);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'awaiting decision');
  const queue = (await world.host.snapshot()).decisions;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].decisionFor, 'commander');
});

test('guard-checked and awaiting decision drop to draft when the file changes: detected by hash, a new version, earlier verdicts void', async () => {
  for (const reach of [cleared, awaiting]) {
    const world = await staffWorld();
    await reach(world);
    await writeBody(world.root, 'j5', 'concept-of-operations', `${CLEAN_BODY}\nA change made with the Edit tool.\n`);
    const status = await callTool(world, J5_TEAM, STATUS, { product: 'concept-of-operations' }, 'lead-planner');
    assert.match(status.text, /The file changed since version 1/, 'a read reports the change and records nothing');
    const scan = await callTool(world, J5_TEAM, SCAN, { product: 'concept-of-operations' }, 'release-guard');
    const newHash = hashIn(scan.text);
    // The guard's next verdict records the edit first, then judges the new version.
    const verdict = await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash: newHash }, 'release-guard');
    assert.ok(verdict.ok, verdict.text);
    const view = (await world.host.snapshot()).registry[0];
    assert.equal(view.version, 2);
    assert.ok(view.history.some((item) => item.event === 'edit' && item.actor.kind === 'agent' && item.actor.member === 'file-change'), 'the edit is recorded with the reserved file-change actor');
    assert.equal(view.guard?.version, 2, 'the old CLEARED does not carry over');
  }
});

test('awaiting decision to approved, then released: only a named person, signed with this device key, on the exact hash', async () => {
  const world = await staffWorld();
  const events = collect(world);
  const hash = await awaiting(world);
  const approved = await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'approve', hash });
  assert.ok(approved.ok, approved.ok ? '' : approved.message);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'approved');
  const released = await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'release', hash });
  assert.ok(released.ok);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'released');
  const decisions = events.filter((event) => event.type === 'staff.decision.recorded');
  assert.deepEqual(decisions.map((event) => (event as { decision: string }).decision), ['approved', 'released']);
  assert.equal((decisions[0] as { person: { name: string } }).person.name, 'A. Demo');
  const header = parseProductFile(await readProductFile(world.root, 'j5', 'concept-of-operations'));
  assert.ok(header.ok && header.value.header.state === 'released');
});

test('approve and release in one act, for a product marked release on approval', async () => {
  const world = await staffWorld();
  const hash = await awaiting(world);
  const done = await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'approve', hash, releaseOnApproval: true });
  assert.ok(done.ok);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'released');
});

test('awaiting decision to rejected needs reasons; rejected to draft when the owner revises, with the reasons linked', async () => {
  const world = await staffWorld();
  await awaiting(world);
  const bare = await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'reject', reasons: [] });
  assert.equal(bare.ok, false, 'rejected without reasons');
  const rejected = await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'reject', reasons: ['The flank is not covered.'] });
  assert.ok(rejected.ok);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'rejected');
  await writeBody(world.root, 'j5', 'concept-of-operations', `${CLEAN_BODY}\nThe flank is covered by the reserve.\n`);
  const revised = await callTool(world, J5_TEAM, PROPOSE, { product: 'concept-of-operations' }, 'lead-planner');
  assert.ok(revised.ok, revised.text);
  const replay = await world.host.replay();
  const state = replay.products.get('concept-of-operations')!;
  assert.equal(state.record.state, 'draft');
  assert.equal(state.record.version, 2);
  assert.deepEqual(state.record.rejection?.reasons, ['The flank is not covered.']);
});

test('released to superseded: a newer version starts a new line, and releasing it supersedes the old one, by a person', async () => {
  const world = await staffWorld();
  const hash = await awaiting(world);
  await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'approve', hash, releaseOnApproval: true });
  await writeBody(world.root, 'j5', 'concept-of-operations', `${CLEAN_BODY}\nVersion two.\n`);
  const next = await callTool(world, J5_TEAM, PROPOSE, { product: 'concept-of-operations' }, 'lead-planner');
  assert.ok(next.ok, next.text);
  const nextHash = hashIn(next.text);
  assert.ok((await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash: nextHash }, 'release-guard')).ok);
  assert.ok((await callTool(world, J5_TEAM, SUBMIT, { product: 'concept-of-operations', decisionFor: 'commander' }, 'lead-planner')).ok);
  assert.ok((await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'approve', hash: nextHash, releaseOnApproval: true })).ok);
  const state = (await world.host.replay()).products.get('concept-of-operations')!;
  assert.equal(state.record.version, 2);
  assert.equal(state.record.state, 'released');
  assert.equal(state.older[0].record.state, 'superseded');
  assert.equal(state.older[0].record.supersededBy, 2);
});

test('any non-terminal state to withdrawn: the owner before a decision, only a person after it', async () => {
  const world = await staffWorld();
  await proposed(world);
  const byOther = await callTool(world, J5_TEAM, WITHDRAW, { product: 'concept-of-operations', reason: 'Not needed' }, 'plans-writer');
  assert.equal(byOther.ok, false);
  assert.ok((await callTool(world, J5_TEAM, WITHDRAW, { product: 'concept-of-operations', reason: 'Not needed' }, 'lead-planner')).ok);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'withdrawn');

  const second = await staffWorld();
  const hash = await awaiting(second);
  await second.host.decide(second.person(), { product: 'concept-of-operations', action: 'approve', hash });
  const agentAfter = await callTool(second, J5_TEAM, WITHDRAW, { product: 'concept-of-operations', reason: 'Changed my mind' }, 'lead-planner');
  assert.equal(agentAfter.ok, false, 'an agent cannot undo a person\'s decision');
  const personAfter = await second.host.decide(second.person(), { product: 'concept-of-operations', action: 'withdraw', reasons: ['Overtaken by events'] });
  assert.ok(personAfter.ok);
  assert.equal(await stateOf(second, 'concept-of-operations'), 'withdrawn');
});

// ---- Every forbidden transition ----------------------------------------------------------------------------------------------------------

test('an agent cannot approve: there is no tool for it, and the host refuses anything that is not a named person on this device', async () => {
  const world = await staffWorld();
  const hash = await awaiting(world);
  const agentShaped = { kind: 'agent', member: 'lead-planner' } as unknown as Parameters<typeof world.host.decide>[0];
  assert.equal((await world.host.decide(agentShaped, { product: 'concept-of-operations', action: 'approve', hash })).ok, false);
  const unnamed = await world.host.decide({ ...world.person(), name: ' ' }, { product: 'concept-of-operations', action: 'approve', hash });
  assert.equal(unnamed.ok, false);
  const otherDevice = await world.host.decide({ ...world.person(), deviceFingerprint: 'not-this-device' }, { product: 'concept-of-operations', action: 'approve', hash });
  assert.equal(otherDevice.ok, false, 'a person is signed with this device\'s key, so a decision naming another key is refused');
  assert.equal(await stateOf(world, 'concept-of-operations'), 'awaiting decision');
});

test('approve without the guard, release without approval, approval of a stale hash: each refused, nothing recorded', async () => {
  const world = await staffWorld();
  const hash = await proposed(world);
  const before = (await ledgerLines(world)).length;
  assert.equal((await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'approve', hash })).ok, false, 'approve without guard');
  assert.equal((await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'release', hash })).ok, false, 'release without approval');
  assert.equal((await ledgerLines(world)).length, before);

  const stale = await staffWorld();
  await awaiting(stale);
  assert.equal((await stale.host.decide(stale.person(), { product: 'concept-of-operations', action: 'approve', hash: 'f'.repeat(64) })).ok, false, 'a stale hash');
});

test('edit after approval: the approved text changed on disk reads as tampered, and cannot be released', async () => {
  const world = await staffWorld();
  const hash = await awaiting(world);
  await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'approve', hash });
  await writeBody(world.root, 'j5', 'concept-of-operations', `${CLEAN_BODY}\nA quiet change after approval.\n`);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'draft (tampered)');
  const release = await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'release', hash });
  assert.equal(release.ok, false);
  if (!release.ok) assert.match(release.message, /changed on disk/);
});

test('tradecraft skipped for J2: the guard cannot clear a J2 product before the tradecraft sign-off on that version', async () => {
  const world = await staffWorld();
  await writeBody(world.root, 'j2', 'intelligence-estimate', '# Intelligence estimate\n\n## Key judgements\n\n- We assess the adversary will likely defend the river line.\n\nMLCOA: defend. MDCOA: counter-attack.\n');
  const proposedJ2 = await callTool(world, J2_TEAM, PROPOSE, { product: 'intelligence-estimate', kind: 'estimate' }, 'j2-chief');
  assert.ok(proposedJ2.ok, proposedJ2.text);
  const hash = hashIn(proposedJ2.text);
  const early = await callTool(world, J2_TEAM, VERDICT, { product: 'intelligence-estimate', gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard');
  assert.equal(early.ok, false);
  assert.match(early.text, /tradecraft sign-off/);
  const signOff = await callTool(world, J2_TEAM, VERDICT, { product: 'intelligence-estimate', gate: 'tradecraft', verdict: 'SIGN-OFF', hash }, 'tradecraft-reviewer');
  assert.ok(signOff.ok, signOff.text);
  assert.ok((await callTool(world, J2_TEAM, VERDICT, { product: 'intelligence-estimate', gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard')).ok);
});

test('a guard verdict for another version is refused, and only the product\'s own gate member may give one', async () => {
  const world = await staffWorld();
  const hash = await proposed(world);
  const wrongHash = await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash: 'a'.repeat(64) }, 'release-guard');
  assert.equal(wrongHash.ok, false);
  assert.match(wrongHash.text, /different version/);
  const notGuard = await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash }, 'plans-writer');
  assert.equal(notGuard.ok, false);
  const lead = await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash });
  assert.equal(lead.ok, false, 'the run\'s lead is not a member');
  assert.match(lead.text, /Only a member/);
});

test('CLEARED is refused while guard-scan holds the version, with the findings', async () => {
  const world = await staffWorld();
  const hash = await proposed(world, 'concept-of-operations', `${CLEAN_BODY}\nCOA 2 has been approved by the commander.\n`);
  const verdict = await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard');
  assert.equal(verdict.ok, false);
  assert.match(verdict.text, /decision-as-made/);
});

test('a non-owner cannot propose another member\'s product, and a gate member cannot own one', async () => {
  const world = await staffWorld();
  await proposed(world);
  await writeBody(world.root, 'j5', 'concept-of-operations', `${CLEAN_BODY}\nChanged by someone else.\n`);
  assert.equal((await callTool(world, J5_TEAM, PROPOSE, { product: 'concept-of-operations' }, 'plans-writer')).ok, false);
  await writeBody(world.root, 'j5', 'guard-notes', '# Notes\n');
  assert.equal((await callTool(world, J5_TEAM, PROPOSE, { product: 'guard-notes', kind: 'report' }, 'release-guard')).ok, false);
});

// ---- Tamper detection, reload persistence, dependency propagation ------------------------------------------------------------------------------

test('a hand-edited header that claims approved reads as draft (tampered), and the guard and a person are refused', async () => {
  const world = await staffWorld();
  const hash = await proposed(world);
  const file = path.join(world.root, productPath('j5', 'concept-of-operations'));
  await writeFile(file, (await readFile(file, 'utf8')).replace('state: draft', 'state: approved').replace('depends_on', 'decision_for: commander\ndepends_on').replace('depends_on: []', 'depends_on: []\nguard: { verdict: CLEARED, at: 2026-11-18T12:00:00.000Z, report: guard/x.md }'), 'utf8');
  assert.equal(await stateOf(world, 'concept-of-operations'), 'draft (tampered)');
  const guard = await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash }, 'release-guard');
  assert.equal(guard.ok, false);
  assert.equal((await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'release', hash })).ok, false);
  // The owner writing it again through the tool puts the ledger's header back.
  await writeBody(world.root, 'j5', 'concept-of-operations', `${CLEAN_BODY}\nRewritten.\n`);
  const raw = await readFile(file, 'utf8');
  await writeFile(file, raw.replace(/^---[\s\S]*?---\n/, ''), 'utf8');
  assert.ok((await callTool(world, J5_TEAM, PROPOSE, { product: 'concept-of-operations' }, 'lead-planner')).ok);
  assert.equal(await stateOf(world, 'concept-of-operations'), 'draft');
});

test('a ledger line added, changed or removed outside NEAR AI breaks the chain: the products it touches read as tampered', async () => {
  // A forged approval signed by a key this computer does not trust.
  const forged = await staffWorld();
  const hash = await awaiting(forged);
  const lines = await ledgerLines(forged);
  const last = JSON.parse(lines[lines.length - 1]) as { payload: { seq: number } };
  const outsider = testSigner();
  const entry = { v: 1, seq: last.payload.seq + 1, prev: '0'.repeat(64), at: '2026-11-18T13:00:00.000Z', run: 'run-1', product: 'concept-of-operations', section: 'j5', event: { type: 'approve', hash }, actor: { kind: 'person', name: 'Mallory', role: 'Commander', deviceFingerprint: outsider.fingerprint } };
  await appendFile(path.join(forged.root, LEDGER_DIR, LEDGER_FILE), `${JSON.stringify(signPayload(outsider, 'staff-ledger', entry))}\n`);
  assert.equal(await stateOf(forged, 'concept-of-operations'), 'draft (tampered)');
  const blocked = await callTool(forged, J5_TEAM, PROPOSE, { product: 'other-plan', kind: 'plan' }, 'lead-planner');
  assert.equal(blocked.ok, false, 'nothing more is recorded on a broken ledger');

  // A line removed from the middle.
  const removed = await staffWorld();
  await awaiting(removed);
  const all = await ledgerLines(removed);
  await writeFile(path.join(removed.root, LEDGER_DIR, LEDGER_FILE), `${[all[0], ...all.slice(2)].join('\n')}\n`);
  assert.equal(await stateOf(removed, 'concept-of-operations'), 'draft (tampered)');

  // A person can set the broken ledger aside (kept, never deleted) and work goes on.
  const kept = await removed.host.setAsideLedger();
  assert.match(kept ?? '', /products\.set-aside-/);
  assert.equal((await removed.host.snapshot()).registry.length, 0);
});

test('reload: a new host over the same folder rebuilds the same registry, decisions and history from the ledger and the files', async () => {
  const world = await staffWorld();
  await awaiting(world);
  const before = await world.host.snapshot();
  world.reload();
  const after = await world.host.snapshot();
  assert.deepEqual(after.registry, before.registry);
  assert.deepEqual(after.decisions, before.decisions);
  assert.equal(after.decisions[0].dissent[0], 'The red team holds COA 2 is safer.', 'dissent is kept, unedited');
});

test('dependency propagation: a newer approved source marks the product; it drops to draft only when its owner takes the change', async () => {
  const world = await staffWorld();
  // The source, v1 approved.
  const sourceHash = await awaiting(world, 'facts-sheet');
  await world.host.decide(world.person(), { product: 'facts-sheet', action: 'approve', hash: sourceHash });
  // The dependent product, built on facts-sheet@1, guard-checked.
  await writeBody(world.root, 'j5', 'concept-of-operations', CLEAN_BODY);
  const dependent = await callTool(world, J5_TEAM, PROPOSE, { product: 'concept-of-operations', kind: 'plan', dependsOn: ['facts-sheet@1'] }, 'lead-planner');
  assert.ok(dependent.ok, dependent.text);
  assert.ok((await callTool(world, J5_TEAM, VERDICT, { product: 'concept-of-operations', gate: 'guard', verdict: 'CLEARED', hash: hashIn(dependent.text) }, 'release-guard')).ok);
  // The source gets a v2, approved.
  await writeBody(world.root, 'j5', 'facts-sheet', `${CLEAN_BODY}\nA new fact.\n`);
  const v2 = await callTool(world, J5_TEAM, PROPOSE, { product: 'facts-sheet' }, 'lead-planner');
  assert.ok((await callTool(world, J5_TEAM, VERDICT, { product: 'facts-sheet', gate: 'guard', verdict: 'CLEARED', hash: hashIn(v2.text) }, 'release-guard')).ok);
  assert.ok((await callTool(world, J5_TEAM, SUBMIT, { product: 'facts-sheet', decisionFor: 'commander' }, 'lead-planner')).ok);
  assert.ok((await world.host.decide(world.person(), { product: 'facts-sheet', action: 'approve', hash: hashIn(v2.text) })).ok);
  const marked = (await world.host.snapshot()).registry.find((view) => view.product === 'concept-of-operations')!;
  assert.equal(marked.sourceChanged, true);
  assert.equal(marked.state, 'guard-checked', 'only marked: it does not drop to draft by itself');
  const status = await callTool(world, J5_TEAM, STATUS, { product: 'concept-of-operations' }, 'lead-planner');
  assert.match(status.text, /SOURCE CHANGED: facts-sheet now has approved version 2/);
  // The owner takes the change: a new version that depends on facts-sheet@2, back to draft.
  const taken = await callTool(world, J5_TEAM, PROPOSE, { product: 'concept-of-operations', dependsOn: ['facts-sheet@2'] }, 'lead-planner');
  assert.ok(taken.ok, taken.text);
  const after = (await world.host.snapshot()).registry.find((view) => view.product === 'concept-of-operations')!;
  assert.equal(after.state, 'draft');
  assert.equal(after.sourceChanged, false);
});

test('events: exactly one state event per transition, in the project\'s event log, the same as what listeners got', async () => {
  const world = await staffWorld();
  const heard = collect(world);
  const hash = await awaiting(world);
  await world.host.decide(world.person(), { product: 'concept-of-operations', action: 'approve', hash });
  const logged = await world.host.events();
  assert.deepEqual(logged, heard);
  const transitions = (await world.host.replay()).products.get('concept-of-operations')!.history.length;
  assert.equal(logged.filter((event) => event.type === 'staff.product.state').length, transitions);
  assert.equal(logged.filter((event) => event.type === 'staff.decision.requested').length, 1);
  assert.equal(logged.filter((event) => event.type === 'staff.decision.recorded').length, 1);
  assert.equal(logged.filter((event) => event.type === 'staff.gate.verdict').length, 1);
});

test('list shows the section\'s products and the run\'s lead can read but never act; a WAITING ON line becomes a waiting event', async () => {
  const world = await staffWorld();
  const heard = collect(world);
  await proposed(world, 'concept-of-operations', `${CLEAN_BODY}\nWAITING ON j2: the adversary COA set.\n`);
  const list = await callTool(world, J5_TEAM, LIST, {});
  assert.ok(list.ok);
  assert.match(list.text, /concept-of-operations \(j5, plan\) v1: draft/);
  assert.equal((await callTool(world, J5_TEAM, PROPOSE, { product: 'concept-of-operations' })).ok, false);
  const waiting = heard.find((event) => event.type === 'staff.waiting');
  assert.ok(waiting && waiting.type === 'staff.waiting');
  if (waiting && waiting.type === 'staff.waiting') { assert.equal(waiting.waitingOn, 'j2'); assert.equal(waiting.member, 'lead-planner'); }
});

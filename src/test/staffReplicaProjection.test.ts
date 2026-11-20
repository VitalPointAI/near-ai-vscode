// The projection adapter (plan 31-11; D-28, D-33): the fold of a multi-user project, turned into exactly the ProductState, LedgerReplay, product file
// text and staff events today's single-machine host produces for the same history. Each scenario is written twice (src/test/helpers/
// staffReplicaHistory.ts): through today's host and as replica entries; the projection of the fold must tell the same story.
import assert from 'node:assert/strict';
import test from 'node:test';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { verifyEntry } from '../domain/replica/verify';
import type { ProductTextOutput } from '../domain/replica/textFold';
import type { ProductVersions } from '../domain/replica/versions';
import type { StaffEvent } from '../domain/staff/events';
import { headerDisagreement, productHash } from '../domain/staff/ledger';
import type { ProductState } from '../domain/staff/ledger';
import { parseProductFile } from '../domain/staff/products';
import type { ProductHeader } from '../domain/staff/products';
import { PROJECTION_PROBLEMS, projectionEntry, projectLedgerReplay, projectProductFile, projectProductStates, projectStaffEvents } from '../staff/replica/projection';
import type { ProjectionEntry, ProjectionInput } from '../staff/replica/projection';
import { ANNEX, CONOPS, DECISION_ROLE, GUARD_DEVICE, TWIN_DEVICE, TWIN_RUN, TWIN_SCENARIOS, twinHistory } from './helpers/staffReplicaHistory';
import type { TwinHistory, TwinScenario } from './helpers/staffReplicaHistory';
import type { Written } from './helpers/replicaWorld';

interface Folded { fold: FoldResult; input: ProjectionInput }

function folded(twin: TwinHistory, options: { texts?: boolean } = {}): Folded {
  const fold = foldEntries(twin.replicaEntries, twin.ctx);
  const entries = new Map<string, ProjectionEntry>();
  for (const sealed of twin.replicaEntries) {
    const outcome = verifyEntry(sealed, twin.ctx);
    if (outcome.status === 'verified') entries.set(outcome.entry.hash, projectionEntry(outcome.entry));
  }
  return { fold, input: { fold, entries, roster: twin.ctx.roster, ...(options.texts === false ? {} : { texts: twin.texts }) } };
}

function cleanFold(fold: FoldResult): void {
  assert.deepEqual([fold.held, fold.rejected, fold.refused], [[], [], []], 'every replica entry of the twin is accepted');
}

// ---- Task 1: the tracer -------------------------------------------------------------------------------------------------------------------------

test('tracer: one proposed product written both ways projects to the same record and meta as today\'s replay', async () => {
  const twin = await twinHistory('proposed');
  const { fold, input } = folded(twin);
  cleanFold(fold);
  const projected = projectProductStates(input);
  const legacy = twin.legacyReplay.products.get(CONOPS) as ProductState;
  const state = projected.get(CONOPS) as ProductState;
  assert.ok(state, 'the product is projected');
  assert.equal(state.tampered, undefined);
  assert.deepEqual(state.record, legacy.record);
  assert.deepEqual(state.meta, legacy.meta);
  assert.equal(state.record.state, 'draft');
  assert.equal(state.record.version, 1);
  assert.deepEqual([...projected.keys()], [...twin.legacyReplay.products.keys()]);
});

// ---- Task 2: every release state, table-driven ------------------------------------------------------------------------------------------------

/**
 * What both sides record about a product. History items are compared on the step, its states, the version and its hash, the actor's name and the
 * time; the ledger's own sequence numbers and runs are not part of it (the fold numbers positions, not ledger lines). The open request is compared
 * on its time: its run is not compared, and its options, dissent and deadline have no source in the fold (version.submit carries only the decision
 * role), which a test of its own pins.
 */
function comparable(state: ProductState): unknown {
  const actorName = (actor: ProductState['history'][number]['actor']): string => (actor.kind === 'person' ? actor.name : actor.member);
  return {
    record: state.record,
    meta: state.meta,
    guard: state.guard,
    tradecraft: state.tradecraft,
    request: state.request === undefined ? undefined : { requestedAt: state.request.requestedAt },
    approvedVersions: state.approvedVersions,
    tampered: state.tampered,
    history: state.history.map((item) => ({ event: item.event, from: item.from, to: item.to, version: item.version, hash: item.hash, actor: actorName(item.actor), at: item.at })),
    older: state.older.map(comparable)
  };
}

const EXPECTED_STATE: Readonly<Record<TwinScenario, string>> = {
  proposed: 'draft', 'guard-checked': 'guard-checked', 'tradecraft-checked': 'guard-checked', 'awaiting-decision': 'awaiting-decision', approved: 'approved',
  released: 'released', rejected: 'rejected', revised: 'draft', withdrawn: 'withdrawn', 'withdrawn-after-approval': 'withdrawn', superseded: 'released', pinned: 'approved'
};

for (const scenario of TWIN_SCENARIOS) {
  test(`${scenario}: the projection of the fold equals today's replay on record, meta, gate marks, request, approvals and older lines`, async () => {
    const twin = await twinHistory(scenario);
    const { fold, input } = folded(twin);
    cleanFold(fold);
    const replay = projectLedgerReplay(input);
    assert.deepEqual([...replay.products.keys()].sort(), [...twin.legacyReplay.products.keys()].sort());
    for (const [product, legacy] of twin.legacyReplay.products) {
      const projected = replay.products.get(product) as ProductState;
      assert.deepEqual(comparable(projected), comparable(legacy), `${scenario}: ${product}`);
    }
    const main = replay.products.get(scenario === 'tradecraft-checked' ? 'intelligence-estimate' : CONOPS) as ProductState;
    assert.equal(main.record.state, EXPECTED_STATE[scenario]);
    assert.equal(main.tampered, undefined);
  });
}

test('the superseded line: the older released version is superseded by the newer one, and both approvals are kept', async () => {
  const twin = await twinHistory('superseded');
  const state = projectLedgerReplay(folded(twin).input).products.get(CONOPS) as ProductState;
  assert.equal(state.record.version, 2);
  assert.equal(state.older.length, 1);
  assert.equal(state.older[0].record.state, 'superseded');
  assert.equal(state.older[0].record.supersededBy, 2);
  assert.deepEqual(state.approvedVersions, [1, 2]);
});

test('a revision after a rejection stays on the same line and keeps the rejection, as today\'s ledger does', async () => {
  const twin = await twinHistory('revised');
  const state = projectLedgerReplay(folded(twin).input).products.get(CONOPS) as ProductState;
  assert.equal(state.record.version, 2);
  assert.equal(state.older.length, 0);
  assert.deepEqual(state.record.rejection?.reasons, ['The flank is not covered.']);
  assert.equal(state.record.rejection?.version, 1);
});

test('a dependency pin product@version is the pinned version\'s hash on the replica side and maps back to product@version', async () => {
  const twin = await twinHistory('pinned');
  const { fold, input } = folded(twin);
  const conopsV1 = (twin.versionHashes.get(CONOPS) as string[])[0];
  const annex = (fold.families.versions as ProductVersions[]).find((product) => product.product === ANNEX) as ProductVersions;
  assert.deepEqual(annex.versions[0].pins, [{ product: CONOPS, hash: conopsV1 }]);
  const legacy = twin.legacyReplay.products.get(ANNEX) as ProductState;
  assert.deepEqual(legacy.meta.dependsOn, [{ product: CONOPS, version: 1 }]);
  const projected = projectLedgerReplay(input).products.get(ANNEX) as ProductState;
  assert.deepEqual(projected.meta.dependsOn, [{ product: CONOPS, version: 1 }]);
  assert.equal(projected.record.hash, legacy.record.hash, 'with the text, the version hash is today\'s');
  assert.notEqual(annex.versions[0].hash, legacy.record.hash, 'the fold pins by hash, today\'s ledger by number');
  // Without the version text the hash with numbered pins cannot be known: the fold's hash stands.
  const blind = projectLedgerReplay(folded(twin, { texts: false }).input).products.get(ANNEX) as ProductState;
  assert.equal(blind.record.hash, annex.versions[0].hash);
  assert.deepEqual(blind.meta.dependsOn, [{ product: CONOPS, version: 1 }]);
});

test('the projected replay is never broken, and its head is the fold\'s digest of the products stream', async () => {
  const twin = await twinHistory('released');
  const { fold, input } = folded(twin);
  const replay = projectLedgerReplay(input);
  assert.equal(replay.broken, undefined);
  assert.equal(replay.head, fold.digests[twin.world.stream]);
  assert.match(replay.head, /^[0-9a-f]{64}$/);
  assert.equal(replay.entries, (replay.products.get(CONOPS) as ProductState).history.length);
});

test('the open request: decision role, time and run from the submit; options, dissent and deadline have no source in the fold', async () => {
  const twin = await twinHistory('awaiting-decision');
  const projected = projectLedgerReplay(folded(twin).input).products.get(CONOPS) as ProductState;
  const legacy = twin.legacyReplay.products.get(CONOPS) as ProductState;
  assert.equal(projected.record.decisionFor, DECISION_ROLE);
  assert.equal(projected.request?.requestedAt, legacy.request?.requestedAt);
  assert.equal(projected.request?.run, TWIN_RUN, 'an agent\'s submit carries its run');
  assert.ok((legacy.request?.options.length ?? 0) > 0, 'today\'s submit carried options');
  assert.deepEqual([projected.request?.options, projected.request?.dissent, projected.request?.deadline], [[], [], undefined]);
});

// ---- Forbidden transitions: the projection never shows a step the fold does not hold -------------------------------------------------------

/** The newest entry of the person's device, to write the next entry after it. */
function deviceHead(twin: TwinHistory): Written {
  const writer = twin.world.writerOf(TWIN_DEVICE);
  const head = twin.world.heads(twin.world.stream).find((item) => item.writer === writer) as { hash: string; seq: number };
  return { entry: twin.world.entries[twin.world.entries.length - 1], hash: head.hash, stream: twin.world.stream, writer, seq: head.seq, lamport: 0 };
}

test('an agent\'s approve is refused by the fold and is no step of the projection: the product stays awaiting a decision', async () => {
  const twin = await twinHistory('awaiting-decision');
  const head = deviceHead(twin);
  const hash = (twin.versionHashes.get(CONOPS) as string[])[0];
  twin.world.write(TWIN_DEVICE, { kind: 'version.decide', data: { product: CONOPS, hash, outcome: 'approve', reasons: [], decisionsSeen: [] }, actor: { kind: 'agent', member: 'lead-planner', run: TWIN_RUN }, deps: [head] });
  const { fold, input } = folded({ ...twin, replicaEntries: [...twin.world.entries] });
  const product = (fold.families.versions as ProductVersions[])[0];
  assert.ok(product.refusals.some((refusal) => refusal.reason === 'agent-cannot-decide'));
  const projected = projectLedgerReplay(input).products.get(CONOPS) as ProductState;
  assert.equal(projected.record.state, 'awaiting-decision');
  assert.deepEqual(comparable(projected), comparable(twin.legacyReplay.products.get(CONOPS) as ProductState));
});

test('concurrent guard verdicts that disagree: the fold holds the version, and the projection shows the fold\'s draft, marked, never guard-checked', async () => {
  const twin = await twinHistory('proposed');
  const propose = deviceHead(twin);
  const hash = (twin.versionHashes.get(CONOPS) as string[])[0];
  const at = '2026-11-18T12:30:00.000Z';
  twin.world.write(TWIN_DEVICE, { kind: 'version.verdict', data: { product: CONOPS, hash, gate: 'guard', verdict: 'CLEARED', reasons: [] }, actor: { kind: 'agent', member: 'release-guard', run: TWIN_RUN }, deps: [propose], at });
  twin.world.write(GUARD_DEVICE, { kind: 'version.verdict', data: { product: CONOPS, hash, gate: 'guard', verdict: 'HOLD', reasons: ['Compilation risk.'] }, actor: { kind: 'agent', member: 'release-guard', run: 'run-2' }, deps: [propose], at });
  const { fold, input } = folded({ ...twin, replicaEntries: [...twin.world.entries] });
  cleanFold(fold);
  const view = (fold.families.versions as ProductVersions[])[0].versions[0];
  assert.equal(view.state, 'draft');
  assert.equal(view.verdictConflict, true);
  const projected = projectLedgerReplay(input).products.get(CONOPS) as ProductState;
  assert.equal(projected.record.state, 'draft');
  assert.equal(projected.tampered, PROJECTION_PROBLEMS.disagrees);
  assert.equal(projected.guard, undefined, 'no gate mark the fold does not hold');
  assert.deepEqual(projected.record.held, { gate: 'guard', reasons: ['Compilation risk.'] });
});

test('the projection reads only what the fold holds: an entry with no time given is unreadable, never guessed', async () => {
  const twin = await twinHistory('proposed');
  const { input } = folded(twin);
  const entries = new Map(input.entries);
  const propose = [...entries.entries()].find(([, entry]) => entry.kind === 'version.propose') as [string, ProjectionEntry];
  entries.delete(propose[0]);
  const projected = projectLedgerReplay({ ...input, entries }).products.get(CONOPS) as ProductState;
  assert.equal(projected.tampered, PROJECTION_PROBLEMS.unreadable);
  assert.equal(projected.record.state, 'draft');
  assert.equal(projected.record.hash, (twin.versionHashes.get(CONOPS) as string[])[0]);
  assert.deepEqual([projected.history, projected.guard, projected.request], [[], undefined, undefined]);
});

// ---- Task 3: product files and staff events as projections -----------------------------------------------------------------------------------

const foldText = (fold: FoldResult, product: string): string => ((fold.families.doc as ProductTextOutput[]).find((item) => item.product === product) as ProductTextOutput).text;

/** The header today's host would read from a product file, and the version hash of its body with the header's pins. */
function fileCheck(text: string): { header: ProductHeader; hash: string } {
  const parsed = parseProductFile(text);
  assert.ok(parsed.ok, 'the file parses');
  if (!parsed.ok) throw new Error('unreachable');
  return { header: parsed.value.header, hash: productHash(parsed.value.body, parsed.value.header.dependsOn) };
}

for (const scenario of TWIN_SCENARIOS) {
  test(`${scenario}: the product file written from the fold is byte-identical to today's, and today's header check finds nothing against the projection`, async () => {
    const twin = await twinHistory(scenario);
    const { fold, input } = folded(twin);
    const products = projectProductStates(input);
    for (const [product, legacyFile] of twin.legacyFiles) {
      const state = products.get(product) as ProductState;
      const file = projectProductFile(state, foldText(fold, product));
      assert.equal(file, legacyFile, `${scenario}: ${product}`);
      const check = fileCheck(file);
      assert.equal(headerDisagreement(state, check.header, check.hash), undefined);
    }
  });
}

test('a header edited by hand gives the same tamper reason against the projection as against today\'s replay', async () => {
  const twin = await twinHistory('awaiting-decision');
  const { input } = folded(twin);
  const projected = projectProductStates(input).get(CONOPS) as ProductState;
  const legacy = twin.legacyReplay.products.get(CONOPS) as ProductState;
  const original = twin.legacyFiles.get(CONOPS) as string;
  const edits: Array<[string, string]> = [
    [original.replace('state: awaiting-decision', 'state: approved'), 'header-state'],
    [original.replace('version: 1', 'version: 2'), 'header-version'],
    [original.replace('owner: lead-planner', 'owner: plans-writer'), 'header-identity'],
    [original.replace(/^(guard: .*\n)/m, '$1tradecraft: { verdict: SIGN-OFF, at: 2026-11-18T12:00:05.000Z, report: tradecraft/concept-of-operations-v1.md }\n'), 'header-verdict']
  ];
  for (const [edited, reason] of edits) {
    assert.notEqual(edited, original);
    const check = fileCheck(edited);
    assert.equal(headerDisagreement(legacy, check.header, check.hash), reason);
    assert.equal(headerDisagreement(projected, check.header, check.hash), reason);
  }
});

test('a released body changed on disk reads as locked-changed against the projection, as against today\'s replay', async () => {
  const twin = await twinHistory('released');
  const { input } = folded(twin);
  const projected = projectProductStates(input).get(CONOPS) as ProductState;
  const legacy = twin.legacyReplay.products.get(CONOPS) as ProductState;
  const check = fileCheck(`${twin.legacyFiles.get(CONOPS) as string}A quiet change after release.\n`);
  assert.equal(headerDisagreement(legacy, check.header, check.hash), 'locked-changed');
  assert.equal(headerDisagreement(projected, check.header, check.hash), 'locked-changed');
});

/**
 * What both sides' events say: type, product, version and, by type, the step and its states, the gate and verdict, the decision role and the person,
 * and the run and time of the step. Excluded: the ledger sequence number a product.state event carries (the fold numbers positions, not ledger lines)
 * and the person's device fingerprint and role, which the record comparison above already covers.
 */
function eventKey(event: StaffEvent): unknown {
  const value = event as unknown as Record<string, unknown>;
  const pick = (...keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  const person = value.person as { name: string } | undefined;
  const actor = value.actor as { kind: string; member?: string; name?: string } | undefined;
  return {
    ...pick('type', 'run', 'at', 'product', 'version', 'from', 'to', 'event', 'hash', 'gate', 'verdict', 'reasons', 'role', 'decision'),
    ...(actor ? { actor: actor.kind === 'person' ? actor.name : actor.member } : {}),
    ...(person ? { person: person.name } : {})
  };
}

for (const scenario of TWIN_SCENARIOS) {
  test(`${scenario}: the staff events projected from the fold are today's events, in order`, async () => {
    const twin = await twinHistory(scenario);
    const events = projectStaffEvents(folded(twin).input, 'run-projected');
    assert.ok(events.length > 0);
    assert.deepEqual(events.map(eventKey), twin.legacyEvents.map(eventKey));
    assert.ok(events.every((event) => event.run === TWIN_RUN), 'every step of the twin has a run, so the projected run is never used');
  });
}

test('a product the projection cannot vouch for sends no events: no step the fold does not hold reaches the Staff Room', async () => {
  const twin = await twinHistory('proposed');
  const propose = deviceHead(twin);
  const hash = (twin.versionHashes.get(CONOPS) as string[])[0];
  twin.world.write(TWIN_DEVICE, { kind: 'version.verdict', data: { product: CONOPS, hash, gate: 'guard', verdict: 'CLEARED', reasons: [] }, actor: { kind: 'agent', member: 'release-guard', run: TWIN_RUN }, deps: [propose] });
  twin.world.write(GUARD_DEVICE, { kind: 'version.verdict', data: { product: CONOPS, hash, gate: 'guard', verdict: 'HOLD', reasons: ['Compilation risk.'] }, actor: { kind: 'agent', member: 'release-guard', run: 'run-2' }, deps: [propose] });
  const events = projectStaffEvents(folded({ ...twin, replicaEntries: [...twin.world.entries] }).input, 'run-projected');
  assert.deepEqual(events, []);
});

// The projection adapter (plan 31-11; D-28, D-33): the fold of a multi-user project, turned into exactly the ProductState, LedgerReplay, product file
// text and staff events today's single-machine host produces for the same history. Each scenario is written twice (src/test/helpers/
// staffReplicaHistory.ts): through today's host and as replica entries; the projection of the fold must tell the same story.
import assert from 'node:assert/strict';
import test from 'node:test';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { verifyEntry } from '../domain/replica/verify';
import type { ProductState } from '../domain/staff/ledger';
import { projectionEntry, projectProductStates } from '../staff/replica/projection';
import type { ProjectionEntry, ProjectionInput } from '../staff/replica/projection';
import { CONOPS, twinHistory } from './helpers/staffReplicaHistory';
import type { TwinHistory } from './helpers/staffReplicaHistory';

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

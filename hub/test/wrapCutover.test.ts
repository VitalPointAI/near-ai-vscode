import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGrant, grantHash, wrapEpochKey } from '@ext/domain/replica/cellKeys';
import type { CellGrant, GrantWrap } from '@ext/domain/replica/cellKeys';
import { kemPublicFromSeeds, wrapEpochKeyV2 } from '@ext/domain/replica/cellWrapV2';
import { WRAP_FEATURE, WRAP_FORMAT_REFUSALS } from '@ext/domain/replica/wrapFormat';
import type { SignedPayload } from '@ext/domain/team/signedPayload';
import { APPEND_REFUSALS, checkBatch, commitBatch } from '../src/append/checks';
import type { AppendResult } from '../src/append/checks';
import { RosterCache } from '../src/append/rosterCache';
import { enrolProject, issueHubFile } from '../src/enrol';
import { hubReplicaFeatures } from '../src/features';
import { RateLimits } from '../src/limits';
import { openHubStore } from '../src/store/hubStore';
import type { HubStore } from '../src/store/hubStore';
import { NOW_MS, WORLD_NOW, createHubWorld, makeHubIdentity, streamOf } from './helpers/hubWorld';
import type { HubWorld, Written } from './helpers/hubWorld';

// 33.2-05 (D-06): your organization's server applies the cutover rule with the fold's own function. After the project requires wrap@2, a grant of a
// new epoch holding an X25519 wrap is refused old-wrap-after-switch; an all-v2 grant is kept; an epoch founded before the switch may still be granted
// the older way. The hub knows wrap@2 because its runtime passes the probe. All names and keys are fictional.

const KEM = kemPublicFromSeeds({ p256: createHash('sha256').update('hub cutover p256').digest(), mlkem768: createHash('sha512').update('hub cutover mlkem').digest() });

interface Hub { store: HubStore; world: HubWorld; cache: RosterCache; close(): Promise<void> }

async function enrolledHub(prepare: (world: HubWorld) => void = () => undefined): Promise<Hub> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-cutover-'));
  const store = await openHubStore(dir);
  const identity = makeHubIdentity();
  const world = createHubWorld();
  world.admitHub(identity);
  prepare(world);
  const issued = issueHubFile(store, identity, { days: 7, now: new Date(WORLD_NOW) });
  if (!issued.ok) throw new Error(issued.message);
  const enrolled = await enrolProject({ store, identity, now: new Date(WORLD_NOW) }, world.enrolRequest(issued.file.payload));
  assert.equal(enrolled.ok ? 'ok' : enrolled.reason, 'ok');
  return { store, world, cache: new RosterCache(store, identity), async close() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

async function push(hub: Hub, entries: readonly unknown[], grants: readonly unknown[]): Promise<AppendResult> {
  const checked = await checkBatch({ project: hub.world.project, device: hub.world.lead.writer, entries, grants }, { store: hub.store, cache: hub.cache, limits: new RateLimits(), now: NOW_MS });
  if (!checked.ok) throw new Error(`the batch was refused ${checked.reason}`);
  return commitBatch(hub.store, hub.cache, checked.checked, NOW_MS);
}

const v1To = (world: HubWorld, cell: string): GrantWrap => ({ writer: world.lead.writer, wrap: wrapEpochKey({ cell, epoch: 1, writer: world.lead.writer, recipient: world.lead.x25519, epochKey: world.keyOf(cell, 1) }) });
const v2To = (world: HubWorld, cell: string): GrantWrap => ({ writer: world.lead.writer, wrap: wrapEpochKeyV2({ cell, epoch: 1, writer: world.lead.writer, recipient: KEM, epochKey: world.keyOf(cell, 1) }) });

function newCell(world: HubWorld, label: string, wrap: (world: HubWorld, cell: string) => GrantWrap): { cell: string; entry: Written; grant: SignedPayload<CellGrant> } {
  const cell = streamOf(`cell/${label}`);
  const wraps = [wrap(world, cell)];
  const v2 = Buffer.from(wraps[0].wrap, 'base64url').length !== 92;
  const founding = buildGrant(world.lead.signer, { cell, epoch: 1, roster: world.head, labelSealed: '', wraps, ...(v2 ? { pages: [] } : {}) });
  const entry = world.rosterEntry(world.lead, 'cell.create', { cell, epoch: 1, grant: grantHash(founding) });
  return { cell, entry, grant: founding };
}

const withHub = (prepare: (world: HubWorld) => void, body: (hub: Hub) => Promise<void>) => async (): Promise<void> => {
  const hub = await enrolledHub(prepare);
  try {
    await body(hub);
  } finally {
    await hub.close();
  }
};

const switched = (world: HubWorld): void => { world.rosterEntry(world.lead, 'roster.require', { features: [WRAP_FEATURE] }); };

test('this hub knows wrap@2 (its runtime passes the probe), so a project that requires it still takes appends', () => {
  assert.ok(hubReplicaFeatures().includes(WRAP_FEATURE));
});

test('after the switch a new epoch\'s grant with an X25519 wrap is refused old-wrap-after-switch; an all-v2 grant is kept', withHub(switched, async (hub) => {
  const old = newCell(hub.world, 'old', v1To);
  const fresh = newCell(hub.world, 'fresh', v2To);
  const result = await push(hub, [old.entry.entry, fresh.entry.entry], [old.grant, fresh.grant]);
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.grants.refused.map((item) => [item.hash, item.reason, item.message]), [[grantHash(old.grant), 'old-wrap-after-switch', WRAP_FORMAT_REFUSALS['old-wrap-after-switch']]]);
  assert.deepEqual(result.grants.stored, [grantHash(fresh.grant)]);
  assert.equal(APPEND_REFUSALS['old-wrap-after-switch'], WRAP_FORMAT_REFUSALS['old-wrap-after-switch']);
}));

test('a grant for an epoch the hub already holds from before the switch is judged at once with the fold\'s rule and kept in either format', withHub(() => undefined, async (hub) => {
  const before = newCell(hub.world, 'before', v1To);
  assert.deepEqual((await push(hub, [before.entry.entry], [before.grant])).grants.stored, [grantHash(before.grant)]);
  const require = hub.world.rosterEntry(hub.world.lead, 'roster.require', { features: [WRAP_FEATURE] });
  assert.deepEqual((await push(hub, [require.entry], [])).refused, []);
  const later = buildGrant(hub.world.lead.signer, { cell: before.cell, epoch: 1, roster: require.hash, labelSealed: '', wraps: [{ writer: hub.world.lead.writer, wrap: v1To(hub.world, before.cell).wrap }] });
  const result = await push(hub, [], [later]);
  assert.deepEqual(result.grants.refused, []);
  assert.deepEqual(result.grants.stored, [grantHash(later)]);
}));

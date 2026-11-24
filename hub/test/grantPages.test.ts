import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGrant, grantHash, wrapEpochKey } from '@ext/domain/replica/cellKeys';
import type { CellGrant, GrantWrap } from '@ext/domain/replica/cellKeys';
import type { SignedPayload } from '@ext/domain/team/signedPayload';
import { checkBatch, commitBatch } from '../src/append/checks';
import type { AppendInput, AppendResult } from '../src/append/checks';
import { RosterCache } from '../src/append/rosterCache';
import { enrolProject, issueHubFile } from '../src/enrol';
import type { HubIdentity } from '../src/enrol';
import { RateLimits } from '../src/limits';
import { openHubStore } from '../src/store/hubStore';
import type { HubStore } from '../src/store/hubStore';
import { NOW_MS, WORLD_NOW, createHubWorld, makeHubIdentity, streamOf } from './helpers/hubWorld';
import type { HubWorld, Written } from './helpers/hubWorld';

// 33.2-03 (D-04): your organization's server keeps a paged cell grant page by page. A page is kept only when its founding page and every other page
// it belongs with fold; the founding page's hash is what the cell.create cites; and the hub finds its own wrap on whichever page holds it. All names
// and keys are fictional.

interface Hub { dir: string; store: HubStore; identity: HubIdentity; world: HubWorld; cache: RosterCache; close(): Promise<void> }

async function enrolledHub(): Promise<Hub> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-pages-'));
  const store = await openHubStore(dir);
  const identity = makeHubIdentity();
  const world = createHubWorld();
  world.admitHub(identity);
  const issued = issueHubFile(store, identity, { days: 7, now: new Date(WORLD_NOW) });
  if (!issued.ok) throw new Error(issued.message);
  const enrolled = await enrolProject({ store, identity, now: new Date(WORLD_NOW) }, world.enrolRequest(issued.file.payload));
  assert.equal(enrolled.ok ? 'ok' : enrolled.reason, 'ok');
  return { dir, store, identity, world, cache: new RosterCache(store, identity), async close() { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

async function push(hub: Hub, entries: readonly unknown[], grants: readonly unknown[]): Promise<AppendResult> {
  const input: AppendInput = { project: hub.world.project, device: hub.world.lead.writer, entries, grants };
  const checked = await checkBatch(input, { store: hub.store, cache: hub.cache, limits: new RateLimits(), now: NOW_MS });
  if (!checked.ok) throw new Error(`the batch was refused ${checked.reason}`);
  return commitBatch(hub.store, hub.cache, checked.checked, NOW_MS);
}

type Page = SignedPayload<CellGrant>;
interface Paged { cell: string; founding: Page; page: Page; create: Written }

// A two-page founding grant for a new cell: the lead on the founding page, the hub on the second page.
function pagedCell(hub: Hub): Paged {
  const { world } = hub;
  const cell = streamOf('cell/paged');
  const key = world.keyOf(cell, 1);
  const wrapTo = (device: { writer: string; x25519: string }): GrantWrap => ({ writer: device.writer, wrap: wrapEpochKey({ cell, epoch: 1, writer: device.writer, recipient: device.x25519, epochKey: key }) });
  const page = buildGrant(world.lead.signer, { cell, epoch: 1, roster: world.head, labelSealed: '', wraps: [wrapTo({ writer: hub.identity.writer, x25519: hub.identity.x25519 })], pages: [] });
  const founding = buildGrant(world.lead.signer, { cell, epoch: 1, roster: world.head, labelSealed: '', wraps: [wrapTo(world.lead)], pages: [grantHash(page)] });
  const create = world.rosterEntry(world.lead, 'cell.create', { cell, epoch: 1, grant: grantHash(founding) });
  return { cell, founding, page, create };
}

const withHub = (body: (hub: Hub) => Promise<void>) => async (): Promise<void> => {
  const hub = await enrolledHub();
  try {
    await body(hub);
  } finally {
    await hub.close();
  }
};

test('a cell.create citing a founding page, sent with both pages, is accepted; the hub stores each page under its own hash', withHub(async (hub) => {
  const paged = pagedCell(hub);
  const result = await push(hub, [paged.create.entry], [paged.founding, paged.page]);
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.accepted, [paged.create.hash]);
  assert.deepEqual([...result.grants.stored].sort(), [grantHash(paged.founding), grantHash(paged.page)].sort());
  for (const page of [paged.founding, paged.page]) assert.equal(hub.store.grant(hub.world.project, grantHash(page))?.cell, paged.cell);
}));

test('the hub finds its own wrap on the second page and opens the cell', withHub(async (hub) => {
  const paged = pagedCell(hub);
  await push(hub, [paged.create.entry], [paged.founding, paged.page]);
  for (const roster of [await hub.cache.get(hub.world.project), await new RosterCache(hub.store, hub.identity).get(hub.world.project)]) {
    assert.deepEqual(roster.ring(paged.cell, 1), hub.world.keyOf(paged.cell, 1));
  }
}));

test('the founding page without its other page is not kept yet; sent again with the page, both are kept', withHub(async (hub) => {
  const paged = pagedCell(hub);
  const first = await push(hub, [paged.create.entry], [paged.founding]);
  assert.deepEqual(first.accepted, [paged.create.hash]);
  assert.deepEqual(first.grants.stored, []);
  assert.deepEqual(first.grants.refused.map((item) => item.reason), ['grant-not-placed']);
  const second = await push(hub, [], [paged.founding, paged.page]);
  assert.deepEqual(second.grants.refused, []);
  assert.equal(second.grants.stored.length, 2);
}));

test('a changed page is not kept, and neither is the founding page it belongs with', withHub(async (hub) => {
  const paged = pagedCell(hub);
  const changed = JSON.parse(JSON.stringify(paged.page)) as Page;
  changed.payload.wraps[0].writer = hub.world.lead.writer;
  const result = await push(hub, [paged.create.entry], [paged.founding, changed]);
  assert.deepEqual(result.grants.stored, []);
  assert.equal(hub.store.grant(hub.world.project, grantHash(paged.founding)), undefined);
}));

// A proposal's text travels as a blob (version.propose textBlob). Found in Phase 33 plan 24, through the live engine and a real hub: the proposer's
// push named no blob for it, and a device that took the proposal without its text never asked for it, so the proposal stayed held missing-blob on
// every other computer. The push names a proposal's text blob as it names a body blob and a compaction's state, and a proposal the fold holds for
// its text is a blob this device wants. Fictional exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../domain/replica/doc';
import { appendProductEntry, proposeVersion } from '../staff/replica/labelCells';
import { isProjectRefused } from '../staff/replica/replicaProject';
import { bringIn, grantsOn, leadWith, orgClearance, streamEntries, syncTo } from './helpers/labelCellWorld';

const PRODUCT = 'logistics-estimate';
const LABEL = 'org/Internal';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };

test('a proposal\'s text blob is named for the push, and a device holding the proposal without it wants it', async () => {
  const lead = await leadWith();
  const member = await bringIn(lead, 'member', 'Blake Rivers', orgClearance('Internal'));
  const created = await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Logistics estimate' }, { label: LABEL });
  assert.ok(created.ok, created.ok ? undefined : created.message);
  const { roster } = await lead.p.state();
  const clientId = clientIdOf(roster.members.devices.get(lead.writer)?.[0]?.slot ?? 1, 0);
  assert.ok((await appendProductEntry(lead.host, 'doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } })).ok);
  const doc = createLocalDoc(clientId);
  assert.ok((await appendProductEntry(lead.host, 'doc.update', { product: PRODUCT, update: Buffer.from(localInsert(doc, 0, 'Fuel for three days.')).toString('base64url') })).ok);
  const proposed = await proposeVersion(lead.host, { product: PRODUCT, text: docText(doc), header: { kind: 'estimate', label: LABEL, profile: 'j4', level: 'official' }, pins: [], snapshot: snapshotOf(doc) });
  assert.ok(proposed.ok, proposed.ok ? undefined : proposed.message);

  // The proposer names the text blob for the push, as for a body blob.
  const cited = await lead.p.blobsCitedBy([proposed.hash]);
  assert.equal(cited.length, 1);
  const [{ entry, blob }] = cited;
  assert.equal(entry, proposed.hash);
  assert.ok(await lead.p.blob(blob), 'the proposer holds the blob it names');

  // The member takes the label cell's entries without any blob: the proposal is held for its text, and that text blob is wanted.
  await syncTo(lead, member);
  const grants = grantsOn(lead.at).filter((item) => item.cell === proposed.stream).map((item) => item.signed);
  assert.ok(grants.length > 0);
  assert.ok(!isProjectRefused(await member.p.putGrants(grants)));
  assert.ok(!isProjectRefused(await member.p.ingestForeign(streamEntries(lead.at, proposed.stream), [])));
  const { fold } = await member.p.state();
  assert.ok(fold.held.some((item) => item.hash === proposed.hash && item.reason === 'missing-blob'), JSON.stringify(fold.held));
  assert.deepEqual(await member.p.wantedBlobs(), [blob]);
});

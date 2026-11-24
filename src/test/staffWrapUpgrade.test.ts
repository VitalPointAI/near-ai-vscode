// The three actions of the switch to post-quantum keys (33.2-07 Task 2; 33.2-CONTEXT D-05): the lead's switch, moving every part to a new
// post-quantum key, and giving keys to a computer that published its keys late. Fictional people and keys.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readGrant } from '../domain/replica/cellKeys';
import { wrapFormatOf } from '../domain/replica/cellWrapV2';
import { WRAP_FEATURE } from '../domain/replica/wrapFormat';
import { ensureLabelCell } from '../staff/replica/labelCells';
import { ensureDeviceKem } from '../staff/replica/kemPublish';
import { loadOrCreateKemKeys } from '../staff/replica/keyring';
import { updateMember } from '../staff/replica/membership';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { giveKeys, moveCellsToV2, switchToV2, wrapCardsFor } from '../staff/replica/wrapUpgrade';
import { identityDir } from '../team/identity';
import { LEAD_MEMBER, bringIn, grantsOn, hostOf, install, ok, orgClearance, orgLabel, project, syncTo } from './helpers/labelCellWorld';
import type { Install, Seat } from './helpers/labelCellWorld';

/** A lead whose project was made before the switch (wrapV2AtCreation false). */
async function unswitchedLead(label: string): Promise<Seat> {
  const at = install(label);
  at.deps.wrapV2AtCreation = false;
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Northwind', profile: 'j4', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: LEAD_MEMBER } }));
  const host = hostOf(p, at);
  ok(await updateMember(host, { member: LEAD_MEMBER, roles: ['member', 'section_lead:j4'], clearance: orgClearance('Confidential') }), 'the lead declares a clearance');
  return { at, p, host, member: LEAD_MEMBER, writer: p.deviceWriter, results: [] };
}

const publishKeys = (seat: Seat): Promise<string> => ensureDeviceKem(seat.p, { loadKeys: () => loadOrCreateKemKeys(seat.at.secrets, { identityDir: identityDir(seat.at.global) }) });
const rekeyedOf = (result: unknown): string[] => {
  const rekeyed = (result as { rekeyed?: unknown }).rekeyed;
  assert.ok(Array.isArray(rekeyed), `parts were moved: ${JSON.stringify(result)}`);
  return rekeyed as string[];
};
const required = async (seat: Seat): Promise<readonly string[]> => (await seat.p.state()).roster.required;
const formatsFor = (at: Install, cell: string, epoch: number): number[] => [...new Set(grantsOn(at).flatMap(({ signed }) => {
  const read = readGrant(signed);
  if (!read.ok || read.grant.cell !== cell || read.grant.epoch !== epoch) return [];
  return read.grant.wraps.map((item) => { const format = wrapFormatOf(item.wrap); return format.ok ? format.format : 0; });
}))].sort();

test('switchToV2 writes one roster.require wrap@2 once the lead\'s computer has published its keys; before that it writes nothing', async () => {
  const lead = await unswitchedLead('switch');
  assert.deepEqual(await switchToV2(lead.host), { ok: false, skipped: 'keys-not-published' });
  assert.equal((await publishKeys(lead)), 'published');
  const switched = await switchToV2(lead.host);
  assert.ok('hash' in switched);
  assert.ok((await required(lead)).includes(WRAP_FEATURE));
});

test('a second switch, or two at once, writes one roster.require between them', async () => {
  const lead = await unswitchedLead('switch-twice');
  await publishKeys(lead);
  const [first, second] = await Promise.all([switchToV2(lead.host), switchToV2(lead.host)]);
  assert.equal([first, second].filter((result) => 'hash' in result).length, 1);
  assert.deepEqual([first, second].find((result) => !('hash' in result)), { ok: false, skipped: 'already-switched' });
  const { roster } = await lead.p.state();
  assert.equal(roster.requiredFrom.get(WRAP_FEATURE) !== undefined, true);
});

test('a member who is not a lead cannot switch', async () => {
  const lead = await unswitchedLead('switch-member');
  const pat = await bringIn(lead, 'switch-pat', 'Pat Analyst', orgClearance('Internal'));
  assert.deepEqual(await switchToV2(pat.host), { ok: false, skipped: 'not-a-lead-device' });
});

test('a person key that refuses (no step-up) writes nothing and returns the refusal', async () => {
  const lead = await unswitchedLead('switch-stepup');
  await publishKeys(lead);
  await lead.p.close();
  const refusing = { fingerprint: lead.p.signer.fingerprint, publicKey: lead.p.signer.publicKey, sign: async () => ({ refused: 'Confirm with your passkey or security key to work on shared projects.' }) };
  const hosted = project(await ReplicaProject.open(lead.at.root, { ...lead.at.deps, personSigner: refusing }));
  const result = await switchToV2(hostOf(hosted, lead.at));
  assert.equal('hash' in result, false);
  assert.equal((result as { refused?: string }).refused, 'signer-refused');
  assert.equal((await hosted.state()).roster.required.includes(WRAP_FEATURE), false);
});

test('moveCellsToV2 gives every part whose holders have keys a new key with v2 wraps only, and the Move card goes away', async () => {
  const lead = await unswitchedLead('move');
  const made = await ensureLabelCell(lead.host, orgLabel('Internal'));
  assert.ok(made.ok);
  if (!made.ok) return;
  await publishKeys(lead);
  assert.ok('hash' in (await switchToV2(lead.host)));
  assert.deepEqual((await wrapCardsFor(lead.host)).map((card) => card.kind), ['move']);
  const moved = rekeyedOf(await moveCellsToV2(lead.host));
  assert.deepEqual([...moved].sort(), [lead.p.projectId, made.cell].sort());
  for (const cell of moved) assert.deepEqual(formatsFor(lead.at, cell, 2), [2]);
  assert.deepEqual(await wrapCardsFor(lead.host), []);
});

test('a computer that published late is offered Give keys; giveKeys writes a v2 grant of the current key to it only, and the card goes away', async () => {
  const lead = await unswitchedLead('give');
  const pat = await bringIn(lead, 'give-pat', 'Pat Analyst', orgClearance('Internal'));
  await publishKeys(lead);
  assert.ok('hash' in (await switchToV2(lead.host)));
  // Pat has not published: the base cell moves without Pat, at once.
  assert.ok(rekeyedOf(await moveCellsToV2(lead.host, { includeWaiting: true })).includes(lead.p.projectId));
  assert.equal(formatsFor(lead.at, lead.p.projectId, 2).length > 0, true);
  assert.equal(await publishKeys(pat), 'published');
  await syncTo(pat, lead);
  const cards = await wrapCardsFor(lead.host);
  assert.deepEqual(cards.map((card) => card.kind), ['give-keys']);
  const given = await giveKeys(lead.host);
  assert.deepEqual(given, { ok: true, given: [pat.writer] });
  const patGrants = grantsOn(lead.at).flatMap(({ signed }) => { const read = readGrant(signed); return read.ok && read.grant.epoch === 2 && read.grant.cell === lead.p.projectId ? read.grant.wraps.filter((item) => item.writer === pat.writer) : []; });
  assert.equal(patGrants.length, 1);
  assert.deepEqual(wrapFormatOf(patGrants[0].wrap), { ok: true, format: 2 });
  assert.deepEqual(await wrapCardsFor(lead.host), []);
});

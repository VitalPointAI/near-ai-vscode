// Phase 33 plan 27 Task 2 (D-13, D-42): trusting your organization's server again after a fork or rollback finding. Only a lead or deputy device,
// only after the twelve words of the server's certificate pin match, and then one hub.readmit signed by the device the roster names: in a hosted
// session the person key, never the session key. Folding it lists the entry for every member's witness (hubSync.ts readmitWitness). Fictional
// exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHubFile } from '../domain/replica/hubFile';
import { hubAt } from '../domain/replica/rosterMembers';
import { rosterView } from '../domain/replica/roster';
import { serverPinWords } from '../domain/replica/serverWords';
import { admitHub, revokeHub } from '../staff/replica/hubMembership';
import { HUB_READMIT_REFUSALS, readmitHub, readmitWordsMatch, typedWords } from '../staff/replica/hubReadmit';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { STEP_UP_TEXT, hostedInstall } from './helpers/hostedWorld';
import { WORLD_NOW, bringIn, hostOf, leadWith, ok, orgClearance, project } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';
import { rosterDevice } from './helpers/replicaRosterWorld';

const CERT_PIN = 'b'.repeat(64);
const RESTORED_PIN = 'c'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

function hubFileText(): { text: string; hub: string } {
  const device = rosterDevice('HUB-NORTH', 'hub');
  const signed = buildHubFile(device.signer, {
    address: 'hub.example.test:8443', certPin: CERT_PIN, x25519: device.x25519, x25519Sig: device.x25519Sig, enrolment: 'enr-00112233aabbccdd',
    enrolmentSecret: Buffer.alloc(32, 7).toString('base64url'), expiresAt: new Date(WORLD_NOW.getTime() + 7 * DAY_MS).toISOString(), now: WORLD_NOW
  });
  return { text: JSON.stringify(signed), hub: `hub-${device.writer.slice(0, 16)}` };
}

async function leadWithHub(): Promise<{ lead: Seat; hub: string }> {
  const lead = await leadWith({ label: 'readmit-lead' });
  const file = hubFileText();
  ok(await admitHub(lead.host, file.text, { ceiling: orgClearance('Confidential') }), 'the hub is admitted');
  return { lead, hub: file.hub };
}

test('the words are compared in order, ignoring case, spaces and commas; a different pin or order never matches', () => {
  const words = serverPinWords(RESTORED_PIN);
  assert.equal(words.length, 12);
  assert.equal(readmitWordsMatch(RESTORED_PIN, words.join(', ').toUpperCase()), true);
  assert.equal(readmitWordsMatch(RESTORED_PIN, words), true);
  assert.equal(readmitWordsMatch(RESTORED_PIN, [...words].reverse()), false);
  assert.equal(readmitWordsMatch(RESTORED_PIN, words.slice(0, 11)), false);
  assert.equal(readmitWordsMatch(CERT_PIN, words), false);
  assert.deepEqual(typedWords(' Alpha,bravo;  CHARLIE. '), ['alpha', 'bravo', 'charlie']);
});

test('words that do not match the pin are refused before anything is written', async () => {
  const { lead, hub } = await leadWithHub();
  const before = (await lead.p.state()).roster.positions.length;
  const refused = await readmitHub(lead.host, { hub, certPin: RESTORED_PIN, words: serverPinWords(CERT_PIN) });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'words-differ');
  assert.equal(refused.message, HUB_READMIT_REFUSALS['words-differ']);
  const invalid = await readmitHub(lead.host, { hub, certPin: 'not-a-pin', words: [] });
  assert.equal(invalid.reason, 'pin-invalid');
  assert.equal((await lead.p.state()).roster.positions.length, before, 'nothing was written');
});

test('matching words write one hub.readmit with the compared pin; the fold opens a trusted version and lists it for every witness', async () => {
  const { lead, hub } = await leadWithHub();
  const done = ok(await readmitHub(lead.host, { hub, certPin: RESTORED_PIN, words: serverPinWords(RESTORED_PIN).join(' ') }), 'readmit');
  assert.equal(done.hub, hub);
  const { roster } = await lead.p.state();
  const head = roster.positions.length - 1;
  assert.equal(hubAt(roster.members, hub, head)?.certPin, RESTORED_PIN);
  const readmits = rosterView(roster).hubReadmits?.(hub) ?? [];
  assert.deepEqual(readmits, [roster.positions[head]], 'the entry every member\'s witness applies once');
});

test('a member who is not a lead or deputy is refused as every roster change; a revoked hub is refused, and nothing is written', async () => {
  const { lead, hub } = await leadWithHub();
  const member = await bringIn(lead, 'readmit-member', 'Blake Rivers', orgClearance('Internal'));
  const asMember = await readmitHub(member.host, { hub, certPin: RESTORED_PIN, words: serverPinWords(RESTORED_PIN) });
  assert.equal(asMember.ok, false);
  assert.equal(asMember.reason, 'not-a-roster-writer');
  ok(await revokeHub(lead.host, { hub }), 'the hub is revoked');
  const before = (await lead.p.state()).roster.positions.length;
  const revoked = await readmitHub(lead.host, { hub, certPin: RESTORED_PIN, words: serverPinWords(RESTORED_PIN) });
  assert.equal(revoked.reason, 'hub-revoked');
  assert.equal((await lead.p.state()).roster.positions.length, before);
});

test('hosted: the person key signs hub.readmit after a fresh confirmation; without one nothing is written and the key store\'s sentence is shown', async () => {
  const at = await hostedInstall('readmit-hosted');
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Northwind', profile: 'j4', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' } }));
  const host = hostOf(p, at);
  const file = hubFileText();
  ok(await admitHub(host, file.text, { ceiling: orgClearance('Internal') }), 'the hosted lead admits the hub');
  at.person.stale = true;
  const before = (await p.state()).roster.positions.length;
  const stale = await readmitHub(host, { hub: file.hub, certPin: RESTORED_PIN, words: serverPinWords(RESTORED_PIN) });
  assert.equal(stale.ok, false);
  assert.equal(stale.message, STEP_UP_TEXT);
  assert.equal((await p.state()).roster.positions.length, before, 'nothing was written');
  at.person.stale = false;
  const signedBefore = at.person.signed;
  ok(await readmitHub(host, { hub: file.hub, certPin: RESTORED_PIN, words: serverPinWords(RESTORED_PIN) }), 'readmit');
  assert.ok(at.person.signed > signedBefore, 'the person key signed it');
  // The fold places a hub.readmit only from a lead device and refuses a session key on a person-key kind (D-62), so a folded entry is the person's.
  const { roster } = await p.state();
  assert.equal(hubAt(roster.members, file.hub, roster.positions.length - 1)?.certPin, RESTORED_PIN, 'the person key\'s hub.readmit folded');
});

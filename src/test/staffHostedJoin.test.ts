// Phase 33 plan 27 (D-60, D-61): hosted joining in the engine. In a hosted session the person key is the device the roster names, so it signs
// everything the roster or a joining computer checks against that device: the genesis and its founding grant, the binding of the X25519 key, cell
// grants, invitations, join requests and hub join envelopes. The session key signs none of them. A person key that refuses (no fresh confirmation)
// signs nothing and the flow returns the key store's sentence. Fictional exercise data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readGrant, x25519BindingBytes } from '../domain/replica/cellKeys';
import { writerIdOf } from '../domain/replica/entry';
import { readInvite } from '../domain/replica/invite';
import { deviceAt } from '../domain/replica/rosterMembers';
import { verifySignature } from '../domain/team/canonical';
import { admitJoinRequest, inviteToProject, joinFromInvite, openWelcome } from '../staff/replica/membership';
import { ReplicaProject } from '../staff/replica/replicaProject';
import { STEP_UP_TEXT, hostedInstall } from './helpers/hostedWorld';
import type { HostedInstall } from './helpers/hostedWorld';
import { WORLD_NOW, grantsOn, hostOf, ok, orgClearance, project } from './helpers/labelCellWorld';

async function hostedLead(label: string): Promise<{ at: HostedInstall; p: ReplicaProject }> {
  const at = await hostedInstall(label);
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Northwind', profile: 'j4', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' } }));
  return { at, p };
}

test('a hosted lead makes shared work: the person key is the lead device, signs the genesis and the founding grant, and binds the X25519 key', async () => {
  const { at, p } = await hostedLead('hosted-genesis');
  assert.equal(p.deviceWriter, writerIdOf(at.person.publicKey));
  assert.equal(p.anchor.lead.publicKey, at.person.publicKey, 'the anchor names the person key');
  const { roster } = await p.state();
  const lead = deviceAt(roster.members, p.deviceWriter, roster.positions.length - 1);
  assert.equal(lead?.publicKey, at.person.publicKey);
  const encryption = at.deps.hosted?.encryption;
  assert.equal(lead?.x25519, encryption?.publicKey, 'the lead device\'s X25519 key is the session\'s opened key');
  assert.ok(verifySignature(x25519BindingBytes(lead?.x25519 as string, p.deviceWriter), encryption?.binding as string, at.person.publicKey), 'the person key bound it');
  assert.ok(roster.required.includes('require@1'), 'the feature check is armed, by the person key');
  for (const { signed } of grantsOn(at)) {
    const read = readGrant(signed);
    assert.ok(read.ok);
    assert.equal(read.signer.publicKey, at.person.publicKey, 'every grant on disk is the person key\'s');
  }
});

test('hosted joining end to end: invitation, join request and grants are signed by the person keys; the joiner opens the work as its person key', async () => {
  const { at: leadAt, p: lead } = await hostedLead('hosted-lead');
  const joinerAt = await hostedInstall('hosted-joiner');
  const leadHost = hostOf(lead, leadAt);
  const invited = ok(await inviteToProject(leadHost, { name: 'Blake Rivers', seat: 'j4-planner', clearance: orgClearance('Internal') }), 'invite');
  const invite = readInvite(invited.file?.text, WORLD_NOW);
  assert.ok(invite.ok);
  assert.equal(invite.invite.inviter.publicKey, leadAt.person.publicKey, 'the invitation is the lead\'s person key\'s');

  const sessionBefore = joinerAt.sessionSigned;
  const joined = ok(await joinFromInvite(joinerAt.root, joinerAt.deps, invited.file?.text, { name: 'Blake Rivers' }), 'join');
  const request = JSON.parse(joined.file?.text as string) as { signer: { publicKey: string }; payload: { publicKey: string } };
  assert.equal(request.signer.publicKey, joinerAt.person.publicKey);
  assert.equal(request.payload.publicKey, joinerAt.person.publicKey, 'the joining device is the joiner\'s person key');
  assert.equal(joinerAt.sessionSigned, sessionBefore, 'the joiner\'s session key signed nothing for the join');

  const admitted = ok(await admitJoinRequest(leadHost, joined.file?.text, { codeMatched: true }), 'admit');
  const welcome = JSON.parse(admitted.file?.text as string) as { grants: unknown[] };
  assert.ok(welcome.grants.length > 0);
  for (const grant of welcome.grants) {
    const read = readGrant(grant);
    assert.ok(read.ok);
    assert.equal(read.signer.publicKey, leadAt.person.publicKey, 'the grants the joiner receives are the lead\'s person key\'s');
  }
  for (const { signed } of grantsOn(leadAt)) {
    const read = readGrant(signed);
    assert.ok(read.ok && read.signer.publicKey !== leadAt.session.publicKey, 'no grant the session key signed is stored');
  }

  const opened = ok(await openWelcome(joinerAt.root, joinerAt.deps, admitted.file?.text), 'welcome');
  const joiner = project(opened.project);
  assert.equal(joiner.deviceWriter, writerIdOf(joinerAt.person.publicKey));
  const { roster } = await joiner.state();
  assert.equal(deviceAt(roster.members, joiner.deviceWriter, roster.positions.length - 1)?.member, admitted.member, 'the joiner is the member\'s device');
  assert.ok(joiner.keys.epochKey(joiner.projectId, 1) !== undefined, 'the joiner opens the base cell with its X25519 key');
});

test('a person key without a fresh confirmation signs nothing: the invitation file and the join request are refused with the key store\'s sentence', async () => {
  const { at: leadAt, p: lead } = await hostedLead('hosted-stale');
  leadAt.person.stale = true;
  const refused = await inviteToProject(hostOf(lead, leadAt), { name: 'Casey Stone', seat: 'j4-planner', clearance: orgClearance('Internal') });
  assert.equal(refused.ok, false);
  assert.equal(refused.message, STEP_UP_TEXT);
  assert.equal(refused.file, undefined, 'no invitation file was made');

  leadAt.person.stale = false;
  const invited = ok(await inviteToProject(hostOf(lead, leadAt), { name: 'Casey Stone', seat: 'j4-planner', clearance: orgClearance('Internal') }), 'invite');
  const joinerAt = await hostedInstall('hosted-stale-joiner');
  joinerAt.person.stale = true;
  await assert.rejects(joinFromInvite(joinerAt.root, joinerAt.deps, invited.file?.text, { name: 'Casey Stone' }), (error: Error) => error.message === STEP_UP_TEXT);
  assert.equal(joinerAt.person.signed, 1, 'only the X25519 binding at install; nothing more was signed');
});

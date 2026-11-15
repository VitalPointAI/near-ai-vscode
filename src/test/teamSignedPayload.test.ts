// Signed payload tests (TMR-05, D-08, D-20, D-21): one signer and verifier for any canonical payload, checked against a key status lookup.
// Keys and canaries are generated at run time; no key material or token literal is written here.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { reduce } from '../domain/team/materialize';
import { NO_KNOWN_KEYS, teamKeyStatus } from '../domain/team/keyStatus';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { TeamState } from '../domain/team/types';
import { loadOrCreateDeviceIdentity } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { newMemberId, newTeamId } from '../team/identity';
import { entryOf } from './helpers/teamEvents';
import { MemorySecrets, testGenesis } from './helpers/teamHarness';

interface TeamWorld { identity: DeviceIdentity; memberId: string; state: TeamState }

// The person's identity is created the way the extension creates it (first need, under the lock), then becomes the owner's device in a team.
async function teamWorld(): Promise<TeamWorld> {
  const folder = await mkdtemp(path.join(tmpdir(), 'near-ai-payload-'));
  try {
    const secrets = new MemorySecrets();
    const { identity } = await loadOrCreateDeviceIdentity(secrets, { identityDir: folder });
    const teamId = newTeamId();
    const memberId = newMemberId();
    const genesis = testGenesis({ teamId, owner: { identity, memberId, secrets }, name: 'Payload test team' });
    const state = reduce(genesis.events.map((event) => entryOf(event)), genesis.anchor);
    return { identity, memberId, state };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('tracer: the person\'s identity signs a policy-bundle sample and the verifier checks it against the team roster', async () => {
  const world = await teamWorld();
  const sample = { version: 1, expiresAt: '2027-01-01T00:00:00Z', issuer: world.identity.fingerprint, rules: [] as string[] };
  const envelope = signPayload(world.identity, 'policy-bundle', sample, { memberId: world.memberId });
  assert.equal(envelope.v, 1);
  assert.equal(envelope.purpose, 'policy-bundle');
  assert.equal(envelope.signer.fingerprint, world.identity.fingerprint);
  assert.equal(envelope.signer.publicKey, world.identity.publicKey);
  const verdict = verifyPayload<typeof sample>(envelope, { purpose: 'policy-bundle', status: teamKeyStatus(world.state) });
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  assert.deepEqual(verdict.payload, sample);
  assert.equal(verdict.signer.memberId, world.memberId);
  assert.equal(verdict.keyState, 'active');
  const unknown = verifyPayload(envelope, { purpose: 'policy-bundle', status: NO_KNOWN_KEYS });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, 'unknown-key');
});

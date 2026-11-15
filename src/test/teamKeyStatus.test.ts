// Key status tests (D-09): the team roster as a status source and how sources combine.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { reduce } from '../domain/team/materialize';
import { NO_KNOWN_KEYS, teamKeyStatus } from '../domain/team/keyStatus';
import { newTeamId } from '../team/identity';
import { genesisEntries, makeActor } from './helpers/teamEvents';

function randomKey(): { fingerprint: string; publicKey: string } {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  return { fingerprint: 'dev-' + 'f'.repeat(32), publicKey: jwk.x as string };
}

test('a key bound to a member in the roster is active', async () => {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  const lookup = teamKeyStatus(reduce(entries, anchor));
  assert.deepEqual(lookup({ fingerprint: owner.identity.fingerprint, publicKey: owner.identity.publicKey }), { state: 'active' });
});

test('a key the roster does not hold, or holds with a different public key, is unknown', async () => {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  const lookup = teamKeyStatus(reduce(entries, anchor));
  assert.deepEqual(lookup(randomKey()), { state: 'unknown' });
  assert.deepEqual(lookup({ fingerprint: owner.identity.fingerprint, publicKey: randomKey().publicKey }), { state: 'unknown' });
  assert.deepEqual(NO_KNOWN_KEYS(randomKey()), { state: 'unknown' });
});

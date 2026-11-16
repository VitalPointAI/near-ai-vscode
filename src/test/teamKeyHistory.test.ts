// Local key history tests (TMR-05, D-09, D-21): a person without a team keeps a signed, hash-chained record of their keys, and replaying it gives
// the same kind of status lookup a team roster gives. Keys are generated at run time; no key material is written here.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fingerprintOf } from '../domain/team/canonical';
import { replayKeyHistory } from '../domain/team/keyRecords';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { KEY_HISTORY_FILE, KEY_HISTORY_HEAD_SECRET, appendKeyRecord, localKeyStatus, readKeyHistory } from '../team/keyHistory';
import { MemorySecrets } from './helpers/teamHarness';

interface TestSigner extends PayloadSigner { readonly privateKey: KeyObject }

// A plain Ed25519 key held in a closure, the way an agent-style signer or the device identity is.
function makeSigner(): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return {
    privateKey,
    fingerprint: fingerprintOf(raw),
    publicKey: raw.toString('base64url'),
    sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url')
  };
}

function refOf(signer: PayloadSigner): { fingerprint: string; publicKey: string } {
  return { fingerprint: signer.fingerprint, publicKey: signer.publicKey };
}

async function withFolder<T>(work: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(path.join(tmpdir(), 'near-ai-keyhistory-'));
  try {
    return await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const at = (iso: string) => (): Date => new Date(iso);

test('tracer: a created record is written, read back and used to verify a solo payload', async () => {
  await withFolder(async (folder) => {
    const secrets = new MemorySecrets();
    const signer = makeSigner();
    const written = await appendKeyRecord(folder, secrets, signer, { kind: 'created', key: refOf(signer) }, { now: at('2026-03-01T10:00:00.000Z') });
    assert.equal(written.ok, true);

    const read = await readKeyHistory(folder, secrets);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.deepEqual(read.active, refOf(signer));
    assert.equal(read.head?.seq, 1);
    assert.equal(secrets.values.has(KEY_HISTORY_HEAD_SECRET), true);

    const grant = signPayload(signer, 'grant', { capability: 'read', until: '2026-12-01T00:00:00Z' });
    const verdict = verifyPayload(grant, { purpose: 'grant', status: await localKeyStatus(folder, secrets) });
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.keyState, 'active');

    // A key the history never saw is unknown, so its payload is refused.
    const stranger = makeSigner();
    const strangers = signPayload(stranger, 'grant', { capability: 'read', until: '2026-12-01T00:00:00Z' });
    const refused = verifyPayload(strangers, { purpose: 'grant', status: await localKeyStatus(folder, secrets) });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, 'unknown-key');

    // The file holds the public key and no rendering of the private key.
    const fileText = await readFile(path.join(folder, KEY_HISTORY_FILE), 'utf8');
    const headText = secrets.values.get(KEY_HISTORY_HEAD_SECRET) ?? '';
    const der = signer.privateKey.export({ format: 'der', type: 'pkcs8' });
    const pem = String(signer.privateKey.export({ format: 'pem', type: 'pkcs8' })).split('\n').filter((line) => !line.startsWith('-----')).join('');
    const jwkD = (signer.privateKey.export({ format: 'jwk' }) as { d: string }).d;
    const seed = der.subarray(der.length - 32);
    assert.ok(fileText.includes(signer.publicKey));
    for (const rendering of [der.toString('base64'), pem, jwkD, seed.toString('base64'), seed.toString('hex')]) {
      assert.ok(!fileText.includes(rendering), 'the history file must not hold a rendering of the private key');
      assert.ok(!headText.includes(rendering), 'the saved head must not hold a rendering of the private key');
    }
  });
});

test('an absent history is empty and trusts no key', async () => {
  await withFolder(async (folder) => {
    const replay = await readKeyHistory(path.join(folder, 'identity'), new MemorySecrets());
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.active, undefined);
    assert.equal(replay.head, undefined);
    assert.equal(replay.lookup(refOf(makeSigner())).state, 'unknown');
    assert.equal(replayKeyHistory(undefined, undefined).ok, false);
  });
});

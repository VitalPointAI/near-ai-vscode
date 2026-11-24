import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { x25519BindingBytes, x25519PrivateFromSeed, x25519PublicRaw } from '@ext/domain/replica/cellKeys';
import { writerIdOf } from '@ext/domain/replica/entry';
import { fingerprintOf, verifySignature } from '@ext/domain/team/canonical';
import { generateKeyFile, KEY_PREFIXES, KeyFileError, readEncryptionKey, readKemKey, readSigningKey } from '../src/keys';
import { generateKeyPairSync } from 'node:crypto';
import { wrapEpochKey } from '@ext/domain/replica/cellKeys';
import { wrapEpochKeyV2 } from '@ext/domain/replica/cellWrapV2';
import { kemBindingHolds } from '@ext/domain/replica/deviceKem';
import { hubDeviceKemData } from '@ext/domain/replica/hubFile';
import { openHubWrap } from '../src/append/rosterCache';
import { hubIdentityOf, issueHubFile } from '../src/enrol';
import type { HubStore } from '../src/store/hubStore';
import { BIN } from './helpers/hubProcess';

// Phase 32, plan 14 (D-30): the hub's own keys. The operator makes each with --generate-key, which prints exactly one key line on stdout and writes
// nothing; the hub reads the line back from a secret file. The keys made here are fresh random keys that live only for the test.

const SIGNING_LINE = /^near-ai-hub-signing-key:v1:[A-Za-z0-9_-]{43}$/;
const ENCRYPTION_LINE = /^near-ai-hub-encryption-key:v1:[A-Za-z0-9_-]{43}$/;

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBin(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN(), ...args], { cwd, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function withEmptyFolder<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-keys-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('generateKeyFile gives one line of the right kind, with a fresh 32-byte seed each time', () => {
  const first = generateKeyFile('signing');
  const second = generateKeyFile('signing');
  assert.match(first, SIGNING_LINE);
  assert.notEqual(first, second);
  assert.match(generateKeyFile('encryption'), ENCRYPTION_LINE);
  assert.equal(Buffer.from(first.slice(KEY_PREFIXES.signing.length), 'base64url').length, 32);
});

for (const [kind, pattern] of [['signing', SIGNING_LINE], ['encryption', ENCRYPTION_LINE]] as const) {
  test(`--generate-key ${kind} exits 0 with exactly one ${kind} key line on stdout, empty stderr, and writes nothing in its working folder`, async () => {
    await withEmptyFolder(async (dir) => {
      const run = await runBin(['--generate-key', kind], dir);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stderr, '');
      assert.ok(run.stdout.endsWith('\n'), 'the key line ends with a newline');
      const lines = run.stdout.slice(0, -1).split('\n');
      assert.equal(lines.length, 1, `exactly one line, got: ${run.stdout}`);
      assert.match(lines[0] as string, pattern);
      assert.deepEqual(await readdir(dir), [], 'the hub wrote a file of its own');
    });
  });
}

test('--generate-key reads no settings and no secrets: a broken HUB_PORT and a plain secret in the environment do not stop it', async () => {
  await withEmptyFolder(async (dir) => {
    const run = await runBin(['--generate-key', 'signing'], dir, { HUB_PORT: 'not-a-port', HUB_SIGNING_KEY: 'fake-plain-value-1234', HUB_COLOUR: 'blue' });
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stdout.trim(), SIGNING_LINE);
    // The line it printed is one the hub reads back.
    assert.match(readSigningKey(run.stdout).writer, /^[0-9a-f]{64}$/);
  });
});

test('--generate-key with a third word, an unknown kind or no kind is refused with exit 1 and prints no key line', async () => {
  await withEmptyFolder(async (dir) => {
    for (const args of [['--generate-key', 'signing', 'extra'], ['--generate-key', 'pseudonym'], ['--generate-key']]) {
      const run = await runBin(args, dir);
      assert.equal(run.code, 1, args.join(' '));
      assert.ok(!run.stdout.includes('near-ai-hub-'), `${args.join(' ')} printed a key line`);
      const lines = run.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(lines.map((line) => line.event), ['hub.start_refused'], args.join(' '));
      assert.equal(lines[0]?.reason, 'config');
      assert.ok(!run.stdout.includes('pseudonym') && !run.stdout.includes('extra'), 'the refused word was echoed');
      assert.equal(run.stderr, '');
      assert.deepEqual(await readdir(dir), []);
    }
  });
});

function refused(action: () => unknown, setting: string, pattern: RegExp, keyText: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof KeyFileError, `expected a KeyFileError, got ${String(error)}`);
    assert.equal(error.setting, setting);
    assert.match(error.message, pattern);
    assert.ok(error.message.includes(setting), 'the sentence names the setting');
    assert.ok(!error.message.includes(keyText.slice(-20)), 'the sentence repeated the key text');
    assert.ok(!error.message.includes('\u2014'), 'no em-dash');
    return true;
  });
}

test('readSigningKey refuses an encryption line, a truncated seed, a seed with bad characters and text that is no key line, in plain sentences', () => {
  const signing = generateKeyFile('signing');
  const encryption = generateKeyFile('encryption');
  refused(() => readSigningKey(encryption), 'HUB_SIGNING_KEY', /encryption key, not its signing key/, encryption);
  refused(() => readSigningKey(signing.slice(0, -4)), 'HUB_SIGNING_KEY', /damaged: the key part must be 32 bytes/, signing);
  refused(() => readSigningKey(`${signing.slice(0, -1)}+`), 'HUB_SIGNING_KEY', /damaged/, signing);
  refused(() => readSigningKey(`${signing}AAAA`), 'HUB_SIGNING_KEY', /damaged/, signing);
  refused(() => readSigningKey('fake-not-a-key-line-0000000000000000000000'), 'HUB_SIGNING_KEY', /not a hub signing key line/, 'fake-not-a-key-line-0000000000000000000000');
  const reader = readSigningKey(signing);
  refused(() => readEncryptionKey(signing, reader), 'HUB_ENCRYPTION_KEY', /signing key, not its encryption key/, signing);
  refused(() => readEncryptionKey(encryption.slice(0, -2), reader), 'HUB_ENCRYPTION_KEY', /damaged/, encryption);
  // One trailing newline, as a saved file has, is accepted.
  assert.equal(readSigningKey(`${signing}\n`).writer, reader.writer);
});

test('readSigningKey gives a signer whose writer id is writerIdOf(publicKey) and whose fingerprint and signatures check out', () => {
  const line = generateKeyFile('signing');
  const key = readSigningKey(line);
  const raw = Buffer.from(key.publicKey, 'base64url');
  assert.equal(raw.length, 32);
  assert.equal(key.writer, writerIdOf(key.publicKey));
  assert.equal(key.signer.publicKey, key.publicKey);
  assert.equal(key.signer.fingerprint, fingerprintOf(raw));
  const bytes = Buffer.from('fictional exercise payload', 'utf8');
  const signature = key.signer.sign(bytes);
  assert.ok(verifySignature(bytes, signature, key.publicKey));
  assert.ok(!verifySignature(Buffer.from('another payload', 'utf8'), signature, key.publicKey));
  // The same line always gives the same hub.
  assert.equal(readSigningKey(line).writer, key.writer);
});

test('readEncryptionKey gives the X25519 key of the seed and a binding signature over x25519BindingBytes that the signing key made', () => {
  const signingLine = generateKeyFile('signing');
  const encryptionLine = generateKeyFile('encryption');
  const signing = readSigningKey(signingLine);
  const encryption = readEncryptionKey(encryptionLine, signing);
  const seed = Buffer.from(encryptionLine.slice(KEY_PREFIXES.encryption.length), 'base64url');
  const expected = x25519PublicRaw(x25519PrivateFromSeed(seed));
  assert.equal(encryption.x25519, expected.toString('base64url'));
  assert.deepEqual(x25519PublicRaw(encryption.privateKey), expected);
  assert.ok(verifySignature(x25519BindingBytes(expected, signing.writer), encryption.x25519Sig, signing.publicKey), 'the binding signature verifies');
  const other = readSigningKey(generateKeyFile('signing'));
  assert.ok(!verifySignature(x25519BindingBytes(expected, other.writer), encryption.x25519Sig, signing.publicKey), 'the binding names this writer only');
});

// ---- 33.2-04 Task 3 (D-03): the hub's own post-quantum keys ----

test('generateKeyFile(kem) gives one near-ai-hub-kem-key:v2 line of 96 bytes; readKemKey gives the keys and a binding the signing key made', () => {
  const line = generateKeyFile('kem');
  assert.match(line, /^near-ai-hub-kem-key:v2:[A-Za-z0-9_-]{128}$/);
  assert.equal(KEY_PREFIXES.kem, 'near-ai-hub-kem-key:v2:');
  const signing = readSigningKey(generateKeyFile('signing'));
  const kem = readKemKey(`${line}\n`, signing);
  assert.equal(Buffer.from(kem.publicKeys.p256, 'base64url').length, 65);
  assert.equal(Buffer.from(kem.publicKeys.mlkem768, 'base64url').length, 1184);
  assert.equal(kemBindingHolds({ ...kem.publicKeys, sig: kem.sig }, signing.writer, signing.publicKey), true);
  assert.deepEqual(readKemKey(line, signing).publicKeys, kem.publicKeys, 'the same line gives the same keys');
});

test('readKemKey refuses a signing line, an encryption line and a truncated line, in plain sentences naming HUB_KEM_KEY', () => {
  const signingLine = generateKeyFile('signing');
  const signing = readSigningKey(signingLine);
  const kemLine = generateKeyFile('kem');
  refused(() => readKemKey(signingLine, signing), 'HUB_KEM_KEY', /signing key, not its kem key/, signingLine);
  refused(() => readKemKey(generateKeyFile('encryption'), signing), 'HUB_KEM_KEY', /encryption key, not its kem key/, kemLine);
  refused(() => readKemKey(kemLine.slice(0, -4), signing), 'HUB_KEM_KEY', /damaged/, kemLine);
  refused(() => readSigningKey(kemLine), 'HUB_SIGNING_KEY', /kem key, not its signing key/, kemLine);
});

test('the hub opens an epoch key granted to it in a v1 wrap and in a v2 wrap; without a kem key it opens the v1 wrap only', () => {
  const signing = readSigningKey(generateKeyFile('signing'));
  const encryption = readEncryptionKey(generateKeyFile('encryption'), signing);
  const kem = readKemKey(generateKeyFile('kem'), signing);
  const cell = 'a'.repeat(32);
  const epochKey = Buffer.alloc(32, 9);
  const grant = { cell, epoch: 2, roster: 'b'.repeat(64), labelSealed: '', wraps: [] };
  const v1 = wrapEpochKey({ cell, epoch: 2, writer: signing.writer, recipient: encryption.x25519, epochKey });
  const v2 = wrapEpochKeyV2({ cell, epoch: 2, writer: signing.writer, recipient: kem.publicKeys, epochKey });
  const withKem = { writer: signing.writer, x25519Private: encryption.privateKey, kem };
  const withoutKem = { writer: signing.writer, x25519Private: encryption.privateKey };
  assert.deepEqual(openHubWrap(withKem, grant, v1), epochKey);
  assert.deepEqual(openHubWrap(withKem, grant, v2), epochKey);
  assert.deepEqual(openHubWrap(withoutKem, grant, v1), epochKey);
  assert.equal(openHubWrap(withoutKem, grant, v2), undefined);
});

test('a hub with a kem key issues a hub file carrying its keys and binding, from which a lead builds the hub\'s device.kem; without one, no kem', () => {
  const signing = readSigningKey(generateKeyFile('signing'));
  const encryption = readEncryptionKey(generateKeyFile('encryption'), signing);
  const kem = readKemKey(generateKeyFile('kem'), signing);
  const withKem = hubIdentityOf(signing, encryption, generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey, 'hub.example.org:8443', kem);
  const store = { putEnrolment: () => undefined } as unknown as HubStore;
  const issued = issueHubFile(store, withKem, { days: 7, now: new Date('2026-11-24T10:00:00.000Z') });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const data = hubDeviceKemData(issued.file.payload);
  assert.deepEqual(data, { device: signing.writer, ...kem.publicKeys, sig: kem.sig });
  const without = issueHubFile(store, hubIdentityOf(signing, encryption, generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey, 'hub.example.org:8443'), { days: 7, now: new Date('2026-11-24T10:00:00.000Z') });
  assert.equal(without.ok && Object.prototype.hasOwnProperty.call(without.file.payload, 'kem'), false);
});

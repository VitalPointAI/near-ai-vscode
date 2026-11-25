// Show This Computer's Identity (Phase 71 plan 10 Task 3; VCRD-06): a single computer's did:key comes from its Phase 69 device key unchanged, with
// six words derived from it that the person compares before binding the computer to themselves. Nothing secret is shown. Fictional keys only,
// made at run time in a memory secret store.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { didKeyFromDevice } from '../domain/did/didKey';
import { deviceFingerprint, deviceIdentityWords, deviceIdentityWordsText } from '../domain/did/deviceWords';
import { SAFETY_WORDS } from '../domain/replica/safetyWords';
import { DEVICE_IDENTITY_TEXT, SHOW_DEVICE_IDENTITY_COMMAND, SHOW_DEVICE_IDENTITY_TITLE, thisComputerIdentity } from '../gate/deviceIdentityCommand';
import type { SecretStorageLike } from '../services/auth';
import { DEVICE_KEY_SECRET, createDeviceIdentity } from '../team/identity';

const ROOT = path.resolve(__dirname, '..', '..');

function memorySecrets(): SecretStorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key) => values.get(key),
    store: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); }
  };
}

test('the command shows this computer\'s did:key, made from its device key unchanged, and its six words; nothing secret', async () => {
  const secrets = memorySecrets();
  const identity = await createDeviceIdentity(secrets);
  const view = await thisComputerIdentity(secrets);
  assert.ok(view !== undefined);
  assert.equal(view.didKey, didKeyFromDevice(identity.publicKey));
  assert.match(view.didKey, /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
  assert.equal(view.words.length, 6);
  assert.ok(view.message.includes(view.words.join(' ')));
  const stored = secrets.values.get(DEVICE_KEY_SECRET) as string;
  assert.ok(stored !== undefined && !view.message.includes(stored) && !view.didKey.includes(stored), 'the private key is never shown');
});

test('a computer with no device key yet shows that, and the command makes no key', async () => {
  const secrets = memorySecrets();
  assert.equal(await thisComputerIdentity(secrets), undefined);
  assert.equal(secrets.values.size, 0);
  assert.match(DEVICE_IDENTITY_TEXT.none, /no identity yet/);
});

test('the six words come from the existing safety word list, are the same on every computer for one did:key, and differ for another', async () => {
  const one = didKeyFromDevice((await createDeviceIdentity(memorySecrets())).publicKey);
  const two = didKeyFromDevice((await createDeviceIdentity(memorySecrets())).publicKey);
  const words = deviceIdentityWords(one);
  assert.deepEqual(deviceIdentityWords(one), words);
  assert.equal(deviceIdentityWordsText(one), words.join(' '));
  const known = new Set(SAFETY_WORDS.map((word) => word.toLowerCase()));
  for (const word of words) assert.ok(known.has(word), word);
  assert.notDeepEqual(deviceIdentityWords(two), words);
  assert.throws(() => deviceIdentityWords('did:webvh:QmExample:hq.example.org:people:x7k2p9'), /did:key/);
});

test('the device fingerprint a binding names is dev- and 32 hex characters, fixed for one did:key', async () => {
  const did = didKeyFromDevice((await createDeviceIdentity(memorySecrets())).publicKey);
  assert.match(deviceFingerprint(did), /^dev-[0-9a-f]{32}$/);
  assert.equal(deviceFingerprint(did), deviceFingerprint(did));
});

test('the command is contributed once with its plain title and registered by the gate commands', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
  const entries = manifest.contributes.commands.filter((entry) => entry.command === SHOW_DEVICE_IDENTITY_COMMAND);
  assert.deepEqual(entries.map((entry) => entry.title), [SHOW_DEVICE_IDENTITY_TITLE]);
  assert.ok(readFileSync(path.join(ROOT, 'src', 'services', 'gateCommands.ts'), 'utf8').includes('SHOW_DEVICE_IDENTITY_COMMAND'));
});

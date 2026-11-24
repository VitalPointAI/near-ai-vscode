// Escrow of the keys a restore depends on (D-73, D-80; CP-9, CP-10), without root, a node or a cluster: escrow-node.sh runs against a temporary
// RKE2 data folder (RKE2_DATA_DIR), and escrow.mjs against a fake kubectl (an injected `run`). Every console line and every spawned argument is
// checked for the Secret's values.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkEscrow, exportEscrow, main, recordKeyBackup } from '../bundle/escrow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NODE_SCRIPT = path.join(ROOT, 'deploy/rke2/escrow-node.sh');
const temp = (prefix) => mkdtempSync(path.join(tmpdir(), prefix));
const mode = (file) => statSync(file).mode & 0o777;

/** A fake RKE2 data folder with the two restore files. */
function dataFolder() {
  const data = temp('rke2-data-');
  mkdirSync(path.join(data, 'server/cred'), { recursive: true });
  writeFileSync(path.join(data, 'server/token'), 'K10fake-token-value::server:not-a-real-secret\n');
  writeFileSync(path.join(data, 'server/cred/encryption-config.json'), '{"kind":"EncryptionConfiguration","resources":[]}\n');
  return data;
}
const node = (data, ...args) => spawnSync('sh', [NODE_SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, RKE2_DATA_DIR: data } });
const sha256sum = (file) => spawnSync('sha256sum', [file], { encoding: 'utf8' }).stdout.split(' ')[0];

test('escrow-node.sh save writes both files 0600 in a 0700 folder with a record whose digests match', () => {
  const data = dataFolder();
  const out = path.join(temp('escrow-'), 'media');
  const save = node(data, 'save', out);
  assert.equal(save.status, 0, save.stderr);
  assert.equal(mode(out), 0o700);
  for (const name of ['token', 'encryption-config.json']) assert.equal(mode(path.join(out, name)), 0o600, name);
  const record = JSON.parse(readFileSync(path.join(out, 'escrow-record.json'), 'utf8'));
  assert.equal(record.format, 'sterling-escrow/1');
  assert.equal(record.kind, 'rke2');
  assert.match(record.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(record.files.map((file) => file.name), ['server/token', 'server/cred/encryption-config.json']);
  for (const file of record.files) assert.equal(file.sha256, sha256sum(path.join(data, file.name)), file.name);
  assert.doesNotMatch(save.stdout + save.stderr, /fake-token-value|EncryptionConfiguration/, 'no value is printed');
});

test('escrow-node.sh check passes on unchanged files and fails naming the file after one byte of the encryption configuration changes', () => {
  const data = dataFolder();
  const out = path.join(temp('escrow-'), 'media');
  assert.equal(node(data, 'save', out).status, 0);
  const record = path.join(out, 'escrow-record.json');
  const current = node(data, 'check', record);
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /escrow current/);
  const config = path.join(data, 'server/cred/encryption-config.json');
  const bytes = readFileSync(config);
  bytes[2] ^= 1;
  writeFileSync(config, bytes);
  const stale = node(data, 'check', record);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /server\/cred\/encryption-config\.json rotated since the escrow on .*; make a new escrow/);
  assert.doesNotMatch(stale.stderr, /server\/token/, 'only the changed file is named');
});

test('escrow-node.sh save refuses an out folder inside the data folder and one that already holds a record', () => {
  const data = dataFolder();
  const inside = node(data, 'save', path.join(data, 'server/escrow'));
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /inside the RKE2 data folder/);
  assert.equal(existsSync(path.join(data, 'server/escrow')), false, 'nothing is written inside the data folder');
  const out = path.join(temp('escrow-'), 'media');
  assert.equal(node(data, 'save', out).status, 0);
  const before = readFileSync(path.join(out, 'escrow-record.json'), 'utf8');
  const again = node(data, 'save', out);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already holds an escrow record/);
  assert.equal(readFileSync(path.join(out, 'escrow-record.json'), 'utf8'), before, 'the first record is not overwritten');
  assert.equal(node(data).status, 2, 'no arguments is a usage error');
});

const SECRET_DATA = {
  CRYPTO_KEY_PROVIDER: Buffer.from('secret').toString('base64'),
  CRYPTO_KEY_VALUE: Buffer.from('super-secret-volume-passphrase-123').toString('base64'),
  CRYPTO_PBKDF: Buffer.from('pbkdf2').toString('base64'),
};
// The confidential value is the passphrase; CRYPTO_KEY_PROVIDER (secret) and CRYPTO_PBKDF (pbkdf2) are fixed words that also appear in kubectl's
// own arguments (get secret), so the leak checks look for the passphrase in both its encoded and decoded forms.
const VALUES = [SECRET_DATA.CRYPTO_KEY_VALUE, Buffer.from(SECRET_DATA.CRYPTO_KEY_VALUE, 'base64').toString()];

/** A fake kubectl: `get secret` prints the Secret held in `state`; every call (argv and stdin) is recorded. */
function fakeKubectl(state) {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, input: options.input });
    if (args[0] === 'get') {
      if (!state.data) return { status: 1, stdout: '', stderr: 'Error from server (NotFound): secrets "longhorn-crypto" not found' };
      return { status: 0, stdout: JSON.stringify({ kind: 'Secret', type: 'Opaque', metadata: { name: 'longhorn-crypto', namespace: 'longhorn-system', resourceVersion: '4242' }, data: state.data }), stderr: '' };
    }
    if (args[0] === 'apply') return { status: 0, stdout: 'configmap/sterling-escrow-record configured', stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected kubectl ${args.join(' ')}` };
  };
  return { run, calls };
}

test('escrow.mjs export writes longhorn-crypto.json 0600 and a digest record; check fails after the Secret data changes', () => {
  const state = { data: { ...SECRET_DATA } };
  const { run } = fakeKubectl(state);
  const out = path.join(temp('escrow-'), 'media');
  const { record } = exportEscrow({ out, run, now: Date.parse('2026-11-24T12:00:00Z') });
  assert.equal(mode(out), 0o700);
  assert.equal(mode(path.join(out, 'longhorn-crypto.json')), 0o600);
  const key = JSON.parse(readFileSync(path.join(out, 'longhorn-crypto.json'), 'utf8'));
  assert.deepEqual(key.data, SECRET_DATA, 'the escrowed Secret restores as it was');
  assert.deepEqual({ kind: record.kind, resourceVersion: record.resourceVersion, createdAt: record.createdAt },
    { kind: 'longhorn-crypto', resourceVersion: '4242', createdAt: '2026-11-24T12:00:00Z' });
  const recordFile = path.join(out, 'escrow-record.json');
  assert.equal(checkEscrow({ record: recordFile, run }).ok, true);
  state.data = { ...SECRET_DATA, CRYPTO_KEY_VALUE: Buffer.from('rotated').toString('base64') };
  const stale = checkEscrow({ record: recordFile, run });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.problems.map((problem) => problem.split(' ')[0]), ['CRYPTO_KEY_VALUE']);
  assert.throws(() => exportEscrow({ out, run }), /already holds an escrow record/);
  assert.throws(() => exportEscrow({ out: path.join(out, 'x'), run: fakeKubectl({}).run }), /does not exist/);
});

test('escrow.mjs never prints a Secret value or passes one as a command argument', () => {
  const state = { data: { ...SECRET_DATA } };
  const { run, calls } = fakeKubectl(state);
  const lines = [];
  const log = (line) => lines.push(String(line));
  const out = path.join(temp('escrow-'), 'media');
  assert.equal(main(['export', '--out', out], { run, log, error: log }), 0);
  assert.equal(main(['check', '--record', path.join(out, 'escrow-record.json')], { run, log, error: log }), 0);
  state.data = { ...SECRET_DATA, CRYPTO_KEY_VALUE: Buffer.from('rotated-passphrase').toString('base64') };
  assert.equal(main(['check', '--record', path.join(out, 'escrow-record.json')], { run, log, error: log }), 1);
  assert.ok(lines.some((line) => /CRYPTO_KEY_VALUE changed since the escrow/.test(line)));
  const argv = calls.flatMap((call) => [call.command, ...call.args]).join('\n');
  for (const value of [...VALUES, 'rotated-passphrase', state.data.CRYPTO_KEY_VALUE]) {
    assert.ok(!lines.join('\n').includes(value), `the value ${value.slice(0, 4)}... is printed`);
    assert.ok(!argv.includes(value), `the value ${value.slice(0, 4)}... is in a command argument`);
  }
});

test('record-key-backup writes an hsm-key-backup record and refuses anything that would carry key material', () => {
  const out = path.join(temp('escrow-'), 'media');
  const fields = { tokenLabel: 'sterling-site', tokenSerial: '0123456789abcdef', backupRef: 'HSM-BACKUP-2026-11-24-A', custodians: 'custodian.one,custodian.two', heldAt: 'EXAMPLE-SITE-B' };
  const { record } = recordKeyBackup({ out, ...fields, now: Date.parse('2026-11-24T12:00:00Z') });
  assert.deepEqual(record, { format: 'sterling-escrow/1', kind: 'hsm-key-backup', createdAt: '2026-11-24T12:00:00Z', tokenLabel: 'sterling-site',
    tokenSerial: '0123456789abcdef', backupRef: 'HSM-BACKUP-2026-11-24-A', custodians: ['custodian.one', 'custodian.two'], heldAt: 'EXAMPLE-SITE-B' });
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'escrow-record.json'), 'utf8')), record);
  for (const extra of [{ pin: '1234' }, { soPin: '1234' }, { keyFile: '/tmp/k.pem' }]) {
    assert.throws(() => recordKeyBackup({ out: path.join(temp('escrow-'), 'm'), ...fields, ...extra }), /holds no key material, PIN or key file/);
  }
  assert.throws(() => recordKeyBackup({ out: path.join(temp('escrow-'), 'm'), ...fields, custodians: 'custodian.one' }), /two key custodians/);
  const lines = [];
  for (const flag of ['--pin', '--pin-file', '--key', '--key-file', '--so-pin']) {
    const code = main(['record-key-backup', '--out', path.join(temp('escrow-'), 'm'), flag, 'x'], { log: (l) => lines.push(l), error: (l) => lines.push(l) });
    assert.equal(code, 2, flag);
  }
  assert.ok(lines.every((line) => /not an option of this command; the record holds no key material, PIN or key file/.test(line)));
});

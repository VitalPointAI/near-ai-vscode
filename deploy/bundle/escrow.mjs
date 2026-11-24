#!/usr/bin/env node
// Escrow of the cluster-held restore key and records of the HSM key backups (D-73, D-80; CP-9, CP-10). Runs on the import host. Node built-ins
// only; kubectl comes from $KUBECTL or PATH.
//
//   node deploy/bundle/escrow.mjs export --out <dir>     write the longhorn-crypto key (needed to read any Longhorn backup once the cluster is
//                                                        gone) to <dir> on the key custodians' escrow media, with a digest-only record
//   node deploy/bundle/escrow.mjs check --record <file>  exit 0 when the cluster's longhorn-crypto still matches the record, 1 naming each key
//                                                        that changed
//   node deploy/bundle/escrow.mjs record-key-backup --out <dir> --token-label <label> --token-serial <serial> --backup-ref <id>
//                                 --custodians <a,b> --held-at <site>
//                                                        record who holds which backup of the HSM token that holds the site signing key and
//                                                        the seal key, and where: no key material, no PIN
//
// The escrow folder is made 0700 and the key file 0600. No value is printed, logged or passed as a command argument: the Secret is read with
// `kubectl get -o json` and parsed in memory. The record holds one SHA-256 per data key, over the decoded value, so a custodian can keep it with
// the runbook records while the values stay on the media. The RKE2 token and encryption configuration are node files: deploy/rke2/escrow-node.sh.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'sterling-escrow/1';
export const SECRET = Object.freeze({ namespace: 'longhorn-system', name: 'longhorn-crypto' });
export const RECORD_FILE = 'escrow-record.json';
export const KEY_FILE = 'longhorn-crypto.json';

const defaultRun = (command, args, { input } = {}) => spawnSync(command, args, { encoding: 'utf8', input, timeout: 120_000 });
const kubectlOf = (kubectl) => kubectl || process.env.KUBECTL || 'kubectl';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const nowIso = (now) => new Date(now ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** One SHA-256 per data key of a Secret, over the decoded value, sorted by key name. */
export function keyDigests(data) {
  return Object.keys(data).sort().map((name) => ({ name, sha256: sha256(Buffer.from(String(data[name]), 'base64')) }));
}

/** Reads the longhorn-crypto Secret through kubectl; throws a plain error naming no value. */
function readSecret({ run, kubectl }) {
  const result = run(kubectlOf(kubectl), ['get', 'secret', SECRET.name, '-n', SECRET.namespace, '-o', 'json']);
  if (result.error) throw new Error(`kubectl could not run (${result.error.message}); set KUBECTL or put kubectl on PATH.`);
  if (result.status !== 0) {
    if (/NotFound|not found/.test(result.stderr || '')) {
      throw new Error(`The Secret ${SECRET.namespace}/${SECRET.name} does not exist; the install script writes it with the encrypted storage class.`);
    }
    throw new Error(`kubectl get secret ${SECRET.namespace}/${SECRET.name} failed (exit ${result.status}).`);
  }
  let secret;
  try {
    secret = JSON.parse(result.stdout);
  } catch {
    throw new Error(`kubectl did not print the Secret ${SECRET.namespace}/${SECRET.name} as JSON.`);
  }
  if (!secret?.data || typeof secret.data !== 'object' || Object.keys(secret.data).length === 0) {
    throw new Error(`The Secret ${SECRET.namespace}/${SECRET.name} holds no data; there is nothing to escrow.`);
  }
  return secret;
}

/** Makes a fresh escrow folder (0700) and refuses one that already holds a record. */
function escrowFolder(out) {
  if (!out) throw new Error('Give the escrow folder with --out.');
  if (existsSync(path.join(out, RECORD_FILE))) throw new Error(`${out} already holds an escrow record; use a new folder for each escrow.`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
}

/** Writes the longhorn-crypto key and its digest-only record to `out`. Returns { record, files }. */
export function exportEscrow({ out, run = defaultRun, kubectl, now } = {}) {
  if (!out) throw new Error('Give the escrow folder with --out.');
  if (existsSync(path.join(out, RECORD_FILE))) throw new Error(`${out} already holds an escrow record; use a new folder for each escrow.`);
  const secret = readSecret({ run, kubectl });
  escrowFolder(out);
  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: SECRET.name, namespace: SECRET.namespace },
    type: secret.type || 'Opaque',
    data: secret.data,
  };
  const keyFile = path.join(out, KEY_FILE);
  writeFileSync(keyFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const record = {
    format: FORMAT,
    kind: 'longhorn-crypto',
    secret: `${SECRET.namespace}/${SECRET.name}`,
    resourceVersion: secret.metadata?.resourceVersion ?? '',
    createdAt: nowIso(now),
    keys: keyDigests(secret.data),
  };
  const recordFile = path.join(out, RECORD_FILE);
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { record, files: [keyFile, recordFile] };
}

/** Compares the cluster's longhorn-crypto with a record. Returns { ok, problems }; problems name keys, never values. */
export function checkEscrow({ record: recordFile, run = defaultRun, kubectl } = {}) {
  if (!recordFile) throw new Error('Give the escrow record with --record.');
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  if (record.format !== FORMAT || record.kind !== 'longhorn-crypto' || !Array.isArray(record.keys)) {
    throw new Error(`${recordFile} is not a longhorn-crypto escrow record (${FORMAT}).`);
  }
  const current = new Map(keyDigests(readSecret({ run, kubectl }).data).map((key) => [key.name, key.sha256]));
  const problems = [];
  for (const { name, sha256: want } of record.keys) {
    if (!current.has(name)) problems.push(`${name} is no longer in ${SECRET.namespace}/${SECRET.name} (escrow of ${record.createdAt}); make a new escrow.`);
    else if (current.get(name) !== want) problems.push(`${name} changed since the escrow on ${record.createdAt}; make a new escrow.`);
  }
  for (const name of current.keys()) {
    if (!record.keys.some((key) => key.name === name)) problems.push(`${name} was added to ${SECRET.namespace}/${SECRET.name} after the escrow on ${record.createdAt}; make a new escrow.`);
  }
  return { ok: problems.length === 0, problems };
}

const BACKUP_FIELDS = ['tokenLabel', 'tokenSerial', 'backupRef', 'custodians', 'heldAt'];

/** Records a backup of the HSM token (site signing key and seal key) by who holds it where; refuses anything that would carry key material. */
export function recordKeyBackup({ out, now, ...fields } = {}) {
  const extra = Object.keys(fields).filter((name) => !BACKUP_FIELDS.includes(name));
  if (extra.length) {
    throw new Error(`The key backup record holds no key material, PIN or key file; refusing ${extra.join(', ')}. It records only who holds which backup where.`);
  }
  const custodians = (Array.isArray(fields.custodians) ? fields.custodians : String(fields.custodians ?? '').split(','))
    .map((name) => name.trim()).filter(Boolean);
  for (const name of ['tokenLabel', 'tokenSerial', 'backupRef', 'heldAt']) {
    if (typeof fields[name] !== 'string' || fields[name].trim() === '') throw new Error(`The key backup record needs ${name}.`);
  }
  if (new Set(custodians).size < 2) throw new Error('A key backup is held by two key custodians; name both with --custodians <a,b>.');
  escrowFolder(out);
  const record = {
    format: FORMAT,
    kind: 'hsm-key-backup',
    createdAt: nowIso(now),
    tokenLabel: fields.tokenLabel.trim(),
    tokenSerial: fields.tokenSerial.trim(),
    backupRef: fields.backupRef.trim(),
    custodians,
    heldAt: fields.heldAt.trim(),
  };
  const recordFile = path.join(out, RECORD_FILE);
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { record, files: [recordFile] };
}

const USAGE = `usage:
  escrow.mjs export --out <dir>          write the longhorn-crypto key and a digest-only record to the escrow media
  escrow.mjs check --record <file>       exit 1 when the cluster's longhorn-crypto no longer matches the record
  escrow.mjs record-key-backup --out <dir> --token-label <label> --token-serial <serial> --backup-ref <id> --custodians <a,b> --held-at <site>`;

const OPTIONS = {
  export: { '--out': 'out' },
  check: { '--record': 'record' },
  'record-key-backup': { '--out': 'out', '--token-label': 'tokenLabel', '--token-serial': 'tokenSerial', '--backup-ref': 'backupRef',
    '--custodians': 'custodians', '--held-at': 'heldAt' },
};

/** Parses `<command> --flag value ...`; refuses any flag the command does not know (a PIN or key file flag among them). */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, command)) throw Object.assign(new Error(USAGE), { usage: true });
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const key = OPTIONS[command][flag];
    if (!key) {
      throw Object.assign(new Error(`${command}: ${flag} is not an option of this command${command === 'record-key-backup'
        ? '; the record holds no key material, PIN or key file' : ''}.\n${USAGE}`), { usage: true });
    }
    if (rest[index + 1] === undefined) throw Object.assign(new Error(`${flag} needs a value.\n${USAGE}`), { usage: true });
    options[key] = rest[index + 1];
  }
  return { command, options };
}

/** The CLI; returns the exit code. `log` and `error` receive messages that never hold a value. */
export function main(argv, { run = defaultRun, log = console.log, error = console.error, now } = {}) {
  if (argv.length === 0 || argv.includes('--help')) {
    log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  try {
    const { command, options } = parseArgs(argv);
    if (command === 'export') {
      const { record } = exportEscrow({ out: options.out, run, now });
      log(`escrow: wrote ${KEY_FILE} and ${RECORD_FILE} (${record.keys.length} keys: ${record.keys.map((key) => key.name).join(', ')}) in ${options.out}`);
      log('escrow: the folder goes to the key custodians\' escrow media; a copy of the record (digests only) goes with the runbook records.');
      return 0;
    }
    if (command === 'check') {
      const { ok, problems } = checkEscrow({ record: options.record, run });
      for (const problem of problems) error(`escrow: ${problem}`);
      if (ok) log('escrow: escrow current');
      return ok ? 0 : 1;
    }
    const { record } = recordKeyBackup({ ...options, out: options.out, now });
    log(`escrow: recorded the backup ${record.backupRef} of HSM token ${record.tokenLabel}, held at ${record.heldAt} by ${record.custodians.join(' and ')}`);
    return 0;
  } catch (problem) {
    error(problem.usage ? problem.message : `escrow: ${problem.message}`);
    return problem.usage ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

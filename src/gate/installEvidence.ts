// Evidence that this install has had a policy before (PR #70 second review). The bundle store may create a first policy by itself only on a true first
// install, and the last-valid marker in SecretStorage is the main proof of an earlier one. When that marker is gone because the whole secret store was
// wiped (a cleared browser on code-server, a new keyring), the disk still remembers: this module looks for what survives there, so a wiped store never
// reads as a fresh install and never signs a policy by itself. Anything found, or anything that cannot be read, counts as evidence; the person then
// restores trust with NEAR AI: Reset Policy to Defaults (which is itself recorded as policy.reset).
//
// What it looks at, in order, and stops at the first hit:
//   1. a policy file or a kept-aside copy of one in the gate folder (a file that exists and does not verify is never the start of a new install);
//   2. a decision log or a model-request log in the gate folder holding a record that names a bundle hash (a policy was valid once; a log of failed starts
//      names none, so a start that failed before it ever had a policy does not lock the install out);
//   3. a key history with records in the identity folder while the secret store holds no device key (the key was lost, the history was not).
// A key history with the device key still present is NOT evidence: Team Mode installs that never had a policy have one and must keep starting normally.
// Node I/O only: this module never imports vscode, and it never writes.
import { open, readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../services/auth';
import { KEY_HISTORY_FILE } from '../team/keyHistory';
import { loadDeviceIdentity } from '../team/identity';

/** The folder name the decision logs live in under the gate folder. src/gate/decisionLog.ts owns the name; a test keeps the two equal. */
export const DECISION_LOGS_FOLDER = 'decisions';
/** The folder name the model-request logs live in under the gate folder (decisionLog.ts owns it as MODEL_REQUESTS_DIR; a test keeps the two equal). */
export const MODEL_REQUEST_LOGS_FOLDER = 'model-requests';
/** The policy file's name and the prefix of a kept-aside copy (bundleStore.ts owns them; a test keeps them equal). */
const POLICY_FILE = 'policy-bundle.json';
const ASIDE_MARK = `${POLICY_FILE}.replaced-`;
const MAX_LOG_FILES = 40;
/** A log file is read in full up to this size; a larger one is read from its end, where the newest records are. */
const MAX_SCAN_BYTES = 6 * 1024 * 1024;
/** A record names its bundle as `"bundleHash":"<64 hex>"` (the empty string when there was none). */
const BUNDLE_HASH_IN_LOG = /"bundleHash":"[0-9a-f]{64}"/;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function namesIn(folder: string): Promise<string[] | 'unreadable'> {
  try {
    return await readdir(folder);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? [] : 'unreadable';
  }
}

async function logNamesABundle(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_SCAN_BYTES);
    if (length === 0) return false;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return BUNDLE_HASH_IN_LOG.test(buffer.toString('utf8'));
  } finally {
    await handle.close();
  }
}

async function historyHasRecords(identityFolder: string): Promise<boolean | 'unreadable'> {
  let text: string;
  try {
    if ((await stat(path.join(identityFolder, KEY_HISTORY_FILE))).size > 1024 * 1024) return true;
    text = await readFile(path.join(identityFolder, KEY_HISTORY_FILE), 'utf8');
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? false : 'unreadable';
  }
  try {
    const value: unknown = JSON.parse(text);
    const records = (value as { records?: unknown } | null)?.records;
    return Array.isArray(records) ? records.length > 0 : true;
  } catch {
    return true;
  }
}

/**
 * The first sign that this install has had a policy before, as a short diagnostic (never shown as the person's sentence and never given key material),
 * or undefined when nothing on disk says so. Never throws: what cannot be read counts as evidence.
 */
export async function earlierInstallEvidence(gateFolder: string, identityFolder: string, secrets: SecretStorageLike): Promise<string | undefined> {
  const names = await namesIn(gateFolder);
  if (names === 'unreadable') return 'the policy folder could not be read';
  if (names.some((name) => name === POLICY_FILE || name.startsWith(ASIDE_MARK))) return 'a policy file is already stored here';
  // Both kinds of log name the policy's hash, so either one remembers an earlier valid policy.
  // Each reason names the kind of log it is about (PR #81 review), so a diagnostic never blames the decision logs for the model-request folder.
  for (const [folder, kind] of [[DECISION_LOGS_FOLDER, 'decision'], [MODEL_REQUEST_LOGS_FOLDER, 'model-request']] as const) {
    const logsFolder = path.join(gateFolder, folder);
    const logs = await namesIn(logsFolder);
    if (logs === 'unreadable') return `the ${kind} logs could not be read`;
    for (const name of logs.filter((entry) => entry.endsWith('.jsonl')).sort().slice(0, MAX_LOG_FILES)) {
      try {
        if (await logNamesABundle(path.join(logsFolder, name))) return `a ${kind} log records an earlier valid policy`;
      } catch {
        return `a ${kind} log could not be read`;
      }
    }
  }
  const history = await historyHasRecords(identityFolder);
  if (history === 'unreadable') return 'the key history could not be read';
  if (history) {
    let identity;
    try {
      identity = await loadDeviceIdentity(secrets);
    } catch {
      return 'the signing key could not be read';
    }
    if (identity === undefined) return 'a key history exists but this computer holds no signing key';
  }
  return undefined;
}

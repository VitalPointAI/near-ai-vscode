// SEC-01 canaries: secret-shaped strings generated at run time (never literals in the repository) and scanners that look for them,
// and for the device key in every encoding it could be written in, across git objects and files.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEVICE_KEY_SECRET, PENDING_DEVICE_KEY_SECRET, PREVIOUS_DEVICE_KEY_SECRET } from '../../team/identity';
import { runGit } from '../../team/runGit';

export interface Needle { label: string; value: string }

export interface Canaries {
  apiKey: string;
  reportingToken: string;
  refreshToken: string;
  prompt: string;
  urlPassword: string;
  labelled(): Needle[];
}

function token(prefix: string): string {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

export function makeCanaries(): Canaries {
  const canaries = {
    apiKey: token('sk-canary'),
    reportingToken: token('rpt-canary'),
    refreshToken: token('rt_canary'),
    prompt: token('CANARY-PROMPT-'),
    urlPassword: token('canarypw')
  };
  return {
    ...canaries,
    labelled: () => [
      { label: 'access key', value: canaries.apiKey },
      { label: 'reporting token', value: canaries.reportingToken },
      { label: 'refresh token', value: canaries.refreshToken },
      { label: 'prompt', value: canaries.prompt },
      { label: 'remote password', value: canaries.urlPassword }
    ]
  };
}

// The stored device key is base64 PKCS#8 for Ed25519: a fixed 16 byte header and the 32 byte seed. Each rendering a leak could take is
// returned, so a scan catches the key whether it was copied as stored, re-encoded, reduced to its seed or written as DER hex: the PKCS#8
// DER as base64, base64url and hex, the seed as hex, base64url and base64 (padded and unpadded), and the SPKI DER of its public half as hex.
// The order matches privateRenderingDigests in teamCommands.ts, and repeats are dropped (base64 and base64url are the same text when the
// key has no + or / in it, and unpadded base64 equals base64url in the same case).
export function deviceKeyForms(storedSecret: string): string[] {
  const der = Buffer.from(storedSecret, 'base64');
  const seed = der.subarray(der.length - 32);
  const spki = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
  const seedBase64 = seed.toString('base64');
  return [...new Set([
    storedSecret, der.toString('base64url'), der.toString('hex'),
    seed.toString('hex'), seed.toString('base64url'), seedBase64, seedBase64.replace(/=+$/, ''),
    spki.toString('hex')
  ])];
}

// Needles for every private key kept in SecretStorage under the three identity names: the device key, the key a rotation keeps aside (pending) and the
// key it replaced (previous). Each stored value that is present contributes every rendering deviceKeyForms lists, labelled by the name it was stored under,
// so a scan after a rotation proves none of the three keys reached a file, a git object, settings or the audit store (TMR-03, D-07).
export function identityKeyNeedles(stored: ReadonlyMap<string, string>, prefix = 'identity'): Needle[] {
  const names: Array<[string, string]> = [[DEVICE_KEY_SECRET, 'device key'], [PENDING_DEVICE_KEY_SECRET, 'pending key'], [PREVIOUS_DEVICE_KEY_SECRET, 'previous key']];
  return names.flatMap(([name, label]) => {
    const value = stored.get(name);
    return value === undefined || value === '' ? [] : deviceKeyForms(value).map((form, index) => ({ label: `${prefix} ${label} form ${index}`, value: form }));
  });
}

// The saved end of the key history (seq and hash) lives only in SecretStorage, never in a file, a git object or the audit store. Its stored text is a
// needle like any other secret, so a scan of those places also proves it never leaked there (TMR-03). Nothing is returned when no head is stored.
export function keyHistoryHeadNeedles(storedHead: string | undefined): Needle[] {
  return storedHead === undefined || storedHead === '' ? [] : [{ label: 'key history head', value: storedHead }];
}

function foundIn(haystack: Buffer, needles: Needle[]): string[] {
  return needles.filter((needle) => haystack.includes(Buffer.from(needle.value, 'utf8'))).map((needle) => needle.label);
}

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// Every object in the repository, reachable or not, as raw bytes (git cat-file --batch-all-objects --batch), plus the repository config
// and packed-refs. The clone's own config holds the canary remote URL by construction, so a caller scanning a clone turns includeConfig off.
export async function scanGitObjects(gitDir: string, needles: Needle[], options: { includeConfig?: boolean } = {}): Promise<string[]> {
  const result = await runGit(['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch'], { timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(`Reading the objects of ${path.basename(path.dirname(gitDir))} failed with exit code ${result.code}.`);
  const labels = new Set(foundIn(result.stdout, needles));
  const files = ['packed-refs', ...(options.includeConfig === false ? [] : ['config'])];
  for (const name of files) {
    const content = await readIfPresent(path.join(gitDir, name));
    if (content !== undefined) for (const label of foundIn(content, needles)) labels.add(label);
  }
  return [...labels];
}

async function filesUnder(target: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') return [target];
    if (code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(child));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

// Walks each root (a directory or a single file) and reads every regular file. Returns 'relative/path: label'; never the matched value.
export async function scanFiles(roots: string[], needles: Needle[]): Promise<string[]> {
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of await filesUnder(root)) {
      const content = await fs.readFile(file);
      const shown = path.relative(root, file) || path.basename(file);
      for (const label of foundIn(content, needles)) hits.push(`${path.basename(root)}/${shown}: ${label}`);
    }
  }
  return hits;
}

// ---- Digest scanners (D-30) ----
// The e2e test window never holds the device private key: the extension host hands it SHA-256 digests of each private rendering and their
// lengths. These scanners find a rendering without the text: every window of each listed length inside every run of base64, base64url or hex
// characters in the scanned bytes is hashed and compared. A rendering embedded in longer text is therefore found, and a match is reported by label.

export interface KeyDigest { length: number; sha256: string }
export interface LabelledDigest extends KeyDigest { label: string }

// The same digests the extension host computes for the stored secret (see privateRenderingDigests in teamCommands.ts), for unit tests that hold a key.
export function deviceKeyFormDigests(storedSecret: string): KeyDigest[] {
  return deviceKeyForms(storedSecret).map((form) => ({ length: form.length, sha256: createHash('sha256').update(form, 'utf8').digest('hex') }));
}

// Characters of base64 (A-Z a-z 0-9 + /), base64url (- _), hex and base64 padding (=), so a padded rendering is one run.
const RUN_BYTE = new Uint8Array(256);
for (const range of ['AZ', 'az', '09']) for (let code = range.charCodeAt(0); code <= range.charCodeAt(1); code += 1) RUN_BYTE[code] = 1;
for (const char of '+/-_=') RUN_BYTE[char.charCodeAt(0)] = 1;

function digestsFoundIn(haystack: Buffer, digests: LabelledDigest[]): string[] {
  const lengths = [...new Set(digests.map((digest) => digest.length))];
  const wanted = new Map<string, string[]>();
  for (const digest of digests) wanted.set(`${digest.length}:${digest.sha256}`, [...(wanted.get(`${digest.length}:${digest.sha256}`) ?? []), digest.label]);
  const labels = new Set<string>();
  const shortest = Math.min(...lengths);
  let index = 0;
  while (index < haystack.length) {
    if (RUN_BYTE[haystack[index] as number] !== 1) { index += 1; continue; }
    let end = index;
    while (end < haystack.length && RUN_BYTE[haystack[end] as number] === 1) end += 1;
    if (end - index >= shortest) {
      for (const length of lengths) {
        for (let start = index; start + length <= end; start += 1) {
          const key = `${length}:${createHash('sha256').update(haystack.subarray(start, start + length)).digest('hex')}`;
          for (const label of wanted.get(key) ?? []) labels.add(label);
        }
      }
    }
    index = end;
  }
  return [...labels];
}

// Like scanFiles, with digests instead of text. Returns 'folder/relative/path: label'; never the matched value.
export async function scanFilesForDigests(roots: string[], digests: LabelledDigest[]): Promise<string[]> {
  if (digests.length === 0) return [];
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of await filesUnder(root)) {
      const content = await fs.readFile(file);
      const shown = path.relative(root, file) || path.basename(file);
      for (const label of digestsFoundIn(content, digests)) hits.push(`${path.basename(root)}/${shown}: ${label}`);
    }
  }
  return hits;
}

// Like scanGitObjects, with digests. git cat-file --batch prints each object's uncompressed content, so the windows are hashed over real
// content; hashing the raw zlib loose objects would never match.
export async function scanGitObjectsForDigests(gitDir: string, digests: LabelledDigest[], options: { includeConfig?: boolean } = {}): Promise<string[]> {
  if (digests.length === 0) return [];
  const result = await runGit(['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch'], { timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(`Reading the objects of ${path.basename(path.dirname(gitDir))} failed with exit code ${result.code}.`);
  const labels = new Set(digestsFoundIn(result.stdout, digests));
  const files = ['packed-refs', ...(options.includeConfig === false ? [] : ['config'])];
  for (const name of files) {
    const content = await readIfPresent(path.join(gitDir, name));
    if (content !== undefined) for (const label of digestsFoundIn(content, digests)) labels.add(label);
  }
  return [...labels];
}

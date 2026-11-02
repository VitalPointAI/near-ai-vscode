// SEC-01 canaries: secret-shaped strings generated at run time (never literals in the repository) and scanners that look for them,
// and for the device key in every encoding it could be written in, across git objects and files.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { formatInviteCode } from '../../team/inviteCode';
import { runGit } from '../../team/runGit';

export interface Needle { label: string; value: string }

export interface Canaries {
  apiKey: string;
  reportingToken: string;
  refreshToken: string;
  /** Shaped like a NEAR session access token (eyJ...), made at run time. */
  accessToken: string;
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
    accessToken: token('eyJcanary'),
    prompt: token('CANARY-PROMPT-'),
    urlPassword: token('canarypw')
  };
  return {
    ...canaries,
    labelled: () => [
      { label: 'access key', value: canaries.apiKey },
      { label: 'reporting token', value: canaries.reportingToken },
      { label: 'refresh token', value: canaries.refreshToken },
      { label: 'access token', value: canaries.accessToken },
      { label: 'prompt', value: canaries.prompt },
      { label: 'remote password', value: canaries.urlPassword }
    ]
  };
}

// The stored device key is base64 PKCS#8 for Ed25519: a fixed 16 byte header and the 32 byte seed. Each rendering a leak could take is
// returned (three or four distinct texts), so a scan catches the key whether it was copied as stored, re-encoded, or reduced to its seed.
export function deviceKeyForms(storedSecret: string): string[] {
  const der = Buffer.from(storedSecret, 'base64');
  const seed = der.subarray(der.length - 32);
  // base64 and base64url are the same text when the key happens to have no + or / in it, so repeats are dropped.
  return [...new Set([storedSecret, der.toString('base64url'), seed.toString('hex'), seed.toString('base64url')])];
}

// Every text an invite code could be written as: the 32 character code, the XXXX-XXXX grouping a person reads out, either letter case, and the
// 20 raw bytes as hex, base64 and base64url. Take the forms before the code bytes are zero-filled; the returned strings are copies.
export function inviteCodeForms(codeText: string, codeBytes: Buffer): string[] {
  const grouped = formatInviteCode(codeText);
  return [...new Set([
    codeText, grouped, codeText.toLowerCase(), grouped.toLowerCase(),
    codeBytes.toString('hex'), codeBytes.toString('base64'), codeBytes.toString('base64url')
  ])];
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

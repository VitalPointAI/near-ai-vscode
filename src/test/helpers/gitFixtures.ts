// Shared by the sync transport tests: real git, a real local bare remote, and a person's repository with staged and dirty files, a failing pre-push
// hook and a sentinel identity. Nothing here contacts a network; every remote is a folder under the system temp directory.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KDF_PARAMS, deriveKek, newDataKey, newSalt, newStateId, wrapDataKey } from '../../domain/state/keys';
import type { KdfRecord, SealedBlob } from '../../domain/state/keys';
import { buildManifest, sealObject } from '../../domain/state/objects';
import type { ObjectClass, ObjectEntry } from '../../domain/state/objects';
import { generateRecoveryCode } from '../../domain/state/recoveryCode';
import { runStateGit } from '../../services/stateGit';
import type { GitRunner } from '../../services/stateGit';
import type { StateFile } from '../../services/stateTransport';

/** The identity the fixtures' own commits use, so a sentinel in the person's config never ends up in them. */
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test'
};

export const SENTINEL_NAME = 'SENTINEL_NAME_91c2';
export const SENTINEL_EMAIL = 'sentinel91c2@example.com';

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GIT_')) env[name] = value;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', ...FIXTURE_IDENTITY };
}

/** Runs git with array arguments in `dir` (or against a bare repository when `dir` is a git dir) and returns stdout as text. */
export function fixtureGit(dir: string, args: string[], input?: string | Buffer): string {
  return execFileSync('git', args, { cwd: dir, env: cleanEnv(), encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** An empty bare repository with a `main` branch holding one commit, so a test can prove main is untouched. */
export function bareRemote(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-remote-'));
  fixtureGit(dir, ['init', '--bare', '-q', '-b', 'main']);
  const seed = mkdtempSync(path.join(tmpdir(), 'near-ai-seed-'));
  fixtureGit(seed, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  fixtureGit(seed, ['add', 'README.md']);
  fixtureGit(seed, ['commit', '-q', '-m', 'seed']);
  fixtureGit(seed, ['push', '-q', dir, 'main']);
  return dir;
}

export interface UserRepo { dir: string; stagedFile: string; dirtyFile: string }

/**
 * A person's repository: remote `origin` (and any extra remotes), a pushed main, then a staged new file, a modified tracked file and a pre-push hook
 * that always fails (a plain `git push` from here is refused), with a sentinel name and email in its own config.
 */
export function userRepo(remoteDir: string, options: { remotes?: Record<string, string> } = {}): UserRepo {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-user-'));
  fixtureGit(dir, ['init', '-q', '-b', 'main']);
  fixtureGit(dir, ['config', 'user.name', SENTINEL_NAME]);
  fixtureGit(dir, ['config', 'user.email', SENTINEL_EMAIL]);
  fixtureGit(dir, ['remote', 'add', 'origin', remoteDir]);
  for (const [name, target] of Object.entries(options.remotes ?? {})) fixtureGit(dir, ['remote', 'add', name, target]);
  writeFileSync(path.join(dir, 'tracked.txt'), 'one\n');
  fixtureGit(dir, ['add', 'tracked.txt']);
  fixtureGit(dir, ['commit', '-q', '-m', 'first']);
  fixtureGit(dir, ['fetch', '-q', 'origin']);
  writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo (modified, not staged)\n');
  writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
  fixtureGit(dir, ['add', 'staged.txt']);
  const hook = path.join(dir, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, '#!/bin/sh\necho "HOOK RAN" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  return { dir, stagedFile: 'staged.txt', dirtyFile: 'tracked.txt' };
}

function digest(file: string): string {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return 'absent'; }
}

/** Everything a sync could change in a person's repository, so two snapshots can be compared for equality. */
export function repoSnapshot(dir: string): Record<string, string> {
  const gitDir = path.join(dir, '.git');
  return {
    status: fixtureGit(dir, ['status', '--porcelain']),
    head: fixtureGit(dir, ['rev-parse', 'HEAD']),
    symbolicHead: fixtureGit(dir, ['symbolic-ref', 'HEAD']),
    refs: fixtureGit(dir, ['for-each-ref']),
    branches: fixtureGit(dir, ['branch', '-a', '-vv']),
    index: digest(path.join(gitDir, 'index')),
    config: digest(path.join(gitDir, 'config')),
    packedRefs: digest(path.join(gitDir, 'packed-refs')),
    tracked: digest(path.join(dir, 'tracked.txt')),
    staged: digest(path.join(dir, 'staged.txt'))
  };
}

export interface RemoteHit { object: string; kind: 'blob' | 'tree' | 'commit' | 'tag' | 'path' | 'ref'; sentinel: string }
export interface RemoteScan { hits: RemoteHit[]; treeNames: string[]; refs: string[]; commits: number; objects: number }

function parseBatch(output: Buffer): Array<{ oid: string; type: string; body: Buffer }> {
  const found: Array<{ oid: string; type: string; body: Buffer }> = [];
  let at = 0;
  while (at < output.length) {
    const lineEnd = output.indexOf(0x0a, at);
    if (lineEnd < 0) break;
    const [oid, type, size] = output.subarray(at, lineEnd).toString('ascii').split(' ');
    const length = Number(size);
    if (!oid || !type || !Number.isInteger(length)) throw new Error(`unexpected cat-file output near byte ${at}`);
    found.push({ oid, type, body: output.subarray(lineEnd + 1, lineEnd + 1 + length) });
    at = lineEnd + 1 + length + 1;
  }
  return found;
}

function mentions(buffer: Buffer, sentinel: string | Buffer): boolean {
  if (typeof sentinel !== 'string') return buffer.includes(sentinel);
  return buffer.toString('latin1').includes(sentinel) || buffer.toString('utf8').includes(sentinel) || buffer.includes(Buffer.from(sentinel, 'utf8'));
}

/**
 * Lists every object the remote holds (blobs, trees, commits, tags), every path name and every ref, and looks for each sentinel in all of them, as
 * latin1 and as UTF-8. Returns the hits, every tree entry name and the ref names.
 */
export function scanRemote(remoteDir: string, sentinels: ReadonlyArray<string | Buffer>): RemoteScan {
  const hits: RemoteHit[] = [];
  const label = (sentinel: string | Buffer): string => (typeof sentinel === 'string' ? sentinel : `bytes:${sentinel.toString('hex')}`);
  const refText = fixtureGit(remoteDir, ['for-each-ref', '--format=%(refname)']);
  const refs = refText.split('\n').filter((line) => line !== '');
  for (const sentinel of sentinels) if (mentions(Buffer.from(refText, 'utf8'), sentinel)) hits.push({ object: 'refs', kind: 'ref', sentinel: label(sentinel) });
  const listing = fixtureGit(remoteDir, ['rev-list', '--all', '--objects']);
  const oids = listing.split('\n').filter((line) => line !== '').map((line) => line.split(' ')[0] as string);
  for (const line of listing.split('\n')) {
    for (const sentinel of sentinels) if (mentions(Buffer.from(line, 'utf8'), sentinel)) hits.push({ object: line.split(' ')[0] ?? '', kind: 'path', sentinel: label(sentinel) });
  }
  const raw = execFileSync('git', ['cat-file', '--batch'], { cwd: remoteDir, env: cleanEnv(), input: `${oids.join('\n')}\n`, maxBuffer: 512 * 1024 * 1024 });
  const objects = parseBatch(raw);
  const treeNames: string[] = [];
  let commits = 0;
  for (const object of objects) {
    const kind = object.type as RemoteHit['kind'];
    if (object.type === 'commit') commits += 1;
    if (object.type === 'tree') {
      const names = fixtureGit(remoteDir, ['ls-tree', '--name-only', object.oid]).split('\n').filter((line) => line !== '');
      treeNames.push(...names);
    }
    for (const sentinel of sentinels) if (mentions(object.body, sentinel)) hits.push({ object: object.oid, kind, sentinel: label(sentinel) });
  }
  return { hits, treeNames, refs, commits, objects: objects.length };
}

/** Each commit reachable from the state branch of the remote: author, committer, both dates (seconds), message and signature status. */
export function remoteCommits(remoteDir: string, ref = 'refs/heads/near-ai/state'): Array<Record<string, string>> {
  const format = ['%an', '%ae', '%cn', '%ce', '%at', '%ct', '%B', '%G?', '%H'].join('%x1f');
  const text = fixtureGit(remoteDir, ['log', ref, `--format=${format}%x1e`]);
  return text.split('\x1e').map((chunk) => chunk.replace(/^\n/, '')).filter((chunk) => chunk !== '').map((chunk) => {
    const [an = '', ae = '', cn = '', ce = '', at = '', ct = '', message = '', signature = '', hash = ''] = chunk.split('\x1f');
    return { an, ae, cn, ce, at, ct, message: message.trim(), signature, hash: hash.trim() };
  });
}

/** A runner that reads no machine or system git configuration unless a file is named, so the tests do not depend on the host's settings. */
export function hermeticRunner(extraEnv: Record<string, string> = {}, config = '/dev/null'): GitRunner {
  return (args, options = {}) => runStateGit(args, { ...options, env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', ...extraEnv, ...options.env } });
}

export async function tempDirectory(prefix = 'near-ai-sync-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

let keyMaterial: Promise<{ kdf: KdfRecord; wrappedKey: SealedBlob; dataKey: Buffer; stateId: string; code: string; codeBytes: Buffer }> | undefined;

/** One data key, recovery code and wrapped key per test process (scrypt is deliberately slow); each bundle still seals with fresh salts and IVs. */
export function sealingKeys(): NonNullable<typeof keyMaterial> {
  keyMaterial ??= (async () => {
    const { code, bytes } = generateRecoveryCode();
    const salt = newSalt();
    const kdf: KdfRecord = { name: KDF_PARAMS.name, N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, salt: salt.toString('base64') };
    const stateId = newStateId();
    const dataKey = newDataKey();
    const wrappedKey = wrapDataKey(await deriveKek(bytes, salt, kdf), dataKey, stateId);
    return { kdf, wrappedKey, dataKey, stateId, code, codeBytes: bytes };
  })();
  return keyMaterial;
}

/** manifest.json plus one sealed object per payload, ready for StateTransport.writeCommit. */
export async function sealedFiles(payloads: ReadonlyArray<{ class: ObjectClass; payload: unknown }>, seq = 1): Promise<{ files: StateFile[]; objectNames: string[]; keys: Awaited<ReturnType<typeof sealingKeys>> }> {
  const keys = await sealingKeys();
  const entries: ObjectEntry[] = [];
  const files: StateFile[] = [];
  for (const item of payloads) {
    for (const part of sealObject(keys.dataKey, keys.stateId, item.class, item.payload)) {
      entries.push(part.entry);
      files.push({ name: part.entry.file, data: part.data });
    }
  }
  const manifest = buildManifest({ stateId: keys.stateId, kdf: keys.kdf, wrappedKey: keys.wrappedKey, dataKey: keys.dataKey, seq, objects: entries, indexFile: null });
  return { files: [{ name: 'manifest.json', data: manifest }, ...files], objectNames: files.map((file) => file.name), keys };
}

export async function mirrorPaths(prefix = 'near-ai-mirror-'): Promise<{ mirrorDir: string; hooksDir: string; base: string }> {
  const base = await tempDirectory(prefix);
  await mkdir(path.join(base, 'sync'), { recursive: true });
  return { mirrorDir: path.join(base, 'sync', 'mirror.git'), hooksDir: path.join(base, 'sync', 'hooks'), base };
}

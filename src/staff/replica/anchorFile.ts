// The genesis pin and project.json of a shared staff project (D-46), moved out of replicaProject.ts so that file stays under the size rule. Node I/O
// only; never imports vscode. The pin lives in extension storage outside the project; project.json is only a convenience copy, and a copy that
// disagrees with the pin is refused. Both hold only public keys and hashes.
import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { isRecord } from '../../domain/team/validate';
import { HASH_PATTERN, STREAM_ID_PATTERN } from '../../domain/replica/entry';
import { SLUG_PATTERN } from '../../domain/replica/kindSchemas/shared';
import type { RosterAnchor } from '../../domain/replica/roster';
import { REPLICA_PROJECT_FILE } from '../../domain/staff/multiUser';
import { readWhole, snapshotOf, writeIfUnchanged } from '../staffFiles';

/** Where the genesis pins live under the extension's global storage: <globalStorage>/staff-replica/<project>/genesis.json. */
export const GENESIS_PIN_FOLDER = 'staff-replica';
export const GENESIS_PIN_FILE = 'genesis.json';
/** The most bytes a pin or project.json may hold; both are a few hundred bytes. */
const ANCHOR_FILE_MAX_BYTES = 64 * 1024;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;

// ---- the pin and project.json ----------------------------------------------------------------------------------------------------------------------

/** The genesis pin of a project in extension storage. */
export function genesisPinFile(globalStorageDir: string, project: string): string {
  if (!STREAM_ID_PATTERN.test(project)) throw new Error('A project id is 32 lowercase hex characters.');
  return path.join(globalStorageDir, GENESIS_PIN_FOLDER, project, GENESIS_PIN_FILE);
}

/** The convenience copy of the pin in the project folder. */
export function projectFile(root: string): string {
  return path.join(path.resolve(root), ...REPLICA_PROJECT_FILE.split('/'));
}

/** A pinned anchor read from untrusted JSON: exact keys, every field in its pattern. A fresh object, never the input. */
export function anchorOf(value: unknown): RosterAnchor | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'genesisHash,lead,project') return undefined;
  const lead = value.lead;
  if (!isRecord(lead) || Object.keys(lead).sort().join(',') !== 'member,publicKey,writer,x25519') return undefined;
  const { genesisHash, project } = value;
  const { member, writer, publicKey, x25519 } = lead;
  if (typeof genesisHash !== 'string' || !HASH_PATTERN.test(genesisHash) || typeof project !== 'string' || !STREAM_ID_PATTERN.test(project)) return undefined;
  if (typeof member !== 'string' || !SLUG_PATTERN.test(member) || typeof writer !== 'string' || !HASH_PATTERN.test(writer)) return undefined;
  if (typeof publicKey !== 'string' || !BASE64URL_KEY.test(publicKey) || typeof x25519 !== 'string' || !BASE64URL_KEY.test(x25519)) return undefined;
  return { genesisHash, project, lead: { member, writer, publicKey, x25519 } };
}

export function sameAnchor(a: RosterAnchor, b: RosterAnchor): boolean {
  return a.genesisHash === b.genesisHash && a.project === b.project && a.lead.member === b.lead.member && a.lead.writer === b.lead.writer
    && a.lead.publicKey === b.lead.publicKey && a.lead.x25519 === b.lead.x25519;
}

export type AnchorRead = { kind: 'missing' } | { kind: 'anchor'; anchor: RosterAnchor } | { kind: 'damaged' };

export async function readAnchorFile(file: string): Promise<AnchorRead> {
  try {
    if ((await lstat(file)).isSymbolicLink()) return { kind: 'damaged' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'damaged' };
  }
  const read = await readWhole(file, ANCHOR_FILE_MAX_BYTES);
  if (read.kind === 'missing') return { kind: 'missing' };
  if (read.kind !== 'text') return { kind: 'damaged' };
  try {
    const value = JSON.parse(read.text) as unknown;
    const anchor = isRecord(value) && value.v === 1 ? anchorOf(value.anchor) : undefined;
    return anchor === undefined ? { kind: 'damaged' } : { kind: 'anchor', anchor };
  } catch {
    return { kind: 'damaged' };
  }
}

/** Writes a pin or project.json. A file that holds the same anchor is left as it is; one that holds another is never replaced. */
export async function writeAnchorFile(file: string, anchor: RosterAnchor): Promise<boolean> {
  const text = `${JSON.stringify({ v: 1, anchor }, null, 2)}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readAnchorFile(file);
    if (before.kind === 'anchor') return sameAnchor(before.anchor, anchor);
    if (before.kind === 'damaged') return false;
    if (await writeIfUnchanged(file, await snapshotOf(file), text)) return true;
  }
  return false;
}

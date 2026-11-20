// Fork target for the replica store's cross-process test (31-13): a second process that opens one store and appends N entries for its own writer,
// one entry per append, so two such processes interleave their appends on one store. Secret storage is a JSON file both processes share, standing in
// for the editor's secret storage that every window of one install shares. The file has no .test suffix on purpose so the test glob does not run it
// as a suite, and it only starts when it is the entry point of a forked process.
//
// Arguments: <project root> <secrets file> <signer label> <count> <stream id>. Messages: ready (store open), then on 'go' it appends and sends done.
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SecretStorageLike } from '../../services/auth';
import { GENESIS_PREV, buildEntry } from '../../domain/replica/entry';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { ReplicaStore } from '../../staff/replica/store';
import { epochKey, fixedSigner } from './replicaWorld';

export type StoreChildMessage = { type: 'ready' } | { type: 'done'; written: number } | { type: 'error'; message: string };

/** Secret storage kept in one JSON file, written by temporary file and rename. Used only under the store's lock, so reads see whole writes. */
export class FileSecrets implements SecretStorageLike {
  public constructor(private readonly file: string) {}
  private read(): Record<string, string> {
    try { return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>; } catch { return {}; }
  }
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.read()[key]); }
  public store(key: string, value: string): Promise<void> {
    const values = { ...this.read(), [key]: value };
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(values));
    renameSync(temporary, this.file);
    return Promise.resolve();
  }
  public delete(key: string): Promise<void> {
    const values = this.read();
    delete values[key];
    writeFileSync(this.file, JSON.stringify(values));
    return Promise.resolve();
  }
}

// Every device in this test is trusted: the two processes stand for two devices whose marks the other must read.
const ACTIVE: KeyStatusLookup = () => ({ state: 'active' });

function send(message: StoreChildMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.send === undefined) { resolve(); return; }
    process.send(message, () => { resolve(); });
  });
}

async function main(root: string, secretsFile: string, label: string, count: number, stream: string): Promise<void> {
  const device = fixedSigner(label);
  const store = await ReplicaStore.open(root, { secrets: new FileSecrets(secretsFile), signer: () => Promise.resolve(device.signer), keyStatus: () => Promise.resolve(ACTIVE) });
  if (!(store instanceof ReplicaStore)) throw new Error(`the store was refused: ${store.refused}`);
  await new Promise<void>((resolve) => {
    process.on('message', (message: unknown) => { if ((message as { type?: unknown } | null)?.type === 'go') resolve(); });
    void send({ type: 'ready' });
  });
  // Each entry is built on the head the store holds now. When another process that signs as the same device (another window of one install) wrote
  // first, the append is refused out-of-order and nothing is written; the store has caught up inside its lock, so the next build follows the
  // other window's entry. That is how a host shares one writer between two windows.
  let written = 0;
  let retries = 0;
  while (written < count) {
    const head = store.head(stream, device.writer);
    const seq = head ? head.seq + 1 : 0;
    const built = buildEntry({ signer: device.signer, key: epochKey('store'), stream, seq, prev: head?.hash ?? GENESIS_PREV, epoch: 0, body: { deps: [], roster: 'a'.repeat(64), lamport: seq, at: '2026-11-19T11:00:00.000Z', actor: { kind: 'person' }, kind: 'doc.update', data: { n: seq, by: `${label}/${process.pid}` } } });
    const result = await store.appendOwn([built]);
    if ('ok' in result) { written += result.written; continue; }
    if (result.refused !== 'out-of-order' || (retries += 1) > 10_000) throw new Error(`an append was refused: ${result.refused}`);
  }
  await send({ type: 'done', written });
  process.exit(0);
}

if (require.main === module) {
  const [root, secretsFile, label, count, stream] = process.argv.slice(2);
  main(root ?? '', secretsFile ?? '', label ?? '', Number(count), stream ?? '').catch(async (error: unknown) => {
    await send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}

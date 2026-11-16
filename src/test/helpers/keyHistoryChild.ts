// Fork target for the key history race test: a second process that appends one rotated record to a shared identity folder. The private key of the
// active key arrives only over the IPC channel (a base64 DER text in a message) and is never written anywhere. The shared secret store is a JSON file;
// it is read and written inside key-history.lock (appendKeyRecord reads and stores the head only while it holds the lock). The file has no .test suffix
// on purpose so the test glob does not run it as a suite, and it only starts when it is the entry point of a forked process.
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SecretStorageLike } from '../../services/auth';
import { fingerprintOf } from '../../domain/team/canonical';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import type { DeviceRef } from '../../domain/team/types';
import { appendKeyRecord } from '../../team/keyHistory';

// Test only: a secret store that several processes share through one file.
export class FileSecrets implements SecretStorageLike {
  public constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private write(values: Record<string, string>): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(values), 'utf8');
    renameSync(temporary, this.file);
  }

  public async get(key: string): Promise<string | undefined> { return this.read()[key]; }

  public async store(key: string, value: string): Promise<void> { this.write({ ...this.read(), [key]: value }); }

  public async delete(key: string): Promise<void> {
    const values = this.read();
    delete values[key];
    this.write(values);
  }
}

export interface KeyHistoryChildStart { type: 'start'; identityDir: string; secretsFile: string; keyDer: string; next: DeviceRef }
export type KeyHistoryChildReply = { type: 'ready' } | { type: 'done'; ok: boolean; message: string };

function send(message: KeyHistoryChildReply): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.send === undefined) {
      resolve();
      return;
    }
    process.send(message, () => { resolve(); });
  });
}

function signerFromDer(keyDer: string): PayloadSigner {
  const privateKey = createPrivateKey({ key: Buffer.from(keyDer, 'base64'), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  return {
    fingerprint: fingerprintOf(raw),
    publicKey: raw.toString('base64url'),
    sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url')
  };
}

function main(): void {
  let start: KeyHistoryChildStart | undefined;
  process.on('message', (message: unknown) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (type === 'start') {
      start = message as KeyHistoryChildStart;
      void send({ type: 'ready' });
      return;
    }
    if (type !== 'go' || start === undefined) return;
    const { identityDir, secretsFile, keyDer, next } = start;
    const signer = signerFromDer(keyDer);
    appendKeyRecord(identityDir, new FileSecrets(secretsFile), signer, { kind: 'rotated', key: { fingerprint: signer.fingerprint, publicKey: signer.publicKey }, next }).then(
      async () => {
        await send({ type: 'done', ok: true, message: '' });
        process.exit(0);
      },
      async (error: unknown) => {
        await send({ type: 'done', ok: false, message: error instanceof Error ? error.message : String(error) });
        process.exit(0);
      }
    );
  });
}

if (require.main === module) main();

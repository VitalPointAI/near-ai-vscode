import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentMessage } from './nearAiClient';

const MAX_TRANSCRIPTS = 50;

export interface TranscriptSummary { id: string; title: string; model: string; updatedAt: string; turns: number }
export interface Transcript extends TranscriptSummary { messages: AgentMessage[]; /** [hash of the message the model saw, what the user typed] */ display?: Array<[string, string]> }

type Envelope = { enc: 'aes-256-gcm'; iv: string; tag: string; data: string };

let shared: (() => Promise<Buffer>) | undefined;

/** The one transcript key source for the extension, so two stores never create two keys. */
export function sharedTranscriptKey(secrets: Parameters<typeof transcriptKey>[0]): () => Promise<Buffer> {
  shared ??= transcriptKey(secrets);
  return shared;
}

/** A 256-bit key kept in SecretStorage, created on first use. */
export function transcriptKey(secrets: { get(key: string): Thenable<string | undefined> | Promise<string | undefined>; store(key: string, value: string): Thenable<void> | Promise<void> }): () => Promise<Buffer> {
  let key: Promise<Buffer> | undefined;
  return () => {
    key ??= (async () => {
      const stored = await secrets.get('nearAi.transcripts.key');
      if (stored && Buffer.from(stored, 'base64').length === 32) return Buffer.from(stored, 'base64');
      const fresh = randomBytes(32);
      await secrets.store('nearAi.transcripts.key', fresh.toString('base64'));
      return fresh;
    })();
    return key;
  };
}

/**
 * Full conversation transcripts, so a chat can be resumed with its context. Kept in the
 * extension's storage on this machine (one folder per project), never in the project itself,
 * and encrypted with AES-256-GCM when a key is given (the extension always gives one). Files
 * saved before encryption are re-saved encrypted when read.
 */
export class TranscriptStore {
  private readonly dir: string;

  public constructor(storageDir: string, root: string, private readonly key?: () => Promise<Buffer>) {
    this.dir = path.join(storageDir, 'transcripts', createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16));
  }

  private async encode(transcript: Transcript): Promise<string> {
    if (!this.key) return JSON.stringify(transcript);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(transcript), 'utf8'), cipher.final()]);
    const envelope: Envelope = { enc: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    return JSON.stringify(envelope);
  }

  private async decode(text: string): Promise<{ value: unknown; plain: boolean }> {
    const parsed = JSON.parse(text) as Envelope | Transcript;
    if ((parsed as Envelope).enc !== 'aes-256-gcm') return { value: parsed, plain: true };
    if (!this.key) throw new Error('This transcript is encrypted.');
    const envelope = parsed as Envelope;
    const decipher = createDecipheriv('aes-256-gcm', await this.key(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return { value: JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')), plain: false };
  }

  public async save(transcript: Transcript): Promise<void> {
    if (!/^conv-[a-z0-9-]{6,60}$/.test(transcript.id)) throw new Error('Invalid transcript id.');
    await this.write(transcript);
    await this.prune();
  }

  private async write(transcript: Transcript): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${transcript.id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, await this.encode(transcript), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  }

  public async list(): Promise<TranscriptSummary[]> {
    const summaries: TranscriptSummary[] = [];
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const transcript = await this.read(name.slice(0, -5));
      if (transcript) summaries.push({ id: transcript.id, title: transcript.title, model: transcript.model, updatedAt: transcript.updatedAt, turns: transcript.turns });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async load(id: string): Promise<Transcript | undefined> {
    return /^conv-[a-z0-9-]{6,60}$/.test(id) ? this.read(id) : undefined;
  }

  private async read(id: string): Promise<Transcript | undefined> {
    try {
      const { value, plain } = await this.decode(await readFile(path.join(this.dir, `${id}.json`), 'utf8'));
      const transcript = value as Transcript;
      if (!transcript || transcript.id !== id || !Array.isArray(transcript.messages)) return undefined;
      if (plain && this.key) await this.write(transcript).catch(() => undefined);
      return transcript;
    } catch {
      return undefined;
    }
  }

  private async prune(): Promise<void> {
    const all = await this.list();
    for (const old of all.slice(MAX_TRANSCRIPTS)) await rm(path.join(this.dir, `${old.id}.json`), { force: true });
  }
}

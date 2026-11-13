import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentMessage } from './nearAiClient';

export interface TranscriptSummary {
  id: string; title: string; model: string; updatedAt: string; turns: number;
  /** The conversation exists but this device cannot open it (its key is not here); it is listed so it never seems to have vanished. */
  locked?: boolean;
}
export interface Transcript extends TranscriptSummary {
  messages: AgentMessage[];
  /** [hash of the message the model saw, what the user typed] */
  display?: Array<[string, string]>;
  /** The entry of the thread log that ends what `messages` covers; set by the thread store, so a context a person continued elsewhere is noticed. */
  basedOnTip?: string;
}

/** What a conversation needs from its store: save it (at the end of a run, or part-way through), load it, and list the saved ones. */
export interface ConversationStore {
  save(transcript: Transcript): Promise<void>;
  checkpoint(transcript: Transcript): Promise<void>;
  load(id: string): Promise<Transcript | undefined>;
  list(): Promise<TranscriptSummary[]>;
}

type Envelope = { enc: 'aes-256-gcm'; iv: string; tag: string; data: string };

let shared: (() => Promise<Buffer>) | undefined;

/** The one transcript key source for the extension, so two stores never create two keys. */
export function sharedTranscriptKey(secrets: Parameters<typeof transcriptKey>[0]): () => Promise<Buffer> {
  shared ??= transcriptKey(secrets);
  return shared;
}

/** The name of a project's folder under an editor's `transcripts/` and `runs/`: the first 16 hex characters of sha256 of the project's path. */
export function projectFolderHash(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
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
export class TranscriptStore implements ConversationStore {
  private readonly dir: string;

  /**
   * `readOnly` makes a store that can only read: it never saves, and reading a transcript saved before encryption does not re-save it encrypted. The
   * migration (plan 10) reads an editor's old folder this way, so nothing in that folder is ever changed.
   */
  public constructor(storageDir: string, root: string, private readonly key?: () => Promise<Buffer>, private readonly readOnly = false) {
    this.dir = path.join(storageDir, 'transcripts', projectFolderHash(root));
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

  /** Saves a conversation. Nothing is ever deleted to make room: a conversation stays until the person removes it. */
  public async save(transcript: Transcript): Promise<void> {
    if (this.readOnly) throw new Error('This transcript store is read-only.');
    if (!/^conv-[a-z0-9-]{6,60}$/.test(transcript.id)) throw new Error('Invalid transcript id.');
    await this.write(transcript);
  }

  /** Saves a running conversation's state, the same as `save`; the thread store treats the two differently, so callers keep them apart. */
  public async checkpoint(transcript: Transcript): Promise<void> {
    if (this.readOnly) throw new Error('This transcript store is read-only.');
    if (!/^conv-[a-z0-9-]{6,60}$/.test(transcript.id)) throw new Error('Invalid transcript id.');
    await this.write(transcript);
  }

  private async write(transcript: Transcript): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${transcript.id}.json`);
    // A random name, so two editors saving one conversation at once never write the same temporary file.
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, await this.encode(transcript), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  }

  public async list(): Promise<TranscriptSummary[]> {
    const summaries: TranscriptSummary[] = [];
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (!name.endsWith('.json') || !/^conv-[a-z0-9-]{6,60}$/.test(name.slice(0, -5))) continue;
      const transcript = await this.read(name.slice(0, -5));
      if (transcript) { summaries.push({ id: transcript.id, title: transcript.title, model: transcript.model, updatedAt: transcript.updatedAt, turns: transcript.turns }); continue; }
      // A file that is there but cannot be opened (sealed with a key this device does not have) is listed as locked, never dropped from the list.
      const modified = (await stat(path.join(this.dir, name)).catch(() => undefined))?.mtime;
      summaries.push({ id: name.slice(0, -5), title: '', model: '', updatedAt: (modified ?? new Date(0)).toISOString(), turns: 0, locked: true });
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
      if (plain && this.key && !this.readOnly) await this.write(transcript).catch(() => undefined);
      return transcript;
    } catch {
      return undefined;
    }
  }
}

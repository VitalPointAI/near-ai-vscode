import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentMessage } from './nearAiClient';

const MAX_TRANSCRIPTS = 50;

export interface TranscriptSummary { id: string; title: string; model: string; updatedAt: string; turns: number }
export interface Transcript extends TranscriptSummary { messages: AgentMessage[]; /** [hash of the message the model saw, what the user typed] */ display?: Array<[string, string]> }

/**
 * Full conversation transcripts, so a chat can be resumed with its context. Kept in the
 * extension's storage on this machine (one folder per project), never in the project itself.
 */
export class TranscriptStore {
  private readonly dir: string;

  public constructor(storageDir: string, root: string) {
    this.dir = path.join(storageDir, 'transcripts', createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16));
  }

  public async save(transcript: Transcript): Promise<void> {
    if (!/^conv-[a-z0-9-]{6,60}$/.test(transcript.id)) throw new Error('Invalid transcript id.');
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${transcript.id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(transcript), 'utf8');
    await rename(temporary, file);
    await this.prune();
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
      const value = JSON.parse(await readFile(path.join(this.dir, `${id}.json`), 'utf8')) as Transcript;
      return value && value.id === id && Array.isArray(value.messages) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async prune(): Promise<void> {
    const all = await this.list();
    for (const old of all.slice(MAX_TRANSCRIPTS)) await rm(path.join(this.dir, `${old.id}.json`), { force: true });
  }
}

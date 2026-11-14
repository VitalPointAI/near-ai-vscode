// A fake editor globalStorage as 0.4.19 left it (plan 10 tests only). It builds folders in a temporary directory with the same file formats the old
// stores wrote, so the migration is tested against the real formats and never touches an editor's real data folders.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RUN_FORMAT, serializeRun, type SavedRun } from '../../benchmark/results';
import type { AgentMessage } from '../../services/nearAiClient';
import { projectFolderHash, TranscriptStore } from '../../services/transcripts';
import { MemorySecrets } from './stateFixtures';

export interface LegacyTranscriptInput {
  id: string;
  title?: string;
  model?: string;
  updatedAt: string;
  messages: AgentMessage[];
  display?: Array<[string, string]>;
}

export interface LegacyMarkerInput {
  conversationId: string;
  runId: string;
  activeAt: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: string;
  pid?: number;
  version?: 1 | 2;
  writer?: string;
  steps?: string[];
  model?: string;
}

export interface LegacyCheckpointInput {
  runId: string;
  snapshots: Array<{ path: string; original: string | null }>;
}

export interface LegacySpendInput {
  /** The key identity folder under spend/. */
  identity: string;
  /** `yyyy-mm`. */
  month: string;
  lines: object[];
}

export interface LegacyOptions {
  /** The editor's old install-local transcript key. Without one the transcripts are written in the old plain form. */
  key?: Buffer;
  transcripts?: LegacyTranscriptInput[];
  /** Files written as they are, for malformed transcripts: name (without .json) and text. */
  rawTranscripts?: Array<{ name: string; text: string }>;
  markers?: LegacyMarkerInput[];
  rawMarkers?: Array<{ name: string; text: string }>;
  checkpoints?: LegacyCheckpointInput[];
  evals?: SavedRun[];
  rawEvals?: Array<{ name: string; text: string }>;
  spend?: LegacySpendInput[];
  /** Team Mode, cyber, the runtime and the emergency stop: folders the migration must leave alone. */
  decoys?: boolean;
  /** The editor's SecretStorage (a new one when omitted); it holds the old key under nearAi.transcripts.key. */
  secrets?: MemorySecrets;
}

export interface LegacyEditor {
  dir: string;
  secrets: MemorySecrets;
  /** The old key as the migration gets it: undefined when this editor has none. */
  oldKey: () => Promise<Buffer | undefined>;
}

/** Writes one editor's globalStorage under `dir` for the project at `root`, in the formats 0.4.19 used. */
export async function legacyEditor(dir: string, root: string, options: LegacyOptions = {}): Promise<LegacyEditor> {
  await mkdir(dir, { recursive: true });
  const secrets = options.secrets ?? new MemorySecrets();
  const { key } = options;
  if (key) secrets.values.set('nearAi.transcripts.key', key.toString('base64'));

  const store = new TranscriptStore(dir, root, key ? async () => key : undefined);
  for (const input of options.transcripts ?? []) {
    await store.save({ id: input.id, title: input.title ?? 'A conversation', model: input.model ?? 'm', updatedAt: input.updatedAt, turns: input.messages.filter((message) => message.role === 'user').length, messages: input.messages, display: input.display ?? [] });
  }
  const folder = path.join(dir, 'transcripts', projectFolderHash(root));
  for (const raw of options.rawTranscripts ?? []) {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${raw.name}.json`), raw.text, 'utf8');
  }

  const runs = path.join(dir, 'runs', projectFolderHash(root));
  for (const marker of options.markers ?? []) {
    await mkdir(runs, { recursive: true });
    const version = marker.version ?? 1;
    const body = { version, conversationId: marker.conversationId, runId: marker.runId, pid: marker.pid ?? 4242, ...(marker.writer ? { writer: marker.writer } : {}), ...(marker.model ? { model: marker.model } : {}), startedAt: marker.startedAt ?? marker.activeAt, activeAt: marker.activeAt, steps: marker.steps ?? [], ...(marker.endedAt ? { endedAt: marker.endedAt, outcome: marker.outcome ?? 'completed' } : {}) };
    await writeFile(path.join(runs, `${marker.conversationId}.json`), `${JSON.stringify(body)}\n`, 'utf8');
  }
  for (const raw of options.rawMarkers ?? []) {
    await mkdir(runs, { recursive: true });
    await writeFile(path.join(runs, `${raw.name}.json`), raw.text, 'utf8');
  }

  // Checkpoints are one flat folder for every project, a bare array of absolute paths (format 1).
  for (const checkpoint of options.checkpoints ?? []) {
    await mkdir(path.join(dir, 'checkpoints'), { recursive: true });
    await writeFile(path.join(dir, 'checkpoints', `${checkpoint.runId}.json`), JSON.stringify(checkpoint.snapshots.map((snapshot) => ({ path: snapshot.path, original: snapshot.original }))), 'utf8');
  }

  for (const run of options.evals ?? []) {
    await mkdir(path.join(dir, 'evals'), { recursive: true });
    await writeFile(path.join(dir, 'evals', `${run.id}.json`), serializeRun(run), 'utf8');
  }
  for (const raw of options.rawEvals ?? []) {
    await mkdir(path.join(dir, 'evals'), { recursive: true });
    await writeFile(path.join(dir, 'evals', `${raw.name}.json`), raw.text, 'utf8');
  }

  for (const input of options.spend ?? []) {
    await mkdir(path.join(dir, 'spend', input.identity), { recursive: true });
    await writeFile(path.join(dir, 'spend', input.identity, `${input.month}.jsonl`), input.lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  }

  if (options.decoys) {
    for (const file of ['team/members/alice.md', 'teams/reviewers.md', 'cyber/abc123/engagement.json', 'gsd/runtime/package.json', 'emergency-stop.json']) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), `decoy ${file}\n`, 'utf8');
    }
  }
  return { dir, secrets, oldKey: async () => (await secrets.get('nearAi.transcripts.key')) ? Buffer.from((await secrets.get('nearAi.transcripts.key'))!, 'base64') : undefined };
}

/** A hash over every path (files and folders) and every file's content below `dir`: equal before and after means nothing was added, changed, moved or removed. */
export async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string): Promise<void> => {
    const items = (await readdir(current, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const item of items) {
      const full = path.join(current, item.name);
      const relative = path.relative(dir, full);
      if (item.isDirectory()) { hash.update(`d:${relative}\n`); await walk(full); continue; }
      const info = await stat(full);
      hash.update(`f:${relative}:${info.size}\n`);
      hash.update(await readFile(full));
    }
  };
  await walk(dir);
  return hash.digest('hex');
}

/** A minimal saved model comparison that the comparison store accepts. */
export function savedRunFixture(id: string, extra: Partial<SavedRun> = {}): SavedRun {
  return {
    format: RUN_FORMAT, version: 1, id, startedAt: `${id.slice(0, 10)}T${id.slice(11, 19).replace(/-/g, ':')}.000Z`, finishedAt: `${id.slice(0, 10)}T${id.slice(11, 19).replace(/-/g, ':')}.500Z`,
    status: 'completed', taskSet: 'short', mode: 'reuse', runsPerTask: 1,
    models: [{ id: 'model-a', privacy: 'tee', catalogVersion: 'v1' }], tasks: [{ id: 'task-1', kind: 'coding', version: '1' }], rows: [],
    ...extra
  };
}

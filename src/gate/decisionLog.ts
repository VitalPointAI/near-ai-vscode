// The gate's decision log on disk (GATE-07, D-21): one JSON line per record in <globalStorage>/gate/decisions/<project key>.jsonl. The project key is a
// hash, so no path appears in a file name, and nothing is ever written into the workspace, the transcripts or the synced project state. Node I/O only:
// this module never imports vscode.
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { redactRecord, validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import { GATE_DIR_NAME } from './bundleStore';

export const DECISIONS_DIR = 'decisions';

/** The first 32 hex characters of the SHA-256 of the normalised project root, so a file name never carries a path. */
export function projectLogKey(root: string): string {
  const normal = path.resolve(root).split(path.sep).join('/');
  return createHash('sha256').update(normal).digest('hex').slice(0, 32);
}

export interface DecisionLogOptions {
  readonly globalStorageDir: string;
  /** From projectLogKey. */
  readonly projectKey: string;
}

export class DecisionLog {
  private readonly file: string;

  public constructor(options: DecisionLogOptions) {
    this.file = path.join(options.globalStorageDir, GATE_DIR_NAME, DECISIONS_DIR, `${options.projectKey}.jsonl`);
  }

  /** Validates, redacts and appends one line, creating the folder on first use. */
  public async append(record: DecisionRecord): Promise<void> {
    const clean = redactRecord(record);
    const checked = validateDecisionRecord(clean);
    if (!checked.ok) throw new Error(`The decision record was not valid (${checked.reason} at ${checked.path}), so it was not written.`);
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(clean)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

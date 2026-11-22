import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { chainLine, GENESIS_PREV, verifyChain, type ChainHead, type ChainVerdict } from '../domain/gate/auditChain';
import { isAuditScanRange } from '../domain/setup/guideRecord';
import { AUDIT_EVENT_IDS, validateAuditBody, type AuditEventId, type AuditEventRegistry } from '../domain/setup/records';
import { canonicalize } from '../domain/team/canonical';
import { withFileLock } from '../services/stateMirrorLock';
import { GATE_DIR_NAME } from './bundleStore';

export const SETUP_AUDIT_DIR = 'setup';
export const MAX_SETUP_LOG_BYTES = 1024 * 1024;
export const MAX_SETUP_ROTATED_FILES = 4;
export const MAX_SETUP_RECORD_BYTES = 32 * 1024;
export const SETUP_AUDIT_TEXT = {
  writeFailed: 'NEAR AI could not save its tamper-evident record of this setup. Your settings are not affected.',
  chainBroken: 'NEAR AI could not verify its tamper-evident record of this setup.',
} as const;

export interface SetupAuditLogOptions {
  readonly globalStorageDir: string;
  /** The 32-character hash from projectLogKey. */
  readonly projectKey: string;
  readonly registry: AuditEventRegistry;
  readonly onWriteFailure: (message: string) => void;
  readonly clock?: () => number;
  readonly maxBytes?: number;
  readonly projectRoot?: string;
}

interface ChainStart { readonly seq: number; readonly prev: string; }
interface StoredHead extends ChainHead { readonly start: ChainStart; }
const GENESIS: ChainStart = { seq: 0, prev: GENESIS_PREV };
const toStart = (head: ChainHead): ChainStart => ({ seq: head.seq, prev: head.hash });
const HASH = /^[a-f0-9]{64}$/;

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function readLines(text: string): unknown[] {
  if (text === '') return [];
  const lines = text.split('\n');
  const incomplete = lines.pop() !== '';
  const parsed = lines.map((line): unknown => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  });
  if (incomplete) parsed.push(null);
  return parsed;
}

function readHead(text: string): StoredHead {
  const value = JSON.parse(text) as Partial<StoredHead> | null;
  if (!value || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1
      || typeof value.hash !== 'string' || !HASH.test(value.hash)
      || !value.start || !Number.isSafeInteger(value.start.seq) || value.start.seq < 0 || value.start.seq > value.seq
      || typeof value.start.prev !== 'string' || !HASH.test(value.start.prev)) throw new Error('Invalid setup audit head.');
  return { seq: value.seq, hash: value.hash, start: value.start };
}

export class SetupAuditLog {
  private readonly dir: string;
  private readonly file: string;
  private readonly headFile: string;
  private readonly lock: string;
  private reported = false;

  public constructor(private readonly options: SetupAuditLogOptions) {
    if (!/^[0-9a-f]{32}$/.test(options.projectKey)) throw new Error('The setup audit needs a project key made by projectLogKey.');
    if (options.projectRoot !== undefined) {
      const relative = path.relative(options.projectRoot, options.globalStorageDir);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        throw new Error('The setup audit folder must be outside the project.');
      }
    }
    this.dir = path.resolve(options.globalStorageDir, GATE_DIR_NAME, SETUP_AUDIT_DIR);
    this.file = path.join(this.dir, `${options.projectKey}.jsonl`);
    this.headFile = path.join(this.dir, `${options.projectKey}.head.json`);
    this.lock = `${options.projectKey}.lock`;
  }

  public async append(event: AuditEventId, body: unknown): Promise<{ ok: true; id: string; seq: number } | { ok: false; reason: string }> {
    try {
      const spec = AUDIT_EVENT_IDS.includes(event) ? this.options.registry.specFor(event) : undefined;
      if (!spec || spec.id !== event) return this.fail('invalid-event');
      // Snapshot before awaiting the lock. The checked body is exactly what gets hashed and saved.
      const stored: unknown = JSON.parse(canonicalize(body));
      if (!validateAuditBody(spec, stored)) return this.fail('invalid-body');
      if (event === 'setup.discovery.scan') {
        const { ranges } = stored as { ranges: unknown };
        if (!Array.isArray(ranges) || !ranges.every(isAuditScanRange)) return this.fail('invalid-body');
      }
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      return await withFileLock(this.dir, this.lock, async () => {
        const { verdict, start, bytes } = await this.readChain();
        if (!verdict.ok) return { ok: false, reason: verdict.why } as const;
        const last = verdict.head;
        const seq = (last?.seq ?? 0) + 1;
        const at = new Date((this.options.clock ?? Date.now)()).toISOString();
        const line = chainLine(last?.hash ?? GENESIS_PREV, seq, event, at, stored);
        const text = `${JSON.stringify(line)}\n`;
        const lineBytes = Buffer.byteLength(text);
        if (lineBytes > MAX_SETUP_RECORD_BYTES) return { ok: false, reason: 'record-too-large' } as const;
        const rotate = last !== undefined && bytes > 0 && bytes + lineBytes > (this.options.maxBytes ?? MAX_SETUP_LOG_BYTES);
        const nextStart = rotate ? toStart(last) : start;
        if (rotate) {
          await this.writeHead({ ...last, start: nextStart });
          await this.rotate();
        }
        try {
          await appendFile(this.file, text, { mode: 0o600 });
          await this.writeHead({ seq, hash: line.hash, start: nextStart });
        } catch (error) {
          // Roll back a failed append or head write while the same lock is held.
          await truncate(this.file, rotate ? 0 : bytes).catch(() => undefined);
          throw error;
        }
        return { ok: true, id: line.hash.slice(0, 16), seq } as const;
      }).then((result) => result.ok ? result : this.fail(result.reason));
    } catch {
      return this.fail('write-failed');
    }
  }

  public async verify(): Promise<ChainVerdict> {
    // Without an independently signed head (ADR-011), cutting both the tail and the head can go undetected.
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      return await withFileLock(this.dir, this.lock, async () => (await this.readChain()).verdict);
    } catch {
      return { ok: false, at: 1, why: 'shape' };
    }
  }

  public async latest(): Promise<ChainHead | undefined> {
    const verdict = await this.verify();
    return verdict.ok ? verdict.head : undefined;
  }

  private async readChain(): Promise<{ verdict: ChainVerdict; start: ChainStart; bytes: number }> {
    const [headText, current, ...archives] = await Promise.all([
      readOptional(this.headFile), readOptional(this.file),
      ...Array.from({ length: MAX_SETUP_ROTATED_FILES }, (_, index) => readOptional(this.rotated(MAX_SETUP_ROTATED_FILES - index))),
    ]);
    const head = headText === undefined ? undefined : readHead(headText);
    const bytes = Buffer.byteLength(current ?? '');
    let start = GENESIS;
    for (const [index, archive] of archives.entries()) {
      if (archive === undefined) continue;
      const lines = readLines(archive);
      if (lines.length === 0) return { verdict: { ok: false, at: start.seq + 1, why: 'shape' }, start, bytes };
      // In the last retention slot, earlier history may have expired. Verify all links from the oldest retained record onward.
      const first = lines[0] as Partial<ChainStart> | null;
      if (index === 0 && typeof first?.seq === 'number' && Number.isSafeInteger(first.seq) && first.seq > 1
          && typeof first.prev === 'string') start = { seq: first.seq - 1, prev: first.prev };
      const verdict = verifyChain(lines, undefined, start);
      if (!verdict.ok) return { verdict, start, bytes };
      if (verdict.head) start = toStart(verdict.head);
    }
    const verdict = verifyChain(readLines(current ?? ''), head, start);
    // start === head marks an interrupted rotation. The files themselves establish the current boundary in that state.
    const moving = head && head.start.seq === head.seq && head.start.prev === head.hash;
    if (verdict.ok && head && !moving && (head.start.seq !== start.seq || head.start.prev !== start.prev)) {
      return { verdict: { ok: false, at: start.seq + 1, why: 'head-mismatch' }, start, bytes };
    }
    return { verdict, start, bytes };
  }

  private rotated(index: number): string {
    return path.join(this.dir, `${this.options.projectKey}.${index}.jsonl`);
  }

  private async rotate(): Promise<void> {
    for (let index = MAX_SETUP_ROTATED_FILES - 1; index >= 1; index -= 1) {
      try { await rename(this.rotated(index), this.rotated(index + 1)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rename(this.file, this.rotated(1));
  }

  private async writeHead(head: StoredHead): Promise<void> {
    const temp = `${this.headFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(head)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, this.headFile);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private fail(reason: string): { ok: false; reason: string } {
    if (!this.reported) {
      this.reported = true;
      try { this.options.onWriteFailure(SETUP_AUDIT_TEXT.writeFailed); } catch { /* Reporting must not fail setup. */ }
    }
    return { ok: false, reason };
  }
}

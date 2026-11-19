// Runs the feed importer's parser in its own process (WP-IMP; research note 11, section 10: "separate parser process; DTD off; size and rate limits").
// The process gets a heap limit, a minimal environment (no tokens, keys or proxies from the extension host), no standard input or output, and a time
// limit: past it, it is killed with SIGKILL and the import is refused. A file over the byte cap is refused before any process starts. No vscode.
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { IMPORT_FORMATS, IMPORT_MAX_BYTES, IMPORT_MAX_HEAP_MB, IMPORT_MAX_ROWS, IMPORT_TIMEOUT_MS } from '../../domain/staff/obs/importers';
import type { ImportFormat, ParsedFeed } from '../../domain/staff/obs/importers';
import type { WorkerRequest } from './worker';

/** The parser script, beside this file once compiled. */
export const IMPORT_WORKER_FILE = path.join(__dirname, 'worker.js');

export interface ParserLimits {
  readonly maxBytes: number;
  readonly maxRecords: number;
  readonly timeoutMs: number;
  readonly maxHeapMb: number;
  /** For tests: another parser script. */
  readonly workerFile: string;
}

export const DEFAULT_PARSER_LIMITS: ParserLimits = {
  maxBytes: IMPORT_MAX_BYTES, maxRecords: IMPORT_MAX_ROWS, timeoutMs: IMPORT_TIMEOUT_MS, maxHeapMb: IMPORT_MAX_HEAP_MB, workerFile: IMPORT_WORKER_FILE
};

/** The environment the parser process gets: only what Node itself needs to start, and the switch that makes VS Code's Electron run as plain Node. */
function parserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

/** Whether what the process sent has the result's shape. Its records are read again, one by one, by planImport. */
function isParsedFeed(value: unknown, maxRecords: number): value is ParsedFeed {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.ok === false) return typeof result.message === 'string' && result.message.length <= 1000;
  if (result.ok !== true) return false;
  if (typeof result.format !== 'string' || !(IMPORT_FORMATS as readonly string[]).includes(result.format)) return false;
  if (!Array.isArray(result.records) || result.records.length > maxRecords) return false;
  const problems = result.problems;
  return typeof problems === 'object' && problems !== null && Object.values(problems).every((count) => Number.isSafeInteger(count) && (count as number) >= 0);
}

/**
 * Parses a feed file in a separate process. Never throws: every failure (too large, not a file, a parser that ran out of time or memory, a result of the
 * wrong shape) is a refusal with a plain sentence.
 */
export async function parseFeedFile(file: string, options: { readonly format?: ImportFormat; readonly limits?: Partial<ParserLimits>; /** For tests: what starts the process. */ readonly fork?: typeof fork } = {}): Promise<ParsedFeed> {
  const limits: ParserLimits = { ...DEFAULT_PARSER_LIMITS, ...(options.limits ?? {}) };
  try {
    const info = await stat(file);
    if (!info.isFile()) return { ok: false, message: 'That is not a file.' };
    if (info.size > limits.maxBytes) return { ok: false, message: `The file is larger than ${Math.round(limits.maxBytes / (1024 * 1024))} MB, the most the importer reads. Split it and import the parts.` };
  } catch {
    return { ok: false, message: 'The file could not be opened.' };
  }
  const start = options.fork ?? fork;
  return new Promise<ParsedFeed>((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: ParsedFeed): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve(result);
    };
    // fork() and send() can also throw at once (a bad argument, a closed channel): that is a refusal too, never a promise that waits forever.
    try {
      const started = start(limits.workerFile, [], {
        execArgv: [`--max-old-space-size=${limits.maxHeapMb}`],
        env: parserEnv(),
        cwd: path.dirname(limits.workerFile),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json'
      });
      child = started;
      timer = setTimeout(() => {
        const seconds = Math.max(1, Math.round(limits.timeoutMs / 1000));
        finish({ ok: false, message: `Reading the file took longer than ${seconds} second${seconds === 1 ? '' : 's'}, so the parser was stopped and nothing was imported.` });
      }, limits.timeoutMs);
      started.once('message', (message: unknown) => {
        finish(isParsedFeed(message, limits.maxRecords) ? message : { ok: false, message: 'The parser returned something that is not an import result, so nothing was imported.' });
      });
      started.once('error', () => finish({ ok: false, message: 'The parser process could not start.' }));
      started.once('exit', (code, signal) => {
        finish({ ok: false, message: `The parser stopped before it finished (${signal ?? `exit ${code ?? 'unknown'}`}: the file may be too large or too complex to read), so nothing was imported.` });
      });
      const request: WorkerRequest = { file, maxBytes: limits.maxBytes, maxRecords: limits.maxRecords, ...(options.format ? { format: options.format } : {}) };
      started.send(request, (error) => { if (error) finish({ ok: false, message: 'The parser process could not be reached.' }); });
    } catch {
      finish({ ok: false, message: child ? 'The parser process could not be reached.' : 'The parser process could not start.' });
    }
  });
}

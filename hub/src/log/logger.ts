// Copied from relay/src/log/logger.ts and adapted for the hub (D-28).
import { type Redactor, uniqueFieldName } from './redact';

// The hub's only output path to stdout (D-26). Every line is one JSON object: time, level, event, then the redacted fields. Values are
// JSON-encoded, so a control character or a newline inside a field cannot forge a second line, and the event name is checked against a fixed
// character set. The guard entry (bin.ts) is the only other file allowed to write, and only to stderr, only its fixed sentences.
//
// One exception lives here too, so this file stays the one place that writes to stdout: printKeyFile, the key line the operator asked for with
// --generate-key (D-30). It prints exactly that line and nothing else, so `> hub_signing_key` gives a clean key file.
// --hub-file and --pin-words (G541) print their one line through it too.

export type LogLevel = 'info' | 'warn' | 'error';

/** Writes one log line to stdout: the default sink, and the one main.ts filters for --hub-file (32-20). */
export function stdoutLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

const EVENT_NAME = /^[a-z0-9._-]+$/;
const RESERVED_KEYS = new Set(['time', 'level', 'event']);

export class Logger {
  constructor(
    private readonly redactor: Redactor,
    private readonly sink: (line: string) => void = stdoutLine,
    private readonly now: () => number = Date.now,
  ) {}

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write('error', event, fields);
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    // A Map, not a plain object, so a field called __proto__ is kept as a field instead of running the prototype setter.
    const entry = new Map<string, unknown>([
      ['time', new Date(this.now()).toISOString()],
      ['level', level],
      ['event', EVENT_NAME.test(event) ? event : 'invalid-event'],
    ]);
    for (const [key, value] of Object.entries(this.redactor.fields(fields))) {
      entry.set(uniqueFieldName(entry, RESERVED_KEYS.has(key) ? `field_${key}` : key), value);
    }
    try {
      this.sink(JSON.stringify(Object.fromEntries(entry)));
    } catch {
      // A broken sink (a closed pipe) must not take the hub down or throw into the code that logged.
    }
  }
}

/** Writes one key line from --generate-key to stdout, then resolves once it is flushed. No logger line comes before or after it (D-30). */
export function printKeyFile(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

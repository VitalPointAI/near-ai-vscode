// The feed importer's parser process (research note 11, 9.2 item 3 and section 10; WP-IMP). The extension host never parses a feed file: it starts this
// script as a separate Node process (runner.ts) with its own heap limit, a minimal environment and a time limit after which it is killed. A hostile file
// (entity expansion, a huge or deeply nested document, a crafted AIS log) can at worst exhaust or crash this process; the host sees a refusal.
//
// It reads one file, at most the byte cap given, as strict UTF-8, parses it with the pure codecs (domain/staff/obs/importers.ts), sends one result over
// the IPC channel and exits. It opens no network connection, writes no file and loads no module outside this extension.
import { open } from 'node:fs/promises';
import { parseFeedText, IMPORT_FORMATS } from '../../domain/staff/obs/importers';
import type { ImportFormat, ParsedFeed } from '../../domain/staff/obs/importers';

export interface WorkerRequest { readonly file: string; readonly maxBytes: number; readonly maxRecords: number; readonly format?: ImportFormat }

async function readCapped(file: string, maxBytes: number): Promise<string | ParsedFeed> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, message: 'That is not a file.' };
    if (info.size > maxBytes) return { ok: false, message: `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, the most the importer reads.` };
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return { ok: false, message: 'The file grew past the size limit while it was read.' };
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      return { ok: false, message: 'The file is not UTF-8 text.' };
    }
  } finally {
    await handle.close();
  }
}

async function handle(request: WorkerRequest): Promise<ParsedFeed> {
  const format = request.format !== undefined && (IMPORT_FORMATS as readonly string[]).includes(request.format) ? request.format : undefined;
  const text = await readCapped(request.file, request.maxBytes);
  if (typeof text !== 'string') return text;
  return parseFeedText(text, { ...(format ? { format } : {}), maxRecords: request.maxRecords });
}

if (typeof process.send === 'function') {
  process.once('message', (message: unknown) => {
    const request = message as WorkerRequest;
    handle(request)
      .catch((error: unknown) => ({ ok: false, message: `The file could not be read (${error instanceof RangeError ? 'too deeply nested' : 'parser error'}).` }) as ParsedFeed)
      .then((result) => { process.send!(result, () => process.exit(0)); });
  });
}

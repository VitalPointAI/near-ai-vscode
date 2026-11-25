// The live projector (33-06, Task 3): the product files of a shared project that are not open in a bound editor follow the fold, without ever writing
// over a person's edit. A file is written only when its text is the text this device last projected there (or, before any record, when only its
// header differs from the projection, the Phase 30 rule). Anything else is left as it is and listed: an edited, incomplete or unreadable file, a
// write that lands while the projector writes. Nothing is ever deleted (projection.ts, writeProjections, keeps the Phase 30 to 32 rules unchanged).
//
// The last projected texts are kept per project on this device, beside the server address (hub.json) in the genesis pin's folder: product name to
// the sha256 of the whole file text written. Nothing in the project folder or the shared record is written for it.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { STREAM_ID_PATTERN } from '../../domain/replica/entry';
import { staffProductPath } from '../../domain/staff/writeLimits';
import { isRecord } from '../../domain/team/validate';
import { readWhole, replaceKeepingEdits, snapshotOfBytes } from '../staffFiles';
import { hubAddressFile, readLocalSettings, writeLocalSettings } from './hubAddress';
import { foldTexts, PROJECTION_LEFT_REASONS, productBodyOf, projectProductFile, projectProductStates, type ProjectionInput } from './projection';

export const LAST_PROJECTED_FILE = 'projected.json';
const LAST_PROJECTED_MAX_BYTES = 1024 * 1024;
const LAST_PROJECTED_PROBLEM = 'This computer could not use its record of the product files it last wrote for this shared work.';
const SHA256 = /^[0-9a-f]{64}$/;

/** What projectLive did, by path from the project root. `left`: a file it did not write, with the reason in the words a person reads. */
export interface LiveProjectionResult {
  readonly written: string[];
  readonly unchanged: string[];
  readonly left: Array<{ path: string; reason: string }>;
}

export interface LiveProjectionOptions {
  readonly globalStorageDir: string;
  /** The project's stream id: the record is kept per project. */
  readonly project: string;
  /** Products open in a bound editor: the editor binding writes those, so the projector skips them. */
  readonly bound?: ReadonlySet<string>;
}

export function lastProjectedFile(globalStorageDir: string, project: string): string {
  return path.join(path.dirname(hubAddressFile(globalStorageDir, project)), LAST_PROJECTED_FILE);
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The record as read: an absent, damaged or foreign record reads as empty, so only the Phase 30 header rule applies until it is written again. */
async function readRecord(file: string, project: string): Promise<Map<string, string>> {
  try {
    const text = await readLocalSettings(file, LAST_PROJECTED_MAX_BYTES, LAST_PROJECTED_PROBLEM);
    if (text === undefined) return new Map();
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'products,project,v' || value.v !== 1 || value.project !== project || !isRecord(value.products)) return new Map();
    const out = new Map<string, string>();
    for (const [product, hash] of Object.entries(value.products)) if (typeof hash === 'string' && SHA256.test(hash)) out.set(product, hash);
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Writes the product files of a shared project from the fold. Each product's file is the projected header and the fold's live text (as
 * writeProjections writes it); it is written only over the text this device last projected there, or where no file is, and never for a product
 * open in a bound editor. The record of last projected texts is updated after the files.
 */
export async function projectLive(root: string, input: ProjectionInput, options: LiveProjectionOptions): Promise<LiveProjectionResult> {
  if (!STREAM_ID_PATTERN.test(options.project)) throw new TypeError('projectLive needs the shared project id.');
  const out: LiveProjectionResult = { written: [], unchanged: [], left: [] };
  const recordFile = lastProjectedFile(options.globalStorageDir, options.project);
  const last = await readRecord(recordFile, options.project);
  const next = new Map(last);
  const { texts, incomplete } = foldTexts(input.fold);
  for (const [product, state] of projectProductStates(input)) {
    if (options.bound?.has(product)) continue;
    const relative = staffProductPath(state.record.section, product);
    if (incomplete.has(product)) { out.left.push({ path: relative, reason: PROJECTION_LEFT_REASONS['text-incomplete'] }); continue; }
    const body = texts.get(product);
    if (body === undefined) continue;
    const text = projectProductFile(state, body);
    const file = path.join(root, ...relative.split('/'));
    const read = await readWhole(file);
    if (read.kind === 'unreadable') { out.left.push({ path: relative, reason: `${PROJECTION_LEFT_REASONS.unreadable}: ${read.reason}` }); continue; }
    // A product with no text and no file stays without one.
    if (read.kind === 'missing' && body === '') continue;
    if (read.kind === 'text' && read.text === text) {
      out.unchanged.push(relative);
      next.set(product, sha256(text));
      continue;
    }
    if (read.kind === 'text') {
      const recorded = last.get(product);
      const ours = recorded !== undefined ? sha256(read.text) === recorded : productBodyOf(read.text) === body;
      if (!ours) { out.left.push({ path: relative, reason: PROJECTION_LEFT_REASONS['text-changed'] }); continue; }
    }
    const replaced = await replaceKeepingEdits(file, snapshotOfBytes(read.kind === 'text' ? read.bytes : undefined), text);
    if (replaced.status === 'written') {
      out.written.push(relative);
      next.set(product, sha256(text));
    } else {
      out.left.push({ path: relative, reason: PROJECTION_LEFT_REASONS.raced });
      if ('kept' in replaced && replaced.kept !== undefined) out.left.push({ path: path.relative(root, replaced.kept).split(path.sep).join('/'), reason: PROJECTION_LEFT_REASONS.raced });
    }
  }
  const changed = next.size !== last.size || [...next].some(([product, hash]) => last.get(product) !== hash);
  if (changed) {
    const products = Object.fromEntries([...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    await writeLocalSettings(recordFile, `${JSON.stringify({ v: 1, project: options.project, products })}\n`, LAST_PROJECTED_PROBLEM);
  }
  return out;
}

// The last-valid marker (D-15, OFFL-02): one small entry in SecretStorage that says "this install has had a valid policy bundle, at this time, with this
// hash". It is the one fact a person or script with only disk access cannot erase, so a deleted bundle file reads as missing and not as a fresh install,
// and it carries the latest time this install has seen, so turning the clock back never revives an expired bundle. Node I/O only: no vscode, SecretStorage
// is reached through the type-only SecretStorageLike interface.
import type { SecretStorageLike } from '../services/auth';

export const LAST_VALID_SECRET = 'nearAi.gate.lastValid';

/** `present` is true for any stored value, even one that does not parse, so a damaged marker never looks like a fresh install. */
export type LastValid = { readonly present: false } | { readonly present: true; readonly at?: number; readonly hash?: string };

export interface LastValidInput {
  /** Epoch milliseconds. */
  readonly at: number;
  /** Lowercase hex hash of the valid bundle (bundleHash). */
  readonly hash: string;
}

function parseMarker(text: string): { at?: number; hash?: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const out: { at?: number; hash?: string } = {};
    if (typeof record.at === 'number' && Number.isSafeInteger(record.at) && record.at >= 0) out.at = record.at;
    if (typeof record.hash === 'string' && /^[0-9a-f]{64}$/.test(record.hash)) out.hash = record.hash;
    return out;
  } catch {
    return {};
  }
}

/** Reads the marker. A secret store that cannot be read throws, and the caller decides what that means (the gate fails closed). */
export async function readLastValid(secrets: SecretStorageLike): Promise<LastValid> {
  const text = await secrets.get(LAST_VALID_SECRET);
  if (text === undefined || text === '') return { present: false };
  return { present: true, ...parseMarker(text) };
}

/**
 * Stores the marker and reads it back. The time never moves backwards: when the stored marker already holds a later time, that time is kept (D-15).
 * Throws an Error with a plain message when the marker cannot be stored or the read back does not match, so nothing is trusted that was not saved.
 */
export async function writeLastValid(secrets: SecretStorageLike, input: LastValidInput): Promise<{ at: number; hash: string }> {
  const previous = await readLastValid(secrets);
  const at = previous.present && previous.at !== undefined && previous.at > input.at ? previous.at : input.at;
  const text = JSON.stringify({ at, hash: input.hash });
  await secrets.store(LAST_VALID_SECRET, text);
  if ((await secrets.get(LAST_VALID_SECRET)) !== text) throw new Error('The policy marker could not be read back from this computer\'s secret storage, so it was not used.');
  return { at, hash: input.hash };
}

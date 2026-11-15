import { createHash, randomBytes } from 'node:crypto';
import { readPrivateFile, StateDirError, writePrivateFileAtomic } from '../stateDir';
import type { Logger } from './logger';

// The key behind the stable phone labels in logs (D-11, D-18). A label is an HMAC of the number under this key, so the same number gets the same
// label on every run only if the key is the same on every run. Source, in order:
//  1. an operator secret (LOG_PSEUDONYM_KEY through a file): the key is its SHA-256 and nothing is written (D-09);
//  2. the file log-pseudonym.key in the state directory, 32 random bytes, 0600, created once and reused.
// The key value is never logged, only where it came from.

export const PSEUDONYM_KEY_FILE = 'log-pseudonym.key';

const KEY_BYTES = 32;

export interface PseudonymKeyOptions {
  secret?: string;
  stateDir: string;
  logger: Logger;
}

export async function loadPseudonymKey(options: PseudonymKeyOptions): Promise<Buffer> {
  const { secret, stateDir, logger } = options;
  if (secret !== undefined) {
    logger.info('log.pseudonym_key', { source: 'secret' });
    return createHash('sha256').update(secret).digest();
  }

  const existing = await readPrivateFile(stateDir, PSEUDONYM_KEY_FILE);
  if (existing !== undefined) {
    if (existing.length !== KEY_BYTES) {
      throw new StateDirError(
        `${PSEUDONYM_KEY_FILE} in RELAY_STATE_DIR is damaged (expected ${KEY_BYTES} bytes). Remove it to create a new one; phone labels in older logs will then no longer match.`,
      );
    }
    logger.info('log.pseudonym_key', { source: 'state-file' });
    return existing;
  }

  const created = randomBytes(KEY_BYTES);
  await writePrivateFileAtomic(stateDir, PSEUDONYM_KEY_FILE, created);
  logger.info('log.pseudonym_key', { source: 'created' });
  return created;
}

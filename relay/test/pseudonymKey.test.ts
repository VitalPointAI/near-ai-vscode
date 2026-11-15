import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Logger } from '../src/log/logger';
import { loadPseudonymKey, PSEUDONYM_KEY_FILE } from '../src/log/pseudonymKey';
import { Redactor } from '../src/log/redact';
import { prepareStateDir, StateDirError } from '../src/stateDir';

// Phase 68, plan 06 (D-11, D-18): phone labels are stable across restarts. The key comes from LOG_PSEUDONYM_KEY when the operator supplies it
// (nothing is written), otherwise from a random key file the relay creates once in the state directory (0600) and reuses.

const FAKE_SECRET = 'relay-pseudonym-test-secret-7d21';
const PHONE = '+1 (555) 010-0199';

interface Harness {
  stateDir: string;
  logger: Logger;
  lines: Record<string, unknown>[];
}

async function withState<T>(body: (harness: Harness) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-pseudonym-'));
  const lines: Record<string, unknown>[] = [];
  const logger = new Logger(new Redactor(), (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); });
  try {
    await prepareStateDir(stateDir, logger);
    lines.length = 0;
    return await body({ stateDir, logger, lines });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('with no secret a fresh directory gets a 32-byte 0600 key file (source created) and a second load returns the same bytes (source state-file)', async () => {
  await withState(async ({ stateDir, logger, lines }) => {
    const first = await loadPseudonymKey({ stateDir, logger });
    assert.equal(first.length, 32);
    assert.equal(PSEUDONYM_KEY_FILE, 'log-pseudonym.key');
    const info = await stat(path.join(stateDir, PSEUDONYM_KEY_FILE));
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(await readFile(path.join(stateDir, PSEUDONYM_KEY_FILE)), first);
    assert.deepEqual(lines.map((line) => [line.event, line.source]), [['log.pseudonym_key', 'created']]);

    const second = await loadPseudonymKey({ stateDir, logger });
    assert.deepEqual(second, first);
    assert.deepEqual(lines.map((line) => line.source), ['created', 'state-file']);
    // No temporary file is left behind.
    assert.deepEqual(await readdir(stateDir), [PSEUDONYM_KEY_FILE]);
  });
});

test('with a secret the key is the SHA-256 of it, nothing is written, the source is secret, and two loads agree', async () => {
  await withState(async ({ stateDir, logger, lines }) => {
    const first = await loadPseudonymKey({ secret: FAKE_SECRET, stateDir, logger });
    const second = await loadPseudonymKey({ secret: FAKE_SECRET, stateDir, logger });
    assert.deepEqual(first, createHash('sha256').update(FAKE_SECRET).digest());
    assert.deepEqual(second, first);
    assert.deepEqual(await readdir(stateDir), []);
    assert.deepEqual(lines.map((line) => [line.event, line.source]), [['log.pseudonym_key', 'secret'], ['log.pseudonym_key', 'secret']]);
  });
});

test('the key value is never logged: no line contains the key in hex, base64 or the secret itself', async () => {
  await withState(async ({ stateDir, logger, lines }) => {
    const created = await loadPseudonymKey({ stateDir, logger });
    const derived = await loadPseudonymKey({ secret: FAKE_SECRET, stateDir, logger });
    const text = JSON.stringify(lines);
    for (const key of [created, derived]) {
      assert.ok(!text.includes(key.toString('hex')));
      assert.ok(!text.includes(key.toString('base64')));
    }
    assert.ok(!text.includes(FAKE_SECRET));
  });
});

test('a key file of 31 bytes stops with a plain message naming log-pseudonym.key and RELAY_STATE_DIR', async () => {
  await withState(async ({ stateDir, logger }) => {
    await writeFile(path.join(stateDir, PSEUDONYM_KEY_FILE), Buffer.alloc(31, 7), { mode: 0o600 });
    await assert.rejects(loadPseudonymKey({ stateDir, logger }), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /log-pseudonym\.key/);
      assert.match(error.message, /RELAY_STATE_DIR/);
      assert.match(error.message, /32 bytes/);
      return true;
    });
  });
});

test('a key file open to other users is refused through readPrivateFile', async () => {
  await withState(async ({ stateDir, logger }) => {
    const file = path.join(stateDir, PSEUDONYM_KEY_FILE);
    await writeFile(file, Buffer.alloc(32, 9));
    await chmod(file, 0o644);
    await assert.rejects(loadPseudonymKey({ stateDir, logger }), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /open to other users/);
      return true;
    });
  });
});

test('two redactors given keys from two successive loads over one directory label the same phone number identically, and a different directory labels it differently', async () => {
  await withState(async ({ stateDir, logger }) => {
    const before = new Redactor();
    before.setPseudonymKey(await loadPseudonymKey({ stateDir, logger }));
    const after = new Redactor();
    after.setPseudonymKey(await loadPseudonymKey({ stateDir, logger }));
    const label = before.text(`call from ${PHONE}`);
    assert.match(label, /^call from phone:[0-9a-f]{8}$/);
    assert.equal(after.text(`call from ${PHONE}`), label);

    await withState(async (other) => {
      const different = new Redactor();
      different.setPseudonymKey(await loadPseudonymKey({ stateDir: other.stateDir, logger: other.logger }));
      assert.notEqual(different.text(`call from ${PHONE}`), label);
    });
  });
});

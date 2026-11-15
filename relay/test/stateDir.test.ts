import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Logger } from '../src/log/logger';
import { Redactor } from '../src/log/redact';
import { prepareStateDir, readPrivateFile, StateDirError, writePrivateFileAtomic } from '../src/stateDir';
import { openSqliteStore } from '../src/store/sqliteStore';

// Phase 68, plan 04 (RELAY-03, D-07, D-17): the private state directory. The tests run with a loose umask (022) on purpose: the relay must not
// depend on the umask to keep its directory and files private.

const BIN = fileURLToPath(new URL('../bin.mjs', import.meta.url));
const UID = process.getuid?.() ?? -1;
const IS_ROOT = UID === 0;
const NOT_ROOT_ONLY = IS_ROOT ? 'the test runs as root, which can write anywhere, so a root-owned directory is not foreign here (Pitfall 11)' : false;

async function withTemp<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-statedir-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withUmask<T>(mask: number, body: () => Promise<T>): Promise<T> {
  const previous = process.umask(mask);
  try {
    return await body();
  } finally {
    process.umask(previous);
  }
}

function capture(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = new Logger(new Redactor(), (line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return { logger, lines };
}

async function modeOf(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}

test('a missing nested directory is created 0700 whatever the umask', async () => {
  await withTemp(async (root) => {
    await withUmask(0o022, async () => {
      const dir = path.join(root, 'a', 'state');
      const { logger, lines } = capture();
      await prepareStateDir(dir, logger);
      assert.equal(await modeOf(dir), 0o700);
      assert.deepEqual(lines, [], 'creating a directory is not a tightening and logs nothing');
    });
  });
});

test('a directory the relay owns but left open is tightened to 0700 with exactly one state_dir.tightened line', async () => {
  await withTemp(async (root) => {
    await withUmask(0o022, async () => {
      const dir = path.join(root, 'state');
      await mkdir(dir, { mode: 0o755 });
      await chmod(dir, 0o755);
      const { logger, lines } = capture();
      await prepareStateDir(dir, logger);
      assert.equal(await modeOf(dir), 0o700);
      const tightened = lines.filter((line) => line.event === 'state_dir.tightened');
      assert.equal(tightened.length, 1);
      assert.equal(tightened[0]?.fromMode, '0755');
      assert.equal(tightened[0]?.level, 'info');
      assert.equal(lines.length, 1);
      // A second start finds nothing to tighten.
      const again = capture();
      await prepareStateDir(dir, again.logger);
      assert.deepEqual(again.lines, []);
    });
  });
});

test('a 0644 file in the directory is tightened to 0600 with a state_dir.file_tightened line, and an open own subfolder to 0700', async () => {
  await withTemp(async (root) => {
    await withUmask(0o022, async () => {
      const dir = path.join(root, 'state');
      await mkdir(dir, { mode: 0o700 });
      const file = path.join(dir, 'old.db');
      await writeFile(file, 'x', { mode: 0o644 });
      await chmod(file, 0o644);
      const folder = path.join(dir, 'tenant-a');
      await mkdir(folder);
      await chmod(folder, 0o755);
      const { logger, lines } = capture();
      await prepareStateDir(dir, logger);
      assert.equal(await modeOf(file), 0o600);
      assert.equal(await modeOf(folder), 0o700);
      const tightened = lines.filter((line) => line.event === 'state_dir.file_tightened');
      assert.deepEqual(
        tightened.map((line) => [line.name, line.fromMode]).sort(),
        [['old.db', '0644'], ['tenant-a', '0755']],
      );
    });
  });
});

test('a directory owned by another user is refused with a plain reason naming RELAY_STATE_DIR', async (t) => {
  await withTemp(async (root) => {
    const dir = path.join(root, 'state');
    await mkdir(dir, { mode: 0o700 });
    const { logger, lines } = capture();
    await assert.rejects(prepareStateDir(dir, logger, { uid: UID + 1 }), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /RELAY_STATE_DIR/);
      assert.ok(error.message.includes(dir));
      assert.match(error.message, new RegExp(`owned by uid ${UID}`));
      assert.match(error.message, new RegExp(`runs as uid ${UID + 1}`));
      return true;
    });
    assert.deepEqual(lines, []);
  });
  t.diagnostic('refusal checked by passing a different uid, so it holds as root too');
});

test('/usr, a real directory owned by root, is refused for a normal user', { skip: NOT_ROOT_ONLY }, async () => {
  const { logger } = capture();
  await assert.rejects(prepareStateDir('/usr', logger), (error: unknown) => {
    assert.ok(error instanceof StateDirError);
    assert.match(error.message, /RELAY_STATE_DIR \/usr is owned by uid 0/);
    return true;
  });
  assert.ok((await stat('/usr')).mode, '/usr was not touched');
});

test('a symbolic link to a directory, a regular file, and a directory holding a symbolic link are each refused', async () => {
  await withTemp(async (root) => {
    const real = path.join(root, 'real');
    await mkdir(real, { mode: 0o700 });
    const { logger } = capture();

    const link = path.join(root, 'link');
    await symlink(real, link);
    await assert.rejects(prepareStateDir(link, logger), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /RELAY_STATE_DIR/);
      assert.match(error.message, /symbolic link/);
      return true;
    });

    const plain = path.join(root, 'plain');
    await writeFile(plain, 'x', { mode: 0o600 });
    await assert.rejects(prepareStateDir(plain, logger), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /RELAY_STATE_DIR/);
      assert.match(error.message, /not a directory/);
      return true;
    });

    await symlink('/etc/hostname', path.join(real, 'sneaky'));
    await assert.rejects(prepareStateDir(real, logger), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /RELAY_STATE_DIR/);
      assert.match(error.message, /symbolic link \(sneaky\)/);
      return true;
    });
  });
});

test('a lost+found folder is left alone (a state directory on its own volume), but lost+found as a file or a link is checked like any entry', async () => {
  await withTemp(async (root) => {
    await withUmask(0o022, async () => {
      const dir = path.join(root, 'state');
      await mkdir(dir, { mode: 0o700 });
      await chmod(dir, 0o700);
      // On a real volume lost+found belongs to root, which a test cannot create; this one is ours and open (0755). It is neither tightened nor
      // logged, which shows the entry is skipped before the owner and mode checks, so a root owner is not looked at either.
      await mkdir(path.join(dir, 'lost+found'), { mode: 0o755 });
      await chmod(path.join(dir, 'lost+found'), 0o755);
      const { logger, lines } = capture();
      await prepareStateDir(dir, logger);
      assert.equal(await modeOf(path.join(dir, 'lost+found')), 0o755);
      assert.deepEqual(lines, []);
      // And it is skipped only as a folder: a file of that name is tightened like any other, and a link of that name is refused.
      await rm(path.join(dir, 'lost+found'), { recursive: true });
      await writeFile(path.join(dir, 'lost+found'), 'x');
      await chmod(path.join(dir, 'lost+found'), 0o644);
      await prepareStateDir(dir, logger);
      assert.equal(await modeOf(path.join(dir, 'lost+found')), 0o600);
      await rm(path.join(dir, 'lost+found'));
      await symlink(root, path.join(dir, 'lost+found'));
      await assert.rejects(prepareStateDir(dir, logger), StateDirError);
    });
  });
});

test('a temporary file that writePrivateFileAtomic left behind is removed at start with one log line; other names are kept', async () => {
  await withTemp(async (root) => {
    const dir = path.join(root, 'state');
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
    const stale = '.log-pseudonym.key.0a1b2c3d.tmp';
    await writeFile(path.join(dir, stale), 'half-written key material', { mode: 0o600 });
    for (const keep of ['.log-pseudonym.key.tmp', 'notes.0a1b2c3d.tmp', '.key.0A1B2C3D.tmp']) await writeFile(path.join(dir, keep), 'x', { mode: 0o600 });
    const { logger, lines } = capture();
    await prepareStateDir(dir, logger);
    assert.deepEqual((await readdir(dir)).sort(), ['.key.0A1B2C3D.tmp', '.log-pseudonym.key.tmp', 'notes.0a1b2c3d.tmp']);
    assert.deepEqual(lines.map((line) => [line.event, line.name]), [['state_dir.stale_temp_removed', stale]]);
  });
});

test('writePrivateFileAtomic leaves a 0600 file with the exact bytes, replaces an earlier one, and leaves no temporary file', async () => {
  await withTemp(async (dir) => {
    await withUmask(0o022, async () => {
      await writePrivateFileAtomic(dir, 'key.bin', Buffer.from([1, 2, 3, 255]));
      assert.equal(await modeOf(path.join(dir, 'key.bin')), 0o600);
      assert.deepEqual(await readPrivateFile(dir, 'key.bin'), Buffer.from([1, 2, 3, 255]));
      await writePrivateFileAtomic(dir, 'key.bin', 'second');
      assert.equal((await readPrivateFile(dir, 'key.bin'))?.toString(), 'second');
      assert.deepEqual(await readdir(dir), ['key.bin']);
    });
  });
});

test('writePrivateFileAtomic refuses a name with a folder in it and removes its temporary file when the write fails', async () => {
  await withTemp(async (dir) => {
    await assert.rejects(writePrivateFileAtomic(dir, '../escape', 'x'), StateDirError);
    await assert.rejects(writePrivateFileAtomic(dir, 'a/b', 'x'), StateDirError);
    await assert.rejects(writePrivateFileAtomic(dir, '..', 'x'), StateDirError);
    // The target is a non-empty directory, so the rename fails after the temporary file was written.
    await mkdir(path.join(dir, 'target'));
    await writeFile(path.join(dir, 'target', 'inner'), 'x');
    await assert.rejects(writePrivateFileAtomic(dir, 'target', 'x'));
    assert.deepEqual(await readdir(dir), ['target']);
  });
});

test('readPrivateFile returns undefined for a missing name and refuses a 0644 file and a symbolic link', async () => {
  await withTemp(async (dir) => {
    assert.equal(await readPrivateFile(dir, 'missing'), undefined);

    const open = path.join(dir, 'open');
    await writeFile(open, 'x', { mode: 0o644 });
    await chmod(open, 0o644);
    await assert.rejects(readPrivateFile(dir, 'open'), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /open to other users/);
      return true;
    });

    const target = path.join(dir, 'target');
    await writeFile(target, 'x', { mode: 0o600 });
    await symlink(target, path.join(dir, 'link'));
    await assert.rejects(readPrivateFile(dir, 'link'), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /symbolic link/);
      return true;
    });
  });
});

test('readPrivateFile takes the relay uid from the same option as prepareStateDir and refuses a file owned by another uid', async () => {
  await withTemp(async (dir) => {
    await writePrivateFileAtomic(dir, 'key.bin', 'payload');
    assert.equal((await readPrivateFile(dir, 'key.bin', { uid: UID }))?.toString(), 'payload');
    await assert.rejects(readPrivateFile(dir, 'key.bin', { uid: UID + 1 }), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /owned by another user/);
      return true;
    });
  });
});

test('under umask 022 the database, its -wal and its -shm file are all 0600 while the store is open', async () => {
  await withTemp(async (root) => {
    await withUmask(0o022, async () => {
      const dir = path.join(root, 'state');
      await prepareStateDir(dir, capture().logger);
      const store = await openSqliteStore(path.join(dir, 'relay.db'));
      try {
        const now = Date.now();
        await store.putTenant({ tenantId: 't1', displayName: 'T1', status: 'active', createdAt: now, updatedAt: now });
        await store.acceptInbound(
          { tenantId: 't1', channel: 'signal', conversationId: 'c', requesterId: 'r', dedupeKey: 'k1', payload: 'hello', receivedAt: now },
          'run-1',
        );
        const names = (await readdir(dir)).sort();
        assert.deepEqual(names, ['relay.db', 'relay.db-shm', 'relay.db-wal']);
        for (const name of names) assert.equal(await modeOf(path.join(dir, name)), 0o600, `${name} is not 0600`);
      } finally {
        await store.close();
      }
    });
  });
});

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runRelay(stateDir: string, until?: (stdout: string) => boolean): { done: Promise<Finished>; stop: () => void } {
  const child = spawn(process.execPath, [BIN], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_STATE_DIR: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let stopped = false;
  const stop = (): void => {
    if (!stopped) {
      stopped = true;
      child.kill('SIGTERM');
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (until?.(stdout)) stop();
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const done = new Promise<Finished>((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { done, stop };
}

function parseLines(stdout: string): Array<Record<string, unknown>> {
  return stdout.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('the relay pointed at /usr exits 1 with relay.start_refused reason state-dir', { skip: NOT_ROOT_ONLY }, async () => {
  const { done } = runRelay('/usr');
  const finished = await done;
  assert.equal(finished.code, 1);
  const lines = parseLines(finished.stdout);
  assert.deepEqual(lines.map((line) => line.event), ['relay.start_refused']);
  assert.equal(lines[0]?.reason, 'state-dir');
  assert.match(String(lines[0]?.detail), /RELAY_STATE_DIR \/usr is owned by uid 0/);
  assert.equal(finished.stderr, '');
});

test('the relay started on a path that does not exist yet creates it 0700 with relay.db 0600 and stops on SIGTERM with exit 0', async () => {
  await withTemp(async (root) => {
    const stateDir = path.join(root, 'fresh', 'state');
    const { done } = runRelay(stateDir, (stdout) => stdout.includes('"relay.listening"'));
    const finished = await done;
    assert.deepEqual({ code: finished.code, signal: finished.signal }, { code: 0, signal: null });
    const events = parseLines(finished.stdout).map((line) => line.event);
    // secrets.loaded and log.pseudonym_key (plan 06) are logged before the relay listens.
    assert.deepEqual(events, ['secrets.loaded', 'log.pseudonym_key', 'relay.listening', 'relay.stopping', 'relay.stopped']);
    const listening = parseLines(finished.stdout).find((line) => line.event === 'relay.listening');
    assert.match(String(listening?.instanceId), /^[0-9a-f-]{36}$/);
    assert.equal(await modeOf(stateDir), 0o700);
    assert.equal(await modeOf(path.join(stateDir, 'relay.db')), 0o600);
    assert.equal(finished.stderr, '');
  });
});

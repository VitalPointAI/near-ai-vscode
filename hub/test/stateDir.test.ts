import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Logger } from '../src/log/logger';
import { Redactor } from '../src/log/redact';
import { prepareStateDir, readPrivateFile, StateDirError, writePrivateFileAtomic } from '../src/stateDir';
import { launchHub, within } from './helpers/hubProcess';

// Phase 32, plan 14 (D-26, D-28), ported from relay/test/stateDir.test.ts: the hub's private state directory. The tests run with a loose umask (022) on purpose: the hub must not
// depend on the umask to keep its directory and files private. The process tests run the built hub with secret files from helpers/hubProcess.

const UID = process.getuid?.() ?? -1;
const IS_ROOT = UID === 0;
const NOT_ROOT_ONLY = IS_ROOT ? 'the test runs as root, which can write anywhere, so a root-owned directory is not foreign here' : false;

async function withTemp<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-statedir-'));
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

test('a directory the hub owns but left open is tightened to 0700 with exactly one state_dir.tightened line', async () => {
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

test('a directory owned by another user is refused with a plain reason naming HUB_STATE_DIR', async (t) => {
  await withTemp(async (root) => {
    const dir = path.join(root, 'state');
    await mkdir(dir, { mode: 0o700 });
    const { logger, lines } = capture();
    await assert.rejects(prepareStateDir(dir, logger, { uid: UID + 1 }), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /HUB_STATE_DIR/);
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
    assert.match(error.message, /HUB_STATE_DIR \/usr is owned by uid 0/);
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
      assert.match(error.message, /HUB_STATE_DIR/);
      assert.match(error.message, /symbolic link/);
      return true;
    });

    const plain = path.join(root, 'plain');
    await writeFile(plain, 'x', { mode: 0o600 });
    await assert.rejects(prepareStateDir(plain, logger), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /HUB_STATE_DIR/);
      assert.match(error.message, /not a directory/);
      return true;
    });

    await symlink('/etc/hostname', path.join(real, 'sneaky'));
    await assert.rejects(prepareStateDir(real, logger), (error: unknown) => {
      assert.ok(error instanceof StateDirError);
      assert.match(error.message, /HUB_STATE_DIR/);
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
    const stale = '.hub.db.0a1b2c3d.tmp';
    await writeFile(path.join(dir, stale), 'half-written state', { mode: 0o600 });
    for (const keep of ['.hub.db.tmp', 'notes.0a1b2c3d.tmp', '.key.0A1B2C3D.tmp']) await writeFile(path.join(dir, keep), 'x', { mode: 0o600 });
    const { logger, lines } = capture();
    await prepareStateDir(dir, logger);
    assert.deepEqual((await readdir(dir)).sort(), ['.hub.db.tmp', '.key.0A1B2C3D.tmp', 'notes.0a1b2c3d.tmp']);
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

test('readPrivateFile takes the hub uid from the same option as prepareStateDir and refuses a file owned by another uid', async () => {
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

test('the hub pointed at /usr exits 1 with hub.start_refused reason state-dir', { skip: NOT_ROOT_ONLY }, async () => {
  const run = launchHub({ stateDir: '/usr' });
  try {
    const exit = await within(run.exited, 10_000, 'the hub refusing /usr');
    assert.equal(exit.code, 1);
    const lines = run.logs();
    assert.deepEqual(lines.map((line) => line.event), ['hub.start_refused']);
    assert.equal(lines[0]?.reason, 'state-dir');
    assert.match(String(lines[0]?.detail), /HUB_STATE_DIR \/usr is owned by uid 0/);
    assert.equal(run.stderr(), '');
  } finally {
    run.cleanup();
  }
});

test('the hub pointed at a symbolic link exits 1 with hub.start_refused reason state-dir and starts nothing', async () => {
  await withTemp(async (root) => {
    const real = path.join(root, 'real');
    await mkdir(real, { mode: 0o700 });
    const link = path.join(root, 'link');
    await symlink(real, link);
    const run = launchHub({ stateDir: link });
    try {
      const exit = await within(run.exited, 10_000, 'the hub refusing a linked state directory');
      assert.equal(exit.code, 1);
      const lines = run.logs();
      assert.deepEqual(lines.map((line) => line.event), ['hub.start_refused']);
      assert.equal(lines[0]?.reason, 'state-dir');
      assert.match(String(lines[0]?.detail), /symbolic link/);
    } finally {
      run.cleanup();
    }
  });
});

test('the hub started on a path that does not exist yet creates it 0700, and SIGTERM on hub.listening stops it with exit 0', async () => {
  await withTemp(async (root) => {
    const stateDir = path.join(root, 'fresh', 'state');
    const run = launchHub({ stateDir });
    try {
      await run.waitForEvent('hub.listening');
      const exit = await within(run.kill('SIGTERM'), 10_000, 'the hub stopping on SIGTERM');
      assert.deepEqual(exit, { code: 0, signal: null });
      assert.deepEqual(run.events(), ['secrets.loaded', 'hub.listening', 'hub.stopping', 'hub.stopped']);
      assert.equal(await modeOf(stateDir), 0o700);
      // D-30: the hub never writes its own keys. Later plans keep their database here, so the check is on content, not on an empty folder.
      const seeds = await Promise.all(
        [run.secretFiles.HUB_SIGNING_KEY, run.secretFiles.HUB_ENCRYPTION_KEY].map(async (file) => (await readFile(file as string, 'utf8')).trim().split(':').pop() as string),
      );
      for (const name of await readdir(stateDir)) {
        const text = await readFile(path.join(stateDir, name), 'latin1').catch(() => '');
        assert.ok(!text.includes('near-ai-hub-signing-key') && !text.includes('near-ai-hub-encryption-key'), `${name} holds a hub key line`);
        for (const seed of seeds) assert.ok(!text.includes(seed), `${name} holds a hub key`);
      }
      assert.equal(run.stderr(), '');
    } finally {
      run.cleanup();
    }
  });
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateKeyFile } from '../src/keys';
import { Redactor } from '../src/log/redact';
import {
  HUB_SECRETS,
  loadSecret,
  loadSecrets,
  MAX_PEM_SECRET_BYTES,
  refusePlainSecretEnv,
  SecretError,
  type SecretSources,
  type SecretSpec,
} from '../src/secrets';
import { hubRoot, launchHub, within } from './helpers/hubProcess';
import { makeTlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 14 (D-26, D-29, D-30), ported from relay/test/secrets.test.ts: every rule of the hub's secret loader. The sources are passed in
// explicitly (an env object and a temporary run-secrets directory), so the host's real /run/secrets and environment are never read. Every value
// is an obviously fake string or a key made for the test.

const LINE: SecretSpec = { name: 'HUB_SIGNING_KEY', kind: 'line', required: true, description: 'test' };
const PEM: SecretSpec = { name: 'HUB_TLS_KEY', kind: 'pem', required: true, description: 'test' };
const NAME = LINE.name;
const FROM_FILE = 'fake-from-explicit-file-11';
const FROM_CREDENTIALS = 'fake-from-credentials-dir-22';
const FROM_RUN = 'fake-from-run-secrets-33';
const IS_ROOT = process.getuid?.() === 0;

interface Dirs {
  root: string;
  credentials: string;
  run: string;
}

async function withDirs<T>(body: (dirs: Dirs) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-secrets-'));
  const dirs = { root, credentials: path.join(root, 'credentials'), run: path.join(root, 'run-secrets') };
  await mkdir(dirs.credentials, { mode: 0o700 });
  await mkdir(dirs.run, { mode: 0o700 });
  try {
    return await body(dirs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function put(file: string, content: string | Buffer, mode = 0o600): Promise<string> {
  await writeFile(file, content);
  await chmod(file, mode);
  return file;
}

function sources(dirs: Dirs, env: Record<string, string> = {}): SecretSources {
  return { env, runSecretsDir: dirs.run };
}

async function refusal(promise: Promise<unknown>): Promise<SecretError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SecretError, `expected a SecretError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the loader to refuse');
}

test('HUB_SECRETS is exactly the TLS pair and the two hub keys, all required, the optional post-quantum key (33.2), and holds no model credential (D-62)', () => {
  assert.deepEqual(HUB_SECRETS.map((spec) => [spec.name, spec.kind, spec.required]), [
    ['HUB_TLS_CERT', 'pem', true],
    ['HUB_TLS_KEY', 'pem', true],
    ['HUB_SIGNING_KEY', 'line', true],
    ['HUB_ENCRYPTION_KEY', 'line', true],
    ['HUB_KEM_KEY', 'line', false],
  ]);
  for (const spec of HUB_SECRETS) {
    assert.ok(spec.description.length > 0);
    assert.ok(!/NEAR_AI|API|MODEL|OPENAI|ANTHROPIC/.test(spec.name), `${spec.name} looks like a model credential`);
  }
});

test('precedence: {NAME}_FILE wins, then CREDENTIALS_DIRECTORY, then the run-secrets directory', async () => {
  await withDirs(async (dirs) => {
    const explicit = await put(path.join(dirs.root, 'explicit'), FROM_FILE);
    await put(path.join(dirs.credentials, NAME.toLowerCase()), FROM_CREDENTIALS);
    await put(path.join(dirs.run, NAME.toLowerCase()), FROM_RUN);
    assert.equal(await loadSecret(LINE, sources(dirs, { [`${NAME}_FILE`]: explicit, CREDENTIALS_DIRECTORY: dirs.credentials })), FROM_FILE);
    assert.equal(await loadSecret(LINE, sources(dirs, { CREDENTIALS_DIRECTORY: dirs.credentials })), FROM_CREDENTIALS);
    assert.equal(await loadSecret(LINE, sources(dirs)), FROM_RUN);
  });
});

test('a CREDENTIALS_DIRECTORY without the file falls through to the run-secrets directory', async () => {
  await withDirs(async (dirs) => {
    await put(path.join(dirs.run, NAME.toLowerCase()), FROM_RUN);
    assert.equal(await loadSecret(LINE, sources(dirs, { CREDENTIALS_DIRECTORY: dirs.credentials })), FROM_RUN);
  });
});

test('a missing secret is undefined, a missing required one throws naming it, and a missing file named by NAME_FILE throws naming NAME_FILE', async () => {
  await withDirs(async (dirs) => {
    assert.equal(await loadSecret(LINE, sources(dirs)), undefined);
    const error = await refusal(loadSecrets([LINE], sources(dirs), new Redactor()));
    assert.equal(error.secretName, NAME);
    assert.match(error.message, /HUB_SIGNING_KEY is required/);
    // The run-secrets file exists, but an explicit path that is wrong must not fall through to it.
    await put(path.join(dirs.run, NAME.toLowerCase()), FROM_RUN);
    const typo = await refusal(loadSecret(LINE, sources(dirs, { [`${NAME}_FILE`]: path.join(dirs.root, 'no-such-file') })));
    assert.match(typo.message, /HUB_SIGNING_KEY_FILE: the file it points to does not exist/);
    assert.ok(!typo.message.includes(FROM_RUN));
  });
});

test('refusePlainSecretEnv refuses each hub secret set as a plain value in any case, ignores empty values and _FILE paths, and never repeats the value', () => {
  const value = 'fake-plain-env-value-44';
  for (const [name, hint] of [
    ['HUB_TLS_CERT', 'HUB_TLS_CERT_FILE'],
    ['HUB_TLS_KEY', 'HUB_TLS_KEY_FILE'],
    ['HUB_SIGNING_KEY', 'HUB_SIGNING_KEY_FILE'],
    ['HUB_ENCRYPTION_KEY', 'HUB_ENCRYPTION_KEY_FILE'],
    ['hub_signing_key', 'HUB_SIGNING_KEY_FILE'],
    ['Hub_Tls_Key', 'HUB_TLS_KEY_FILE'],
  ] as const) {
    assert.throws(
      () => refusePlainSecretEnv({ [name]: value }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError, name);
        assert.equal(error.secretName, name);
        assert.ok(error.message.includes(name));
        assert.ok(!error.message.includes(value), 'the message repeated the value');
        assert.ok(error.message.includes(hint), `${name}: the message names ${hint}`);
        return true;
      },
    );
  }
  assert.doesNotThrow(() => refusePlainSecretEnv({ HUB_SIGNING_KEY: '', HUB_TLS_KEY: '' }));
  assert.doesNotThrow(() => refusePlainSecretEnv({ HUB_TLS_KEY_FILE: '/run/secrets/hub_tls_key', HUB_SIGNING_KEY_FILE: '/x', PATH: '/usr/bin', OTHER_FILE: '/z' }));
  assert.doesNotThrow(() => refusePlainSecretEnv({}));
});

test('a file open to group or others is refused with the chmod hint; 0400 and 0600 load', async () => {
  await withDirs(async (dirs) => {
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      const file = await put(path.join(dirs.root, `m${mode.toString(8)}`), FROM_FILE, mode);
      const error = await refusal(loadSecret(LINE, sources(dirs, { [`${NAME}_FILE`]: file })));
      assert.equal(error.secretName, NAME);
      assert.match(error.message, /group or others/);
      assert.match(error.message, /chmod 600/);
      assert.ok(!error.message.includes(FROM_FILE));
    }
    for (const mode of [0o400, 0o600]) {
      const file = await put(path.join(dirs.root, `ok${mode.toString(8)}`), FROM_FILE, mode);
      assert.equal(await loadSecret(LINE, sources(dirs, { [`${NAME}_FILE`]: file })), FROM_FILE);
    }
  });
});

test('a directory at the secret path, and a symbolic link whose target is a directory, are refused as not a regular file', async () => {
  await withDirs(async (dirs) => {
    const folder = path.join(dirs.root, 'a-folder');
    await mkdir(folder, { mode: 0o700 });
    assert.match((await refusal(loadSecret(LINE, sources(dirs, { [`${NAME}_FILE`]: folder })))).message, /not a regular file/);
    const link = path.join(dirs.root, 'link-to-folder');
    await symlink(folder, link);
    assert.match((await refusal(loadSecret(LINE, sources(dirs, { [`${NAME}_FILE`]: link })))).message, /not a regular file/);
  });
});

test('an empty file, a line secret over 16 KiB, a 7-character value and a line secret with an inner line break are refused, and no message carries the content', async () => {
  await withDirs(async (dirs) => {
    const cases: [string, string | Buffer, RegExp][] = [
      ['empty', '', /empty/],
      ['big', Buffer.alloc(16385, 'a'), /larger than 16384/],
      ['short', 'seven77\n', /shorter than 8/],
      ['inner', 'fake-first-line\nfake-second-line\n', /line break/],
      ['innercr', 'fake-first-line\rfake-second-line', /line break/],
      ['doublenewline', 'fake-value-5566\n\n', /line break/],
    ];
    for (const [label, content, pattern] of cases) {
      const file = await put(path.join(dirs.root, label), content);
      const error = await refusal(loadSecret(LINE, sources(dirs, { [`${NAME}_FILE`]: file })));
      assert.match(error.message, pattern, label);
      assert.equal(error.secretName, NAME);
      for (const fragment of ['seven77', 'fake-first-line', 'fake-second-line', 'fake-value-5566']) {
        assert.ok(!error.message.includes(fragment), `${label}: the message carried file content`);
      }
    }
  });
});

test('a PEM file with line breaks loads unchanged; a PEM secret that does not start with -----BEGIN is refused', async () => {
  const tls = makeTlsFixture();
  try {
    await withDirs(async (dirs) => {
      assert.ok(tls.keyPem.split('\n').length > 3, 'the fixture key spans several lines');
      assert.equal(await loadSecret(PEM, sources(dirs, { HUB_TLS_KEY_FILE: tls.keyFile })), tls.keyPem);
      const bad = await put(path.join(dirs.root, 'not-pem'), 'fake-not-a-pem-file\nsecond-line-value\n');
      const error = await refusal(loadSecret(PEM, sources(dirs, { HUB_TLS_KEY_FILE: bad })));
      assert.match(error.message, /not a PEM file/);
      assert.ok(!error.message.includes('fake-not-a-pem') && !error.message.includes('second-line'));
    });
  } finally {
    tls.cleanup();
  }
});

test('a PEM file of exactly 64 KiB loads and one of 64 KiB plus one byte is refused', async () => {
  await withDirs(async (dirs) => {
    const head = '-----BEGIN CERTIFICATE-----\n';
    const exact = await put(path.join(dirs.root, 'exact'), head + 'A'.repeat(MAX_PEM_SECRET_BYTES - head.length));
    assert.equal((await loadSecret(PEM, sources(dirs, { HUB_TLS_KEY_FILE: exact })))?.length, MAX_PEM_SECRET_BYTES);
    const over = await put(path.join(dirs.root, 'over'), head + 'A'.repeat(MAX_PEM_SECRET_BYTES - head.length + 1));
    assert.match((await refusal(loadSecret(PEM, sources(dirs, { HUB_TLS_KEY_FILE: over })))).message, /larger than 65536 bytes/);
  });
});

test('one trailing LF or CRLF is stripped from a line secret and the value is otherwise unchanged', async () => {
  await withDirs(async (dirs) => {
    for (const ending of ['\n', '\r\n', '']) {
      const file = await put(path.join(dirs.root, `end${ending.length}`), `value-1234${ending}`);
      assert.equal(await loadSecret(LINE, sources(dirs, { [`${NAME}_FILE`]: file })), 'value-1234');
    }
  });
});

test('a file the hub cannot read (mode 0000) in CREDENTIALS_DIRECTORY stops with the cannot-read message even though run-secrets holds a valid file', async (t) => {
  if (IS_ROOT) {
    t.skip('running as root: root can read a 0000 file, so the refusal cannot be shown here');
    return;
  }
  await withDirs(async (dirs) => {
    await put(path.join(dirs.credentials, NAME.toLowerCase()), FROM_CREDENTIALS, 0o000);
    await put(path.join(dirs.run, NAME.toLowerCase()), FROM_RUN);
    const error = await refusal(loadSecret(LINE, sources(dirs, { CREDENTIALS_DIRECTORY: dirs.credentials })));
    assert.match(error.message, /cannot read it/);
    assert.match(error.message, /uid \d+/);
    assert.ok(!error.message.includes(FROM_RUN) && !error.message.includes(FROM_CREDENTIALS));
  });
});

test('a symbolic link to a valid 0600 file loads, and a symbolic link to a file open to others is refused', async () => {
  await withDirs(async (dirs) => {
    const target = await put(path.join(dirs.root, 'target'), FROM_FILE);
    await symlink(target, path.join(dirs.run, NAME.toLowerCase()));
    assert.equal(await loadSecret(LINE, sources(dirs)), FROM_FILE);
    const open = await put(path.join(dirs.root, 'open'), FROM_FILE, 0o644);
    const link = path.join(dirs.root, 'link-open');
    await symlink(open, link);
    assert.match((await refusal(loadSecret(LINE, sources(dirs, { [`${NAME}_FILE`]: link })))).message, /group or others/);
  });
});

// G540: on Kubernetes the kubelet writes Secret files owned by root and, under the pod's fsGroup, at least 0440, so the chart (deploy/hub) cannot
// give the hub an owner-only Secret file. Its init container runs deploy/hub/files/stage-secrets.cjs with the hub image's Node to copy them into a
// memory volume. This runs that file on a folder laid out the way the kubelet lays out a Secret volume, under the names the chart's HUB_*_FILE
// settings use, and loads the result with the real loader.
test('G540: the chart\'s key files as the kubelet writes them (0440) are refused, and the copies its init container makes are 0400, ours, and load', async () => {
  const repo = path.dirname(hubRoot());
  const template = readFileSync(path.join(repo, 'deploy/hub/templates/statefulset.yaml'), 'utf8');
  const script = readFileSync(path.join(repo, 'deploy/hub/files/stage-secrets.cjs'), 'utf8');
  const folder = '/run/secrets/hub/';
  const settings = new Map([...template.matchAll(/\{ name: (HUB_[A-Z_]+_FILE), value: (\S+) \}/g)].map(([, name, value]) => [name!, value!]));
  for (const spec of HUB_SECRETS.filter((entry) => entry.required)) assert.ok(settings.has(`${spec.name}_FILE`), `the chart does not set ${spec.name}_FILE`);
  for (const [name, value] of settings) assert.ok(value.startsWith(folder) && !value.slice(folder.length).includes('/'), `${name} = ${value}`);
  const tls = makeTlsFixture();
  try {
    await withDirs(async (dirs) => {
      const values: Record<string, string> = {
        HUB_TLS_CERT: tls.certPem,
        HUB_TLS_KEY: tls.keyPem,
        HUB_SIGNING_KEY: generateKeyFile('signing'),
        HUB_ENCRYPTION_KEY: generateKeyFile('encryption'),
      };
      // The Secret volume: the files in a timestamped folder, ..data pointing at it, and each name a link through ..data.
      const volume = path.join(dirs.root, 'secret-volume');
      const data = path.join(volume, '..2026_11_25_00_00_00.000000001');
      await mkdir(data, { recursive: true });
      await symlink(path.basename(data), path.join(volume, '..data'));
      for (const [name, file] of settings) {
        const value = values[name.slice(0, -'_FILE'.length)];
        assert.ok(value !== undefined, `no test value for ${name}`);
        await put(path.join(data, path.basename(file)), value.startsWith('-----') ? value : `${value}\n`, 0o440);
        await symlink(path.join('..data', path.basename(file)), path.join(volume, path.basename(file)));
      }
      const envIn = (dir: string) => Object.fromEntries([...settings].map(([name, file]) => [name, path.join(dir, path.basename(file))]));

      const refused = await refusal(loadSecrets(HUB_SECRETS, sources(dirs, envIn(volume)), new Redactor()));
      assert.match(refused.message, /group or others/);

      // node -e <file> <Secret volume> <memory volume>, twice: a pod whose init container runs again finds its earlier copies.
      const staged = path.join(dirs.root, 'staged');
      await mkdir(staged, { mode: 0o700 });
      for (let run = 0; run < 2; run += 1) {
        const result = spawnSync(process.execPath, ['-e', script, volume, staged], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
      assert.deepEqual((await readdir(staged)).sort(), [...settings.values()].map((file) => path.basename(file)).sort());
      for (const file of await readdir(staged)) {
        const info = await lstat(path.join(staged, file));
        assert.ok(info.isFile(), `${file} is a regular file, not a link`);
        assert.equal(info.mode & 0o777, 0o400, `${file} is owner-only`);
        assert.equal(info.uid, process.getuid?.(), `${file} belongs to the user that ran the copy`);
      }
      const loaded = await loadSecrets(HUB_SECRETS, sources(dirs, envIn(staged)), new Redactor());
      assert.deepEqual(Object.fromEntries(loaded), values);
    });
  } finally {
    tls.cleanup();
  }
});

test('loadSecrets registers every value with the redactor: the whole value, the key part of a key line and each line of a PEM key', async () => {
  const tls = makeTlsFixture();
  try {
    await withDirs(async (dirs) => {
      const keyLine = generateKeyFile('signing');
      const keyFile = await put(path.join(dirs.root, 'signing'), `${keyLine}\n`);
      const redactor = new Redactor();
      const loaded = await loadSecrets([LINE, PEM], sources(dirs, { HUB_SIGNING_KEY_FILE: keyFile, HUB_TLS_KEY_FILE: tls.keyFile }), redactor);
      assert.deepEqual([...loaded.keys()], ['HUB_SIGNING_KEY', 'HUB_TLS_KEY']);
      const seed = keyLine.slice(keyLine.lastIndexOf(':') + 1);
      assert.equal(redactor.text(`a ${keyLine} b`), 'a [secret:HUB_SIGNING_KEY] b');
      assert.equal(redactor.text(`seed ${seed} only`), 'seed [secret:HUB_SIGNING_KEY] only');
      const bodyLine = tls.keyPem.split('\n').find((line) => line.length >= 16 && !line.startsWith('-----')) as string;
      assert.equal(redactor.text(`one line ${bodyLine} of the key`), 'one line [secret:HUB_TLS_KEY] of the key');
      assert.ok(!redactor.text(tls.keyPem).includes(bodyLine));
    });
  } finally {
    tls.cleanup();
  }
});

test('the built hub refuses HUB_SIGNING_KEY set as a plain value, and a missing HUB_TLS_KEY_FILE, naming the setting and never the value', async () => {
  const value = 'fake-plain-signing-value-77';
  const plain = launchHub({ env: { HUB_SIGNING_KEY: value } });
  const missing = launchHub({ env: { HUB_TLS_KEY_FILE: '/nonexistent/near-ai-hub-test/hub_tls_key' } });
  try {
    const [plainExit, missingExit] = await within(Promise.all([plain.exited, missing.exited]), 10_000, 'the hub refusing its secrets');
    assert.equal(plainExit.code, 1);
    const plainLines = plain.logs();
    assert.deepEqual(plainLines.map((line) => line.event), ['hub.start_refused']);
    assert.equal(plainLines[0]?.reason, 'secrets');
    assert.match(String(plainLines[0]?.detail), /HUB_SIGNING_KEY is set as a plain environment value/);
    assert.ok(!plain.stdout().includes(value), 'the plain value was echoed');

    assert.equal(missingExit.code, 1);
    const missingLines = missing.logs();
    assert.deepEqual(missingLines.map((line) => line.event), ['hub.start_refused']);
    assert.equal(missingLines[0]?.reason, 'secrets');
    assert.match(String(missingLines[0]?.detail), /HUB_TLS_KEY_FILE: the file it points to does not exist/);
    assert.equal(plain.stderr() + missing.stderr(), '');
  } finally {
    plain.cleanup();
    missing.cleanup();
  }
});

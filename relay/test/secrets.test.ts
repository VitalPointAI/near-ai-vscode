import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Redactor } from '../src/log/redact';
import {
  loadSecret,
  loadSecrets,
  refusePlainSecretEnv,
  RELAY_SECRETS,
  SECRET_CLASSES,
  SecretError,
  TENANT_KEY_NAME,
  type SecretSources,
  type SecretSpec,
} from '../src/secrets';

// Phase 68, plan 06 (RELAY-04, D-08, D-09, D-10): every rule of the secret loader. The sources are passed in explicitly (an env object and a
// temporary run-secrets directory), so the host's real /run/secrets and environment are never read. Every value is an obviously fake string.

const NAME = 'TEAMS_APP_SECRET';
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
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-relay-secrets-'));
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

test('precedence: {NAME}_FILE wins, then CREDENTIALS_DIRECTORY, then the run-secrets directory', async () => {
  await withDirs(async (dirs) => {
    const explicit = await put(path.join(dirs.root, 'explicit'), FROM_FILE);
    await put(path.join(dirs.credentials, NAME.toLowerCase()), FROM_CREDENTIALS);
    await put(path.join(dirs.run, NAME.toLowerCase()), FROM_RUN);

    const all = sources(dirs, { [`${NAME}_FILE`]: explicit, CREDENTIALS_DIRECTORY: dirs.credentials });
    assert.equal(await loadSecret(NAME, all), FROM_FILE);

    const noExplicit = sources(dirs, { CREDENTIALS_DIRECTORY: dirs.credentials });
    assert.equal(await loadSecret(NAME, noExplicit), FROM_CREDENTIALS);

    assert.equal(await loadSecret(NAME, sources(dirs)), FROM_RUN);
  });
});

test('a CREDENTIALS_DIRECTORY without the file falls through to the run-secrets directory', async () => {
  await withDirs(async (dirs) => {
    await put(path.join(dirs.run, NAME.toLowerCase()), FROM_RUN);
    assert.equal(await loadSecret(NAME, sources(dirs, { CREDENTIALS_DIRECTORY: dirs.credentials })), FROM_RUN);
  });
});

test('a missing optional secret is undefined, a missing required one throws naming it, and a typo in {NAME}_FILE throws naming {NAME}_FILE', async () => {
  await withDirs(async (dirs) => {
    assert.equal(await loadSecret(NAME, sources(dirs)), undefined);

    const required: SecretSpec[] = [{ name: NAME, secretClass: 'teams-bot-secret', required: true }];
    const error = await refusal(loadSecrets(required, sources(dirs), new Redactor()));
    assert.equal(error.secretName, NAME);
    assert.match(error.message, /TEAMS_APP_SECRET is required/);

    // The run-secrets file exists, but an explicit path that is wrong must not fall through to it.
    await put(path.join(dirs.run, NAME.toLowerCase()), FROM_RUN);
    const typo = await refusal(loadSecret(NAME, sources(dirs, { [`${NAME}_FILE`]: path.join(dirs.root, 'no-such-file') })));
    assert.match(typo.message, /TEAMS_APP_SECRET_FILE/);
    assert.ok(!typo.message.includes(FROM_RUN));
  });
});

test('refusePlainSecretEnv refuses a plain secret and a plain tenant key, ignores empty values and _FILE names, and never repeats the value', () => {
  const value = 'fake-plain-env-value-44';
  for (const name of ['TEAMS_APP_SECRET', 'LOG_PSEUDONYM_KEY', 'NEAR_AI_KEY_X', 'NEAR_AI_KEY_TEAM_2']) {
    assert.throws(
      () => refusePlainSecretEnv({ [name]: value }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.secretName, name);
        assert.ok(error.message.includes(name));
        assert.ok(!error.message.includes(value), 'the message repeated the value');
        assert.match(error.message, new RegExp(`${name}_FILE`));
        return true;
      },
    );
  }
  assert.doesNotThrow(() => refusePlainSecretEnv({ TEAMS_APP_SECRET: '', NEAR_AI_KEY_X: '' }));
  assert.doesNotThrow(() => refusePlainSecretEnv({ NEAR_AI_KEY_X_FILE: '/run/secrets/near_ai_key_x', TEAMS_APP_SECRET_FILE: '/x', PATH: '/usr/bin' }));
  assert.doesNotThrow(() => refusePlainSecretEnv({}));
  assert.ok(TENANT_KEY_NAME.test('NEAR_AI_KEY_ACME') && !TENANT_KEY_NAME.test('NEAR_AI_KEY_') && !TENANT_KEY_NAME.test('near_ai_key_acme'));
});

test('a file open to group or others is refused with the chmod hint (0640 and 0604); 0400 and 0600 load', async () => {
  await withDirs(async (dirs) => {
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      const file = await put(path.join(dirs.root, `m${mode.toString(8)}`), FROM_FILE, mode);
      const error = await refusal(loadSecret(NAME, sources(dirs, { [`${NAME}_FILE`]: file })));
      assert.equal(error.secretName, NAME);
      assert.match(error.message, /group or others/);
      assert.match(error.message, /chmod 600/);
      assert.ok(!error.message.includes(FROM_FILE));
    }
    for (const mode of [0o400, 0o600]) {
      const file = await put(path.join(dirs.root, `ok${mode.toString(8)}`), FROM_FILE, mode);
      assert.equal(await loadSecret(NAME, sources(dirs, { [`${NAME}_FILE`]: file })), FROM_FILE);
    }
  });
});

test('a directory at the secret path is refused as not a regular file', async () => {
  await withDirs(async (dirs) => {
    const folder = path.join(dirs.root, 'a-folder');
    await mkdir(folder, { mode: 0o700 });
    const error = await refusal(loadSecret(NAME, sources(dirs, { [`${NAME}_FILE`]: folder })));
    assert.match(error.message, /not a regular file/);
  });
});

test('an empty file, a file over 16 KiB, a 7-character value and a value with an inner line break are refused, and no message carries the content', async () => {
  await withDirs(async (dirs) => {
    const cases: [string, string | Buffer, RegExp][] = [
      ['empty', '', /empty/],
      ['big', Buffer.alloc(16385, 'a'), /larger than 16384/],
      ['short', 'seven77\n', /shorter than 8/],
      ['onlynewline', '\n', /shorter than 8/],
      ['inner', 'fake-first-line\nfake-second-line\n', /line break/],
      ['innercr', 'fake-first-line\rfake-second-line', /line break/],
      ['doublenewline', 'fake-value-5566\n\n', /line break/],
    ];
    for (const [label, content, pattern] of cases) {
      const file = await put(path.join(dirs.root, label), content);
      const error = await refusal(loadSecret(NAME, sources(dirs, { [`${NAME}_FILE`]: file })));
      assert.match(error.message, pattern, label);
      assert.equal(error.secretName, NAME);
      for (const fragment of ['seven77', 'fake-first-line', 'fake-second-line', 'fake-value-5566']) {
        assert.ok(!error.message.includes(fragment), `${label}: the message carried file content`);
      }
    }
  });
});

test('a file of exactly 16384 bytes loads', async () => {
  await withDirs(async (dirs) => {
    const file = await put(path.join(dirs.root, 'limit'), Buffer.alloc(16384, 'b'));
    const value = await loadSecret(NAME, sources(dirs, { [`${NAME}_FILE`]: file }));
    assert.equal(value?.length, 16384);
  });
});

test('one trailing LF or CRLF is stripped and the value is otherwise unchanged', async () => {
  await withDirs(async (dirs) => {
    for (const ending of ['\n', '\r\n', '']) {
      const file = await put(path.join(dirs.root, `end${ending.length}`), `value-1234${ending}`);
      assert.equal(await loadSecret(NAME, sources(dirs, { [`${NAME}_FILE`]: file })), 'value-1234');
    }
  });
});

test('a file the relay cannot read (mode 0000) in CREDENTIALS_DIRECTORY stops with the cannot-read message even though run-secrets holds a valid file', async (t) => {
  if (IS_ROOT) {
    t.skip('running as root: root can read a 0000 file, so Pitfall 11 cannot be shown here');
    return;
  }
  await withDirs(async (dirs) => {
    await put(path.join(dirs.credentials, NAME.toLowerCase()), FROM_CREDENTIALS, 0o000);
    await put(path.join(dirs.run, NAME.toLowerCase()), FROM_RUN);
    const error = await refusal(loadSecret(NAME, sources(dirs, { CREDENTIALS_DIRECTORY: dirs.credentials })));
    assert.equal(error.secretName, NAME);
    assert.match(error.message, /cannot read it/);
    assert.match(error.message, /uid \d+/);
    assert.match(error.message, /0400 or 0600/);
    assert.ok(!error.message.includes(FROM_RUN) && !error.message.includes(FROM_CREDENTIALS));
  });
});

test('a symbolic link to a valid 0600 file loads (the target is checked through the opened descriptor)', async () => {
  await withDirs(async (dirs) => {
    const target = await put(path.join(dirs.root, 'target'), FROM_FILE);
    await symlink(target, path.join(dirs.run, NAME.toLowerCase()));
    assert.equal(await loadSecret(NAME, sources(dirs)), FROM_FILE);
  });
});

test('a symbolic link to a file open to others is refused', async () => {
  await withDirs(async (dirs) => {
    const target = await put(path.join(dirs.root, 'target'), FROM_FILE, 0o644);
    await symlink(target, path.join(dirs.run, NAME.toLowerCase()));
    const error = await refusal(loadSecret(NAME, sources(dirs)));
    assert.match(error.message, /group or others/);
  });
});

test('loadSecrets registers every value with the redactor, so text containing it shows [secret:NAME]', async () => {
  await withDirs(async (dirs) => {
    const file = await put(path.join(dirs.root, 'teams'), FROM_FILE);
    const redactor = new Redactor();
    const loaded = await loadSecrets(RELAY_SECRETS, sources(dirs, { [`${NAME}_FILE`]: file }), redactor);
    assert.deepEqual([...loaded.keys()], [NAME]);
    assert.equal(loaded.get(NAME), FROM_FILE);
    const masked = redactor.text(`header ${FROM_FILE} trailer`);
    assert.equal(masked, 'header [secret:TEAMS_APP_SECRET] trailer');
    assert.ok(!masked.includes(FROM_FILE));
  });
});

test('SECRET_CLASSES has exactly the four classes, signal-registration is held by the sidecar volume, and none is required in Phase 68', () => {
  assert.deepEqual(Object.keys(SECRET_CLASSES).sort(), ['log-pseudonym-key', 'signal-registration', 'teams-bot-secret', 'tenant-near-ai-key']);
  assert.equal(SECRET_CLASSES['signal-registration'].source, 'sidecar-volume');
  assert.equal(SECRET_CLASSES['teams-bot-secret'].source, 'file');
  for (const info of Object.values(SECRET_CLASSES)) assert.ok(info.description.length > 0);
  assert.deepEqual(RELAY_SECRETS.map((spec) => [spec.name, spec.secretClass, spec.required]), [
    ['TEAMS_APP_SECRET', 'teams-bot-secret', false],
    ['LOG_PSEUDONYM_KEY', 'log-pseudonym-key', false],
  ]);
});

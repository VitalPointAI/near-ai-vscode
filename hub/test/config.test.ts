import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, HUB_SETTINGS, loadConfig } from '../src/config';
import { launchHub, within } from './helpers/hubProcess';

// Phase 32, plan 14 (D-26): the hub reads a closed list of settings. A typo, a relative state directory, a port out of range or a host with a space
// stops startup with one hub.start_refused line that names the setting and never repeats its value.

const DEFAULTS = { stateDir: '/var/lib/near-ai-hub-default' };

function refusedFor(env: NodeJS.ProcessEnv, variable: string): ConfigError {
  try {
    loadConfig(env, DEFAULTS);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
    assert.equal(error.variable, variable);
    assert.ok(error.message.includes(variable));
    return error;
  }
  assert.fail(`expected ${variable} to be refused`);
}

test('the defaults: host 127.0.0.1, port 8443, the default state directory, no public address', () => {
  assert.deepEqual(loadConfig({}, DEFAULTS), {
    host: '127.0.0.1',
    port: 8443,
    stateDir: DEFAULTS.stateDir,
    publicAddress: undefined,
    organizationPolicy: undefined,
    organizationKey: undefined,
  });
  assert.deepEqual([...HUB_SETTINGS], ['HUB_HOST', 'HUB_PORT', 'HUB_STATE_DIR', 'HUB_PUBLIC_ADDRESS', 'HUB_ORGANIZATION_POLICY', 'HUB_ORGANIZATION_KEY']);
});

test('valid settings are read, an empty HUB_PUBLIC_ADDRESS means not set, and the NAME_FILE settings of the hub secrets are accepted', () => {
  const config = loadConfig(
    {
      HUB_HOST: '0.0.0.0',
      HUB_PORT: '0',
      HUB_STATE_DIR: '/srv/hub/state',
      HUB_PUBLIC_ADDRESS: 'hub.example.org:8443',
      HUB_TLS_CERT_FILE: '/run/secrets/hub_tls_cert',
      HUB_TLS_KEY_FILE: '/run/secrets/hub_tls_key',
      HUB_SIGNING_KEY_FILE: '/run/secrets/hub_signing_key',
      HUB_ENCRYPTION_KEY_FILE: '/run/secrets/hub_encryption_key',
      PATH: '/usr/bin',
    },
    DEFAULTS,
  );
  assert.deepEqual(config, {
    host: '0.0.0.0',
    port: 0,
    stateDir: '/srv/hub/state',
    publicAddress: 'hub.example.org:8443',
    organizationPolicy: undefined,
    organizationKey: undefined,
  });
  assert.equal(loadConfig({ HUB_PUBLIC_ADDRESS: '' }, DEFAULTS).publicAddress, undefined);
  // A plain secret is the secret loader's to refuse, with its own sentence, so the config reader leaves it alone.
  assert.doesNotThrow(() => loadConfig({ HUB_SIGNING_KEY: 'fake-plain-value-1234' }, DEFAULTS));
});

test('an unknown HUB_ name, a relative HUB_STATE_DIR, a port over 65535, a malformed port, a host with a space and a bad public address are refused without their values', () => {
  const cases: [NodeJS.ProcessEnv, string, string][] = [
    [{ HUB_COLOUR: 'blue-value-xyz' }, 'HUB_COLOUR', 'blue-value-xyz'],
    [{ HUB_STATE_DIRECTORY: '/srv/typo-xyz' }, 'HUB_STATE_DIRECTORY', 'typo-xyz'],
    [{ HUB_TLS_KEY_PATH: '/run/secrets/x-xyz' }, 'HUB_TLS_KEY_PATH', 'x-xyz'],
    [{ HUB_STATE_DIR: 'relative/dir-xyz' }, 'HUB_STATE_DIR', 'dir-xyz'],
    [{ HUB_PORT: '65536' }, 'HUB_PORT', '65536'],
    [{ HUB_PORT: 'abc-xyz' }, 'HUB_PORT', 'abc-xyz'],
    [{ HUB_PORT: '-1' }, 'HUB_PORT', '-1'],
    [{ HUB_HOST: 'bad host-xyz' }, 'HUB_HOST', 'host-xyz'],
    [{ HUB_HOST: '' }, 'HUB_HOST', 'unused-marker-xyz'],
    [{ HUB_PUBLIC_ADDRESS: 'https://hub-xyz.example.org' }, 'HUB_PUBLIC_ADDRESS', 'hub-xyz'],
  ];
  for (const [env, variable, value] of cases) {
    const error = refusedFor(env, variable);
    assert.ok(!error.message.includes(value), `${variable}: the message repeated the value`);
  }
});

test('each refused setting stops the built hub with exit 1 and one hub.start_refused line naming it, never its value', async () => {
  const cases: [Record<string, string>, string, string][] = [
    [{ HUB_COLOUR: 'blue-value-xyz' }, 'HUB_COLOUR', 'blue-value-xyz'],
    [{ HUB_STATE_DIR: 'relative/dir-xyz' }, 'HUB_STATE_DIR', 'dir-xyz'],
    [{ HUB_PORT: '70000' }, 'HUB_PORT', '70000'],
    [{ HUB_HOST: 'bad host-xyz' }, 'HUB_HOST', 'host-xyz'],
  ];
  await Promise.all(
    cases.map(async ([env, variable, value]) => {
      const run = launchHub({ env });
      try {
        const exit = await within(run.exited, 10_000, `the hub refusing ${variable}`);
        assert.equal(exit.code, 1, variable);
        const lines = run.logs();
        assert.deepEqual(lines.map((line) => line.event), ['hub.start_refused'], variable);
        assert.equal(lines[0]?.reason, 'config');
        assert.equal(lines[0]?.level, 'error');
        assert.match(String(lines[0]?.detail), new RegExp(variable));
        assert.ok(!run.stdout().includes(value), `${variable}: the refused value was echoed into the log`);
        assert.equal(run.stderr(), '');
      } finally {
        run.cleanup();
      }
    }),
  );
});

test('71-09: your organization\'s rules file and key are read; a relative rules path and a malformed key are refused without their values', () => {
  const key = 'A'.repeat(43);
  const config = loadConfig({ HUB_ORGANIZATION_POLICY: '/srv/hub/organization.near-org-rules', HUB_ORGANIZATION_KEY: key }, DEFAULTS);
  assert.equal(config.organizationPolicy, '/srv/hub/organization.near-org-rules');
  assert.equal(config.organizationKey, key);
  assert.equal(loadConfig({ HUB_ORGANIZATION_POLICY: '', HUB_ORGANIZATION_KEY: '' }, DEFAULTS).organizationPolicy, undefined);
  const relative = refusedFor({ HUB_ORGANIZATION_POLICY: 'rules/fictional-secret-path' }, 'HUB_ORGANIZATION_POLICY');
  assert.ok(!relative.message.includes('fictional-secret-path'));
  const bad = refusedFor({ HUB_ORGANIZATION_KEY: 'not-a-key-fictional' }, 'HUB_ORGANIZATION_KEY');
  assert.ok(!bad.message.includes('not-a-key-fictional'));
});

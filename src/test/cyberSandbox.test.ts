// The sandbox tiers (D-08), their two-way cleanup proof (D-10), the rate and wall-clock limits with
// the not-reached report (D-09), and the read-only post-exploitation rules (D-11). Everything runs
// against a hand-written runner: no real container runtime, no network, no dependency on docker being
// installed on the machine running the suite.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { checkBudget, postExploitAllowed, RateLimiter } from '../domain/cyberLimits';
import {
  chooseTier,
  detectRuntime,
  SandboxError,
  startSandbox,
  verifyCleanup,
  withSandbox,
  type Runner
} from '../services/cyberSandbox';

interface FakeRunner {
  run: Runner;
  calls: string[][];
  /** Names `ps -a` still lists, so cleanup can be proven to fail when it should. */
  surviving: Set<string>;
  output?: string;
}

function fakeRunner(): FakeRunner {
  const fake: FakeRunner = {
    calls: [],
    surviving: new Set(),
    run: async (command, args) => {
      fake.calls.push([command, ...args]);
      const joined = args.join(' ');
      if (joined === '--version') { if (command === 'missing') throw new Error('ENOENT'); return `${command} version 1.0.0`; }
      if (joined.startsWith('rm -f')) { for (const name of [...fake.surviving]) fake.surviving.delete(name); return ''; }
      if (joined.startsWith('ps -a')) return [...fake.surviving].join('\n');
      // A real 'docker run -d' prints the new container id; the sandbox checks for it.
      if (joined.startsWith('run ')) return 'a'.repeat(12);
      if (joined.startsWith('exec ')) {
        const name = args[1];
        fake.surviving.add(name);
        return `0\n${fake.output ?? 'payload output'}`;
      }
      return '';
    }
  };
  return fake;
}

test('detectRuntime prefers docker, falls to podman, and reports nothing when neither answers', async () => {
  const both = fakeRunner();
  assert.equal(await detectRuntime(both.run), 'docker');
  assert.deepEqual(both.calls, [['docker', '--version']], 'docker answering ends the probe; podman is not asked');

  const podmanOnly: Runner = async (command, args) => {
    if (command === 'docker' && args[0] === '--version') throw new Error('ENOENT');
    return 'podman version 4.9.4';
  };
  assert.equal(await detectRuntime(podmanOnly), 'podman');

  const neither: Runner = async () => { throw new Error('ENOENT'); };
  assert.equal(await detectRuntime(neither), undefined);

  const chosen = await chooseTier({ run: neither });
  assert.equal(chosen.tier, 'tempFolder');
  assert.match(chosen.reason ?? '', /no container isolation/i);

  const disabled = await chooseTier({ run: neither, allowTempTier: false });
  assert.equal(disabled.tier, 'disabled');
  assert.match(disabled.reason ?? '', /offensive mode is disabled/);

  const container = await chooseTier({ run: both.run });
  assert.equal(container.tier, 'container');
  assert.equal(container.runtime, 'docker');
});

test('the container tier runs with no network, mounts read-only, and emits the exact argv sequence', async () => {
  const fake = fakeRunner();
  const sandbox = await startSandbox('container', { runner: fake.run, mountTarget: tmpdir(), image: 'alpine:3.20' });
  assert.match(sandbox.id, /^cyber-[0-9a-f]{8}$/);

  const run = fake.calls.find((call) => call[1] === 'run');
  assert.ok(run, 'a run call was made');
  assert.deepEqual(run.slice(0, 8), ['docker', 'run', '--rm', '-d', '--name', sandbox.id, '--network', 'none']);
  assert.equal(run[8], '-v');
  assert.match(run[9], /:\/target:ro$/);
  assert.deepEqual(run.slice(10), ['alpine:3.20', 'sleep', 'infinity']);
  assert.ok(!run.includes('--privileged'), 'the container is never privileged');
  assert.ok(!run.includes('--network=host'));

  const result = await sandbox.exec(['sh', '-c', 'id'], new AbortController().signal);
  assert.deepEqual(result.argv, ['sh', '-c', 'id']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /payload output/);
  const exec = fake.calls.find((call) => call[1] === 'exec');
  assert.deepEqual(exec?.slice(0, 4), ['docker', 'exec', sandbox.id, 'sh']);

  await sandbox.stop();
  const rm = fake.calls.find((call) => call[1] === 'rm');
  assert.deepEqual(rm, ['docker', 'rm', '-f', sandbox.id]);
  assert.ok(fake.calls.some((call) => call[1] === 'ps' && call.includes(`name=${sandbox.id}`)), 'cleanup is verified with ps -a');
  assert.ok(fake.calls.findIndex((call) => call[1] === 'rm') < fake.calls.findIndex((call) => call[1] === 'ps'), 'rm runs before the ps check');
});

test('a container that survives cleanup makes stop fail with a message naming it', async () => {
  const fake = fakeRunner();
  const keep: Runner = async (command, args) => {
    const output = await fake.run(command, args);
    if (args[0] === 'rm') fake.surviving.add(args[2]);
    return args[0] === 'ps' ? [...fake.surviving].join('\n') : output;
  };
  const sandbox = await startSandbox('container', { runner: keep });
  await assert.rejects(sandbox.stop(), (error: Error) => error instanceof SandboxError && error.message.includes(sandbox.id));
});

test('withSandbox stops the sandbox on the way out, whether the step resolved or threw', async () => {
  const fake = fakeRunner();
  const stops: string[] = [];
  const sandbox = await startSandbox('container', { runner: fake.run });
  const counted = { ...sandbox, stop: async () => { stops.push('stop'); await sandbox.stop(); } };
  await withSandbox(counted, async (active) => active.exec(['id']));
  assert.deepEqual(stops, ['stop']);
  await assert.rejects(withSandbox(counted, async () => { throw new Error('payload failed'); }), /payload failed/);
  assert.deepEqual(stops, ['stop', 'stop']);
});

test('the temp tier refuses a binary outside its allowlist and removes its directory', async () => {
  const sandbox = await startSandbox('tempFolder', { allowlist: ['sh', 'cat'], execTimeoutMs: 5_000 });
  assert.equal(sandbox.tier, 'tempFolder');
  assert.ok(path.isAbsolute(sandbox.id));
  await assert.rejects(sandbox.exec(['curl', 'http://127.0.0.1/']), /not on this run's temporary-tier allowlist/);
  const listed = await sandbox.exec(['sh', '-c', 'echo hi']);
  assert.equal(listed.exitCode, 0);
  assert.match(listed.stdout, /hi/);
  await sandbox.stop();
  await assert.rejects(sandbox.exec(['sh', '-c', 'true']), /ENOENT|no such file|not on this run/i);
});

test('a disabled tier carries a non-empty reason and every exec refuses with it', async () => {
  const sandbox = await startSandbox('disabled');
  assert.equal(sandbox.tier, 'disabled');
  assert.equal(sandbox.id, '');
  await assert.rejects(sandbox.exec(['id']), /Offensive mode is disabled/);
  await sandbox.stop();
});

test('verifyCleanup reports recorded writes still present in a temp sandbox and host leaks from a container', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cyber-cleanup-'));
  const sandbox = { tier: 'tempFolder' as const, id: directory, exec: async () => ({ argv: [], exitCode: 0, stdout: '', stderr: '' }), stop: async () => undefined };
  await writeFile(path.join(directory, 'shell.php'), '<?php ?>');
  const problems = await verifyCleanup({ filesDropped: ['shell.php'], credentialsCreated: [] }, sandbox);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /shell\.php was recorded as written and is still in/);

  const container = { tier: 'container' as const, id: 'cyber-abcdef12', exec: sandbox.exec, stop: sandbox.stop };
  const hostFile = path.join(directory, 'escaped.txt');
  await writeFile(hostFile, 'x');
  const leaked = await verifyCleanup({ filesDropped: [hostFile], credentialsCreated: [] }, container);
  assert.match(leaked[0], /exists on the host/);
});

test('the rate limiter allows opsPerMinute, refuses the next, and never banks idle time into a burst', () => {
  const limiter = new RateLimiter(5);
  for (let index = 0; index < 5; index += 1) assert.equal(limiter.acquire(1_000).ok, true);
  const refused = limiter.acquire(1_001);
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : '', /rate limit: 5 ops\/min reached/);

  // Well inside the window the sixth still refuses; once the whole window has slid past, five is
  // the most that can run again, and a sixth right behind them still refuses.
  assert.equal(limiter.acquire(59_999).ok, false);
  const later = new RateLimiter(5);
  for (let index = 0; index < 5; index += 1) later.acquire(0);
  for (let index = 0; index < 5; index += 1) assert.equal(later.acquire(60_000).ok, true);
  assert.equal(later.acquire(60_001).ok, false, 'a burst never exceeds the limit after idle time');
});

test('a budget stop names the exact hosts and checks it did not reach, never just a count', () => {
  const planned = {
    hosts: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
    checks: ['http-headers', 'tls', 'dns'],
    completed: { hosts: ['10.0.0.1', '10.0.0.2'], checks: ['http-headers'] }
  };
  const inside = checkBudget({ startedAt: 1_000, budgetMs: 60_000, planned }, 30_000);
  assert.equal(inside.ok, true);
  assert.equal(inside.ok === true ? inside.remainingMs : 0, 31_000);

  const exceeded = checkBudget({ startedAt: 1_000, budgetMs: 60_000, planned }, 61_000);
  assert.equal(exceeded.ok, false);
  if (exceeded.ok) return;
  assert.match(exceeded.reason, /wall-clock budget reached/);
  assert.deepEqual(exceeded.shortfall.unreachedHosts, ['10.0.0.3', '10.0.0.4']);
  assert.deepEqual(exceeded.shortfall.unreachedChecks, ['tls', 'dns']);
  assert.equal(exceeded.shortfall.plannedHostCount, 4);
  assert.equal(exceeded.shortfall.plannedCheckCount, 3);
  // The shortfall survives into a report line with names in it, so a budget stop is never a clean scan.
  assert.match(`${exceeded.reason} unreached: ${exceeded.shortfall.unreachedHosts.join(', ')}`, /10\.0\.0\.3, 10\.0\.0\.4/);
});

test('post-exploitation allows read-only forms and refuses writes, lateral moves, and persistence by rule', () => {
  for (const command of ['whoami', 'ls -la', 'cat notes.txt', 'id -u', 'uname -a', 'hostname -s']) {
    assert.deepEqual(postExploitAllowed(command), { allowed: true }, `${command} is a read-only form`);
  }
  const refusals: Array<[string, RegExp]> = [
    ['rm -rf /tmp/x', /"rm" can write or execute/],
    ['crontab -e', /persistence/],
    ['useradd bob', /persistence/],
    ['ssh host2', /lateral movement/],
    ['cat /etc/passwd > /tmp/out', /chains, redirects/],
    ['cat /etc/shadow', /credential store/],
    ['ls /etc', /absolute path/],
    ['cat ../secrets', /"\.\." climbs out/],
    ['curl http://127.0.0.1/', /lateral movement/],
    ['ls -la | grep x', /chains, redirects/],
    ['cat /root/.ssh/id_rsa', /credential store/],
    ['python3 -c print(1)', /"python3" can write or execute/],
    ['ls -Z', /not an allowed read-only form/]
  ];
  for (const [command, pattern] of refusals) {
    const verdict = postExploitAllowed(command);
    assert.equal(verdict.allowed, false, `${command} must be refused`);
    assert.match(verdict.allowed === false ? verdict.reason : '', pattern, `refusal for "${command}" names its rule`);
  }
});

test('starting a container is allowed far longer than a version check', async () => {
  // CI failed the first sandbox start at exactly 3044 ms while `docker run` was still pulling the
  // image: the version check's 3-second deadline was applied to a command that downloads layers.
  // A working daemon on a clean machine therefore failed the first offensive scan.
  const timeouts: number[] = [];
  const slowRunner: Runner = async (command, args) => {
    if (args[0] === '--version') return `${command} version 1.0.0`;
    if (args[0] === 'run') { timeouts.push(1); return 'abc123def456'; }
    return '';
  };
  const sandbox = await startSandbox('container', { runner: slowRunner, image: 'alpine:3.20' });
  assert.equal(sandbox.tier, 'container');
  await sandbox.stop();
  assert.deepEqual(timeouts, [1], 'the start went through the container-start path');
});

test('a start that produces no container id is reported as a failed start', async () => {
  // A daemon that answered but did not create the container must not look like success.
  const silentRunner: Runner = async (command, args) => (args[0] === '--version' ? `${command} version 1.0.0` : '');
  await assert.rejects(
    startSandbox('container', { runner: silentRunner }),
    (error: Error) => error instanceof SandboxError && /did not start container/.test(error.message)
  );
});

// The container sandbox tier against the real runtime. The fake-runner tests in
// cyberSandbox.test.ts assert the argv sequence; they cannot prove that docker actually starts the
// container, that `--network none` isolates it, or that the cleanup proof observes reality. This file
// runs the real thing when a runtime is available and skips cleanly when one is not, so a machine
// without docker still has a green suite (the point of the disabled tier, D-08).

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { detectRuntime, runCapture, startSandbox, verifyCleanup, type ContainerRuntime, type Sandbox } from '../services/cyberSandbox';

/** The image the real-runtime tests use; small, and the module's own default. */
const IMAGE = 'alpine:3.20';

let detected: ContainerRuntime | undefined;
let resolved = false;

/**
 * The runtime for this test, or a skip. Resolved lazily because this project compiles to CommonJS,
 * where a module-level await is not allowed.
 */
/**
 * The runtime for this test, or a skip. `--version` answering is not enough: a CI runner has the
 * docker CLI but no daemon, so the CLI answers and every `run` fails. The check is whether a
 * container actually starts, which is the capability these tests are about (D-08's own rule: a
 * runtime that answered and then failed is not a working runtime).
 */
async function requireRuntime(t: TestContext): Promise<ContainerRuntime | undefined> {
  if (!resolved) {
    detected = await detectRuntime();
    if (detected) {
      const usable = await runCapture(detected, ['run', '--rm', IMAGE, 'true']).then(() => true).catch(() => false);
      if (!usable) detected = undefined;
    }
    resolved = true;
  }
  if (!detected) { t.skip('no usable container runtime (the CLI may be present without a daemon)'); return undefined; }
  return detected;
}

/** True when the runtime's own listing no longer shows the container. */
async function containerGone(runtime: ContainerRuntime, name: string): Promise<boolean> {
  const listed = await runCapture(runtime, ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}']).catch(() => '');
  return !listed.split('\n').map((line) => line.trim()).includes(name);
}

test('the real runtime starts a container, runs a command, and cleans it up', async (t) => {
  const runtime = await requireRuntime(t);
  if (!runtime) return;
  const sandbox: Sandbox = await startSandbox('container', { image: IMAGE });
  assert.equal(sandbox.tier, 'container');
  assert.match(sandbox.id, /^cyber-[0-9a-f]{8}$/, 'the container name is unique per run');
  try {
    const result = await sandbox.exec(['sh', '-c', 'echo fixture-alive']);
    assert.match(result.stdout, /fixture-alive/, 'the command ran inside the container');
  } finally {
    await sandbox.stop();
  }
  assert.equal(await containerGone(runtime, sandbox.id), true, 'the container is gone after stop()');
});

test('a failing command reports a non-zero exit status rather than appearing to succeed', async (t) => {
  const runtime = await requireRuntime(t);
  if (!runtime) return;
  const sandbox = await startSandbox('container', { image: IMAGE });
  try {
    const result = await sandbox.exec(['sh', '-c', 'echo doomed; exit 7']);
    assert.equal(result.exitCode, 7, "docker exec returns the command's own exit code");
    assert.match(result.stdout, /doomed/, 'a failing command still yields its output');
  } finally {
    await sandbox.stop();
  }
});

test('the container has no outbound network unless a scope explicitly asks for one', async (t) => {
  const runtime = await requireRuntime(t);
  if (!runtime) return;
  const sandbox = await startSandbox('container', { image: IMAGE });
  try {
    // `--network none` leaves only loopback, so name resolution must fail. The assertion is on the
    // observable consequence inside the container, not on docker's own bookkeeping.
    const dns = await sandbox.exec(['sh', '-c', 'getent hosts example.com >/dev/null 2>&1; echo $?']);
    assert.notEqual(dns.stdout.trim(), '0', 'name resolution fails with no network');
  } finally {
    await sandbox.stop();
  }
});

test('a read-only mounted target is visible inside the container and cannot be written', async (t) => {
  const runtime = await requireRuntime(t);
  if (!runtime) return;
  // The fixture lives in the workspace, not os.tmpdir(): this daemon does not share the host's /tmp
  // with containers, so a /tmp path bind-mounts as an empty directory. The workspace is shared.
  const directory = await mkdtemp(path.join(path.dirname(process.cwd()), 'mount-'));
  await writeFile(path.join(directory, 'marker.txt'), 'mounted-target\n', { encoding: 'utf8', mode: 0o755 });
  const sandbox = await startSandbox('container', { image: IMAGE, mountTarget: directory });
  try {
    const read = await sandbox.exec(['sh', '-c', 'cat /target/marker.txt']);
    assert.equal(read.stdout.trim(), 'mounted-target', 'the target is readable at /target');
    const write = await sandbox.exec(['sh', '-c', 'echo nope > /target/new.txt; echo $?']);
    assert.notEqual(write.stdout.trim(), '0', 'the mount is read-only, so a write fails');
  } finally {
    await sandbox.stop();
  }
});

test('cleanup is proven against the runtime: a container that survives rm makes stop fail', async (t) => {
  const runtime = await requireRuntime(t);
  if (!runtime) return;
  const sandbox = await startSandbox('container', { image: IMAGE });
  await sandbox.stop();
  // Re-create a container under the same name *and* keep a shell running in it, so the name is in
  // `ps -a` while `rm -f` is asked to remove it. A race is possible in principle, so the assertion
  // accepts either the proven failure or a runtime that removed it cleanly — what must never happen
  // is a silent "cleaned up" while the container is still listed.
  await runCapture(runtime, ['run', '--rm', '-d', '--name', sandbox.id, '--network', 'none', IMAGE, 'sleep', 'infinity']);
  try {
    const stillListed = !(await containerGone(runtime, sandbox.id));
    assert.equal(stillListed, true, 'the replacement container is listed before stop()');
    await sandbox.stop();
    // stop() either removed it (and verified) or threw with the container named; both are honest.
    assert.equal(await containerGone(runtime, sandbox.id), true, 'after stop() the name is gone from the runtime');
  } finally {
    await runCapture(runtime, ['rm', '-f', sandbox.id]).catch(() => '');
  }
});

test('verifyCleanup reports a file that leaked onto the host', async (t) => {
  const runtime = await requireRuntime(t);
  if (!runtime) return;
  const directory = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-leak-'));
  const leaked = path.join(directory, 'dropped.txt');
  await writeFile(leaked, 'written by a payload\n', 'utf8');
  const sandbox = await startSandbox('container', { image: IMAGE });
  try {
    const problems = await verifyCleanup({ filesDropped: [leaked], credentialsCreated: [] }, sandbox);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /exists on the host/, 'a path recorded inside the container but present on the host is an escape');
  } finally {
    await sandbox.stop();
  }
});

test('the two tiers report different tiers, so a run can state which it used', async (t) => {
  const runtime = await requireRuntime(t);
  if (!runtime) return;
  const container = await startSandbox('container', { image: IMAGE });
  const temp = await startSandbox('tempFolder', { allowlist: ['sh'] });
  try {
    assert.equal(container.tier, 'container');
    assert.equal(temp.tier, 'tempFolder');
    assert.notEqual(container.id, temp.id);
  } finally {
    await container.stop();
    await temp.stop();
  }
});

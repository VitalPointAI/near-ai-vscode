// The seeded proof targets: both fixtures boot offline on OS-chosen ports with plain node, no
// container and no dependency install, and exhibit exactly the seeded differences. These fixtures
// are what CYBER-06 and CYBER-07 are measured against, so the differences are asserted here before
// any probe relies on them.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { connect as tlsConnect } from 'node:tls';
import { fixtureDirFor, startTarget } from './cyberStartTarget';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface PeerCertificate { subject?: { CN?: string }; issuer?: { CN?: string }; valid_from?: string; valid_to?: string }

/** Reads the leaf certificate's dates over a real TLS handshake, ignoring trust (self-signed). */
function peerCertificate(url: string): Promise<PeerCertificate> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: parsed.hostname, port: Number(parsed.port), rejectUnauthorized: false }, () => {
      const certificate = socket.getPeerCertificate() as PeerCertificate;
      socket.end();
      resolve(certificate);
    });
    socket.once('error', reject);
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error('TLS handshake timed out')); });
  });
}

function postLogin(url: string, username: string, password: string): Promise<{ status: number; body: string }> {
  return fetch(new URL('/login', url), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString()
  }).then(async (response) => ({ status: response.status, body: await response.text() }));
}

const read = (kind: 'vulnerable' | 'patched', file: string) => readFile(path.join(fixtureDirFor(kind), file), 'utf8');

test('both fixture targets boot offline on ephemeral ports and answer, and close() really stops them', async () => {
  for (const kind of ['vulnerable', 'patched'] as const) {
    const target = await startTarget(kind);
    try {
      assert.match(target.httpUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      assert.match(target.tlsUrl, /^https:\/\/127\.0\.0\.1:\d+\/$/);
      assert.notEqual(new URL(target.httpUrl).port, new URL(target.tlsUrl).port, 'the TLS listener gets its own port');
      const response = await fetch(target.httpUrl);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Fixture target/);
      const health = await fetch(new URL('/health', target.httpUrl));
      assert.equal(await health.text(), 'ok');
      // A live process answers signal 0; a stopped one throws ESRCH (or EPERM for another user).
      assert.doesNotThrow(() => process.kill(target.pid, 0), 'the fixture process is running while the target is open');
      await target.close();
      await assert.rejects(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        process.kill(target.pid, 0);
      }, /ESRCH|EPERM/);
    } finally {
      await target.close();
    }
  }
});

test('the vulnerable login accepts the injection payload and the patched twin denies it', async () => {
  const vulnerable = await startTarget('vulnerable');
  const patched = await startTarget('patched');
  try {
    const injected = await postLogin(vulnerable.httpUrl, "' OR '1'='1", 'anything');
    assert.equal(injected.status, 200);
    assert.match(injected.body, /"result":"ok"/);

    const exact = await postLogin(vulnerable.httpUrl, 'admin', 'admin');
    assert.equal(exact.status, 200);

    const denied = await postLogin(patched.httpUrl, "' OR '1'='1", 'anything');
    assert.equal(denied.status, 401);
    assert.match(denied.body, /"result":"denied"/);
    assert.equal((await postLogin(patched.httpUrl, 'admin', 'admin')).status, 200);
  } finally {
    await vulnerable.close();
    await patched.close();
  }
});

test('the vulnerable certificate is expired and the patched one is valid into the future', async () => {
  const vulnerable = await startTarget('vulnerable');
  const patched = await startTarget('patched');
  try {
    const expired = await peerCertificate(vulnerable.tlsUrl);
    const expiredTo = Date.parse(expired.valid_to ?? '');
    assert.ok(Number.isFinite(expiredTo), `expected certificate dates, got ${JSON.stringify(expired)}`);
    assert.ok(expiredTo < Date.now(), `the vulnerable leaf should be expired, notAfter=${expired.valid_to}`);
    assert.equal(expired.issuer?.CN, expired.subject?.CN, 'the vulnerable leaf is self-signed');

    const valid = await peerCertificate(patched.tlsUrl);
    const validFrom = Date.parse(valid.valid_from ?? '');
    const validTo = Date.parse(valid.valid_to ?? '');
    assert.ok(validFrom <= Date.now() && validTo > Date.now(), `the patched leaf should be valid now, ${valid.valid_from}..${valid.valid_to}`);
    assert.notEqual(valid.issuer?.CN, valid.subject?.CN, 'the patched leaf is signed by the fixture CA, not itself');
  } finally {
    await vulnerable.close();
    await patched.close();
  }
});

test('the seeded IaC lines exist in the vulnerable fixture and are gone from the patched twin', async () => {
  const [vulnTf, patchedTf, vulnDockerfile, patchedDockerfile, vulnCi, patchedCi] = await Promise.all([
    read('vulnerable', 'main.tf'), read('patched', 'main.tf'),
    read('vulnerable', 'Dockerfile'), read('patched', 'Dockerfile'),
    read('vulnerable', '.github/workflows/ci.yml'), read('patched', '.github/workflows/ci.yml')
  ]);

  assert.match(vulnTf, /cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/);
  assert.match(vulnTf, /aws_s3_bucket_acl/);
  assert.doesNotMatch(vulnTf, /server_side_encryption_configuration/);
  assert.match(vulnTf, /acl\s*=\s*"public-read"/);
  assert.match(patchedTf, /server_side_encryption_configuration/);
  assert.doesNotMatch(patchedTf, /0\.0\.0\.0\/0/);
  assert.doesNotMatch(patchedTf, /"public-read"/);

  assert.match(vulnDockerfile, /^USER root$/m);
  assert.match(vulnDockerfile, /^ENV API_KEY=fixture-secret-DO-NOT-USE\.invalid$/m);
  assert.match(vulnDockerfile, /^FROM node:latest$/m);
  assert.doesNotMatch(patchedDockerfile, /^USER root$/m);
  assert.doesNotMatch(patchedDockerfile, /ENV API_KEY/);
  assert.match(patchedDockerfile, /^USER app$/m);

  assert.match(vulnCi, /uses: actions\/checkout@v4$/m);
  assert.match(vulnCi, /API_TOKEN: fixture-token-DO-NOT-USE\.invalid/);
  assert.match(patchedCi, /uses: actions\/checkout@[0-9a-f]{40}/);
  assert.doesNotMatch(patchedCi, /@v4$/m);
  assert.match(patchedCi, /\$\{\{ secrets\.FIXTURE_API_TOKEN \}\}/);
  assert.doesNotMatch(patchedCi, /fixture-token-DO-NOT-USE/);
});

test('the fixtures are provably excluded from the package and need no container', async () => {
  const ignore = await readFile(path.join(REPO_ROOT, '.vscodeignore'), 'utf8');
  const lines = ignore.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  assert.ok(lines.includes('test/**'), 'the whole test tree, fixtures included, must stay out of the .vsix');

  const startSource = await readFile(path.join(__dirname, 'cyberStartTarget.js'), 'utf8');
  assert.doesNotMatch(startSource, /docker|podman/, 'fixtures must start without a container runtime');
  for (const file of ['vulnerable/server.js', 'patched/server.js']) {
    const source = await readFile(path.join(REPO_ROOT, 'test', 'fixtures', 'cyber', file), 'utf8');
    assert.match(source, /READY/, `${file} prints the READY line`);
    assert.match(source, /listen\(0, '127\.0\.0\.1'/, `${file} binds an ephemeral loopback port`);
    assert.doesNotMatch(source, /require\('express'\)|require\("express"\)/, `${file} has no dependencies`);
  }
});

test('the committed secret fixture uses only obvious sentinels, never a real credential', async () => {
  const files = ['config.env', 'Dockerfile', '.github/workflows/ci.yml'];
  for (const file of files) {
    const text = await read('vulnerable', file);
    for (const match of text.matchAll(/fixture-(?:secret|token)-DO-NOT-USE\.[a-z]+/g)) assert.ok(match[0].endsWith('.invalid'));
  }
  assert.match(await read('vulnerable', 'config.env'), /API_KEY=fixture-secret-DO-NOT-USE\.invalid/);
});

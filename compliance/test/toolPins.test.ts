// The CI tool pins stay well formed (D-04, D-47): every tool is fetched by exact version over https and checked by a
// SHA-256 kept in the repository before anything is extracted. This test is offline; it never downloads or runs a tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ci');

interface ToolPin {
  version: string;
  url: string;
  sha256: string;
  checksumUrl: string;
  archive: string;
  bin: string;
  java?: string;
}

const pins = JSON.parse(readFileSync(path.join(CI_DIR, 'tool-pins.json'), 'utf8')) as Record<string, ToolPin>;
const installer = readFileSync(path.join(CI_DIR, 'install-tool.sh'), 'utf8');
// Shell lines without comments, so a word in a comment can neither satisfy nor break a check.
const installerCode = installer
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ALLOWED_HOSTS = new Set(['repo1.maven.org', 'github.com']);
const ARCHIVES = new Set(['zip', 'tar.gz']);

test('exactly the three CI binaries are pinned: oscal-cli, syft and grype', () => {
  assert.deepEqual(Object.keys(pins).sort(), ['grype', 'oscal-cli', 'syft']);
});

test('every tool has a semantic version, an https address on Maven Central or GitHub, a 64-hex SHA-256 and a known archive kind', () => {
  for (const [name, pin] of Object.entries(pins)) {
    assert.match(pin.version, SEMVER, `${name}: version`);
    for (const key of ['url', 'checksumUrl'] as const) {
      const address = new URL(pin[key]);
      assert.equal(address.protocol, 'https:', `${name}: ${key} protocol`);
      assert.ok(ALLOWED_HOSTS.has(address.hostname), `${name}: ${key} host ${address.hostname}`);
      assert.ok(address.pathname.includes(pin.version), `${name}: ${key} names the pinned version`);
    }
    assert.match(pin.sha256, SHA256, `${name}: sha256`);
    assert.ok(ARCHIVES.has(pin.archive), `${name}: archive ${pin.archive}`);
    assert.ok(pin.url.endsWith(pin.archive === 'zip' ? '.zip' : '.tar.gz'), `${name}: address matches the archive kind`);
    assert.match(pin.bin, /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, `${name}: bin is a plain relative path`);
  }
});

test('oscal-cli is 3.2.0 from Maven Central, on Java 11 or later, with the hash read on 2026-11-21', () => {
  const pin = pins['oscal-cli'];
  assert.equal(pin.version, '3.2.0');
  assert.equal(
    pin.url,
    'https://repo1.maven.org/maven2/dev/metaschema/oscal/oscal-cli-enhanced/3.2.0/oscal-cli-enhanced-3.2.0-oscal-cli.zip'
  );
  assert.equal(pin.checksumUrl, `${pin.url}.sha256`);
  assert.equal(pin.sha256, 'e001b353ee245da6f4ff0ad930c4dfaa88083c63243ca004bd5f5bcef44e8ec8');
  assert.equal(pin.archive, 'zip');
  assert.equal(pin.bin, 'bin/oscal-cli');
  assert.equal(pin.java, '>=11');
});

test('the installer checks the hash with sha256sum --check before any extract command', () => {
  const check = installerCode.indexOf('sha256sum --check');
  assert.ok(check >= 0, 'sha256sum --check is present');
  assert.match(installerCode, /sha256sum --check --strict/);
  const extracts = [...installerCode.matchAll(/\bunzip\b|\btar\s+-x/g)].map((m) => m.index ?? -1);
  assert.ok(extracts.length >= 2, 'both archive kinds are extracted');
  for (const at of extracts) assert.ok(at > check, `extract at ${at} comes after the hash check at ${check}`);
});

test('the installer downloads over https only and never pipes anything into a shell or node', () => {
  assert.match(installerCode, /curl [^\n]*--fail/);
  assert.match(installerCode, /--proto =https/);
  assert.match(installerCode, /--proto-redir =https/);
  assert.doesNotMatch(installerCode, /\|\s*(sudo\s+)?(sh|bash|zsh|dash|node|python3?)\b/);
  assert.doesNotMatch(installerCode, /\b(eval|source)\b/);
  assert.doesNotMatch(installerCode, /<\(\s*curl/);
});

test('the installer reads the address and hash for the named tool from tool-pins.json', () => {
  assert.match(installerCode, /tool-pins\.json/);
  assert.match(installerCode, /^set -eu$/m);
  assert.match(installer, /^#!\/bin\/sh$/m);
});

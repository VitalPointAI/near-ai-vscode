// The CI tool pins stay well formed (D-04, D-47): every tool is fetched by exact version over https and checked by a
// SHA-256 kept in the repository before anything is extracted. This test is offline; it never downloads or runs a tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ci');

interface Asset {
  url: string;
  sha256: string;
  checksumUrl?: string;
}

interface ToolPin {
  version: string;
  url: string;
  sha256: string;
  checksumUrl?: string;
  archive: string;
  bin?: string;
  java?: string;
  scope?: string;
  pinKind?: string;
  commit?: string;
  tree?: string;
  tarSha256?: string;
  assets?: Asset[];
}

const pins = JSON.parse(readFileSync(path.join(CI_DIR, 'tool-pins.json'), 'utf8')) as Record<string, ToolPin>;
const installer = readFileSync(path.join(CI_DIR, 'install-tool.sh'), 'utf8');
// Shell lines without comments, so a word in a comment can neither satisfy nor break a check.
const installerCode = installer
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

// x.y or x.y.z, with an optional +build suffix (RKE2's 1.37.2+rke2r1; PostgreSQL's 18.7).
const VERSION = /^\d+\.\d+(\.\d+)?(\+[0-9A-Za-z.]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ALLOWED_HOSTS = new Set(['repo1.maven.org', 'github.com', 'get.helm.sh', 'download.postgresql.org']);
const ARCHIVES = new Set(['zip', 'tar.gz', 'binary', 'file']);
const PLAIN_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const httpsOnAllowedHost = (name: string, key: string, value: string) => {
  const address = new URL(value);
  assert.equal(address.protocol, 'https:', `${name}: ${key} protocol`);
  assert.ok(ALLOWED_HOSTS.has(address.hostname), `${name}: ${key} host ${address.hostname}`);
  return address;
};

test('the pinned tools are exactly the CI binaries and the deployment stack downloads', () => {
  assert.deepEqual(Object.keys(pins).sort(), ['cosign', 'grype', 'hauler', 'helm', 'kms-pkcs11', 'oscal-cli', 'postgresql', 'rke2', 'softhsm2', 'syft']);
});

test('syft is 1.57.2 and grype is 0.122.1, linux amd64 tarballs from their immutable GitHub releases', () => {
  const expected = {
    syft: { version: '1.57.2', sha256: 'ad92bd3ec1b94a3df01d4d0aec199afa9c42b72e86da436ff5f837914d32706b' },
    grype: { version: '0.122.1', sha256: 'f1ba7e2917ee1395618de20a98da0aa7c0fb1788927797651047c50502a37538' }
  } as const;
  for (const [name, want] of Object.entries(expected)) {
    const pin = pins[name];
    const release = `https://github.com/anchore/${name}/releases/download/v${want.version}/`;
    assert.equal(pin.version, want.version, `${name}: version`);
    assert.equal(pin.url, `${release}${name}_${want.version}_linux_amd64.tar.gz`, `${name}: url`);
    assert.equal(pin.checksumUrl, `${release}${name}_${want.version}_checksums.txt`, `${name}: checksums file`);
    assert.equal(pin.sha256, want.sha256, `${name}: sha256`);
    assert.equal(pin.archive, 'tar.gz');
    assert.equal(pin.bin, name);
  }
});

test('every tool has an exact version, https addresses on an allowed host, 64-hex SHA-256 values and a known archive kind', () => {
  for (const [name, pin] of Object.entries(pins)) {
    assert.match(pin.version, VERSION, `${name}: version`);
    const url = httpsOnAllowedHost(name, 'url', pin.url);
    assert.match(pin.sha256, SHA256, `${name}: sha256`);
    if (pin.pinKind === 'commit') {
      // No publisher checksum exists (SoftHSM2): the pin is the commit and its tree, reproducible offline with git archive. Test scope only.
      assert.equal(pin.scope, 'test', `${name}: a commit pin is test scope only`);
      assert.equal(pin.checksumUrl, undefined, `${name}: a commit pin has no publisher checksum to name`);
      assert.match(pin.commit ?? '', COMMIT, `${name}: commit`);
      assert.match(pin.tree ?? '', COMMIT, `${name}: tree`);
      assert.match(pin.tarSha256 ?? '', SHA256, `${name}: tarSha256`);
      assert.ok(url.pathname.endsWith(`/archive/${pin.commit}.tar.gz`), `${name}: url is the archive of the pinned commit`);
    } else {
      assert.equal(pin.pinKind, undefined, `${name}: pinKind`);
      assert.ok(decodeURIComponent(url.pathname).includes(pin.version), `${name}: url names the pinned version`);
      const checksum = httpsOnAllowedHost(name, 'checksumUrl', pin.checksumUrl ?? '');
      // A yum repository's metadata names the major version in its path, not the full version.
      const named = checksum.pathname.endsWith('/repodata/repomd.xml') ? `/${pin.version.split('.')[0]}/` : pin.version;
      assert.ok(decodeURIComponent(checksum.pathname).includes(named), `${name}: checksumUrl names the pinned version`);
    }
    assert.ok(ARCHIVES.has(pin.archive), `${name}: archive ${pin.archive}`);
    if (pin.archive === 'zip' || pin.archive === 'tar.gz') assert.ok(pin.url.endsWith(`.${pin.archive}`), `${name}: address matches the archive kind`);
    if (pin.archive === 'binary') assert.doesNotMatch(pin.url, /\.(zip|tar\.gz|tgz|tar|rpm)$/, `${name}: a binary pin is a bare executable`);
    if (pin.archive === 'file') assert.equal(pin.bin, undefined, `${name}: a file pin is placed as-is, with no bin`);
    else assert.match(pin.bin ?? '', pin.archive === 'binary' ? /^[A-Za-z0-9._-]+$/ : PLAIN_PATH, `${name}: bin is a plain relative path`);
    for (const [index, asset] of (pin.assets ?? []).entries()) {
      httpsOnAllowedHost(name, `assets[${index}].url`, asset.url);
      assert.match(asset.sha256, SHA256, `${name}: assets[${index}].sha256`);
      if (asset.checksumUrl !== undefined) httpsOnAllowedHost(name, `assets[${index}].checksumUrl`, asset.checksumUrl);
    }
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

// Trestle (D-04): installed in CI with --require-hashes --no-deps, so every wheel must be listed, pinned and hashed.
const requirements = readFileSync(path.join(CI_DIR, 'trestle-requirements.txt'), 'utf8');
const requirementLines = requirements
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));
const REQUIREMENT = /^([a-z0-9]+(?:-[a-z0-9]+)*)==([A-Za-z0-9.]+)((?:\s+--hash=sha256:[0-9a-f]{64})+)$/;

test('every non-comment line of trestle-requirements.txt is name==version with at least one --hash=sha256: of 64 hex', () => {
  assert.ok(requirementLines.length >= 10, 'the transitive wheels are listed, not only Trestle');
  for (const line of requirementLines) {
    assert.match(line, REQUIREMENT, line);
    assert.match(line, /--hash=sha256:[0-9a-f]{64}/, line);
  }
  assert.doesNotMatch(requirements, /\\\s*$/m, 'no line continuations that could hide a line from this check');
});

test('trestle-requirements.txt pins owner-approved compliance-trestle 5.2.1 once, lists each package once, with no markers, extras or options', () => {
  assert.equal(requirementLines.filter((line) => line.startsWith('compliance-trestle==')).length, 1);
  assert.ok(requirementLines.includes(
    'compliance-trestle==5.2.1 --hash=sha256:4f870ba0d98b89f7196ae275daa522d990753e4aeaad26d8651237cc7d6a5479'
  ));
  const names = requirementLines.map((line) => line.split('==')[0]);
  assert.equal(new Set(names).size, names.length, 'no package is listed twice');
  for (const line of requirementLines) assert.doesNotMatch(line, /[;[\]@]|^-|\s-[^-]|--(?!hash=)/, line);
  for (const needed of ['pydantic', 'pydantic-core', 'cryptography', 'paramiko', 'ruamel-yaml', 'securesystemslib']) {
    assert.ok(names.includes(needed), `${needed} is pinned`);
  }
});

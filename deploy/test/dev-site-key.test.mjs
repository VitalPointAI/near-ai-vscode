// The owner's development site key script, deploy/keys/new-dev-site-key.sh (48.1-22, owner decision a). Runs the script with fake
// softhsm2-util, pkcs11-tool, script, stty, apt-get and sudo (deploy/test/fixtures/fake-pkcs11) in temporary folders only: PATH holds just those
// fakes and links to a few base utilities, so no real token tool or package manager can be reached, and HOME is a temporary folder too.
// Checks: the key is made inside the token and checked sensitive and never extractable; only the PEM public key and the PKCS#11 URI
// are printed; no PIN is on any command line, in any file or in the output; it refuses without a terminal; a second run creates nothing
// and checks the existing private key; --rotate archives by moving and never removes. The fake pkcs11-tool fails the PIN prompt unless it
// runs under the (fake) script, as OpenSC does without a terminal; dev-site-key-softhsm.test.mjs runs the real tools on a real terminal.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'deploy/keys/new-dev-site-key.sh');
const FAKES = path.join(ROOT, 'deploy/test/fixtures/fake-pkcs11');
const SO_PIN = 'so-pin-7391';
const USER_PIN = 'user-pin-5528';
/** What the owner types for a new token: the SO PIN twice and the user PIN twice (softhsm2-util), then the user PIN (pkcs11-tool). */
const PINS = `${SO_PIN}\n${SO_PIN}\n${USER_PIN}\n${USER_PIN}\n${USER_PIN}\n`;
const UTILITIES = ['sh', 'cat', 'mkdir', 'chmod', 'mv', 'cp', 'date', 'base64', 'tr', 'fold', 'awk', 'grep', 'sed', 'id', 'dirname', 'basename', 'ls', 'wc', 'head',
  'mktemp', 'rm', 'rmdir'];
const fixtureKey = (name) => readFileSync(path.join(FAKES, `key-${name}.spki.b64`), 'utf8').trim();

/** A temporary sandbox: bin (base utilities, plus the fake token tools when installed), a fake home, and the sterling-signing folder. */
function sandbox({ installed = true, packageManager = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dev-site-key-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  // The script's temporary folder is a sibling of the fake home, so it never contains the owner's folder.
  const temp = path.join(root, 'tmp');
  const base = path.join(temp, 'sterling-signing');
  for (const dir of [bin, home, temp, base]) mkdirSync(dir);
  for (const name of UTILITIES) {
    const found = ['/usr/bin', '/bin'].map((dir) => path.join(dir, name)).find((file) => existsSync(file));
    assert.ok(found, `base utility ${name}`);
    symlinkSync(found, path.join(bin, name));
  }
  symlinkSync(path.join(FAKES, 'tools', 'stty'), path.join(bin, 'stty'));
  const module = path.join(root, 'libsofthsm2.so');
  if (installed) {
    for (const tool of ['softhsm2-util', 'pkcs11-tool', 'script']) symlinkSync(path.join(FAKES, 'tools', tool), path.join(bin, tool));
    writeFileSync(module, '');
  }
  const log = path.join(root, 'calls.log');
  const env = {
    PATH: packageManager ? `${path.join(FAKES, 'pkg')}:${bin}` : bin,
    HOME: home,
    TMPDIR: temp,
    LC_ALL: 'C',
    FAKE_LOG: log,
    FAKE_FIXTURES: FAKES,
    FAKE_INSTALL_BIN: bin,
    FAKE_KEY: 'a',
    STERLING_PKCS11_MODULE: module,
    SOFTHSM2_CONF: path.join(base, 'softhsm', 'softhsm2.conf'),
  };
  const run = (args, input = '', extra = {}) => spawnSync('/bin/sh', [SCRIPT, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('|')) : []);
  return { root, home, temp, base, module, env, run, calls };
}

/** Every file under a folder, as paths relative to it. */
function files(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(dir, entry.name), rel) : [rel];
  });
}

/** The printed lines split into the PEM block and the rest. */
function printed(stdout) {
  const lines = stdout.trimEnd().split('\n');
  const end = lines.indexOf('-----END PUBLIC KEY-----');
  return { pem: `${lines.slice(0, end + 1).join('\n')}\n`, rest: lines.slice(end + 1), first: lines[0] };
}

const spkiOf = (pem) => createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');

function assertNoPin(box, result) {
  for (const call of box.calls()) for (const arg of call) assert.ok(!arg.includes(SO_PIN) && !arg.includes(USER_PIN), `no PIN in the arguments of ${call[0]}`);
  for (const text of [result.stdout, result.stderr]) assert.ok(!text.includes(SO_PIN) && !text.includes(USER_PIN), 'no PIN in the output');
  for (const file of files(box.root)) {
    const full = path.join(box.root, file);
    if (statSync(full).isFile()) {
      const text = readFileSync(full, 'latin1');
      assert.ok(!text.includes(SO_PIN) && !text.includes(USER_PIN), `no PIN in ${file}`);
    }
  }
}

test('makes the token and an EC P-256 key inside it, and prints only the PEM public key and the PKCS#11 URI', () => {
  const box = sandbox();
  const result = box.run(['--test'], PINS);
  assert.equal(result.status, 0, result.stderr);
  const out = printed(result.stdout);
  assert.equal(out.first, '-----BEGIN PUBLIC KEY-----');
  const key = createPublicKey(out.pem);
  assert.equal(key.asymmetricKeyType, 'ec');
  assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(spkiOf(out.pem), fixtureKey('a'), 'the public key read from the token');
  assert.deepEqual(out.rest, [`pkcs11:token=sterling-site-dev;object=sterling-site;id=%01;type=private?module-path=${box.module}`], 'nothing else on standard output');
  assert.ok(result.stderr.includes(`SOFTHSM2_CONF=${box.env.SOFTHSM2_CONF}`), 'says how to point signing at the token');

  const softhsm = path.join(box.base, 'softhsm');
  assert.equal(readFileSync(box.env.SOFTHSM2_CONF, 'utf8').match(/^directories\.tokendir = (.*)$/m)[1], path.join(softhsm, 'tokens'));
  for (const dir of [softhsm, path.join(softhsm, 'tokens')]) assert.equal(statSync(dir).mode & 0o777, 0o700, `${dir} is 0700`);
  assert.equal(readFileSync(path.join(box.base, 'site-key.pub.pem'), 'utf8'), out.pem, 'the public key, and only it, is saved');

  const calls = box.calls();
  const init = calls.find((call) => call[0] === 'softhsm2-util' && call.includes('--init-token'));
  assert.deepEqual(init, ['softhsm2-util', '--init-token', '--free', '--label', 'sterling-site-dev'], 'both PINs are left to the tool\'s own prompts');
  const gen = calls.find((call) => call[0] === 'pkcs11-tool' && call.includes('--keypairgen'));
  assert.ok(gen, 'the key pair is generated by the token');
  // OpenSC's PIN prompt needs a terminal on standard output, so keypairgen runs under script, which keeps a copy of its output.
  const wrapped = calls.find((call) => call[0] === 'script');
  assert.deepEqual(wrapped.slice(0, 5), ['script', '-q', '-e', '-c', `stty -echo && ${gen.join(' ')}`],
    'pkcs11-tool runs on a terminal of its own, with echo off before its prompt so a PIN typed early is not copied');
  const session = wrapped[5];
  assert.equal(path.dirname(path.dirname(session)), box.temp, 'the copy of its output is in a folder of its own in the temporary folder');
  assert.ok(!existsSync(path.dirname(session)), 'and is removed with that folder when the script exits');
  for (const [flag, value] of [['--module', box.module], ['--token-label', 'sterling-site-dev'], ['--key-type', 'EC:prime256v1'], ['--label', 'sterling-site'], ['--id', '01']]) {
    assert.equal(gen[gen.indexOf(flag) + 1], value, `keypairgen ${flag}`);
  }
  for (const flag of ['--login', '--sensitive', '--usage-sign']) assert.ok(gen.includes(flag), `keypairgen ${flag}`);
  assert.ok(!gen.includes('--extractable'), 'never asks for an extractable key');
  assert.ok(!calls.some((call) => call[0] === 'pkcs11-tool' && call.includes('--read-object') && !call.includes('pubkey')), 'only the public key is ever read');
  assertNoPin(box, result);
});

test('installs softhsm2 and opensc from deploy/host-packages.json only after the owner types yes', () => {
  const wanted = JSON.parse(readFileSync(path.join(ROOT, 'deploy/host-packages.json'), 'utf8')).packages
    .filter((pkg) => pkg.usedBy.includes('deploy/keys/new-dev-site-key.sh')).map((pkg) => pkg.packageNames.apt);
  assert.deepEqual(wanted, ['softhsm2', 'opensc', 'bsdutils']);

  const declined = sandbox({ installed: false, packageManager: true });
  const no = declined.run(['--test'], `no\n${PINS}`);
  assert.notEqual(no.status, 0);
  assert.match(no.stderr, /apt-get install softhsm2 opensc/, 'shows the install command first');
  assert.deepEqual(declined.calls(), [], 'nothing installed or run when the owner does not type yes');

  const box = sandbox({ installed: false, packageManager: true });
  const result = box.run(['--test'], `yes\n${PINS}`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(box.calls()[0], ['sudo', 'apt-get', 'install', ...wanted]);
  assert.equal(spkiOf(printed(result.stdout).pem), fixtureKey('a'));
  assertNoPin(box, result);
});

test('stops and archives the token when the new private key is extractable or not sensitive', () => {
  for (const flag of ['FAKE_EXTRACTABLE', 'FAKE_NOT_SENSITIVE']) {
    const box = sandbox();
    const result = box.run(['--test'], PINS, { [flag]: '1' });
    assert.notEqual(result.status, 0, flag);
    assert.match(result.stderr, /extractable|sensitive/, flag);
    assert.equal(result.stdout, '', `${flag}: no key printed`);
    const softhsm = path.join(box.base, 'softhsm');
    assert.ok(!existsSync(path.join(softhsm, 'tokens')), `${flag}: the token folder moved away`);
    assert.ok(!existsSync(path.join(box.base, 'site-key.pub.pem')), `${flag}: no public key saved`);
    const archived = readdirSync(path.join(softhsm, '.archive'));
    assert.equal(archived.length, 1);
    assert.ok(files(path.join(softhsm, '.archive', archived[0])).includes(path.join('tokens', 'token-1', 'key.spki.b64')), `${flag}: the token is kept in the archive`);
  }
});

test('refuses before any tool runs without a terminal, or with --test outside a temporary folder', () => {
  const box = sandbox();
  const plain = box.run([], PINS);
  assert.notEqual(plain.status, 0);
  assert.match(plain.stderr, /terminal/);
  assert.deepEqual(files(box.home), [], 'nothing written in the home folder');

  const ownerConf = path.join(box.home, '.config', 'sterling-signing', 'softhsm', 'softhsm2.conf');
  mkdirSync(path.dirname(path.dirname(ownerConf)), { recursive: true });
  for (const conf of ['/var/lib/sterling-signing/softhsm/softhsm2.conf', path.join(tmpdir(), '..', '..', 'sterling-signing', 'softhsm', 'softhsm2.conf'), ownerConf, '']) {
    const result = box.run(['--test'], PINS, { SOFTHSM2_CONF: conf });
    assert.notEqual(result.status, 0, conf);
    assert.match(result.stderr, /temporary folder/, conf);
  }
  assert.deepEqual(box.calls(), [], 'no tool ran');
  assert.deepEqual(files(box.base), [], 'nothing written');
});

test('--test refuses any configuration that would write into or above the owner folder, or a temporary folder holding it', async (t) => {
  // Review of #194: the check compared only the configuration's grandparent, so each of these wrote into the owner's real folder.
  const box = sandbox();
  const owner = path.join(box.home, '.config', 'sterling-signing');
  mkdirSync(owner, { recursive: true });
  mkdirSync(path.join(box.home, 'work', 'sterling-signing'), { recursive: true });
  const linkParent = path.join(box.temp, 'a');
  mkdirSync(linkParent);
  symlinkSync(owner, path.join(linkParent, 'link'));
  const cases = [
    ['the shallow owner path, with TMPDIR=$HOME', path.join(owner, 'softhsm2.conf'), { TMPDIR: box.home }],
    ['the configuration directly in the owner folder, with a temporary folder that holds the home', path.join(owner, 'softhsm2.conf'), { TMPDIR: box.root }],
    ['TMPDIR=$HOME, away from the owner folder', path.join(box.home, 'work', 'sterling-signing', 'softhsm', 'softhsm2.conf'), { TMPDIR: box.home }],
    ['a symlink into the owner folder', path.join(linkParent, 'link', 'softhsm2.conf'), {}]
  ];
  for (const [name, conf, extra] of cases) await t.test(name, () => {
    const result = box.run(['--test'], PINS, { SOFTHSM2_CONF: conf, ...extra });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /temporary folder/, name);
    assert.deepEqual(box.calls(), [], `${name}: no tool ran`);
    assert.deepEqual(files(owner), [], `${name}: nothing written in the owner folder`);
    assert.deepEqual(files(path.join(box.home, 'work')), [], `${name}: nothing written under the home`);
  });
});

test('a second run, or --show, creates nothing and prints the existing public key and URI', () => {
  const box = sandbox();
  const first = box.run(['--test'], PINS);
  assert.equal(first.status, 0, first.stderr);
  const before = box.calls().length;
  const again = box.run(['--test'], `${USER_PIN}\n`, { FAKE_KEY: 'b' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, first.stdout, 'a second run prints the same key and URI');
  assert.match(again.stderr, /already exists[\s\S]*sensitive and never extractable; nothing was changed/);
  const check = box.calls().slice(before).find((call) => call[0] === 'pkcs11-tool' && call.includes('--login'));
  assert.ok(check && check.includes('--list-objects') && check[check.indexOf('--type') + 1] === 'privkey', 'a second run logs in and checks the existing private key');
  const middle = box.calls().length;
  const shown = box.run(['--test', '--show'], '', { FAKE_KEY: 'b' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, first.stdout, '--show prints the same key and URI');
  assert.match(shown.stderr, /already exists[\s\S]*did not check/);
  assert.ok(!box.calls().slice(middle).some((call) => call.includes('--login') || call[0] === 'script'), '--show never logs in');
  const later = box.calls().slice(before);
  assert.ok(!later.some((call) => call.includes('--init-token') || call.includes('--keypairgen') || call[0] === 'sudo'), 'no token or key made again');
  assertNoPin(box, first);
  assertNoPin(box, again);

  const empty = sandbox();
  const show = empty.run(['--test', '--show'], '');
  assert.notEqual(show.status, 0);
  assert.match(show.stderr, /no development site key/);
  assert.deepEqual(files(empty.base), [], '--show never creates anything');
});

test('a second run archives an existing private key that is extractable or not sensitive, and a failed login changes nothing', () => {
  for (const flag of ['FAKE_EXTRACTABLE', 'FAKE_NOT_SENSITIVE']) {
    const box = sandbox();
    assert.equal(box.run(['--test'], PINS).status, 0);
    const result = box.run(['--test'], `${USER_PIN}\n`, { [flag]: '1' });
    assert.notEqual(result.status, 0, flag);
    assert.match(result.stderr, /archived/, flag);
    assert.equal(result.stdout, '', `${flag}: no key printed`);
    const softhsm = path.join(box.base, 'softhsm');
    assert.ok(!existsSync(path.join(softhsm, 'tokens')) && !existsSync(path.join(box.base, 'site-key.pub.pem')), `${flag}: nothing left in use`);
    const archived = readdirSync(path.join(softhsm, '.archive'));
    assert.equal(archived.length, 1);
    assert.ok(files(path.join(softhsm, '.archive', archived[0])).includes('site-key.pub.pem'), `${flag}: the public key is kept in the archive`);
  }

  const box = sandbox();
  assert.equal(box.run(['--test'], PINS).status, 0);
  const snapshot = () => Object.fromEntries(files(box.base).map((file) => [file, readFileSync(path.join(box.base, file), 'latin1')]));
  const before = snapshot();
  const wrong = box.run(['--test'], '\n');
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /could not log in[\s\S]*nothing was changed/);
  assert.equal(wrong.stdout, '');
  assert.deepEqual(snapshot(), before, 'nothing changed');
});

test('a token left without its key is never reused or overwritten: the script points at --rotate', () => {
  const box = sandbox();
  const tokens = path.join(box.base, 'softhsm', 'tokens');
  mkdirSync(path.join(tokens, 'token-1'), { recursive: true });
  writeFileSync(path.join(tokens, 'token-1', 'label'), 'sterling-site-dev');
  writeFileSync(box.env.SOFTHSM2_CONF, `directories.tokendir = ${tokens}\n`);
  const before = files(box.base);
  const result = box.run(['--test'], PINS);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--rotate/);
  assert.deepEqual(files(box.base), before, 'nothing changed');
  assert.ok(!box.calls().some((call) => call.includes('--init-token') || call.includes('--keypairgen')));
});

test('--rotate archives the whole token folder and the saved public key by moving them, then makes a new key', () => {
  const box = sandbox();
  const first = box.run(['--test'], PINS);
  assert.equal(first.status, 0, first.stderr);
  const softhsm = path.join(box.base, 'softhsm');
  const old = Object.fromEntries(files(box.base).map((file) => [file, readFileSync(path.join(box.base, file), 'latin1')]));

  const declined = box.run(['--test', '--rotate'], `no\n${PINS}`, { FAKE_KEY: 'b' });
  assert.notEqual(declined.status, 0);
  assert.deepEqual(Object.keys(old).sort(), files(box.base).sort(), 'nothing moved when the owner does not type yes');

  const rotated = box.run(['--test', '--rotate'], `yes\n${PINS}`, { FAKE_KEY: 'b' });
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.equal(spkiOf(printed(rotated.stdout).pem), fixtureKey('b'), 'the new key');
  assert.equal(readFileSync(path.join(box.base, 'site-key.pub.pem'), 'utf8'), printed(rotated.stdout).pem);
  const archived = readdirSync(path.join(softhsm, '.archive'));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^\d{8}T\d{6}Z/, 'archived under its UTC time');
  const archive = path.join(softhsm, '.archive', archived[0]);
  assert.ok(rotated.stderr.includes(archive), 'says where the archive went');
  // Every file there before still exists, with the same content, in the archive.
  for (const [file, content] of Object.entries(old)) {
    const inArchive = file.startsWith(`softhsm${path.sep}`) ? file.slice('softhsm/'.length) : file;
    assert.equal(readFileSync(path.join(archive, inArchive), 'latin1'), content, `${file} kept in the archive`);
  }
  assert.equal(spkiOf(readFileSync(path.join(archive, 'site-key.pub.pem'), 'utf8')), fixtureKey('a'));
  assertNoPin(box, rotated);
});

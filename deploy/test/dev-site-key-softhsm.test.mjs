// deploy/keys/new-dev-site-key.sh against the real SoftHSM2 and OpenSC, on a real terminal (48.1-22 field fix). The fake-tool tests in
// dev-site-key.test.mjs missed that OpenSC's PIN prompt fails ("util_getpass error") when pkcs11-tool's standard output is not a terminal;
// this test runs the script under util-linux script, so every tool sees a terminal as on the owner's machine, and types each test PIN
// into that terminal only after the tool's own prompt appears: never as an argument, an environment variable or a file.
// Everything lives in a temporary folder: HOME, TMPDIR and SOFTHSM2_CONF point into it, PATH holds links to the real token tools and a
// few base utilities only (no package manager), and every path is checked to be outside ~/.config/sterling-signing (the owner's real
// token) and ~/.near-credentials before anything runs. Needs softhsm2-util, pkcs11-tool, script and the SoftHSM2 module (CI installs
// softhsm2 and opensc); it fails, never skips, without them.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'deploy/keys/new-dev-site-key.sh');
const MODULE = process.env.STERLING_PKCS11_MODULE || '/usr/lib/softhsm/libsofthsm2.so';
const SO_PIN = 'so-pin-8164';
const USER_PIN = 'user-pin-2937';
const TOOLS = ['softhsm2-util', 'pkcs11-tool', 'script'];
const UTILITIES = ['sh', 'cat', 'mkdir', 'chmod', 'mv', 'cp', 'date', 'base64', 'tr', 'fold', 'awk', 'grep', 'sed', 'id', 'dirname', 'basename', 'ls', 'wc', 'head',
  'mktemp', 'rm', 'rmdir', 'stty'];
const FORBIDDEN = [path.join(homedir(), '.config', 'sterling-signing'), path.join(homedir(), '.near-credentials')];
const which = (name) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((dir) => path.join(dir, name)).find((file) => existsSync(file));

/** The prompts and answers for a new token: softhsm2-util asks for the SO PIN and the user PIN twice each, then pkcs11-tool for the user PIN. */
const CREATE = [
  [/Please enter SO PIN: $/, SO_PIN], [/Please reenter SO PIN: $/, SO_PIN],
  [/Please enter user PIN: $/, USER_PIN], [/Please reenter user PIN: $/, USER_PIN],
  [/Please enter User PIN: $/, USER_PIN]
];

/** Throws unless the path, resolved through any symlinks in the part that exists, is outside the owner's real folders. */
function outsideOwner(file) {
  let existing = file;
  while (!existsSync(existing)) existing = path.dirname(existing);
  const resolved = path.join(realpathSync(existing), path.relative(existing, file));
  for (const forbidden of FORBIDDEN) {
    assert.ok(resolved !== forbidden && !resolved.startsWith(`${forbidden}${path.sep}`), `${file} must stay outside ${forbidden}`);
  }
  return file;
}

function sandbox() {
  const root = outsideOwner(mkdtempSync(path.join(tmpdir(), 'dev-site-key-softhsm-')));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  const base = path.join(temp, 'sterling-signing');
  for (const dir of [bin, home, temp, base]) mkdirSync(dir);
  for (const name of [...TOOLS, ...UTILITIES]) {
    const found = which(name);
    assert.ok(found, `${name} is installed (the test needs the real SoftHSM2, OpenSC and util-linux tools; CI installs softhsm2 and opensc)`);
    symlinkSync(found, path.join(bin, name));
  }
  assert.ok(existsSync(MODULE), `the SoftHSM2 module ${MODULE} is installed`);
  const env = {
    PATH: bin,
    HOME: home,
    TMPDIR: temp,
    LC_ALL: 'C',
    SHELL: '/bin/sh',
    TERM: 'dumb',
    STERLING_PKCS11_MODULE: MODULE,
    SOFTHSM2_CONF: outsideOwner(path.join(base, 'softhsm', 'softhsm2.conf'))
  };
  for (const dir of [home, temp, base]) outsideOwner(dir);
  let runs = 0;

  /**
   * Runs the script with --test on a terminal of its own, answering each prompt in order once it appears (after a short pause, so that
   * the tool has turned echo off), and resolves the exit status, standard output (kept in a file, away from the terminal), the terminal
   * transcript and how many prompts were never seen.
   */
  const run = (args, answers) => new Promise((resolve, reject) => {
    runs += 1;
    const stdoutFile = path.join(root, `stdout-${runs}`);
    const command = `/bin/sh '${SCRIPT}' --test ${args.join(' ')} > '${stdoutFile}'`;
    const child = spawn(which('script'), ['-q', '-e', '-c', command, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let transcript = '';
    let seen = 0;
    let next = 0;
    let waiting = false;
    const pump = () => {
      if (waiting || next >= answers.length) return;
      const match = answers[next][0].exec(transcript.slice(seen));
      if (!match) return;
      seen += match.index + match[0].length;
      const answer = answers[next][1];
      next += 1;
      waiting = true;
      setTimeout(() => { waiting = false; child.stdin.write(`${answer}\n`); pump(); }, 300);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out; transcript:\n${transcript}`)); }, 60_000);
    child.stdout.on('data', (chunk) => { transcript += chunk.toString('latin1'); pump(); });
    child.stderr.on('data', (chunk) => { transcript += chunk.toString('latin1'); });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ status, stdout: existsSync(stdoutFile) ? readFileSync(stdoutFile, 'utf8') : '', transcript, unanswered: answers.length - next });
    });
  });
  return { root, temp, base, env, run };
}

/** Every file under a folder, as paths relative to it. */
function files(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(dir, entry.name), rel) : [rel];
  });
}
/** A SHA-256 of every file under a folder; with skipTokenInfo, SoftHSM2's token.object (token flags it rewrites on every login) shows only as present. */
const contents = (dir, { skipTokenInfo = false } = {}) => Object.fromEntries(files(dir).map((file) => [file,
  skipTokenInfo && path.basename(file) === 'token.object' ? 'present' : createHash('sha256').update(readFileSync(path.join(dir, file))).digest('hex')]));

function pemOf(stdout) {
  const lines = stdout.trimEnd().split('\n');
  const end = lines.indexOf('-----END PUBLIC KEY-----');
  return { pem: `${lines.slice(0, end + 1).join('\n')}\n`, rest: lines.slice(end + 1) };
}

/** No PIN on the terminal (which shows the same bytes script copies into the script's session file), on standard output or in any file. */
function assertNoPin(box, result) {
  for (const text of [result.transcript, result.stdout]) assert.ok(!text.includes(SO_PIN) && !text.includes(USER_PIN), 'no PIN on the terminal or standard output');
  for (const file of files(box.root)) {
    const full = path.join(box.root, file);
    if (statSync(full).isFile()) {
      const text = readFileSync(full, 'latin1');
      assert.ok(!text.includes(SO_PIN) && !text.includes(USER_PIN), `no PIN in ${file}`);
    }
  }
  assert.deepEqual(readdirSync(box.temp).filter((name) => name.startsWith('new-dev-site-key.')), [], 'the copy of pkcs11-tool\'s output is removed');
}

test('makes a real SoftHSM2 token and key on a terminal, a second run changes nothing, and --rotate archives', async (t) => {
  const box = sandbox();
  const softhsm = path.join(box.base, 'softhsm');
  let first;

  await t.test('makes the token and an EC P-256 key that is sensitive and never extractable, and prints only the PEM and the URI', async () => {
    first = await box.run([], CREATE);
    assert.equal(first.status, 0, first.transcript);
    assert.equal(first.unanswered, 0, 'every prompt appeared');
    assert.match(first.transcript, /Access: +sensitive, always sensitive, never extractable, local/, 'OpenSC showed the new private key\'s Access line');
    const { pem, rest } = pemOf(first.stdout);
    const key = createPublicKey(pem);
    assert.equal(key.asymmetricKeyType, 'ec');
    assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
    assert.deepEqual(rest, [`pkcs11:token=sterling-site-dev;object=sterling-site;id=%01;type=private?module-path=${MODULE}`], 'nothing else on standard output');
    assert.equal(readFileSync(path.join(box.base, 'site-key.pub.pem'), 'utf8'), pem, 'the public key, and only it, is saved');
    assert.ok(files(path.join(softhsm, 'tokens')).length > 0, 'the token is in the temporary tokens folder');
    assertNoPin(box, first);
  });

  await t.test('a second run logs in, checks the existing private key and changes nothing', async () => {
    const before = contents(box.base, { skipTokenInfo: true });
    const again = await box.run([], [[/Please enter User PIN: $/, USER_PIN]]);
    assert.equal(again.status, 0, again.transcript);
    assert.equal(again.unanswered, 0);
    assert.equal(again.stdout, first.stdout, 'the same key and URI');
    assert.match(again.transcript, /Access: +sensitive, always sensitive, never extractable, local/, 'the existing private key was listed after the login');
    assert.match(again.transcript, /sensitive and never extractable; nothing was changed/);
    assert.deepEqual(contents(box.base, { skipTokenInfo: true }), before, 'no file added or removed, and the keys, configuration and public key unchanged');
    assertNoPin(box, again);
  });

  await t.test('--rotate archives the token, its configuration and the public key by moving them, then makes a new key', async () => {
    const before = contents(box.base);
    const rotated = await box.run(['--rotate'], [[/Type yes to continue: $/, 'yes'], ...CREATE]);
    assert.equal(rotated.status, 0, rotated.transcript);
    assert.equal(rotated.unanswered, 0);
    const { pem } = pemOf(rotated.stdout);
    assert.notEqual(pem, pemOf(first.stdout).pem, 'a new key');
    assert.equal(readFileSync(path.join(box.base, 'site-key.pub.pem'), 'utf8'), pem);
    const archived = readdirSync(path.join(softhsm, '.archive'));
    assert.equal(archived.length, 1);
    const archive = path.join(softhsm, '.archive', archived[0]);
    const kept = contents(archive);
    for (const [file, hash] of Object.entries(before)) {
      const inArchive = file.startsWith(`softhsm${path.sep}`) ? file.slice('softhsm/'.length) : file;
      assert.equal(kept[inArchive], hash, `${file} kept unchanged in the archive`);
    }
    assertNoPin(box, rotated);
  });
});

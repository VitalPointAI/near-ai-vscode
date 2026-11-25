// team.json as untrusted input, secret refusal, serialised atomic writes and the local trust pin (D-01, D-10, D-21, D-23).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize } from '../domain/team/canonical';
import { SecretLeakError } from '../domain/team/secrets';
import type { TeamFile } from '../domain/team/types';
import { TEAM_ID_PATTERN } from '../domain/team/validate';
import { newTeamId } from '../team/identity';
import {
  COORDINATION_REF_PATTERN, REMOTE_NAME_PATTERN, RESERVED_SYNC_REFS, TEAM_FILE_REL, TeamFileError, TrustPinError, canonicalTeamFile, checkTrustPin, PROJECT_TRUST_FOLDER, pinTrust, projectTrustDir, projectTrustKey, collidesWithSyncRef,
  parseTeamFile, readTeamFile, serialiseTeamFile, teamFilePath, teamStorageDir, writeTeamFile
} from '../team/teamFile';
import { INCOMING_REF as TEAM_INCOMING_REF, LOCAL_REF, QUARANTINE_REF_PREFIX } from '../team/gitTransport';
import { INCOMING_REF, STATE_REF } from '../services/stateTransport';
import { createOwner, testGenesis } from './helpers/teamHarness';

async function workDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'near-ai-teamfile-'));
}

async function validFile(options: { near?: boolean } = {}): Promise<TeamFile> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = testGenesis({ teamId, owner, name: 'Team file test' });
  const file = JSON.parse(genesis.teamFileText) as TeamFile;
  if (options.near === true) file.near = { organizationId: 'org_123', workspaceId: 'ws:456' };
  return file;
}

// A loosely typed view of a team file so a test can add forbidden keys or break a value.
interface Doc {
  [key: string]: unknown;
  coordination: Record<string, unknown>;
  genesis: { [key: string]: unknown; ownerDevice: Record<string, unknown> };
}

// Deep clone that tests then edit before serialising.
function edited(file: TeamFile, edit: (copy: Doc) => void): string {
  const copy = JSON.parse(JSON.stringify(file)) as Doc;
  edit(copy);
  return JSON.stringify(copy);
}

test('a valid team file round-trips and serialises in the fixed key order with a trailing newline', async () => {
  for (const near of [false, true]) {
    const file = await validFile({ near });
    const text = serialiseTeamFile(file);
    assert.deepEqual(parseTeamFile(text), file);
    assert.ok(text.endsWith('\n'));
    const topKeys = Object.keys(JSON.parse(text) as object);
    assert.deepEqual(topKeys, near
      ? ['version', 'teamId', 'name', 'coordination', 'genesis', 'near', 'createdAt']
      : ['version', 'teamId', 'name', 'coordination', 'genesis', 'createdAt']);
    const parsed = JSON.parse(text) as TeamFile;
    assert.deepEqual(Object.keys(parsed.coordination), ['transport', 'ref', 'remote']);
    assert.deepEqual(Object.keys(parsed.genesis), ['eventId', 'ownerDevice']);
  }
});

test('the genesis copy is canonical JSON and matches the harness bytes', async () => {
  const file = await validFile({ near: true });
  assert.equal(canonicalTeamFile(file), canonicalize(file));
  assert.deepEqual(JSON.parse(canonicalTeamFile(file)), file);
  const plain = await validFile();
  assert.equal(canonicalTeamFile(plain), canonicalize(plain));
});

test('invalid JSON, a newer version and extra keys are refused with plain messages', async () => {
  const file = await validFile();
  assert.throws(() => parseTeamFile('{not json'), (error: unknown) => error instanceof TeamFileError && /not valid JSON/.test(error.message));
  assert.throws(() => parseTeamFile(edited(file, (c) => { c.version = 2; })), /newer version of SovAI.*Update the extension/);
  assert.throws(() => parseTeamFile(edited(file, (c) => { c.version = 2; c.extra = 1; })), /Update the extension/);
  assert.throws(() => parseTeamFile(edited(file, (c) => { delete c.version; })), TeamFileError);
  assert.throws(() => parseTeamFile(edited(file, (c) => { c.extra = 'x'; })), /unexpected extra field/);
  assert.throws(() => parseTeamFile(edited(file, (c) => { c.coordination.extra = 'x'; })), /unexpected extra field in "coordination"/);
  assert.throws(() => parseTeamFile(edited(file, (c) => { c.genesis.extra = 'x'; })), /unexpected extra field in "genesis"/);
  assert.throws(() => parseTeamFile(edited(file, (c) => { c.genesis.ownerDevice.extra = 'x'; })), TeamFileError);
  assert.throws(() => parseTeamFile('[]'), TeamFileError);
  assert.throws(() => parseTeamFile('null'), TeamFileError);
});

test('a team.json carrying a policy key is refused because the log, not team.json, holds policy (D-21)', async () => {
  const file = await validFile();
  assert.throws(() => parseTeamFile(edited(file, (c) => { c.policy = { dispatchMode: 'auto' }; })), TeamFileError);
  assert.throws(() => parseTeamFile(edited(file, (c) => { c.coordination.policy = {}; })), TeamFileError);
});

test('a hostile __proto__ key is an extra field and never reaches the result', async () => {
  const file = await validFile();
  const text = serialiseTeamFile(file).replace('{\n', '{\n  "__proto__": { "polluted": true },\n');
  assert.throws(() => parseTeamFile(text), TeamFileError);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('team id, name, transport, remote, ref, genesis and timestamp are each validated', async () => {
  const file = await validFile();
  const cases: Array<[string, (copy: Doc) => void]> = [
    ['teamId', (c) => { c.teamId = 'team-xyz'; }],
    ['empty name', (c) => { c.name = ''; }],
    ['81 character name', (c) => { c.name = 'n'.repeat(81); }],
    ['name with a control character', (c) => { c.name = 'bad\nname'; }],
    ['transport', (c) => { c.coordination.transport = 'http'; }],
    ['option-like remote', (c) => { c.coordination.remote = '--upload-pack=x'; }],
    ['remote with a slash', (c) => { c.coordination.remote = 'a/b'; }],
    ['remote with a space', (c) => { c.coordination.remote = 'a b'; }],
    ['remote as a url', (c) => { c.coordination.remote = 'https://example.invalid/x.git'; }],
    ['tag ref', (c) => { c.coordination.ref = 'refs/tags/x'; }],
    ['ref with dot dot', (c) => { c.coordination.ref = 'refs/heads/a/../b'; }],
    ['ref ending in .lock', (c) => { c.coordination.ref = 'refs/heads/near-ai/coordination.lock'; }],
    ['ref with a double slash', (c) => { c.coordination.ref = 'refs/heads/a//b'; }],
    ['ref with a trailing slash', (c) => { c.coordination.ref = 'refs/heads/a/'; }],
    ['ref component starting with a dot', (c) => { c.coordination.ref = 'refs/heads/a/.hidden'; }],
    ['ref with a space', (c) => { c.coordination.ref = 'refs/heads/a b'; }],
    ['genesis event id', (c) => { c.genesis.eventId = 'evt-123'; }],
    ['genesis fingerprint that does not match the key', (c) => { c.genesis.ownerDevice.fingerprint = `dev-${'0'.repeat(32)}`; }],
    ['genesis public key', (c) => { c.genesis.ownerDevice.publicKey = 'short'; }],
    ['createdAt', (c) => { c.createdAt = 'yesterday'; }],
    ['near with a bad id', (c) => { c.near = { organizationId: 'bad id', workspaceId: 'ws' }; }],
    ['near with an extra key', (c) => { c.near = { organizationId: 'org', workspaceId: 'ws', extra: 1 }; }]
  ];
  for (const [label, edit] of cases) {
    assert.throws(() => parseTeamFile(edited(file, edit)), (error: unknown) => error instanceof TeamFileError && !/—/.test(error.message), label);
  }
  assert.ok(REMOTE_NAME_PATTERN.test('origin'));
  assert.ok(COORDINATION_REF_PATTERN.test('refs/near-ai/coordination'));
});

test('a refused value is never echoed back in the message', async () => {
  const file = await validFile();
  const probe = '--upload-pack=touch-pwned';
  try {
    parseTeamFile(edited(file, (c) => { c.coordination.remote = probe; }));
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof TeamFileError);
    assert.ok(!error.message.includes(probe));
  }
  try {
    parseTeamFile(edited(file, (c) => { c['--evil-key'] = 1; }));
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof TeamFileError);
    assert.ok(!error.message.includes('--evil-key'));
  }
});

test('an oversized file is refused', async () => {
  await assert.rejects(async () => parseTeamFile(`{"pad":"${'x'.repeat(20000)}"}`), /larger than 16 KB/);
});

test('writeTeamFile with a secret-like name throws SecretLeakError and leaves nothing behind', async () => {
  const root = await workDir();
  try {
    const file = await validFile();
    file.name = `Team sk-${randomBytes(12).toString('hex')}`;
    await assert.rejects(() => writeTeamFile(root, file), SecretLeakError);
    await assert.rejects(() => fs.access(path.join(root, '.planning')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writeTeamFile writes the serialised file and readTeamFile returns it', async () => {
  const root = await workDir();
  try {
    assert.equal(await readTeamFile(root), undefined);
    const file = await validFile({ near: true });
    await writeTeamFile(root, file);
    assert.equal(await fs.readFile(teamFilePath(root), 'utf8'), serialiseTeamFile(file));
    assert.equal(teamFilePath(root), path.join(root, '.planning', '.near-ai', 'team.json'));
    assert.equal(TEAM_FILE_REL, '.planning/.near-ai/team.json');
    assert.deepEqual(await readTeamFile(root), file);
    assert.deepEqual(await fs.readdir(path.dirname(teamFilePath(root))), ['team.json']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writeTeamFile refuses an invalid file before touching disk', async () => {
  const root = await workDir();
  try {
    const file = await validFile();
    file.coordination.remote = '--upload-pack=x';
    await assert.rejects(() => writeTeamFile(root, file), TeamFileError);
    await assert.rejects(() => fs.access(path.join(root, '.planning')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent writes complete in call order and the file holds valid JSON of the last one', async () => {
  const root = await workDir();
  try {
    const first = await validFile();
    const second = { ...first, name: 'Second name' };
    const third = { ...first, name: 'Third name' };
    const writes = [writeTeamFile(root, first), writeTeamFile(root, second), writeTeamFile(root, third)];
    await Promise.all(writes);
    const onDisk = parseTeamFile(await fs.readFile(teamFilePath(root), 'utf8'));
    assert.equal(onDisk.name, 'Third name');
    assert.deepEqual(await fs.readdir(path.dirname(teamFilePath(root))), ['team.json']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failed write rejects with the error, leaves no temp file and does not block the next write', async () => {
  const root = await workDir();
  try {
    const target = teamFilePath(root);
    // A non-empty directory where team.json should be makes the final rename fail on every platform and for every user.
    await fs.mkdir(path.join(target, 'inner'), { recursive: true });
    const file = await validFile();
    await assert.rejects(() => writeTeamFile(root, file), (error: unknown) => error instanceof Error && !(error instanceof TeamFileError));
    assert.deepEqual(await fs.readdir(path.dirname(target)), ['team.json']);
    await fs.rm(target, { recursive: true, force: true });
    await writeTeamFile(root, file);
    assert.deepEqual(await readTeamFile(root), file);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a write into a read-only directory rejects and leaves no temp file', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const root = await workDir();
  const dir = path.join(root, '.planning', '.near-ai');
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o500);
    const file = await validFile();
    await assert.rejects(() => writeTeamFile(root, file));
    await fs.chmod(dir, 0o700);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.chmod(dir, 0o700);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('readTeamFile throws TeamFileError for a corrupt file instead of reporting no team', async () => {
  const root = await workDir();
  try {
    await fs.mkdir(path.dirname(teamFilePath(root)), { recursive: true });
    await fs.writeFile(teamFilePath(root), '{"version":1,', 'utf8');
    await assert.rejects(() => readTeamFile(root), TeamFileError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the trust pin is written on first sight, matches afterwards and refuses a changed team, genesis or owner key', async () => {
  const dir = await workDir();
  try {
    const file = await validFile();
    assert.equal(await checkTrustPin(dir, file), 'first-seen');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'trust.json'), 'utf8')), {
      version: 1, teamId: file.teamId, genesisEventId: file.genesis.eventId, ownerFingerprint: file.genesis.ownerDevice.fingerprint
    });
    assert.equal(await checkTrustPin(dir, file), 'match');
    assert.equal(await checkTrustPin(dir, { ...file, name: 'Renamed team' }), 'match', 'a display name change is not a trust change');

    const otherTeam = { ...file, teamId: newTeamId() };
    await assert.rejects(() => checkTrustPin(dir, otherTeam), (error: unknown) => error instanceof TrustPinError && /different team or owner key/.test(error.message));
    const otherGenesis = { ...file, genesis: { ...file.genesis, eventId: `evt-${'1'.repeat(26)}` } };
    await assert.rejects(() => checkTrustPin(dir, otherGenesis), TrustPinError);
    const stranger = await createOwner(file.teamId);
    const otherOwner = { ...file, genesis: { ...file.genesis, ownerDevice: { fingerprint: stranger.identity.fingerprint, publicKey: stranger.identity.publicKey } } };
    await assert.rejects(() => checkTrustPin(dir, otherOwner), TrustPinError);
    assert.equal(await checkTrustPin(dir, file), 'match', 'the pin is unchanged by refused attempts');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt trust record fails closed and concurrent first sights agree', async () => {
  const dir = await workDir();
  try {
    const file = await validFile();
    const results = await Promise.all([checkTrustPin(dir, file), checkTrustPin(dir, file), checkTrustPin(dir, file)]);
    assert.deepEqual(results, ['first-seen', 'match', 'match']);
    await fs.writeFile(path.join(dir, 'trust.json'), '{broken', 'utf8');
    await assert.rejects(() => checkTrustPin(dir, file), TrustPinError);
    await fs.writeFile(path.join(dir, 'trust.json'), JSON.stringify({ version: 9 }), 'utf8');
    await assert.rejects(() => checkTrustPin(dir, file), TrustPinError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the project trust folder is keyed by the resolved project path as Phase 27 keys its sync mirrors, never by anything in team.json', async () => {
  const { mirrorFolderName } = await import('../services/syncFlows');
  const root = path.join(tmpdir(), 'some-project');
  assert.equal(projectTrustKey(root), mirrorFolderName(root));
  assert.equal(projectTrustKey(`${root}${path.sep}.`), projectTrustKey(root), 'the path is resolved first');
  assert.notEqual(projectTrustKey(path.join(tmpdir(), 'other-project')), projectTrustKey(root));
  assert.equal(projectTrustDir('/store', root), path.join('/store', 'team', PROJECT_TRUST_FOLDER, projectTrustKey(root)));
  assert.equal(TEAM_ID_PATTERN.test(PROJECT_TRUST_FOLDER), false, 'no team id can name the projects folder');
});

test('pinTrust replaces the pin deliberately, and checkTrustPin then matches only the new team', async () => {
  const dir = await workDir();
  try {
    const file = await validFile();
    assert.equal(await checkTrustPin(dir, file), 'first-seen');
    const next = { ...file, teamId: newTeamId() };
    await assert.rejects(() => checkTrustPin(dir, next), TrustPinError);
    await pinTrust(dir, next);
    assert.equal(await checkTrustPin(dir, next), 'match');
    await assert.rejects(() => checkTrustPin(dir, file), TrustPinError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('teamStorageDir joins the global storage with the validated team id and refuses traversal', () => {
  const teamId = newTeamId();
  assert.equal(teamStorageDir('/store', teamId), path.join('/store', 'team', teamId));
  for (const bad of ['../x', 'team-../..', 'team-ZZZZ', '', `${teamId}/..`, `${teamId}\n`]) {
    assert.throws(() => teamStorageDir('/store', bad), TeamFileError, bad);
  }
});

// ---- Team Mode and project sync share one remote, so team.json may never name sync's branches (D-12, D-23).

test('team.json refuses the project sync branch, its parents, children and incoming ref, whatever the letter case', async () => {
  const file = await validFile();
  const refused = [
    'refs/heads/near-ai/state',
    'refs/heads/near-ai/state/x',
    'refs/heads/near-ai',
    'refs/heads/NEAR-AI/State',
    'refs/near-ai/incoming',
    'refs/near-ai/incoming/a',
    'refs/near-ai/INCOMING'
  ];
  for (const ref of refused) {
    assert.ok(collidesWithSyncRef(ref), `${ref} collides`);
    assert.throws(
      () => parseTeamFile(edited(file, (c) => { c.coordination.ref = ref; })),
      (error: unknown) => error instanceof TeamFileError && error.message === 'team.json has a missing or invalid "coordination.ref" and was not used.' && !error.message.includes(ref),
      ref
    );
  }
});

test('team.json still accepts the default coordination branch and sibling names that are not sync branches', async () => {
  const file = await validFile();
  const accepted = ['refs/heads/near-ai/coordination', 'refs/near-ai/coordination', 'refs/heads/near-ai/states', 'refs/heads/team-log'];
  for (const ref of accepted) {
    assert.equal(collidesWithSyncRef(ref), false, `${ref} does not collide`);
    assert.equal(parseTeamFile(edited(file, (c) => { c.coordination.ref = ref; })).coordination.ref, ref, ref);
  }
});

test('the reserved sync refs are pinned to the sync constants, so a rename on the sync side breaks this test', () => {
  assert.deepEqual([...RESERVED_SYNC_REFS], [STATE_REF, INCOMING_REF]);
});

test('the team transport keeps its own local refs out of the refs/near-ai/ namespace and apart from sync refs', () => {
  for (const ref of [LOCAL_REF, TEAM_INCOMING_REF, QUARANTINE_REF_PREFIX]) {
    assert.ok(!ref.startsWith('refs/near-ai/'), `${ref} is outside refs/near-ai/`);
    assert.ok(!collidesWithSyncRef(ref), `${ref} does not collide with a sync ref`);
    assert.notEqual(ref, STATE_REF);
    assert.notEqual(ref, INCOMING_REF);
  }
});

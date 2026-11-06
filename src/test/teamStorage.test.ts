// Where a person's teams live (owner, 2026-11-06): uninstalling the extension, or installing it in another VS Code, must not lose the teams they made in
// Team Studio. These pin the rule and the one-time move from the old location.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { legacyTeamsDirectory, sameFolder, teamsDirectory } from '../domain/teamStorage';
import { migrateTeams } from '../services/teamStorage';

test('teams live under the home folder, not inside the extension, so an uninstall keeps them', () => {
  assert.equal(teamsDirectory('/home/dev'), path.join('/home/dev', '.near-ai-teams'));
  // A deliberate folder wins, for tests and for a person who keeps their home elsewhere.
  assert.equal(teamsDirectory('/home/dev', { NEAR_AI_TEAMS_DIR: '/data/teams' }), '/data/teams');
  // A relative or empty value is ignored, never used to scatter files into a working directory.
  assert.equal(teamsDirectory('/home/dev', { NEAR_AI_TEAMS_DIR: 'relative/path' }), path.join('/home/dev', '.near-ai-teams'));
  assert.equal(teamsDirectory('/home/dev', { NEAR_AI_TEAMS_DIR: '   ' }), path.join('/home/dev', '.near-ai-teams'));
  // The old location is the extension's global storage, which is what an upgrade moves away from.
  assert.equal(legacyTeamsDirectory('/storage/xyz'), path.join('/storage/xyz', 'teams'));
  // The same folder spelled two ways is one folder.
  assert.equal(sameFolder('/a/b/', '/a/./b'), true);
  assert.equal(sameFolder('/a/b', '/a/c'), false);
});

test('a first run copies the teams saved under the old extension folder into the new one, and leaves the old ones alone', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-team-move-'));
  const legacy = path.join(base, 'globalstorage');
  const target = path.join(base, 'home', '.near-ai-teams');
  await mkdir(path.join(legacy, 'teams', '.versions', 'research'), { recursive: true });
  await writeFile(path.join(legacy, 'teams', 'research.md'), '---\nname: Research\n---\nbody\n');
  await writeFile(path.join(legacy, 'teams', '.versions', 'research', 'v1.md'), 'older\n');
  await mkdir(path.join(legacy, 'teams', '.archived'), { recursive: true });
  await writeFile(path.join(legacy, 'teams', '.archived', 'old.md'), 'gone\n');

  const result = await migrateTeams({ home: path.join(base, 'home'), globalStorage: legacy });
  assert.equal(result.moved, 3, 'the team, its version and the archived one travelled');
  assert.equal(result.skipped, 0);
  assert.equal(await readFile(path.join(target, 'teams', 'research.md'), 'utf8'), '---\nname: Research\n---\nbody\n');
  assert.equal(await readFile(path.join(target, 'teams', '.versions', 'research', 'v1.md'), 'utf8'), 'older\n');
  assert.equal(await readFile(path.join(target, 'teams', '.archived', 'old.md'), 'utf8'), 'gone\n');
  // Copied, not moved: a person who goes back to the old version of the extension still finds their teams.
  assert.equal(existsSync(path.join(legacy, 'teams', 'research.md')), true, 'the old copy is left in place');

  // A second run changes nothing: a file already there is not overwritten, because it may be the newer one.
  await writeFile(path.join(target, 'teams', 'research.md'), '---\nname: Research\n---\nedited in the new place\n');
  const again = await migrateTeams({ home: path.join(base, 'home'), globalStorage: legacy });
  assert.equal(again.moved, 0);
  assert.equal(again.skipped, 3, 'every file was already present');
  assert.match(await readFile(path.join(target, 'teams', 'research.md'), 'utf8'), /edited in the new place/);
});

test('a first run with nothing to move does nothing, and never fails a start', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-team-move-empty-'));
  const result = await migrateTeams({ home: path.join(base, 'home'), globalStorage: path.join(base, 'no-storage') });
  assert.deepEqual(result, { moved: 0, skipped: 0 });
  // The team folder does not have to exist yet: a person who has made no teams has none to move.
  assert.equal(existsSync(path.join(base, 'home', '.near-ai-teams')), false);
});

test('when the new folder is the old one, nothing is copied onto itself', async () => {
  // The only way the two name the same folder is a person pointing NEAR_AI_TEAMS_DIR at the old storage parent, which an upgrade must survive.
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-team-same-'));
  const globalStorage = path.join(base, 'storage');
  await mkdir(path.join(globalStorage, 'teams'), { recursive: true });
  await writeFile(path.join(globalStorage, 'teams', 'one.md'), 'x\n');
  const result = await migrateTeams({ home: base, globalStorage, env: { NEAR_AI_TEAMS_DIR: globalStorage } });
  assert.deepEqual(result, { moved: 0, skipped: 0 }, 'nothing is copied onto itself');
  assert.deepEqual((await readdir(path.join(globalStorage, 'teams'))).sort(), ['one.md'], 'and the file is untouched');
});

test('reading a team the extension wrote never asks for approval, and any other file outside still does', async () => {
  const { classifyCommand } = await import('../agent/commandSafety');
  const home = '/home/dev';
  const teams = teamsDirectory(home);
  const root = '/work/app';
  const trusted = { root, cwd: root, home, trustedToolRoots: [teams] };
  const untrusted = { root, cwd: root, home };
  // Owner report, 2026-11-06: an agent reading its own team definition was held as "outside the workspace". It is NEAR AI's own file.
  const read = classifyCommand(`cat ${path.join(teams, 'teams', 'researchx.md')}`, trusted);
  assert.equal(read.verdict, 'safe', JSON.stringify(read));
  // The same read without the trusted root still asks, so the fix is the root and not a blanket change.
  assert.equal(classifyCommand(`cat ${path.join(teams, 'teams', 'researchx.md')}`, untrusted).verdict, 'unknown');
  // An unrelated file outside the workspace is still held.
  assert.equal(classifyCommand('cat /etc/hosts', trusted).verdict, 'unknown');
  // A team file is never written to by an agent, even though it may be read.
  const write = classifyCommand(`echo x > ${path.join(teams, 'teams', 'researchx.md')}`, trusted);
  assert.notEqual(write.verdict, 'safe', JSON.stringify(write));
});

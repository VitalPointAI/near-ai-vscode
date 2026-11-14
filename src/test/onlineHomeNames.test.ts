// REVIEW NIT src/services/onlineHome.ts:150: the repository name is an argument of the gh command, so a name that starts with '-' would be read as an option.
import assert from 'node:assert/strict';
import test from 'node:test';
import { repoNameFromFolder, validateRepoName } from '../domain/state/onlineHome';
import { systemGhCli, type GhExec } from '../services/onlineHome';

test('a repository name that starts with a hyphen is refused, and ordinary names are still accepted', () => {
  for (const bad of ['-x', '--help', '-', '--private', '-draft']) assert.equal(validateRepoName(bad), false, bad);
  for (const good of ['my-project', 'a.b_c', 'x-', 'x', 'A1', '_underscore']) assert.equal(validateRepoName(good), true, good);
  assert.equal(validateRepoName(''), false);
  assert.equal(validateRepoName('.'), false);
  assert.equal(validateRepoName('..'), false);
  assert.equal(validateRepoName('name.git'), false);
});

test('a folder name that starts with a hyphen is suggested without it, and a name that is nothing but hyphens falls back to a valid one', () => {
  assert.equal(repoNameFromFolder('-draft'), 'draft');
  assert.equal(repoNameFromFolder('--my folder'), 'my-folder');
  const fallback = repoNameFromFolder('--');
  assert.equal(validateRepoName(fallback), true);
  assert.equal(fallback, 'project');
  assert.equal(validateRepoName(repoNameFromFolder('-')), true);
});

test('gh is never run for a repository name that starts with a hyphen', async () => {
  const calls: string[][] = [];
  const exec: GhExec = (args) => { calls.push(args); return Promise.resolve({ code: 0, stdout: args[0] === 'api' ? 'me\n' : 'https://github.com/me/fine-name\n', stderr: '' }); };
  const gh = systemGhCli(exec);
  for (const name of ['-x', '--help', '-']) await assert.rejects(gh.createRepo(name, 'private'), /./, name);
  assert.deepEqual(calls, [], 'no command was run');
  await gh.createRepo('fine-name', 'private');
  assert.equal(calls.length > 0, true, 'a good name still reaches gh');
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamLibrary } from '../agent/teams';

// The Update Team command itself, with VS Code stubbed: a file that changed or vanished after it was
// listed gets a clear message instead of an unhandled error.

const errors: Array<{ message: string; items: string[] }> = [];
const opened: string[] = [];
let errorAnswer: string | undefined;
const infos: string[] = [];
const vscodeStub = {
  workspace: { workspaceFolders: [] as Array<{ uri: { fsPath: string } }>, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), fs: { stat: async () => ({}) }, openTextDocument: async () => ({}) },
  window: {
    showErrorMessage: async (message: string, ...items: string[]) => { errors.push({ message, items }); return errorAnswer; },
    showInformationMessage: async (message: string) => { infos.push(message); return undefined; },
    showWarningMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async (uri: { fsPath: string }) => { opened.push(uri.fsPath); }
  },
  commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose() {} }) },
  Uri: { file: (fsPath: string) => ({ fsPath }) }
};

function load(): typeof import('../services/teamUpdateCommands') {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => (request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain));
  try { return require('../services/teamUpdateCommands') as typeof import('../services/teamUpdateCommands'); } finally { nodeModule._load = originalLoad; }
}

test('Update Team on a file that no longer parses, or no longer exists, says so instead of failing', async () => {
  const { updateTeam } = load();
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-update-cmd-'));
  const library = new TeamLibrary(path.join(base, 'global'));
  await mkdir(library.directory, { recursive: true });
  const broken = path.join(library.directory, 'broken.md');
  // A research team (so Update Team recognises it) whose name was deleted after it was listed.
  await writeFile(broken, '---\ndescription: no name\n---\n\n## investigator\n\nFind.\n\n## source-verifier\n\nCheck.\n\n## analyst\n\nWeigh.\n');
  errorAnswer = 'Open team file';
  await updateTeam(library, broken);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /^broken\.md was not updated because it can't be read as a team: The team needs a name in its frontmatter \(name: My team\)\. Fix the file, then run Update Team again\.$/);
  assert.deepEqual(errors[0].items, ['Open team file']);
  assert.deepEqual(opened, [broken], 'the file opens so it can be fixed');
  errorAnswer = undefined;
  await updateTeam(library, path.join(library.directory, 'gone.md'));
  assert.equal(errors.length, 2);
  assert.match(errors[1].message, /^gone\.md was not updated because it no longer exists\./);
  assert.deepEqual(errors[1].items, [], 'nothing to open');
});

test('Update Team writes only a project team file or a team in the library, never a path it is handed elsewhere', async () => {
  const { updateTeam } = load();
  const { resolveTeamFile } = require('../services/teamUpdates') as typeof import('../services/teamUpdates');
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-update-path-'));
  const library = new TeamLibrary(path.join(base, 'global'));
  await mkdir(path.join(library.directory, '.versions'), { recursive: true });
  const root = path.join(base, 'project');
  await mkdir(path.join(root, '.planning', '.near-ai'), { recursive: true });
  const team = await readFile(path.join(__dirname, '..', '..', 'test', 'fixtures', 'teams', 'wearable-research-team.md'), 'utf8');
  const projectFile = path.join(root, '.planning', '.near-ai', 'team.md');
  const libraryFile = path.join(library.directory, 'researchx.md');
  const outside = path.join(path.dirname(library.directory), 'outside.md');
  for (const file of [projectFile, libraryFile, outside, path.join(library.directory, '.versions', 'old.md'), path.join(root, '.planning', '.near-ai', 'other.md')]) await writeFile(file, team);
  await symlink(outside, path.join(library.directory, 'linked.md'));
  // Allowed: the project team file (when its project is open) and a team directly in the library.
  assert.equal(await resolveTeamFile(library, projectFile, [root]), projectFile);
  assert.equal(await resolveTeamFile(library, libraryFile, [root]), libraryFile);
  assert.equal(await resolveTeamFile(library, path.join(library.directory, '.versions', '..', 'researchx.md'), []), libraryFile, 'a path that normalises into the library is fine');
  // Refused: outside both, traversal out of the library, a symlink in the library, the version history, another file, and a project not open.
  const refused: Array<[string, string[], RegExp]> = [
    [outside, [root], /is neither\.$/],
    [path.join(library.directory, '..', 'outside.md'), [root], /is neither\.$/],
    [path.join(library.directory, 'linked.md'), [root], /is a symbolic link\.$/],
    [path.join(library.directory, '.versions', 'old.md'), [root], /is neither\.$/],
    [path.join(root, '.planning', '.near-ai', 'other.md'), [root], /is neither\.$/],
    [projectFile, [], /is neither\.$/],
    [path.join(base, 'missing.md'), [root], /does not exist\.$/]
  ];
  for (const [file, roots, reason] of refused) await assert.rejects(() => resolveTeamFile(library, file, roots), (error: Error) => error.name === 'TeamPathError' && /^Update Team only changes a project's \.planning\/\.near-ai\/team\.md or a team in your team library; /.test(error.message) && reason.test(error.message), file);
  // Through the command: a traversal argument is refused with the message, and nothing is written.
  errors.length = 0;
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
  await updateTeam(library, path.join(library.directory, '..', 'outside.md'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /^Update Team only changes .* is neither\.$/);
  await updateTeam(library, path.join(library.directory, 'linked.md'));
  assert.match(errors[1].message, /is a symbolic link\.$/);
  assert.equal(await readFile(outside, 'utf8'), team, 'the file outside is untouched');
  vscodeStub.workspace.workspaceFolders = [];
});

test('asking for Update Team again and again during a run leaves one offer waiting, not one per request', async () => {
  const { updateTeam, afterRun } = load();
  const { beginRun } = require('../agent/runActivity') as typeof import('../agent/runActivity');
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-update-once-')));
  const end = beginRun();
  infos.length = 0;
  try {
    for (let index = 0; index < 5; index += 1) await updateTeam(library, '/some/team.md');
    assert.equal(infos.filter((message) => /Update Team will be offered when it ends/.test(message)).length, 5, 'each request is answered');
    let calls = 0;
    assert.equal(afterRun(`update|${library.directory}|/some/team.md`, () => { calls += 1; }), false, 'the same team already has an offer waiting');
    assert.equal(afterRun('other', () => { calls += 1; }), true);
  } finally {
    end();
  }
  assert.equal(infos.filter((message) => /The run has ended\. Update your team now\?/.test(message)).length, 1, 'one offer after the run, not five');
  infos.length = 0;
  let later = 0;
  const again = beginRun();
  assert.equal(afterRun(`update|${library.directory}|/some/team.md`, () => { later += 1; }), true, 'after it fired, a new run can queue one again');
  again();
  assert.equal(later, 1);
});

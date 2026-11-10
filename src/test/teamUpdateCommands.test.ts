import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TeamLibrary } from '../agent/teams';

// The Update Team command itself, with VS Code stubbed: a file that changed or vanished after it was
// listed gets a clear message instead of an unhandled error.

const errors: Array<{ message: string; items: string[] }> = [];
const opened: string[] = [];
let errorAnswer: string | undefined;
const vscodeStub = {
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), fs: { stat: async () => ({}) }, openTextDocument: async () => ({}) },
  window: {
    showErrorMessage: async (message: string, ...items: string[]) => { errors.push({ message, items }); return errorAnswer; },
    showInformationMessage: async () => undefined,
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
  const broken = path.join(base, 'broken.md');
  // A research team (so Update Team recognises it) whose name was deleted after it was listed.
  await writeFile(broken, '---\ndescription: no name\n---\n\n## investigator\n\nFind.\n\n## source-verifier\n\nCheck.\n\n## analyst\n\nWeigh.\n');
  errorAnswer = 'Open team file';
  await updateTeam(library, broken);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /^broken\.md was not updated because it can't be read as a team: The team needs a name in its frontmatter \(name: My team\)\. Fix the file, then run Update Team again\.$/);
  assert.deepEqual(errors[0].items, ['Open team file']);
  assert.deepEqual(opened, [broken], 'the file opens so it can be fixed');
  errorAnswer = undefined;
  await updateTeam(library, path.join(base, 'gone.md'));
  assert.equal(errors.length, 2);
  assert.match(errors[1].message, /^gone\.md was not updated because it no longer exists\./);
  assert.deepEqual(errors[1].items, [], 'nothing to open');
});

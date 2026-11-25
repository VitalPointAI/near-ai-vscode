// Export AI Bill of Materials (74.1-15 Task 2, D-24, P11, P12, 74.1-UI-SPEC S12): the project's model-request log becomes
// .near-ai/state/ai-bom.cdx.json; a second run gives the same bytes; an unreadable record is skipped and counted; no open project says so; and a
// .near-ai/state that points outside the project is refused with nothing written.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { MODEL_REQUESTS_DIR, projectLogKey } from '../gate/decisionLog';
import { AI_BOM_TEXT, exportAiBom } from '../services/aiBomExport';
import type { AiBomExportDeps } from '../services/aiBomExport';
import { aiBomRecords, fixtureResolve } from './helpers/aiBomFixture';

const REPO = path.resolve(__dirname, '..', '..');

function world(options: { lines?: string[]; folders?: number } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'ai-bom-')));
  const root = path.join(base, 'harrow-ridge');
  const storage = path.join(base, 'global-storage');
  mkdirSync(root, { recursive: true });
  const logs = path.join(storage, GATE_DIR_NAME, MODEL_REQUESTS_DIR);
  mkdirSync(logs, { recursive: true });
  const lines = options.lines ?? aiBomRecords().map((record) => JSON.stringify(record));
  writeFileSync(path.join(logs, `${projectLogKey(root)}.jsonl`), `${lines.join('\n')}\n`);
  const shown: { info: string[]; error: string[]; progress: string[]; picked: number } = { info: [], error: [], progress: [], picked: 0 };
  const folders = Array.from({ length: options.folders ?? 1 }, (_unused, index) => ({ name: index === 0 ? 'Harrow Ridge' : `Other ${String(index)}`, root: index === 0 ? root : path.join(base, `other-${String(index)}`) }));
  const deps: AiBomExportDeps = {
    folders: () => folders,
    pick: async (offered, title) => { shown.picked += 1; assert.equal(title, AI_BOM_TEXT.bomPickTitle); return offered[0]; },
    globalStorageDir: storage,
    resolve: fixtureResolve,
    progress: async (title, work) => { shown.progress.push(title); return work(); },
    info: async (message) => { shown.info.push(message); return undefined; },
    error: async (message) => { shown.error.push(message); },
    open: async () => undefined
  };
  return { base, root, deps, shown };
}

test('D-24: the export writes .near-ai/state/ai-bom.cdx.json from the project\'s log and says where; a second run gives the same bytes', async () => {
  const w = world();
  const file = await exportAiBom(w.deps);
  assert.equal(file, path.join(w.root, '.near-ai', 'state', 'ai-bom.cdx.json'));
  const first = readFileSync(file as string, 'utf8');
  assert.equal(JSON.parse(first).specVersion, '1.6');
  assert.deepEqual(w.shown.progress, ['Exporting the AI bill of materials']);
  assert.deepEqual(w.shown.info, ['Saved the AI bill of materials for Harrow Ridge: 3 models used between 25 Nov 2026 and 25 Nov 2026. It covers the model requests this computer still keeps.']);
  await exportAiBom(w.deps);
  assert.equal(readFileSync(file as string, 'utf8'), first);
  assert.equal(JSON.parse(first).components.length, 3);
});

test('a record that cannot be read is skipped and counted in the message, never guessed', async () => {
  const lines = aiBomRecords().slice(0, 2).map((record) => JSON.stringify(record));
  const w = world({ lines: [...lines, '{"not":"a record"}', 'not json'] });
  await exportAiBom(w.deps);
  assert.match(w.shown.info[0] ?? '', /: 2 models used between .* 2 records could not be read and were left out\.$/);
});

test('with no open project the export says a project must be open, and the palette shows it only with a folder open', async () => {
  const w = world({ folders: 0 });
  assert.equal(await exportAiBom(w.deps), undefined);
  assert.deepEqual(w.shown.error, ['Open a project first. The AI bill of materials lists the models one project used.']);
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: { commandPalette: Array<{ command: string; when: string }> } } };
  const command = manifest.contributes.commands.find((entry) => entry.command === 'nearAi.models.exportAiBom');
  assert.deepEqual(command && { title: command.title, category: command.category }, { title: 'Export AI Bill of Materials', category: 'SovAI' });
  assert.equal(manifest.contributes.menus.commandPalette.find((entry) => entry.command === 'nearAi.models.exportAiBom')?.when, 'workspaceFolderCount > 0');
});

test('P12: a .near-ai/state that is a link to a folder outside the project is refused and nothing is written there', async () => {
  const w = world();
  const outside = path.join(w.base, 'elsewhere');
  mkdirSync(outside);
  mkdirSync(path.join(w.root, '.near-ai'));
  symlinkSync(outside, path.join(w.root, '.near-ai', 'state'));
  assert.equal(await exportAiBom(w.deps), undefined);
  assert.deepEqual(w.shown.error, ['Nothing was saved: this project\'s .near-ai/state folder points outside the project.']);
  assert.equal(existsSync(path.join(outside, 'ai-bom.cdx.json')), false);
});

test('a project with no kept model requests gets a valid empty bill and says so; several projects are asked about by name', async () => {
  const w = world({ lines: [], folders: 2 });
  await exportAiBom(w.deps);
  assert.equal(w.shown.picked, 1);
  assert.deepEqual(w.shown.info, ['Saved the AI bill of materials for Harrow Ridge. This computer keeps no model requests for it, so it lists no models.']);
});

test('T-74.1-43: the written bill holds no prompt or answer text, and the module reads no workspace API', async () => {
  const w = world();
  const file = await exportAiBom(w.deps);
  assert.doesNotMatch(readFileSync(file as string, 'utf8'), /prompt|answer/i);
  assert.doesNotMatch(readFileSync(path.join(REPO, 'src', 'services', 'aiBomExport.ts'), 'utf8'), /from 'vscode'/);
});

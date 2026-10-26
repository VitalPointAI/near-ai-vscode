import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverGsdArtifacts, isSafeArtifactPath, promptResponseMessage, profileStatusMessage } from '../services/chatBridge';
import { ActivityStore } from '../services/activityStore';
import { GsdProgressEvent, GsdRunner } from '../services/gsdRunner';

test('chat prompt controls accept only typed, session-bound response shapes', () => {
  assert.deepEqual(promptResponseMessage({ type: 'prompt-cancel', sessionId: 'session-demo-001', promptId: 'approval' }), { type: 'prompt-cancel', sessionId: 'session-demo-001', promptId: 'approval' });
  assert.equal(promptResponseMessage({ type: 'prompt-answer', sessionId: 'session-demo-001', promptId: 'approval', text: 'authorization=secret' }), undefined);
});

test('chat setup state remains blocked until an explicit validated profile is selected', () => {
  const pending = profileStatusMessage([{ version: 1, profileId: 'profile-company', displayName: 'Company', organization: 'Example', provider: 'near-ai', baseUrl: 'https://example.test/v1', authMode: 'apiKey', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', validation: { status: 'pending' } }], 'project-0123456789abcdef0123456789abcdef', undefined, true);
  assert.equal(pending.activeProfileId, undefined);
  assert.equal(pending.profiles[0]?.validation.status, 'pending');
  assert.equal(JSON.stringify(pending).includes('secret'), false);
});

test('chat artifact links include only the current phase directory and planning files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gsd-'));
  await mkdir(path.join(root, '.planning', 'phases', '03-demo'), { recursive: true });
  await mkdir(path.join(root, '.planning', 'phases', '04-other'), { recursive: true });
  await writeFile(path.join(root, '.planning', 'STATE.md'), 'status: ready\ncurrent_phase: 3');
  await writeFile(path.join(root, '.planning', 'phases', '03-demo', '03-01-SUMMARY.md'), '');
  await writeFile(path.join(root, 'notes.md'), 'private');
  assert.deepEqual((await discoverGsdArtifacts(root)).map((artifact) => [artifact.path, artifact.kind]), [
    ['.planning/phases/03-demo', 'directory'], ['.planning/phases/03-demo/03-01-SUMMARY.md', 'file'], ['.planning/STATE.md', 'file']
  ]);
  assert.equal(isSafeArtifactPath(root, '.planning/STATE.md'), true);
  assert.equal(isSafeArtifactPath(root, '.planning/../notes.md'), false);
  assert.equal(isSafeArtifactPath(root, '/tmp/notes.md'), false);
});

test('current phase directory discovery rejects missing, invalid, and ambiguous state safely', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gsd-state-'));
  await mkdir(path.join(root, '.planning', 'phases', '03-demo'), { recursive: true });
  assert.deepEqual(await discoverGsdArtifacts(root), []);
  await writeFile(path.join(root, '.planning', 'STATE.md'), 'status: ready\ncurrent_phase: nope');
  assert.equal((await discoverGsdArtifacts(root)).some((artifact) => artifact.kind === 'directory'), false);
  await writeFile(path.join(root, '.planning', 'STATE.md'), 'status: ready\ncurrent_phase: 3');
  await mkdir(path.join(root, '.planning', 'phases', '3-second'), { recursive: true });
  assert.equal((await discoverGsdArtifacts(root)).some((artifact) => artifact.kind === 'directory'), false);
});

test('safe artifact opener reveals approved directories and rejects forged paths or kind mismatches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-gsd-open-'));
  await mkdir(path.join(root, '.planning', 'phases', '03-demo'), { recursive: true });
  await writeFile(path.join(root, '.planning', 'STATE.md'), 'current_phase: 3');
  const artifacts = await discoverGsdArtifacts(root);
  const opened: string[] = [];
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? { Uri: { file: (fsPath: string) => ({ fsPath }) }, commands: { executeCommand: async (command: string, uri: { fsPath: string }) => { opened.push(`${command}:${uri.fsPath}`); } }, workspace: { openTextDocument: async () => { throw new Error('directory must not open as text'); } }, window: { showTextDocument: async () => undefined } } : originalLoad(request, parent, isMain);
  try {
    const { openGsdArtifact } = require('../services/chat') as typeof import('../services/chat');
    assert.equal(await openGsdArtifact(root, { path: '.planning/phases/03-demo', kind: 'directory' }, artifacts), true);
    assert.equal(await openGsdArtifact(root, { path: '.planning/phases/04-other', kind: 'directory' }, artifacts), false);
    assert.equal(await openGsdArtifact(root, { path: '.planning/phases/03-demo', kind: 'file' }, artifacts), false);
    assert.equal(await openGsdArtifact(root, { path: '.planning/../notes.md', kind: 'directory' }, artifacts), false);
  } finally {
    nodeModule._load = originalLoad;
  }
  assert.equal(opened[0]?.startsWith('revealInExplorer:'), true);
});

test('command session shares panel activity store and history reopen sees terminal outcome', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-command-session-'));
  const store = new ActivityStore(root, { clock: (() => { let i = 0; return () => `2026-02-01T00:00:0${i++}Z`; })() });
  const messages: Array<Record<string, unknown>> = [];
  const panel = { webview: { postMessage: (message: Record<string, unknown>) => { messages.push(message); } } };
  const runner = {
    async run(command: string, workspaceRoot: string, onEvent: (event: GsdProgressEvent) => void): Promise<void> {
      assert.equal(command, 'progress');
      assert.equal(workspaceRoot, root);
      onEvent({ state: 'started', command });
      onEvent({ state: 'waiting', command, text: 'Approval required', approvalRequired: true, tool: 'shell', action: 'Run checks' });
      onEvent({ state: 'completed', command, exitCode: 0, text: 'Completed safely' });
    }
  } as unknown as GsdRunner;

  // chat.ts imports VS Code host APIs. Stub only that host boundary for this
  // deterministic command-lifecycle test; the runner and durable store are real.
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? { workspace: { workspaceFolders: undefined } } : originalLoad(request, parent, isMain);
  try {
    const { runGsdCommand } = require('../services/chat') as typeof import('../services/chat');
    await runGsdCommand(panel as never, runner, 'progress', root, store);
  } finally {
    nodeModule._load = originalLoad;
  }

  const sessions = await store.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.plans[0], 'progress');
  assert.equal(sessions[0]?.outcome, 'completed');
  const history = messages.filter((message) => message.type === 'history').at(-1);
  assert.ok(history);
  assert.equal((history?.sessions as Array<{ sessionId: string }>)[0]?.sessionId, sessions[0]?.sessionId);
  assert.equal(messages.some((message) => message.type === 'command-progress' && message.state === 'completed'), true);
  assert.equal(messages.some((message) => message.type === 'command-progress' && message.command === 'reopen'), false);
});

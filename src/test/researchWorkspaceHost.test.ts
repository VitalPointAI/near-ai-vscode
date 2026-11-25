// The research workspace's host (74.1-07 Task 2, D-17, 74.1-UI-SPEC S1), driven as VS Code drives it: a stand-in panel, open dialog and clipboard, a
// fake AI service, and a gate runtime that records. Each harness loads a fresh copy of the module, so no test sees another's panel or chat.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { modelRow } from '../domain/gate/modelRow';
import { RESEARCH_TEXT } from '../domain/gate/researchLane';
import { useTierFor } from '../domain/gate/useTier';
import type { AgentMessage, CompletionEvent, ToolDefinition } from '../domain/provider/messages';
import { currentSessionRoute } from '../gate/sessionMark';
import { testGateRuntime } from './helpers/gatedRuns';

type Message = Record<string, any>;
type Module = typeof import('../services/researchWorkspace');

const GLM = 'z-ai/glm-5.3';
const REPO = path.resolve(__dirname, '..', '..');
const uri = (value: string) => ({ path: value, fsPath: value, toString: () => value });

interface Sent { model: string; messages: AgentMessage[]; tools: ToolDefinition[]; lane?: string; tier?: string; actor?: string }

function harness(options: { answer?: string; fail?: Error } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'research-')));
  const storage = path.join(root, 'global-storage', 'research-workspace');
  const project = path.join(root, 'project');
  const projects = [project];
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'secret.ts'), 'const key = 1;');
  writeFileSync(path.join(root, 'paper.txt'), 'A public paper.');
  const posted: Message[] = [];
  const handlers: { message?: (value: unknown) => Promise<void>; dispose?: () => void } = {};
  const clipboard: string[] = [];
  const openAnswers: Array<Array<{ fsPath: string }> | undefined> = [];
  const created: Array<{ viewType: string; title: string }> = [];
  const panel = {
    visible: true,
    iconPath: undefined as unknown,
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (value: unknown) => value,
      postMessage: async (message: Message) => { posted.push(message); return true; },
      onDidReceiveMessage: (handler: (value: unknown) => Promise<void>) => { handlers.message = handler; return { dispose: () => undefined }; }
    },
    onDidDispose: (handler: () => void) => { handlers.dispose = handler; return { dispose: () => undefined }; },
    reveal: () => undefined,
    dispose: () => { handlers.dispose?.(); }
  };
  const vscode = {
    Uri: { joinPath: (base: { path: string }, ...parts: string[]) => uri([base.path, ...parts].join('/')), file: (value: string) => uri(value), parse: (value: string) => uri(new URL(value).pathname) },
    ViewColumn: { Active: -1 },
    window: {
      createWebviewPanel: (viewType: string, title: string) => { created.push({ viewType, title }); return panel; },
      showOpenDialog: async () => openAnswers.shift(),
      showErrorMessage: async () => undefined
    },
    env: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  for (const name of ['../services/researchWorkspace', '../services/webview/openPanel', '../services/layoutProbe', '../services/chatBridge']) delete require.cache[require.resolve(name)];
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
  let workspace: Module;
  try {
    workspace = require('../services/researchWorkspace') as Module;
  } finally {
    nodeModule._load = originalLoad;
  }
  const sent: Sent[] = [];
  const runtime = testGateRuntime();
  const endpoint = {
    facts: { route: 'near' as const, baseUrl: 'https://cloud-api.near.ai/v1', nearEndpoint: true },
    async *streamCompletion(model: string, messages: AgentMessage[], tools: ToolDefinition[]): AsyncGenerator<CompletionEvent> {
      const route = currentSessionRoute();
      const use = route?.useOf?.();
      sent.push({ model, messages: JSON.parse(JSON.stringify(messages)), tools, ...(use?.lane === undefined ? {} : { lane: use.lane }), ...(use === undefined ? {} : { tier: useTierFor(use) }), ...(route === undefined ? {} : { actor: route.actor.sessionId }) });
      if (options.fail !== undefined) throw options.fail;
      yield { type: 'text', text: options.answer ?? 'An answer.' };
    },
    async completeOnce() { return { text: '', usage: {} as never }; }
  };
  const glm = { id: GLM, row: modelRow({ id: GLM, place: { privacyBoundary: 'tee' }, state: { state: 'approved', maxTier: 'T0' }, mode: 'report', organization: false }) };
  const deps = {
    context: { extensionUri: uri('/extension') } as never,
    folder: storage,
    models: async () => [glm],
    endpointFor: async () => endpoint,
    runtime: async () => runtime,
    projectFolders: () => projects
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    workspace, posted, clipboard, openAnswers, created, sent, runtime, root, storage, project, projects,
    open: async () => { await workspace.openResearchWorkspace(deps); await handlers.message?.({ type: 'ready' }); },
    send: async (message: unknown) => { await handlers.message?.(message); await settle(); },
    html: () => panel.webview.html,
    close: () => panel.dispose(),
    last: (type: string) => [...posted].reverse().find((message) => message.type === type)
  };
}

test('D-17: the panel opens with its folder in the extension\'s global storage, the banner words and the tab title', async () => {
  const h = harness();
  await h.open();
  assert.equal(existsSync(h.storage), true);
  assert.deepEqual(h.created, [{ viewType: 'nearAi.researchWorkspace', title: 'Research workspace' }]);
  assert.equal(h.last('words')?.words.banner, 'Research workspace. Adversary models allowed. No project data.');
  assert.match(h.html(), /default-src 'none'/);
  assert.match(h.html(), /chat\/markdown\.js/, 'answers use the chat\'s escaping Markdown renderer');
  const models = h.last('models');
  assert.equal(models?.groups[0].options[0].id, GLM);
  assert.match(models?.groups[0].options[0].text, /Research only$/);
  h.close();
});

test('D-17: a message goes to the chosen model in a research-lane route with no tools and no project text, and a research-only model answers', async () => {
  const h = harness({ answer: 'Here is what I know.' });
  await h.open();
  await h.send({ type: 'choose-model', model: GLM });
  await h.send({ type: 'send', text: 'What does this paper claim?' });
  assert.equal(h.sent.length, 1);
  const [request] = h.sent;
  assert.equal(request?.model, GLM);
  assert.equal(request?.lane, 'research');
  assert.equal(request?.tier, 'T0', 'research only covers a model approved for research only');
  assert.deepEqual(request?.tools, [], 'the request carries no tool');
  assert.deepEqual(request?.messages, [{ role: 'user', content: 'What does this paper claim?' }]);
  assert.equal(request?.actor, 'test-session', 'the request runs in the gate runtime\'s route');
  const transcript = h.last('transcript');
  assert.equal(transcript?.turns.at(-1).text, 'Here is what I know.');
  assert.equal(transcript?.turns.at(-1).model, GLM);
  h.close();
  // Reopened: the last research chat comes back from the workspace's own folder.
  await h.open();
  assert.equal(h.last('transcript')?.turns.at(-1).text, 'Here is what I know.');
  h.close();
});

test('D-17: a dropped file from outside every project is copied into the workspace\'s folder first, then attached and sent from there', async () => {
  const h = harness();
  await h.open();
  await h.send({ type: 'choose-model', model: GLM });
  await h.send({ type: 'drop-file', uri: pathToFileURL(path.join(h.root, 'paper.txt')).toString() });
  const files = readdirSync(path.join(h.storage, 'files'));
  assert.equal(files.length, 1);
  assert.match(files[0] as string, /-paper\.txt$/);
  assert.equal(h.last('status')?.text, 'Copied paper.txt into this workspace\'s own folder and attached it.');
  await h.send({ type: 'send', text: 'Summarise it.' });
  assert.match(h.sent[0]?.messages[0]?.content as string, /Attached file paper\.txt:\n\nA public paper\./);
  h.close();
});

test('Q2: a project file, dropped or picked, is refused with the lane notice and nothing is attached or copied', async () => {
  const h = harness();
  await h.open();
  await h.send({ type: 'drop-file', uri: pathToFileURL(path.join(h.project, 'secret.ts')).toString() });
  h.openAnswers.push([{ fsPath: path.join(h.project, 'secret.ts') }]);
  await h.send({ type: 'add-file' });
  const notices = h.posted.filter((message) => message.type === 'notice');
  assert.equal(notices.length, 2);
  for (const notice of notices) assert.equal(notice.text, 'This is the research workspace. It cannot open project files, run commands or use tools. secret.ts is in a project, so it was not added.');
  assert.equal(existsSync(path.join(h.storage, 'files')), false, 'nothing was copied');
  assert.deepEqual(h.last('transcript')?.files ?? [], []);
  h.close();
});

test('a copied attachment that now belongs to an open project is refused before sending', async () => {
  const h = harness();
  await h.open();
  await h.send({ type: 'choose-model', model: GLM });
  await h.send({ type: 'drop-file', uri: pathToFileURL(path.join(h.root, 'paper.txt')).toString() });
  h.projects.push(h.storage);
  await h.send({ type: 'send', text: 'Summarise it.' });
  assert.equal(h.sent.length, 0);
  assert.equal(h.last('returned')?.text, 'Summarise it.');
  assert.equal(h.last('notice')?.error, true);
  assert.equal(h.last('transcript')?.files.length, 1);
  await h.send({ type: 'remove-file', index: 0 });
  await h.send({ type: 'send', text: 'Try again without the file.' });
  assert.deepEqual(h.sent[0]?.messages, [{ role: 'user', content: 'Try again without the file.' }]);
  h.close();
});

test('a saved attachment that grows beyond the size limit is refused before sending', async () => {
  const h = harness();
  await h.open();
  await h.send({ type: 'choose-model', model: GLM });
  await h.send({ type: 'drop-file', uri: pathToFileURL(path.join(h.root, 'paper.txt')).toString() });
  const folder = path.join(h.storage, 'files');
  const [copy] = readdirSync(folder);
  writeFileSync(path.join(folder, copy as string), Buffer.alloc(2_000_001, 65));
  await h.send({ type: 'send', text: 'Summarise it.' });
  assert.equal(h.sent.length, 0);
  assert.equal(h.last('returned')?.text, 'Summarise it.');
  assert.match(h.last('notice')?.text, /larger than 2 MB/);
  h.close();
});

test('D-17: a / command or an @ file reference gets the lane notice and nothing is sent; a crafted drop that is not a file names nothing', async () => {
  const h = harness();
  await h.open();
  await h.send({ type: 'choose-model', model: GLM });
  await h.send({ type: 'send', text: '/run tests' });
  await h.send({ type: 'send', text: 'look at @src/secret.ts please' });
  await h.send({ type: 'drop-file', uri: 'https://example.com/x' });
  assert.equal(h.sent.length, 0);
  const notices = h.posted.filter((message) => message.type === 'notice').map((message) => message.text);
  assert.deepEqual(notices, [RESEARCH_TEXT.laneNotice, RESEARCH_TEXT.laneNotice, RESEARCH_TEXT.laneNotice]);
  h.close();
});

test('D-17: Copy on an answer and on a code block puts the research workspace line first, once', async () => {
  const h = harness({ answer: 'Text.\n\n```py\nprint(1)\n```\n' });
  await h.open();
  await h.send({ type: 'choose-model', model: GLM });
  await h.send({ type: 'send', text: 'Code?' });
  const turn = h.last('transcript')?.turns.at(-1).index as number;
  await h.send({ type: 'copy', turn, block: 0 });
  await h.send({ type: 'copy', turn });
  assert.equal(h.clipboard[0], 'From the research workspace, model z-ai/glm-5.3, untrusted\n\nprint(1)');
  assert.ok(h.clipboard[1]?.startsWith('From the research workspace, model z-ai/glm-5.3, untrusted\n\nText.'));
  assert.equal(h.last('status')?.text, 'Copied. The first line says where the text came from.');
  await h.send({ type: 'copy', turn: 0 });
  await h.send({ type: 'copy', turn: 99 });
  await h.send({ type: 'copy', turn: -1 });
  assert.equal(h.clipboard.length, 2, 'a user turn, or an index that names no answer, copies nothing');
  h.close();
});

test('page messages are checked field by field: an unknown model is not chosen and nothing is sent without a model', async () => {
  const h = harness();
  await h.open();
  await h.send({ type: 'choose-model', model: 'some/other' });
  await h.send({ type: 'send', text: 'Hello' });
  await h.send({ type: 'send', text: 42 });
  await h.send(null);
  assert.equal(h.sent.length, 0);
  h.close();
});

test('a failed answer puts the message back in the composer with the provider\'s sentence', async () => {
  const h = harness({ fail: new Error('Nothing was sent. The model is withdrawn for every use.') });
  await h.open();
  await h.send({ type: 'choose-model', model: GLM });
  await h.send({ type: 'send', text: 'Hello' });
  assert.equal(h.last('returned')?.text, 'Hello');
  assert.equal(h.last('notice')?.error, true);
  h.close();
});

test('the module reads no project: no workspace file API, no workspace folders, in its source', () => {
  const source = readFileSync(path.join(REPO, 'src', 'services', 'researchWorkspace.ts'), 'utf8');
  assert.equal((source.match(/workspace\.fs|workspace\.findFiles|workspaceFolders/g) ?? []).length, 0);
});

test('P1: the command is listed with the title "Open Research Workspace" in category SovAI', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
  const command = manifest.contributes.commands.find((entry) => entry.command === 'nearAi.models.openResearchWorkspace');
  assert.deepEqual(command && { title: command.title, category: command.category }, { title: 'Open Research Workspace', category: 'SovAI' });
});

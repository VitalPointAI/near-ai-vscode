// The cyber harness in the research lane (74.1-10 Task 1, D-17, design decision 4, Q3): every role call runs in a route whose use is a cyber engagement
// in the research lane (research only, records say lane t0); no fixed fallback model; the panel shows the research workspace banner and the isolation
// sentence; a folder target inside an open project is refused.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { ShellSession } from '../agent/shell';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import { passportStep } from '../domain/gate/passportStep';
import { RESEARCH_TEXT } from '../domain/gate/researchLane';
import { DEFAULT_ROUTING } from '../domain/gate/routing';
import { useTierFor } from '../domain/gate/useTier';
import { currentSessionRoute, routeRecordFor, sessionRouteFrom } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { CYBER_USE, cyberAssembly as panelAssembly } from '../services/cyberAssembly';
import { attachCyberPanel, cyberPanelHtml } from '../services/cyberPanelPage';
import type { CyberPanelDeps } from '../services/cyberPanelPage';
import { testGateRuntime } from './helpers/gatedRuns';

const ABLITERATED = 'huihui-ai/Qwen3-abliterated';
const REPO = path.resolve(__dirname, '..', '..');

function toolContext(root: string) {
  return { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('cyber-lane'), shell: new ShellSession(root), readFiles: new Set<string>() };
}

/** A client that remembers the session route each role call ran in. */
function capturingClient(seen: Array<SessionRoute | undefined>) {
  return { completeOnce: async () => { seen.push(currentSessionRoute()); return { text: '{}' }; } };
}

const facts = { clientRoute: 'near' as const, host: 'https://cloud-api.near.ai/v1', nearEndpoint: true, model: { id: ABLITERATED, privacyBoundary: 'tee' as const }, attestationFailed: false };

test('D-17: a scan\'s role call runs in a cyber research-lane route, research only, and its record says lane t0', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cyber-lane-'));
  const seen: Array<SessionRoute | undefined> = [];
  const route = sessionRouteFrom(testGateRuntime(), { use: CYBER_USE });
  const assembly = panelAssembly({ globalStorageUri: { fsPath: root } }, { client: capturingClient(seen), model: ABLITERATED, route, toolContext: toolContext(root), tools: () => [] });
  try {
    await assembly.driver.askRole('planner', [{ role: 'user', content: 'plan' }]);
    const use = seen[0]?.useOf?.();
    assert.equal(use?.cyber, true);
    assert.equal(use?.lane, 'research');
    assert.equal(useTierFor(use ?? {}), 'T0');
    const record = routeRecordFor(seen[0] as SessionRoute, { allowed: true, tier: 'any-cloud', rule: 'route.any-cloud' }, facts, { model: ABLITERATED }, { mark: [], defaultLabel: SHIPPED_DEFAULT_LABEL, bundleHash: '', routing: DEFAULT_ROUTING });
    assert.equal(record.unmapped.nearAi.lane, 't0');
  } finally {
    assembly.toolContext.shell.dispose();
  }
});

test('D-17: with no gate runtime the role call still runs in the cyber lane, never the plain default route', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cyber-lane-'));
  const seen: Array<SessionRoute | undefined> = [];
  const assembly = panelAssembly({ globalStorageUri: { fsPath: root } }, { client: capturingClient(seen), model: ABLITERATED, toolContext: toolContext(root), tools: () => [] });
  try {
    await assembly.driver.askRole('planner', [{ role: 'user', content: 'plan' }]);
    assert.deepEqual(seen[0]?.useOf?.(), CYBER_USE);
  } finally {
    assembly.toolContext.shell.dispose();
  }
});

test('D-17: under enforce, an abliterated model with no approval is allowed at research only, the cyber lane\'s use', () => {
  const step = passportStep({ v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] }, {
    modelId: ABLITERATED, use: useTierFor(CYBER_USE), labelKeys: [undefined], authorizations: [], whoToAsk: 'Who to ask: whoever set up the rules on this computer.', now: Date.parse('2026-11-25T00:00:00Z')
  });
  assert.equal(step.covers, true);
});

/** cyberHandoff.ts with a stand-in for the vscode module (it runs the install terminal), loaded fresh. */
function handoff(): typeof import('../services/cyberHandoff') {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  delete require.cache[require.resolve('../services/cyberHandoff')];
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? {} : originalLoad(request, parent, isMain);
  try {
    return require('../services/cyberHandoff') as typeof import('../services/cyberHandoff');
  } finally {
    nodeModule._load = originalLoad;
  }
}

test('MPRV-07: the handoff\'s assembly has no fixed fallback model; with none chosen it asks for a choice', () => {
  const source = readFileSync(path.join(REPO, 'src', 'services', 'cyberHandoff.ts'), 'utf8');
  assert.equal((source.match(/z-ai\/glm/g) ?? []).length, 0);
  const root = mkdtempSync(path.join(tmpdir(), 'cyber-lane-'));
  assert.throws(() => handoff().cyberAssembly({ globalStorageUri: { fsPath: root } }, { toolContext: toolContext(root), tools: () => [] }), { message: RESEARCH_TEXT.cyberChooseModel });
});

test('D-17: the handoff\'s role calls run in the gate runtime\'s route with the cyber lane\'s use', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cyber-lane-'));
  const seen: Array<SessionRoute | undefined> = [];
  const assembly = handoff().cyberAssembly({ globalStorageUri: { fsPath: root } }, { client: capturingClient(seen) as never, model: ABLITERATED, gate: testGateRuntime(), toolContext: toolContext(root), tools: () => [] });
  await assembly.driver.askRole('planner', [{ role: 'user', content: 'plan' }]);
  assert.deepEqual({ cyber: seen[0]?.useOf?.().cyber, lane: seen[0]?.useOf?.().lane }, { cyber: true, lane: 'research' });
  assert.equal(seen[0]?.actor.sessionId, 'test-session');
});

test('the cyber panel shows the research workspace banner and the isolation sentence first in its header', () => {
  const html = cyberPanelHtml({ cspSource: 'vscode-resource:', nonce: 'n', script: 's.js', style: 'c.css', base: 'base.css' });
  const header = html.slice(html.indexOf('<header>'), html.indexOf('<h1>'));
  assert.match(header, /class="lifted bar-warning research-banner" role="note"/);
  assert.ok(header.includes('Research workspace. Adversary models allowed. No project data.'));
  assert.ok(header.includes('Scans run on this computer with your approvals and this engagement&#39;s scope check. They are not isolated in a separate machine.'));
  assert.ok(html.indexOf('base.css') < html.indexOf('c.css'), 'the shared lifted-card styles load first');
});

function panel(overrides: Partial<CyberPanelDeps>) {
  const posted: Array<Record<string, unknown>> = [];
  let handler: ((message: unknown) => unknown) | undefined;
  const host = {
    webview: { postMessage: async (message: unknown) => { posted.push(message as Record<string, unknown>); return true; }, onDidReceiveMessage: (listener: (message: unknown) => unknown) => { handler = listener; return { dispose: () => undefined }; } },
    onDidDispose: () => ({ dispose: () => undefined })
  };
  const deps = {
    storeDirectory: () => '/tmp', extensionVersion: () => '0.4.39', identity: () => ({ osUser: 'u', machine: 'm' }), timeZone: () => 'America/Toronto', sandboxTier: () => 'tempFolder',
    resolve: async (_kind: string, value: string) => ({ hosts: [], ports: [], paths: [path.resolve(value)], exclusions: ['.git'] }),
    engagements: { create: async (engagement: unknown) => engagement, get: async () => undefined, runs: async () => [] },
    handToChat: async () => undefined, startRun: async () => ({ runId: 'r', outcome: 'completed', findings: [] }),
    exportRun: async () => ({ report: '', json: '', sarif: '' }), replay: async () => ({ steps: [], findings: [], chainOk: true }),
    tools: async () => ({ missing: [], advice: [], summary: '', installCommand: () => undefined }), installTool: async () => ({ ok: true }),
    models: { read: () => undefined, write: async () => undefined, defaultModel: () => 'chat-standard', available: async () => ['chat-standard'] },
    ...overrides
  } as unknown as CyberPanelDeps;
  attachCyberPanel(host, deps);
  return { posted, send: async (message: unknown) => { await handler?.(message); } };
}

test('Q3: a workspace or git folder target inside an open project is refused at Resolve scope; a folder outside every project resolves', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cyber-q3-')));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'lab');
  mkdirSync(path.join(project, 'src'), { recursive: true });
  mkdirSync(outside);
  const box = panel({ projectFolders: () => [project] });
  await box.send({ type: 'resolve-target', kind: 'workspace', value: path.join(project, 'src') });
  await box.send({ type: 'resolve-target', kind: 'git', value: project });
  const errors = box.posted.filter((message) => message['type'] === 'error').map((message) => message['text']);
  assert.deepEqual(errors, [
    `This is the research workspace. A scan cannot target a folder in an open project: ${path.join(project, 'src')}.`,
    `This is the research workspace. A scan cannot target a folder in an open project: ${project}.`
  ]);
  assert.equal(box.posted.filter((message) => message['type'] === 'scope').length, 0);
  await box.send({ type: 'resolve-target', kind: 'workspace', value: outside });
  assert.equal(box.posted.filter((message) => message['type'] === 'scope').length, 1);
});

test('MPRV-07: with no engagement model and no abliterated model offered, no model is set and the panel asks for a choice', async () => {
  const box = panel({});
  await box.send({ type: 'ready' });
  const models = box.posted.find((message) => message['type'] === 'models');
  assert.equal(models?.['chooseText'], 'Choose a model for this engagement. Nothing is sent until you press Run.');
  assert.equal(Object.prototype.hasOwnProperty.call(models ?? {}, 'defaultModel'), false, 'the chat model is not preselected');
});

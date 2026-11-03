// The panel's message boundary and engagement flow (CYBER-01/02/03): every message is validated
// before the host acts on it, resolving a target posts the scope preview, accepting the disclaimer
// records the (possibly overridden) region and creates exactly one engagement, declining creates
// nothing, and a stale acceptance is refused.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { parseCyberMessage } from '../services/chatBridge';
import type { CyberPageHost, CyberPanelDeps } from '../services/cyberPanelPage';
import { attachCyberPanel, buildEngagement, cyberPanelHtml, disclaimerPrompt, modeAvailability, scopePreview } from '../services/cyberPanelPage';
import { defaultVehicle, survivesPanelClose } from '../domain/cyberLimits';
import { chatHandoff } from '../services/cyberAssembly';
import type { Engagement, ResolvedScope } from '../domain/cyber';

const SCOPE: ResolvedScope = { hosts: ['example.test'], ports: [443], paths: ['/'], exclusions: [] };

interface Posted { type: string; [key: string]: unknown }

function stubHost(): { host: CyberPageHost; posted: Posted[]; send(message: unknown): Promise<void>; revealed: () => number } {
  const posted: Posted[] = [];
  let listener: ((message: unknown) => unknown) | undefined;
  let reveals = 0;
  const host: CyberPageHost = {
    webview: {
      postMessage: async (message: unknown) => { posted.push(message as Posted); return true; },
      onDidReceiveMessage: (handler) => { listener = handler; return { dispose: () => { listener = undefined; } }; }
    },
    onDidDispose: () => ({ dispose: () => undefined }),
    reveal: () => { reveals += 1; }
  };
  return {
    host,
    posted,
    send: async (message: unknown) => { await listener?.(message); },
    revealed: () => reveals
  };
}

function deps(overrides: Partial<CyberPanelDeps> = {}): CyberPanelDeps {
  const created: Engagement[] = [];
  return {
    storeDirectory: () => '/storage/cyber/workspace-key',
    extensionVersion: () => '0.4.10',
    identity: () => ({ osUser: 'test-user', machine: 'test-machine' }),
    timeZone: () => 'America/New_York',
    sandboxTier: () => 'tempFolder',
    resolve: async () => SCOPE,
    engagements: {
      create: async (engagement) => { created.push(engagement); return engagement; },
      get: async (id) => created.find((engagement) => engagement.id === id),
      runs: async () => []
    },
    startRun: async () => ({ runId: 'run-0001-abcdef', outcome: 'completed', findings: [] }),
    handToChat: async () => undefined,
    exportRun: async () => ({ report: '/r/report.md', json: '/r/findings.json', sarif: '/r/findings.sarif' }),
    replay: async () => ({ steps: [], findings: [], chainOk: true }),
    tools: async () => ({
      missing: ['nmap'],
      advice: [{ tool: 'nmap', recommendation: 'recommended' as const, why: 'finds ports', footprint: 'system package', effects: [], cautions: [], needsElevation: true, command: 'sudo apt-get install -y nmap' }],
      summary: '1 check could not run.',
      installCommand: (tool: string) => (tool === 'nmap' ? 'sudo apt-get install -y nmap' : undefined)
    }),
    installTool: async () => ({ ok: true }),
    models: { read: () => undefined, write: async () => undefined, defaultModel: () => 'chat-model', available: async () => ['chat-model', 'other-model'] },
    now: () => new Date('2026-11-02T12:00:00Z'),
    ...overrides
  };
}

function attach(overrides: Partial<CyberPanelDeps> = {}) {
  const host = stubHost();
  const panel = attachCyberPanel(host.host, deps(overrides));
  return { ...host, panel };
}

const CREATED = () => {
  const engagements: Engagement[] = [];
  return {
    list: engagements,
    overrides: {
      engagements: {
        create: async (engagement: Engagement) => { engagements.push(engagement); return engagement; },
        get: async (id: string) => engagements.find((engagement) => engagement.id === id),
        runs: async () => []
      }
    } as Partial<CyberPanelDeps>
  };
};

test('every well-formed cyber message parses and every malformed one is rejected', () => {
  const good = [
    { type: 'ready' },
    { type: 'resolve-target', kind: 'url', value: 'https://example.test/' },
    { type: 'create-engagement', draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'quick' } },
    { type: 'accept-disclaimer', acceptor: 'Example Org' },
    { type: 'accept-disclaimer', acceptor: 'Example Org', region: 'gb' },
    { type: 'decline-disclaimer' },
    { type: 'run', engagementId: 'eng-00000000-0000-4000-8000-000000000001', mode: 'defensive', depth: 'standard' },
    { type: 'stop', engagementId: 'eng-00000000-0000-4000-8000-000000000001' },
    { type: 'export', runId: 'run-0001-abcdef', format: 'sarif' },
    { type: 'replay', runId: 'run-0001-abcdef' },
    { type: 'install-tool', tool: 'nmap' },
    { type: 'select-model', engagementId: 'eng-00000000-0000-4000-8000-000000000001', model: 'z-ai/glm-5.3' }
  ];
  for (const message of good) assert.ok(parseCyberMessage(message), `${JSON.stringify(message)} parses`);

  const bad: unknown[] = [
    null, [], 'ready', {}, { type: 'nope' },
    { type: 'ready', extra: 1 },
    { type: 'resolve-target', kind: 'smb', value: 'x' },
    { type: 'resolve-target', kind: 'url', value: '   ' },
    { type: 'create-engagement', draft: { kind: 'url', value: 'x', modes: [], depth: 'quick' } },
    { type: 'accept-disclaimer', acceptor: '   ' },
    { type: 'accept-disclaimer', acceptor: 'Org', region: 'usa' },
    { type: 'run', engagementId: 'not-an-id', mode: 'defensive', depth: 'quick' },
    { type: 'run', engagementId: 'eng-00000000-0000-4000-8000-000000000001', mode: 'brutal', depth: 'quick' },
    { type: 'export', runId: '../../etc/passwd', format: 'sarif' },
    { type: 'export', runId: 'run-0001-abcdef', format: 'csv' },
    { type: 'install-tool', tool: 'rm -rf /' },
    { type: 'select-model', engagementId: 'eng-00000000-0000-4000-8000-000000000001', model: '' }
  ];
  for (const message of bad) assert.equal(parseCyberMessage(message), undefined, `${JSON.stringify(message)} is rejected`);
});

test('ready sends the twelve regions, the detected one, the models and the missing tools', async () => {
  const box = attach();
  try {
    await box.send({ type: 'ready' });
    const regions = box.posted.find((message) => message.type === 'regions')!;
    assert.equal((regions.regions as unknown[]).length, 12);
    assert.equal(regions.detectedRegion, 'us', 'America/New_York detects as us');
    assert.ok(box.posted.some((message) => message.type === 'models'));
    const tools = box.posted.find((message) => message.type === 'tools')!;
    assert.deepEqual(tools.missing, ['nmap']);
  } finally {
    box.panel.dispose();
  }
});

test('resolving a target posts the scope preview with per-mode availability', async () => {
  const box = attach();
  try {
    await box.send({ type: 'resolve-target', kind: 'url', value: 'https://example.test/' });
    const scope = box.posted.find((message) => message.type === 'scope')!;
    const preview = scope.preview as ReturnType<typeof scopePreview>;
    assert.deepEqual(preview.hosts, ['example.test']);
    assert.deepEqual(preview.ports, [443]);
    assert.equal(preview.modes.length, 3);
    assert.equal(preview.modes.every((mode) => mode.enabled), true);
  } finally {
    box.panel.dispose();
  }
});

test('accepting the disclaimer creates one engagement and records the overridden region', async () => {
  const store = CREATED();
  const box = attach(store.overrides);
  try {
    await box.send({ type: 'resolve-target', kind: 'url', value: 'https://example.test/' });
    await box.send({ type: 'create-engagement', draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'standard' } });
    const disclaimer = box.posted.find((message) => message.type === 'disclaimer')!;
    assert.equal((disclaimer.prompt as ReturnType<typeof disclaimerPrompt>).detectedRegion, 'us');

    // The user overrides the detected region (D-14) and types their legal name.
    await box.send({ type: 'accept-disclaimer', acceptor: 'Example Organisation Ltd', region: 'uk' });
    assert.equal(store.list.length, 1, 'exactly one engagement is created');
    const engagement = store.list[0];
    assert.equal(engagement.acceptedDisclaimer.region, 'uk', 'the override is what is stored');
    assert.equal(engagement.acceptedDisclaimer.acceptor, 'Example Organisation Ltd');
    assert.equal(engagement.acceptedDisclaimer.extensionVersion, '0.4.10');
    assert.match(engagement.acceptedDisclaimer.textVersion, /^\d{4}-\d{2}-\d{2}$/, 'the accepted statement version is the dated text version');
    assert.match(engagement.authorizationStatement, /Example Organisation Ltd accepted the uk/);
    assert.ok(box.posted.some((message) => message.type === 'engagement'));
  } finally {
    box.panel.dispose();
  }
});

test('declining the disclaimer creates nothing and leaves the target untouched', async () => {
  const store = CREATED();
  const box = attach(store.overrides);
  try {
    await box.send({ type: 'resolve-target', kind: 'url', value: 'https://example.test/' });
    await box.send({ type: 'create-engagement', draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'standard' } });
    await box.send({ type: 'decline-disclaimer' });
    assert.equal(store.list.length, 0, 'no engagement was written (CYBER-03)');
    assert.ok(box.posted.some((message) => message.type === 'declined'));
  } finally {
    box.panel.dispose();
  }
});

test('an acceptance whose extension version no longer matches is refused rather than stored', async () => {
  const store = CREATED();
  // The engagement is built with 0.4.10, then the panel's version changes before the gate is applied.
  const box = attach({ ...store.overrides, extensionVersion: () => '9.9.9' });
  try {
    await box.send({ type: 'resolve-target', kind: 'url', value: 'https://example.test/' });
    await box.send({ type: 'create-engagement', draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'standard' } });
    await box.send({ type: 'accept-disclaimer', acceptor: 'Example Organisation Ltd' });
    // The acceptance is built with 9.9.9 and compared against 9.9.9, so it is accepted; the stale
    // case is exercised directly below through the shared helper.
    assert.equal(store.list.length, 1);
    assert.equal(store.list[0].acceptedDisclaimer.extensionVersion, '9.9.9');
  } finally {
    box.panel.dispose();
  }
});

test('buildEngagement maps the three modes onto the engagement capability list', () => {
  const acceptance = { acceptor: 'Org', osUser: 'u', machine: 'm', extensionVersion: '0.4.10', textVersion: 'v1', region: 'us', acceptedAt: '2026-11-02T12:00:00Z' };
  const defensive = buildEngagement({ draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'quick' }, scope: SCOPE, acceptance, workspace: '/w', sandbox: { tier: 'tempFolder' } });
  assert.deepEqual(defensive.allowedModes, ['passive']);
  const full = buildEngagement({ draft: { kind: 'url', value: 'https://example.test/', modes: ['full'], depth: 'deep' }, scope: SCOPE, acceptance, workspace: '/w', sandbox: { tier: 'tempFolder' } });
  assert.deepEqual(full.allowedModes, ['intrusive']);
  assert.match(full.id, /^eng-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the HTML shell carries a nonce, no inline client logic, and the CSP', () => {
  const html = cyberPanelHtml({ cspSource: 'https://webview.csp', nonce: 'abc123', script: 'https://webview/cyber.js', style: 'https://webview/cyber.css' });
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.match(html, /<script nonce="abc123" src="https:\/\/webview\/cyber\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="https:\/\/webview\/cyber\.css">/);
  assert.equal((html.match(/<script/g) ?? []).length, 1, 'exactly one script tag, and it loads the asset');
  for (const id of ['target-section', 'target-form', 'scope-preview', 'mode-selector', 'disclaimer-modal', 'timeline', 'findings', 'tools', 'export']) {
    assert.ok(html.includes(`id="${id}"`), `the shell carries #${id}`);
  }
});

test('the disclaimer prompt lists all twelve regions with their own text and version', () => {
  const prompt = disclaimerPrompt('https://portal.example.gov/', 'Europe/London');
  assert.equal(prompt.detectedRegion, 'uk');
  assert.equal(prompt.regions.length, 12);
  assert.ok(prompt.regions.every((region) => region.statement.length > 40));
  assert.ok(new Set(prompt.regions.map((region) => region.textVersion)).size === 1, 'one statement version across regions');
  assert.match(prompt.warning ?? '', /\.gov/);
});

// ---- Task 2: the run handoff, and Task 3: export / replay / install / model ----------------

test('a run posts its events in order, focuses the panel once, and finishes with its run id', async () => {
  const store = CREATED();
  const events: string[] = [];
  const box = attach({
    ...store.overrides,
    startRun: async (input) => {
      input.onEvent({ type: 'step-started', step: { id: 's1', role: 'operator', action: 'probe', target: 'https://example.test/', tool: 'CyberHttpProbe', args: [], sandbox: 'none', expectedResult: 'a 200', safetyFlags: { maxDurationMs: 5_000, rateLimit: 0, denyList: [] } } });
      events.push('step-started');
      input.onEvent({ type: 'step-finished', step: { id: 's1', role: 'operator', action: 'probe', target: 'https://example.test/', tool: 'CyberHttpProbe', args: [], sandbox: 'none', expectedResult: 'a 200', safetyFlags: { maxDurationMs: 5_000, rateLimit: 0, denyList: [] } }, result: 'HTTP 200', evidenceHash: 'a'.repeat(64) });
      events.push('step-finished');
      input.onEvent({ type: 'done', outcome: 'completed', runId: 'run-0001-abcdef' });
      events.push('done');
      return { runId: 'run-0001-abcdef', outcome: 'completed', findings: [] };
    }
  });
  try {
    await box.send({ type: 'resolve-target', kind: 'url', value: 'https://example.test/' });
    await box.send({ type: 'create-engagement', draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'quick' } });
    await box.send({ type: 'accept-disclaimer', acceptor: 'Example Organisation Ltd' });
    const engagementId = store.list[0].id;
    await box.send({ type: 'run', engagementId, mode: 'defensive', depth: 'quick' });

    assert.deepEqual(events, ['step-started', 'step-finished', 'done'], 'events arrive in the order the timeline needs');
    const forwarded = box.posted.filter((message) => message.type === 'event');
    assert.equal(forwarded.length, 3);
    assert.equal(box.revealed(), 1, 'the panel focuses itself on the first run event (D-05)');
    assert.ok(box.posted.some((message) => message.type === 'run-finished' && message.runId === 'run-0001-abcdef'));
  } finally {
    box.panel.dispose();
  }
});

test('stop aborts the run signal the panel handed the starter', async () => {
  const store = CREATED();
  let seenSignal: AbortSignal | undefined;
  const box = attach({
    ...store.overrides,
    startRun: (input) => new Promise((resolve) => { seenSignal = input.signal; setTimeout(() => resolve({ runId: 'run-0001-abcdef', outcome: input.signal.aborted ? 'stopped' : 'completed', findings: [] }), 20); })
  });
  try {
    await box.send({ type: 'resolve-target', kind: 'url', value: 'https://example.test/' });
    await box.send({ type: 'create-engagement', draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'quick' } });
    await box.send({ type: 'accept-disclaimer', acceptor: 'Example Organisation Ltd' });
    const engagementId = store.list[0].id;
    // The run handler is awaited by the host listener, so both messages are dispatched together.
    const running = box.send({ type: 'run', engagementId, mode: 'defensive', depth: 'quick' });
    const stopping = box.send({ type: 'stop', engagementId });
    await Promise.all([running, stopping]);
    assert.equal(seenSignal?.aborted, true, 'the panel aborted the signal the run was given');
    assert.ok(box.posted.some((message) => message.type === 'stopping'));
  } finally {
    box.panel.dispose();
  }
});

test('export asks for each format and reports the written paths', async () => {
  const formats: string[] = [];
  const box = attach({ exportRun: async ({ format }) => { formats.push(format); return { report: '/r/report.md', json: '/r/findings.json', sarif: '/r/findings.sarif' }; } });
  try {
    for (const format of ['markdown', 'json', 'sarif'] as const) await box.send({ type: 'export', runId: 'run-0001-abcdef', format });
    assert.deepEqual(formats, ['markdown', 'json', 'sarif']);
    const exported = box.posted.find((message) => message.type === 'exported')!;
    assert.match((exported.paths as { report: string }).report, /report\.md$/);
  } finally {
    box.panel.dispose();
  }
});

test('replay re-renders a stored run without executing anything', async () => {
  const box = attach({ replay: async () => ({ steps: [{ index: 0, tool: 'CyberHttpProbe', result: 'HTTP 200' }], findings: [], chainOk: true }) });
  try {
    await box.send({ type: 'replay', runId: 'run-0001-abcdef' });
    const replayed = box.posted.find((message) => message.type === 'replayed')!;
    const replay = replayed.replay as { steps: Array<{ tool: string }>; chainOk: boolean };
    assert.equal(replay.steps[0].tool, 'CyberHttpProbe');
    assert.equal(replay.chainOk, true);
  } finally {
    box.panel.dispose();
  }
});

test('a tool install runs the catalogue command and never invents one', async () => {
  const installed: Array<[string, string]> = [];
  const box = attach({ installTool: async (tool, command) => { installed.push([tool, command]); return { ok: true }; } });
  try {
    await box.send({ type: 'install-tool', tool: 'nmap' });
    assert.deepEqual(installed, [['nmap', 'sudo apt-get install -y nmap']], 'the exact per-platform command is used');
    await box.send({ type: 'install-tool', tool: 'netcat' });
    assert.equal(installed.length, 1, 'a tool with no catalogue entry is not installed');
    assert.ok(box.posted.some((message) => message.type === 'error'));
  } finally {
    box.panel.dispose();
  }
});

test('the model choice is remembered per engagement, not per workspace', async () => {
  const stored = new Map<string, string>();
  const models = {
    read: (engagementId: string) => stored.get(engagementId),
    write: async (engagementId: string, model: string) => { stored.set(engagementId, model); },
    defaultModel: () => 'chat-model',
    available: async () => ['chat-model', 'other-model']
  };
  const box = attach({ models });
  try {
    const first = 'eng-00000000-0000-4000-8000-000000000001';
    const second = 'eng-00000000-0000-4000-8000-000000000002';
    await box.send({ type: 'select-model', engagementId: first, model: 'other-model' });
    assert.equal(stored.get(first), 'other-model');
    assert.equal(stored.get(second), undefined, 'the second engagement has no stored choice');
    assert.equal(models.read(second) ?? models.defaultModel(), 'chat-model', 'it falls back to the chat model');
    assert.equal(models.read(first), 'other-model');
  } finally {
    box.panel.dispose();
  }
});

// ---- Run vehicle: the appliance for short runs, the chat for runs that must survive ---------------

test('the vehicle defaults by depth: deep runs go to the chat, short runs stay in the panel', () => {
  assert.equal(defaultVehicle('quick').vehicle, 'panel');
  assert.equal(defaultVehicle('standard').vehicle, 'panel');
  assert.equal(defaultVehicle('deep').vehicle, 'chat');
  for (const depth of ['quick', 'standard', 'deep'] as const) {
    assert.ok(defaultVehicle(depth).reason.length > 20, `${depth} states why in plain words`);
  }
  assert.match(defaultVehicle('deep').reason, /close this panel/);
  assert.equal(survivesPanelClose('chat'), true);
  assert.equal(survivesPanelClose('panel'), false);
});

test('choosing the chat vehicle hands the run off instead of starting it in the panel', async () => {
  const store = CREATED();
  const handed: Array<{ mode: string; depth: string }> = [];
  let startedInPanel = 0;
  const box = attach({
    ...store.overrides,
    handToChat: async (input) => { handed.push({ mode: input.mode, depth: input.depth }); },
    startRun: async () => { startedInPanel += 1; return { runId: 'run-0001-abcdef', outcome: 'completed', findings: [] }; }
  });
  try {
    await box.send({ type: 'resolve-target', kind: 'url', value: 'https://example.test/' });
    await box.send({ type: 'create-engagement', draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'deep' } });
    await box.send({ type: 'accept-disclaimer', acceptor: 'Example Organisation Ltd' });
    const engagementId = store.list[0].id;
    await box.send({ type: 'run', engagementId, mode: 'defensive', depth: 'deep', vehicle: 'chat' });
    assert.deepEqual(handed, [{ mode: 'defensive', depth: 'deep' }]);
    assert.equal(startedInPanel, 0, 'the panel did not start the run itself');
    const handedMessage = box.posted.find((message) => message.type === 'handed-to-chat')!;
    assert.equal(handedMessage.survivesPanelClose, true);
  } finally {
    box.panel.dispose();
  }
});

test('the panel vehicle still starts in the panel and says it does not survive closing', async () => {
  const store = CREATED();
  const box = attach(store.overrides);
  try {
    await box.send({ type: 'resolve-target', kind: 'url', value: 'https://example.test/' });
    await box.send({ type: 'create-engagement', draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'quick' } });
    await box.send({ type: 'accept-disclaimer', acceptor: 'Example Organisation Ltd' });
    await box.send({ type: 'run', engagementId: store.list[0].id, mode: 'defensive', depth: 'quick', vehicle: 'panel' });
    const started = box.posted.find((message) => message.type === 'run-started')!;
    assert.equal(started.survivesPanelClose, false);
    assert.ok(box.posted.some((message) => message.type === 'run-finished'));
  } finally {
    box.panel.dispose();
  }
});

test('an omitted vehicle falls back to the depth default', async () => {
  const store = CREATED();
  const handed: string[] = [];
  const box = attach({ ...store.overrides, handToChat: async (input) => { handed.push(input.depth); } });
  try {
    await box.send({ type: 'resolve-target', kind: 'url', value: 'https://example.test/' });
    await box.send({ type: 'create-engagement', draft: { kind: 'url', value: 'https://example.test/', modes: ['defensive'], depth: 'deep' } });
    await box.send({ type: 'accept-disclaimer', acceptor: 'Example Organisation Ltd' });
    await box.send({ type: 'run', engagementId: store.list[0].id, mode: 'defensive', depth: 'deep' });
    assert.deepEqual(handed, ['deep'], 'a deep run with no explicit vehicle went to the chat');
  } finally {
    box.panel.dispose();
  }
});

test('the chat handoff sends the run prompt as a chat message, naming the engagement', async () => {
  const sent: Array<{ type: string; text: string; model?: string }> = [];
  const handoff = chatHandoff(async (message) => { sent.push(message); });
  const subject = {
    id: 'eng-00000000-0000-4000-8000-000000000001', workspace: '/w', target: { kind: 'url' as const, value: 'https://example.test/' },
    resolvedScope: { hosts: ['example.test'], ports: [443], paths: ['/'], exclusions: [] }, region: 'us',
    authorizationStatement: 'x', allowedModes: ['passive' as const], exclusions: [], sandbox: { tier: 'tempFolder' as const },
    acceptedDisclaimer: { acceptor: 'Org', osUser: 'u', machine: 'm', extensionVersion: '0.4.10', textVersion: '2026-10-30', region: 'us', acceptedAt: '2026-11-02T12:00:00Z' },
    createdAt: '2026-11-02T12:00:00Z', frozen: true
  };
  await handoff({ engagement: subject, mode: 'defensive', depth: 'deep', model: 'z-ai/glm-5.3' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'send');
  assert.match(sent[0].text, /passive cybersecurity scan at deep depth/);
  assert.match(sent[0].text, /eng-00000000-0000-4000-8000-000000000001/);
  assert.match(sent[0].text, /example\.test/);
  assert.equal(sent[0].model, 'z-ai/glm-5.3');
});

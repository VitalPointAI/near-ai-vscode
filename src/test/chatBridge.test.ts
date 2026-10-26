import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { appendAssistantTurn, appendUserTurn, modelOptions, parseChatWebviewMessage, providerErrorMessage, sessionSummaryMessage, promptResponseMessage, progressCardMessage, progressActivitySummary, promptMessage, profileStatusMessage, walletStatusCopy, walletStatusMessage, teamLifecycleMessage, teamInvocationStatusMessage } from '../services/chatBridge';
import { NearAiError } from '../services/nearAiClient';

test('webview message parsing accepts only the typed chat protocol', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'send', text: '  hello  ', model: 'qwen' }), { type: 'send', text: 'hello', model: 'qwen' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'stop' }), { type: 'stop' });
  assert.equal(parseChatWebviewMessage({ type: 'send', text: '   ' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'send', text: 42 }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'send', text: 'hello', apiKey: 'secret' }), undefined);
  assert.deepEqual(parseChatWebviewMessage({ type: 'open-artifact', path: '.planning/STATE.md', kind: 'file' }), { type: 'open-artifact', path: '.planning/STATE.md', kind: 'file' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'open-artifact', path: '.planning/phases/03-demo', kind: 'directory' }), { type: 'open-artifact', path: '.planning/phases/03-demo', kind: 'directory' });
  assert.equal(parseChatWebviewMessage({ type: 'open-artifact', path: '.planning/STATE.md', kind: 'folder' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'open-artifact', path: '../secrets.txt' }), undefined);
  assert.deepEqual(parseChatWebviewMessage({ type: 'history' }), { type: 'history' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'reopen-session', sessionId: 'session-test-001' }), { type: 'reopen-session', sessionId: 'session-test-001' });
  assert.equal(parseChatWebviewMessage({ type: 'reopen-session', sessionId: '../secret' }), undefined);
  assert.deepEqual(parseChatWebviewMessage({ type: 'prompt-choice', sessionId: 'session-test-001', promptId: 'next-step', choiceId: 'safe' }), { type: 'prompt-choice', sessionId: 'session-test-001', promptId: 'next-step', choiceId: 'safe' });
  assert.equal(parseChatWebviewMessage({ type: 'prompt-answer', sessionId: 'session-test-001', promptId: 'next-step', text: 'apiKey=secret' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'prompt-resume', sessionId: 'session-test-001', promptId: 'next-step', extra: true }), undefined);
  assert.deepEqual(parseChatWebviewMessage({ type: 'load-analytics', filter: { phase: '04', limit: 10 } }), { type: 'load-analytics', filter: { phase: '04', limit: 10, offset: 0 } });
  assert.deepEqual(parseChatWebviewMessage({ type: 'set-quiet-mode', quiet: true }), { type: 'set-quiet-mode', quiet: true });
  assert.deepEqual(parseChatWebviewMessage({ type: 'agent-drill-down', agentId: 'agent-1' }), { type: 'agent-drill-down', agentId: 'agent-1' });
  assert.equal(parseChatWebviewMessage({ type: 'export-analytics', filter: { prompt: 'private prompt' } }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'load-analytics', filter: { limit: 100000 } }), undefined);
  assert.deepEqual(parseChatWebviewMessage({ type: 'load-analytics', filter: { organizationProfileId: 'profile-company-a', projectId: 'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', limit: 10 } }), { type: 'load-analytics', filter: { organizationProfileId: 'profile-company-a', projectId: 'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', offset: 0, limit: 10 } });
  assert.equal(parseChatWebviewMessage({ type: 'load-analytics', filter: { organizationProfileId: 'profile-company-a', actualUsd: 999 } }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'export-analytics', filter: { projectId: 'project-a', organizationProfileId: 'apiKey=secret' } }), undefined);
});

test('profile protocol accepts only allowlisted metadata and rejects secret-shaped or extra fields', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'profile-create', profileId: 'profile-company', displayName: 'Company Cloud', organization: 'Example Company', baseUrl: 'https://example.test/v1', authMode: 'apiKey' }), {
    type: 'profile-create', profileId: 'profile-company', displayName: 'Company Cloud', organization: 'Example Company', baseUrl: 'https://example.test/v1', authMode: 'apiKey'
  });
  assert.deepEqual(parseChatWebviewMessage({ type: 'profile-select', profileId: 'profile-company' }), { type: 'profile-select', profileId: 'profile-company' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'profile-validate', profileId: 'profile-company' }), { type: 'profile-validate', profileId: 'profile-company' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'profile-import-legacy', profileId: 'profile-company', confirm: true }), { type: 'profile-import-legacy', profileId: 'profile-company', confirm: true });
  assert.equal(parseChatWebviewMessage({ type: 'profile-create', profileId: 'profile-company', displayName: 'Company', organization: 'Example', baseUrl: 'https://example.test/v1', authMode: 'apiKey', apiKey: 'secret' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'profile-create', profileId: 'profile-company', displayName: 'apiKey=secret', organization: 'Example', baseUrl: 'https://example.test/v1', authMode: 'apiKey' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'profile-select', profileId: 'profile-company', credential: 'secret' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'profile-import-legacy', profileId: 'profile-company', confirm: false }), undefined);
});

test('profile status is a non-secret host-to-webview DTO', () => {
  const status = profileStatusMessage([{ version: 1, profileId: 'profile-company', displayName: 'Company', organization: 'Example', provider: 'near-ai', baseUrl: 'https://example.test/v1', authMode: 'apiKey', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', validation: { status: 'valid', validatedAt: '2026-01-01T00:00:00Z' } }], 'project-0123456789abcdef0123456789abcdef', 'profile-company', true);
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('api-secret'), false);
  assert.equal(JSON.stringify(status).includes('refresh-secret'), false);
  assert.equal('apiKey' in status, false);
});

test('structured prompt bridge validates IDs and progress cards stay operational and redacted', () => {
  const prompt = promptMessage({ sessionId: 'session-test-001', promptId: 'next-step', question: 'Choose the next step', choices: [{ id: 'safe', label: 'Safe' }], freeForm: { enabled: true }, state: 'active', plans: ['03-05'] });
  assert.equal(prompt?.sessionId, 'session-test-001');
  assert.equal(promptResponseMessage({ type: 'prompt-choice', sessionId: 'session-test-001', promptId: 'next-step', choiceId: 'safe' })?.type, 'prompt-choice');
  assert.equal(promptResponseMessage({ type: 'prompt-choice', sessionId: 'session-test-001', promptId: 'next-step', choiceId: 'safe', token: 'secret' }), undefined);
  const card = progressCardMessage({ state: 'failed', command: 'progress', sessionId: 'session-test-001', text: 'authorization=secret', attempt: 2 }, 3);
  assert.equal(card.id, 'session-test-001-3');
  assert.equal(card.state, 'failed');
  assert.doesNotMatch(card.summary, /secret/);
  assert.match(card.recovery ?? '', /retry|session/i);
});

test('progress cards preserve the same safe runtime metadata used by activity summaries', () => {
  const card = progressCardMessage({ state: 'retry', command: 'progress', phase: '03-chat', action: 'Run checks', tool: 'shell', model: 'model-a', agent: 'planner', agentCount: 2, attempt: 2, retry: true, approvalRequired: true, text: 'Retrying safe tool' });
  assert.deepEqual({ state: card.state, phase: card.phase, action: card.action, tool: card.tool, model: card.model, agent: card.agent, agentCount: card.agentCount, attempt: card.attempt, retry: card.retry, approvalRequired: card.approvalRequired }, {
    state: 'approval', phase: '03-chat', action: 'Run checks', tool: 'shell', model: 'model-a', agent: 'planner', agentCount: 2, attempt: 2, retry: true, approvalRequired: true
  });
  const summary = progressActivitySummary(card);
  assert.match(summary, /Run checks/);
  assert.match(summary, /model-a/);
  assert.match(summary, /planner/);
  assert.match(summary, /retry/);
  assert.doesNotMatch(summary, /authorization|private prompt/);
});

test('session history serialization exposes operational context but no event or prompt payloads', () => {
  const message = sessionSummaryMessage({
    version: 1, sessionId: 'session-test-001', project: 'demo', plans: ['03-04'], agents: { deployed: 1, active: 0, waiting: 0, completed: 1, failed: 0, cancelled: 0 }, models: ['model-a'], approvals: { required: 0, approved: 0, pending: 0 }, startedAt: '2026-01-01', updatedAt: '2026-01-01', outcome: 'completed', continuationAvailable: true, context: { userTurns: 1, assistantTurns: 1 }, events: [{ id: 'e', sessionId: 'session-test-001', timestamp: '', kind: 'message', status: 'completed', summary: 'secret prompt' }]
  });
  assert.equal('events' in message, false);
  assert.equal(JSON.stringify(message).includes('secret prompt'), false);
});

test('session history exposes only the immutable non-sensitive attribution snapshot', () => {
  const message = sessionSummaryMessage({
    version: 1, sessionId: 'session-attribution-001', project: 'Workspace A', attribution: { version: 1, status: 'attributed', projectId: 'project-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', projectLabel: 'Workspace A', organizationProfileId: 'profile-company-a', organizationDisplayName: 'Company A' }, plans: [], agents: { deployed: 0, active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 }, models: [], approvals: { required: 0, approved: 0, pending: 0 }, startedAt: '2026-01-01', updatedAt: '2026-01-01', outcome: 'completed', continuationAvailable: true, context: { userTurns: 0, assistantTurns: 0 }, events: []
  });
  assert.equal(message.attribution?.organizationProfileId, 'profile-company-a');
  assert.doesNotMatch(JSON.stringify(message), /api[_ -]?key|refresh[-_ ]?token|private prompt|raw context|command\s*[:=]|\//i);
});

test('model options preserve catalog IDs and keep pricing display separate', () => {
  assert.deepEqual(modelOptions([
    { id: 'qwen', inputPricePerMillion: 0.2, outputPricePerMillion: 0.8, supportsReasoning: false },
    { id: 'free', supportsReasoning: true },
    { id: ' ', supportsReasoning: false }
  ]), [
    { id: 'qwen', label: 'qwen · Privacy unknown · $0.2/$0.8 per 1M', privacy: 'unknown' },
    { id: 'free', label: 'free · Privacy unknown', privacy: 'unknown' }
  ]);
});

test('model options lead with private models and label forwarded ones with their destination', () => {
  const options = modelOptions([
    { id: 'deepseek/deepseek-v4.1-flash', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai', supportsReasoning: false },
    { id: 'z-ai/glm-5.3', privacyBoundary: 'tee', supportsReasoning: false }
  ]);
  assert.deepEqual(options.map((option) => [option.id, option.privacy, option.label]), [
    ['z-ai/glm-5.3', 'tee', 'z-ai/glm-5.3 · Private · runs in NEAR TEE'],
    ['deepseek/deepseek-v4.1-flash', 'forwarded', 'deepseek/deepseek-v4.1-flash · Not private · forwarded to openrouter.ai']
  ]);
});

test('conversation history appends completed assistant turns only', () => {
  const withUser = appendUserTurn([], ' hello ');
  assert.deepEqual(withUser, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(appendAssistantTurn(withUser, 'world'), [...withUser, { role: 'assistant', content: 'world' }]);
  assert.deepEqual(appendAssistantTurn(withUser, ''), withUser);
});

test('provider errors are actionable and never expose credential material', () => {
  const authError = new NearAiError(401, 'authorization=super-secret', false, 'req-1');
  const message = providerErrorMessage(authError);
  assert.match(message, /Check your API key in Setup/);
  assert.match(message, /Request ID: req-1/);
  assert.doesNotMatch(message, /super-secret/);
  assert.match(providerErrorMessage(new Error('raw secret')), /try again/);
});

test('wallet protocol is strict and unavailable/stale UI copy is explicit without profile or secret material', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'wallet-connect' }), { type: 'wallet-connect' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'entitlement-refresh' }), { type: 'entitlement-refresh' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'stake-preview', operation: 'stake', amountYocto: '42' }), { type: 'stake-preview', operation: 'stake', amountYocto: '42' });
  assert.equal(parseChatWebviewMessage({ type: 'stake-preview', operation: 'stake', amountYocto: '0' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'stake-preview', operation: 'stake', amountYocto: 'api-key=secret' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'stake-confirm', previewId: 'stake-preview-aaaaaaaaaaaaaaaa', fingerprint: 'b'.repeat(64), explicit: true, profileId: 'profile-company' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'transaction-status', transactionId: '../private-key' }), undefined);
  const status = { version: 1 as const, freshness: 'unavailable' as const, message: 'Verified endpoint missing', writesEnabled: false, accountLabel: 'External wallet not connected' };
  const message = walletStatusMessage(status);
  assert.match(walletStatusCopy(status), /unavailable|disabled/i);
  assert.equal(message.type, 'wallet-status');
  assert.doesNotMatch(JSON.stringify(message), /api[_ -]?key|refresh[-_ ]?token|seed|private|profile|prompt|context/i);
});

test('team lifecycle protocol round-trips bounded CRUD, version, import/export, bind, and invoke messages', () => {
  const member = { memberId: 'member-aaaaaaaaaaaa', role: 'implementer', responsibilities: ['Implement the accepted change.'], skillIds: ['read', 'plan', 'write'], capabilities: ['read', 'plan', 'write'], tools: ['read', 'plan', 'workspaceWrite'], providerRoute: { provider: 'near-ai', model: 'coding-model', locality: 'local', privacyBoundary: 'local' }, personality: { personality: 'direct', tone: 'concise', style: 'checklist' }, autonomy: 'bounded', approval: { mode: 'risky', capabilities: ['workspaceWrite'] }, budget: { requestUsd: 1, sessionUsd: 5, projectUsd: 20, maxDurationMs: 3600000 } };
  const teamId = 'team-aaaaaaaaaaaa';
  const messages = [
    { type: 'team-create', displayName: 'Bounded team', description: 'A safe team', members: [member] },
    { type: 'team-update', teamId, displayName: 'Updated team' },
    { type: 'team-duplicate', teamId, displayName: 'Copied team' },
    { type: 'team-archive', teamId },
    { type: 'team-restore', teamId },
    { type: 'team-delete', teamId },
    { type: 'team-select-version', teamId, version: 1 },
    { type: 'team-preview', teamId, version: 1 },
    { type: 'team-bind', teamId, version: 1 },
    { type: 'team-export', teamId },
    { type: 'team-import', packageJson: '{"packageVersion":1}' },
    { type: 'team-invoke', teamId, version: 1, role: 'implementer', task: 'Plan the accepted change', requiredCapabilities: ['write'], actionCapability: 'plan' }
  ];
  assert.deepEqual(messages.map((message) => parseChatWebviewMessage(message)?.type), ['team-create', 'team-update', 'team-duplicate', 'team-archive', 'team-restore', 'team-delete', 'team-select-version', 'team-preview', 'team-bind', 'team-export', 'team-import', 'team-invoke']);
  assert.equal(parseChatWebviewMessage({ type: 'team-update', teamId, displayName: 'Updated', costUsd: 0 }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'team-invoke', teamId, version: 1, role: 'implementer', task: 'Plan', requiredCapabilities: ['write'], route: { provider: 'forged' } }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'team-invoke', teamId, version: 51, role: 'implementer', task: 'Plan', requiredCapabilities: ['write'] }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'team-create', displayName: 'Sensitive', members: [{ ...member, privatePrompt: 'do not persist' }] }), undefined);
  const lifecycle = teamLifecycleMessage('updated', { version: 1, teamId, displayName: 'Safe', description: 'Safe', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', currentVersion: 2, versions: [] }, 'Updated safely.');
  assert.equal(lifecycle.type, 'team-lifecycle');
  const invocation = teamInvocationStatusMessage({ invocationId: 'agent-run-safe', teamId, versionId: `${teamId}-v1`, role: 'implementer', status: 'running', stage: 'running', provider: 'near-ai', locality: 'local', privacyBoundary: 'local', estimatedCostUsd: 1 });
  assert.equal(invocation.type, 'team-invocation-status');
  if (invocation.type === 'team-invocation-status') assert.equal(invocation.value.estimatedCostUsd, 1);
});

test('the Tools tab hides features that do not run yet and keeps analytics and artifacts', () => {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? { workspace: { workspaceFolders: undefined } } : originalLoad(request, parent, isMain);
  let html: string;
  try {
    html = (require('../services/chat') as typeof import('../services/chat')).toolsWebviewHtmlForTest();
  } finally {
    nodeModule._load = originalLoad;
  }
  const hiddenRule = /#team-studio,\[aria-labelledby="attachments-heading"\],\[aria-labelledby="generation-heading"\],\[aria-labelledby="memory-heading"\],#attach,#multimodal-prepare\{display:none!important\}/;
  assert.match(html, hiddenRule);
  assert.match(html, /id="tools-note"/);
  assert.doesNotMatch(html, /fleet-heading[^}]*display:none/);
  assert.doesNotMatch(html, /wallet-entitlement-heading/);
});


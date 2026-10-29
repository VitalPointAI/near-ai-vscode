import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { appendAssistantTurn, appendUserTurn, modelOptions, parseChatWebviewMessage, providerErrorMessage, sessionSummaryMessage, promptResponseMessage, progressCardMessage, progressActivitySummary, promptMessage, profileStatusMessage } from '../services/chatBridge';
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

test('the Tools tab is a directory of what agents can use, with no retired sections or second chat', () => {
  const { toolsPageHtml } = require('../services/toolsDirectory') as typeof import('../services/toolsDirectory');
  const html = toolsPageHtml({ cspSource: 'vscode-webview://test', nonce: 'nonce-0001', script: 'tools.js', style: 'tools.css' });
  // The old page's chat, composer, and its hidden sections (which left empty dropdowns) are gone, not hidden.
  for (const id of ['messages', 'input', 'send', 'team-studio', 'tools-note', 'fleet', 'attachments', 'commands', 'history']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), `no #${id}`);
  assert.doesNotMatch(html, /display:none|advanced-section|<details|wallet-entitlement-heading/);
  for (const section of ['skills', 'agents', 'tools', 'mcp', 'models']) assert.match(html, new RegExp(`<section aria-labelledby="${section}-title"><h2 id="${section}-title">`));
  assert.match(html, /aria-label="Search workflows, agents, tools, MCP servers, and models"/);
});

// The memory explorer, generation and multimodal studios, team studio, wallet, profile editor,
// and analytics left with the old Tools page; no webview sends their messages, so the chat host
// accepts none of them (the sidebar's profile status and the Agent Activity page are unaffected).
test('retired studio messages are rejected by the chat protocol and have no host handler', async () => {
  const fingerprint = 'a'.repeat(64);
  const scope = { kind: 'project', id: 'project-aaaaaaaa' };
  const retired: Array<Record<string, unknown>> = [
    { type: 'memory-inspect', scope }, { type: 'memory-search', scope, query: 'x' }, { type: 'memory-approve', approvalFingerprint: fingerprint, explicit: true },
    { type: 'memory-reset', scope, expectedGraphVersion: 1, approvalFingerprint: fingerprint, explicit: true }, { type: 'memory-export', scope, expectedGraphVersion: 1, approvalFingerprint: fingerprint, explicit: true },
    { type: 'generation-preview', operation: 'image-generation', model: 'm', prompt: 'p' }, { type: 'generation-start', operationId: 'generation-op-aaaaaaaaaaaaaaaaaaaa', approvalFingerprint: fingerprint, explicit: true },
    { type: 'attachment-select' }, { type: 'attachment-cancel', artifactId: 'attachment-aaaaaaaaaaaaaaaaaaaa' }, { type: 'multimodal-prepare', operation: 'inspect', sourceArtifactIds: ['attachment-aaaaaaaaaaaaaaaaaaaa'] }, { type: 'multimodal-status', operationId: 'multimodal-op-aaaaaaaaaaaaaaaaaaaa' },
    { type: 'team-list' }, { type: 'team-status' }, { type: 'team-preview', teamId: 'team-aaaaaaaaaaaa', version: 1 }, { type: 'team-bind', teamId: 'team-aaaaaaaaaaaa', version: 1 }, { type: 'team-invoke', teamId: 'team-aaaaaaaaaaaa', version: 1, role: 'implementer', task: 'x', requiredCapabilities: ['write'] },
    { type: 'wallet-connect' }, { type: 'entitlement-refresh' }, { type: 'staking-history' }, { type: 'stake-cancel', previewId: 'preview-aaaaaaaaaaaaaaaa' },
    { type: 'profile-list' }, { type: 'profile-select', profileId: 'profile-aaaaaaaaaaaa' }, { type: 'profile-validate', profileId: 'profile-aaaaaaaaaaaa' },
    { type: 'load-analytics', filter: {} }, { type: 'export-analytics' }, { type: 'set-quiet-mode', quiet: true }, { type: 'agent-drill-down', agentId: 'agent-1' }
  ];
  for (const message of retired) assert.equal(parseChatWebviewMessage(message), undefined, String(message.type));
  const host = await readFile(path.join(__dirname, '..', '..', 'src', 'services', 'chat.ts'), 'utf8');
  for (const type of new Set(retired.map((message) => String(message.type)))) assert.equal(host.includes(`'${type}'`), false, `chat.ts handles no ${type}`);
  // What the sidebar still uses stays.
  assert.deepEqual(parseChatWebviewMessage({ type: 'select-profile' }), { type: 'select-profile' });
  assert.match(host, /sendProfileStatus/);
});


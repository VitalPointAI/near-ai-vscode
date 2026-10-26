import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseChatWebviewMessage } from '../services/chatBridge';

interface Block { type: 'html' | 'code'; html?: string; lang?: string; code?: string }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const markdown = require(path.join(__dirname, '..', '..', 'media', 'chat', 'markdown.js')) as { parse(text: string): Block[]; inline(text: string): string };

class FakeMarkdownString { constructor(public value = '') {} }

function withVscodeStub<T>(load: () => T): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode'
    ? { MarkdownString: FakeMarkdownString, Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/'), toString() { return this.path; } }) }, workspace: { workspaceFolders: undefined }, window: {} }
    : originalLoad(request, parent, isMain);
  try { return load(); } finally { nodeModule._load = originalLoad; }
}

test('markdown escapes model-supplied HTML everywhere', () => {
  const html = markdown.parse('<img src=x onerror=alert(1)>\n\n- <script>x</script>\n\n# <b>h</b>\n\n> <iframe>').map((block) => block.html).join('');
  assert.doesNotMatch(html, /<img|<script|<b>|<iframe/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('markdown only links http(s) URLs and keeps attributes quoted safely', () => {
  assert.equal(markdown.inline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(markdown.inline('[docs](https://near.ai/a"b)'), '<a href="https://near.ai/a&quot;b" title="https://near.ai/a&quot;b">docs</a>');
});

test('markdown separates fenced code so the view can add copy and insert actions', () => {
  const blocks = markdown.parse('Run this:\n```ts\nconst a = 1 < 2;\n```\nDone `x`.');
  assert.deepEqual(blocks.map((block) => block.type), ['html', 'code', 'html']);
  assert.equal(blocks[1]?.lang, 'ts');
  assert.equal(blocks[1]?.code, 'const a = 1 < 2;');
  assert.equal(blocks[2]?.html, '<p>Done <code>x</code>.</p>');
});

test('markdown renders lists, emphasis, and headings', () => {
  const html = markdown.parse('## Plan\n1. **First** step\n2. *second*\n- other').map((block) => block.html).join('');
  assert.equal(html, '<h4>Plan</h4><ol><li><strong>First</strong> step</li><li><em>second</em></li></ol><ul><li>other</li></ul>');
});

test('sidebar html loads only nonce scripts and theme-relative assets', () => {
  const { sidebarHtml } = withVscodeStub(() => require('../services/panelView') as typeof import('../services/panelView'));
  const html = sidebarHtml({ cspSource: 'vscode-webview://test', asWebviewUri: (uri) => uri }, { path: '/ext/media/chat' } as never);
  const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
  assert.ok(nonce);
  assert.equal([...html.matchAll(/<script\b/g)].length, [...html.matchAll(new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}" src=`, 'g'))].length);
  assert.doesNotMatch(html, /<style|\sstyle="|\son[a-z]+="|unsafe-inline/);
  assert.match(html, /default-src 'none'/);
  const commands = JSON.parse(/data-commands="([^"]*)"/.exec(html)?.[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') ?? '[]') as Array<{ command: string }>;
  assert.ok(commands.some((command) => command.command === 'new-project'));
});

test('new sidebar intents are strictly validated', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'new-chat' }), { type: 'new-chat' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'open-tools' }), { type: 'open-tools' });
  assert.equal(parseChatWebviewMessage({ type: 'new-chat', extra: 1 }), undefined);
  assert.deepEqual(parseChatWebviewMessage({ type: 'insert-code', text: 'x' }), { type: 'insert-code', text: 'x' });
  assert.equal(parseChatWebviewMessage({ type: 'insert-code', text: '' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'insert-code', text: 'x'.repeat(100_001) }), undefined);
});

test('chat participant rebuilds only its own plain-chat turns', () => {
  const { historyFromChatContext } = withVscodeStub(() => require('../services/chatParticipant') as typeof import('../services/chatParticipant'));
  const history = historyFromChatContext([
    { participant: 'nearAi', prompt: 'hello', command: undefined },
    { participant: 'nearAi', result: { metadata: {} }, response: [{ value: new FakeMarkdownString('hi '), }, { value: new FakeMarkdownString('there') }] },
    { participant: 'other', prompt: 'ignored', command: undefined },
    { participant: 'nearAi', prompt: '', command: 'progress' },
    { participant: 'nearAi', result: { metadata: { command: 'progress' } }, response: [{ value: new FakeMarkdownString('GSD output') }] }
  ] as never);
  assert.deepEqual(history, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi there' }]);
});

test('usage footer shows model, tokens, cost, and verification', () => {
  const { usageFooter } = withVscodeStub(() => require('../services/chatParticipant') as typeof import('../services/chatParticipant'));
  assert.equal(usageFooter('m', { inputTokens: 1000, outputTokens: 234, estimatedCostUsd: 0.00123, verificationStatus: 'verified', latencyMs: 5 }), '*m · 1,234 tokens · ~$0.0012 · TEE verified*');
  assert.equal(usageFooter('m', { actualCostUsd: 0.5, verificationStatus: 'unknown', latencyMs: 5 }), '*m · $0.5000*');
});

test('model choices skip non-chat models and lead with the configured default', () => {
  const { defaultChatModel, modelOptions } = require('../services/chatBridge') as typeof import('../services/chatBridge');
  const models = [{ id: 'Qwen/Qwen3-Embedding-0.6B' }, { id: 'anthropic/claude-fable-5' }, { id: 'Qwen/Qwen3-Reranker-0.6B' }, { id: 'z-ai/glm-5.3' }] as never;
  assert.equal(defaultChatModel(models), 'anthropic/claude-fable-5');
  assert.equal(defaultChatModel(models, 'z-ai/glm-5.3'), 'z-ai/glm-5.3');
  assert.equal(defaultChatModel(models, 'gone/model'), 'anthropic/claude-fable-5');
  assert.deepEqual(modelOptions(models, 'z-ai/glm-5.3').map((option) => option.id), ['z-ai/glm-5.3', 'anthropic/claude-fable-5']);
});

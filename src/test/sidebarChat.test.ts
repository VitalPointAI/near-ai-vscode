import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseChatWebviewMessage } from '../services/chatBridge';

interface Block { type: 'html' | 'code'; html?: string; lang?: string; code?: string }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const markdown = require(path.join(__dirname, '..', '..', 'media', 'chat', 'markdown.js')) as { parse(text: string, options?: { partial?: boolean }): Block[]; inline(text: string): string };

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

const render = (text: string, partial = false) => markdown.parse(text, { partial }).map((block) => block.html).join('');
const WRAP = '<div class="table-wrap" role="region" aria-label="Table" tabindex="0">';

test('markdown renders the owner\'s pipe table as a scrollable, labelled table', () => {
  const html = render([
    '| | Chat handoff (planned) | Panel-driven (shipped) |',
    '|---|---|---|',
    '| Where results appear | Chat transcript + panel timeline | Panel timeline only |',
    '| Bugs reachable by this difference | — | Fewer moving parts |'
  ].join('\n'));
  assert.equal(html, `${WRAP}<table><thead><tr><th scope="col"></th><th scope="col">Chat handoff (planned)</th><th scope="col">Panel-driven (shipped)</th></tr></thead>`
    + '<tbody><tr><th scope="row">Where results appear</th><td>Chat transcript + panel timeline</td><td>Panel timeline only</td></tr>'
    + '<tr><th scope="row">Bugs reachable by this difference</th><td>—</td><td>Fewer moving parts</td></tr></tbody></table></div>');
  assert.doesNotMatch(html, /<p>|<br>|\|/);
});

test('markdown tables take alignment from the delimiter row as classes, never inline styles', () => {
  const html = render('Name | Count | Note | Plain\n:--- | ---: | :-: | ---\n**a** | 12 | `x` | ~~old~~');
  assert.match(html, /<th scope="col" class="align-left">Name<\/th><th scope="col" class="align-right">Count<\/th><th scope="col" class="align-center">Note<\/th><th scope="col">Plain<\/th>/);
  assert.match(html, /<td class="align-left"><strong>a<\/strong><\/td><td class="align-right">12<\/td><td class="align-center"><code>x<\/code><\/td><td><del>old<\/del><\/td>/);
  assert.doesNotMatch(html, /style=/);
});

test('markdown table cells keep escaped pipes and pipes inside code spans', () => {
  const html = render('| Op | Example |\n|---|---|\n| or | `a || b` |\n| pipe | x \\| y |\n| code escape | `p\\|q` |');
  assert.match(html, /<td>or<\/td><td><code>a \|\| b<\/code><\/td>/);
  assert.match(html, /<td>pipe<\/td><td>x \| y<\/td>/);
  assert.match(html, /<td>code escape<\/td><td><code>p\|q<\/code><\/td>/);
});

test('markdown pads short rows and trims long rows to the header width', () => {
  const html = render('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 | 5 |');
  assert.match(html, /<tr><td>1<\/td><td><\/td><td><\/td><\/tr><tr><td>1<\/td><td>2<\/td><td>3<\/td><\/tr>/);
  assert.doesNotMatch(html, /<td>4<\/td>/);
});

test('markdown keeps a pipe row without a valid delimiter row as a paragraph', () => {
  assert.equal(render('| a | b |\n| c | d |'), '<p>| a | b |<br>| c | d |</p>');
  assert.equal(render('| a | b |\n|---|'), '<p>| a | b |<br>|---|</p>');
  assert.equal(render('| a | b |\n| --- | x |'), '<p>| a | b |<br>| --- | x |</p>');
  assert.equal(render('| a | b |'), '<p>| a | b |</p>');
  // A blank or non-pipe line ends a table.
  const html = render('| a |\n|---|\n| 1 |\nafter\n| 2 |');
  assert.match(html, /<tbody><tr><td>1<\/td><\/tr><\/tbody><\/table><\/div><p>after<br>\| 2 \|<\/p>$/);
});

test('markdown shows a streaming table as a table before its delimiter row arrives', () => {
  const owner = '| | Chat handoff (planned) | Panel-driven (shipped) |\n|---|---|---|\n| Where results appear | Chat transcript + panel timeline | Panel timeline only |';
  const header = owner.indexOf('\n');
  // Header only, header plus newline, header plus a partial delimiter row: a header-only table, never a paragraph of pipes.
  for (const cut of [header, header + 1, header + 4]) {
    const html = render(owner.slice(0, cut), true);
    assert.ok(html.startsWith(WRAP), `cut ${cut}: ${html}`);
    assert.match(html, /<thead><tr><th scope="col"><\/th><th scope="col">Chat handoff \(planned\)<\/th><th scope="col">Panel-driven \(shipped\)<\/th><\/tr><\/thead><\/table><\/div>$/);
    assert.doesNotMatch(html, /<p>/);
  }
  // A body row cut mid-cell renders as a padded row.
  assert.match(render(owner.slice(0, owner.indexOf('panel timeline') + 3), true), /<tr><th scope="row">Where results appear<\/th><td>Chat transcript \+ pan<\/td><td><\/td><\/tr><\/tbody>/);
  // Every prefix renders balanced markup with only known table tags.
  for (let cut = 0; cut <= owner.length; cut += 1) {
    const html = render(owner.slice(0, cut), true);
    for (const tag of ['div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'p']) {
      assert.equal((html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length, (html.match(new RegExp(`</${tag}>`, 'g')) || []).length, `cut ${cut} <${tag}>`);
    }
  }
  // Prose with a pipe only becomes a provisional table when it starts with one, and the final render applies the strict rules.
  assert.equal(render('use a | b', true), '<p>use a | b</p>');
  assert.equal(render('| a | b |'), '<p>| a | b |</p>');
  assert.equal(render(owner, true), render(owner));
});

test('markdown table cells stay escaped', () => {
  const html = render('| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |\n|---|---|\n| <script>x</script> | "quoted" \' |\n| [ok](https://near.ai) | `<b>` |');
  assert.doesNotMatch(html, /<img|<script|<b>|href="javascript/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<th scope="col">\[x\]\(javascript:alert\(1\)\)<\/th>/);
  assert.match(html, /<td>&quot;quoted&quot; &#39;<\/td>/);
  assert.match(html, /<a href="https:\/\/near.ai" title="https:\/\/near.ai">ok<\/a>/);
  assert.match(html, /<code>&lt;b&gt;<\/code>/);
});

test('markdown merges consecutive quote lines into one blockquote', () => {
  assert.equal(render('> one\n> two\n>\n> three <i>\n\nafter'), '<blockquote><p>one<br>two</p><p>three &lt;i&gt;</p></blockquote><p>after</p>');
  assert.equal(render('> a\n\n> b'), '<blockquote><p>a</p></blockquote><blockquote><p>b</p></blockquote>');
});

test('markdown renders strikethrough and leaves code spans alone', () => {
  assert.equal(markdown.inline('~~gone~~ and `~~kept~~` and ~~<s>~~'), '<del>gone</del> and <code>~~kept~~</code> and <del>&lt;s&gt;</del>');
});

test('chat view renders streaming text as partial and the finished reply strictly, and tables scroll in their own box', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /markdown\.parse\(text, \{ partial: partial === true \}\)/);
  assert.match(script, /requestAnimationFrame\(\(\) => flushAssistant\(true\)\)/);
  // closeSegment and finishAssistant render the final text with the strict rules.
  assert.equal([...script.matchAll(/flushAssistant\(\);/g)].length, 2);
  const css = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.css'), 'utf8');
  assert.match(css, /\.turn \.table-wrap \{[^}]*overflow-x: auto/);
  assert.match(css, /\.turn td\.align-right \{ text-align: right;/);
  const tableRules = css.split('\n').filter((line) => /\.turn (\.table-wrap|table|th|td|thead|tbody|tr)/.test(line)).join('\n');
  assert.doesNotMatch(tableRules, /#[0-9a-f]{3,8}\b|rgb\(/i);
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
  assert.ok(commands.some((command) => command.command === 'gsd-new-project'));
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

test('usage footer shows model, privacy, tokens, and actual cost over the estimate', () => {
  const { usageFooter } = withVscodeStub(() => require('../services/chatParticipant') as typeof import('../services/chatParticipant'));
  assert.equal(usageFooter('m', { inputTokens: 1000, outputTokens: 234, estimatedCostUsd: 0.00123, verificationStatus: 'unknown', latencyMs: 5 }, 'Private · runs in NEAR TEE'), '*m · Private · runs in NEAR TEE · 1,234 tokens · ~$0.0012 est.*');
  assert.equal(usageFooter('m', { estimatedCostUsd: 0.4, actualCostUsd: 0.5, verificationStatus: 'unknown', latencyMs: 5 }), '*m · $0.5000*');
});


test('model choices skip non-chat models and lead with the configured default', () => {
  const { defaultChatModel, modelOptions } = require('../services/chatBridge') as typeof import('../services/chatBridge');
  const models = [{ id: 'Qwen/Qwen3-Embedding-0.6B' }, { id: 'anthropic/claude-fable-5' }, { id: 'Qwen/Qwen3-Reranker-0.6B' }, { id: 'z-ai/glm-5.3' }] as never;
  assert.equal(defaultChatModel(models), 'anthropic/claude-fable-5');
  assert.equal(defaultChatModel(models, 'z-ai/glm-5.3'), 'z-ai/glm-5.3');
  assert.equal(defaultChatModel(models, 'gone/model'), 'anthropic/claude-fable-5');
  assert.deepEqual(modelOptions(models, 'z-ai/glm-5.3').map((option) => option.id), ['z-ai/glm-5.3', 'anthropic/claude-fable-5']);
});

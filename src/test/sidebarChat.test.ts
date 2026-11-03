import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseChatWebviewMessage } from '../services/chatBridge';

interface Block { type: 'html' | 'code'; html?: string; lang?: string; code?: string }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const markdown = require(path.join(__dirname, '..', '..', 'media', 'chat', 'markdown.js')) as { parse(text: string, options?: { partial?: boolean }): Block[]; inline(text: string): string; tableLabel(header: string[]): string };

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
const WRAP = '<div class="table-wrap" role="region" aria-label="Table: Chat handoff (planned), Panel-driven (shipped)">';

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
  // Prose with a pipe stays prose while it streams until a delimiter row starts under it, and the final render applies the strict rules.
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

// Every prefix of a streamed reply, rendered the way the view renders it while text arrives.
const frames = (doc: string) => Array.from({ length: doc.length }, (_unused, cut) => ({ text: doc.slice(0, cut + 1), html: render(doc.slice(0, cut + 1), true) }));
const stripAttrs = (html: string) => html.replace(/ role="region" aria-label="[^"]*"| scope="(col|row)"/g, '');

test('markdown streams a table without leading pipes as a table once its delimiter row starts, never as a rule', () => {
  const doc = 'Name | Count\n--- | ---\nA | 1';
  for (const frame of frames(doc)) {
    assert.doesNotMatch(frame.html, /<hr>/, JSON.stringify(frame.text));
    if (frame.text.includes('\n-')) assert.ok(frame.html.startsWith('<div class="table-wrap"'), `${JSON.stringify(frame.text)}: ${frame.html}`);
  }
  assert.equal(stripAttrs(render('Name | Count\n-', true)), '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Count</th></tr></thead></table></div>');
  assert.equal(render(doc, true), render(doc));
  // A header with leading pipes and a delimiter row without them never drops back to a paragraph.
  const mixed = '| a | b |\n--- | ---\n| 1 | 2 |';
  // A lone "|" renders nothing yet; from the first cell on, every frame is a table.
  assert.equal(render('|', true), '');
  for (const frame of frames(mixed).slice(2)) assert.ok(frame.html.startsWith('<div class="table-wrap"'), `${JSON.stringify(frame.text)}: ${frame.html}`);
  // Prose with a pipe followed by a list item is not taken for a table.
  assert.equal(render('a | b\n- ', true), '<p>a | b</p><ul><li></li></ul>');
  // Once the stream ends, a lone rule under prose is a rule again.
  assert.equal(render('a | b\n---'), '<p>a | b</p><hr>');
});

test('markdown does not show a prose line with a pipe as a table header while a reply streams', () => {
  for (const frame of frames('Use x | y as follows:\n| a | b |\n|---|---|').filter((item) => item.text.includes('\n'))) {
    assert.match(frame.html, /^<p>Use x \| y as follows:<\/p>/, JSON.stringify(frame.text));
  }
  assert.equal(render('Use x | y as follows:\n|', true), '<p>Use x | y as follows:</p>');
  assert.equal(render('use a | b', true), '<p>use a | b</p>');
  // A delimiter row with more cells than its header is not a header of its own.
  assert.equal(render('| a | b |\n|---|---|-', true), '<p>| a | b |<br>|---|---|-</p>');
  // Prose whose pipe sits in a code span, leaves an empty cell, or that ends like a sentence does
  // not flash up as a table when the next line starts with a dash.
  for (const doc of ['Run `cat x | grep y` to filter:\n- item one', 'a || b is logical or\n- next', 'Pick a | b here.\n---\nNext part', 'Use x | y as follows:\n--- and more']) {
    for (const frame of frames(doc)) assert.doesNotMatch(frame.html, /table-wrap/, JSON.stringify(frame.text));
  }
  assert.equal(render('Run `cat x | grep y` to filter:\n-', true), render('Run `cat x | grep y` to filter:\n-'));
  assert.equal(render('Pick a | b here.\n---', true), '<p>Pick a | b here.</p><hr>');
  // A row that reads like a header still streams as a table, and the finished reply is strict.
  assert.match(render('Total: 5 | 6\n---', true), /^<div class="table-wrap"/);
  assert.equal(render('Total: 5 | 6\n---'), '<p>Total: 5 | 6</p><hr>');
});

test('markdown keeps list items and headings with pipes as they are, next to tables', () => {
  assert.equal(render('- a | b\n|---|---|\n| 1 | 2 |'), '<ul><li>a | b</li></ul><p>|---|---|<br>| 1 | 2 |</p>');
  assert.equal(render('# Title | Sub\n|---|---|'), '<h3>Title | Sub</h3><p>|---|---|</p>');
  assert.equal(render('1. step | x\n|---|---|'), '<ol><li>step | x</li></ol><p>|---|---|</p>');
  assert.equal(render('* | a |\n|---|'), '<ul><li>| a |</li></ul><p>|---|</p>');
  const table = '<div class="table-wrap" role="region" aria-label="Table: a, b"><table><thead><tr><th scope="col">a</th><th scope="col">b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>';
  assert.equal(render('| a | b |\n|---|---|\n| 1 | 2 |\n- list | x'), `${table}<ul><li>list | x</li></ul>`);
  assert.equal(render('| a | b |\n|---|---|\n| 1 | 2 |\n## H | x'), `${table}<h4>H | x</h4>`);
  assert.equal(render('| a | b |\n|---|---|\n| 1 | 2 |\n3. step | x'), `${table}<ol><li>step | x</li></ol>`);
  // A body row that starts like a list item ends the table and becomes a list item, as in GFM.
  const named = '<div class="table-wrap" role="region" aria-label="Table: Name, Value"><table><thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead>';
  assert.equal(render('Name | Value\n--- | ---\nfoo | 1\n- | 2'), `${named}<tbody><tr><td>foo</td><td>1</td></tr></tbody></table></div><ul><li>| 2</li></ul>`);
  assert.equal(render('Name | Value\n--- | ---\n1. | ok'), `${named}</table></div><ol><li>| ok</li></ol>`);
  // Streaming never takes a heading or list item for a provisional table header either.
  assert.equal(render('## H | x\n|', true), '<h4>H | x</h4>');
  assert.equal(render('- a | b\n|--', true), '<ul><li>a | b</li></ul><p>|--</p>');
});

test('markdown keeps link URLs intact and strikes through only text the tildes hug', () => {
  assert.equal(markdown.inline('[x](https://a.com/~~b~~)'), '<a href="https://a.com/~~b~~" title="https://a.com/~~b~~">x</a>');
  assert.equal(markdown.inline('[x](https://a.com/**b**/_c_/__d__)'), '<a href="https://a.com/**b**/_c_/__d__" title="https://a.com/**b**/_c_/__d__">x</a>');
  assert.equal(markdown.inline('[**bold** ~~old~~](https://a.com/~~b~~) and ~~gone~~'), '<a href="https://a.com/~~b~~" title="https://a.com/~~b~~"><strong>bold</strong> <del>old</del></a> and <del>gone</del>');
  assert.equal(markdown.inline('cost is ~~5 and ~~10'), 'cost is ~~5 and ~~10');
  assert.equal(markdown.inline('~~ spaced ~~ and ~~~x~~~'), '~~ spaced ~~ and ~~~x~~~');
  assert.equal(markdown.inline('~~a~~ ~~b c~~'), '<del>a</del> <del>b c</del>');
  // A code span inside a URL never puts markup into the link's attributes.
  assert.equal(markdown.inline('[x](https://e.com/`a`)'), '[x](https://e.com/<code>a</code>)');
  // Placeholder characters in the model's text cannot pull in another span.
  assert.equal(markdown.inline('\u00000\u0000 `x` \u00010\u0001'), '�0� <code>x</code> �0�');
});

test('markdown gives every table region its own label', () => {
  const html = render('| Name | `Count` | [Docs](https://near.ai) | Extra |\n|---|---|---|---|\n\n| a | b |\n|---|---|\n\n| a | b |\n|---|---|\n\n| |\n|---|');
  assert.deepEqual([...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1]), ['Table: Name, Count, Docs, …', 'Table: a, b', 'Table: a, b (2)', 'Table']);
  assert.doesNotMatch(html, /tabindex/);
  assert.equal(markdown.tableLabel(['<b>"x"</b>']), 'Table: <b>"x"</b>');
  assert.match(render('| <b>"x"</b> |\n|---|'), /aria-label="Table: &lt;b&gt;&quot;x&quot;&lt;\/b&gt;"/);
  assert.equal(markdown.tableLabel(['x'.repeat(200)]).length, 'Table: '.length + 80);
});

test('markdown table labels match the header text people see', () => {
  const label = (text: string) => (render(text).match(/aria-label="([^"]*)"/) || [])[1];
  // Literal underscores, stars, tildes and backslashes stay; only Markdown that renders loses its markers.
  assert.equal(label('| user_id | created_at | file_path |\n|---|---|---|'), 'Table: user_id, created_at, file_path');
  assert.equal(markdown.tableLabel(['a * b', 'x ~ y', 'C:\\path']), 'Table: a * b, x ~ y, C:\\path');
  assert.equal(markdown.tableLabel(['**Bold**', '_em_', '~~old~~']), 'Table: Bold, em, old');
  assert.equal(markdown.tableLabel(['a &amp; b', '`x_y`']), 'Table: a &amp; b, x_y');
  // Placeholder characters show as the replacement character, as they do in the cell.
  assert.equal(markdown.tableLabel(['a\u0001b', 'c\u0000']), 'Table: a\ufffdb, c\ufffd');
  // A long label is cut by characters, so an emoji is never split in half.
  const cut = markdown.tableLabel(['x'.repeat(78) + '\u{1F600}'.repeat(3)]);
  assert.equal(cut, `Table: ${'x'.repeat(78)}\u{1F600}…`);
  assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

// A stand-in for the table boxes in the chat DOM: just the parts tables.js touches.
class FakeWrap {
  scrollLeft = 0;
  focused = false;
  attrs = new Map<string, string>();
  constructor(public scrollWidth: number, public clientWidth = 300) {}
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  // The links inside the table, the only focusable parts the renderer makes.
  links: FakeLink[] = [];
  withLinks(count: number) { this.links = Array.from({ length: count }, () => new FakeLink(this)); return this; }
  querySelectorAll() { return this.links; }
  closest() { return this; }
  contains(node: unknown) { return node === this || this.links.includes(node as FakeLink); }
  focus() { this.focused = true; }
}
class FakeLink {
  focused = false;
  constructor(public wrap: FakeWrap) {}
  closest() { return this.wrap; }
  focus() { this.focused = true; }
}
const fakeBody = (wraps: FakeWrap[]) => ({ querySelectorAll: () => wraps });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tables = require(path.join(__dirname, '..', '..', 'media', 'chat', 'tables.js')) as {
  capture(target: unknown, active: unknown): { scroll: number[]; focused: number; inner: number };
  restore(target: unknown, saved: unknown): FakeWrap[];
  syncTabStop(wrap: FakeWrap, active?: unknown): void;
  focusLeft(event: { target: unknown; relatedTarget: unknown }): void;
  watchSizes(Observer: unknown, activeElement: () => unknown): { observe(wraps: unknown[]): void; release(wraps: unknown[]): void; reset(): void };
};

test('chat tables keep their sideways scroll and focus when a streaming reply re-renders', () => {
  const before = [new FakeWrap(900), new FakeWrap(200)];
  before[0].scrollLeft = 240;
  const saved = tables.capture(fakeBody(before), before[0]);
  assert.deepEqual({ scroll: saved.scroll, focused: saved.focused }, { scroll: [240, 0], focused: 0 });
  // The next frame rebuilds both tables; the wide one gets its scroll and focus back.
  const after = [new FakeWrap(950), new FakeWrap(200)];
  tables.restore(fakeBody(after), saved);
  assert.equal(after[0].scrollLeft, 240);
  assert.equal(after[0].focused, true);
  assert.equal(after[1].focused, false);
  // Focus on something else on the page is left alone.
  const elsewhere = tables.capture(fakeBody(after), { other: true });
  assert.equal(elsewhere.focused, -1);
  const third = [new FakeWrap(950)];
  tables.restore(fakeBody(third), elsewhere);
  assert.equal(third[0].focused, false);
});

test('chat tables keep focus on the same link inside a table when a streaming reply re-renders', () => {
  const before = [new FakeWrap(900).withLinks(3), new FakeWrap(200).withLinks(1)];
  const saved = tables.capture(fakeBody(before), before[0].links[1]);
  assert.deepEqual({ focused: saved.focused, inner: saved.inner }, { focused: 0, inner: 1 });
  const after = [new FakeWrap(950).withLinks(3), new FakeWrap(200).withLinks(1)];
  tables.restore(fakeBody(after), saved);
  // The same link gets focus back, not the table box, so Tab moves on from the link.
  assert.deepEqual(after[0].links.map((link) => link.focused), [false, true, false]);
  assert.equal(after[0].focused, false);
  assert.equal(after[1].focused || after[1].links[0].focused, false);
  // A link in a table that does not overflow keeps focus, and the box does not become a Tab stop.
  const narrow = [new FakeWrap(200).withLinks(2)];
  const kept = tables.capture(fakeBody(narrow), narrow[0].links[0]);
  const rebuilt = [new FakeWrap(200).withLinks(2)];
  tables.restore(fakeBody(rebuilt), kept);
  assert.equal(rebuilt[0].links[0].focused, true);
  assert.equal(rebuilt[0].focused, false);
  assert.equal(rebuilt[0].hasAttribute('tabindex'), false);
  // If that link is gone from the next frame, focus falls back to the table box.
  const fewer = [new FakeWrap(200).withLinks(0)];
  tables.restore(fakeBody(fewer), kept);
  assert.equal(fewer[0].focused, true);
  assert.equal(fewer[0].getAttribute('tabindex'), '0');
  // Focus that has moved past the table is left alone.
  const past = tables.capture(fakeBody(rebuilt), { outside: true });
  const next = [new FakeWrap(200).withLinks(2)];
  tables.restore(fakeBody(next), past);
  assert.equal(next[0].focused || next[0].links.some((link) => link.focused), false);
});

test('chat tables stop being a Tab stop when focus leaves a box that does not overflow', () => {
  const box = new FakeWrap(200).withLinks(1);
  box.setAttribute('tabindex', '0');
  // Moving from the box to a link inside it keeps the Tab stop.
  tables.focusLeft({ target: box, relatedTarget: box.links[0] });
  assert.equal(box.getAttribute('tabindex'), '0');
  tables.focusLeft({ target: box.links[0], relatedTarget: { outside: true } });
  assert.equal(box.hasAttribute('tabindex'), false);
  // A box that overflows stays a Tab stop.
  const wide = new FakeWrap(900);
  wide.setAttribute('tabindex', '0');
  tables.focusLeft({ target: wide, relatedTarget: null });
  assert.equal(wide.getAttribute('tabindex'), '0');
  // Focus leaving anything outside a table is ignored.
  tables.focusLeft({ target: { closest: () => null }, relatedTarget: null });
  tables.focusLeft({ target: null, relatedTarget: null });
});

test('chat tables stop being watched for size changes once their reply is gone or the chat is cleared', () => {
  // A stand-in for ResizeObserver that records what it watches.
  class FakeObserver {
    static last: FakeObserver;
    watched = new Set<unknown>();
    constructor(public callback: (entries: { target: unknown }[]) => void) { FakeObserver.last = this; }
    observe(node: unknown) { this.watched.add(node); }
    unobserve(node: unknown) { this.watched.delete(node); }
    disconnect() { this.watched.clear(); }
  }
  const box = (overflow: boolean) => {
    const wrap = Object.assign(new FakeWrap(overflow ? 900 : 200), { isConnected: true, firstElementChild: { table: true } });
    return wrap;
  };
  const sizes = tables.watchSizes(FakeObserver, () => null);
  const observer = FakeObserver.last;
  const [first, second] = [box(true), box(false)];
  sizes.observe([first, second]);
  assert.deepEqual([...observer.watched], [first, first.firstElementChild, second, second.firstElementChild]);
  // A size change sets the Tab stop of a box that is still on the page.
  observer.callback([{ target: first }]);
  assert.equal(first.getAttribute('tabindex'), '0');
  // A box that has left the page is let go instead.
  second.isConnected = false;
  observer.callback([{ target: second }]);
  assert.equal(observer.watched.has(second), false);
  // A reply rebuilt or removed lets go of its boxes.
  sizes.release([first]);
  assert.deepEqual([...observer.watched], [second.firstElementChild]);
  // Clearing the conversation lets go of every box at once.
  sizes.observe([first]);
  sizes.reset();
  assert.equal(observer.watched.size, 0);
  // Without ResizeObserver nothing is watched and nothing fails.
  const none = tables.watchSizes(undefined, () => null);
  none.observe([first]);
  none.release([first]);
  none.reset();
  // The chat view lets go of tables when a reply is removed or the conversation is cleared.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  const reset = script.slice(script.indexOf('function resetConversation() {'), script.indexOf('\n  }\n', script.indexOf('function resetConversation() {')));
  assert.match(reset, /tableSizes\.reset\(\);\n {4}transcript\.replaceChildren\(welcome\);/);
  assert.doesNotMatch(script, /current\.node\.remove\(\)/);
  assert.equal([...script.matchAll(/removeTurn\(current\.node\)/g)].length, 3);
  assert.match(script, /tableSizes\.release\(saved\.wraps\);\n {4}target\.replaceChildren\(\);/);
});

test('chat tables are Tab stops only while they are wider than their box', () => {
  const wide = new FakeWrap(900);
  const narrow = new FakeWrap(280);
  tables.restore(fakeBody([wide, narrow]), undefined);
  assert.equal(wide.getAttribute('tabindex'), '0');
  assert.equal(narrow.hasAttribute('tabindex'), false);
  // Widening the chat takes the Tab stop away, unless the table has focus right now.
  wide.clientWidth = 1000;
  tables.syncTabStop(wide, wide);
  assert.equal(wide.getAttribute('tabindex'), '0');
  tables.syncTabStop(wide, undefined);
  assert.equal(wide.hasAttribute('tabindex'), false);
  narrow.clientWidth = 100;
  tables.syncTabStop(narrow, undefined);
  assert.equal(narrow.getAttribute('tabindex'), '0');
});

test('chat view renders streaming text as partial and the finished reply strictly, loads the table helper and styles tables with theme colours only', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const panel = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'panelView.ts'), 'utf8');
  // Streaming frames render with the lenient rules and rebuild tables through the helper.
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /markdown\.parse\(text, \{ partial: partial === true \}\)/);
  assert.match(script, /requestAnimationFrame\(\(\) => flushAssistant\(true\)\)/);
  assert.match(script, /function flushAssistant\(partial\) \{[^}]*renderMarkdown\(current\.body, current\.text, partial === true\);/);
  // closeSegment and finishAssistant render the final text with the strict rules.
  assert.equal([...script.matchAll(/flushAssistant\(\);/g)].length, 2);
  assert.match(script, /function finishAssistant\(meta\) \{[^}]*\n {4}flushAssistant\(\);/);
  assert.match(script, /function closeSegment\(\) \{[^}]*\n {4}flushAssistant\(\);/);
  // Only streaming frames pass true; no other call renders a reply with the lenient rules.
  assert.deepEqual([...new Set([...script.matchAll(/flushAssistant\(([^)]*)\)[;)]/g)].map((match) => match[1]))].sort(), ['', 'true']);
  // A saved reply replayed from the transcript is rendered strictly too.
  const renders = [...script.matchAll(/renderMarkdown\(([^)]*)\);/g)].map((match) => match[1]);
  assert.deepEqual(renders, ['current.body, current.text, partial === true', "body, turn.text || ''"]);
  assert.match(script, /transcript\.addEventListener\('focusout', tables\.focusLeft\)/);
  // Without the table helper the view falls back to stand-ins for every part of it.
  const fallback = script.slice(script.indexOf('window.nearTables || {'), script.indexOf('\n  };\n', script.indexOf('window.nearTables || {')));
  assert.deepEqual([...fallback.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]).sort(), Object.keys(tables).sort());
  assert.match(script, /tables\.capture\(target, document\.activeElement\)[\s\S]*target\.replaceChildren\(\)[\s\S]*tables\.restore\(target, saved\)/);
  assert.ok(panel.indexOf("asset('tables.js')") > 0 && panel.indexOf("asset('tables.js')") < panel.indexOf("asset('chat.js')"), 'tables.js loads before chat.js');
  const css = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.css'), 'utf8');
  assert.match(css, /\.turn \.table-wrap \{[^}]*overflow-x: auto/);
  assert.match(css, /\.turn td\.align-right \{ text-align: right;/);
  assert.match(css, /\.turn td code[^{]*\{ overflow-wrap: anywhere; \}/);
  const tableRules = css.split('\n').filter((line) => /\.turn (\.table-wrap|table|th|td|thead|tbody|tr)/.test(line)).join('\n');
  assert.doesNotMatch(tableRules, /#[0-9a-f]{3,8}\b|rgb\(|style=/i);
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

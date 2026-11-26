// The Documentation view's build step (workbench/tools/documentation-render.mjs): images, diagrams, MDX figures and raw HTML become our own
// HTML at build time, so the view never shows ![…], <figure> or ```mermaid as text, and never loads anything from another origin.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDocumentationRenderer } from '../tools/documentation-render.mjs';

// Bundled to workbench/dist/test/, so the repository root is three folders up.
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'sterling-docs-'));
after(() => rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f0e0000000049454e44ae426082', 'hex');
mkdirSync(path.join(root, 'docs-site/content/img'), { recursive: true });
mkdirSync(path.join(root, 'docs-site/static/img'), { recursive: true });
mkdirSync(path.join(root, 'docs/marketplace'), { recursive: true });
writeFileSync(path.join(root, 'docs-site/content/img/figure.png'), PNG);
writeFileSync(path.join(root, 'docs-site/static/img/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
writeFileSync(path.join(root, 'docs/marketplace/shot.png'), Buffer.concat([PNG, Buffer.from([0])]));

/** No source syntax may reach the page as visible text. */
function assertNoRawSyntax(html) {
  // Tags are stripped until nothing changes, so markup that a single pass would rebuild (`<<b>script>`) cannot pass for visible text.
  let visible = html;
  for (let previous; visible !== previous;) {
    previous = visible;
    visible = visible.replace(/<[^>]*>/g, '');
  }
  for (const raw of ['![', '&lt;figure', '&lt;img', '```', 'flowchart LR', '&lt;Figure']) {
    assert.ok(!visible.includes(raw), `visible text holds ${raw}:\n${visible}`);
  }
  assert.doesNotMatch(html, /<script|<style|\son\w+=|(?:src|href)="https?:\/\/(?!www\.w3\.org)[^"]*\.(png|svg|jpe?g|gif|webp)/i);
}

test('a Markdown image in the checkout or published from this repository is bundled; any other address becomes a note', () => {
  const renderer = createDocumentationRenderer({ root });
  const { html } = renderer.render('docs-site/content/guide.md', [
    '![A local figure](img/figure.png "Local")',
    '',
    '![A screenshot](https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/marketplace/shot.png)',
    '',
    '![A remote chart](https://example.com/chart.png)',
  ].join('\n'));
  const sources = [...html.matchAll(/<img src="([^"]+)" alt="([^"]*)"/g)].map((match) => [match[1], match[2]]);
  assert.equal(sources.length, 2, html);
  assert.match(sources[0][0], /^sterling-documentation\/[0-9a-f]{16}\.png$/);
  assert.deepEqual(sources.map(([, alt]) => alt), ['A local figure', 'A screenshot']);
  assert.notEqual(sources[0][0], sources[1][0]);
  assert.deepEqual([...renderer.assets].sort(), [
    [sources[0][0].slice('sterling-documentation/'.length), path.join(root, 'docs-site/content/img/figure.png')],
    [sources[1][0].slice('sterling-documentation/'.length), path.join(root, 'docs/marketplace/shot.png')],
  ].sort(), 'each picture is copied from its repository file; the published address uses the checkout copy');
  renderer.render('docs-site/content/other.md', '![Again](img/figure.png)');
  assert.equal(renderer.assets.size, 2, 'the same picture is bundled once');
  assert.match(html, /Image not available offline: A remote chart/);
  assert.doesNotMatch(html, /example\.com/);
  assertNoRawSyntax(html);
});

test('a missing or outside image stops the build with the page named', () => {
  const renderer = createDocumentationRenderer({ root });
  assert.throws(() => renderer.render('docs-site/content/guide.md', '![Gone](img/missing.png)'), /docs-site\/content\/guide\.md: the image img\/missing\.png/);
  assert.throws(() => renderer.render('docs-site/content/guide.md', '![Out](../../../../etc/passwd.png)'), /inside the repository/);
  assert.throws(() => renderer.render('docs-site/content/guide.md', '![Text](notes.txt)'), /not a png, jpg, gif, webp or svg/);
});

test('a mermaid diagram is drawn to an inline SVG that follows the theme and loads nothing', () => {
  const renderer = createDocumentationRenderer({ root });
  const { html, text } = renderer.render('docs-site/content/guide.md', [
    '## How a request flows',
    '',
    '```mermaid',
    'flowchart LR',
    '  Person["Person"] --> Proxy["Sign-in proxy"]',
    '  Proxy --> Workbench["Workbench"]',
    '```',
  ].join('\n'));
  assert.match(html, /<figure class="sterling-doc-diagram" style="--sterling-diagram-width:\d+px"><svg [^>]*role="img" aria-label="Diagram: How a request flows"/);
  const geometry = html.match(/<figure class="sterling-doc-diagram" style="--sterling-diagram-width:(\d+)px"><svg [^>]*?viewBox="0 0 ([\d.]+) [\d.]+" width="([\d.]+)"/);
  assert.ok(geometry, 'the SVG keeps its drawn width and viewBox');
  const [, boxWidth, viewBoxWidth, drawnWidth] = geometry;
  assert.equal(Number(boxWidth), Math.ceil(Number(drawnWidth)));
  assert.equal(Number(viewBoxWidth), Number(drawnWidth));
  assert.match(html, /--bg:var\(--sterling-diagram-bg\);--fg:var\(--sterling-diagram-fg\)/);
  assert.match(html, /--_line:/, 'the derived colour variables move onto the SVG');
  assert.doesNotMatch(html, /fonts\.googleapis|@import|<style/);
  for (const label of ['Person', 'Sign-in proxy', 'Workbench']) assert.match(html, new RegExp(`<text[^>]*>${label}</text>`));
  assert.match(text, /Sign-in proxy/, 'diagram labels are searchable');
  assertNoRawSyntax(html);
});

test('an MDX figure, components and import lines become plain HTML or a clear note, never JSX text', () => {
  const renderer = createDocumentationRenderer({ root });
  const { html } = renderer.render('docs-site/content/guide.mdx', [
    'import ComplianceTable from \'@site/src/components/ComplianceTable\';',
    'import Tabs from \'@theme/Tabs\';',
    '',
    '# Guide',
    '',
    '<figure>',
    '  <img src={require(\'./img/figure.png\').default} alt="The control flow" />',
    '',
    '  <figcaption>The control flow, **step by step**.</figcaption>',
    '</figure>',
    '',
    '<ComplianceTable level="protected-b" />',
    '',
    '<Tabs>',
    '  <TabItem value="one" label="One">Hello *there*.</TabItem>',
    '</Tabs>',
  ].join('\n'));
  assert.match(html, /<figure class="sterling-doc-figure"><img src="sterling-documentation\/[0-9a-f]{16}\.png" alt="The control flow" loading="lazy"><figcaption>The control flow, <strong>step by step<\/strong>\.<\/figcaption><\/figure>/);
  assert.match(html, /The interactive part of this page \(ComplianceTable\) is shown only on the documentation site\./);
  assert.match(html, /<p>Hello <em>there<\/em>\.<\/p>/);
  assert.doesNotMatch(html, /import|TabItem|require\(/);
  assertNoRawSyntax(html);
});

test('a raw HTML block keeps its picture and text but never its scripts, handlers or remote sources', () => {
  const renderer = createDocumentationRenderer({ root });
  const { html } = renderer.render('README.md', [
    '<p align="center"><img src="docs-site/static/img/logo.svg" alt="Logo" width="80"></p>',
    '',
    '<script>alert(1)</script>',
    '',
    '<div onclick="steal()">Plain <b>words</b> stay.</div>',
    '',
    '<iframe src="https://example.com/video"></iframe>',
    '',
    'Inline <img src="/img/logo.svg" alt="Badge"> and a line<br>break.',
    '',
    'A placeholder like <team> or <extension> in prose stays as text.',
  ].join('\n'));
  assert.match(html, /<figure class="sterling-doc-figure"><img src="sterling-documentation\/[0-9a-f]{16}\.svg" alt="Logo"/);
  assert.match(html, /<p>Plain <strong>words<\/strong> stay\.<\/p>/);
  assert.match(html, /This embedded content is not shown in the workbench\./);
  assert.match(html, /Inline <img src="sterling-documentation\/[0-9a-f]{16}\.svg" alt="Badge" loading="lazy"> and a line<br>\s*break\./);
  assert.match(html, /&lt;team&gt; or &lt;extension&gt;/);
  assert.doesNotMatch(html, /alert|steal|onclick|example\.com/);
  assertNoRawSyntax(html);
});

test('the bundled architecture guide renders its illustration and searchable flows, and the README retains its screenshots', async () => {
  const renderer = createDocumentationRenderer({ root: repositoryRoot });
  const { readFile } = await import('node:fs/promises');
  const source = 'docs-site/content/architecture/overview.mdx';
  const overview = renderer.render(source, await readFile(path.join(repositoryRoot, source), 'utf8'));
  const illustration = overview.html.match(/<figure class="sterling-doc-figure"><img src="sterling-documentation\/([0-9a-f]{16}\.webp)" alt="Illustrated map of Sterling Sovereign AI[^"]*"/);
  assert.ok(illustration, 'the overview renders a same-origin illustrated figure');
  assert.equal(renderer.assets.get(illustration[1]), path.join(repositoryRoot, 'docs-site/static/img/sovai-data-flows.webp'));
  const flow = [...overview.html.matchAll(/<table>[\s\S]*?<\/table>/g)]
    .map(([table]) => table)
    .find((table) => table.includes('Mission hub validates sealed changes'));
  assert.ok(flow, 'the overview renders the shared flow table');
  assert.equal(flow.match(/<tbody>\s*([\s\S]*?)<\/tbody>/)?.[1].match(/<tr>/g)?.length, 9);
  assert.match(overview.text, /Mission hub validates sealed changes/);
  assert.doesNotMatch(overview.html, /SystemArchitecture|The interactive part of this page/);
  assertNoRawSyntax(overview.html);
  const readme = renderer.render('README.md', await readFile(path.join(repositoryRoot, 'README.md'), 'utf8'));
  assert.equal(readme.html.match(/<img src="sterling-documentation\/[0-9a-f]{16}\.png"/g)?.length, 4);
  assertNoRawSyntax(readme.html);
});

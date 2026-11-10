import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { RunCheckpoints } from '../agent/checkpoints';
import { prepareImage } from '../agent/docImages';
import { parseInline, parseMarkdown } from '../agent/docMarkdown';
import { documentText, PDFJS_DIR } from '../agent/documents';
import { createDocx } from '../agent/docxWriter';
import { documentTool, GRAPHICS_TOOLS, pdfTool } from '../agent/graphicsTools';
import { createPdf } from '../agent/pdfWriter';
import { ShellSession } from '../agent/shell';
import { DEFAULT_TOOLS, parseTeam, resolveMemberTools } from '../agent/teams';
import type { ToolContext } from '../agent/tools';
import { ToolError } from '../agent/workspace';
import { readZip } from '../agent/zip';

// CreatePdf and CreateDocument: Markdown in, a PDF or a Word file out, made on this machine with
// no library, and read back with the extension's own document readers.

const MEDIA = path.join(__dirname, '..', '..', 'test', 'fixtures', 'media');
const LOGO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#0f766e"/></svg>');

const REPORT = `# Quarterly Report

The project codename is **HERON-2291**, with *italic* notes, \`inline code\`, and a [source](https://example.com/source).

## Findings

- Revenue grew
- Costs fell
  - mostly in logistics

1. First step
2. Second step

> A quoted passage from the board.

| Region | Units | Notes |
| --- | ---: | :---: |
| North | 1200 | steady |
| South | 875 | up 4% |

![Build chart](chart.png)

### Method

\`\`\`
units = north + south
\`\`\`

#### Appendix detail

Closing paragraph with the marker ALBATROSS-3306.
`;

type PdfJs = { getDocument(options: Record<string, unknown>): { promise: Promise<PdfDoc>; destroy(): Promise<void> }; OPS: Record<string, number> };
type PdfDoc = { numPages: number; getOutline(): Promise<Array<{ title: string; items: unknown[] }> | null>; getMetadata(): Promise<{ info: Record<string, unknown> }>; getPage(n: number): Promise<{ getAnnotations(): Promise<Array<{ subtype: string; url?: string }>>; getOperatorList(): Promise<{ fnArray: number[] }> }> };
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PdfJs>;

async function openPdf(bytes: Buffer) {
  const lib = await importModule(pathToFileURL(path.join(PDFJS_DIR, 'pdf.min.mjs')).href);
  const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: true });
  return { lib, doc: await task.promise, close: () => task.destroy() };
}

/** Every xref offset points at its object, and startxref points at the table: the file needs no repair to open. */
function assertXref(bytes: Buffer) {
  const text = bytes.toString('latin1');
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
  assert.ok(text.startsWith('%PDF-1.4\n'), 'PDF header');
  assert.equal(text.slice(start, start + 4), 'xref');
  const table = /^xref\n0 (\d+)\n/.exec(text.slice(start))!;
  const count = Number(table[1]);
  const entries = text.slice(start + table[0].length).split('\n').slice(1, count);
  entries.forEach((entry, index) => {
    const offset = Number(entry.slice(0, 10));
    assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`, `object ${index + 1} is where the xref says`);
  });
}

async function sample() {
  const images = new Map([['chart.png', await prepareImage(await readFile(path.join(MEDIA, 'build-code.png')), 'chart.png')]]);
  return { title: 'Quarterly Report', author: 'Research team', blocks: parseMarkdown(REPORT), images, pageSize: 'A4' as const };
}

test('the Markdown subset parses into headings, lists, quotes, tables, code, and images', () => {
  const blocks = parseMarkdown(REPORT);
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'paragraph', 'heading', 'list', 'list', 'quote', 'table', 'image', 'heading', 'code', 'heading', 'paragraph']);
  const lists = blocks.filter((block) => block.kind === 'list');
  assert.deepEqual(lists[0].kind === 'list' && lists[0].items.map((item) => [item.level, item.ordered]), [[0, false], [0, false], [1, false]]);
  assert.deepEqual(lists[1].kind === 'list' && lists[1].items.map((item) => item.number), [1, 2]);
  const table = blocks.find((block) => block.kind === 'table');
  assert.deepEqual(table?.kind === 'table' && table.align, ['left', 'right', 'center']);
  assert.deepEqual(parseInline('a **b** *c* `d*e` [f](https://x.y) \\*g\\*'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd*e', code: true }, { text: ' ' }, { text: 'f', link: 'https://x.y' }, { text: ' *g*' }]);
});

test('a PDF round-trips headings, body text, and table cells through the PDF reader, with bookmarks, links, metadata, and an embedded image', async () => {
  const result = createPdf(await sample());
  assertXref(result.bytes);
  assert.equal(result.headings, 4);
  assert.equal(result.images, 1);
  assert.deepEqual(result.substituted, []);
  const read = await documentText(result.bytes, 'pdf', 'report.pdf');
  assert.equal(read.pages, result.pages);
  for (const expected of ['Quarterly Report', 'HERON-2291', 'Findings', 'Revenue grew', 'mostly in logistics', 'A quoted passage from the board.', 'Region', 'Units', 'North', '1200', 'South', '875', 'up 4%', 'Build chart', 'units = north + south', 'Appendix detail', 'ALBATROSS-3306', `Page 1 of ${result.pages}`]) assert.ok(read.text.includes(expected), `${expected} survives: ${read.text}`);
  const { lib, doc, close } = await openPdf(result.bytes);
  try {
    const outline = await doc.getOutline();
    assert.equal(outline?.[0].title, 'Quarterly Report');
    const titles = (items: Array<{ title: string; items: unknown[] }>): string[] => items.flatMap((item) => [item.title, ...titles(item.items as typeof items)]);
    assert.deepEqual(titles(outline ?? []), ['Quarterly Report', 'Findings', 'Method', 'Appendix detail']);
    assert.equal((outline?.[0].items as unknown[]).length, 1, 'Findings nests under the h1');
    const info = (await doc.getMetadata()).info;
    assert.equal(info.Title, 'Quarterly Report');
    assert.equal(info.Author, 'Research team');
    assert.equal(info.CreationDate, undefined, 'no date unless one is passed');
    const page = await doc.getPage(1);
    assert.ok((await page.getAnnotations()).some((annotation) => annotation.subtype === 'Link' && annotation.url === 'https://example.com/source'));
    const ops = (await page.getOperatorList()).fnArray;
    assert.ok(ops.includes(lib.OPS.paintImageXObject), 'the image is drawn');
  } finally {
    await close();
  }
});

test('PDF text outside the standard fonts is substituted and reported, never written as a broken file', async () => {
  const result = createPdf({ title: 'Ünïcode → test', blocks: parseMarkdown('Arrows → and ticks ✓, euro €, and 中文.'), images: new Map() });
  assert.deepEqual(result.substituted, ['中', '文']);
  const read = await documentText(result.bytes, 'pdf', 'u.pdf');
  assert.match(read.text, /Arrows -> and ticks \[x\], euro €, and \?\?\./);
  const { doc, close } = await openPdf(result.bytes);
  try { assert.equal((await doc.getMetadata()).info.Title, 'Ünïcode → test', 'the title keeps every character'); } finally { await close(); }
});

test('long content flows onto numbered pages, and a long table repeats its header', async () => {
  const rows = Array.from({ length: 120 }, (_, index) => `| Row ${index} | ${'word '.repeat(index % 7 + 1)}|`).join('\n');
  const result = createPdf({ title: 'Long', pageSize: 'Letter', blocks: parseMarkdown(`# Long\n\n${'Paragraph text that wraps across the line. '.repeat(200)}\n\n| Name | Value |\n| --- | --- |\n${rows}\n`), images: new Map() });
  assert.ok(result.pages >= 4, `${result.pages} pages`);
  assertXref(result.bytes);
  const read = await documentText(result.bytes, 'pdf', 'long.pdf');
  assert.ok(read.text.includes('Row 119'));
  assert.ok((read.text.match(/Name\s*Value/g) ?? []).length >= 2, 'the header row repeats on the next page');
  assert.ok(read.text.includes(`Page ${result.pages} of ${result.pages}`));
});

test('a Word document round-trips headings, body text, and table cells, with real heading styles, numbering, a picture, and properties', async () => {
  const result = createDocx({ ...(await sample()), date: '2026-11-10' });
  const text = (await documentText(result.bytes, 'docx', 'report.docx')).text;
  for (const expected of ['Quarterly Report', 'HERON-2291', 'Revenue grew', 'mostly in logistics', 'A quoted passage from the board.', 'Region | Units | Notes', 'North | 1200 | steady', 'South | 875 | up 4%', 'Build chart', 'units = north + south', 'ALBATROSS-3306']) assert.ok(text.includes(expected), `${expected} survives: ${text}`);
  const zip = readZip(result.bytes, 'report.docx');
  const part = (name: string) => zip.get(name)?.().toString('utf8') ?? '';
  const document = part('word/document.xml');
  for (const level of [1, 2, 3, 4]) assert.match(document, new RegExp(`<w:pStyle w:val="Heading${level}"/>`), `Heading ${level} is used`);
  const styles = part('word/styles.xml');
  for (const level of [1, 2, 3, 4]) assert.match(styles, new RegExp(`w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>[\\s\\S]*?<w:outlineLvl w:val="${level - 1}"/>`), `heading ${level} is a built-in style with an outline level`);
  assert.match(document, /<w:tbl>[\s\S]*<w:tblHeader\/>[\s\S]*<\/w:tbl>/);
  assert.match(document, /<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="1"\/><\/w:numPr>/, 'the nested bullet is a level-1 list item');
  assert.match(part('word/numbering.xml'), /<w:num w:numId="2"><w:abstractNumId w:val="1"\/>/);
  // 640×240 px at 96 dpi is 6096000×2286000 EMU, inside the A4 text width, so it is not scaled.
  assert.match(document, /<wp:extent cx="6096000" cy="2286000"\/>/);
  const rels = part('word/_rels/document.xml.rels');
  const imageRel = /Id="(rId\d+)" Type="[^"]+\/image" Target="media\/image1\.png"/.exec(rels);
  assert.ok(imageRel, 'the picture has a relationship');
  assert.match(document, new RegExp(`<a:blip r:embed="${imageRel![1]}"/>`));
  assert.deepEqual([...zip.get('word/media/image1.png')!().subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.match(rels, /Target="https:\/\/example\.com\/source" TargetMode="External"/);
  assert.match(part('docProps/core.xml'), /<dc:title>Quarterly Report<\/dc:title><dc:creator>Research team<\/dc:creator>[\s\S]*<dcterms:created xsi:type="dcterms:W3CDTF">2026-11-10T00:00:00Z<\/dcterms:created>/);
  // Every part a relationship names exists, and every part has a content type.
  for (const target of [...rels.matchAll(/Target="([^"]+)"(?! TargetMode)/g)].map((match) => `word/${match[1]}`)) assert.ok(zip.has(target), `${target} exists`);
  const types = part('[Content_Types].xml');
  for (const name of zip.keys()) if (!/\.(rels|png|jpeg)$/.test(name) && name !== '[Content_Types].xml') assert.ok(types.includes(`PartName="/${name}"`), `${name} has a content type`);
});

test('the same input gives byte-identical PDF and Word files', async () => {
  const first = await sample();
  const second = await sample();
  assert.ok(createPdf(first).bytes.equals(createPdf(second).bytes), 'PDF is deterministic');
  assert.ok(createDocx(first).bytes.equals(createDocx(second).bytes), 'DOCX is deterministic');
  const dated = createPdf({ ...first, date: '2026-01-02' });
  assert.ok(dated.bytes.toString('latin1').includes('/CreationDate (D:20260102000000Z)'));
  assert.ok(!createPdf(first).bytes.equals(dated.bytes), 'a date is written only when passed');
});

test('JPEG and SVG figures are embedded, and an unknown image format fails with a ToolError', async () => {
  const jpeg = await prepareImage(await readFile(path.join(MEDIA, 'build-code.jpg')), 'shot.jpg');
  assert.equal(jpeg.format, 'jpeg');
  const svg = await prepareImage(LOGO, 'logo.svg');
  assert.equal(svg.format, 'png');
  assert.ok(svg.width >= 120 * 2, 'an SVG is drawn large enough to print sharply');
  const images = new Map([['a.jpg', jpeg], ['b.svg', svg]]);
  const blocks = parseMarkdown('![photo](a.jpg)\n\n![logo](b.svg)\n');
  const pdf = createPdf({ title: 'Figures', blocks, images });
  assert.equal(pdf.images, 2);
  assert.ok(pdf.bytes.toString('latin1').includes('/Filter /DCTDecode'), 'the JPEG is embedded as it is');
  assert.ok(pdf.bytes.toString('latin1').includes('/SMask') || pdf.bytes.toString('latin1').includes('/DeviceRGB'));
  const docx = createDocx({ title: 'Figures', blocks, images });
  assert.deepEqual([...readZip(docx.bytes, 'f').keys()].filter((name) => name.startsWith('word/media/')), ['word/media/image1.jpeg', 'word/media/image2.png']);
  await assert.rejects(() => prepareImage(Buffer.from('plain text'), 'notes.png'), (error: Error) => error instanceof ToolError && /notes\.png: Not a PNG/.test(error.message));
  assert.throws(() => createPdf({ title: 'x', blocks: parseMarkdown('![x](missing.png)'), images: new Map() }), /missing\.png was not loaded/);
});

function toolContext(root: string): ToolContext {
  return { root, checkpoints: new RunCheckpoints(`doc-${Date.now()}`), shell: new ShellSession(root), readFiles: new Set(), signal: new AbortController().signal, onTodos: () => undefined };
}

test('CreatePdf and CreateDocument read and write only inside the workspace, ask before protected writes, and can be reverted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-doc-'));
  await mkdir(path.join(root, 'report', 'figures'), { recursive: true });
  await writeFile(path.join(root, 'report', 'figures', 'chart.png'), await readFile(path.join(MEDIA, 'build-code.png')));
  await writeFile(path.join(root, 'report', 'REPORT.md'), REPORT.replace('(chart.png)', '(figures/chart.png)'));
  const context = toolContext(root);
  try {
    assert.ok(GRAPHICS_TOOLS.includes(pdfTool) && GRAPHICS_TOOLS.includes(documentTool), 'both are registered with the graphics tools');
    for (const tool of [pdfTool, documentTool]) assert.equal(tool.capability, 'workspaceWrite');
    const pdf = pdfTool.parse({ output_path: 'out/report.pdf', title: 'Quarterly Report', source_path: 'report/REPORT.md', page_size: 'Letter' });
    assert.match(await pdfTool.run(pdf, context), /^Saved out\/report\.pdf: \d+ pages, 4 bookmarks, 1 images, \d+ KB\.$/);
    const preview = await pdfTool.preview!(pdf, context);
    assert.match(preview.kind === 'note' ? preview.text : '', /Create PDF out\/report\.pdf \("Quarterly Report", Letter\) from report\/REPORT\.md: 4 headings, 1 tables, 1 images\./);
    const docx = documentTool.parse({ output_path: 'out/report.docx', title: 'Quarterly Report', markdown: '# Inline\n\n![c](report/figures/chart.png)\n' });
    assert.match(await documentTool.run(docx, context), /^Saved out\/report\.docx: 1 headings, 0 tables, 1 images/);
    assert.match((await documentText(await readFile(path.join(root, 'out', 'report.pdf')), 'pdf', 'r.pdf')).text, /HERON-2291/);

    // Paths: traversal and absolute paths outside the workspace are refused, for the output, the source, and images.
    await assert.rejects(() => pdfTool.run(pdfTool.parse({ output_path: '../escape.pdf', title: 't', markdown: '# x' }), context), /outside the workspace/);
    await assert.rejects(() => pdfTool.run(pdfTool.parse({ output_path: '/tmp/escape.pdf', title: 't', markdown: '# x' }), context), /outside the workspace/);
    await assert.rejects(() => documentTool.run(documentTool.parse({ output_path: 'x.docx', title: 't', source_path: '../../etc/notes.md' }), context), /outside the workspace/);
    await assert.rejects(() => pdfTool.run(pdfTool.parse({ output_path: 'x.pdf', title: 't', markdown: '![x](../../secret.png)' }), context), /outside the workspace/);
    await assert.rejects(() => pdfTool.run(pdfTool.parse({ output_path: 'x.pdf', title: 't', markdown: '![x](https://example.com/a.png)' }), context), /not a workspace file/);
    assert.equal(existsSync(path.join(root, '..', 'escape.pdf')), false);

    // Bad input is a ToolError the model can act on, never a crash.
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ output_path: 'x.pdf', title: 't' }, /either markdown or source_path/],
      [{ output_path: 'x.pdf', title: 't', markdown: '# a', source_path: 'a.md' }, /either markdown or source_path/],
      [{ output_path: 'x.docx', title: 't', markdown: '# a' }, /must end in \.pdf/],
      [{ output_path: 'x.pdf', markdown: '# a' }, /Missing required parameter "title"/],
      [{ output_path: 'x.pdf', title: 't', markdown: '# a', page_size: 'A3' }, /page_size must be A4 or Letter/],
      [{ output_path: 'x.pdf', title: 't', markdown: '# a', date: 'yesterday' }, /date must be YYYY-MM-DD/],
      [{ output_path: 'x.pdf', title: 't', markdown: 42 }, /"markdown" must be a string/],
      [{ output_path: 'x.pdf', title: 't', source_path: 'report.docx' }, /must end in \.md/]
    ];
    for (const [raw, message] of bad) assert.throws(() => pdfTool.parse(raw), (error: Error) => error instanceof ToolError && message.test(error.message), JSON.stringify(raw));
    await assert.rejects(() => pdfTool.run(pdfTool.parse({ output_path: 'x.pdf', title: 't', source_path: 'missing.md' }), context), (error: Error) => error instanceof ToolError && /missing\.md does not exist/.test(error.message));
    await assert.rejects(() => pdfTool.run(pdfTool.parse({ output_path: 'x.pdf', title: 't', markdown: '   \n' }), context), (error: Error) => error instanceof ToolError && /no content/.test(error.message));
    await assert.rejects(() => documentTool.run(documentTool.parse({ output_path: 'x.docx', title: 't', markdown: '![x](report/REPORT.md)' }), context), (error: Error) => error instanceof ToolError && /Use a PNG, JPEG, or SVG/.test(error.message));

    // The same safety hooks as CreatePresentation: protected writes and credential-looking reads ask first.
    assert.match(String(await pdfTool.sensitive!(pdfTool.parse({ output_path: '.git/hooks/x.pdf', title: 't', markdown: '# a' }), context)), /inside \.git/);
    assert.match(String(await documentTool.sensitive!(documentTool.parse({ output_path: 'ok.docx', title: 't', markdown: '![k](keys/id_rsa.png)\n\n![k](.ssh/x.png)' }), context)), /credentials/);
    assert.equal(await pdfTool.sensitive!(pdf, context), undefined);

    await context.checkpoints.revert();
    for (const file of ['out/report.pdf', 'out/report.docx']) assert.equal(existsSync(path.join(root, file)), false, `${file} is removed by Revert`);
  } finally {
    context.shell.dispose();
  }
});

test('a member that lists CreatePresentation also gets CreatePdf and CreateDocument, without its team file changing', () => {
  assert.deepEqual(resolveMemberTools(['Read', 'CreatePresentation']), ['Read', 'CreatePresentation', 'CreatePdf', 'CreateDocument']);
  assert.deepEqual(resolveMemberTools(['Read', 'Write']), ['Read', 'Write']);
  assert.deepEqual(resolveMemberTools(['CreatePresentation', 'CreatePdf']), ['CreatePresentation', 'CreatePdf', 'CreateDocument']);
  for (const tool of ['CreatePdf', 'CreateDocument', 'CreatePresentation']) assert.ok(DEFAULT_TOOLS.includes(tool), `${tool} is a default tool`);
  const text = '---\nname: Old research team\n---\n\n## writer\nrole: implementer\ntools: Read, Write, CreatePresentation, RenderSvg\n\nDraft the report.\n\n## editor\ntools: Read, CheckCitations\n\nEdit it.\n';
  const team = parseTeam(text, '/tmp/old.md');
  assert.deepEqual(team.members[0].tools, ['Read', 'Write', 'CreatePresentation', 'RenderSvg', 'CreatePdf', 'CreateDocument']);
  assert.deepEqual(team.members[1].tools, ['Read', 'CheckCitations'], 'a member without CreatePresentation gains nothing');
});

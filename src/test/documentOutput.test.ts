import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { RunCheckpoints } from '../agent/checkpoints';
import { prepareImage } from '../agent/docImages';
import { parseDocument, parseInline, parseMarkdown } from '../agent/docMarkdown';
import { documentText, PDFJS_DIR } from '../agent/documents';
import { createDocx } from '../agent/docxWriter';
import { documentTool, GRAPHICS_TOOLS, pdfTool } from '../agent/graphicsTools';
import { createPdf, pdfDate } from '../agent/pdfWriter';
import { ShellSession } from '../agent/shell';
import { DEFAULT_TOOLS, parseTeam, resolveMemberTools } from '../agent/teams';
import type { ToolContext } from '../agent/tools';
import { ToolError } from '../agent/workspace';
import { readZip, writeZip } from '../agent/zip';

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
    assert.match(await pdfTool.run(pdf, context), /^Saved out\/report\.pdf: \d+ pages, 4 bookmarks, 1 images, 0 endnotes, \d+ KB\.$/);
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

const CITED = `# Cited report

The market grew 12% in 2025.[^growth] Costs fell, as the regulator reported.[^reg] Growth again.[^growth]

| Claim | Note |
| --- | --- |
| Prices rose | See source.[^prices] |

[^reg]: Annual review, Regulator, 2026-03-01. https://regulator.example/review
[^growth]: Market survey, Example Institute, 2026-01-15. [Survey page](https://institute.example/survey), accessed 2026-11-01.
[^prices]: Price index, Statistics office.
    https://stats.example/prices
`;

test('notes are numbered in order of first citation, and broken notes are errors that name the id', () => {
  const { notes } = parseDocument(CITED);
  assert.deepEqual(notes.map((note) => [note.id, note.number]), [['growth', 1], ['reg', 2], ['prices', 3]]);
  assert.ok(notes[2].inlines.some((run) => run.link === 'https://stats.example/prices'), 'a continuation line and a bare URL become part of the note, as a link');
  const fails: Array<[string, RegExp]> = [
    ['Claim.[^missing]\n', /Footnote reference \[\^missing\] has no definition/],
    ['Claim.\n\n[^orphan]: Source.\n', /Footnote \[\^orphan\] is defined but nothing references it/],
    ['Claim.[^a]\n\n[^a]: One.\n[^a]: Two.\n', /Footnote \[\^a\] is defined more than once/],
    ['Claim.[^a]\n\n[^a]: See [^b].\n[^b]: B.\n', /Footnote \[\^a\] refers to another footnote \(\[\^b\]\)/]
  ];
  for (const [source, message] of fails) assert.throws(() => parseDocument(source), (error: Error) => error instanceof ToolError && message.test(error.message), source);
  assert.deepEqual(parseDocument('```\n[^x]: not a note\n```\n').notes, [], 'a note-like line inside a code block is code');
});

test('PDF endnotes and footnotes carry superscript numbers, a Notes section or page-foot notes, clickable URLs, and links from each reference', async () => {
  const { blocks, notes } = parseDocument(CITED);
  const endnotes = createPdf({ title: 'Cited', blocks, notes, images: new Map() });
  assert.equal(endnotes.notes, 3);
  assertXref(endnotes.bytes);
  const text = (await documentText(endnotes.bytes, 'pdf', 'e.pdf')).text;
  assert.match(text, /grew 12% in 2025\.\s*1 Costs fell, as the regulator reported\.\s*2 Growth again\.\s*1/, text);
  const notesAt = text.indexOf('Notes\n');
  assert.ok(notesAt > text.indexOf('Prices rose'), 'the Notes section comes after the body');
  const section = text.slice(notesAt);
  assert.ok(section.indexOf('Market survey') < section.indexOf('Annual review') && section.indexOf('Annual review') < section.indexOf('Price index'), 'notes are listed in number order');
  const { doc, close } = await openPdf(endnotes.bytes);
  try {
    const titles = (await doc.getOutline())!.map((item) => item.title);
    assert.ok(titles.includes('Notes') || JSON.stringify(await doc.getOutline()).includes('"Notes"'), 'Notes has a bookmark');
    const annotations = (await doc.getPage(1)).getAnnotations();
    const links = await annotations;
    for (const url of ['https://regulator.example/review', 'https://institute.example/survey', 'https://stats.example/prices']) assert.ok(links.some((link) => link.url === url), `${url} is a link`);
    assert.ok(links.filter((link) => link.subtype === 'Link' && !link.url).length >= 4, 'each reference links to its note');
  } finally { await close(); }

  const footnotes = createPdf({ title: 'Cited', blocks, notes, noteStyle: 'footnotes', images: new Map() });
  assertXref(footnotes.bytes);
  const footText = (await documentText(footnotes.bytes, 'pdf', 'f.pdf')).text;
  assert.ok(!/\nNotes\n/.test(footText), 'footnotes have no Notes section');
  assert.ok(footText.indexOf('Market survey') > footText.indexOf('Prices rose') && footText.indexOf('Market survey') < footText.indexOf('Page 1 of'), 'footnotes sit at the foot of the page, above the page number');
  assert.ok(createPdf({ title: 'Cited', blocks, notes, images: new Map() }).bytes.equals(endnotes.bytes), 'deterministic with notes');
});

test('footnotes move with the line that cites them to the next page when they do not fit', async () => {
  const filler = 'Body text that fills the page with ordinary sentences. '.repeat(52);
  const source = `${filler}\n\n${filler}\n\nThe cited line.[^late]\n\n[^late]: ${'A long note that needs several lines at the foot of the page. '.repeat(6)}\n`;
  const { blocks, notes } = parseDocument(source);
  const result = createPdf({ title: 'Flow', blocks, notes, noteStyle: 'footnotes', images: new Map() });
  const text = (await documentText(result.bytes, 'pdf', 'flow.pdf')).text;
  const pageOf = (needle: string) => text.slice(0, text.indexOf(needle)).split('[Page ').length - 1;
  assert.equal(pageOf('The cited line.'), pageOf('A long note that needs'), 'the note is printed on the page of its reference');
});

test('Word notes are real endnotes or footnotes, with styles, relationships, and content types, and read back in order', async () => {
  const { blocks, notes } = parseDocument(CITED);
  for (const kind of ['endnote', 'footnote'] as const) {
    const result = createDocx({ title: 'Cited', blocks, notes, noteStyle: `${kind}s`, images: new Map() });
    assert.equal(result.notes, 3);
    const zip = readZip(result.bytes, 'cited.docx');
    const part = (name: string) => zip.get(name)?.().toString('utf8') ?? '';
    const document = part('word/document.xml');
    const references = [...document.matchAll(new RegExp(`<w:${kind}Reference w:id="(\\d+)"/>`, 'g'))].map((match) => Number(match[1]));
    assert.deepEqual(references, [1, 2, 3], `${kind} references in reading order`);
    assert.match(document, /<w:rStyle w:val="\w+Reference"\/><\/w:rPr><w:t>1<\/w:t>/, 'the repeated citation shows the same number');
    const notesXml = part(`word/${kind}s.xml`);
    assert.match(notesXml, new RegExp(`<w:${kind} w:type="separator" w:id="-1">`));
    assert.match(notesXml, new RegExp(`<w:${kind} w:id="1"><w:p><w:pPr><w:pStyle w:val="${kind === 'footnote' ? 'Footnote' : 'Endnote'}Text"/>`));
    assert.match(part('word/_rels/document.xml.rels'), new RegExp(`Type="[^"]+/${kind}s" Target="${kind}s\\.xml"`));
    assert.match(part('[Content_Types].xml'), new RegExp(`PartName="/word/${kind}s\\.xml" ContentType="application/vnd\\.openxmlformats-officedocument\\.wordprocessingml\\.${kind}s\\+xml"`));
    assert.match(part('word/styles.xml'), new RegExp(`w:styleId="${kind === 'footnote' ? 'Footnote' : 'Endnote'}Reference"><w:name w:val="${kind} reference"/>[\\s\\S]*?<w:vertAlign w:val="superscript"/>`));
    const noteRels = part(`word/_rels/${kind}s.xml.rels`);
    assert.match(noteRels, /Target="https:\/\/institute\.example\/survey" TargetMode="External"/);
    const link = /Id="(rId\d+)"[^>]*Target="https:\/\/stats\.example\/prices"/.exec(noteRels);
    assert.ok(link && notesXml.includes(`<w:hyperlink r:id="${link[1]}">`), 'a URL in a note is a link in the notes part');
    if (kind === 'endnote') assert.match(document, /<w:endnotePr><w:numFmt w:val="decimal"\/><\/w:endnotePr>/, 'endnotes are numbered 1, 2, 3, not i, ii, iii');
    const text = (await documentText(result.bytes, 'docx', 'cited.docx')).text;
    assert.match(text, new RegExp(`${kind === 'footnote' ? 'Footnotes' : 'Endnotes'}:\\n\\[1\\] Market survey, Example Institute, 2026-01-15\\. Survey page, accessed 2026-11-01\\.\\n\\[2\\] Annual review, Regulator, 2026-03-01\\. https://regulator\\.example/review\\n\\[3\\] Price index, Statistics office\\. https://stats\\.example/prices$`), text);
    assert.ok(createDocx({ title: 'Cited', blocks, notes, noteStyle: `${kind}s`, images: new Map() }).bytes.equals(result.bytes), 'deterministic with notes');
  }
});

test('the tools take a notes option and report a broken note as a ToolError', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-notes-'));
  const context = toolContext(root);
  try {
    const input = documentTool.parse({ output_path: 'cited.docx', title: 'Cited', markdown: CITED, notes: 'footnotes' });
    assert.equal(input.notes, 'footnotes');
    assert.equal(pdfTool.parse({ output_path: 'c.pdf', title: 'C', markdown: CITED }).notes, 'endnotes', 'endnotes by default');
    assert.match(await documentTool.run(input, context), /3 footnotes/);
    assert.match(await pdfTool.run(pdfTool.parse({ output_path: 'cited.pdf', title: 'Cited', markdown: CITED }), context), /3 endnotes/);
    assert.throws(() => pdfTool.parse({ output_path: 'c.pdf', title: 'C', markdown: CITED, notes: 'sidenotes' }), /notes must be endnotes or footnotes/);
    await assert.rejects(() => pdfTool.run(pdfTool.parse({ output_path: 'c.pdf', title: 'C', markdown: 'Claim.[^gone]\n' }), context), (error: Error) => error instanceof ToolError && /\[\^gone\] has no definition/.test(error.message));
  } finally {
    context.shell.dispose();
  }
});

test('a table row with more cells than its header is an error that names the row, not a silent loss', async () => {
  assert.throws(() => parseMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 | 5 |\n'), (error: Error) => error instanceof ToolError && /^Row 2 of the table headed "A \| B" has 3 cells, but the header has 2 columns: \| 3 \| 4 \| 5 \|\./.test(error.message));
  const short = parseMarkdown('| A | B |\n| --- | --- |\n| 1 |\n| a \\| b | c |\n');
  assert.deepEqual(short[0].kind === 'table' && short[0].rows.map((row) => row.map((cell) => cell.map((run) => run.text).join(''))), [['1', ''], ['a | b', 'c']], 'a short row is padded and an escaped | is text');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-table-'));
  const context = toolContext(root);
  try {
    await assert.rejects(() => pdfTool.run(pdfTool.parse({ output_path: 't.pdf', title: 'T', markdown: '| A |\n| --- |\n| 1 | 2 |\n' }), context), (error: Error) => error instanceof ToolError && /Row 1 of the table headed "A" has 2 cells/.test(error.message));
    assert.equal(existsSync(path.join(root, 't.pdf')), false, 'nothing is written');
  } finally {
    context.shell.dispose();
  }
});

test('notes read back with their own ids, not their position, when the ids are not 1, 2, 3', async () => {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const docx = writeZip([
    ['word/document.xml', Buffer.from(`<w:document xmlns:w="${w}"><w:body><w:p><w:r><w:t>Claim</w:t></w:r><w:r><w:footnoteReference w:id="7"/></w:r><w:r><w:t> and another</w:t></w:r><w:r><w:footnoteReference w:id="3"/></w:r></w:p></w:body></w:document>`)],
    ['word/footnotes.xml', Buffer.from(`<w:footnotes xmlns:w="${w}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="3"><w:p><w:r><w:t>Source three.</w:t></w:r></w:p></w:footnote><w:footnote w:id="7"><w:p><w:r><w:t>Source seven.</w:t></w:r></w:p></w:footnote></w:footnotes>`)]
  ]);
  assert.equal((await documentText(docx, 'docx', 'ids.docx')).text, 'Claim and another\n\nFootnotes:\n[3] Source three.\n[7] Source seven.');
});

test('a link with a stray % still makes a PDF, and the link keeps its target as written', async () => {
  const result = createPdf({ title: 'Links', blocks: parseMarkdown('See [the sale](https://example.com/100%off) and [a good one](https://example.com/a%20b).\n'), images: new Map() });
  const { doc, close } = await openPdf(result.bytes);
  try {
    const urls = (await (await doc.getPage(1)).getAnnotations()).map((annotation) => annotation.url);
    assert.ok(urls.includes('https://example.com/100%off'), JSON.stringify(urls));
    assert.ok(urls.includes('https://example.com/a%20b'));
  } finally { await close(); }
});

test('an impossible date is refused rather than rolled over to another day', () => {
  assert.equal(pdfDate('2026-02-28'), 'D:20260228000000Z');
  assert.equal(pdfDate('2028-02-29T23:59:59Z'), 'D:20280229235959Z', 'a leap day');
  for (const value of ['2026-02-31', '2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-01-01T24:00', '2026-01-01T10:60', '2026-01-01T10:00:61Z']) {
    assert.throws(() => pdfDate(value), (error: Error) => error instanceof ToolError && error.message === `date "${value}" is not a real date and time.`, value);
  }
  assert.throws(() => pdfTool.parse({ output_path: 'x.pdf', title: 't', markdown: '# a', date: '2026-02-31' }), /is not a real date and time/);
});

test('a footnote too long for any page is an error naming it, not a note pushed off the page', () => {
  const huge = 'A very long note that goes on and on. '.repeat(600);
  const { blocks, notes } = parseDocument(`# Report\n\nA claim.[^long] Another claim.[^ok]\n\n[^long]: ${huge}\n[^ok]: Short source.\n`);
  assert.throws(() => createPdf({ title: 'T', blocks, notes, noteStyle: 'footnotes', images: new Map() }), (error: Error) => error instanceof ToolError && /^Footnote \[\^long\] is too long to fit at the foot of a page with the line that cites it\./.test(error.message));
  assert.ok(createPdf({ title: 'T', blocks, notes, noteStyle: 'endnotes', images: new Map() }).pages >= 2, 'as an endnote it is fine');
  const table = parseDocument(`| Claim |\n| --- |\n| cited[^long] |\n\n[^long]: ${huge}\n`);
  assert.throws(() => createPdf({ title: 'T', blocks: table.blocks, notes: table.notes, noteStyle: 'footnotes', images: new Map() }), /Footnote \[\^long\] is too long/);
  // A long note that does fit moves to a fresh page with the line that cites it.
  const fits = parseDocument(`${'Filler sentence for the page. '.repeat(160)}\n\nThe cited line.[^mid]\n\n[^mid]: ${'A note of moderate length. '.repeat(60)}\n`);
  const result = createPdf({ title: 'T', blocks: fits.blocks, notes: fits.notes, noteStyle: 'footnotes', images: new Map() });
  assertXref(result.bytes);
  return documentText(result.bytes, 'pdf', 'fits.pdf').then((read) => {
    const pageOf = (needle: string) => read.text.slice(0, read.text.indexOf(needle)).split('[Page ').length - 1;
    assert.equal(pageOf('The cited line.'), pageOf('A note of moderate length.'));
  });
});

test('a Word document makes only web and mail links live, like the PDF: a script, file or network-share target stays text', () => {
  const blocks = parseMarkdown('[web](https://example.com/a) [mail](mailto:a@example.com) [js](javascript:alert(1)) [file](file:///etc/passwd) [share](\\\\host\\share)\n');
  const zip = readZip(createDocx({ title: 'Links', blocks, images: new Map() }).bytes, 'links.docx');
  const rels = zip.get('word/_rels/document.xml.rels')!().toString('utf8');
  assert.match(rels, /Target="https:\/\/example\.com\/a" TargetMode="External"/);
  assert.match(rels, /Target="mailto:a@example\.com" TargetMode="External"/);
  assert.doesNotMatch(rels, /javascript:|file:|host/i, 'no relationship for an unsafe target');
  const document = zip.get('word/document.xml')!().toString('utf8');
  for (const text of ['js', 'file', 'share']) assert.match(document, new RegExp(`<w:t xml:space="preserve">${text}</w:t>`), `${text} is kept as text`);
});

test('a member whose instructions open with a "Privacy: ..." sentence still loads, and a one-word privacy typo is still reported', () => {
  const team = (line: string) => `---\nname: T\ndescription: d\n---\n\n## writer\nrole: writer\n${line}\nWrite things.\n`;
  const loaded = parseTeam(team('Privacy: handle client data carefully.'), 't.md');
  assert.equal(loaded.members[0]!.privacy, undefined);
  assert.match(loaded.members[0]!.instructions, /^Privacy: handle client data carefully\.\nWrite things\./);
  assert.equal(parseTeam(team('privacy: private'), 't.md').members[0]!.privacy, 'private');
  assert.throws(() => parseTeam(team('privacy: privat'), 't.md'), /privacy: privat/);
});

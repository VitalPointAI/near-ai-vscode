import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DocImage, prepareImage } from './docImages';
import { Block, imageReferences, Note, parseDocument, parseMarkdown } from './docMarkdown';
import { createDocx } from './docxWriter';
import { createPresentation, DeckSpec, renderSvg, SlideSpec, TraceDetail, vectorize } from './graphics';
import { createPdf, NoteStyle, PageSize, pdfDate } from './pdfWriter';
import { AgentTool, protectedWrite, sensitiveRead, ToolContext } from './tools';
import { displayPath, resolveInWorkspace, ToolError } from './workspace';

// Graphics and document tools for the agent: trace an image into SVG, render SVG to PNG, and build
// .pptx decks, .pdf files, and .docx documents.
// Everything runs on this machine; files are read from and written into the workspace only.

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const text = (raw: Record<string, unknown>, key: string, required = true): string | undefined => {
  const value = raw[key];
  if (value === undefined || value === null || value === '') { if (required) throw new ToolError(`Missing required parameter "${key}".`); return undefined; }
  if (typeof value !== 'string') throw new ToolError(`Parameter "${key}" must be a string.`);
  return value;
};
const withExtension = (value: string, pattern: RegExp, label: string) => { if (!pattern.test(value)) throw new ToolError(`${value} must end in ${label}.`); return value; };

async function readImage(context: ToolContext, requested: string): Promise<{ absolute: string; bytes: Buffer }> {
  const absolute = await resolveInWorkspace(context.root, requested, context.readOnlyRoots);
  const info = await stat(absolute).catch(() => { throw new ToolError(`${requested} does not exist.`); });
  if (!info.isFile()) throw new ToolError(`${requested} is not a file.`);
  if (info.size > MAX_IMAGE_BYTES) throw new ToolError(`${requested} is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  return { absolute, bytes: await readFile(absolute) };
}

async function save(context: ToolContext, requested: string, content: Buffer | string): Promise<string> {
  const absolute = await resolveInWorkspace(context.root, requested);
  await context.checkpoints.capture(absolute);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return displayPath(context.root, absolute);
}

async function writeReason(context: ToolContext, output: string, inputs: string[]): Promise<string | undefined> {
  for (const input of inputs) { const reason = await sensitiveRead(input, context); if (reason) return reason; }
  return protectedWrite(output, context);
}

export const vectorizeTool: AgentTool<{ image: string; output: string; colors?: number; detail: TraceDetail }> = {
  name: 'VectorizeImage',
  description: 'Trace a PNG, JPEG, or GIF in the workspace into an SVG with flat color shapes (logos, icons, diagrams, simple illustrations; photos become posterized). Use colors 2-4 for line art and logos, 8-16 for illustrations. Check the result with RenderSvg.',
  parameters: { type: 'object', properties: { image_path: { type: 'string' }, output_path: { type: 'string', description: 'Where to save the .svg.' }, colors: { type: 'number', description: 'Number of colors, 2-64 (default 16).' }, detail: { type: 'string', enum: ['low', 'medium', 'high'], description: 'low: smoother, fewer shapes; high: keeps small details (default medium).' } }, required: ['image_path', 'output_path'], additionalProperties: false },
  capability: 'workspaceWrite',
  parse: (raw) => {
    const detail = raw.detail === undefined ? 'medium' : raw.detail;
    if (detail !== 'low' && detail !== 'medium' && detail !== 'high') throw new ToolError('detail must be low, medium, or high.');
    if (raw.colors !== undefined && (typeof raw.colors !== 'number' || raw.colors < 2 || raw.colors > 64)) throw new ToolError('colors must be a number from 2 to 64.');
    return { image: text(raw, 'image_path')!, output: withExtension(text(raw, 'output_path')!, /\.svg$/i, '.svg'), ...(typeof raw.colors === 'number' ? { colors: raw.colors } : {}), detail };
  },
  title: (input) => `Vectorize ${input.image} → ${input.output}`,
  sensitive: (input, context) => writeReason(context, input.output, [input.image]),
  async preview(input) { return { kind: 'note', text: `Trace ${input.image} into ${input.output} (${input.colors ?? 16} colors, ${input.detail} detail).` }; },
  async run(input, context) {
    const { bytes } = await readImage(context, input.image);
    const result = await vectorize(bytes, { colors: input.colors, detail: input.detail });
    const saved = await save(context, input.output, result.svg);
    return `Saved ${saved}: ${result.width}×${result.height}, ${result.paths} shapes, ${Math.round(result.svg.length / 1024)} KB.`;
  }
};

export const renderSvgTool: AgentTool<{ svg: string; output: string; width?: number }> = {
  name: 'RenderSvg',
  description: 'Render an SVG in the workspace to a PNG, to check how it looks or for places that need a raster image (favicons, README badges, social cards). Text uses the bundled DejaVu Sans fonts.',
  parameters: { type: 'object', properties: { svg_path: { type: 'string' }, output_path: { type: 'string', description: 'Where to save the .png.' }, width: { type: 'number', description: 'Output width in pixels (default: the SVG\'s own width).' } }, required: ['svg_path', 'output_path'], additionalProperties: false },
  capability: 'workspaceWrite',
  parse: (raw) => {
    if (raw.width !== undefined && (typeof raw.width !== 'number' || raw.width < 1 || raw.width > 8_192)) throw new ToolError('width must be a number from 1 to 8192.');
    return { svg: withExtension(text(raw, 'svg_path')!, /\.svg$/i, '.svg'), output: withExtension(text(raw, 'output_path')!, /\.png$/i, '.png'), ...(typeof raw.width === 'number' ? { width: raw.width } : {}) };
  },
  title: (input) => `Render ${input.svg} → ${input.output}`,
  sensitive: (input, context) => writeReason(context, input.output, [input.svg]),
  async preview(input) { return { kind: 'note', text: `Render ${input.svg} to ${input.output}${input.width ? ` at ${input.width}px wide` : ''}.` }; },
  async run(input, context) {
    const { bytes } = await readImage(context, input.svg);
    const result = await renderSvg(bytes, input.width);
    const saved = await save(context, input.output, result.png);
    return `Saved ${saved}: ${result.width}×${result.height} PNG, ${Math.round(result.png.length / 1024)} KB.`;
  }
};

const LAYOUTS = ['title', 'section', 'content', 'image', 'two-column'] as const;

function parseSlide(raw: unknown, index: number): SlideSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError(`slides[${index}] must be an object.`);
  const value = raw as Record<string, unknown>;
  const optional = (key: string, max = 4_000) => { const item = value[key]; if (item === undefined || item === null) return undefined; if (typeof item !== 'string') throw new ToolError(`slides[${index}].${key} must be a string.`); return item.slice(0, max); };
  const layout = value.layout;
  if (layout !== undefined && !LAYOUTS.includes(layout as typeof LAYOUTS[number])) throw new ToolError(`slides[${index}].layout must be one of ${LAYOUTS.join(', ')}.`);
  const bullets = value.bullets === undefined ? undefined : Array.isArray(value.bullets) ? value.bullets.slice(0, 40).map((bullet, number) => {
    if (typeof bullet === 'string') return bullet.slice(0, 1_000);
    if (bullet && typeof bullet === 'object' && typeof (bullet as { text?: unknown }).text === 'string') return { text: String((bullet as { text: string }).text).slice(0, 1_000), level: Number((bullet as { level?: unknown }).level) || 0 };
    throw new ToolError(`slides[${index}].bullets[${number}] must be a string or { text, level }.`);
  }) : (() => { throw new ToolError(`slides[${index}].bullets must be an array.`); })();
  const columns = value.columns === undefined ? undefined : Array.isArray(value.columns) ? value.columns.slice(0, 2).map((column) => {
    const item = (column ?? {}) as { heading?: unknown; bullets?: unknown };
    return { ...(typeof item.heading === 'string' ? { heading: item.heading.slice(0, 200) } : {}), bullets: Array.isArray(item.bullets) ? item.bullets.filter((entry): entry is string => typeof entry === 'string').slice(0, 30) : [] };
  }) : (() => { throw new ToolError(`slides[${index}].columns must be an array.`); })();
  return { ...(layout ? { layout: layout as SlideSpec['layout'] } : {}), title: optional('title', 300), subtitle: optional('subtitle', 500), text: optional('text'), image: optional('image', 1_000), caption: optional('caption', 300), notes: optional('notes', 10_000), ...(bullets ? { bullets } : {}), ...(columns ? { columns } : {}) };
}

export const presentationTool: AgentTool<{ output: string; deck: DeckSpec }> = {
  name: 'CreatePresentation',
  description: 'Create a 16:9 PowerPoint (.pptx) deck from a slide outline. Layouts: title (title + subtitle), section (divider), content (title + text/bullets, optional image on the right), image (title + one large image + caption), two-column (two headed bullet lists). Images are workspace paths to PNG, JPEG, GIF, or SVG; SVGs stay sharp (with a PNG fallback for old viewers). Speaker notes go in notes.',
  parameters: {
    type: 'object',
    properties: {
      output_path: { type: 'string', description: 'Where to save the .pptx.' },
      title: { type: 'string' }, author: { type: 'string' },
      theme: { type: 'object', properties: { background: { type: 'string', description: '#RRGGBB' }, text: { type: 'string', description: '#RRGGBB' }, accent: { type: 'string', description: '#RRGGBB, used for titles' }, font: { type: 'string', description: 'Font name, e.g. Arial' } }, additionalProperties: false },
      slides: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: { layout: { type: 'string', enum: [...LAYOUTS] }, title: { type: 'string' }, subtitle: { type: 'string' }, text: { type: 'string' }, bullets: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { text: { type: 'string' }, level: { type: 'number' } }, required: ['text'] }] } }, image: { type: 'string' }, caption: { type: 'string' }, columns: { type: 'array', maxItems: 2, items: { type: 'object', properties: { heading: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } } } }, notes: { type: 'string' } } } }
    },
    required: ['output_path', 'slides'],
    additionalProperties: false
  },
  capability: 'workspaceWrite',
  parse: (raw) => {
    if (!Array.isArray(raw.slides) || !raw.slides.length) throw new ToolError('slides must be a non-empty array.');
    if (raw.slides.length > 200) throw new ToolError('A deck can have at most 200 slides.');
    const theme = raw.theme && typeof raw.theme === 'object' ? raw.theme as DeckSpec['theme'] : undefined;
    return { output: withExtension(text(raw, 'output_path')!, /\.pptx$/i, '.pptx'), deck: { title: text(raw, 'title', false), author: text(raw, 'author', false), ...(theme ? { theme } : {}), slides: raw.slides.map(parseSlide) } };
  },
  title: (input) => `Create ${input.output} (${input.deck.slides.length} slides)`,
  sensitive: (input, context) => writeReason(context, input.output, input.deck.slides.map((slide) => slide.image).filter((image): image is string => Boolean(image))),
  async preview(input) {
    return { kind: 'note', text: `Create ${input.output} with ${input.deck.slides.length} slides:\n${input.deck.slides.map((slide, index) => `${index + 1}. ${slide.title ?? slide.layout ?? 'untitled'}${slide.image ? ` [${slide.image}]` : ''}`).join('\n')}` };
  },
  async run(input, context) {
    const images = new Map<string, { bytes: Buffer; name: string }>();
    for (const image of new Set(input.deck.slides.map((slide) => slide.image).filter((value): value is string => Boolean(value)))) images.set(image, { bytes: (await readImage(context, image)).bytes, name: path.basename(image) });
    const result = await createPresentation(input.deck, images);
    const saved = await save(context, input.output, result.bytes);
    return `Saved ${saved}: ${result.slides} slides, ${Math.round(result.bytes.length / 1024)} KB.`;
  }
};

// ---- PDF and Word documents from Markdown -------------------------------------------------------

const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_IMAGES = 200;

export interface DocumentInput { output: string; title: string; author?: string; date?: string; pageSize: PageSize; notes: NoteStyle; markdown?: string; source?: string }

const MARKDOWN_HELP = 'Markdown supported: # to #### headings, paragraphs, **bold**, *italic*, `code`, [links](https://...), - and 1. lists (indent to nest), > quotes, ``` code blocks, | pipe | tables |, --- rules, ![caption](path.png) images on their own line, and notes: cite with [^id] in the text and define each once as a line "[^id]: Title, publisher, date. https://..." (numbered in order of first citation; a missing, unused, or repeated definition is an error) (PNG, JPEG, or SVG in the workspace; paths are relative to source_path\'s folder, or the workspace root for inline markdown).';

const documentParameters = (extension: string) => ({
  type: 'object',
  properties: {
    output_path: { type: 'string', description: `Where to save the ${extension}.` },
    title: { type: 'string', description: 'Document title, stored in its properties.' },
    author: { type: 'string' },
    page_size: { type: 'string', enum: ['A4', 'Letter'], description: 'Default A4.' },
    notes: { type: 'string', enum: ['endnotes', 'footnotes'], description: 'Where [^id] notes go: endnotes (default; a Notes section at the end) or footnotes (at the foot of the page that cites them).' },
    date: { type: 'string', description: 'Optional creation date (YYYY-MM-DD). Without it no date is written, so the same input always gives the same file.' },
    markdown: { type: 'string', description: 'The content as Markdown. Give this or source_path, not both.' },
    source_path: { type: 'string', description: 'A Markdown file in the workspace to convert (for example the report you wrote). Give this or markdown, not both.' }
  },
  required: ['output_path', 'title'],
  additionalProperties: false
});

function parseDocumentInput(raw: Record<string, unknown>, pattern: RegExp, label: string): DocumentInput {
  const pageSize = raw.page_size === undefined || raw.page_size === null || raw.page_size === '' ? 'A4' : raw.page_size;
  if (pageSize !== 'A4' && pageSize !== 'Letter') throw new ToolError('page_size must be A4 or Letter.');
  const notes = raw.notes === undefined || raw.notes === null || raw.notes === '' ? 'endnotes' : raw.notes;
  if (notes !== 'endnotes' && notes !== 'footnotes') throw new ToolError('notes must be endnotes or footnotes.');
  const markdown = raw.markdown === undefined || raw.markdown === null ? undefined : raw.markdown;
  if (markdown !== undefined && typeof markdown !== 'string') throw new ToolError('Parameter "markdown" must be a string.');
  const source = text(raw, 'source_path', false);
  if ((markdown !== undefined) === (source !== undefined)) throw new ToolError('Give the content as either markdown or source_path (one of them, not both).');
  if (markdown !== undefined && Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) throw new ToolError(`markdown is over ${MAX_MARKDOWN_BYTES / 1024 / 1024} MB.`);
  if (source !== undefined) withExtension(source, /\.(md|markdown|txt)$/i, '.md, .markdown, or .txt');
  const title = text(raw, 'title')!.slice(0, 500);
  const date = text(raw, 'date', false);
  if (date) pdfDate(date);
  return { output: withExtension(text(raw, 'output_path')!, pattern, label), title, author: text(raw, 'author', false)?.slice(0, 300), ...(date ? { date } : {}), pageSize, notes, ...(markdown !== undefined ? { markdown } : {}), ...(source !== undefined ? { source } : {}) };
}

async function documentSource(input: DocumentInput, context: ToolContext): Promise<{ markdown: string; base: string }> {
  if (input.markdown !== undefined) return { markdown: input.markdown, base: '' };
  const absolute = await resolveInWorkspace(context.root, input.source!, context.readOnlyRoots);
  const info = await stat(absolute).catch(() => { throw new ToolError(`${input.source} does not exist.`); });
  if (!info.isFile()) throw new ToolError(`${input.source} is not a file.`);
  if (info.size > MAX_MARKDOWN_BYTES) throw new ToolError(`${input.source} is over ${MAX_MARKDOWN_BYTES / 1024 / 1024} MB.`);
  context.readFiles.add(absolute);
  return { markdown: await readFile(absolute, 'utf8'), base: path.posix.dirname(input.source!.replace(/\\/g, '/')) };
}

/** The workspace path of an image the Markdown refers to; web and data URLs are refused (nothing is downloaded). */
function imagePath(src: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) throw new ToolError(`Image ${src} is not a workspace file. Save the image into the workspace (for example with WebFetch or GenerateImage) and refer to its path.`);
  let decoded = src;
  try { decoded = decodeURI(src); } catch { /* keep it as written */ }
  return base && base !== '.' ? path.posix.join(base, decoded) : decoded;
}

async function loadDocument(input: DocumentInput, context: ToolContext): Promise<{ blocks: Block[]; notes: Note[]; images: Map<string, DocImage> }> {
  const { markdown, base } = await documentSource(input, context);
  const { blocks, notes } = parseDocument(markdown);
  if (!blocks.length) throw new ToolError('The document has no content.');
  const references = imageReferences(blocks);
  if (references.length > MAX_DOCUMENT_IMAGES) throw new ToolError(`A document can have at most ${MAX_DOCUMENT_IMAGES} different images.`);
  const images = new Map<string, DocImage>();
  for (const src of references) {
    const file = imagePath(src, base);
    images.set(src, await prepareImage((await readImage(context, file)).bytes, path.posix.basename(file)));
  }
  return { blocks, notes, images };
}

/** The files a document reads (its source and its images), for the sensitive-read check. */
async function documentReads(input: DocumentInput, context: ToolContext): Promise<string[]> {
  try {
    const { markdown, base } = await documentSource(input, context);
    return [...(input.source ? [input.source] : []), ...imageReferences(parseMarkdown(markdown)).map((src) => { try { return imagePath(src, base); } catch { return undefined; } }).filter((file): file is string => Boolean(file))];
  } catch {
    return input.source ? [input.source] : [];
  }
}

async function documentPreview(input: DocumentInput, context: ToolContext, kind: string) {
  let summary = '';
  try {
    const { markdown } = await documentSource(input, context);
    const { blocks, notes } = parseDocument(markdown);
    const count = (kindOf: Block['kind']) => blocks.filter((block) => block.kind === kindOf).length;
    summary = `: ${count('heading')} headings, ${count('table')} tables, ${imageReferences(blocks).length} images${notes.length ? `, ${notes.length} ${input.notes}` : ''}`;
  } catch { /* the run reports the problem */ }
  return { kind: 'note' as const, text: `Create ${kind} ${input.output} ("${input.title}", ${input.pageSize}) from ${input.source ?? 'the given Markdown'}${summary}.` };
}

const kb = (bytes: Buffer) => `${Math.max(1, Math.round(bytes.length / 1024))} KB`;

export const pdfTool: AgentTool<DocumentInput> = {
  name: 'CreatePdf',
  description: `Create a PDF from Markdown (inline, or a .md file in the workspace), for example to deliver a finished report. Headings become PDF bookmarks, pages are numbered, tables and images are laid out to fit, and the same input always gives the same file. Text uses the standard PDF fonts (Helvetica), which cover Western European languages; other characters are replaced and listed in the result (use CreateDocument for other scripts). ${MARKDOWN_HELP}`,
  parameters: documentParameters('.pdf'),
  capability: 'workspaceWrite',
  parse: (raw) => parseDocumentInput(raw, /\.pdf$/i, '.pdf'),
  title: (input) => `Create ${input.output}`,
  sensitive: async (input, context) => writeReason(context, input.output, await documentReads(input, context)),
  preview: (input, context) => documentPreview(input, context, 'PDF'),
  async run(input, context) {
    const { blocks, notes, images } = await loadDocument(input, context);
    const result = createPdf({ title: input.title, author: input.author, date: input.date, pageSize: input.pageSize, blocks, images, notes, noteStyle: input.notes });
    const saved = await save(context, input.output, result.bytes);
    const missing = result.substituted.length ? ` ${result.substituted.length} character${result.substituted.length === 1 ? '' : 's'} not in the standard PDF fonts ${result.substituted.length === 1 ? 'was' : 'were'} written as "?": ${result.substituted.slice(0, 20).map((char) => `${char} (U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`).join(', ')}. Replace ${result.substituted.length === 1 ? 'it' : 'them'} in the Markdown, or deliver with CreateDocument, which keeps every character.` : '';
    return `Saved ${saved}: ${result.pages} pages, ${result.headings} bookmarks, ${result.images} images, ${result.notes} ${input.notes}, ${kb(result.bytes)}.${missing}`;
  }
};

export const documentTool: AgentTool<DocumentInput> = {
  name: 'CreateDocument',
  description: `Create a Word document (.docx) from Markdown (inline, or a .md file in the workspace), for example to deliver a report people will edit. Headings use Word's Heading 1-4 styles (so the Navigation pane and a table of contents work), and tables, lists, links, and pictures are real Word objects. Every Unicode character is kept. ${MARKDOWN_HELP}`,
  parameters: documentParameters('.docx'),
  capability: 'workspaceWrite',
  parse: (raw) => parseDocumentInput(raw, /\.docx$/i, '.docx'),
  title: (input) => `Create ${input.output}`,
  sensitive: async (input, context) => writeReason(context, input.output, await documentReads(input, context)),
  preview: (input, context) => documentPreview(input, context, 'Word document'),
  async run(input, context) {
    const { blocks, notes, images } = await loadDocument(input, context);
    const result = createDocx({ title: input.title, author: input.author, date: input.date, pageSize: input.pageSize, blocks, images, notes, noteStyle: input.notes });
    const saved = await save(context, input.output, result.bytes);
    return `Saved ${saved}: ${result.headings} headings, ${result.tables} tables, ${result.images} images, ${result.notes} ${input.notes}, ${kb(result.bytes)}.`;
  }
};

export const GRAPHICS_TOOLS: AgentTool<any>[] = [vectorizeTool, renderSvgTool, presentationTool, pdfTool, documentTool];

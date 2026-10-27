import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createPresentation, DeckSpec, renderSvg, SlideSpec, TraceDetail, vectorize } from './graphics';
import { AgentTool, protectedWrite, sensitiveRead, ToolContext } from './tools';
import { displayPath, resolveInWorkspace, ToolError } from './workspace';

// Graphics tools for the agent: trace an image into SVG, render SVG to PNG, and build .pptx decks.
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

export const GRAPHICS_TOOLS: AgentTool<any>[] = [vectorizeTool, renderSvgTool, presentationTool];

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ToolError } from './workspace';
import { readZip, writeZip } from './zip';

// Vector graphics and slide decks, made on this machine with vendored libraries (see
// scripts/vendor-libs.mjs): resvg renders SVG and decodes raster images, imagetracer.js traces
// images into SVG, and pptxgenjs writes .pptx. No network is used; resvg's WebAssembly build has
// no file system, so an SVG cannot pull in local files.

export const VENDOR_DIR = path.join(__dirname, '..', '..', 'vendor');
const MAX_SVG_BYTES = 5 * 1024 * 1024;
const MAX_RENDER_PIXELS = 50_000_000;
const TRACE_TARGET_EDGE = 1_024;
const TRACE_MAX_PIXELS = 1_500_000;

type ResvgModule = {
  initWasm(wasm: Buffer): Promise<void>;
  Resvg: new (svg: string | Uint8Array, options?: Record<string, unknown>) => { render(): { width: number; height: number; pixels: Uint8Array; asPng(): Uint8Array } };
};
type Tracer = { imagedataToSVG(image: { width: number; height: number; data: Uint8Array }, options: Record<string, unknown>): string };

let resvg: Promise<ResvgModule> | undefined;
let fonts: Uint8Array[] | undefined;

function vendorRequire<T>(file: string): T {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(VENDOR_DIR, file)) as T;
  } catch (error) {
    throw new ToolError(`A graphics component is missing from this installation (${(error as Error).message}).`);
  }
}

async function renderer(): Promise<ResvgModule> {
  resvg ??= (async () => {
    const module = vendorRequire<ResvgModule>('resvg/resvg.js');
    await module.initWasm(readFileSync(path.join(VENDOR_DIR, 'resvg', 'resvg.wasm')));
    fonts = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map((file) => new Uint8Array(readFileSync(path.join(VENDOR_DIR, 'fonts', file))));
    return module;
  })().catch((error: unknown) => { resvg = undefined; throw error; });
  return resvg;
}

/** Width and height of a PNG, JPEG, GIF, WebP, or SVG image, from its header. */
export function imageSize(bytes: Buffer): { width: number; height: number; format: 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' } {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: 'png' };
  if (bytes.length > 10 && bytes.toString('ascii', 0, 3) === 'GIF') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), format: 'gif' };
  if (bytes.length > 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), format: 'webp' };
    if (chunk === 'VP8L') { const bits = bytes.readUInt32LE(21); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), format: 'webp' }; }
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, format: 'webp' };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5), format: 'jpeg' };
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }
  const head = bytes.subarray(0, 4096).toString('utf8');
  if (/<svg[\s>]/i.test(head)) {
    const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? '';
    const number = (attribute: string) => { const value = new RegExp(`\\b${attribute}="\\s*([\\d.]+)(px)?\\s*"`).exec(tag)?.[1]; return value ? Number(value) : undefined; };
    const box = /\bviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(tag);
    const width = number('width') ?? (box ? Number(box[1]) : undefined);
    const height = number('height') ?? (box ? Number(box[2]) : undefined);
    if (width && height) return { width, height, format: 'svg' };
    throw new ToolError('The SVG has no width, height, or viewBox to size it by.');
  }
  throw new ToolError('Not a PNG, JPEG, GIF, WebP, or SVG image.');
}

/** Renders SVG to PNG, `width` pixels wide (default: the SVG's own size), with the bundled DejaVu fonts. */
export async function renderSvg(svg: Buffer, width?: number): Promise<{ png: Buffer; width: number; height: number }> {
  if (svg.length > MAX_SVG_BYTES) throw new ToolError(`The SVG is over ${MAX_SVG_BYTES / 1024 / 1024} MB.`);
  const size = imageSize(svg);
  const scale = width ? width / size.width : 1;
  if (size.width * size.height * scale * scale > MAX_RENDER_PIXELS) throw new ToolError('That render would be over 50 megapixels; choose a smaller width.');
  const module = await renderer();
  try {
    const image = new module.Resvg(new Uint8Array(svg), { ...(width ? { fitTo: { mode: 'width', value: Math.round(width) } } : {}), font: { fontBuffers: fonts, defaultFontFamily: 'DejaVu Sans', sansSerifFamily: 'DejaVu Sans', loadSystemFonts: false } }).render();
    return { png: Buffer.from(image.asPng()), width: image.width, height: image.height };
  } catch (error) {
    throw new ToolError(`The SVG could not be rendered: ${(error as Error).message}`);
  }
}

/** RGBA pixels of a raster image, scaled so tracing has enough (but not too much) detail. */
export async function decodeImage(bytes: Buffer): Promise<{ width: number; height: number; pixels: Uint8Array; original: { width: number; height: number } }> {
  const size = imageSize(bytes);
  if (size.format === 'svg') throw new ToolError('The image is already an SVG.');
  if (size.format === 'webp') throw new ToolError('WebP images are not supported for tracing yet; convert to PNG first.');
  const longest = Math.max(size.width, size.height);
  let scale = longest < TRACE_TARGET_EDGE ? Math.min(4, TRACE_TARGET_EDGE / longest) : 1;
  if (size.width * size.height * scale * scale > TRACE_MAX_PIXELS) scale = Math.sqrt(TRACE_MAX_PIXELS / (size.width * size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const mime = size.format === 'jpeg' ? 'image/jpeg' : `image/${size.format}`;
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" preserveAspectRatio="none" href="data:${mime};base64,${bytes.toString('base64')}"/></svg>`;
  const module = await renderer();
  const image = new module.Resvg(wrapper, { font: { loadSystemFonts: false } }).render();
  if (!image.pixels.some((value, index) => index % 4 === 3 && value > 0)) throw new ToolError('The image could not be decoded.');
  return { width: image.width, height: image.height, pixels: image.pixels, original: { width: size.width, height: size.height } };
}

export type TraceDetail = 'low' | 'medium' | 'high';
const DETAIL: Record<TraceDetail, Record<string, number>> = {
  low: { pathomit: 16, ltres: 2, qtres: 2, blurradius: 1, blurdelta: 20 },
  medium: { pathomit: 2, ltres: 1, qtres: 1 },
  high: { pathomit: 0, ltres: 0.5, qtres: 0.5 }
};

/** Traces a PNG, JPEG, or GIF into an SVG with `colors` flat colors, sized like the original. */
export async function vectorize(bytes: Buffer, options: { colors?: number; detail?: TraceDetail } = {}): Promise<{ svg: string; paths: number; width: number; height: number }> {
  const image = await decodeImage(bytes);
  const tracer = vendorRequire<Tracer>('imagetracer/imagetracer.js');
  const colors = Math.max(2, Math.min(64, Math.round(options.colors ?? 16)));
  const traced = tracer.imagedataToSVG({ width: image.width, height: image.height, data: image.pixels }, { numberofcolors: colors, colorquantcycles: 3, roundcoords: 1, ...DETAIL[options.detail ?? 'medium'] });
  const body = traced.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${image.original.width}" height="${image.original.height}" viewBox="0 0 ${image.width} ${image.height}">${body}</svg>\n`;
  return { svg, paths: (body.match(/<path\b/g) ?? []).length, width: image.original.width, height: image.original.height };
}

// ---- Slide decks ----------------------------------------------------------------------------

export interface SlideSpec {
  layout?: 'title' | 'section' | 'content' | 'image' | 'two-column';
  title?: string;
  subtitle?: string;
  bullets?: Array<string | { text: string; level?: number }>;
  text?: string;
  image?: string;
  caption?: string;
  columns?: Array<{ heading?: string; bullets?: string[] }>;
  notes?: string;
}
export interface DeckSpec { title?: string; author?: string; theme?: { background?: string; text?: string; accent?: string; font?: string }; slides: SlideSpec[] }
export interface DeckImage { bytes: Buffer; name: string }

type Pptx = {
  layout: string; title: string; author: string;
  addSlide(): PptxSlide;
  write(options: { outputType: 'nodebuffer' }): Promise<Buffer>;
};
type PptxSlide = { background: { color: string }; addText(text: unknown, options: Record<string, unknown>): void; addImage(options: Record<string, unknown>): void; addNotes(text: string): void };

const hex = (value: string | undefined, fallback: string) => (value && /^#?[0-9a-f]{6}$/i.test(value) ? value.replace('#', '').toUpperCase() : fallback);
const W = 13.333;
const H = 7.5;

/** Fits an image inside a box, keeping its aspect ratio, centered. */
function fit(image: { width: number; height: number }, box: { x: number; y: number; w: number; h: number }) {
  const scale = Math.min(box.w / image.width, box.h / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/**
 * A 16:9 .pptx from a slide outline. SVG images are embedded as SVG (sharp at any size in
 * PowerPoint 2019 and later) with a real PNG fallback rendered here for older viewers.
 */
export async function createPresentation(spec: DeckSpec, images: Map<string, DeckImage>): Promise<{ bytes: Buffer; slides: number }> {
  if (!spec.slides.length) throw new ToolError('A deck needs at least one slide.');
  if (spec.slides.length > 200) throw new ToolError('A deck can have at most 200 slides.');
  const PptxGenJS = vendorRequire<new () => Pptx>('pptxgenjs/pptxgen.cjs');
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.title = spec.title ?? spec.slides[0].title ?? 'Presentation';
  pres.author = spec.author ?? '';
  const background = hex(spec.theme?.background, 'FFFFFF');
  const color = hex(spec.theme?.text, '1F2937');
  const accent = hex(spec.theme?.accent, '2563EB');
  const fontFace = spec.theme?.font?.slice(0, 60) || 'Arial';
  const addImage = (slide: PptxSlide, reference: string, box: { x: number; y: number; w: number; h: number }) => {
    const image = images.get(reference);
    if (!image) throw new ToolError(`Image ${reference} was not loaded.`);
    const size = imageSize(image.bytes);
    const mime = size.format === 'svg' ? 'image/svg+xml' : size.format === 'jpeg' ? 'image/jpeg' : `image/${size.format}`;
    slide.addImage({ data: `data:${mime};base64,${image.bytes.toString('base64')}`, ...fit(size, box), altText: image.name });
  };
  const bulletRuns = (bullets: SlideSpec['bullets'] = []) => bullets.map((bullet) => {
    const item = typeof bullet === 'string' ? { text: bullet, level: 0 } : { text: bullet.text, level: bullet.level ?? 0 };
    return { text: item.text, options: { bullet: true, indentLevel: Math.max(0, Math.min(4, item.level)), breakLine: true } };
  });
  for (const [index, item] of spec.slides.entries()) {
    const slide = pres.addSlide();
    slide.background = { color: background };
    const layout = item.layout ?? (index === 0 && !item.bullets?.length && !item.image ? 'title' : item.image && !item.bullets?.length && !item.text ? 'image' : 'content');
    const text = (value: unknown, options: Record<string, unknown>) => slide.addText(value, { fontFace, color, valign: 'top', fit: 'shrink', ...options });
    if (layout === 'title' || layout === 'section') {
      text(item.title ?? '', { x: 0.8, y: layout === 'title' ? 2.4 : 2.8, w: W - 1.6, h: 1.4, fontSize: layout === 'title' ? 40 : 34, bold: true, align: 'center', valign: 'middle', color: layout === 'section' ? accent : color });
      if (item.subtitle || item.text) text(item.subtitle ?? item.text, { x: 0.8, y: 3.9, w: W - 1.6, h: 1, fontSize: 20, align: 'center' });
      if (item.image) addImage(slide, item.image, { x: W / 2 - 1, y: 0.6, w: 2, h: 1.6 });
    } else {
      if (item.title) text(item.title, { x: 0.6, y: 0.35, w: W - 1.2, h: 0.9, fontSize: 30, bold: true, color: accent });
      const top = item.title ? 1.4 : 0.6;
      if (layout === 'two-column') {
        (item.columns ?? []).slice(0, 2).forEach((column, number) => {
          const x = 0.6 + number * ((W - 1.2) / 2 + 0.1);
          if (column.heading) text(column.heading, { x, y: top, w: (W - 1.4) / 2, h: 0.6, fontSize: 22, bold: true });
          text(bulletRuns(column.bullets), { x, y: top + (column.heading ? 0.7 : 0), w: (W - 1.4) / 2, h: H - top - 1, fontSize: 18 });
        });
      } else if (layout === 'image') {
        if (item.image) addImage(slide, item.image, { x: 0.6, y: top, w: W - 1.2, h: H - top - (item.caption ? 1.1 : 0.5) });
        if (item.caption) text(item.caption, { x: 0.6, y: H - 1, w: W - 1.2, h: 0.6, fontSize: 16, align: 'center', italic: true });
      } else {
        const textWidth = item.image ? (W - 1.2) * 0.55 : W - 1.2;
        const body = [...(item.text ? [{ text: item.text, options: { breakLine: true } }] : []), ...bulletRuns(item.bullets)];
        if (body.length) text(body, { x: 0.6, y: top, w: textWidth, h: H - top - 0.5, fontSize: 20, paraSpaceAfter: 6 });
        if (item.image) addImage(slide, item.image, { x: 0.6 + textWidth + 0.3, y: top, w: W - 1.2 - textWidth - 0.3, h: H - top - (item.caption ? 1.1 : 0.5) });
        if (item.image && item.caption) text(item.caption, { x: 0.6 + textWidth + 0.3, y: H - 1, w: W - 1.2 - textWidth - 0.3, h: 0.6, fontSize: 14, align: 'center', italic: true });
      }
    }
    if (item.notes) slide.addNotes(item.notes);
  }
  const written = await pres.write({ outputType: 'nodebuffer' });
  return { bytes: await withPngFallbacks(Buffer.from(written)), slides: spec.slides.length };
}

/** pptxgenjs, outside a browser, stores the SVG itself where the PNG fallback belongs; render real ones. */
async function withPngFallbacks(deck: Buffer): Promise<Buffer> {
  const zip = readZip(deck, 'the generated deck', 200 * 1024 * 1024);
  const entries: Array<[string, Buffer]> = [];
  for (const [name, read] of zip) {
    let content = read();
    if (/^ppt\/media\/.+\.png$/i.test(name) && /^\s*(<\?xml|<svg)/.test(content.subarray(0, 200).toString('utf8'))) {
      const size = imageSize(content);
      content = (await renderSvg(content, Math.min(2_000, Math.max(800, size.width)))).png;
    }
    entries.push([name, content]);
  }
  return writeZip(entries);
}

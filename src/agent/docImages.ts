import { deflateSync, inflateSync } from 'node:zlib';
import { imageSize, renderSvg } from './graphics';
import { ToolError } from './workspace';

// Figures for CreatePdf and CreateDocument. PNG and JPEG are embedded as they are; an SVG is
// drawn to a PNG with the bundled renderer (the same one RenderSvg uses), and a GIF or WebP, or a
// PNG the PDF writer cannot take as it is, is redrawn the same way. Everything stays on this machine.

export interface DocImage { name: string; format: 'png' | 'jpeg'; bytes: Buffer; width: number; height: number }

/** The longest edge an SVG is drawn at, in pixels: sharp when printed at page width. */
const SVG_EDGE = 1_600;

/** Draws a raster image through resvg at its own size, giving an 8-bit, non-interlaced PNG. */
async function redraw(bytes: Buffer, width: number, height: number, format: string): Promise<Buffer> {
  const mime = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" preserveAspectRatio="none" href="data:${mime};base64,${bytes.toString('base64')}"/></svg>`;
  return (await renderSvg(Buffer.from(wrapper), width)).png;
}

/** Turns a workspace image into a PNG or JPEG both writers can embed. */
export async function prepareImage(bytes: Buffer, name: string): Promise<DocImage> {
  let size: ReturnType<typeof imageSize>;
  try { size = imageSize(bytes); } catch (error) { throw new ToolError(`${name}: ${(error as Error).message} Use a PNG, JPEG, or SVG.`); }
  if (size.format === 'svg') {
    const scale = Math.min(4, SVG_EDGE / Math.max(size.width, size.height));
    const rendered = await renderSvg(bytes, Math.max(1, Math.round(size.width * scale)));
    return { name, format: 'png', bytes: rendered.png, width: rendered.width, height: rendered.height };
  }
  if (!size.width || !size.height) throw new ToolError(`${name} has no size in its header; it may be damaged.`);
  if (size.format === 'jpeg') return { name, format: 'jpeg', bytes, width: size.width, height: size.height };
  if (size.format === 'png' && !needsRedraw(bytes)) return { name, format: 'png', bytes, width: size.width, height: size.height };
  const png = await redraw(bytes, size.width, size.height, size.format);
  const redrawn = imageSize(png);
  return { name, format: 'png', bytes: png, width: redrawn.width, height: redrawn.height };
}

// ---- PNG for PDF ----------------------------------------------------------------------------

interface PngInfo { width: number; height: number; depth: number; colorType: number; interlace: number; palette?: Buffer; transparency?: Buffer; data: Buffer }

function readPng(bytes: Buffer, name: string): PngInfo {
  if (bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47) throw new ToolError(`${name} is not a PNG.`);
  let offset = 8;
  const idat: Buffer[] = [];
  const info: Partial<PngInfo> = {};
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    if (start + length > bytes.length) throw new ToolError(`${name} is a damaged PNG (a ${type} chunk is cut short).`);
    const body = bytes.subarray(start, start + length);
    if (type === 'IHDR') Object.assign(info, { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] });
    else if (type === 'PLTE') info.palette = body;
    else if (type === 'tRNS') info.transparency = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset = start + length + 4;
  }
  if (!info.width || !info.height || !idat.length) throw new ToolError(`${name} is a damaged PNG (no image data).`);
  return { ...(info as PngInfo), data: Buffer.concat(idat) };
}

/** A PNG the PDF writer cannot pass through as it is: interlaced, 16-bit, or with transparency it would have to split out. */
function needsRedraw(bytes: Buffer): boolean {
  try {
    const png = readPng(bytes, 'image');
    return png.interlace !== 0 || png.depth > 8 || Boolean(png.transparency) || ((png.colorType === 4 || png.colorType === 6) && png.depth !== 8);
  } catch { return true; }
}

/** What the PDF needs to draw a PNG: an image stream, and a soft mask when it has an alpha channel. */
export interface PdfImage { dictionary: string; stream: Buffer; mask?: { dictionary: string; stream: Buffer } }

export function pdfImage(image: DocImage): PdfImage {
  if (image.format === 'jpeg') {
    const components = jpegComponents(image.bytes);
    const space = components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
    return { dictionary: `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode`, stream: image.bytes };
  }
  const png = readPng(image.bytes, image.name);
  const head = `/Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height}`;
  if (png.colorType === 0 || png.colorType === 2 || png.colorType === 3) {
    // Pass the compressed rows straight through; the PNG predictor undoes the row filters.
    const colors = png.colorType === 2 ? 3 : 1;
    const space = png.colorType === 3 ? `[/Indexed /DeviceRGB ${Math.max(0, (png.palette?.length ?? 3) / 3 - 1)} <${(png.palette ?? Buffer.alloc(3)).toString('hex')}>]` : colors === 3 ? '/DeviceRGB' : '/DeviceGray';
    return { dictionary: `${head} /ColorSpace ${space} /BitsPerComponent ${png.depth} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${png.depth} /Columns ${png.width} >>`, stream: png.data };
  }
  // Gray or RGB with an 8-bit alpha channel: undo the filters and split the alpha into a soft mask.
  const channels = png.colorType === 6 ? 4 : 2;
  const pixels = unfilter(inflate(png.data, image.name), png.width, png.height, channels);
  const color = Buffer.alloc(png.width * png.height * (channels - 1));
  const alpha = Buffer.alloc(png.width * png.height);
  for (let pixel = 0, source = 0, target = 0; pixel < png.width * png.height; pixel += 1) {
    for (let channel = 0; channel < channels - 1; channel += 1) color[target++] = pixels[source++];
    alpha[pixel] = pixels[source++];
  }
  return {
    dictionary: `${head} /ColorSpace ${channels === 4 ? '/DeviceRGB' : '/DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode`,
    stream: deflateSync(color),
    ...(alpha.every((value) => value === 255) ? {} : { mask: { dictionary: `${head} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, stream: deflateSync(alpha) } })
  };
}

function inflate(data: Buffer, name: string): Buffer {
  try { return inflateSync(data, { maxOutputLength: 400 * 1024 * 1024 }); } catch { throw new ToolError(`${name} is a damaged PNG (its image data does not unpack).`); }
}

function unfilter(raw: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
  const stride = width * bytesPerPixel;
  if (raw.length < height * (stride + 1)) throw new ToolError('A PNG is damaged (its image data is short).');
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride;
    const source = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bytesPerPixel ? out[row + x - bytesPerPixel] : 0;
      const b = y > 0 ? out[row - stride + x] : 0;
      const c = x >= bytesPerPixel && y > 0 ? out[row - stride + x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new ToolError('A PNG is damaged (unknown row filter).');
      out[row + x] = (raw[source + x] + predictor) & 0xff;
    }
  }
  return out;
}

function jpegComponents(bytes: Buffer): number {
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return bytes[offset + 9];
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return 3;
}

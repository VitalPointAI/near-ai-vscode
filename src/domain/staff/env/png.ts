// A small PNG writer and reader for the map's height tiles (Terrarium RGB) and their tests, on node:zlib alone, so the tile builder needs no image
// package. 8-bit RGB or RGBA, not interlaced. The writer picks each row's filter by the usual least-sum-of-differences rule, which keeps the smooth
// height tiles small. The reader takes only what the writer makes (plus every filter type), and refuses anything else.
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encodes 8-bit pixels (`channels` 3 for RGB, 4 for RGBA) as a PNG. */
export function encodePng(pixels: Uint8Array, width: number, height: number, channels: 3 | 4): Uint8Array {
  if (pixels.length !== width * height * channels) throw new Error('encodePng: the pixel buffer does not match the size.');
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    let best = -1, bestSum = Infinity;
    for (let filter = 0; filter < 5; filter += 1) {
      let sum = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? row[i - channels] : 0, b = up ? up[i] : 0, c = up && i >= channels ? up[i - channels] : 0;
        const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - predicted) & 255;
        candidate[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = filter; candidate.copy(raw, y * (stride + 1) + 1); }
    }
    raw[y * (stride + 1)] = best;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return new Uint8Array(Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]));
}

/** Decodes a PNG of 8-bit RGB or RGBA, not interlaced, to RGBA. Throws on anything else or on a bad chunk checksum. */
export function decodePng(bytes: Uint8Array): { readonly width: number; readonly height: number; readonly rgba: Uint8Array } {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 8 || !data.subarray(0, 8).equals(SIGNATURE)) throw new Error('decodePng: not a PNG file.');
  let at = 8, width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  while (at + 12 <= data.length) {
    const length = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > data.length) throw new Error('decodePng: a chunk runs past the end.');
    const body = data.subarray(at + 8, at + 8 + length);
    if (crc32(data.subarray(at + 4, at + 8 + length)) !== data.readUInt32BE(at + 8 + length)) throw new Error(`decodePng: bad checksum in ${type}.`);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6) || body[12] !== 0) throw new Error('decodePng: only 8-bit RGB or RGBA, not interlaced.');
      channels = body[9] === 6 ? 4 : 3;
      if (!(width > 0 && height > 0 && width * height <= 4096 * 4096)) throw new Error('decodePng: unsupported size.');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!channels) throw new Error('decodePng: no header.');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error('decodePng: the image data has the wrong length.');
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('decodePng: unknown filter.');
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? out[y * stride + i - channels] : 0, b = y > 0 ? out[(y - 1) * stride + i] : 0, c = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels] : 0;
      const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
      out[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + predicted) & 255;
    }
  }
  if (channels === 4) return { width, height, rgba: out };
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) { rgba[p * 4] = out[p * 3]; rgba[p * 4 + 1] = out[p * 3 + 1]; rgba[p * 4 + 2] = out[p * 3 + 2]; rgba[p * 4 + 3] = 255; }
  return { width, height, rgba };
}

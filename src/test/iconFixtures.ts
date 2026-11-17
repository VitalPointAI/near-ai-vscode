import { crc32, deflateSync } from 'node:zlib';

// Images for the team icon tests, built with Node's own zlib rather than the code under test.

/** A real PNG, built here with Node's own zlib (not the code under test): `width` x `height`, RGBA, with optional extra chunks before IDAT. */
export function png(width = 128, height = 128, options: { extra?: Array<[string, Buffer]>; noise?: boolean; seed?: number } = {}): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  const rows: Buffer[] = [];
  let state = options.seed ?? 7;
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      if (options.noise) { for (let c = 0; c < 4; c += 1) { state = (state * 1103515245 + 12345) & 0x7fffffff; row[1 + x * 4 + c] = state & 0xff; } }
      else { row[1 + x * 4] = (30 + (options.seed ?? 0) * 17) & 0xff; row[2 + x * 4] = 90 + (y % 8); row[3 + x * 4] = 160; row[4 + x * 4] = 255; }
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), ...(options.extra ?? []).map(([type, data]) => chunk(type, data)), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
export const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([30, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(18)]);
export const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');

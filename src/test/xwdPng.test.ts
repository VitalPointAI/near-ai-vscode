// The framebuffer to PNG converter (Phase 62 plan 16): Xvfb writes its screen as an XWD file with -fbdir, and the e2e turns it into a PNG the owner can
// open. These tests build small XWD files by hand, read the PNG back chunk by chunk, and finally run a real Xvfb.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { captureScreen, cropImage, encodePng, readXwd, xwdToPng, type RgbImage } from './e2e/xwdPng';

type Rgb = [number, number, number];

// Six known colours for a 3 by 2 image, rows top to bottom.
const COLOURS: Rgb[] = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [18, 52, 86], [250, 128, 7], [1, 2, 3],
];

interface XwdOptions {
  width: number;
  height: number;
  pixels: Rgb[];
  bitsPerPixel?: 24 | 32 | 16;
  bytesPerLine?: number;
  pixelOrder?: 'lsb' | 'msb';
  headerOrder?: 'be' | 'le';
  ncolors?: number;
  name?: string;
  truncateBy?: number;
}

// A ZPixmap XWD with masks 0xff0000, 0xff00, 0xff, the window name after the 25 header fields, ncolors colormap entries of 12 bytes, then the pixels.
function buildXwd(options: XwdOptions): Buffer {
  const bpp = options.bitsPerPixel ?? 32;
  const bytesPerPixel = bpp / 8;
  const bytesPerLine = options.bytesPerLine ?? options.width * bytesPerPixel;
  const name = Buffer.from(`${options.name ?? 'Xvfb main window'}\0`, 'latin1');
  const headerSize = 100 + name.length;
  const ncolors = options.ncolors ?? 0;
  const fields = [
    headerSize, 7, 2, 24, options.width, options.height, 0,
    options.pixelOrder === 'msb' ? 1 : 0, 32, options.pixelOrder === 'msb' ? 1 : 0, 32, bpp, bytesPerLine,
    4, 0xff0000, 0xff00, 0xff, 8, 256, ncolors, options.width, options.height, 0, 0, 0,
  ];
  const header = Buffer.alloc(100);
  fields.forEach((value, index) => {
    if (options.headerOrder === 'le') header.writeUInt32LE(value, index * 4);
    else header.writeUInt32BE(value, index * 4);
  });
  const colormap = Buffer.alloc(ncolors * 12, 0xab);
  const pixels = Buffer.alloc(bytesPerLine * options.height, 0xee);
  for (let y = 0; y < options.height; y += 1) {
    for (let x = 0; x < options.width; x += 1) {
      const [r, g, b] = options.pixels[y * options.width + x];
      const value = ((r << 16) | (g << 8) | b) >>> 0;
      const at = y * bytesPerLine + x * bytesPerPixel;
      for (let byte = 0; byte < bytesPerPixel; byte += 1) {
        const shift = options.pixelOrder === 'msb' ? (bytesPerPixel - 1 - byte) * 8 : byte * 8;
        pixels[at + byte] = (value >>> shift) & 0xff;
      }
    }
  }
  const file = Buffer.concat([header, name, colormap, pixels]);
  return options.truncateBy ? file.subarray(0, file.length - options.truncateBy) : file;
}

interface PngChunk { type: string; data: Buffer }

// Walks the PNG chunks, checking the signature and every chunk's CRC-32 over its type and data.
function readPng(png: Buffer): { width: number; height: number; chunks: PngChunk[]; rows: Buffer[] } {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  const chunks: PngChunk[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    const data = png.subarray(at + 8, at + 8 + length);
    const crc = png.readUInt32BE(at + 8 + length);
    assert.equal(crc, crc32(png.subarray(at + 4, at + 8 + length)), `${type} chunk CRC`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.equal(at, png.length, 'no bytes after the last chunk');
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], 'bit depth 8, colour type 2, no interlace');
  const raw = inflateSync(chunks[1].data);
  assert.equal(raw.length, height * (1 + width * 3));
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = raw.subarray(y * (1 + width * 3), (y + 1) * (1 + width * 3));
    assert.equal(row[0], 0, `row ${y} uses filter 0`);
    rows.push(row.subarray(1));
  }
  return { width, height, chunks, rows };
}

const pixelsOf = (rows: Buffer[]): Rgb[] => rows.flatMap((row) => {
  const out: Rgb[] = [];
  for (let x = 0; x < row.length; x += 3) out.push([row[x], row[x + 1], row[x + 2]]);
  return out;
});

const base: XwdOptions = { width: 3, height: 2, pixels: COLOURS, bytesPerLine: 16, ncolors: 2 };

test('a 32 bit XWD with padded rows converts to a PNG with valid chunks and exactly the six colours', () => {
  const png = xwdToPng(buildXwd(base));
  const read = readPng(png);
  assert.equal(read.width, 3);
  assert.equal(read.height, 2);
  assert.deepEqual(pixelsOf(read.rows), COLOURS);
});

test('most significant byte first pixels, a little-endian header and a 24 bit image all give the same PNG', () => {
  const expected = xwdToPng(buildXwd(base));
  assert.deepEqual(xwdToPng(buildXwd({ ...base, pixelOrder: 'msb' })), expected);
  assert.deepEqual(xwdToPng(buildXwd({ ...base, headerOrder: 'le' })), expected);
  assert.deepEqual(xwdToPng(buildXwd({ ...base, bitsPerPixel: 24, bytesPerLine: 12 })), expected);
  assert.deepEqual(xwdToPng(buildXwd({ ...base, bitsPerPixel: 24, bytesPerLine: 9, ncolors: 0, pixelOrder: 'msb' })), expected);
});

test('a 16 bit image is refused naming bits_per_pixel, and a short file is refused naming the file size', () => {
  assert.throws(() => readXwd(buildXwd({ ...base, bitsPerPixel: 16, bytesPerLine: 8 })), /bits_per_pixel/);
  assert.throws(() => readXwd(buildXwd({ ...base, truncateBy: 5 })), /file size/);
  assert.throws(() => readXwd(Buffer.alloc(40)), /file size/);
  const notXwd = Buffer.alloc(200, 0x41);
  assert.throws(() => readXwd(notXwd), /file_version/);
});

test('cropImage keeps the middle column, and a box outside the image is refused', () => {
  const image = readXwd(buildXwd(base));
  const middle = cropImage(image, { x: 1, y: 0, width: 1, height: 2 });
  assert.equal(middle.width, 1);
  assert.equal(middle.height, 2);
  assert.deepEqual([...middle.rgb], [...COLOURS[1], ...COLOURS[4]]);
  assert.throws(() => cropImage(image, { x: 2, y: 0, width: 2, height: 1 }), /outside/);
  assert.throws(() => cropImage(image, { x: -1, y: 0, width: 1, height: 1 }), /outside/);
  assert.throws(() => cropImage(image, { x: 0, y: 0, width: 0, height: 1 }), /outside/);
  const cropped = readPng(xwdToPng(buildXwd(base), { x: 1, y: 1, width: 2, height: 1 }));
  assert.deepEqual(pixelsOf(cropped.rows), [COLOURS[4], COLOURS[5]]);
});

test('encodePng refuses pixel data of the wrong length', () => {
  const image: RgbImage = { width: 2, height: 2, rgb: Buffer.alloc(11) };
  assert.throws(() => encodePng(image), /pixel data/);
});

const xvfb = spawnSync('sh', ['-c', 'command -v Xvfb'], { encoding: 'utf8' }).stdout.trim();

test('a real Xvfb screen is saved as a 64 by 48 PNG whose every pixel is white', { skip: xvfb ? false : 'Xvfb is not on PATH' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-xvfb-'));
  const fbdir = path.join(dir, 'fb');
  await mkdir(fbdir);
  const server = spawn(xvfb, ['-displayfd', '3', '-screen', '0', '64x48x24', '-fbdir', fbdir, '-wr', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  try {
    // -displayfd writes the display number once the server is ready to draw.
    const display = await new Promise<string>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('Xvfb did not report a display within 15 s')), 15_000);
      const fd3 = server.stdio[3] as NodeJS.ReadableStream;
      fd3.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (text.includes('\n')) { clearTimeout(timer); resolve(text.trim()); }
      });
      server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Xvfb exited early with code ${code}`)); });
    });
    assert.match(display, /^\d+$/);
    assert.ok(existsSync(path.join(fbdir, 'Xvfb_screen0')), 'Xvfb wrote its framebuffer file');
    const out = path.join(dir, 'shots', 'screen.png');
    const result = await captureScreen(fbdir, out);
    assert.equal(result.width, 64);
    assert.equal(result.height, 48);
    const png = readFileSync(out);
    assert.equal(result.bytes, png.length);
    const read = readPng(png);
    assert.equal(read.width, 64);
    assert.equal(read.height, 48);
    for (const row of read.rows) assert.ok(row.every((byte) => byte === 255), 'every pixel is white');
  } finally {
    server.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5_000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(dir, { recursive: true, force: true });
  }
});

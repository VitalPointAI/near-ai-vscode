// Test-only screenshot tool (Phase 62 plan 16): Xvfb started with -fbdir keeps its screen in <fbdir>/Xvfb_screen0 as an XWD file. This module reads that
// file and writes a PNG the owner can open, with Node built-ins only (no screenshot program is installed and no dependency is added).
//
// XWD layout: 25 unsigned 32-bit header fields, the window name up to header_size, ncolors colormap entries of 12 bytes, then the pixels in rows of
// bytes_per_line. Xvfb writes the header most significant byte first; the pixels follow byte_order (0 means least significant byte first).
// PNG layout: the 8-byte signature, IHDR, one IDAT holding zlib data of rows each led by filter byte 0, IEND; every chunk ends with the CRC-32 of its
// type and data.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

/** An image of 3 bytes per pixel (red, green, blue), rows top to bottom. */
export interface RgbImage { width: number; height: number; rgb: Buffer }

type Box = { x: number; y: number; width: number; height: number };

const FIELDS = [
  'header_size', 'file_version', 'pixmap_format', 'pixmap_depth', 'pixmap_width', 'pixmap_height', 'xoffset', 'byte_order', 'bitmap_unit',
  'bitmap_bit_order', 'bitmap_pad', 'bits_per_pixel', 'bytes_per_line', 'visual_class', 'red_mask', 'green_mask', 'blue_mask', 'bits_per_rgb',
  'colormap_entries', 'ncolors', 'window_width', 'window_height', 'window_x', 'window_y', 'window_bdrwidth',
] as const;
type Field = typeof FIELDS[number];

const HEADER_BYTES = FIELDS.length * 4;
const XWD_VERSION = 7;
const ZPIXMAP = 2;
// Far larger than any test screen, small enough that a corrupt header cannot ask for gigabytes (T-62-56).
const MAX_SIDE = 16_384;

function readHeader(file: Buffer): Record<Field, number> {
  if (file.length < HEADER_BYTES) throw new Error(`XWD file size ${file.length} bytes is shorter than the ${HEADER_BYTES} byte header`);
  let read = (at: number): number => file.readUInt32BE(at);
  if (read(4) !== XWD_VERSION) {
    read = (at: number): number => file.readUInt32LE(at);
    if (read(4) !== XWD_VERSION) throw new Error(`XWD file_version is not ${XWD_VERSION} in either byte order`);
  }
  const header = {} as Record<Field, number>;
  FIELDS.forEach((field, index) => { header[field] = read(index * 4); });
  return header;
}

// A channel mask's shift (its trailing zero count) and its width in bits.
function maskShape(mask: number, name: string): { shift: number; bits: number } {
  if (mask === 0) throw new Error(`XWD ${name} is 0`);
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  let bits = 0;
  while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1) === 1) bits += 1;
  if (bits > 16) throw new Error(`XWD ${name} is wider than 16 bits`);
  return { shift, bits };
}

/** Reads a ZPixmap XWD of 24 or 32 bits per pixel into an RGB image. Throws a plain Error naming the field or size it cannot accept. */
export function readXwd(file: Buffer): RgbImage {
  const header = readHeader(file);
  if (header.pixmap_format !== ZPIXMAP) throw new Error(`XWD pixmap_format ${header.pixmap_format} is not ZPixmap (${ZPIXMAP})`);
  const bpp = header.bits_per_pixel;
  if (bpp !== 24 && bpp !== 32) throw new Error(`XWD bits_per_pixel ${bpp} is not supported (24 or 32 only)`);
  if (header.byte_order !== 0 && header.byte_order !== 1) throw new Error(`XWD byte_order ${header.byte_order} is not 0 or 1`);
  const width = header.pixmap_width;
  const height = header.pixmap_height;
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`XWD pixmap_width ${width} or pixmap_height ${height} is out of range`);
  const bytesPerPixel = bpp / 8;
  const bytesPerLine = header.bytes_per_line;
  if (bytesPerLine < width * bytesPerPixel || bytesPerLine > width * bytesPerPixel + 64) throw new Error(`XWD bytes_per_line ${bytesPerLine} does not fit pixmap_width ${width}`);
  if (header.header_size < HEADER_BYTES || header.header_size > file.length) throw new Error(`XWD header_size ${header.header_size} does not fit the file size ${file.length} bytes`);
  if (header.ncolors > 65_536) throw new Error(`XWD ncolors ${header.ncolors} is out of range`);
  const pixelStart = header.header_size + header.ncolors * 12;
  const needed = pixelStart + bytesPerLine * height;
  if (file.length < needed) throw new Error(`XWD file size ${file.length} bytes is shorter than the ${needed} bytes its header describes`);

  const red = maskShape(header.red_mask, 'red_mask');
  const green = maskShape(header.green_mask, 'green_mask');
  const blue = maskShape(header.blue_mask, 'blue_mask');
  const scale = (value: number, bits: number): number => (bits === 8 ? value : Math.round((value * 255) / ((2 ** bits) - 1)));
  const lsbFirst = header.byte_order === 0;

  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const row = pixelStart + y * bytesPerLine;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * bytesPerPixel;
      let pixel = 0;
      for (let byte = 0; byte < bytesPerPixel; byte += 1) {
        const value = file[at + byte];
        const shift = lsbFirst ? byte * 8 : (bytesPerPixel - 1 - byte) * 8;
        pixel = (pixel | (value << shift)) >>> 0;
      }
      const out = (y * width + x) * 3;
      rgb[out] = scale((pixel & header.red_mask) >>> red.shift, red.bits);
      rgb[out + 1] = scale((pixel & header.green_mask) >>> green.shift, green.bits);
      rgb[out + 2] = scale((pixel & header.blue_mask) >>> blue.shift, blue.bits);
    }
  }
  return { width, height, rgb };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes an RGB image as a PNG: colour type 2, bit depth 8, filter 0 on every row, one zlib IDAT. */
export function encodePng(image: RgbImage): Buffer {
  const { width, height, rgb } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`image size ${width} by ${height} is not a positive whole size`);
  if (rgb.length !== width * height * 3) throw new Error(`pixel data is ${rgb.length} bytes, expected ${width * height * 3} for ${width} by ${height}`);
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Copies a box out of an image. The box must lie inside the image and have a positive size. */
export function cropImage(image: RgbImage, box: Box): RgbImage {
  const { x, y, width, height } = box;
  const whole = [x, y, width, height].every(Number.isInteger);
  if (!whole || x < 0 || y < 0 || width < 1 || height < 1 || x + width > image.width || y + height > image.height) {
    throw new Error(`crop box ${x},${y} ${width} by ${height} is outside the ${image.width} by ${image.height} image`);
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * 3;
    image.rgb.copy(rgb, row * width * 3, from, from + width * 3);
  }
  return { width, height, rgb };
}

/** Converts an XWD file to PNG bytes, optionally cropped first. */
export function xwdToPng(file: Buffer, crop?: Box): Buffer {
  const image = readXwd(file);
  return encodePng(crop ? cropImage(image, crop) : image);
}

/** Saves the current Xvfb screen (<fbdir>/Xvfb_screen0) as a PNG at outFile, creating its folder. The file is read once, since Xvfb rewrites it in place. */
export async function captureScreen(fbdir: string, outFile: string, crop?: Box): Promise<{ width: number; height: number; bytes: number }> {
  const file = await readFile(path.join(fbdir, 'Xvfb_screen0'));
  const image = readXwd(file);
  const shot = crop ? cropImage(image, crop) : image;
  const png = encodePng(shot);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, png);
  return { width: shot.width, height: shot.height, bytes: png.length };
}

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const size = 512;
const pixels = Buffer.alloc(size * size * 4);

function clamp(value) { return Math.max(0, Math.min(255, value)); }
function blend(x, y, r, g, b, alpha) {
  if (x < 0 || y < 0 || x >= size || y >= size || alpha <= 0) return;
  const offset = (y * size + x) * 4;
  const sourceAlpha = Math.min(1, alpha);
  const destinationAlpha = pixels[offset + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha === 0) return;
  pixels[offset] = clamp((r * sourceAlpha + pixels[offset] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[offset + 1] = clamp((g * sourceAlpha + pixels[offset + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[offset + 2] = clamp((b * sourceAlpha + pixels[offset + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[offset + 3] = Math.round(outputAlpha * 255);
}
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}
function strokeSegment(ax, ay, bx, by, width, color, glow = 0) {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - width - glow));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + width + glow));
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - width - glow));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by) + width + glow));
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    const distance = distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
    if (glow > 0 && distance < width + glow) blend(x, y, color[0], color[1], color[2], (1 - distance / (width + glow)) * 0.22);
    if (distance < width) blend(x, y, color[0], color[1], color[2], 1);
  }
}
function circle(cx, cy, radius, color, alpha = 1) {
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(size - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(size - 1, Math.ceil(cy + radius));
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
    const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (distance <= radius) blend(x, y, color[0], color[1], color[2], alpha * Math.min(1, (radius - distance) / 2 + 1));
  }
}
function ellipse(cx, cy, rx, ry, rotation, width, color) {
  const sin = Math.sin(rotation); const cos = Math.cos(rotation);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const dx = x + 0.5 - cx; const dy = y + 0.5 - cy;
    const localX = dx * cos + dy * sin; const localY = -dx * sin + dy * cos;
    const normalized = Math.hypot(localX / rx, localY / ry);
    const distance = Math.abs(normalized - 1) * Math.min(rx, ry);
    if (distance < width + 7) {
      const alpha = distance < width ? 0.9 : (1 - (distance - width) / 7) * 0.28;
      blend(x, y, color[0], color[1], color[2], alpha);
    }
  }
}

for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
  const distance = Math.hypot(x - size / 2, y - size / 2) / (size * 0.72);
  const glow = Math.max(0, 1 - distance);
  blend(x, y, 2 + glow * 4, 13 + glow * 12, 28 + glow * 26, 1);
}

ellipse(256, 256, 190, 116, -0.48, 3, [8, 196, 244]);
ellipse(256, 256, 190, 116, 0.48, 3, [255, 190, 38]);

const gold = [255, 188, 34];
const goldLight = [255, 222, 76];
// Angular NEAR-inspired N: two strong uprights joined by one rising diagonal.
strokeSegment(145, 375, 145, 137, 31, gold, 18);
strokeSegment(145, 137, 367, 375, 31, goldLight, 18);
strokeSegment(367, 375, 367, 137, 31, gold, 18);

for (const [x, y, color] of [[118, 118, goldLight], [394, 118, [45, 218, 255]], [418, 256, gold], [394, 394, [45, 218, 255]], [118, 394, gold], [94, 256, [45, 218, 255]]]) {
  circle(x, y, 19, color, 0.18);
  circle(x, y, 12, color, 1);
  circle(x - 3, y - 4, 4, [255, 255, 255], 0.55);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const payload = Buffer.concat([typeBuffer, data]);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBuffer.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(payload), 8 + data.length);
  return result;
}
const scanlines = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y += 1) {
  scanlines[y * (size * 4 + 1)] = 0;
  pixels.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', (() => { const data = Buffer.alloc(13); data.writeUInt32BE(size, 0); data.writeUInt32BE(size, 4); data[8] = 8; data[9] = 6; return data; })()),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
const output = resolve(root, 'media/near-ai-icon.png');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, png);
console.log(`Wrote ${output} (${png.length} bytes)`);

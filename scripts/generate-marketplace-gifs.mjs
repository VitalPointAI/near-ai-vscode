import { mkdirSync, writeFileSync } from 'node:fs';

const WIDTH = 480;
const HEIGHT = 300;
const PALETTE = [
  [15, 23, 42], [30, 41, 59], [51, 65, 85], [100, 116, 139],
  [226, 232, 240], [248, 250, 252], [255, 184, 28], [245, 158, 11],
  [139, 92, 246], [124, 58, 237], [34, 197, 94], [16, 185, 129],
  [56, 189, 248], [14, 165, 233], [248, 113, 113], [239, 68, 68]
];

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'], D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'], H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'], J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'], L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'], N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'], V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'], X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'], Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], 3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'], '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'], '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'], '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};

function canvas() { return new Uint8Array(WIDTH * HEIGHT).fill(0); }
function pixel(data, x, y, color) { if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) data[y * WIDTH + x] = color; }
function rect(data, x, y, width, height, color) {
  for (let row = y; row < y + height; row += 1) for (let col = x; col < x + width; col += 1) pixel(data, col, row, color);
}
function outline(data, x, y, width, height, color) {
  rect(data, x, y, width, 1, color); rect(data, x, y + height - 1, width, 1, color);
  rect(data, x, y, 1, height, color); rect(data, x + width - 1, y, 1, height, color);
}
function text(data, value, x, y, color = 5, scale = 2) {
  let cursor = x;
  for (const character of value.toUpperCase()) {
    const glyph = FONT[character] ?? FONT['?'];
    for (let row = 0; row < glyph.length; row += 1) for (let col = 0; col < glyph[row].length; col += 1) if (glyph[row][col] === '1') rect(data, cursor + col * scale, y + row * scale, scale, scale, color);
    cursor += 6 * scale;
  }
}
function header(data, title, subtitle) {
  rect(data, 0, 0, WIDTH, HEIGHT, 0); rect(data, 0, 0, WIDTH, 38, 1); rect(data, 0, 0, 8, HEIGHT, 6);
  text(data, 'NEAR AI', 24, 11, 6, 2); text(data, title, 180, 11, 5, 2); text(data, subtitle, 420, 13, 3, 1);
}
function panel(data, x, y, width, height, color = 1) { rect(data, x, y, width, height, color); outline(data, x, y, width, height, 2); }
function dot(data, x, y, color) { rect(data, x, y, 8, 8, color); }
function overviewFrame(step) {
  const data = canvas(); header(data, 'CHAT + ACTIVITY', 'DEMO');
  panel(data, 24, 58, 104, 216); text(data, 'WORKSPACE', 38, 74, 3, 1); text(data, 'CHAT', 48, 108, step === 0 ? 6 : 5, 2); text(data, 'ACTIVITY', 40, 140, step === 1 ? 6 : 5, 2); text(data, 'COST', 48, 172, step === 2 ? 6 : 5, 2); text(data, 'GSD', 54, 230, 3, 2);
  panel(data, 146, 58, 310, 216); text(data, 'OPEN-GSD PROJECT', 164, 74, 5, 2); text(data, 'PRIVATE WORKFLOW', 164, 96, 6, 1);
  panel(data, 164, 116, 214, 36, 2); text(data, 'PLAN THE NEXT STEP', 178, 130, 5, 1);
  panel(data, 250, 166, 188, 38, 8); text(data, step === 0 ? 'MODEL READY' : step === 1 ? 'REQUEST COMPLETE' : 'COST TRACKED', 264, 180, 5, 1);
  dot(data, 174, 222, 10); text(data, step === 2 ? 'TOKENS + COST VISIBLE' : 'PROVIDER VALIDATED', 190, 222, 5, 1); dot(data, 174, 244, step === 1 ? 6 : 10); text(data, 'APPROVALS STAY EXPLICIT', 190, 244, 5, 1);
  return data;
}
function setupFrame(step) {
  const data = canvas(); header(data, 'FIRST PROJECT SETUP', 'DEMO');
  text(data, 'CONNECT + SET GUARDRAILS', 28, 58, 5, 2); text(data, 'HOST CONTROLLED', 28, 78, 3, 1);
  const cards = [['SECRETSTORAGE', 'API KEY STAYS HOST SIDE', 6], ['LOCAL-ONLY MODE', 'BLOCK CLOUD DISPATCH', 8], ['RISKY ACTIONS', 'ASK BEFORE WRITE', 10], ['WALLET STATUS', 'WRITES DISABLED', 3]];
  cards.forEach(([title, detail, color], index) => { const x = 28 + (index % 2) * 222; const y = 108 + Math.floor(index / 2) * 74; panel(data, x, y, 202, 56); dot(data, x + 14, y + 16, step === index ? 6 : color); text(data, title, x + 30, y + 12, 5, 1); text(data, detail, x + 30, y + 30, 3, 1); });
  text(data, step % 2 === 0 ? 'REVIEW THE PREVIEW' : 'READY FOR A GUARDED RUN', 28, 270, 6, 1);
  return data;
}

function le16(value) { return [value & 255, (value >> 8) & 255]; }
function lzwEncode(pixels) {
  const minimum = 4; const clear = 1 << minimum; const end = clear + 1; const codes = [];
  // Reset before every pixel. This is intentionally simple and keeps the
  // generated demo deterministic without introducing a GIF encoder package.
  for (const value of pixels) { codes.push(clear, value); }
  codes.push(end);
  const bytes = []; let bitBuffer = 0; let bitCount = 0;
  for (const value of codes) { bitBuffer |= value << bitCount; bitCount += minimum + 1; while (bitCount >= 8) { bytes.push(bitBuffer & 255); bitBuffer >>>= 8; bitCount -= 8; } }
  if (bitCount > 0) bytes.push(bitBuffer & 255);
  return bytes;
}
function gif(frames) {
  const bytes = [...Buffer.from('GIF89a')]; bytes.push(...le16(WIDTH), ...le16(HEIGHT), 0xf3, 0, 0);
  for (const color of PALETTE) bytes.push(...color);
  bytes.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00);
  frames.forEach((frame, index) => {
    bytes.push(0x21, 0xf9, 0x04, 0x00, 0x32, 0x00, 0x00, 0x00);
    bytes.push(0x2c, 0x00, 0x00, 0x00, 0x00, ...le16(WIDTH), ...le16(HEIGHT), 0x00, 0x04);
    const compressed = lzwEncode(frame); for (let offset = 0; offset < compressed.length; offset += 255) { const chunk = compressed.slice(offset, offset + 255); bytes.push(chunk.length, ...chunk); } bytes.push(0x00);
    if (index === frames.length - 1) bytes.push(0x3b);
  });
  return Buffer.from(bytes);
}

mkdirSync('docs/marketplace', { recursive: true });
writeFileSync('docs/marketplace/near-ai-overview.gif', gif([overviewFrame(0), overviewFrame(1), overviewFrame(2)]));
writeFileSync('docs/marketplace/near-ai-setup.gif', gif([setupFrame(0), setupFrame(1), setupFrame(2), setupFrame(3)]));

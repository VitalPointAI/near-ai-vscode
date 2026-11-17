import { parseFrontmatter } from '../gsd/library';

// Team icons (0.4.30, owner 2026-11-17: "give user ability to upload or AI generate an icon for the team. Ensure there's a default icon available if none
// are selected/generated"). No VS Code imports, so the tests run it directly, and nothing here reads or writes a file.
//
// An icon is a 128 x 128 PNG of at most 64 KB, kept beside the team's Markdown as `<team file name>.icon.png` and named in the team file's front matter
// (`icon: web-team.icon.png`). A build from before icons ignores the line, and the studio's save keeps it like any key it does not show. The page turns
// any picture into such a PNG in a canvas (it decodes PNG, JPEG and WebP; SVG is never accepted, because it can carry script), and the host checks every
// icon here again before it writes it, shows it, or imports it: an icon is not a secret, but one from a shared file, a hand-edited folder or the page is
// untrusted input.

/** The one size an icon is stored at. */
export const TEAM_ICON_SIZE = 128;
/** The most an icon file may be: a 128 x 128 picture compresses to far less, and the page simplifies the colours of one that does not. */
export const MAX_TEAM_ICON_BYTES = 64 * 1024;
/** The most a picture chosen with Upload may be, before the page reduces it to an icon. */
export const MAX_ICON_SOURCE_BYTES = 2 * 1024 * 1024;
/** The most a generated picture may be before the page reduces it (image models return about 1024 x 1024). */
export const MAX_GENERATED_IMAGE_BYTES = 8 * 1024 * 1024;
/** The icon file's name ends with this, after the team file's own name without `.md`. */
export const TEAM_ICON_SUFFIX = '.icon.png';

export type IconSourceType = 'image/png' | 'image/jpeg' | 'image/webp';

export class TeamIconError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TeamIconError';
  }
}

/** A change that failed half way and could not be undone: its message says exactly what is on disk now (PR #82 review). */
export class TeamIconPartialError extends TeamIconError {
  public constructor(message: string) {
    super(message);
    this.name = 'TeamIconPartialError';
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What a picture is, from its first bytes (never its name or a type the page claims): PNG, JPEG or WebP, or undefined for anything else, SVG included. */
export function iconSourceType(bytes: Uint8Array): IconSourceType | undefined {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/** Whether the bytes look like SVG or other XML, so the refusal can say why SVG is not accepted. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg') || /<svg[\s>]/.test(head);
}

/** Why a picture chosen with Upload is refused, in plain words, or undefined when the page may turn it into an icon. */
export function iconSourceProblem(bytes: Uint8Array): string | undefined {
  if (bytes.length > MAX_ICON_SOURCE_BYTES) return 'The image is larger than 2 MB. Choose a smaller one.';
  if (iconSourceType(bytes)) return undefined;
  if (looksLikeSvg(bytes)) return 'SVG images can carry scripts, so they are not accepted. Use a PNG, JPEG or WebP image.';
  return 'That file is not an image the studio can use. Use a PNG, JPEG or WebP image.';
}

// The chunks an icon may hold: the picture itself and notes on how to show its colours. Text, Exif and anything else could carry data the person did
// not mean to share, so an icon holding one is refused (the page's canvas never writes one).
const ALLOWED_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'iCCP', 'pHYs', 'sBIT', 'bKGD']);
const COLOUR_TYPES = new Map<number, number[]>([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
const DAMAGED = 'The image is damaged.';

/**
 * Why these bytes are not a team icon, in plain words, or undefined when they are one: a PNG (by its signature), exactly 128 x 128, at most 64 KB, every
 * chunk whole with a correct checksum, the picture's own chunks only, and nothing after its end.
 */
export function checkTeamIcon(bytes: Uint8Array): string | undefined {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return 'It is not a PNG image.';
  if (bytes.length > MAX_TEAM_ICON_BYTES) return 'It is larger than 64 KB.';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let first = true;
  let pictures = 0;
  let ended = false;
  while (offset < bytes.length) {
    if (ended) return DAMAGED;
    if (offset + 12 > bytes.length) return DAMAGED;
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || length > bytes.length - offset - 12) return DAMAGED;
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if ((crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0) !== view.getUint32(offset + 8 + length)) return DAMAGED;
    if (first) {
      if (type !== 'IHDR' || length !== 13) return DAMAGED;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (width !== TEAM_ICON_SIZE || height !== TEAM_ICON_SIZE) return `It is ${width} x ${height} pixels; a team icon is ${TEAM_ICON_SIZE} x ${TEAM_ICON_SIZE}.`;
      const [depth, colour, compression, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (!COLOUR_TYPES.get(colour!)?.includes(depth!) || compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) return DAMAGED;
      first = false;
    } else if (type === 'IHDR') return DAMAGED;
    if (!ALLOWED_CHUNKS.has(type)) return 'It carries data other than the picture.';
    if (type === 'IDAT') pictures += 1;
    if (type === 'IEND') { if (length !== 0) return DAMAGED; ended = true; }
    offset += 12 + length;
  }
  return ended && pictures > 0 ? undefined : DAMAGED;
}

// The base64 of the largest icon, with room for padding: anything longer is refused before it is decoded.
const MAX_ICON_BASE64 = Math.ceil(MAX_TEAM_ICON_BYTES / 3) * 4;

/** An icon the page sends, as bytes: strict base64 (no spaces or line breaks), no longer than the largest icon. Undefined for anything else. */
export function decodeIconBase64(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_ICON_BASE64 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : undefined;
}

/** How the page is sent an icon: a data URI it can show under its policy (img-src data:), never a path. */
export function iconDataUri(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Team text made plain for the prompt: one line, no angle brackets, capped. */
function plain(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/</g, '‹').replace(/>/g, '›').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * What an image model is asked for an icon: the team's name and what it is for, nothing else from the team (not its members, instructions or models).
 * SECURITY.md says this is what leaves the computer when the image model is not a private one.
 */
export function teamIconPrompt(team: { name: string; description: string }): string {
  const name = plain(team.name, 80) || 'team';
  const purpose = plain(team.description, 300);
  return `A simple, flat square app icon for a team called "${name}".${purpose ? ` What the team does: ${purpose}${/[.!?]$/.test(purpose) ? '' : '.'}` : ''} One bold symbol centred on a plain background, readable at small sizes. No text, letters or numbers.`;
}

// ---- the front matter's icon line ----

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const ICON_LINE = /^icon:/;

/**
 * The one reading of a team file's icon lines (PR #82 review: reading took the last `icon:` line and writing changed the first, so a hand edit with two
 * lines kept a stale one). The first `icon:` line in the front matter is the reference; any later one is a leftover that every write removes.
 */
function iconLines(text: string): { match: RegExpExecArray; lines: string[]; at: number[] } | undefined {
  const match = FRONTMATTER.exec(text);
  if (!match) return undefined;
  const lines = match[1]!.split(/\r?\n/);
  return { match, lines, at: lines.flatMap((line, index) => (ICON_LINE.test(line) ? [index] : [])) };
}

/** The `icon:` value in a team file's front matter (its first icon line), or undefined. */
export function iconReference(text: string): string | undefined {
  const found = iconLines(text);
  if (!found || !found.at.length) return undefined;
  const value = found.lines[found.at[0]!]!.replace(ICON_LINE, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  return value || undefined;
}

/**
 * The team file with exactly one icon line naming this icon (where the first one was, or after the description), or with none when `name` is
 * undefined. Every other byte is kept, line endings included; a file with no front matter (not a usable team) is returned as it is.
 */
export function withIconReference(text: string, name: string | undefined): string {
  const found = iconLines(text);
  if (!found) return text;
  const { match, lines, at } = found;
  const line = name === undefined ? undefined : `icon: ${name}`;
  if (line === undefined ? !at.length : at.length === 1 && lines[at[0]!] === line) return text;
  const inner = match[1]!;
  const open = /^---\r?\n/.exec(match[0])![0];
  const close = match[0].slice(open.length + inner.length);
  const eol = inner.includes('\r\n') || open.includes('\r\n') ? '\r\n' : '\n';
  const kept = lines.filter((_, index) => !at.includes(index));
  if (line !== undefined) {
    if (at.length) kept.splice(at[0]!, 0, line);
    else kept.splice(iconLinePlace(kept), 0, line);
  }
  return `${open}${kept.join(eol)}${close}${text.slice(match[0].length)}`;
}

/** A top-level key line as the team loader's front matter parser reads it (parseFrontmatter in gsd/library.ts): a key at the start of the line. */
const KEY_LINE = /^([A-Za-z0-9_-]+):\s*(.*)$/;

/**
 * Where a new icon line goes (PR #82 review, round 2: it went after any `description:` line, which put it inside a hand-written `description: |` block).
 * Right after the description only when its value is complete on that one line (not a block scalar, not a quote left open, not continued on an indented
 * line); otherwise at the end of the front matter, which ends any value above it. The place is then checked with the loader's own parser: every key must
 * read as it did, or the line goes at the end.
 */
function iconLinePlace(lines: string[]): number {
  const description = lines.findIndex((entry) => /^description:/.test(entry));
  if (description < 0) return lines.length;
  const value = (KEY_LINE.exec(lines[description]!)?.[2] ?? '').trim();
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : undefined;
  const oneLine = value !== '' && !/^[|>]/.test(value) && (!quote || (value.length > 1 && value.endsWith(quote)))
    && !/^\s/.test(lines[description + 1] ?? '');
  if (!oneLine) return lines.length;
  const read = (entries: string[]) => JSON.stringify(parseFrontmatter(`---\n${entries.join('\n')}\n---\n`).data);
  const placed = [...lines.slice(0, description + 1), 'icon: x', ...lines.slice(description + 1)];
  const { icon: _icon, ...rest } = parseFrontmatter(`---\n${placed.join('\n')}\n---\n`).data;
  return JSON.stringify(rest) === read(lines) ? description + 1 : lines.length;
}

// ---- small helpers ----

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

let table: Uint32Array | undefined;
/** CRC-32 as PNG uses it (ISO 3309), so a damaged chunk is caught; written out because older VS Code runtimes may lack zlib.crc32. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

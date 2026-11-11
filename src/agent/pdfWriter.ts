import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { DocImage, pdfImage } from './docImages';
import { Block, Inline, Note, plainText } from './docMarkdown';
import { ToolError } from './workspace';

// A PDF from the Markdown subset, written here with no library: the 14 standard fonts (Helvetica
// and Courier, WinAnsi encoding), so nothing is embedded and nothing is downloaded. Headings
// become bookmarks, every page is numbered, footnotes go to the foot of the page or to a Notes
// section at the end, and the same input always gives the same bytes: no
// clock is read, and the creation date is written only when the caller passes one.

export type PageSize = 'A4' | 'Letter';
export type NoteStyle = 'footnotes' | 'endnotes';
export interface DocumentSpec { title: string; author?: string; date?: string; pageSize?: PageSize; blocks: Block[]; images: Map<string, DocImage>; notes?: Note[]; noteStyle?: NoteStyle }
export interface PdfResult { bytes: Buffer; pages: number; headings: number; images: number; notes: number; substituted: string[] }

const PAGE: Record<PageSize, [number, number]> = { A4: [595.28, 841.89], Letter: [612, 792] };
const MARGIN = 56;
const FOOTER = 30;

// ---- WinAnsi encoding -------------------------------------------------------------------------

/** WinAnsiEncoding's 0x80-0x9F block, by Unicode code point. */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
};
/** Characters the standard fonts lack, written with ones they have. Anything else becomes "?" and is reported. */
const STAND_INS: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇐': '<=', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '−': '-', '‐': '-', '‑': '-', '‒': '-', '―': '—',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '‌': '', '‍': '', '⁠': '', '﻿': '', '­': '',
  '′': "'", '″': '"', '∙': '•', '●': '•', '▪': '•', '◦': '•', '‣': '•', '⁃': '-',
  '☐': '[ ]', '☑': '[x]', '☒': '[x]', '✓': '[x]', '✔': '[x]', '✗': 'x', '✘': 'x', '✕': 'x', '✖': 'x'
};

class Encoder {
  public readonly missing = new Set<string>();
  /** The text as a WinAnsi byte string (one char per byte). */
  public encode(text: string): string {
    let out = '';
    for (const char of text.normalize('NFC')) {
      const stand = STAND_INS[char];
      if (stand !== undefined) { out += stand ? this.encode(stand) : ''; continue; }
      const code = char.codePointAt(0)!;
      if (code === 10) out += '\n';
      else if (code < 32 || code === 127) continue;
      else if (code < 128 || (code >= 0xa0 && code <= 0xff)) out += char;
      else if (WIN_ANSI_HIGH[code] !== undefined) out += String.fromCharCode(WIN_ANSI_HIGH[code]);
      else { this.missing.add(char); out += '?'; }
    }
    return out;
  }
}

// ---- Font metrics (Adobe AFM advance widths, 1/1000 em, WinAnsi codes 32-255) ----------------

const widths = (spec: string) => spec.split(' ').map(Number);
const HELVETICA = widths('278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584 350 556 350 222 556 333 1000 556 556 333 1000 667 333 1000 350 611 350 350 222 222 333 333 350 556 1000 333 1000 500 333 944 350 500 667 278 333 556 556 556 556 260 556 333 737 370 556 584 333 737 333 400 584 333 333 333 556 537 278 333 333 365 556 834 834 834 611 667 667 667 667 667 667 1000 722 667 667 667 667 278 278 278 278 722 722 778 778 778 778 778 584 778 722 722 722 722 667 667 611 556 556 556 556 556 556 889 500 556 556 556 556 278 278 278 278 556 556 556 556 556 556 556 584 611 556 556 556 556 500 556 500');
const HELVETICA_BOLD = widths('278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584 350 556 350 278 556 500 1000 556 556 333 1000 667 333 1000 350 611 350 350 278 278 500 500 350 556 1000 333 1000 556 333 944 350 500 667 278 333 556 556 556 556 280 556 333 737 370 556 584 333 737 333 400 584 333 333 333 611 556 278 333 333 365 556 834 834 834 611 722 722 722 722 722 722 1000 722 667 667 667 667 278 278 278 278 722 722 778 778 778 778 778 584 778 722 722 722 722 667 667 611 556 556 556 556 556 556 889 556 556 556 556 556 278 278 278 278 611 611 611 611 611 611 611 584 611 611 611 611 611 556 611 556');

type FontKey = 'F1' | 'F2' | 'F3' | 'F4' | 'F5';
const FONTS: Array<[FontKey, string]> = [['F1', 'Helvetica'], ['F2', 'Helvetica-Bold'], ['F3', 'Helvetica-Oblique'], ['F4', 'Helvetica-BoldOblique'], ['F5', 'Courier']];

function advance(code: number, font: FontKey): number {
  if (font === 'F5') return 600;
  const table = font === 'F2' || font === 'F4' ? HELVETICA_BOLD : HELVETICA;
  return table[code - 32] ?? 556;
}
const measure = (bytes: string, font: FontKey, size: number) => { let total = 0; for (let index = 0; index < bytes.length; index += 1) total += advance(bytes.charCodeAt(index), font); return total * size / 1000; };

// ---- Layout -------------------------------------------------------------------------------------

type Color = [number, number, number];
const TEXT: Color = [0.12, 0.16, 0.22];
const MUTED: Color = [0.42, 0.45, 0.5];
const LINK: Color = [0.1, 0.33, 0.75];
const RULE: Color = [0.8, 0.82, 0.85];

interface Style { font: FontKey; size: number; color: Color; link?: string; rise?: number }
interface Atom { text: string; style: Style; space: boolean; width: number; br?: boolean; note?: number }
interface Fragment { text: string; style: Style; x: number; width: number }
interface Line { fragments: Fragment[]; width: number; notes: number[] }
interface Page { ops: string[]; links: Array<{ rect: number[]; uri: string }>; notes: number[]; reserved: number }
interface OutlineEntry { level: number; title: string; page: number; y: number }

const num = (value: number) => { const rounded = Math.round(value * 100) / 100; return Object.is(rounded, -0) ? '0' : String(rounded); };
const rgb = (color: Color, stroke = false) => `${color.map(num).join(' ')} ${stroke ? 'RG' : 'rg'}`;
const escapeString = (bytes: string) => bytes.replace(/[\\()]/g, (char) => `\\${char}`).replace(/[\r\n]/g, ' ');
const fontFor = (bold?: boolean, italic?: boolean): FontKey => (bold && italic ? 'F4' : bold ? 'F2' : italic ? 'F3' : 'F1');
/** A web or mail link for an annotation, re-encoded consistently; a target that is not valid percent-encoding (a stray %) is used as written. */
export const linkable = (target: string | undefined) => {
  if (!target || !/^(https?:|mailto:)/i.test(target)) return undefined;
  try { return encodeURI(decodeURI(target)); } catch { return target; }
};

class Layout {
  public readonly pages: Page[] = [];
  public readonly outline: OutlineEntry[] = [];
  public readonly usedImages: string[] = [];
  /** Where each note is printed, for the links from its references. */
  public readonly noteTargets = new Map<number, { page: number; y: number }>();
  private readonly placed = new Set<number>();
  private readonly noteLineCache = new Map<number, Line[]>();
  private readonly noteNumbers: Map<string, number>;
  private y = 0;
  private readonly left = MARGIN;
  private readonly width: number;
  private readonly top: number;
  private readonly bottom = MARGIN + FOOTER;

  public constructor(private readonly size: [number, number], private readonly encoder: Encoder, private readonly images: Map<string, DocImage>, private readonly notes: Note[] = [], private readonly noteStyle: NoteStyle = 'endnotes') {
    this.noteNumbers = new Map(notes.map((note) => [note.id, note.number]));
    this.width = size[0] - 2 * MARGIN;
    this.top = size[1] - MARGIN;
    this.newPage();
  }

  private get page(): Page { return this.pages[this.pages.length - 1]; }
  private newPage() { this.pages.push({ ops: [], links: [], notes: [], reserved: 0 }); this.y = this.top; }
  private atTop() { return this.y >= this.top - 0.01; }
  /** The lowest point text may reach on this page, above any footnotes it carries. */
  private floor() { return this.bottom + this.page.reserved; }
  private ensure(height: number) { if (this.y - height < this.floor() && !this.atTop()) this.newPage(); }

  // ---- Notes ----

  private noteLines(number: number): Line[] {
    let lines = this.noteLineCache.get(number);
    if (!lines) {
      const note = this.notes.find((item) => item.number === number)!;
      lines = this.wrap(this.atoms(note.inlines, { size: this.noteStyle === 'footnotes' ? 8 : 9 }), this.width - 18);
      this.noteLineCache.set(number, lines);
    }
    return lines;
  }
  /** Footnotes a line or row brings to this page that are not placed yet. */
  private pending(numbers: number[]): number[] {
    return this.noteStyle === 'footnotes' ? [...new Set(numbers)].filter((number) => !this.placed.has(number)) : [];
  }
  /** The room those footnotes need at the foot of the current page, with the separator if they are its first. */
  private footHeight(numbers: number[]): number {
    if (!numbers.length) return 0;
    return (this.page.notes.length ? 0 : 10) + numbers.reduce((sum, number) => sum + this.noteLines(number).length * 10 + 2, 0);
  }
  private reserve(numbers: number[]) {
    const height = this.footHeight(numbers);
    for (const number of numbers) { this.placed.add(number); this.page.notes.push(number); }
    this.page.reserved += height;
  }

  /** The error for footnotes that cannot fit on one page with the line that cites them. */
  private noteTooLong(numbers: number[]): ToolError {
    // Name the notes that are too long on their own; if none is, it is the notes of this one line together.
    const room = this.top - this.bottom - 30;
    const alone = numbers.filter((number) => this.noteLines(number).length * 10 + 12 > room);
    const named = (alone.length ? alone : numbers).map((number) => `[^${this.notes.find((note) => note.number === number)?.id ?? number}]`);
    const subject = named.length === 1 ? `Footnote ${named[0]} is` : `Footnotes ${named.join(', ')} are${alone.length ? '' : ' together'}`;
    return new ToolError(`${subject} too long to fit at the foot of a page with the line that cites ${named.length === 1 ? 'it' : 'them'}. Shorten or split ${named.length === 1 ? 'it' : 'them'}, or use notes: endnotes, which have no such limit.`);
  }

  /** Prints each page's footnotes in the room reserved for them. */
  public footnotes() {
    this.pages.forEach((page, index) => {
      if (!page.notes.length) return;
      let y = this.bottom + page.reserved;
      page.ops.push(`${rgb(RULE, true)} 0.5 w ${num(this.left)} ${num(y - 4)} m ${num(this.left + this.width / 3)} ${num(y - 4)} l S`);
      y -= 10;
      for (const number of page.notes) {
        this.noteTargets.set(number, { page: index, y: y + 2 });
        const marker = this.encoder.encode(`${number}.`);
        page.ops.push(`${rgb(TEXT)} BT /F1 8 Tf ${num(this.left + 14 - measure(marker, 'F1', 8))} ${num(y - 8)} Td (${escapeString(marker)}) Tj ET`);
        for (const line of this.noteLines(number)) { this.drawLineOn(page, line, this.left + 18, y - 8); y -= 10; }
        y -= 2;
      }
    });
  }

  /** The Notes section at the end of the document. */
  public endnotes() {
    if (this.noteStyle !== 'endnotes' || !this.notes.length) return;
    this.heading(1, [{ text: 'Notes' }]);
    for (const note of this.notes) {
      const lines = this.noteLines(note.number);
      this.ensure(Math.min(lines.length, 2) * 12.5);
      this.noteTargets.set(note.number, { page: this.pages.length - 1, y: this.y });
      const marker = this.encoder.encode(`${note.number}.`);
      this.page.ops.push(`${rgb(TEXT)} BT /F1 9 Tf ${num(this.left + 14 - measure(marker, 'F1', 9))} ${num(this.y - 9)} Td (${escapeString(marker)}) Tj ET`);
      this.flow(lines, this.left + 18, 12.5, 9);
      this.y -= 3;
    }
  }
  private gap(points: number) { if (!this.atTop()) this.y -= points; }

  /** Inline runs as atoms (words and spaces), each with its style and width. */
  private atoms(inlines: Inline[], base: { size: number; bold?: boolean; italic?: boolean; color?: Color }): Atom[] {
    const atoms: Atom[] = [];
    for (const run of inlines) {
      if (run.note !== undefined) {
        const number = this.noteNumbers.get(run.note);
        if (number === undefined) throw new ToolError(`Footnote reference [^${run.note}] has no definition.`);
        const text = this.encoder.encode(String(number));
        const style: Style = { font: 'F1', size: base.size * 0.62, color: LINK, rise: base.size * 0.38, link: `#note-${number}` };
        atoms.push({ text, style, space: false, width: measure(text, 'F1', style.size), note: number });
        continue;
      }
      const link = linkable(run.link);
      const style: Style = run.code
        ? { font: 'F5', size: base.size * 0.92, color: base.color ?? TEXT, ...(link ? { link } : {}) }
        : { font: fontFor(base.bold || run.bold, base.italic || run.italic), size: base.size, color: link ? LINK : base.color ?? TEXT, ...(link ? { link } : {}) };
      for (const part of this.encoder.encode(run.text).split(/( +|\n)/)) {
        if (!part) continue;
        if (part === '\n') { atoms.push({ text: '', style, space: false, width: 0, br: true }); continue; }
        const space = part[0] === ' ';
        const text = space ? ' ' : part;
        atoms.push({ text, style, space, width: measure(text, style.font, style.size) });
      }
    }
    return atoms;
  }

  /** Greedy line breaking; a word wider than the line is broken between characters. */
  private wrap(atoms: Atom[], width: number): Line[] {
    const lines: Line[] = [];
    let current: Atom[] = [];
    let used = 0;
    const finish = () => {
      while (current.length && current[current.length - 1].space) { used -= current[current.length - 1].width; current.pop(); }
      const fragments: Fragment[] = [];
      let x = 0;
      for (const atom of current) {
        const last = fragments[fragments.length - 1];
        if (last && last.style === atom.style) { last.text += atom.text; last.width += atom.width; } else fragments.push({ text: atom.text, style: atom.style, x, width: atom.width });
        x += atom.width;
      }
      lines.push({ fragments, width: x, notes: current.filter((atom) => atom.note !== undefined).map((atom) => atom.note!) });
      current = []; used = 0;
    };
    for (const atom of atoms) {
      if (atom.br) { finish(); continue; }
      if (atom.space) { if (current.length) { current.push(atom); used += atom.width; } continue; }
      if (used + atom.width <= width + 0.01) { current.push(atom); used += atom.width; continue; }
      if (current.length) finish();
      if (atom.width <= width) { current.push(atom); used = atom.width; continue; }
      let piece = '';
      for (const char of atom.text) {
        const next = measure(piece + char, atom.style.font, atom.style.size);
        if (next > width && piece) { current.push({ ...atom, text: piece, width: measure(piece, atom.style.font, atom.style.size) }); finish(); piece = char; } else piece += char;
      }
      if (piece) { const w = measure(piece, atom.style.font, atom.style.size); current.push({ ...atom, text: piece, width: w }); used = w; }
    }
    if (current.length || !lines.length) finish();
    return lines;
  }

  private drawLine(line: Line, x: number, baseline: number) { this.drawLineOn(this.page, line, x, baseline); }

  private drawLineOn(page: Page, line: Line, x: number, baseline: number) {
    for (const fragment of line.fragments) {
      const style = fragment.style;
      // Text rise is part of the text state and outlives ET, so a superscript resets it.
      page.ops.push(`${rgb(style.color)} BT /${style.font} ${num(style.size)} Tf ${style.rise ? `${num(style.rise)} Ts ` : ''}${num(x + fragment.x)} ${num(baseline)} Td (${escapeString(fragment.text)}) Tj${style.rise ? ' 0 Ts' : ''} ET`);
      const lift = style.rise ?? 0;
      if (style.link) page.links.push({ rect: [x + fragment.x, baseline + lift - style.size * 0.25, x + fragment.x + fragment.width, baseline + lift + style.size * 0.85], uri: style.link });
    }
  }

  /** Flows lines down the page, starting a new page when one does not fit. */
  private flow(lines: Line[], x: number, leading: number, size: number, decorate?: (top: number, bottom: number) => void) {
    for (const line of lines) {
      const notes = this.pending(line.notes);
      // A line moves to the next page with its footnotes when both do not fit on this one; on a fresh page they must fit, or the note can
      // never be placed and reserving its room would push it off the page.
      if (this.y - leading - this.footHeight(notes) < this.floor() && !this.atTop()) this.newPage();
      if (this.y - leading - this.footHeight(this.pending(line.notes)) < this.floor()) throw this.noteTooLong(this.pending(line.notes));
      const top = this.y;
      this.drawLine(line, x, this.y - size);
      this.y -= leading;
      this.reserve(this.pending(line.notes));
      decorate?.(top, this.y);
    }
  }

  public block(block: Block) {
    switch (block.kind) {
      case 'heading': return this.heading(block.level, block.inlines);
      case 'paragraph': {
        this.flow(this.wrap(this.atoms(block.inlines, { size: 10.5 }), this.width), this.left, 14.5, 10.5);
        this.y -= 7;
        return;
      }
      case 'list': {
        for (const item of block.items) {
          const indent = 18 + item.level * 18;
          const lines = this.wrap(this.atoms(item.inlines, { size: 10.5 }), this.width - indent);
          const marker = this.encoder.encode(item.ordered ? `${item.number}.` : item.level % 2 ? '–' : '•');
          this.ensure(14.5);
          const markerWidth = measure(marker, 'F1', 10.5);
          this.page.ops.push(`${rgb(TEXT)} BT /F1 10.5 Tf ${num(this.left + indent - 5 - markerWidth)} ${num(this.y - 10.5)} Td (${escapeString(marker)}) Tj ET`);
          this.flow(lines, this.left + indent, 14.5, 10.5);
          this.y -= 2;
        }
        this.y -= 5;
        return;
      }
      case 'quote': {
        for (const paragraph of block.paragraphs) {
          this.flow(this.wrap(this.atoms(paragraph, { size: 10.5, color: MUTED, italic: true }), this.width - 20), this.left + 16, 14.5, 10.5, (top, bottom) => this.page.ops.push(`${rgb(RULE)} ${num(this.left + 2)} ${num(bottom)} 3 ${num(top - bottom)} re f`));
          this.y -= 4;
        }
        this.y -= 4;
        return;
      }
      case 'code': {
        const size = 8.5;
        const perLine = Math.max(10, Math.floor((this.width - 12) / (size * 0.6)));
        const lines = this.encoder.encode(block.text).split('\n').flatMap((line) => { const parts: string[] = []; for (let at = 0; at < Math.max(1, line.length); at += perLine) parts.push(line.slice(at, at + perLine)); return parts; });
        this.y -= 2;
        for (const line of lines) {
          this.ensure(11.5);
          this.page.ops.push(`0.95 0.96 0.97 rg ${num(this.left)} ${num(this.y - 11.5)} ${num(this.width)} 11.5 re f`);
          this.page.ops.push(`${rgb(TEXT)} BT /F5 ${size} Tf ${num(this.left + 6)} ${num(this.y - 9)} Td (${escapeString(line)}) Tj ET`);
          this.y -= 11.5;
        }
        this.y -= 9;
        return;
      }
      case 'table': return this.table(block);
      case 'image': return this.image(block.src, block.alt);
      case 'rule': {
        this.ensure(12);
        this.y -= 6;
        this.page.ops.push(`${rgb(RULE, true)} 0.75 w ${num(this.left)} ${num(this.y)} m ${num(this.left + this.width)} ${num(this.y)} l S`);
        this.y -= 8;
        return;
      }
    }
  }

  private heading(level: 1 | 2 | 3 | 4, inlines: Inline[]) {
    const size = [20, 15.5, 12.5, 11][level - 1];
    this.gap([16, 14, 10, 8][level - 1]);
    const lines = this.wrap(this.atoms(inlines, { size, bold: true, color: level === 1 ? [0.06, 0.09, 0.16] : TEXT }), this.width);
    const leading = size * 1.25;
    // Keep a heading with the first lines of what follows it.
    this.ensure(lines.length * leading + 36);
    this.outline.push({ level, title: plainText(inlines).trim() || 'Untitled', page: this.pages.length - 1, y: this.y });
    this.flow(lines, this.left, leading, size);
    if (level === 1) { this.page.ops.push(`${rgb(RULE, true)} 0.75 w ${num(this.left)} ${num(this.y - 1)} m ${num(this.left + this.width)} ${num(this.y - 1)} l S`); this.y -= 6; }
    this.y -= 4;
  }

  private table(block: Extract<Block, { kind: 'table' }>) {
    const size = 9;
    const leading = 12;
    const pad = 4;
    const columns = block.header.length;
    const cells = [block.header, ...block.rows].map((row, rowIndex) => row.map((cell) => this.atoms(cell, { size, bold: rowIndex === 0 })));
    const natural = Array.from({ length: columns }, (_, column) => Math.max(...cells.map((row) => row[column].reduce((sum, atom) => sum + atom.width, 0))) + 2 * pad);
    const minimum = Array.from({ length: columns }, (_, column) => Math.min(this.width / columns, Math.max(24, ...cells.map((row) => Math.max(0, ...row[column].filter((atom) => !atom.space).map((atom) => atom.width))) ) + 2 * pad));
    let widths: number[];
    const totalNatural = natural.reduce((a, b) => a + b, 0);
    if (totalNatural <= this.width) widths = natural.map((value) => value * this.width / totalNatural);
    else {
      const totalMinimum = minimum.reduce((a, b) => a + b, 0);
      const spare = this.width - totalMinimum;
      const extra = natural.map((value, column) => Math.max(0, value - minimum[column]));
      const totalExtra = extra.reduce((a, b) => a + b, 0) || 1;
      widths = spare > 0 ? minimum.map((value, column) => value + spare * extra[column] / totalExtra) : minimum.map((value) => value * this.width / totalMinimum);
    }
    const xs = widths.map((_, column) => this.left + widths.slice(0, column).reduce((a, b) => a + b, 0));
    const wrapped = cells.map((row) => row.map((atoms, column) => this.wrap(atoms, widths[column] - 2 * pad)));
    const drawRow = (rowIndex: number, from: number, to: number) => {
      const height = (to - from) * leading + 2 * pad;
      const top = this.y;
      if (rowIndex === 0) this.page.ops.push(`0.93 0.94 0.96 rg ${num(this.left)} ${num(top - height)} ${num(this.width)} ${num(height)} re f`);
      wrapped[rowIndex].forEach((lines, column) => {
        lines.slice(from, to).forEach((line, offset) => {
          const align = block.align[column];
          const room = widths[column] - 2 * pad - line.width;
          const x = xs[column] + pad + (align === 'right' ? room : align === 'center' ? room / 2 : 0);
          this.drawLine(line, x, top - pad - offset * leading - size);
        });
        this.page.ops.push(`${rgb(RULE, true)} 0.5 w ${num(xs[column])} ${num(top - height)} ${num(widths[column])} ${num(height)} re S`);
      });
      this.y -= height;
    };
    const rowNotes = (rowIndex: number, from: number, to: number) => this.pending(wrapped[rowIndex].flatMap((lines) => lines.slice(from, to).flatMap((line) => line.notes)));
    const header = () => { const count = Math.max(...wrapped[0].map((lines) => lines.length)); const notes = rowNotes(0, 0, count); drawRow(0, 0, count); this.reserve(notes); };
    this.ensure(2 * (leading + 2 * pad) + leading);
    header();
    let fresh = true;
    for (let rowIndex = 1; rowIndex < wrapped.length; rowIndex += 1) {
      const count = Math.max(1, ...wrapped[rowIndex].map((lines) => lines.length));
      let from = 0;
      while (from < count) {
        const room = () => this.y - this.floor();
        let to = Math.min(count, from + Math.max(0, Math.floor((room() - 2 * pad) / leading)));
        // A short row is kept whole rather than split across pages.
        if (from === 0 && to < count && count <= 4) to = from;
        while (to > from && (to - from) * leading + 2 * pad + this.footHeight(rowNotes(rowIndex, from, to)) > room()) to -= 1;
        if (to === from) {
          if (!fresh) { this.newPage(); header(); fresh = true; continue; }
          to = Math.max(from + 1, Math.min(count, from + Math.floor((room() - 2 * pad) / leading)));
          while (to > from + 1 && (to - from) * leading + 2 * pad + this.footHeight(rowNotes(rowIndex, from, to)) > room()) to -= 1;
          // Even one line of the row with its footnotes does not fit on an empty page: the note can never be placed.
          if (leading + 2 * pad + this.footHeight(rowNotes(rowIndex, from, to)) > room()) throw this.noteTooLong(rowNotes(rowIndex, from, to));
        }
        const notes = rowNotes(rowIndex, from, to);
        drawRow(rowIndex, from, to);
        this.reserve(notes);
        fresh = false;
        from = to;
        if (from < count) { this.newPage(); header(); fresh = true; }
      }
    }
    this.y -= 10;
  }

  private image(src: string, alt: string) {
    const image = this.images.get(src);
    if (!image) throw new ToolError(`Image ${src} was not loaded.`);
    if (!this.usedImages.includes(src)) this.usedImages.push(src);
    const natural = [image.width * 0.75, image.height * 0.75];
    const maxHeight = (this.top - this.bottom) * 0.75;
    const scale = Math.min(1, this.width / natural[0], maxHeight / natural[1]);
    const [w, h] = [natural[0] * scale, natural[1] * scale];
    const caption = alt ? this.wrap(this.atoms([{ text: alt }], { size: 9, italic: true, color: MUTED }), this.width) : [];
    this.gap(4);
    this.ensure(h + caption.length * 12 + 6);
    const x = this.left + (this.width - w) / 2;
    this.page.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.y - h)} cm /Im${this.usedImages.indexOf(src) + 1} Do Q`);
    this.y -= h + 4;
    for (const line of caption) { this.drawLine(line, this.left + (this.width - line.width) / 2, this.y - 9); this.y -= 12; }
    this.y -= 8;
  }
}

// ---- Serialisation ------------------------------------------------------------------------------

/** A PDF text string: plain when it is printable ASCII, otherwise UTF-16BE with a byte-order mark. */
function textString(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return `(${value.replace(/[\\()]/g, (char) => `\\${char}`)})`;
  return `<FEFF${Buffer.from(value, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
}

/** D:YYYYMMDDHHmmSSZ from an ISO date (YYYY-MM-DD, optionally with a UTC time). */
export function pdfDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?Z?)?$/.exec(value.trim());
  if (!match) throw new ToolError(`date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ, not "${value}".`);
  // Date.parse rolls 2026-02-31 over to March 3, so the parts are compared with the date they make.
  const [year, month, day, hour, minute, second] = [match[1], match[2], match[3], match[4] ?? '00', match[5] ?? '00', match[6] ?? '00'].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) throw new ToolError(`date "${value}" is not a real date and time.`);
  return `D:${match[1]}${match[2]}${match[3]}${match[4] ?? '00'}${match[5] ?? '00'}${match[6] ?? '00'}Z`;
}

export function createPdf(spec: DocumentSpec): PdfResult {
  const size = PAGE[spec.pageSize ?? 'A4'];
  const encoder = new Encoder();
  const layout = new Layout(size, encoder, spec.images, spec.notes ?? [], spec.noteStyle ?? 'endnotes');
  for (const block of spec.blocks) layout.block(block);
  layout.endnotes();
  layout.footnotes();
  const pages = layout.pages;

  const objects: Array<Buffer | string> = [];
  const alloc = () => { objects.push(''); return objects.length; };
  const set = (id: number, value: Buffer | string) => { objects[id - 1] = value; };
  const stream = (dictionary: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);

  const catalog = alloc();
  const pagesId = alloc();
  const info = alloc();
  const fonts = FONTS.map(([key, name]) => { const id = alloc(); set(id, `<< /Type /Font /Subtype /Type1 /BaseFont /${name}${name === 'Courier' || name.startsWith('Helvetica') ? ' /Encoding /WinAnsiEncoding' : ''} >>`); return `/${key} ${id} 0 R`; });
  const imageRefs = layout.usedImages.map((src, index) => {
    const image = pdfImage(spec.images.get(src)!);
    const id = alloc();
    let mask = '';
    if (image.mask) { const maskId = alloc(); set(maskId, stream(image.mask.dictionary, image.mask.stream)); mask = ` /SMask ${maskId} 0 R`; }
    set(id, stream(`${image.dictionary}${mask}`, image.stream));
    return `/Im${index + 1} ${id} 0 R`;
  });
  const resources = `<< /ProcSet [/PDF /Text /ImageB /ImageC /ImageI] /Font << ${fonts.join(' ')} >>${imageRefs.length ? ` /XObject << ${imageRefs.join(' ')} >>` : ''} >>`;
  const pageIds = pages.map(() => alloc());
  pages.forEach((page, index) => {
    const content = alloc();
    const footer = encoder.encode(`Page ${index + 1} of ${pages.length}`);
    const ops = [...page.ops, `${rgb(MUTED)} BT /F1 8.5 Tf ${num((size[0] - measure(footer, 'F1', 8.5)) / 2)} ${num(MARGIN - 4)} Td (${escapeString(footer)}) Tj ET`];
    set(content, stream('/Filter /FlateDecode', deflateSync(Buffer.from(ops.join('\n'), 'latin1'), { level: 9 })));
    const annots = page.links.map((link) => {
      const note = /^#note-(\d+)$/.exec(link.uri);
      const target = note ? layout.noteTargets.get(Number(note[1])) : undefined;
      const action = note ? (target ? `/Dest [${pageIds[target.page]} 0 R /XYZ null ${num(target.y)} null]` : '') : `/A << /S /URI /URI ${textString(link.uri)} >>`;
      return action ? `<< /Type /Annot /Subtype /Link /Rect [${link.rect.map(num).join(' ')}] /Border [0 0 0] ${action} >>` : '';
    }).filter(Boolean);
    set(pageIds[index], `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(size[0])} ${num(size[1])}] /Resources ${resources} /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.join(' ')}]` : ''} >>`);
  });
  set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);

  // Bookmarks: each heading under the nearest earlier heading of a higher level.
  let outlinesId: number | undefined;
  if (layout.outline.length) {
    outlinesId = alloc();
    const ids = layout.outline.map(() => alloc());
    const parent: number[] = [];
    const stack: number[] = [];
    layout.outline.forEach((entry, index) => {
      while (stack.length && layout.outline[stack[stack.length - 1]].level >= entry.level) stack.pop();
      parent[index] = stack.length ? stack[stack.length - 1] : -1;
      stack.push(index);
    });
    const children = (of: number) => layout.outline.map((_, index) => index).filter((index) => parent[index] === of);
    const descendants = (of: number): number => children(of).reduce((sum, child) => sum + 1 + descendants(child), 0);
    layout.outline.forEach((entry, index) => {
      const siblings = children(parent[index]);
      const position = siblings.indexOf(index);
      const own = children(index);
      const fields = [`/Title ${textString(entry.title)}`, `/Parent ${parent[index] < 0 ? outlinesId : ids[parent[index]]} 0 R`, `/Dest [${pageIds[entry.page]} 0 R /XYZ null ${num(entry.y)} null]`];
      if (position > 0) fields.push(`/Prev ${ids[siblings[position - 1]]} 0 R`);
      if (position < siblings.length - 1) fields.push(`/Next ${ids[siblings[position + 1]]} 0 R`);
      if (own.length) fields.push(`/First ${ids[own[0]]} 0 R /Last ${ids[own[own.length - 1]]} 0 R /Count ${descendants(index)}`);
      set(ids[index], `<< ${fields.join(' ')} >>`);
    });
    const top = children(-1);
    set(outlinesId, `<< /Type /Outlines /First ${ids[top[0]]} 0 R /Last ${ids[top[top.length - 1]]} 0 R /Count ${layout.outline.length} >>`);
  }
  set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R${outlinesId ? ` /Outlines ${outlinesId} 0 R /PageMode /UseOutlines` : ''} >>`);
  const date = spec.date ? pdfDate(spec.date) : undefined;
  set(info, `<< /Title ${textString(spec.title)}${spec.author ? ` /Author ${textString(spec.author)}` : ''} /Creator (NEAR AI for VS Code) /Producer (NEAR AI for VS Code CreatePdf)${date ? ` /CreationDate (${date}) /ModDate (${date})` : ''} >>`);

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), typeof body === 'string' ? Buffer.from(body, 'latin1') : body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const fingerprint = createHash('md5').update(Buffer.concat(parts)).digest('hex');
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${fingerprint}> <${fingerprint}>] >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return { bytes: Buffer.concat(parts), pages: pages.length, headings: layout.outline.length, images: layout.usedImages.length, notes: spec.notes?.length ?? 0, substituted: [...encoder.missing] };
}

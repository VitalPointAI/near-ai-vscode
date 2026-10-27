import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { ToolError } from './workspace';

// Text from attached documents, read on this machine: PDFs with Mozilla's pdf.js (vendored at build
// time into vendor/pdfjs, since the extension ships no node_modules) and .docx, .pptx, and .xlsx
// from their XML. Only the extracted text is sent on, through the same checks as typed text.

export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx';
export interface DocumentText { text: string; pages?: number; note?: string }

const MAX_TEXT_CHARS = 200_000;
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_SHEET_ROWS = 5_000;

export async function documentText(bytes: Buffer, format: DocumentFormat, name: string): Promise<DocumentText> {
  const result = format === 'pdf' ? await pdfText(bytes, name) : officeText(bytes, format, name);
  const text = result.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length <= MAX_TEXT_CHARS) return { ...result, text };
  return { ...result, text: text.slice(0, MAX_TEXT_CHARS), note: [result.note, `${name} is long; only its first ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters were included.`].filter(Boolean).join(' ') };
}

// ---- PDF ------------------------------------------------------------------------------------

type PdfJs = { getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): Promise<void> }; GlobalWorkerOptions: { workerSrc: string } };
type PdfDocument = { numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }> }> };

export const PDFJS_DIR = path.join(__dirname, '..', '..', 'vendor', 'pdfjs');
// pdf.js is an ES module; TypeScript's CommonJS output would turn import() into require().
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PdfJs>;
let pdfjs: Promise<PdfJs> | undefined;

function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= importModule(pathToFileURL(path.join(PDFJS_DIR, 'pdf.min.mjs')).href).then((module) => {
    module.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(PDFJS_DIR, 'pdf.worker.min.mjs')).href;
    return module;
  }, (error: Error) => { pdfjs = undefined; throw new ToolError(`The PDF reader is missing from this installation (${error.message}).`); });
  return pdfjs;
}

async function pdfText(bytes: Buffer, name: string): Promise<DocumentText> {
  const lib = await loadPdfJs();
  // No eval, embedded fonts, or system fonts: only the text layer is wanted from an untrusted file.
  const task = lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  let document: PdfDocument;
  try {
    document = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => undefined);
    const reason = (error as { name?: string }).name === 'PasswordException' ? 'is password-protected' : 'could not be read as a PDF';
    throw new ToolError(`${name} ${reason}.`);
  }
  try {
    const pages = Math.min(document.numPages, MAX_PDF_PAGES);
    const parts: string[] = [];
    let length = 0;
    for (let number = 1; number <= pages && length < MAX_TEXT_CHARS; number += 1) {
      const content = await (await document.getPage(number)).getTextContent();
      const text = content.items.map((item) => `${item.str ?? ''}${item.hasEOL ? '\n' : ''}`).join('').trim();
      if (text) { parts.push(`[Page ${number}]\n${text}`); length += text.length; }
    }
    const notes: string[] = [];
    if (!parts.length) notes.push(`${name} has no text layer (it may be scanned), so its pages could not be read. Export it with text recognition (OCR) and attach it again.`);
    if (document.numPages > MAX_PDF_PAGES) notes.push(`Only the first ${MAX_PDF_PAGES} of ${document.numPages} pages of ${name} were read.`);
    return { text: parts.join('\n\n'), pages: document.numPages, ...(notes.length ? { note: notes.join(' ') } : {}) };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

// ---- Office Open XML ------------------------------------------------------------------------

/** The entries of a zip archive, each inflated on demand within a shared size budget. */
function unzip(bytes: Buffer, name: string): Map<string, () => string> {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  if (end < 0) throw new ToolError(`${name} is not a valid Office file.`);
  const entries = new Map<string, () => string>();
  let budget = MAX_UNPACKED_BYTES;
  let offset = bytes.readUInt32LE(end + 16);
  for (let count = bytes.readUInt16LE(end + 10); count > 0; count -= 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new ToolError(`${name} is not a valid Office file.`);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const entry = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    entries.set(entry, () => {
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new ToolError(`${name} is not a valid Office file.`);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const data = bytes.subarray(start, start + compressed);
      let output: Buffer;
      try {
        output = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: Math.max(1, budget) }) : Buffer.alloc(0);
      } catch {
        throw new ToolError(`${name} is too large when unpacked (over ${MAX_UNPACKED_BYTES / 1024 / 1024} MB) or damaged.`);
      }
      budget -= output.length;
      if (budget < 0) throw new ToolError(`${name} is too large when unpacked (over ${MAX_UNPACKED_BYTES / 1024 / 1024} MB).`);
      return output.toString('utf8');
    });
  }
  return entries;
}

function decodeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (match, entity: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Relationship targets by id, resolved against the folder of the part that owns them. */
function relationships(xml: string | undefined, folder: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  for (const match of (xml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1];
    if (!id || !target || /TargetMode="External"/.test(match[0])) continue;
    map.set(id, { target: target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(folder, target)), type: /\bType="([^"]+)"/.exec(match[0])?.[1] ?? '' });
  }
  return map;
}

function officeText(bytes: Buffer, format: Exclude<DocumentFormat, 'pdf'>, name: string): DocumentText {
  const zip = unzip(bytes, name);
  const read = (entry: string) => zip.get(entry)?.();
  if (format === 'docx') return { text: wordText(read('word/document.xml') ?? missing(name, 'word/document.xml')) };
  if (format === 'pptx') return slidesText(read, name);
  return sheetsText(read, name);
}

function missing(name: string, part: string): never {
  throw new ToolError(`${name} is missing ${part}; it may not be a Word, PowerPoint, or Excel file.`);
}

function wordText(xml: string): string {
  let out = '';
  let cells = 0;
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>|<w:tc\b[^>]*>|<\/w:tc>|<\/w:tr>|<\/w:p>/g)) {
    const token = match[0];
    if (match[1] !== undefined) out += decodeXml(match[1]);
    else if (token === '<w:tab/>') out += '\t';
    else if (token.startsWith('<w:br') || token.startsWith('<w:cr')) out += '\n';
    else if (token.startsWith('<w:tc')) cells += 1;
    else if (token === '</w:tc>') { cells -= 1; out = `${out.trimEnd()} | `; }
    else if (token === '</w:tr>') out = `${out.replace(/ \| $/, '')}\n`;
    else out += cells > 0 ? ' ' : '\n';
  }
  return out;
}

function drawingText(xml: string): string {
  let out = '';
  for (const match of xml.matchAll(/<a:t>([^<]*)<\/a:t>|<a:t\s[^>]*>([^<]*)<\/a:t>|<a:br\b[^>]*\/>|<\/a:p>/g)) {
    if (match[1] !== undefined || match[2] !== undefined) out += decodeXml(match[1] ?? match[2]);
    else out += '\n';
  }
  return out.trim();
}

function slidesText(read: (entry: string) => string | undefined, name: string): DocumentText {
  const presentation = read('ppt/presentation.xml') ?? missing(name, 'ppt/presentation.xml');
  const rels = relationships(read('ppt/_rels/presentation.xml.rels'), 'ppt');
  const slides = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((match) => rels.get(match[1])?.target).filter((target): target is string => Boolean(target));
  const parts = slides.map((slide, index) => {
    const xml = read(slide) ?? '';
    const own = relationships(read(path.posix.join(path.posix.dirname(slide), '_rels', `${path.posix.basename(slide)}.rels`)), path.posix.dirname(slide));
    const notesPart = [...own.values()].find((rel) => rel.type.endsWith('/notesSlide'))?.target;
    // Skip the placeholders for the slide image, slide number, header, footer, and date.
    const notes = notesPart ? [...(read(notesPart) ?? '').matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].filter((shape) => !/<p:ph\b[^>]*type="(?:sldImg|sldNum|hdr|ftr|dt)"/.test(shape[0])).map((shape) => drawingText(shape[0])).join('\n').trim() : '';
    return `## Slide ${index + 1}\n${drawingText(xml)}${notes ? `\n\nNotes: ${notes}` : ''}`;
  });
  return { text: parts.join('\n\n'), pages: slides.length };
}

function columnIndex(reference: string): number {
  let index = 0;
  for (const letter of /^[A-Z]+/.exec(reference)?.[0] ?? 'A') index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function sheetsText(read: (entry: string) => string | undefined, name: string): DocumentText {
  const workbook = read('xl/workbook.xml') ?? missing(name, 'xl/workbook.xml');
  const rels = relationships(read('xl/_rels/workbook.xml.rels'), 'xl');
  const shared = [...(read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) => [...item[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((run) => decodeXml(run[1])).join(''));
  const notes: string[] = [];
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((match) => ({ title: decodeXml(/\bname="([^"]*)"/.exec(match[0])?.[1] ?? 'Sheet'), part: rels.get(/\br:id="([^"]+)"/.exec(match[0])?.[1] ?? '')?.target }));
  const parts = sheets.map((sheet) => {
    const xml = (sheet.part && read(sheet.part)) || '';
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_SHEET_ROWS) { notes.push(`Only the first ${MAX_SHEET_ROWS} rows of sheet "${sheet.title}" were read.`); break; }
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1];
        const body = cell[2] ?? '';
        const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
        const raw = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        const value = type === 's' ? shared[Number(raw)] ?? ''
          : type === 'inlineStr' ? [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((run) => decodeXml(run[1])).join('')
          : type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE')
          : raw !== undefined ? decodeXml(raw) : '';
        const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1];
        const column = reference ? columnIndex(reference) : cells.length;
        while (cells.length < column) cells.push('');
        cells[column] = value.replace(/[\t\n]+/g, ' ');
      }
      if (cells.some((value) => value)) rows.push(cells.join('\t'));
    }
    return `## Sheet: ${sheet.title}\n${rows.join('\n')}`;
  });
  return { text: parts.join('\n\n'), pages: sheets.length, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

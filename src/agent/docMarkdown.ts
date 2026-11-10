// The Markdown subset that CreatePdf and CreateDocument turn into pages: headings 1-4,
// paragraphs, bold, italic, inline code, links, bullet and numbered lists (nested by indentation),
// block quotes, fenced or indented code blocks, pipe tables, horizontal rules, and images on a
// line of their own. Anything else is kept as plain text rather than dropped, so nothing the
// writer put in the report silently disappears.

export interface Inline { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string }
export type Align = 'left' | 'center' | 'right';
export interface ListItem { inlines: Inline[]; level: number; ordered: boolean; number: number }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'quote'; paragraphs: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][]; align: Align[] }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'rule' };

/** Characters Markdown lets a writer escape with a backslash. */
const ESCAPABLE = '\\`*_{}[]()#+-.!|>~';

/** Splits inline Markdown into styled runs; adjacent runs with the same style are merged. */
export function parseInline(source: string): Inline[] {
  const runs: Inline[] = [];
  const push = (text: string, style: Omit<Inline, 'text'>) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && !!last.bold === !!style.bold && !!last.italic === !!style.italic && !!last.code === !!style.code && last.link === style.link) last.text += text;
    else runs.push({ text, ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}), ...(style.code ? { code: true } : {}), ...(style.link ? { link: style.link } : {}) });
  };
  const walk = (text: string, style: Omit<Inline, 'text'>, depth: number) => {
    let plain = '';
    const flush = () => { push(plain, style); plain = ''; };
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      const rest = text.slice(index);
      if (char === '\\' && index + 1 < text.length && ESCAPABLE.includes(text[index + 1])) { plain += text[index + 1]; index += 2; continue; }
      if (char === '`') {
        const ticks = /^`+/.exec(rest)![0];
        const close = text.indexOf(ticks, index + ticks.length);
        if (close > 0) { flush(); push(text.slice(index + ticks.length, close).replace(/^ (.+) $/, '$1'), { ...style, code: true }); index = close + ticks.length; continue; }
      }
      if (depth < 6) {
        const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
        if (image) { plain += image[1] || 'image'; index += image[0].length; continue; }
        const link = /^\[((?:\\.|[^\]\\])+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
        if (link) { flush(); walk(link[1], { ...style, link: link[2] }, depth + 1); index += link[0].length; continue; }
        const auto = /^<((?:https?|mailto):[^>\s]+)>/.exec(rest);
        if (auto) { flush(); push(auto[1], { ...style, link: auto[1] }); index += auto[0].length; continue; }
        const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1(?!\*)/.exec(rest);
        if (strong && !(strong[1] === '__' && /\w/.test(text[index - 1] ?? ''))) { flush(); walk(strong[2], { ...style, bold: true }, depth + 1); index += strong[0].length; continue; }
        const emphasis = /^([*_])(?=\S)([\s\S]*?[^\s\\])\1(?![*_])/.exec(rest);
        if (emphasis && !(emphasis[1] === '_' && /\w/.test(text[index - 1] ?? ''))) { flush(); walk(emphasis[2], { ...style, italic: true }, depth + 1); index += emphasis[0].length; continue; }
      }
      plain += char;
      index += 1;
    }
    flush();
  };
  walk(source, {}, 0);
  return runs;
}

/** The text of a run list with no styling, for outlines, alt text, and checks. */
export const plainText = (inlines: Inline[]): string => inlines.map((run) => run.text).join('');

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const IMAGE_LINE = /^ {0,3}!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let code = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') { current += '|'; index += 1; continue; }
    if (char === '`') code = !code;
    if (char === '|' && !code) { cells.push(current.trim()); current = ''; continue; }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

const isTableStart = (lines: string[], index: number) => lines[index].includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]) && lines[index + 1].includes('-') && (lines[index + 1].includes('|') || lines[index].trim().startsWith('|'));

/** Parses the supported Markdown subset into blocks. Front matter (--- ... ---) at the top is skipped. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  if (lines[0] === '---') { const end = lines.indexOf('---', 1); if (end > 0) index = end + 1; }
  const blank = (line: string | undefined) => line === undefined || !line.trim();
  const startsBlock = (at: number) => {
    const line = lines[at];
    return HEADING.test(line) || FENCE.test(line) || RULE.test(line) || QUOTE.test(line) || IMAGE_LINE.test(line) || LIST_ITEM.test(line) || isTableStart(lines, at);
  };
  while (index < lines.length) {
    const line = lines[index];
    if (blank(line)) { index += 1; continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1].length) as 1 | 2 | 3 | 4;
      blocks.push({ kind: 'heading', level, inlines: parseInline(heading[2].trim()) });
      index += 1; continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index].trim().startsWith(fence[1][0].repeat(fence[1].length)) && /^\s*[`~]+\s*$/.test(lines[index]))) { body.push(lines[index]); index += 1; }
      index += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (/^ {4}/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && (/^ {4}/.test(lines[index]) || (blank(lines[index]) && /^ {4}/.test(lines[index + 1] ?? '')))) { body.push(lines[index].slice(4)); index += 1; }
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (RULE.test(line)) { blocks.push({ kind: 'rule' }); index += 1; continue; }
    const image = IMAGE_LINE.exec(line);
    if (image) { blocks.push({ kind: 'image', alt: image[1].trim(), src: image[2] }); index += 1; continue; }
    if (QUOTE.test(line)) {
      const paragraphs: string[][] = [[]];
      while (index < lines.length && (QUOTE.test(lines[index]) || (!blank(lines[index]) && paragraphs[paragraphs.length - 1].length && !startsBlock(index)))) {
        const quoted = QUOTE.exec(lines[index]);
        const text = quoted ? quoted[1] : lines[index];
        if (!text.trim()) { if (paragraphs[paragraphs.length - 1].length) paragraphs.push([]); } else paragraphs[paragraphs.length - 1].push(text.trim());
        index += 1;
      }
      blocks.push({ kind: 'quote', paragraphs: paragraphs.filter((part) => part.length).map((part) => parseInline(part.join(' '))) });
      continue;
    }
    if (isTableStart(lines, index)) {
      const header = splitRow(line);
      const align: Align[] = splitRow(lines[index + 1]).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left'));
      index += 2;
      const rows: Inline[][][] = [];
      while (index < lines.length && !blank(lines[index]) && lines[index].includes('|')) {
        const cells = splitRow(lines[index]);
        rows.push(header.map((_, column) => parseInline(cells[column] ?? '')));
        index += 1;
      }
      blocks.push({ kind: 'table', header: header.map((cell) => parseInline(cell)), rows, align: header.map((_, column) => align[column] ?? 'left') });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: ListItem[] = [];
      const indents: number[] = [];
      const counters: number[] = [];
      const kinds: boolean[] = [];
      while (index < lines.length) {
        const current = lines[index];
        const item = LIST_ITEM.exec(current);
        if (item) {
          const indent = item[1].length;
          while (indents.length && indent < indents[indents.length - 1]) { indents.pop(); counters.pop(); }
          if (!indents.length || indent > indents[indents.length - 1] + 1) { indents.push(indent); counters.push(0); }
          const level = Math.min(indents.length - 1, 8);
          const ordered = /\d/.test(item[2]);
          // A switch between bullets and numbers at the top level starts a new list; deeper, it restarts the count.
          if (kinds[level] !== undefined && kinds[level] !== ordered && counters[counters.length - 1] !== 0) {
            if (level === 0) break;
            counters[counters.length - 1] = 0;
          }
          kinds[level] = ordered;
          kinds.length = level + 1;
          const start = ordered ? Number(item[2].slice(0, -1)) : 0;
          counters[counters.length - 1] = counters[counters.length - 1] === 0 && ordered ? start : counters[counters.length - 1] + 1;
          let text = item[3];
          const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
          if (task) text = `${task[1] === ' ' ? '☐' : '☑'} ${task[2]}`;
          items.push({ inlines: [], level, ordered, number: ordered ? counters[counters.length - 1] : 0, text } as ListItem & { text: string });
          index += 1;
          continue;
        }
        if (blank(current)) {
          const next = lines[index + 1];
          if (next !== undefined && (LIST_ITEM.test(next) || (/^\s{2,}\S/.test(next) && !startsBlock(index + 1)))) { index += 1; continue; }
          break;
        }
        if (startsBlock(index) && !/^\s{2,}/.test(current)) break;
        (items[items.length - 1] as ListItem & { text: string }).text += ` ${current.trim()}`;
        index += 1;
      }
      for (const item of items as Array<ListItem & { text?: string }>) { item.inlines = parseInline(item.text ?? ''); delete item.text; }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && !blank(lines[index]) && (!paragraph.length || !startsBlock(index))) {
      // A line ending in two spaces or a backslash is a hard break.
      const raw = lines[index];
      paragraph.push(/( {2,}|\\)$/.test(raw) ? `${raw.replace(/( {2,}|\\)$/, '')}\n` : raw.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ').replace(/\n /g, '\n')) });
  }
  return blocks;
}

/** Image references in a Markdown source, in order, without duplicates. */
export function imageReferences(blocks: Block[]): string[] {
  return [...new Set(blocks.filter((block): block is Extract<Block, { kind: 'image' }> => block.kind === 'image').map((block) => block.src))];
}

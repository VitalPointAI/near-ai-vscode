// Minimal Markdown renderer for model output. Every character of input is HTML-escaped
// before any markup is added, so model text can never inject elements or attributes.
(function (root) {
  'use strict';

  function escapeHtml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Emphasis runs only on text outside code spans and link URLs, so a URL keeps its `~~`, `**` or
  // `_` characters. A strikethrough must hug its text (`~~a b~~`, not `~~ a ~~`), as in GFM.
  function emphasis(html) {
    return html
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^~])~~(?=[^\s~])([^~\n]*?[^\s~])~~(?!~)/g, '$1<del>$2</del>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
  }

  function inline(text) {
    const codeSpans = [];
    const links = [];
    // \u0000 and \u0001 mark held-back spans below, so they never come from the model's text.
    let html = escapeHtml(String(text).replace(/[\u0000\u0001]/g, '\ufffd')).replace(/`([^`\n]+)`/g, (_match, code) => {
      codeSpans.push(code);
      return `\u0000${codeSpans.length - 1}\u0000`;
    });
    // A URL cannot contain a held-back code span, so a backtick in a URL leaves the link as text.
    html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g, (_match, label, url) => {
      links.push(`<a href="${url}" title="${url}">${emphasis(label)}</a>`);
      return `\u0001${links.length - 1}\u0001`;
    });
    html = emphasis(html).replace(/\u0001(\d+)\u0001/g, (_match, index) => links[Number(index)]);
    return html.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${codeSpans[Number(index)]}</code>`);
  }

  // Splits a table row into raw cell texts. `\|` is a literal pipe, and a pipe inside a code span
  // does not end the cell. Leading and trailing pipes are optional.
  function splitRow(line) {
    const text = line.trim();
    const cells = [];
    let cell = '';
    let endedWithPipe = false;
    for (let index = 0; index < text.length;) {
      const char = text[index];
      endedWithPipe = false;
      if (char === '\\' && text[index + 1] === '|') {
        cell += '|';
        index += 2;
      } else if (char === '`') {
        let run = 1;
        while (text[index + run] === '`') run += 1;
        const close = text.indexOf('`'.repeat(run), index + run);
        const end = close === -1 ? index + run : close + run;
        cell += close === -1 ? text.slice(index, end) : text.slice(index, end).replace(/\\\|/g, '|');
        index = end;
      } else if (char === '|') {
        cells.push(cell);
        cell = '';
        endedWithPipe = true;
        index += 1;
      } else {
        cell += char;
        index += 1;
      }
    }
    cells.push(cell);
    if (text.startsWith('|')) cells.shift();
    if (endedWithPipe && cells.length) cells.pop();
    return cells.map((value) => value.trim());
  }

  const HEADING = /^(#{1,4})\s+(.*)$/;
  const BULLET = /^\s*[-*+]\s+(.*)$/;
  const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
  const QUOTE = /^\s*>/;
  const FENCE = /^\s*```/;
  // A table row is a plain line with a pipe: a heading, list item, quote or fence that contains a
  // pipe stays what it is, so it never becomes a table header or gets swallowed as a table row.
  const isRow = (line) => line.includes('|') && ![HEADING, BULLET, ORDERED, QUOTE, FENCE].some((rule) => rule.test(line));
  const startsWithPipe = (line) => /^\s*\|/.test(line);

  function alignments(line) {
    if (!line.includes('|')) return undefined;
    const cells = splitRow(line);
    if (!cells.length || !cells.every((cell) => /^:?-+:?$/.test(cell))) return undefined;
    return cells.map(alignOf);
  }

  function alignOf(cell) {
    const left = cell.startsWith(':');
    const right = cell.length > 1 && cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  }

  // A line without a leading pipe only passes for a table header while it streams if it reads like
  // one: two or more cells split by pipes outside code spans, none of them empty, and, until the
  // delimiter row shows a pipe of its own, no cell that ends like a sentence. So prose such as
  // "Run `a | b` to filter:", "a || b is or" or "Pick a | b here." stays prose.
  function looksLikeHeader(line, next) {
    if (startsWithPipe(line)) return true;
    const cells = splitRow(line);
    if (cells.length < 2 || cells.some((cell) => !cell)) return false;
    return next.includes('|') || !cells.some((cell) => /[.,:;!?]$/.test(cell));
  }

  // While a reply streams, its delimiter row may not have arrived yet. A trailing row that starts
  // with a pipe shows as a table header straight away. A row that looks like a table header and is
  // followed by the start of a delimiter row (`-`, `|--`, `:--`) also shows as a table, instead of
  // flashing up as a paragraph and a rule. A prose line with a pipe on its own stays prose until a
  // dash arrives, so text like "use a | b" never turns into a table. The final render applies the
  // strict rules.
  function pendingTableEnd(lines, index) {
    const line = lines[index];
    if (!isRow(line)) return 0;
    // A lone delimiter row is not a header: it belongs to the row above, which did not match it.
    if (index === lines.length - 1) return startsWithPipe(line) && !(/^[\s|:-]*$/.test(line) && line.includes('-')) ? 1 : 0;
    if (index !== lines.length - 2) return 0;
    const next = lines[index + 1];
    if (!/^[\s|:-]*$/.test(next) || /^\s*-\s+$/.test(next)) return 0;
    if (!startsWithPipe(line) && (!next.includes('-') || !looksLikeHeader(line, next))) return 0;
    return splitRow(next).length <= splitRow(line).length ? 2 : 0;
  }

  // The text a cell shows, without its markup: the rendered cell with its tags taken off. Only
  // Markdown that renders (emphasis pairs, code spans, links) loses its markers, so `user_id`
  // or `C:\\path` keeps every character. Model text is escaped first, so every tag is our own.
  function plainText(cell) {
    return inline(cell).replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  // A plain-text name for a table region, from its header cells, so screen reader users can tell
  // tables apart: "Table: Name, Count, Note".
  function tableLabel(header) {
    const names = header.map((cell) => plainText(cell).replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!names.length) return 'Table';
    // Counted in characters, not UTF-16 units, so an emoji is never cut in half.
    const text = Array.from(names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : ''));
    return `Table: ${text.length > 80 ? text.slice(0, 79).join('').trimEnd() + '…' : text.join('')}`;
  }

  function renderTable(header, aligns, rows, label) {
    // A table whose first header cell is empty uses its first column as row labels.
    const rowHeaders = header.length > 1 && !header[0];
    const attrs = (column) => (aligns[column] ? ` class="align-${aligns[column]}"` : '');
    const head = header.map((cell, column) => `<th scope="col"${attrs(column)}>${inline(cell)}</th>`).join('');
    const body = rows.map((row) => `<tr>${header.map((_cell, column) => {
      const tag = rowHeaders && column === 0 ? 'th' : 'td';
      const scope = tag === 'th' ? ' scope="row"' : '';
      return `<${tag}${scope}${attrs(column)}>${inline(row[column] || '')}</${tag}>`;
    }).join('')}</tr>`).join('');
    // A lone backtick in a header is kept in the label, but as a character reference, so the
    // attribute holds nothing a browser could ever treat as a quote.
    return `<div class="table-wrap" role="region" aria-label="${escapeHtml(label).replace(/`/g, '&#96;')}"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>`;
  }

  function renderQuote(lines) {
    const paragraphs = [];
    let current = [];
    for (const line of lines) {
      if (line.trim()) current.push(line);
      else if (current.length) { paragraphs.push(current); current = []; }
    }
    if (current.length) paragraphs.push(current);
    return `<blockquote>${paragraphs.map((group) => `<p>${group.map(inline).join('<br>')}</p>`).join('')}</blockquote>`;
  }

  /**
   * Returns blocks: { type: 'html', html } or { type: 'code', lang, code } so callers can add code-block chrome.
   * Pass { partial: true } while text is still streaming in, so an unfinished table does not flicker.
   */
  function parse(source, options) {
    const partial = Boolean(options && options.partial);
    const blocks = [];
    const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let list;
    // Two tables with the same headers in one reply get numbered labels, so every region is distinct.
    const labels = new Map();
    const labelFor = (header) => {
      const base = tableLabel(header);
      const count = (labels.get(base) || 0) + 1;
      labels.set(base, count);
      return count === 1 ? base : `${base} (${count})`;
    };
    const flushParagraph = () => {
      if (paragraph.length) blocks.push({ type: 'html', html: `<p>${paragraph.map(inline).join('<br>')}</p>` });
      paragraph = [];
    };
    const flushList = () => {
      if (list) blocks.push({ type: 'html', html: `<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>` });
      list = undefined;
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flushParagraph();
        flushList();
        const code = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { code.push(lines[index]); index += 1; }
        blocks.push({ type: 'code', lang: fence[1] || '', code: code.join('\n') });
        continue;
      }
      const aligns = isRow(line) && index + 1 < lines.length ? alignments(lines[index + 1]) : undefined;
      const header = aligns ? splitRow(line) : undefined;
      if (header && header.length === aligns.length) {
        flushParagraph();
        flushList();
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].trim() && isRow(lines[index])) { rows.push(splitRow(lines[index])); index += 1; }
        index -= 1;
        blocks.push({ type: 'html', html: renderTable(header, aligns, rows, labelFor(header)) });
        continue;
      }
      const pending = partial ? pendingTableEnd(lines, index) : 0;
      if (pending) {
        flushParagraph();
        flushList();
        const cells = splitRow(line);
        if (cells.length) blocks.push({ type: 'html', html: renderTable(cells, pending === 2 ? splitRow(lines[index + 1]).map(alignOf) : [], [], labelFor(cells)) });
        break;
      }
      const heading = HEADING.exec(line);
      const bullet = BULLET.exec(line);
      const ordered = ORDERED.exec(line);
      if (heading) {
        flushParagraph();
        flushList();
        const level = Math.min(heading[1].length + 2, 6);
        blocks.push({ type: 'html', html: `<h${level}>${inline(heading[2])}</h${level}>` });
      } else if (bullet || ordered) {
        flushParagraph();
        const tag = bullet ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        list = list || { tag, items: [] };
        list.items.push((bullet || ordered)[1]);
      } else if (/^\s*>/.test(line)) {
        flushParagraph();
        flushList();
        const quoted = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) { quoted.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
        index -= 1;
        blocks.push({ type: 'html', html: renderQuote(quoted) });
      } else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
        flushParagraph();
        flushList();
        blocks.push({ type: 'html', html: '<hr>' });
      } else if (!line.trim()) {
        flushParagraph();
        flushList();
      } else {
        flushList();
        paragraph.push(line);
      }
    }
    flushParagraph();
    flushList();
    return blocks;
  }

  const api = { escapeHtml, inline, parse, splitRow, tableLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.nearMarkdown = api;
})(this);

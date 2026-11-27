// Turns one bundled guide into HTML at image build time, so the Documentation view never shows Markdown, MDX or diagram source as text.
// Build time only: nothing here runs in the browser, contacts a network or reads outside the repository root it is given.
//
//   images      a local or same-repository image is copied in as a same-origin asset (sterling-documentation/<hash>.<ext>); any other
//               address becomes a short text note, so the page never loads a remote image (46-03: same-origin, data: or blob: only)
//   diagrams    ```mermaid fences are drawn to static SVG here (beautiful-mermaid: no DOM, no browser); its <style> block, with its Google
//               Fonts @import, is removed and its colours follow the Theia theme through CSS variables
//   HTML, MDX   raw HTML is never passed through (markdown-it runs with html: false); figures and <img> become our own <figure>/<img>,
//               <details> keeps its summary, MDX import/export lines are dropped, and other JSX components keep their text or say plainly
//               that the interactive part is not shown here
//
// The Documentation view still sanitizes the result with DOMPurify before showing it (defence in depth, sterling-documentation-module.ts).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import { renderMermaidSVG } from 'beautiful-mermaid';

/** The folder, beside sterling-documentation.json in lib/frontend, that holds the bundled images. */
export const ASSET_DIR = 'sterling-documentation';
const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// Images this repository publishes on GitHub are the same files as in the checkout: bundle the local copy instead of linking out.
const REPOSITORY_IMAGE = [
  /^https:\/\/raw\.githubusercontent\.com\/VitalPointAI\/near-ai-vscode\/main\/([^?#]+)/i,
  /^https:\/\/github\.com\/VitalPointAI\/near-ai-vscode\/(?:raw|blob)\/main\/([^?#]+)/i,
];
// HTML element names a block may start with; any other lowercase name (a placeholder like <team> or <extension> in prose) stays text.
const HTML_BLOCK_TAGS = new Set(['figure', 'picture', 'img', 'p', 'div', 'center', 'details', 'section', 'span', 'a', 'br', 'hr',
  'table', 'video', 'audio', 'iframe', 'object', 'embed', 'script', 'style', 'source', 'sub', 'sup', 'kbd', 'b', 'i', 'em', 'strong']);
// Only block-level elements (and JSX components) may interrupt a paragraph, as in CommonMark; an inline tag at a line start stays inline.
const INLINE_TAGS = new Set(['img', 'span', 'a', 'br', 'source', 'sub', 'sup', 'kbd', 'b', 'i', 'em', 'strong', 'code', 'small', 'u', 's']);
const FORMAT_TAGS = new Map([['b', 'strong'], ['strong', 'strong'], ['i', 'em'], ['em', 'em'], ['kbd', 'kbd'], ['sub', 'sub'], ['sup', 'sup'], ['code', 'code'], ['s', 's']]);
const DROPPED_TAGS = new Set(['script', 'style']);
const EMBED_TAGS = new Set(['video', 'audio', 'iframe', 'object', 'embed']);

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeEntities = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, name) => {
  const lower = name.toLowerCase();
  if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
  if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }[lower] ?? whole;
});
/** Plain text of a fragment of HTML or JSX: tags removed, entities decoded, whitespace folded. */
const textOf = (markup) => decodeEntities(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Text matched literally inside a regular expression: every character with a meaning there is escaped, the backslash included. */
const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/** The attributes of one HTML or JSX tag: name="v", name='v', name={"v"}, name={require('v').default} and name={useBaseUrl('v')}. */
export function tagAttributes(tag) {
  const attributes = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:require|useBaseUrl)\(\s*["'`]([^"'`]*)["'`]\s*\)(?:\.default)?\s*\}|\{\s*["'`]([^"'`]*)["'`]\s*\})/g;
  for (const match of tag.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attributes;
}

/**
 * Makes a renderer for the guides of the repository at `root` (a filesystem path). `render(source, markdown)` returns the page's sanitized
 * HTML and its plain text for search; `assets` maps each bundled image's file name to the repository file to copy.
 */
export function createDocumentationRenderer({ root }) {
  const repository = realpathSync(root);
  const assets = new Map();

  /** The same-origin address of a bundled copy of `src`, or undefined when the image is not one this repository holds. */
  function bundleImage(src, source) {
    const address = (src ?? '').trim();
    if (!address) return undefined;
    let file;
    const published = REPOSITORY_IMAGE.map((pattern) => address.match(pattern)).find(Boolean);
    if (published) file = decodeURIComponent(published[1]);
    else if (/^[a-z][a-z\d+.-]*:/i.test(address) || address.startsWith('//')) return undefined;
    else {
      const clean = decodeURIComponent(address.replace(/[?#].*$/, ''));
      if (clean.startsWith('@site/')) file = path.posix.join('docs-site', clean.slice('@site/'.length));
      // Docusaurus serves docs-site/static/ at the site root.
      else if (clean.startsWith('/')) file = path.posix.join('docs-site/static', clean);
      else file = path.posix.join(path.posix.dirname(source), clean);
    }
    const extension = path.extname(file).toLowerCase();
    const absolute = path.resolve(repository, file);
    const inside = path.relative(repository, absolute);
    if (!IMAGE_TYPES.has(extension) || inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error(`${source}: the image ${address} is not a png, jpg, gif, webp or svg file inside the repository.`);
    }
    if (!existsSync(absolute)) throw new Error(`${source}: the image ${address} (${file}) does not exist.`);
    const real = realpathSync(absolute);
    if (path.relative(repository, real).startsWith('..')) throw new Error(`${source}: the image ${address} links outside the repository.`);
    if (statSync(real).size > MAX_IMAGE_BYTES) throw new Error(`${source}: the image ${address} is larger than 2 MB.`);
    const name = `${createHash('sha256').update(readFileSync(real)).digest('hex').slice(0, 16)}${extension}`;
    assets.set(name, real);
    return `${ASSET_DIR}/${name}`;
  }

  function imageHtml(src, alt, title, source, fullSize = false) {
    const bundled = bundleImage(src, source);
    const words = alt.trim();
    if (!bundled) {
      return `<span class="sterling-doc-image-missing">Image not available offline${words ? `: ${escapeHtml(words)}` : ''}</span>`;
    }
    const image = `<img src="${escapeHtml(bundled)}" alt="${escapeHtml(words)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
    return fullSize
      ? `<figure class="sterling-doc-figure"><a href="${escapeHtml(bundled)}">${image}<br>Open full-size image</a></figure>\n`
      : image;
  }

  function diagramHtml(code, label, source) {
    let svg;
    try {
      svg = renderMermaidSVG(code, { bg: 'var(--sterling-diagram-bg)', fg: 'var(--sterling-diagram-fg)', transparent: true });
    } catch (error) {
      throw new Error(`${source}: a mermaid diagram could not be drawn offline (${error instanceof Error ? error.message : error}).`);
    }
    // The renderer's <style> block would style every SVG on the page and @imports Google Fonts: keep only its CSS variables, on the SVG.
    const variables = svg.match(/<style>[\s\S]*?\bsvg\s*\{([^}]*)\}[\s\S]*?<\/style>/)?.[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim() ?? '';
    svg = svg.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<svg ([^>]*?)style="([^"]*)"/, (whole, before, style) =>
      `<svg ${before}style="${style};${variables}" role="img" aria-label="${escapeHtml(label)}"`);
    if (/<(script|style|foreignObject|image|use|a)\b|@import|https?:\/\/(?!www\.w3\.org\/)|\son\w+=/i.test(svg)) {
      throw new Error(`${source}: a drawn diagram holds markup the Documentation view does not allow.`);
    }
    // The drawn width lets the view shrink a wide diagram only as far as its labels stay readable, then scroll it (sterling-documentation.css).
    const drawn = Number(svg.match(/^<svg [^>]*?\swidth="([\d.]+)"/)?.[1]);
    const width = Number.isFinite(drawn) && drawn > 0 ? ` style="--sterling-diagram-width:${Math.ceil(drawn)}px"` : '';
    return `<figure class="sterling-doc-diagram"${width}>${svg}</figure>\n`;
  }

  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

  md.core.ruler.before('inline', 'documentation_heading_ids', ({ tokens }) => {
    for (const [index, heading] of tokens.entries()) {
      if (heading.type !== 'heading_open') continue;
      const inline = tokens[index + 1];
      const marker = inline.content.match(/\s+\{#([\w-]+)\}$/);
      if (!marker) continue;
      heading.attrSet('id', marker[1]);
      inline.content = inline.content.slice(0, marker.index);
    }
  });

  md.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
    const heading = tokens[index];
    const text = tokens[index + 1].children.map(token => {
      if (token.type === 'text' || token.type === 'code_inline') return token.content;
      if (token.type === 'softbreak' || token.type === 'hardbreak' || token.content === '<br>\n') return ' ';
      return '';
    }).join('');
    const base = heading.attrGet('id') || text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    let id = base;
    for (let suffix = 1; env.headingIds.has(id); suffix += 1) id = `${base}-${suffix}`;
    env.headingIds.add(id);
    heading.attrSet('id', id);
    return renderer.renderToken(tokens, index, options);
  };

  md.renderer.rules.image = (tokens, index, options, env) => {
    const token = tokens[index];
    return imageHtml(token.attrGet('src'), md.renderer.renderInlineAsText(token.children ?? [], options, env), token.attrGet('title'), env.source);
  };

  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token.info.trim().split(/\s+/)[0].toLowerCase() !== 'mermaid') return fence(tokens, index, options, env, self);
    const title = token.content.match(/^\s*accTitle\s*:\s*(.+)$/m)?.[1];
    let heading;
    for (let back = index - 1; back >= 0 && !heading; back -= 1) {
      if (tokens[back].type === 'heading_open') heading = tokens[back + 1].content;
    }
    return diagramHtml(token.content, `Diagram: ${(title ?? heading ?? env.title ?? 'figure').trim()}`, env.source);
  };

  md.renderer.rules.sterling_html = (tokens, index, _options, env) => {
    const token = tokens[index];
    return token.meta ? convertBlock(token.content, token.meta.name, env) : token.content;
  };

  /** Our HTML for one raw HTML or JSX block (never the block itself). */
  function convertBlock(raw, name, env) {
    const tag = name.toLowerCase();
    if (raw.startsWith('<!--') || DROPPED_TAGS.has(tag)) return '';
    if (EMBED_TAGS.has(tag)) return '<p class="sterling-doc-fallback">This embedded content is not shown in the workbench.</p>\n';
    const images = [...raw.matchAll(/<img\b[^>]*>/gi)].map((match) => tagAttributes(match[0]));
    if (images.length && tag === 'systemarchitecturemap') {
      return images.map(image => imageHtml(image.src, image.alt ?? '', image.title, env.source, true)).join('');
    }
    if (images.length) {
      const caption = raw.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1];
      const figure = images.map((image) => imageHtml(image.src, image.alt ?? '', image.title, env.source)).join('');
      return `<figure class="sterling-doc-figure">${figure}${caption ? `<figcaption>${md.renderInline(textOf(caption), env)}</figcaption>` : ''}</figure>\n`;
    }
    if (tag === 'details') {
      const summary = raw.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1];
      const body = raw.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, '').replace(/^<details\b[^>]*>|<\/details>\s*$/gi, '');
      return `<details><summary>${md.renderInline(textOf(summary ?? 'Details'), env)}</summary>${renderInner(body, env)}</details>\n`;
    }
    // Keep the element's text as Markdown: block tags and components become line breaks; inline tags are left to the inline rule below.
    const inner = raw.replace(/<\/?([A-Za-z][\w.:-]*)(?:\s(?:[^>{]|\{[^}]*\})*)?\/?>/g, (whole, tagName) =>
      INLINE_TAGS.has(tagName.toLowerCase()) ? whole : '\n');
    if (!inner.trim() && /^[A-Z]|\./.test(name)) {
      return `<p class="sterling-doc-fallback">The interactive part of this page (${escapeHtml(name)}) is shown only on the documentation site.</p>\n`;
    }
    return renderInner(inner, env);
  }

  /** Renders the Markdown left inside an element, without the indentation it had inside the element. */
  function renderInner(markdown, env) {
    const lines = markdown.split('\n').map((line) => line.trimEnd());
    const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length));
    const text = lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n').trim();
    return text ? md.render(text, env) : '';
  }

  // Raw HTML and JSX blocks: html: false would print them as escaped text; replace each with our own HTML instead.
  md.block.ruler.before('html_block', 'sterling_markup', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const lineText = (line) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    const first = lineText(startLine);
    let last = startLine;
    let name;
    if (state.env.mdx && /^(import|export)\s/.test(first)) {
      if (silent) return false;
      while (last + 1 < endLine && !state.isEmpty(last + 1)) last += 1;
      name = '';
    } else if (first.startsWith('<!--')) {
      while (last < endLine - 1 && !lineText(last).includes('-->')) last += 1;
      name = '!--';
    } else {
      name = first.match(/^<([A-Za-z][\w.:-]*)(?=[\s/>]|$)/)?.[1];
      if (!name) return false;
      const component = /^[A-Z]|\./.test(name);
      // Inline elements (<img>, <b>, <a> ...) at a line start belong to a paragraph; the inline rule below converts them.
      if (!component && (!HTML_BLOCK_TAGS.has(name.toLowerCase()) || INLINE_TAGS.has(name.toLowerCase()))) return false;
      if (silent) return true;
      const open = new RegExp(`<${escapeRegExp(name)}(?=[\\s/>]|$)(?:[^>{]|\\{[^}]*\\})*?(/?)>`, 'g');
      const close = new RegExp(`</${escapeRegExp(name)}\\s*>`, 'g');
      // The block ends on the line that closes the element it opens; an element left open ends at the first blank line instead.
      const isVoid = ['img', 'br', 'hr', 'source'].includes(name.toLowerCase());
      let depth = 0;
      let closed = false;
      for (let line = startLine; line < endLine && !closed; line += 1) {
        const text = lineText(line);
        for (const match of text.matchAll(open)) if (!match[1] && !isVoid) depth += 1;
        depth -= [...text.matchAll(close)].length;
        last = line;
        closed = depth <= 0;
      }
      if (!closed) {
        last = startLine;
        while (last + 1 < endLine && !state.isEmpty(last + 1)) last += 1;
      }
    }
    if (silent) return true;
    const raw = state.getLines(startLine, last + 1, state.blkIndent, false).trim();
    const token = state.push('sterling_html', '', 0);
    token.block = true;
    token.map = [startLine, last + 1];
    if (name) {
      token.content = raw;
      token.meta = { name };
    }
    state.line = last + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote'] });

  // Inline HTML: <img> becomes a bundled image or a note, <br> a line break, <a> a link the view checks, and formatting tags our own
  // tags without attributes; other inline tags just go. Any other name (a placeholder like <team> in prose) stays escaped text.
  md.inline.ruler.before('html_inline', 'sterling_inline_markup', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x3c) return false;
    const match = state.src.slice(state.pos).match(/^<(\/?)([A-Za-z][\w-]*)(?=[\s/>])(?:[^>{]|\{[^}]*\})*?\/?>/);
    const tag = match?.[2].toLowerCase();
    if (!match || !INLINE_TAGS.has(tag)) return false;
    if (!silent) {
      const closing = match[1] === '/';
      const attributes = tagAttributes(match[0]);
      let html = '';
      if (tag === 'br') html = '<br>\n';
      else if (tag === 'img') html = closing ? '' : imageHtml(attributes.src, attributes.alt ?? '', attributes.title, state.env.source);
      else if (tag === 'a') html = closing ? '</a>' : /^\s*(javascript|data|vbscript):/i.test(attributes.href ?? '') || !attributes.href ? '<a>' : `<a href="${escapeHtml(attributes.href)}">`;
      else if (FORMAT_TAGS.has(tag)) html = `<${closing ? '/' : ''}${FORMAT_TAGS.get(tag)}>`;
      state.push('sterling_html', '', 0).content = html;
    }
    state.pos += match[0].length;
    return true;
  });

  return {
    assets,
    /** The HTML and search text of one guide. `source` is its repository path; front matter is removed here. */
    render(source, input, title) {
      const markdown = input.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
      const html = md.render(markdown, { source, title, mdx: source.endsWith('.mdx'), headingIds: new Set() });
      return { html, text: textOf(html) };
    },
  };
}

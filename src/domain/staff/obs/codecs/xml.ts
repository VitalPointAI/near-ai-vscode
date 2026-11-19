// A strict, small XML reader for the feed importers (research note 11, 9.2 item 3 and section 10; WP-IMP): CoT, KML, RSS 2.0 and Atom. Pure: no I/O,
// no clock, no vscode. It runs inside the importer's own process (src/staff/feedImport/worker.ts), never in the extension host.
//
// Why our own reader and no dependency: XML entity expansion attacks hit popular JavaScript parsers as recently as 2026 (fast-xml-parser CVE-2026-26278
// and CVE-2026-33349, both "limits bypassed"; sax CVE-2026-29074, Billion Laughs; note 11 [F53]). The feeds we read need none of what those attacks use,
// so the reader simply has none of it:
// - a document type declaration (`<!DOCTYPE`) is refused outright, so no entity can ever be declared, internal or external;
// - only the five predefined entities and numeric character references are read; any other `&name;` is refused, never looked up;
// - nothing is fetched: there is no external entity, schema or stylesheet resolution of any kind;
// - every size is capped: input bytes, nesting depth, elements, attributes per element, attribute and text length. Past a cap the read stops with a
//   refusal; it never truncates silently.
// Namespaces are not resolved: a prefixed name keeps its prefix (`gx:Track`), and localName() strips it, which is all the feed formats need.

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  /** The element's own text (character data and CDATA), concatenated, entities decoded. */
  text: string;
}

export interface XmlLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxElements: number;
  readonly maxAttributes: number;
  readonly maxAttributeLength: number;
  readonly maxTextLength: number;
}

export const XML_LIMITS: XmlLimits = {
  maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxElements: 200_000, maxAttributes: 64, maxAttributeLength: 64 * 1024, maxTextLength: 1024 * 1024
};

/** The closed list of reasons an XML document is refused. */
export const XML_FAILURES = {
  doctype: 'The file declares a document type (DOCTYPE). Feed files never need one, and it is how entity expansion attacks start, so it is refused.',
  entity: 'The file uses an entity other than the five XML defines (&amp; &lt; &gt; &quot; &apos;) or a character reference. It is refused, never looked up.',
  'too-large': 'The file is larger than the importer reads.',
  'too-deep': 'The file nests elements deeper than the importer reads.',
  'too-many': 'The file has more elements, or an element more attributes, than the importer reads.',
  'too-long': 'A text or attribute value is longer than the importer reads.',
  malformed: 'The file is not well-formed XML.'
} as const;
export type XmlFailure = keyof typeof XML_FAILURES;

export type XmlRead = { readonly ok: true; readonly root: XmlElement } | { readonly ok: false; readonly reason: XmlFailure; readonly at: number };

class XmlRefused extends Error {
  constructor(readonly reason: XmlFailure, readonly at: number) { super(XML_FAILURES[reason]); }
}

const NAME_START = /[A-Za-z_:À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_:.·À-￿-]/;
const PREDEFINED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

/** Decodes the five predefined entities and character references; anything else is refused. */
function decode(raw: string, at: number): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let index = 0;
  while (index < raw.length) {
    const amp = raw.indexOf('&', index);
    if (amp < 0) { out += raw.slice(index); break; }
    out += raw.slice(index, amp);
    const semi = raw.indexOf(';', amp);
    if (semi < 0 || semi - amp > 12) throw new XmlRefused('entity', at + amp);
    const body = raw.slice(amp + 1, semi);
    let char: string | undefined;
    if (/^#x[0-9A-Fa-f]{1,6}$/.test(body)) char = codePoint(parseInt(body.slice(2), 16));
    else if (/^#[0-9]{1,7}$/.test(body)) char = codePoint(Number(body.slice(1)));
    else if (Object.prototype.hasOwnProperty.call(PREDEFINED, body)) char = PREDEFINED[body];
    if (char === undefined) throw new XmlRefused('entity', at + amp);
    out += char;
    index = semi + 1;
  }
  return out;
}

/** A character reference XML 1.0 allows (tab, newline, carriage return and the legal ranges), or undefined. */
function codePoint(value: number): string | undefined {
  const legal = value === 0x9 || value === 0xa || value === 0xd || (value >= 0x20 && value <= 0xd7ff) || (value >= 0xe000 && value <= 0xfffd) || (value >= 0x10000 && value <= 0x10ffff);
  return legal ? String.fromCodePoint(value) : undefined;
}

/**
 * Reads one XML document. With `fragments`, the input may hold several top-level elements, each optionally after its own XML declaration (a CoT log
 * of one event per line); they become the children of a synthetic `#fragments` root.
 */
export function readXml(source: string, options: { readonly fragments?: boolean; readonly limits?: Partial<XmlLimits> } = {}): XmlRead {
  const limits: XmlLimits = { ...XML_LIMITS, ...(options.limits ?? {}) };
  try {
    return { ok: true, root: parse(source, limits, options.fragments === true) };
  } catch (error) {
    if (error instanceof XmlRefused) return { ok: false, reason: error.reason, at: error.at };
    throw error;
  }
}

function parse(source: string, limits: XmlLimits, fragments: boolean): XmlElement {
  if (source.length > limits.maxBytes) throw new XmlRefused('too-large', 0);
  // A document type declaration anywhere is refused before anything else is read, even inside what looks like text.
  const doctype = source.search(/<!DOCTYPE/i);
  if (doctype >= 0) throw new XmlRefused('doctype', doctype);
  const holder: XmlElement = { name: '#fragments', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [];
  let elements = 0;
  let at = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let roots = 0;
  const top = (): XmlElement | undefined => stack[stack.length - 1];
  const addText = (text: string, where: number): void => {
    const parent = top();
    if (!parent) { if (text.trim() !== '') throw new XmlRefused('malformed', where); return; }
    if (parent.text.length + text.length > limits.maxTextLength) throw new XmlRefused('too-long', where);
    parent.text += text;
  };
  while (at < source.length) {
    const lt = source.indexOf('<', at);
    if (lt < 0) { addText(decode(source.slice(at), at), at); break; }
    if (lt > at) addText(decode(source.slice(at, lt), at), at);
    at = lt;
    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at + 4);
      if (end < 0) throw new XmlRefused('malformed', at);
      at = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', at)) {
      const end = source.indexOf(']]>', at + 9);
      if (end < 0 || stack.length === 0) throw new XmlRefused('malformed', at);
      addText(source.slice(at + 9, end), at);
      at = end + 3;
      continue;
    }
    if (source.startsWith('<?', at)) {
      // The XML declaration and processing instructions carry no content the feeds use; they are skipped, never acted on.
      const end = source.indexOf('?>', at + 2);
      if (end < 0) throw new XmlRefused('malformed', at);
      at = end + 2;
      continue;
    }
    if (source.startsWith('<!', at)) throw new XmlRefused(/^<!ENTITY/i.test(source.slice(at, at + 8)) ? 'doctype' : 'malformed', at);
    if (source[at + 1] === '/') {
      const end = source.indexOf('>', at);
      if (end < 0) throw new XmlRefused('malformed', at);
      const name = source.slice(at + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new XmlRefused('malformed', at);
      at = end + 1;
      continue;
    }
    // A start tag.
    let cursor = at + 1;
    if (!NAME_START.test(source[cursor] ?? '')) throw new XmlRefused('malformed', at);
    while (cursor < source.length && NAME_CHAR.test(source[cursor])) cursor += 1;
    const name = source.slice(at + 1, cursor);
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    let count = 0;
    let selfClosing = false;
    for (;;) {
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      const char = source[cursor];
      if (char === undefined) throw new XmlRefused('malformed', at);
      if (char === '>') { cursor += 1; break; }
      if (char === '/' && source[cursor + 1] === '>') { cursor += 2; selfClosing = true; break; }
      const nameAt = cursor;
      if (!NAME_START.test(char)) throw new XmlRefused('malformed', cursor);
      while (cursor < source.length && NAME_CHAR.test(source[cursor])) cursor += 1;
      const attrName = source.slice(nameAt, cursor);
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] !== '=') throw new XmlRefused('malformed', cursor);
      cursor += 1;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      const quote = source[cursor];
      if (quote !== '"' && quote !== '\'') throw new XmlRefused('malformed', cursor);
      const close = source.indexOf(quote, cursor + 1);
      if (close < 0) throw new XmlRefused('malformed', cursor);
      const raw = source.slice(cursor + 1, close);
      if (raw.includes('<')) throw new XmlRefused('malformed', cursor);
      if (raw.length > limits.maxAttributeLength) throw new XmlRefused('too-long', cursor);
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) throw new XmlRefused('malformed', nameAt);
      count += 1;
      if (count > limits.maxAttributes) throw new XmlRefused('too-many', nameAt);
      attrs[attrName] = decode(raw, cursor + 1);
      cursor = close + 1;
      if (!/[\s/>]/.test(source[cursor] ?? '')) throw new XmlRefused('malformed', cursor);
    }
    elements += 1;
    if (elements > limits.maxElements) throw new XmlRefused('too-many', at);
    const element: XmlElement = { name, attrs, children: [], text: '' };
    const parent = top();
    if (parent) parent.children.push(element);
    else {
      roots += 1;
      if (roots > 1 && !fragments) throw new XmlRefused('malformed', at);
      holder.children.push(element);
    }
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > limits.maxDepth) throw new XmlRefused('too-deep', at);
    }
    at = cursor;
  }
  if (stack.length > 0 || holder.children.length === 0) throw new XmlRefused('malformed', source.length);
  return fragments ? holder : holder.children[0];
}

/** A name without its namespace prefix (`kml:Placemark` is `Placemark`). */
export function localName(name: string): string {
  const colon = name.lastIndexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** The first child with this local name. */
export function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((entry) => localName(entry.name) === name);
}

/** Every child with this local name. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((entry) => localName(entry.name) === name);
}

/** The trimmed text of the first child with this local name, or undefined when it is absent or blank. */
export function childText(element: XmlElement, name: string): string | undefined {
  const text = child(element, name)?.text.trim();
  return text ? text : undefined;
}

/** Every descendant with this local name, depth first, in document order. The tree is depth-capped, so the walk is bounded. */
export function descendants(element: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const entry of element.children) {
    if (localName(entry.name) === name) out.push(entry);
    descendants(entry, name, out);
  }
  return out;
}

/** An attribute by name, or undefined. */
export function attr(element: XmlElement, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(element.attrs, name) ? element.attrs[name] : undefined;
}

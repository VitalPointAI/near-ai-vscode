import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { newCatalog, newControl, newGroup, statementPart } from './lib/oscalBuild.ts';
import { createFetcher, type Fetcher } from './lib/fetch.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type GeneratedCatalog = { catalog: { metadata: Record<string, unknown>; groups: Array<{ id: string; title: string; controls: unknown[] }> } };

const DPA_37_URL = 'https://laws-lois.justice.gc.ca/eng/acts/D-1/section-37.html';
const CGR_URL = 'https://laws-lois.justice.gc.ca/eng/regulations/SOR-2001-32/FullText.html';
const ACCURATE_REPRODUCTION_NOTICE = 'Accurate reproduction, not the official version.';
const RETRIEVED_AT = '2026-11-21T00:00:00Z';

export const CGP_REQUIREMENTS = [
  { id: 'cgp-37-1', instrument: 'defence-production-act', section: '37', paragraph: '1', url: DPA_37_URL },
  { id: 'cgp-37-2', instrument: 'defence-production-act', section: '37', paragraph: '2', url: DPA_37_URL },
  { id: 'cgp-9', instrument: 'controlled-goods-regulations', section: '9', paragraph: undefined, url: CGR_URL },
  { id: 'cgp-10-a', instrument: 'controlled-goods-regulations', section: '10', paragraph: 'a', url: CGR_URL },
  { id: 'cgp-10-b', instrument: 'controlled-goods-regulations', section: '10', paragraph: 'b', url: CGR_URL },
  { id: 'cgp-10-c', instrument: 'controlled-goods-regulations', section: '10', paragraph: 'c', url: CGR_URL },
  { id: 'cgp-10-e', instrument: 'controlled-goods-regulations', section: '10', paragraph: 'e', url: CGR_URL },
  { id: 'cgp-10-f', instrument: 'controlled-goods-regulations', section: '10', paragraph: 'f', url: CGR_URL },
  { id: 'cgp-10-g', instrument: 'controlled-goods-regulations', section: '10', paragraph: 'g', url: CGR_URL },
  { id: 'cgp-10-h', instrument: 'controlled-goods-regulations', section: '10', paragraph: 'h', url: CGR_URL },
  { id: 'cgp-10-i', instrument: 'controlled-goods-regulations', section: '10', paragraph: 'i', url: CGR_URL },
  { id: 'cgp-10-j', instrument: 'controlled-goods-regulations', section: '10', paragraph: 'j', url: CGR_URL },
  ...['11', '12', '13', '14', '15', '16', '17', '18', '19', '23'].map((section) => ({ id: `cgp-${section}`, instrument: 'controlled-goods-regulations', section, paragraph: undefined, url: CGR_URL }))
] as const;

const isElement = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => ('childNodes' in node ? node.childNodes : []);
const textOf = (node: Node): string => ('value' in node ? node.value : children(node).map(textOf).join('')).replace(/\s+/g, ' ').trim();
const attribute = (element: Element, name: string): string | undefined => element.attrs.find((item) => item.name === name)?.value;

function elementById(node: Node, id: string): Element | undefined {
  const pending = [node];
  while (pending.length > 0) {
    const candidate = pending.shift()!;
    if (isElement(candidate) && attribute(candidate, 'id') === id) return candidate;
    pending.push(...children(candidate));
  }
  return undefined;
}

function elements(node: Node): Element[] {
  const found: Element[] = [];
  const pending = [node];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (isElement(candidate)) found.push(candidate);
    pending.push(...[...children(candidate)].reverse());
  }
  return found;
}

function hasClass(element: Element, name: string): boolean {
  return (attribute(element, 'class') ?? '').split(/\s+/).includes(name);
}

function marker(element: Element): string | undefined {
  const label = elements(element).find((candidate) => hasClass(candidate, 'lawlabel'));
  return label && textOf(label);
}

/**
 * Justice Laws' current pages put the section anchor and legal number markers
 * inside semantic paragraph elements. Walk document-order paragraph elements
 * from the named section anchor, then select by the `lawlabel` number rather
 * than by a character offset or position in a list.
 */
function currentPageParagraph(document: Node, section: string, paragraph: string | undefined): string | undefined {
  let inSection = false;
  for (const candidate of elements(document)) {
    if (candidate.tagName !== 'p') continue;
    const sectionLabel = elements(candidate).find((child) => attribute(child, 'id')?.startsWith('s-'));
    if (sectionLabel) inSection = attribute(sectionLabel, 'id') === `s-${section}`;
    if (!inSection) continue;
    const paragraphMarker = marker(candidate);
    if (paragraph === undefined || paragraphMarker === `(${paragraph})`) return textOf(candidate);
  }
  return undefined;
}

function paragraphText(section: Element, paragraph: string | undefined): string | undefined {
  const pending = [...children(section)];
  while (pending.length > 0) {
    const candidate = pending.shift()!;
    if (isElement(candidate) && candidate.tagName === 'p') {
      const value = textOf(candidate);
      if (paragraph === undefined || new RegExp(`^\\(${paragraph}\\)`).test(value)) return value;
    }
    pending.push(...children(candidate));
  }
  return undefined;
}

function requirementText(document: Node, section: string, paragraph: string | undefined): string | undefined {
  return currentPageParagraph(document, section, paragraph) ??
    paragraphText(elementById(document, `s-${section}`) ?? ({ childNodes: [] } as unknown as Element), paragraph);
}

async function requiredPage(context: { readonly offlinePages?: Readonly<Record<string, string>>; readonly fetcher?: Fetcher }, url: string): Promise<string> {
  const page = context.offlinePages?.[url];
  if (page) return page;
  return (await (context.fetcher ?? createFetcher({ fetchImpl: globalThis.fetch as any })).get(url, { accept: 'text/html' })).body.toString('utf8');
}

/** Imports the controlled-goods Act requirements from numbered paragraphs, never character offsets. */
export async function importSource(context: { readonly offlinePages?: Readonly<Record<string, string>>; readonly fetcher?: Fetcher } = {}) {
  const documents = new Map<string, Node>();
  for (const url of new Set(CGP_REQUIREMENTS.map((requirement) => requirement.url))) documents.set(url, parse(await requiredPage(context, url)));
  const catalog = newCatalog({
    sourceId: 'defence-production-act',
    title: 'Controlled Goods Program requirements',
    version: '0.1.0',
    retrievedAt: RETRIEVED_AT
  }) as unknown as GeneratedCatalog;
  catalog.catalog.metadata.remarks = ACCURATE_REPRODUCTION_NOTICE;
  const dpa = newGroup('dpa', 'Defence Production Act Part 2');
  const cgr = newGroup('cgr', 'Controlled Goods Regulations');
  for (const requirement of CGP_REQUIREMENTS) {
    const document = documents.get(requirement.url)!;
    const prose = requirementText(document, requirement.section, requirement.paragraph);
    if (!prose) throw new Error(`missing required paragraph ${requirement.section}(${requirement.paragraph}) for ${requirement.id}`);
    const control = {
      ...newControl({ id: requirement.id, title: requirement.id.toUpperCase(), label: requirement.id.toUpperCase() }),
      links: [{ href: requirement.url, rel: 'reference' }],
      parts: [statementPart(requirement.id, [prose])]
    };
    (requirement.instrument === 'defence-production-act' ? dpa : cgr).controls.push(control);
  }
  catalog.catalog.groups.push(dpa);
  catalog.catalog.groups.push(cgr);
  return {
    sourceId: 'defence-production-act', file: 'catalogs/cgp/catalog.json', catalog,
    reportFile: 'import-reports/cgp.json',
    report: { sourceIds: ['defence-production-act', 'controlled-goods-regulations'], excluded: [{ id: 'cgp-37-3', reason: 'definition' }] }
  };
}

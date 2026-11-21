import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { newCatalog, newControl, newGroup, statementPart } from './lib/oscalBuild.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type GeneratedCatalog = { catalog: { metadata: Record<string, unknown>; groups: Array<{ id: string; title: string; controls: unknown[] }> } };

const DPA_37_URL = 'https://laws-lois.justice.gc.ca/eng/acts/D-1.5/page-3.html#h-419174';
const CGR_URL = 'https://laws-lois.justice.gc.ca/eng/regulations/SOR-2001-32/page-1.html';
const ACCURATE_REPRODUCTION_NOTICE = 'Accurate reproduction, not the official version.';

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

function requiredPage(context: { readonly offlinePages?: Readonly<Record<string, string>> }, url: string): string {
  const page = context.offlinePages?.[url];
  if (!page) throw new Error(`missing source page ${url}`);
  return page;
}

/** Imports the controlled-goods Act requirements from numbered paragraphs, never character offsets. */
export async function importSource(context: { readonly offlinePages?: Readonly<Record<string, string>> } = {}) {
  const documents = new Map<string, Node>();
  for (const url of new Set(CGP_REQUIREMENTS.map((requirement) => requirement.url))) documents.set(url, parse(requiredPage(context, url)));
  const catalog = newCatalog({
    sourceId: 'defence-production-act',
    title: 'Controlled Goods Program requirements',
    version: '0.1.0',
    retrievedAt: new Date().toISOString()
  }) as unknown as GeneratedCatalog;
  catalog.catalog.metadata.remarks = ACCURATE_REPRODUCTION_NOTICE;
  const dpa = newGroup('dpa', 'Defence Production Act Part 2');
  const cgr = newGroup('cgr', 'Controlled Goods Regulations');
  for (const requirement of CGP_REQUIREMENTS) {
    const section = elementById(documents.get(requirement.url)!, `s-${requirement.section}`);
    if (!section) throw new Error(`missing required section ${requirement.section} for ${requirement.id}`);
    const prose = paragraphText(section, requirement.paragraph);
    if (!prose) throw new Error(`missing required paragraph ${requirement.section}(${requirement.paragraph}) for ${requirement.id}`);
    const control = {
      ...newControl({ id: requirement.id, title: requirement.id.toUpperCase(), label: requirement.id.toUpperCase() }),
      links: [{ href: requirement.url, rel: 'reference' }],
      parts: [statementPart([prose])]
    };
    (requirement.instrument === 'defence-production-act' ? dpa : cgr).controls.push(control);
  }
  catalog.catalog.groups.push(dpa);
  catalog.catalog.groups.push(cgr);
  return { sourceId: 'defence-production-act', file: 'catalogs/cgp/catalog.json', catalog };
}

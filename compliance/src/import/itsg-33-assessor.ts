import { createHash } from 'node:crypto';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { NS } from '../model.ts';
import { stableOscalUuid } from '../oscalSsp.ts';
import { annexControlHeading, ITSG33_ANNEX_3A_URL } from './itsg-33.ts';
import { mainOf, parseHtml } from './lib/cyberHtml.ts';
import { newCatalog, statementPart } from './lib/oscalBuild.ts';
import { SOURCE_REGISTRY } from './lib/sourceRegistry.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
const isElement = (node: Node): node is Element => 'tagName' in node;
const elements = (node: Node): Element[] => 'childNodes' in node ? node.childNodes.filter(isElement) : [];
const attr = (element: Element, name: string) => element.attrs.find((item) => item.name === name)?.value;
const inline = (node: Node): string => 'value' in node ? node.value :
  'childNodes' in node ? node.childNodes.filter((child) => !isElement(child) || child.tagName !== 'ol').map(inline).join('') : '';
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const visibleText = (node: Node) => normalize(inline(node));

const CONTROL_LABEL = /^Control\s*:\s*/;
const WITHDRAWAL_NOTICE = /^\[Withdrawn(?::|\])/;
const NON_ALLOCATION_NOTICE = /^\[Not allocated in GC profiles\./;
const NEXT_SECTION = /^(?:Supplemental Guidance|Control Enhancements|References)\s*:/;

function listLines(list: Element, depth = 0): string[] {
  const style = attr(list, 'style') ?? '';
  if (!/^list-style-type:\s*(?:upper|lower)-alpha;?$/.test(style)) {
    throw new Error(`Unexpected Annex 3A list style: ${style}`);
  }
  const first = style.includes('upper-alpha') ? 'A'.charCodeAt(0) : 'a'.charCodeAt(0);
  let number = 0;
  return elements(list).flatMap((item) => {
    if (item.tagName !== 'li') throw new Error(`Unexpected Annex 3A list element: ${item.tagName}`);
    number = Number(attr(item, 'value') ?? number + 1);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid Annex 3A list item number');
    let label = '';
    for (let remaining = number; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
      label = String.fromCharCode(first + (remaining - 1) % 26) + label;
    }
    const nested = elements(item).filter((child) => child.tagName === 'ol');
    return [`${'  '.repeat(depth)}${label}. ${visibleText(item)}`, ...nested.flatMap((child) => listLines(child, depth + 1))];
  });
}

function readStatement(heading: Element, id: string) {
  const siblings = elements(heading.parentNode ?? heading);
  const value: string[] = [];
  for (const block of siblings.slice(siblings.indexOf(heading) + 1)) {
    if (/^h[1-4]$/.test(block.tagName) || (block.tagName === 'p' && NEXT_SECTION.test(visibleText(block)))) break;
    if (block.tagName === 'p') value.push(visibleText(block));
    else if (block.tagName === 'ol') value.push(listLines(block).join('\n'));
    else throw new Error(`Unexpected Annex 3A statement element for ${id}: ${block.tagName}`);
  }
  const lead = value[0] ?? '';
  const withdrawn = WITHDRAWAL_NOTICE.test(lead);
  if (withdrawn || NON_ALLOCATION_NOTICE.test(lead)) {
    if (value.length !== 1) throw new Error(`Unexpected continuation after Annex 3A notice for ${id}`);
    return { withdrawn, prose: value };
  }
  value[0] = lead.replace(CONTROL_LABEL, '');
  const prose = value.filter(Boolean);
  if (!CONTROL_LABEL.test(lead) || !prose.length) throw new Error(`Missing Annex 3A statement for ${id}`);
  return { withdrawn, prose };
}

/** Builds the assessor-only OSCAL catalogue from official Annex HTML and the pinned base-control index. */
export function buildItsg33AssessorCatalogue(html: Buffer, baseIds: readonly string[], retrievedAt: string) {
  const source = SOURCE_REGISTRY.find((entry) => entry.id === 'itsg-33');
  if (!source || source.use !== 'text' || source.licence !== 'ca-ogl-lgo' || source.licenceEvidence.kind !== 'ckan') {
    throw new Error('ITSG-33 Annex 3A requires the approved Open Government Licence evidence');
  }
  const controls = new Map<string, ReturnType<typeof readStatement> & { title: string }>();
  const visit = (element: Element) => {
    const heading = element.tagName === 'h4' ? annexControlHeading(visibleText(element)) : undefined;
    if (heading && !heading.id.includes('.')) {
      const { id, title } = heading;
      if (controls.has(id)) throw new Error(`Duplicate Annex 3A control: ${id}`);
      controls.set(id, { title, ...readStatement(element, id) });
    }
    elements(element).forEach(visit);
  };
  visit(mainOf(parseHtml(html.toString('utf8'))));
  const expected = new Set(baseIds);
  const missing = [...expected].filter((id) => !controls.has(id));
  const extra = [...controls.keys()].filter((id) => !expected.has(id));
  if (!expected.size || expected.size !== baseIds.length || missing.length || extra.length) {
    throw new Error(`Annex 3A base-control mismatch (missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'})`);
  }
  const { catalog: { metadata } } = newCatalog({ sourceId: source.id, title: 'ITSG-33 Annex 3A', version: '1.0', retrievedAt });
  metadata.props.push(
    { name: 'source-licence', ns: NS, value: source.licence },
    { name: 'source-sha256', ns: NS, value: createHash('sha256').update(html).digest('hex') },
    { name: 'ckan-record', ns: NS, value: source.licenceEvidence.recordId },
  );
  return {
    catalog: {
      uuid: stableOscalUuid('catalog:itsg-33:assessor-annex-3a'),
      metadata: {
        ...metadata,
        links: [{ href: ITSG33_ANNEX_3A_URL, rel: 'source' }],
        remarks: 'Contains information licensed under the Open Government Licence - Canada. Unofficial representation, not reviewed or endorsed by the Cyber Centre.',
      },
      controls: baseIds.map((id) => {
        const { title, withdrawn, prose } = controls.get(id)!;
        return { id, title, ...(withdrawn ? { props: [{ name: 'status', value: 'withdrawn' }] } : {}), parts: [statementPart(id, prose)] };
      }),
    },
  };
}

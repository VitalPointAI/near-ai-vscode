import { mainOf, normalizeId, parseHtml } from './lib/cyberHtml.ts';
import { newCatalog } from './lib/oscalBuild.ts';
import { createFetcher, type Fetcher } from './lib/fetch.ts';

type PageSet = Readonly<Record<string, string>>;
type Element = { tagName?: string; attrs?: readonly { name: string; value: string }[]; childNodes?: readonly Element[]; parentNode?: Element; value?: string };
type Part = { id: string; name: string; prose: string };

const text = (node: Element): string => (node.value ?? (node.childNodes ?? []).map(text).join('')).replace(/\s+/g, ' ').trim();
const attr = (node: Element, name: string): string | undefined => node.attrs?.find((item) => item.name === name)?.value;
const children = (node: Element): readonly Element[] => (node.childNodes ?? []) as readonly Element[];
const descendants = (node: Element): readonly Element[] => [node, ...children(node).flatMap(descendants)];
const mainElements = (html: string): readonly Element[] => descendants(mainOf(parseHtml(html)) as unknown as Element);
const titleFor = (heading: string, id: string): string => heading.replace(/^\d{2}\.\d{2}\.\d{2}\s*/, '') || id;
const normalizedSourceIds = (value: string): Set<string> => new Set(
  [...value.matchAll(/\b[A-Z]{2}-\d+(?:\(\d+\))?(?![\w(])/g)].map(([id]) => normalizeId(id)),
);
const requirementId = (heading: Element): string | undefined => {
  if (heading.tagName !== 'h4') return undefined;
  const id = attr(heading, 'id');
  if (id && /^\d{2}-\d{2}-\d{2}$/.test(id)) return id.replaceAll('-', '.');
  return /^(\d{2}\.\d{2}\.\d{2})\b/.exec(text(heading))?.[1];
};
const isNotAllocated = (heading: Element, id: string): boolean => titleFor(text(heading), id).toLowerCase() === 'not allocated';
const rawText = (node: Element): string => node.value ?? children(node).map(rawText).join('');

/** Active requirements use accordions, while withdrawal notices use bare headings. */
function sectionContent(heading: Element): readonly Element[] {
  const parent = heading.parentNode;
  if (!parent) return [];
  const details = parent.tagName === 'summary' && parent.parentNode?.tagName === 'details' ? parent.parentNode : undefined;
  const container = details ? parent : heading;
  const siblings = children(details ?? parent);
  const start = siblings.indexOf(container);
  const result: Element[] = [];
  for (const sibling of siblings.slice(start + 1)) {
    if (sibling.tagName === 'h4' || descendants(sibling).some(requirementId)) break;
    result.push(sibling);
  }
  return result;
}

export interface Itsp171Result {
  readonly catalog: any;
  readonly unmatchedAssessmentIds: readonly string[];
  readonly requirementsWithoutSourceControls: number;
  readonly mapping: any;
  readonly report: { readonly unmatchedAssessmentIds: readonly string[]; readonly requirementsWithoutSourceControls: number };
}

/** Parses locally supplied pages; callers fetch them through the guarded import command. */
export function parseItsp171(pages: PageSet): Itsp171Result {
  const requirementNodes = mainElements(pages.requirements ?? '');
  const assessmentNodes = mainElements(pages.assessment ?? '');
  const assessment = new Map<string, string>();
  for (const heading of assessmentNodes) {
    const id = requirementId(heading);
    // A withdrawal notice carries no assessment determination.
    if (!id || isNotAllocated(heading, id)) continue;
    const value = sectionContent(heading).map(text).filter(Boolean);
    assessment.set(id, value.join(' '));
  }

  const catalog = newCatalog({ sourceId: 'itsp-10-171', title: 'ITSP.10.171', version: '1.0', retrievedAt: '2026-11-21T00:00:00Z' }) as any;
  const groups = new Map<string, any>();
  const seen = new Set<string>();
  let requirementsWithoutSourceControls = 0;
  const mappingRows: any[] = [];
  for (const heading of requirementNodes) {
    const label = requirementId(heading);
    if (!label) continue;
    const id = `itsp171-${label}`; const groupId = `g-${label.slice(0, 5).replace('.', '-')}`;
    const notAllocated = isNotAllocated(heading, label);
    const body: string[] = []; let guidance = ''; let section = 'statement'; let references = '';
    for (const node of sectionContent(heading)) {
      const value = notAllocated ? rawText(node).replace(/\s+/g, ' ').trim() : text(node);
      const headingText = value.toLowerCase();
      if (node.tagName === 'h5') { section = headingText.startsWith('discussion') ? 'guidance' : headingText.startsWith('references') ? 'references' : 'other'; continue; }
      if (!value) continue;
      if (section === 'statement') body.push(value); else if (section === 'guidance') guidance += `${guidance ? ' ' : ''}${value}`; else if (section === 'references') references += `${references ? ' ' : ''}${value}`;
    }
    const parts: Part[] = [{ id: `${id}_smt`, name: 'statement', prose: body.join(' ') }];
    if (guidance) parts.push({ id: `${id}_guidance`, name: 'guidance', prose: guidance });
    const determination = assessment.get(label);
    if (determination) { parts.push({ id: `${id}_assessment`, name: 'assessment-objective', prose: determination }); seen.add(label); }
    const group = groups.get(groupId) ?? { id: groupId, title: `ITSP.10.171 ${groupId}`, controls: [] }; groups.set(groupId, group);
    group.controls.push({ id, title: titleFor(text(heading), id), props: [{ name: 'label', value: label }], parts });
    const targets = normalizedSourceIds(references);
    if (targets.size === 0) requirementsWithoutSourceControls += 1;
    for (const targetId of targets) mappingRows.push({ 'source-uuid': id, 'target-uuid': targetId, props: [{ name: 'ours', ns: 'urn:near-ai-vscode:compliance', value: 'true' }] });
  }
  catalog.catalog.groups = [...groups.values()];
  if (catalog.catalog.groups.length === 0) throw new Error('ITSP.10.171 requirements page has no parseable requirement headings');
  const unmatchedAssessmentIds = [...assessment.keys()].filter((id) => !seen.has(id)).sort();
  const mapping = {
    'mapping-collection': {
      uuid: '00000000-0000-4000-8000-000000000002',
      metadata: {
        title: 'ITSP.10.171 to ITSP.10.033 mapping',
        version: '1.0',
        'last-modified': '2026-11-21T00:00:00Z',
        'oscal-version': '1.2.1',
      },
      provenance: {
        method: 'automation',
        'matching-rationale': 'syntactic',
        status: 'draft',
        'mapping-description': 'Identifier references parsed from the published ITSP.10.171 requirements.',
      },
      mappings: {
        uuid: '00000000-0000-4000-8000-000000000171',
        'source-resource': { type: 'catalog', href: '../catalogs/itsp-10-171/catalog.json' },
        'target-resource': { type: 'catalog', href: '../catalogs/itsp-10-033/catalog.json' },
        maps: mappingRows.map((row, index) => ({
          uuid: `00000000-0000-4000-8000-${(1000 + index).toString(16).padStart(12, '0')}`,
          relationship: 'intersects-with',
          sources: [{ type: 'control', 'id-ref': row['source-uuid'] }],
          targets: [{ type: 'control', 'id-ref': row['target-uuid'] }],
          props: row.props,
        })),
      },
    },
  };
  return {
    catalog, unmatchedAssessmentIds, requirementsWithoutSourceControls, mapping,
    report: { unmatchedAssessmentIds, requirementsWithoutSourceControls },
  };
}

export async function importSource(context: { readonly offlinePages?: PageSet; readonly fetcher?: Fetcher }): Promise<{ sourceId: string; catalog: unknown; file: string; reports: readonly { file: string; content: unknown }[] }> {
  const pages = context.offlinePages ?? await (async () => {
    const fetcher = context.fetcher ?? createFetcher({ fetchImpl: globalThis.fetch as any });
    const [requirements, assessment] = await Promise.all([
      fetcher.get('https://www.cyber.gc.ca/en/guidance/protecting-specified-information-non-government-canada-systems-and-organizations-itsp10171', { accept: 'text/html' }),
      fetcher.get('https://www.cyber.gc.ca/en/guidance/assessing-security-requirements-specified-information-itsp10171-01', { accept: 'text/html' })
    ]);
    return { requirements: requirements.body.toString('utf8'), assessment: assessment.body.toString('utf8') };
  })();
  const result = parseItsp171(pages);
  return { sourceId: 'itsp-10-171', catalog: result.catalog, file: 'catalogs/itsp-10-171/catalog.json', reports: [{ file: 'mappings/itsp10171-to-itsp10033.json', content: result.mapping }, { file: 'import-reports/itsp-10-171.json', content: result.report }] };
}

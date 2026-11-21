import { mainOf, parseHtml } from './lib/cyberHtml.ts';
import { newCatalog } from './lib/oscalBuild.ts';
import { createFetcher, type Fetcher } from './lib/fetch.ts';

type PageSet = Readonly<Record<string, string>>;
type Element = { tagName?: string; attrs?: readonly { name: string; value: string }[]; childNodes?: readonly Element[]; value?: string };
type Part = { id: string; name: string; prose: string };

const text = (node: Element): string => (node.value ?? (node.childNodes ?? []).map(text).join('')).replace(/\s+/g, ' ').trim();
const attr = (node: Element, name: string): string | undefined => node.attrs?.find((item) => item.name === name)?.value;
const children = (node: Element): readonly Element[] => (node.childNodes ?? []) as readonly Element[];
const descendants = (node: Element): readonly Element[] => [node, ...children(node).flatMap(descendants)];
const mainElements = (html: string): readonly Element[] => descendants(mainOf(parseHtml(html)) as unknown as Element);
const titleFor = (heading: string, id: string): string => heading.replace(/^\d{2}\.\d{2}\.\d{2}\s*/, '') || id;
const normalizedSourceIds = (value: string): string[] => [...value.matchAll(/\b([A-Z]{2})-(\d+)(?:\((\d+)\))?\b/g)].map((match) => `${match[1].toLowerCase()}-${match[2].padStart(2, '0')}${match[3] ? `.${match[3].padStart(2, '0')}` : ''}`);
const requirementId = (heading: Element): string | undefined => {
  const id = attr(heading, 'id');
  if (id && /^\d{2}-\d{2}-\d{2}$/.test(id)) return id.replaceAll('-', '.');
  return /^(\d{2}\.\d{2}\.\d{2})\b/.exec(text(heading))?.[1];
};

/** Current Cyber Centre pages put each h4 inside summary/details rather than directly under main. */
function sectionContent(heading: Element): readonly Element[] {
  const summary = (heading as any).parentNode as Element | undefined;
  const detail = summary && (summary as any).parentNode as Element | undefined;
  if (summary?.tagName === 'summary' && detail?.tagName === 'details') return children(detail).filter((node) => node !== summary);
  const siblings = summary ? children(summary) : [];
  const start = siblings.indexOf(heading);
  const result: Element[] = [];
  for (let index = start + 1; index < siblings.length && siblings[index].tagName !== 'h4'; index += 1) result.push(siblings[index]);
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
    const id = heading.tagName === 'h4' ? requirementId(heading) : undefined;
    if (!id) continue;
    const value = sectionContent(heading).map(text).filter(Boolean);
    assessment.set(id, value.join(' '));
  }

  const catalog = newCatalog({ sourceId: 'itsp-10-171', title: 'ITSP.10.171', version: '1.0', retrievedAt: '2026-11-21T00:00:00Z' }) as any;
  const groups = new Map<string, any>();
  const seen = new Set<string>();
  let requirementsWithoutSourceControls = 0;
  const mappingRows: any[] = [];
  for (const heading of requirementNodes) {
    const label = heading.tagName === 'h4' ? requirementId(heading) : undefined;
    if (!label) continue;
    const id = `itsp171-${label}`; const groupId = `g-${label.slice(0, 5).replace('.', '-')}`;
    const body: string[] = []; let guidance = ''; let section = 'statement'; let references = '';
    for (const node of sectionContent(heading)) {
      const headingText = text(node).toLowerCase();
      if (node.tagName === 'h5') { section = headingText.startsWith('discussion') ? 'guidance' : headingText.startsWith('references') ? 'references' : 'other'; continue; }
      if (!text(node)) continue;
      if (section === 'statement') body.push(text(node)); else if (section === 'guidance') guidance += `${guidance ? ' ' : ''}${text(node)}`; else if (section === 'references') references += `${references ? ' ' : ''}${text(node)}`;
    }
    const parts: Part[] = [{ id: `${id}_smt`, name: 'statement', prose: body.join(' ') }];
    if (guidance) parts.push({ id: `${id}_guidance`, name: 'guidance', prose: guidance });
    const determination = assessment.get(label);
    if (determination) { parts.push({ id: `${id}_assessment`, name: 'assessment-objective', prose: determination }); seen.add(label); }
    const group = groups.get(groupId) ?? { id: groupId, title: `ITSP.10.171 ${groupId}`, controls: [] }; groups.set(groupId, group);
    group.controls.push({ id, title: titleFor(text(heading), id), props: [{ name: 'label', value: label }], parts });
    const targets = normalizedSourceIds(references);
    if (targets.length === 0) requirementsWithoutSourceControls += 1;
    for (const targetId of targets) mappingRows.push({ 'source-uuid': id, 'target-uuid': targetId, props: [{ name: 'ours', ns: 'urn:near-ai-vscode:compliance', value: 'true' }] });
  }
  catalog.catalog.groups = [...groups.values()];
  if (catalog.catalog.groups.length === 0) throw new Error('ITSP.10.171 requirements page has no parseable requirement headings');
  const unmatchedAssessmentIds = [...assessment.keys()].filter((id) => !seen.has(id)).sort();
  return {
    catalog, unmatchedAssessmentIds, requirementsWithoutSourceControls,
    mapping: { 'mapping-collection': { uuid: '00000000-0000-4000-8000-000000000002', metadata: { title: 'ITSP.10.171 to ITSP.10.033 mapping', version: '1.0', 'last-modified': '2026-11-21T00:00:00Z', 'oscal-version': '1.2.1' }, provenance: { method: 'automation', 'matching-rationale': 'syntactic', status: 'draft', 'mapping-description': 'Identifier references parsed from the published ITSP.10.171 requirements.' }, mappings: [{ uuid: '00000000-0000-4000-8000-000000000171', 'source-resource': { type: 'catalog', href: '../catalogs/itsp-10-171/catalog.json' }, 'target-resource': { type: 'catalog', href: '../catalogs/itsp-10-033/catalog.json' }, maps: mappingRows.map((row, index) => ({ uuid: `00000000-0000-4000-8000-${(1000 + index).toString(16).padStart(12, '0')}`, relationship: 'intersects-with', sources: [{ type: 'control', 'id-ref': row['source-uuid'] }], targets: [{ type: 'control', 'id-ref': row['target-uuid'] }], props: row.props })) }] } },
    report: { unmatchedAssessmentIds, requirementsWithoutSourceControls }
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

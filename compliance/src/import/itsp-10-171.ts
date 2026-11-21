import { mainOf, parseHtml } from './lib/cyberHtml.ts';
import { newCatalog } from './lib/oscalBuild.ts';

type PageSet = Readonly<Record<string, string>>;
type Element = { tagName?: string; attrs?: readonly { name: string; value: string }[]; childNodes?: readonly Element[]; value?: string };
type Part = { id: string; name: string; prose: string };

const text = (node: Element): string => (node.value ?? (node.childNodes ?? []).map(text).join('')).replace(/\s+/g, ' ').trim();
const attr = (node: Element, name: string): string | undefined => node.attrs?.find((item) => item.name === name)?.value;
const mainChildren = (html: string): readonly Element[] => ((mainOf(parseHtml(html)).childNodes ?? []) as unknown as readonly Element[]);
const titleFor = (heading: string, id: string): string => heading.replace(/^\d{2}\.\d{2}\.\d{2}\s*/, '') || id;
const normalizedSourceIds = (value: string): string[] => [...value.matchAll(/\b([A-Z]{2})-(\d+)(?:\((\d+)\))?\b/g)].map((match) => `${match[1].toLowerCase()}-${match[2].padStart(2, '0')}${match[3] ? `.${match[3].padStart(2, '0')}` : ''}`);

export interface Itsp171Result {
  readonly catalog: any;
  readonly unmatchedAssessmentIds: readonly string[];
  readonly requirementsWithoutSourceControls: number;
  readonly mapping: any;
  readonly report: { readonly unmatchedAssessmentIds: readonly string[]; readonly requirementsWithoutSourceControls: number };
}

/** Parses locally supplied pages; callers fetch them through the guarded import command. */
export function parseItsp171(pages: PageSet): Itsp171Result {
  const requirementNodes = mainChildren(pages.requirements ?? '');
  const assessmentNodes = mainChildren(pages.assessment ?? '');
  const assessment = new Map<string, string>();
  for (let index = 0; index < assessmentNodes.length; index += 1) {
    const heading = assessmentNodes[index];
    if (heading.tagName !== 'h4' || !/^\d{2}-\d{2}-\d{2}$/.test(attr(heading, 'id') ?? '')) continue;
    const value: string[] = [];
    for (let next = index + 1; next < assessmentNodes.length && assessmentNodes[next].tagName !== 'h4'; next += 1) {
      if (text(assessmentNodes[next])) value.push(text(assessmentNodes[next]));
    }
    assessment.set((attr(heading, 'id') ?? '').replaceAll('-', '.'), value.join(' '));
  }

  const catalog = newCatalog({ sourceId: 'itsp-10-171', title: 'ITSP.10.171', version: '1.0', retrievedAt: '2026-11-21T00:00:00Z' }) as any;
  const groups = new Map<string, any>();
  const seen = new Set<string>();
  let requirementsWithoutSourceControls = 0;
  const mappingRows: any[] = [];
  for (let index = 0; index < requirementNodes.length; index += 1) {
    const heading = requirementNodes[index];
    const sourceId = attr(heading, 'id');
    if (heading.tagName !== 'h4' || !sourceId || !/^\d{2}-\d{2}-\d{2}$/.test(sourceId)) continue;
    const label = sourceId.replaceAll('-', '.'); const id = `itsp171-${label}`; const groupId = `g-${sourceId.slice(0, 5)}`;
    const body: string[] = []; let guidance = ''; let section = 'statement'; let references = '';
    for (let next = index + 1; next < requirementNodes.length && requirementNodes[next].tagName !== 'h4'; next += 1) {
      const node = requirementNodes[next]; const headingText = text(node).toLowerCase();
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
  const unmatchedAssessmentIds = [...assessment.keys()].filter((id) => !seen.has(id)).sort();
  return {
    catalog, unmatchedAssessmentIds, requirementsWithoutSourceControls,
    mapping: { 'mapping-collection': { uuid: '00000000-0000-4000-8000-000000000002', metadata: { title: 'ITSP.10.171 to ITSP.10.033 mapping', version: '1.0', 'last-modified': '2026-11-21T00:00:00Z', 'oscal-version': '1.2.1' }, mappings: mappingRows } },
    report: { unmatchedAssessmentIds, requirementsWithoutSourceControls }
  };
}

export async function importSource(context: { readonly offlinePages?: PageSet }): Promise<{ sourceId: string; catalog: unknown; file: string }> {
  if (!context.offlinePages) throw new Error('ITSP.10.171 importer requires fetched or offline pages');
  const result = parseItsp171(context.offlinePages);
  return { sourceId: 'itsp-10-171', catalog: result.catalog, file: 'catalogs/itsp-10-171/catalog.json' };
}

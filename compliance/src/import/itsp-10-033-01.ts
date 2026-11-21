import { NS } from '../model.ts';
import { mainOf, normalizeId, parseHtml } from './lib/cyberHtml.ts';
import { newProfile } from './lib/oscalBuild.ts';

type HtmlNode = { readonly tagName?: string; readonly childNodes?: readonly HtmlNode[]; readonly value?: string };
export interface ProfileRow { readonly control: string; readonly value: string; readonly placeholder?: string; readonly note?: string }
export interface ImportReport { readonly rows: readonly ProfileRow[]; readonly counts: Readonly<Record<string, number>>; readonly differences: readonly { readonly control: string; readonly en: string; readonly fr: string }[] }

const cellText = (node: HtmlNode): string => (typeof node.value === 'string' ? node.value : (node.childNodes ?? []).map(cellText).join('')).replace(/\s+/g, ' ').trim();
const elements = (node: HtmlNode, tag: string): HtmlNode[] => [node, ...(node.childNodes ?? []).flatMap((child) => elements(child, tag))].filter((child) => child.tagName === tag);
const findTable = (html: string): HtmlNode => {
  const tables = elements(mainOf(parseHtml(html)) as unknown as HtmlNode, 'table');
  const table = tables.find((candidate) => /^Table 4\.1:/i.test(cellText(elements(candidate, 'caption')[0] ?? {})));
  if (!table) throw new Error('ITSP.10.033-01 page has no Table 4.1 profile table');
  return table;
};

const requiredHeaders = ['Family', 'ID', 'Suggested for this profile', 'Suggested placeholder values', 'Profile-specific notes'];
function profileRows(html: string): ProfileRow[] {
  const table = findTable(html);
  const rows = elements(table, 'tr');
  const headings = elements(rows[0] ?? {}, 'th').map(cellText);
  const index = (header: string): number => {
    const found = headings.indexOf(header);
    if (found < 0) throw new Error(`ITSP.10.033-01 table is missing ${header} column`);
    return found;
  };
  requiredHeaders.forEach(index);
  return rows.slice(1).map((row) => {
    const cells = elements(row, 'td').map(cellText);
    const family = cells[index('Family')]; const rawId = cells[index('ID')]; const value = cells[index('Suggested for this profile')];
    if (!family || !rawId || !value) throw new Error('ITSP.10.033-01 table has a row without family, id, or selection');
    const control = normalizeId(`${family}-${rawId}`);
    const placeholder = cells[index('Suggested placeholder values')]; const note = cells[index('Profile-specific notes')];
    return { control, value, ...(placeholder ? { placeholder } : {}), ...(note ? { note } : {}) };
  });
}

/** Import the English ITSP.10.033-01 Medium profile. English is authoritative (D-13). */
export async function importSource(context: { readonly offlinePages?: Readonly<Record<string, string>> } = {}): Promise<{ sourceId: string; catalog: any; report: ImportReport }> {
  const html = context.offlinePages?.en;
  if (!html) throw new Error('ITSP.10.033-01 importer needs the English profile page');
  const rows = profileRows(html);
  const values = new Set(['Selected', 'Not selected', 'Deployed organization-wide. Not associated with baseline.', 'NA', 'Not allocated to baseline.']);
  for (const row of rows) if (!values.has(row.value)) throw new Error(`ITSP.10.033-01 ${row.control}: unknown selection value ${JSON.stringify(row.value)}`);
  const includes = rows.filter((row) => row.value === 'Selected' || row.value === 'Deployed organization-wide. Not associated with baseline.').map((row) => row.control);
  const alters = rows.flatMap((row) => row.value === 'Deployed organization-wide. Not associated with baseline.' ? [{ 'control-id': row.control, adds: [{ props: [{ name: 'profile-suggestion', ns: NS, value: 'deployed-organization-wide' }] }] }] : []);
  const catalog = newProfile('ITSP.10.033-01 Medium profile', 'ITSP.10.033-01', '2026-11-21T00:00:00Z') as any;
  catalog.profile.imports.push({ href: '../catalogs/itsp-10-033/catalog.json', 'include-controls': [{ 'with-ids': includes }] });
  if (alters.length > 0) catalog.profile.modify = { alters };
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.value] = (counts[row.value] ?? 0) + 1;
  return { sourceId: 'itsp-10-033-01', catalog, report: { rows, counts, differences: [] } };
}

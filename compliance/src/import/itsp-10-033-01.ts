import { NS } from '../model.ts';
import { mainOf, normalizeId, parseHtml } from './lib/cyberHtml.ts';
import { newProfile } from './lib/oscalBuild.ts';
import { createFetcher, type Fetcher } from './lib/fetch.ts';

type HtmlNode = { readonly tagName?: string; readonly childNodes?: readonly HtmlNode[]; readonly value?: string };
export interface ProfileRow { readonly control: string; readonly value: string; readonly placeholder?: string; readonly note?: string }
export interface ImportReport { readonly rows: readonly ProfileRow[]; readonly counts: Readonly<Record<string, number>>; readonly differences: readonly { readonly control: string; readonly en: string; readonly fr: string }[] }
export interface TailoringRemoval { readonly control: string; readonly reason: string; readonly reviewer: string; readonly reviewedAt: string }

const cellText = (node: HtmlNode): string => (typeof node.value === 'string' ? node.value : (node.childNodes ?? []).map(cellText).join('')).replace(/\s+/g, ' ').trim();
const elements = (node: HtmlNode, tag: string): HtmlNode[] => [node, ...(node.childNodes ?? []).flatMap((child) => elements(child, tag))].filter((child) => child.tagName === tag);
const findTable = (html: string, locale: 'en' | 'fr'): HtmlNode => {
  const tables = elements(mainOf(parseHtml(html)) as unknown as HtmlNode, 'table');
  const caption = locale === 'en' ? /^Table 4\.1:/i : /^Tableau 4\.1\s*:/i;
  const table = tables.find((candidate) => caption.test(cellText(elements(candidate, 'caption')[0] ?? {})));
  if (!table) throw new Error('ITSP.10.033-01 page has no Table 4.1 profile table');
  return table;
};

const englishHeaders = ['Family', 'ID', 'Suggested for this profile', 'Suggested placeholder values', 'Profile-specific notes'];
const frenchHeaders = ['Famille', 'ID', 'Suggéré pour ce profil', 'Valeurs de remplacement suggérées', 'Notes propres au profil'];
const englishPage = 'https://www.cyber.gc.ca/en/guidance/suggested-organizational-security-privacy-control-activity-profile-medium-impact-itsp10033-01';
const frenchPage = 'https://www.cyber.gc.ca/fr/orientation/gestion-risques-lies-cybersecurite-risques-datteinte-vie-privee/proposition-profil-dactivites-controles-organisationnels-securite-protection-vie-privee-incidence-moyenne-itsp10033-01';
function profileRows(html: string, locale: 'en' | 'fr' = 'en'): ProfileRow[] {
  const table = findTable(html, locale);
  const rows = elements(table, 'tr');
  const headings = elements(rows[0] ?? {}, 'th').map(cellText);
  const [familyHeader, idHeader, selectionHeader, placeholderHeader, noteHeader] = locale === 'en' ? englishHeaders : frenchHeaders;
  const index = (header: string): number => {
    const found = headings.indexOf(header);
    if (found < 0) throw new Error(`ITSP.10.033-01 table is missing ${header} column`);
    return found;
  };
  [familyHeader, idHeader, selectionHeader, placeholderHeader, noteHeader].forEach(index);
  return rows.slice(1).map((row) => {
    const cells = elements(row, 'td').map(cellText);
    const family = cells[index(familyHeader)]; const rawId = cells[index(idHeader)]; const value = cells[index(selectionHeader)];
    if (!family || !rawId || !value) throw new Error('ITSP.10.033-01 table has a row without family, id, or selection');
    const control = normalizeId(`${family}-${rawId}`);
    const placeholder = cells[index(placeholderHeader)]; const note = cells[index(noteHeader)];
    return { control, value, ...(placeholder ? { placeholder } : {}), ...(note ? { note } : {}) };
  });
}

/** Import the English ITSP.10.033-01 Medium profile. English is authoritative (D-13). */
export async function importSource(context: { readonly offlinePages?: Readonly<Record<string, string>>; readonly fetcher?: Fetcher; readonly lang?: 'en' | 'fr' | 'both' } = {}): Promise<{ sourceId: string; catalog: any; file: string; reportFile: string; report: ImportReport }> {
  if (context.lang === 'fr') throw new Error('ITSP.10.033-01 English is authoritative; French-only imports are refused');
  const fetcher = context.fetcher ?? createFetcher({ fetchImpl: globalThis.fetch as any });
  const read = async (key: 'en' | 'fr', url: string): Promise<string | undefined> => context.offlinePages ? context.offlinePages[key] : (await fetcher.get(url, { accept: 'text/html' })).body.toString('utf8');
  const html = await read('en', englishPage);
  if (!html) throw new Error('ITSP.10.033-01 importer needs the English profile page');
  const rows = profileRows(html);
  const values = new Set(['Selected', 'Not selected', 'Deployed organization-wide. Not associated with baseline.', 'NA', 'Not allocated to baseline.']);
  for (const row of rows) if (!values.has(row.value)) throw new Error(`ITSP.10.033-01 ${row.control}: unknown selection value ${JSON.stringify(row.value)}`);
  const includes = rows.filter((row) => row.value === 'Selected' || row.value === 'Deployed organization-wide. Not associated with baseline.').map((row) => row.control);
  const alters = rows.flatMap((row) => {
    const props = [
      ...(row.value === 'Deployed organization-wide. Not associated with baseline.' ? [{ name: 'profile-suggestion', ns: NS, value: 'deployed-organization-wide' }] : []),
      ...(row.placeholder ? [{ name: 'suggested-placeholder', ns: NS, value: row.placeholder }] : []),
      ...(row.note ? [{ name: 'profile-note', ns: NS, value: row.note }] : [])
    ];
    return props.length ? [{ 'control-id': row.control, adds: [{ props }] }] : [];
  });
  const catalog = newProfile('ITSP.10.033-01 Medium profile', 'ITSP.10.033-01', '2026-11-21T00:00:00Z') as any;
  catalog.profile.imports.push({ href: '../catalogs/itsp-10-033/catalog.json', 'include-controls': [{ 'with-ids': includes }] });
  if (alters.length > 0) catalog.profile.modify = { alters };
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.value] = (counts[row.value] ?? 0) + 1;
  const frenchHtml = context.lang === 'en' ? undefined : await read('fr', frenchPage);
  const french = frenchHtml ? profileRows(frenchHtml, 'fr') : [];
  const frenchValues: Readonly<Record<string, string>> = {
    'Sélectionné': 'Selected', 'Non sélectionné': 'Not selected',
    'Déployé dans l’ensemble de l’organisation. Non associé à une base de référence.': 'Deployed organization-wide. Not associated with baseline.',
    'ND': 'NA', 'Non attribué à une base de référence.': 'Not allocated to baseline.'
  };
  const byControl = new Map(rows.map((row) => [row.control, row]));
  const differences = french.flatMap((row) => {
    const en = byControl.get(row.control); const fr = frenchValues[row.value];
    if (!en || !fr) throw new Error(`ITSP.10.033-01 ${row.control}: unknown French selection value ${JSON.stringify(row.value)}`);
    return en.value === fr ? [] : [{ control: row.control, en: en.value, fr }];
  });
  return { sourceId: 'itsp-10-033-01', catalog, file: 'profiles/itsp-10-033-01-medium.json', reportFile: 'import-reports/itsp-10-033-01.json', report: { rows, counts, differences } };
}

/** Builds the derived Protected A profile only from reviewed tailoring removals. */
export function protectedAForTailoring(removals: readonly TailoringRemoval[]): any {
  for (const removal of removals) if (!removal.reason || !removal.reviewer || !removal.reviewedAt) throw new Error(`Protected A removal ${removal.control} needs a reason, reviewer, and review date`);
  const profile = newProfile('Protected A profile', '1.0.0', '2026-11-21T00:00:00Z') as any;
  profile.profile.imports.push({ href: 'itsp-10-033-01-medium.json', 'include-all': {} });
  if (removals.length) profile.profile.modify = { alters: removals.map((removal) => ({ 'control-id': removal.control, removes: [{ 'by-item-name': 'prop', remarks: `${removal.reason} Reviewed by ${removal.reviewer} on ${removal.reviewedAt}.` }] })) };
  return profile;
}

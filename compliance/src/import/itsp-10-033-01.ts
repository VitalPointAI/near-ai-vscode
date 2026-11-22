import { NS } from '../model.ts';
import { mainOf, normalizeId, parseHtml } from './lib/cyberHtml.ts';
import { newProfile } from './lib/oscalBuild.ts';
import { createFetcher, type Fetcher } from './lib/fetch.ts';

type HtmlNode = { readonly tagName?: string; readonly childNodes?: readonly HtmlNode[]; readonly value?: string };
export interface ProfileRow { readonly control: string; readonly value: string; readonly placeholder?: string; readonly note?: string }
interface SourceCorrection { readonly table: number; readonly publishedControl: string; readonly control: string; readonly verifiedAgainst: string }
export interface ImportReport { readonly rows: readonly ProfileRow[]; readonly counts: Readonly<Record<string, number>>; readonly differences: readonly { readonly control: string; readonly en: string; readonly fr: string }[]; readonly frenchFailures: readonly { readonly page: string; readonly reason: string }[]; readonly sourceCorrections?: readonly SourceCorrection[] }
export interface TailoringRemoval { readonly control: string; readonly reason: string; readonly reviewer: string; readonly reviewedAt: string }

const cellText = (node: HtmlNode): string => (typeof node.value === 'string' ? node.value : (node.childNodes ?? []).map(cellText).join('')).replace(/\s+/g, ' ').trim();
const elements = (node: HtmlNode, tag: string): HtmlNode[] => [node, ...(node.childNodes ?? []).flatMap((child) => elements(child, tag))].filter((child) => child.tagName === tag);
const englishHeaders = [['Family'], ['ID'], ['Suggested for this profile'], ['Suggested placeholder values'], ['Profile-specific notes']];
const frenchHeaders = [['Famille'], ['ID'], ['Suggéré pour ce profil'], ['Valeurs suggérées de paramètres substituables', 'Valeurs de remplacement suggérées'], ['Remarques concernant le profil', 'Notes propres au profil']];
const englishPage = 'https://www.cyber.gc.ca/en/guidance/cyber-security-privacy-risk-management/suggested-organizational-security-privacy-control-activity-profile-medium-impact-itsp10033-01';
const frenchPage = 'https://www.cyber.gc.ca/fr/orientation/gestion-risques-lies-cybersecurite-risques-datteinte-vie-privee/proposition-profil-dactivites-controles-organisationnels-securite-protection-vie-privee-incidence-moyenne-itsp10033-01';
function profileRows(html: string, locale: 'en' | 'fr', sourceCorrections: SourceCorrection[] = []): ProfileRow[] {
  const captionPattern = locale === 'en' ? /^Table 4\.(\d+)\s*:/i : /^Tableau 4\.(\d+)\s*:/i;
  const profileTables = elements(mainOf(parseHtml(html)) as unknown as HtmlNode, 'table').flatMap((table) => {
    const match = captionPattern.exec(cellText(elements(table, 'caption')[0] ?? {}));
    return match ? [{ table, number: Number(match[1]) }] : [];
  });
  if (!profileTables.length) throw new Error('ITSP.10.033-01 page has no Table 4.1 profile table');

  const seen = new Set<string>();
  return profileTables.flatMap(({ table, number }, tableIndex) => {
    if (number !== tableIndex + 1) throw new Error(`ITSP.10.033-01 expected Table 4.${tableIndex + 1}, found Table 4.${number}`);
    const rows = elements(table, 'tr');
    const headings = elements(rows[0] ?? {}, 'th').map(cellText);
    const [familyIndex, idIndex, selectionIndex, placeholderIndex, noteIndex] = (locale === 'en' ? englishHeaders : frenchHeaders).map((aliases) => {
      const found = headings.findIndex((heading) => aliases.includes(heading));
      if (found < 0) throw new Error(`ITSP.10.033-01 Table 4.${number} is missing ${aliases[0]} column`);
      return found;
    });
    if (rows.length <= 1) throw new Error(`ITSP.10.033-01 Table 4.${number} has no profile rows`);
    return rows.slice(1).map((row) => {
      const cells = (row.childNodes ?? []).filter((cell) => cell.tagName === 'td' || cell.tagName === 'th').map(cellText);
      const family = cells[familyIndex]; const rawId = cells[idIndex]; const value = cells[selectionIndex];
      if (!family || !rawId || !value) throw new Error(`ITSP.10.033-01 Table 4.${number} has a row without family, id, or selection`);
      let control = normalizeId(`${family}-${rawId}`);
      // The English HTML repeats CM-11(02). The official English PDF, Table 4.5,
      // identifies the automation row as CM-11(03). The French HTML agrees.
      if (locale === 'en' && number === 5 && control === 'cm-11.02' && seen.has(control)
        && cells[headings.indexOf('Description')]?.startsWith('User-installed software: Automated enforcement and monitoring')) {
        sourceCorrections.push({ table: number, publishedControl: control, control: 'cm-11.03', verifiedAgainst: 'https://www.cyber.gc.ca/sites/default/files/itsp.10.033-01-e.pdf' });
        control = 'cm-11.03';
      }
      if (seen.has(control)) throw new Error(`ITSP.10.033-01 Table 4.${number} duplicates control ${control}`);
      seen.add(control);
      const placeholder = cells[placeholderIndex]; const note = cells[noteIndex];
      return { control, value, ...(placeholder ? { placeholder } : {}), ...(note ? { note } : {}) };
    });
  });
}

/** Import the English ITSP.10.033-01 Medium profile. English is authoritative (D-13). */
export async function importSource(context: { readonly offlinePages?: Readonly<Record<string, string>>; readonly fetcher?: Fetcher; readonly lang?: 'en' | 'fr' | 'both' } = {}): Promise<{ sourceId: string; catalog: any; file: string; reportFile: string; report: ImportReport }> {
  if (context.lang === 'fr') throw new Error('ITSP.10.033-01 English is authoritative; French-only imports are refused');
  const fetcher = context.fetcher ?? createFetcher({ fetchImpl: globalThis.fetch as any });
  const read = async (key: 'en' | 'fr', url: string): Promise<string | undefined> => context.offlinePages ? context.offlinePages[key] : (await fetcher.get(url, { accept: 'text/html' })).body.toString('utf8');
  const html = await read('en', englishPage);
  if (!html) throw new Error('ITSP.10.033-01 importer needs the English profile page');
  const sourceCorrections: SourceCorrection[] = [];
  const rows = profileRows(html, 'en', sourceCorrections);
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
  const frenchValues: Readonly<Record<string, string>> = {
    'Sélectionné': 'Selected', 'Non sélectionné': 'Not selected',
    'Déployé dans l’ensemble de l’organisation. Non associé à une base de référence.': 'Deployed organization-wide. Not associated with baseline.',
    'Déployé dans l’ensemble de l’organisation. Non associé à la base de référence.': 'Deployed organization-wide. Not associated with baseline.',
    'ND': 'NA', 's.o.': 'NA', 'Non attribué à une base de référence.': 'Not allocated to baseline.',
    'Non attribué à la base de référence.': 'Not allocated to baseline.'
  };
  const frenchFailures: ImportReport['frenchFailures'][number][] = [];
  let differences: ImportReport['differences'] = [];
  if (context.lang !== 'en') try {
    const frenchHtml = await read('fr', frenchPage);
    if (frenchHtml) {
      const french = profileRows(frenchHtml, 'fr');
      const byControl = new Map(french.map((row) => [row.control, row]));
      differences = rows.flatMap((row) => {
        const translated = byControl.get(row.control);
        if (!translated) throw new Error(`ITSP.10.033-01 French profile lacks ${row.control}`);
        if (!Object.hasOwn(frenchValues, translated.value)) throw new Error(`ITSP.10.033-01 ${row.control}: unknown French selection value ${JSON.stringify(translated.value)}`);
        const fr = frenchValues[translated.value];
        return row.value === fr ? [] : [{ control: row.control, en: row.value, fr }];
      });
      if (french.length !== rows.length) throw new Error('ITSP.10.033-01 French profile contains controls absent in English');
    }
  } catch (error) {
    differences = [];
    frenchFailures.push({ page: frenchPage, reason: error instanceof Error ? error.message : String(error) });
  }
  return { sourceId: 'itsp-10-033-01', catalog, file: 'profiles/itsp-10-033-01-medium.json', reportFile: 'import-reports/itsp-10-033-01.json', report: { rows, counts, differences, frenchFailures, ...(sourceCorrections.length ? { sourceCorrections } : {}) } };
}

/** Builds the derived Protected A profile only from reviewed tailoring removals. */
export function protectedAForTailoring(removals: readonly TailoringRemoval[]): any {
  for (const removal of removals) if (!removal.reason || !removal.reviewer || !removal.reviewedAt) throw new Error(`Protected A removal ${removal.control} needs a reason, reviewer, and review date`);
  const profile = newProfile('Protected A profile', '1.0.0', '2026-11-21T00:00:00Z') as any;
  profile.profile.imports.push({ href: 'itsp-10-033-01-medium.json', 'include-all': {} });
  if (removals.length) profile.profile.modify = { alters: removals.map((removal) => ({ 'control-id': removal.control, removes: [{ 'by-item-name': 'prop', remarks: `${removal.reason} Reviewed by ${removal.reviewer} on ${removal.reviewedAt}.` }] })) };
  return profile;
}

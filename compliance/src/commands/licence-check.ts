import { writeFileSync } from 'node:fs';
import { SOURCE_REGISTRY } from '../import/lib/sourceRegistry.ts';

export interface LicenceCheckContext { readonly fetchJson?: (url: string) => Promise<unknown>; readonly write?: (text: string) => void; }

const ckanUrl = (recordId: string) => `https://open.canada.ca/data/api/action/package_show?id=${encodeURIComponent(recordId)}`;
const defaultFetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { headers: { 'user-agent': 'NEAR AI compliance importer/0.1' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};
const licenseId = (value: unknown): unknown => typeof value === 'object' && value !== null && 'result' in value && typeof value.result === 'object' && value.result !== null && 'license_id' in value.result ? (value.result as Record<string, unknown>).license_id : undefined;

export async function run(argv: readonly string[], context: LicenceCheckContext = {}): Promise<number> {
  const index = argv.indexOf('--out');
  if (index !== -1 && (index + 1 === argv.length || index !== argv.length - 2)) throw new Error('usage: licence-check [--out <file>]');
  const fetchJson = context.fetchJson ?? defaultFetchJson;
  const rows: { id: string; recordId: string; ok: boolean; actual?: string }[] = [];
  for (const source of SOURCE_REGISTRY) {
    if (source.licenceEvidence.kind !== 'ckan') continue;
    try {
      const actual = licenseId(await fetchJson(ckanUrl(source.licenceEvidence.recordId)));
      const ok = actual === source.licence;
      rows.push({ id: source.id, recordId: source.licenceEvidence.recordId, ok, ...(typeof actual === 'string' ? { actual } : {}) });
    } catch {
      rows.push({ id: source.id, recordId: source.licenceEvidence.recordId, ok: false });
    }
  }
  if (index !== -1) writeFileSync(argv[index + 1], JSON.stringify(rows, null, 2) + '\n', 'utf8');
  else for (const row of rows) context.write?.(JSON.stringify(row) + '\n');
  return rows.every((row) => row.ok) ? 0 : 3;
}

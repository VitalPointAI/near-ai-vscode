import { newCatalog } from './lib/oscalBuild.ts';

export const ITAR_REQUIREMENTS = [] as const;

/** Scaffold for the ITAR and EAR importer. */
export async function importSource(_context: { readonly offlinePages?: Readonly<Record<string, string>> } = {}) {
  return {
    sourceId: 'ecfr-title-22',
    file: 'catalogs/itar/catalog.json',
    catalog: newCatalog({ sourceId: 'ecfr-title-22', title: 'ITAR and EAR requirements', version: '0.1.0', retrievedAt: '2026-11-21T00:00:00Z' })
  };
}

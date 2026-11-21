import { newCatalog } from './lib/oscalBuild.ts';

export const CGP_REQUIREMENTS = [] as const;

/** Scaffold for the Controlled Goods Program importer. */
export async function importSource(_context: { readonly offlinePages?: Readonly<Record<string, string>> } = {}) {
  return {
    sourceId: 'defence-production-act',
    file: 'catalogs/cgp/catalog.json',
    catalog: newCatalog({
      sourceId: 'defence-production-act',
      title: 'Controlled Goods Program requirements',
      version: '0.1.0',
      retrievedAt: '2026-11-21T00:00:00Z'
    })
  };
}

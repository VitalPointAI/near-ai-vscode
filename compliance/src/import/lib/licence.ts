import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SourceEntry } from './sourceRegistry.ts';

export const ALLOWED_TEXT_LICENCES = Object.freeze(['ca-ogl-lgo', 'us-public-domain', 'us-government-work', 'reproduction-of-federal-law-order'] as const);

export function mayStoreText(entry: SourceEntry): boolean {
  return entry.use === 'text' && (ALLOWED_TEXT_LICENCES as readonly string[]).includes(entry.licence);
}

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const sourceId = (catalog: unknown): string | undefined => {
  if (!record(catalog) || !record(catalog.catalog)) return undefined;
  // Older generated data used the invalid root location; keep it readable while new
  // output uses OSCAL's valid catalog.metadata.props location.
  const props = Array.isArray(catalog.catalog.props) ? catalog.catalog.props : record(catalog.catalog.metadata) && Array.isArray(catalog.catalog.metadata.props) ? catalog.catalog.metadata.props : [];
  const prop = props.find((candidate) => record(candidate) && candidate.name === 'source-id' && typeof candidate.value === 'string');
  return record(prop) && typeof prop.value === 'string' ? prop.value : undefined;
};
const proseControl = (catalog: unknown): string | undefined => {
  const root = record(catalog) && record(catalog.catalog) ? catalog.catalog : undefined;
  const controls: unknown[] = [];
  const collect = (value: unknown): void => {
    if (!record(value)) return;
    if (Array.isArray(value.controls)) controls.push(...value.controls);
    if (Array.isArray(value.groups)) value.groups.forEach(collect);
  };
  collect(root);
  for (const control of controls) {
    if (!record(control)) continue;
    const containsProse = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(containsProse);
      if (!record(value)) return false;
      if (typeof value.prose === 'string' && value.prose.trim() !== '') return true;
      return Object.values(value).some(containsProse);
    };
    if (containsProse(control)) return typeof control.id === 'string' ? control.id : '<unnamed-control>';
  }
  return undefined;
};
const jsonFiles = (folder: string): string[] => {
  if (!existsSync(folder)) return [];
  if (statSync(folder).isFile()) return folder.endsWith('.json') ? [folder] : [];
  return readdirSync(folder, { recursive: true, encoding: 'utf8' }).map((file) => path.join(folder, file)).filter((file) => file.endsWith('.json') && statSync(file).isFile());
};

/** Refuses catalogue prose whose declared source is not explicitly permitted to store text (D-11). */
export function checkCatalogTextLicence(catalogOrFolder: unknown, registry: readonly SourceEntry[]): void {
  const catalogs = typeof catalogOrFolder === 'string'
    ? jsonFiles(catalogOrFolder).map((file) => ({ file, catalog: JSON.parse(readFileSync(file, 'utf8')) }))
    : [{ file: '<catalog>', catalog: catalogOrFolder }];
  for (const { file, catalog } of catalogs) {
    const control = proseControl(catalog);
    if (!control) continue;
    const id = sourceId(catalog);
    const entry = registry.find((candidate) => candidate.id === id);
    if (!entry || !mayStoreText(entry)) throw new Error(`${file}: control ${control} has prose from source ${id ?? '<missing>'} without an allowed text licence`);
  }
}

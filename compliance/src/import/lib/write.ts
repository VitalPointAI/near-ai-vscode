import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkCatalogTextLicence } from './licence.ts';
import type { SourceEntry } from './sourceRegistry.ts';

export interface ImportResult { readonly sourceId: string; readonly catalog: unknown; readonly file?: string; }

const sort = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sort);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
  return value;
};

/** Writes one generated catalogue after enforcing the licence invariant and a lexical output-root boundary. */
export function writeImportResult(outRoot: string, result: ImportResult, registry: readonly SourceEntry[]): string {
  const source = registry.find((entry) => entry.id === result.sourceId);
  if (!source) throw new Error(`unknown source ${result.sourceId}`);
  checkCatalogTextLicence(result.catalog, registry);
  const relative = result.file ?? path.join('catalogs', `${result.sourceId}.json`);
  if (path.isAbsolute(relative)) throw new Error('import output must be relative');
  mkdirSync(outRoot, { recursive: true });
  const root = realpathSync(outRoot);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('import output escapes its root');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(sort(result.catalog), null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
  return target;
}

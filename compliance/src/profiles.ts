import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadJson } from './validate.ts';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const ids = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(ids) : record(value) ? [typeof value.id === 'string' ? value.id : '', ...Object.values(value).flatMap(ids)].filter(Boolean) : [];

function importsOf(file: string, seen = new Set<string>()): { ids: Set<string>; alters: RecordValue[] } {
  const resolved = path.resolve(file); if (seen.has(resolved)) throw new Error(`profile import cycle: ${resolved}`); seen.add(resolved);
  if (!existsSync(resolved)) throw new Error(`profile import missing: ${resolved}`);
  const document = loadJson(resolved) as RecordValue; const profile = record(document.profile) ? document.profile : document;
  const selected = new Set<string>(); const alters: RecordValue[] = [];
  for (const entry of (Array.isArray(profile.imports) ? profile.imports : [])) {
    if (!record(entry)) continue;
    const href = typeof entry.href === 'string' ? entry.href : undefined;
    let available: string[] = [];
    if (href) {
      const imported = path.resolve(path.dirname(resolved), href);
      if (!existsSync(imported)) throw new Error(`profile import missing: ${href}`);
      const child = loadJson(imported) as RecordValue;
      if (record(child.profile)) { const nested = importsOf(imported, seen); available = [...nested.ids]; alters.push(...nested.alters); }
      else available = ids(child.catalog ?? child);
    }
    if (entry['include-all'] !== undefined) available.forEach((id) => selected.add(id));
    const selectedBy = (value: unknown) => Array.isArray(value) ? value.flatMap((item) => record(item) ? [...asStrings(item['with-ids']), ...asStrings(item.withIds)] : []) : record(value) ? [...asStrings(value['with-ids']), ...asStrings(value.withIds)] : [];
    for (const id of selectedBy(entry['include-controls'] ?? entry.withIds)) selected.add(id);
    for (const id of selectedBy(entry['exclude-controls'] ?? entry.excludeIds)) selected.delete(id);
  }
  const modify = record(profile.modify) ? profile.modify : {};
  for (const alter of (Array.isArray(modify['set-parameters']) ? modify['set-parameters'] : [])) if (record(alter)) alters.push(alter);
  seen.delete(resolved); return { ids: selected, alters };
}

/** Resolve a profile's selectors recursively; this intentionally returns IDs only, not OSCAL's full resolution. */
export function selectedIds(profileFile: string): string[] { return [...importsOf(profileFile).ids].sort(); }
/** Organization-wide parameter choices from the profile's alteration block. */
export function profileAlters(profileFile: string): readonly RecordValue[] { return importsOf(profileFile).alters; }

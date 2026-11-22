import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadJson, validateOurs } from './validate.ts';
import type { TailoringRecord } from './model.ts';

export interface TailoringRemoval { readonly level: string; readonly control: string; readonly reason: string; readonly reviewer: string; readonly reviewedAt: string }
export interface Tailoring { readonly notApplicable: readonly TailoringRecord[]; readonly removals: readonly TailoringRemoval[] }

/** Loads strict tailoring files and refuses duplicate not-applicable decisions. */
export function loadTailoring(dir: string): Tailoring {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { notApplicable: [], removals: [] };
  const notApplicable: TailoringRecord[] = [];
  const removals: TailoringRemoval[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    if (!statSync(file).isFile()) continue;
    const doc = loadJson(file);
    const valid = validateOurs(doc, 'tailoring');
    if (!valid.ok) throw new Error(`${file}: invalid tailoring: ${valid.errors.join('; ')}`);
    const root = doc as { level: string; notApplicable: Omit<TailoringRecord, 'level'>[]; removals: Omit<TailoringRemoval, 'level'>[] };
    for (const entry of root.notApplicable) {
      const item = { ...entry, level: root.level };
      const key = `${item.level}\u0000${item.control}\u0000${item.component}`;
      if (seen.has(key)) throw new Error(`${file}: duplicate not-applicable record for ${item.level}, ${item.control}, ${item.component}`);
      seen.add(key);
      notApplicable.push(item);
    }
    for (const entry of root.removals) removals.push({ ...entry, level: root.level });
  }
  return { notApplicable, removals };
}

export function notApplicableFor(tailoring: Tailoring, level: string, control: string, component: string): TailoringRecord | undefined {
  return tailoring.notApplicable.find((entry) => entry.level === level && entry.control === control && entry.component === component);
}

export function removalsFor(tailoring: Tailoring, level: string): readonly TailoringRemoval[] { return tailoring.removals.filter((entry) => entry.level === level); }

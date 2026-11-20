// The `models` section of policy bundle v2 (models@1, FND-08, Phase 41 D-42): a strict `v: 1` shell that plan 41-05 fills with the passport schema of the
// model provenance design (5.1 to 5.3). Pure: no I/O, no clock, no vscode, no package.
// Until then every key the schema names is refused as not available yet, and any other key as unknown, so a policy can never carry a models rule this
// version would silently ignore. 41-05 keeps this file's names and the parser's signature, and `{ v: 1 }` keeps parsing after it.
// This file imports nothing from bundle.ts: 41-10's routing.ts imports it, and bundle.ts imports routing.ts, which would make a load-time cycle.
import type { ScaleTable } from './labels';
import { childPath, isRecord, ownValue, refused } from './shape';
import type { Parsed } from './shape';

export interface ModelsSection {
  readonly v: 1;
}

/** The keys of the models section in the provenance design's schema (WP-0), in the order the design lists them. */
export const MODELS_SECTION_KEYS = Object.freeze(['mode', 'unknownMaxTier', 'tierByLevel', 'tierByProject', 'passports', 'defaults', 'localCatalogue', 'order'] as const);

/** Reads the models section against the document's scales (the scales name the levels of `tierByLevel` once 41-05 fills it). */
export function parseModelsSection(value: unknown, scales: ScaleTable, path = 'models'): Parsed<ModelsSection> {
  void scales;
  if (!isRecord(value)) return refused('wrong-type', path);
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== 1) return refused('unknown-version', childPath(path, 'v'));
  for (const key of Object.keys(value)) {
    if (key === 'v') continue;
    const where = childPath(path, key.slice(0, 40));
    if ((MODELS_SECTION_KEYS as readonly string[]).includes(key)) return refused('not-available-yet', where);
    return refused('unknown-field', where);
  }
  if (v !== 1) return refused(Object.prototype.hasOwnProperty.call(value, 'v') ? 'wrong-type' : 'missing-field', childPath(path, 'v'));
  return { ok: true, value: Object.freeze({ v: 1 }) };
}

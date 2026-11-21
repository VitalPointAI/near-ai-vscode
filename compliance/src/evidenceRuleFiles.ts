import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { EvidenceRule } from './model.ts';
import { loadJson, validateOurs } from './validate.ts';

/** Load every validated evidence rule file deterministically. */
export function loadEvidenceRules(dir: string): EvidenceRule[] {
  if (!existsSync(dir)) return [];
  const rules: EvidenceRule[] = []; const ids = new Set<string>();
  for (const name of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
    const file = path.join(dir, name); if (!statSync(file).isFile()) continue;
    const document = loadJson(file); const valid = validateOurs(document, 'evidence-rule');
    if (!valid.ok) throw new Error(`${file}: invalid evidence rules: ${valid.errors.join('; ')}`);
    for (const rule of (document as { rules: EvidenceRule[] }).rules) { if (ids.has(rule.id)) throw new Error(`${file}: duplicate evidence rule ${rule.id}`); ids.add(rule.id); rules.push(rule); }
  }
  return rules;
}

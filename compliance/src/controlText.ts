import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ALLOWED_TEXT_LICENCES } from './import/lib/licence.ts';
import type { SourceEntry } from './import/lib/sourceRegistry.ts';
import { validateOurs } from './validate.ts';

type AnyRecord = Record<string, unknown>;
const record = (value: unknown): value is AnyRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const controls = (value: unknown): AnyRecord[] => Array.isArray(value) ? value.flatMap((item) => record(item) ? [item, ...controls(item.controls)] : []) : [];
const sourceId = (catalog: AnyRecord) => (Array.isArray(catalog.props) ? catalog.props.find((prop) => record(prop) && prop.name === 'source-id') : undefined) as AnyRecord | undefined;
const parts = (control: AnyRecord) => (Array.isArray(control.parts) ? control.parts : []).filter(record).map((part) => ({ name: typeof part.name === 'string' ? part.name : typeof part.id === 'string' ? part.id : 'part', prose: typeof part.prose === 'string' ? part.prose : '', lang: 'en' }));

/** Write one attributed public-text file per catalog family. Unlicensed sources expose only identifiers and links. */
export function writeControlText(outDir: string, catalogs: readonly unknown[], sources: readonly SourceEntry[]): { readonly catalog: string; readonly family: string; readonly file: string }[] {
  const index: { catalog: string; family: string; file: string }[] = [];
  for (const input of catalogs) {
    const root = record(input) && record(input.catalog) ? input.catalog : record(input) ? input : undefined; if (!root) continue;
    const id = typeof root.uuid === 'string' ? root.uuid : typeof root.id === 'string' ? root.id : 'catalog';
    const source = sources.find((item) => item.id === sourceId(root)?.value) ?? sources[0]; if (!source) throw new Error(`catalog ${id} has no source`);
    const licensed = (ALLOWED_TEXT_LICENCES as readonly string[]).includes(source.licence);
    const grouped = new Map<string, AnyRecord[]>();
    for (const control of controls(root.controls)) { const family = String(control.id ?? 'unknown').split('-')[0].toLowerCase(); (grouped.get(family) ?? (grouped.set(family, []), grouped.get(family)!)).push(control); }
    for (const [family, items] of grouped) {
      const document = { catalog: id, family, attribution: { source: source.title, url: source.pages[0].url, licence: source.licence, retrievedAt: new Date().toISOString(), notice: 'Unofficial representation of the source; consult the official publication.' }, controls: items.map((control) => ({ id: String(control.id), label: String(control.label ?? control.id), title: String(control.title ?? control.id), parts: licensed ? parts(control) : [] })) };
      const valid = validateOurs(document, 'control-text'); if (!valid.ok) throw new Error(`control text ${id}/${family}: ${valid.errors.join('; ')}`);
      const relative = `text/${id}/${family}.json`; const target = path.join(outDir, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`); index.push({ catalog: id, family, file: relative });
    }
  }
  return index.sort((a, b) => a.file.localeCompare(b.file));
}

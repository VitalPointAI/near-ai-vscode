import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { controlIdentifiers, selectedIds } from '../profiles.ts';

type Json = Record<string, unknown>;
const option = (args: readonly string[], name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const isRecord = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function compareResolved(expected: readonly string[], resolved: readonly string[]): { missing: string[]; extra: string[] } {
  const wanted = new Set(expected); const got = new Set(resolved);
  return { missing: [...wanted].filter((id) => !got.has(id)).sort(), extra: [...got].filter((id) => !wanted.has(id)).sort() };
}
export async function run(args: readonly string[], context: { write?: (text: string) => void } = {}): Promise<number> {
  const profiles = path.resolve(option(args, '--profiles') ?? 'compliance/profiles');
  const resolved = path.resolve(option(args, '--resolved') ?? 'compliance/out/resolved');
  const out = option(args, '--out');
  if (!existsSync(profiles) || !existsSync(resolved)) return 2;
  try {
    const lines = ['# OSCAL profile resolution check', ''];
    for (const name of readdirSync(profiles).filter((item) => item.endsWith('.json')).sort()) {
      const resolvedFile = path.join(resolved, name);
      if (!existsSync(resolvedFile)) { lines.push(`- ${path.basename(name, '.json')}: resolved output missing`); continue; }
      const expected = selectedIds(path.join(profiles, name));
      const document = JSON.parse(readFileSync(resolvedFile, 'utf8')) as Json;
      const found = [...new Set(controlIdentifiers(isRecord(document.catalog) ? document.catalog : document))].sort();
      const difference = compareResolved(expected, found);
      const label = path.basename(name, '.json');
      if (!difference.missing.length && !difference.extra.length) lines.push(`- ${label}: no differences`);
      else {
        lines.push(`- ${label}:`);
        if (difference.missing.length) lines.push(`  - missing from resolved catalogue: ${difference.missing.join(', ')}`);
        if (difference.extra.length) lines.push(`  - only in resolved catalogue: ${difference.extra.join(', ')}`);
      }
    }
    const report = `${lines.join('\n')}\n`;
    if (out) writeFileSync(out, report); else (context.write ?? process.stdout.write.bind(process.stdout))(report);
    return 0;
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

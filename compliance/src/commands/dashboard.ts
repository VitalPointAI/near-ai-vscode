import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateOurs } from '../validate.ts';
const option = (args: readonly string[], name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
/** A bundle already holds the engine-produced dashboard; regeneration validates and copies it byte-for-byte. */
export async function run(args: readonly string[]): Promise<number> { const bundle = option(args, '--bundle'); const out = option(args, '--out'); if (!bundle || !out) return 2; try { const text = readFileSync(path.join(bundle, 'dashboard', 'dashboard.json'), 'utf8'); const valid = validateOurs(JSON.parse(text), 'dashboard'); if (!valid.ok) throw new Error(valid.errors.join('; ')); mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, 'dashboard.json'), text); return 0; } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; } }

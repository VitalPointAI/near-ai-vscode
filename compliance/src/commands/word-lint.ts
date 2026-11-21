import { readFileSync, statSync } from 'node:fs';
import { lintDashboard, lintPage } from '../wordLint.ts';
export async function run(args: readonly string[]): Promise<number> { const paths = args.length ? args : []; const hits = paths.flatMap((file) => { const text = readFileSync(file, 'utf8'); return file.endsWith('.json') ? lintDashboard(JSON.parse(text)) : lintPage(text, file); }); for (const hit of hits) process.stderr.write(`${hit.path}: ${hit.phrase}\n`); return hits.length === 0 ? 0 : 1; }

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crossCheck, markdownSummary } from '../crossCheck.ts';

const valueFor = (argv: readonly string[], flag: string): string | undefined => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
const json = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
/** Runs the comparison on maintainer-provided scratch conversions and writes identifier-only findings. */
export async function run(argv: readonly string[], options: { readonly write?: (text: string) => void } = {}): Promise<number> {
  const ours = valueFor(argv, '--ours'); const aws = valueFor(argv, '--aws'); const ciso = valueFor(argv, '--ciso');
  if (!ours || !aws || !ciso) return 2;
  try {
    const nist = valueFor(argv, '--nist'); const out = valueFor(argv, '--out') ?? path.join(ours, 'import-reports', 'cross-check.json');
    const result = crossCheck({
      ours: { catalog: json(path.join(ours, 'catalogs', 'itsp-10-033', 'catalog.json')), profile: json(path.join(ours, 'profiles', 'itsp-10-033-01-medium.json')) },
      aws: { catalog: json(path.join(aws, 'catalog.json')), profile: json(path.join(aws, 'profile.json')) },
      ciso: readFileSync(ciso, 'utf8'), nist: nist ? json(nist) : { catalog: { controls: [] } }
    });
    mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 });
    (options.write ?? process.stdout.write.bind(process.stdout))(markdownSummary(result) + '\n'); return 0;
  } catch (error) { (options.write ?? process.stderr.write.bind(process.stderr))(`cross-check failed: ${error instanceof Error ? error.message : String(error)}\n`); return 2; }
}

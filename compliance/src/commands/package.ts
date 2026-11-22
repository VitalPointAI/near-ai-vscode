import { fileURLToPath } from 'node:url';
import { buildPackage } from '../package.ts';

const option = (args: readonly string[], name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
export const options = (args: readonly string[], name: string): string[] => args.flatMap((value, index) => value === name && typeof args[index + 1] === 'string' ? [args[index + 1] as string] : []);
export async function run(args: readonly string[]): Promise<number> {
  const release = option(args, '--release'); const bundle = option(args, '--bundle'); const out = option(args, '--out');
  if (!release || !bundle || !out) return 2;
  try { buildPackage({ release, bundle, out, sourceRoot: fileURLToPath(new URL('../../', import.meta.url)), ...(option(args, '--resolved') ? { resolved: option(args, '--resolved') } : {}), ...(options(args, '--sbom').length ? { sboms: options(args, '--sbom') } : {}) }); return 0; }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = Object.freeze([
  'import',
  'licence-check',
  'watch',
  'cross-check',
  'sources',
  'bundle',
  'dashboard',
  'validate',
  'word-lint',
  'package',
  'pr-summary',
  'resolve-check',
  'site-export',
  'hosted-docs',
  'applicability',
  'coverage',
  'release-evidence',
  'supply-chain-statements',
] as const);
const commandName = /^[a-z][a-z0-9-]*$/;

export async function main(argv: readonly string[], options: { readonly write?: (text: string) => void } = {}): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || !commandName.test(name) || !(COMMANDS as readonly string[]).includes(name)) {
    (options.write ?? process.stderr.write.bind(process.stderr))(`Unknown command ${name ?? '<none>'}. Commands: ${COMMANDS.join(', ')}\n`);
    return 2;
  }
  try {
    const module = await import(`./commands/${name}.ts`) as { run?: (args: readonly string[]) => Promise<number> };
    if (typeof module.run !== 'function') throw new Error('command does not export run(argv)');
    return module.run(rest);
  } catch (error) {
    (options.write ?? process.stderr.write.bind(process.stderr))(`Cannot run ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

export function isDirectInvocation(argv: readonly string[], entryPath: string): boolean {
  return Boolean(argv[1] && path.resolve(argv[1]) === entryPath);
}

if (import.meta.main || isDirectInvocation(process.argv, fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv.slice(2));

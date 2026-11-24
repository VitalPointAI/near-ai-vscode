// `hosted-docs` (48.1-01, D-09): the generated blocks of the hosted SA&A documents.
//
//   hosted-docs --check [--root <repository>]   exit 1 when a block differs from its source or a block's source check finds a problem
//   hosted-docs --write [--root <repository>]   rewrite every block from its source, then run the source checks
//
// Runs in the required docs CI job with Node alone: this module and compliance/src/hosted/ import only Node built-ins.
import { checkAll, loadBlocks, REPO_ROOT, writeAll } from '../hosted/generate.ts';

export interface HostedDocsIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const USAGE = 'usage: hosted-docs (--check | --write) [--root <repository>]\n';

export async function run(args: readonly string[], io: HostedDocsIo = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = io.stderr ?? ((text: string) => { process.stderr.write(text); });
  const mode = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : undefined;
  const rootAt = args.indexOf('--root');
  const root = rootAt < 0 ? REPO_ROOT : args[rootAt + 1];
  const known = new Set(['--check', '--write', '--root', ...(rootAt < 0 ? [] : [root])]);
  if (!mode || (args.includes('--write') && args.includes('--check')) || !root || args.some((arg) => !known.has(arg))) { err(USAGE); return 2; }
  const blocks = await loadBlocks();
  if (mode === 'write') for (const document of await writeAll(root, blocks)) out(`wrote ${document}\n`);
  const report = await checkAll(root, blocks);
  for (const warning of report.warnings) err(`warning: ${warning}\n`);
  for (const line of [...report.stale, ...report.problems]) err(`${line}\n`);
  if (report.stale.length || report.problems.length) return 1;
  out(`hosted documents: ${blocks.length} generated blocks are current\n`);
  return 0;
}

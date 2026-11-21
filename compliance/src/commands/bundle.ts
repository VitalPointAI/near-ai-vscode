import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBundle, type BundleInputs } from '../bundle.ts';
import type { FetchJson } from '../collectors/types.ts';

function option(args: readonly string[], name: string): string | undefined { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; }
function githubFetch(token: string): FetchJson { return async (url, init = {}) => {
  if (!url.startsWith('https://api.github.com/')) throw new Error('refused non-GitHub API URL');
  const response = await fetch(url, { method: init.method, headers: { ...init.headers, authorization: `Bearer ${token}` } });
  if (!response.ok) { const error = Object.assign(new Error(`GitHub returned ${response.status}`), { status: response.status }); throw error; }
  return response.json();
}; }

export async function run(args: readonly string[]): Promise<number> {
  const inputFile = option(args, '--inputs'); const out = option(args, '--out'); const previous = option(args, '--previous');
  if (!inputFile || !out) return 2;
  try {
    const inputs = JSON.parse(readFileSync(inputFile, 'utf8')) as BundleInputs;
    const runUrl = inputs.runUrl ?? (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined);
    const token = process.env.GITHUB_TOKEN; const fetchJson = token ? githubFetch(token) : undefined;
    await runBundle({ ...inputs, ...(runUrl ? { runUrl } : {}), repoRoot: inputs.repoRoot ? path.resolve(inputs.repoRoot) : process.cwd() }, out, { fetchJson, ...(previous ? { previous: path.resolve(previous) } : {}) });
    return 0;
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}

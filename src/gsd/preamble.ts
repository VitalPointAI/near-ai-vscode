import { lstat, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';

// Open-GSD's workflows start their shell snippets with a fixed resolver (the "preamble") that
// defines `gsd_run` and then call `gsd_run …`. The auto approval mode may run those snippets
// without asking only when (1) the preamble is byte for byte one shipped in the managed runtime,
// and (2) the resolver would pick the managed runtime's gsd-tools: nothing it checks first exists.

/** The first words of every preamble. */
export const PREAMBLE_START = '_GSD_SHIM_NAME="gsd-tools.cjs";';

/**
 * The resolver structure this check knows: the project root is RUNTIME_DIR, else git's top level,
 * else the working directory; then three copies under that root are tried; then the config homes,
 * the first being CLAUDE_CONFIG_DIR (which the extension sets to the managed runtime). A preamble
 * without these exact parts (an older or edited resolver) is never trusted.
 */
const STRUCTURE = [
  '_GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}";',
  '_gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ',
  'if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; };'
];

/** The copies the resolver tries, relative to the project root, before the managed runtime. */
export const PRECEDING_CANDIDATES = ['gsd-core/bin/gsd-tools.cjs', '.claude/gsd-core/bin/gsd-tools.cjs', '.codex/gsd-core/bin/gsd-tools.cjs'];

export function isKnownPreamble(text: string): boolean {
  return text.startsWith(PREAMBLE_START) && STRUCTURE.every((part) => text.includes(part));
}

const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 512_000;
const cache = new Map<string, Promise<string[]>>();

/**
 * The preambles shipped in the managed runtime at `home` (one line each in its Markdown files),
 * that have the known resolver structure. Cached per runtime folder, which is per version.
 */
export function trustedPreambles(home: string): Promise<string[]> {
  let found = cache.get(home);
  if (!found) {
    found = collectPreambles(home).catch(() => []);
    cache.set(home, found);
  }
  return found;
}

async function collectPreambles(home: string): Promise<string[]> {
  const preambles = new Set<string>();
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (files >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) await walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      files += 1;
      const text = await readFile(full, 'utf8').catch(() => '');
      if (text.length > MAX_FILE_BYTES || !text.includes(PREAMBLE_START)) continue;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (isKnownPreamble(trimmed)) preambles.add(trimmed);
      }
    }
  };
  await walk(home);
  return [...preambles];
}

/** Whether `gsd_run`, as the preamble defines it in this shell, is the managed runtime's gsd-tools. */
export type GsdRunResolution = { trusted: true } | { trusted: false; reason: string };

const exists = async (file: string) => Boolean(await lstat(file).catch(() => undefined));

/** git's top level for `cwd`: the nearest folder with a `.git` entry, or undefined. */
async function gitTopLevel(cwd: string): Promise<string | undefined> {
  let dir = path.resolve(cwd);
  for (;;) {
    if (await exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Checked when the command is decided: the shell's environment must point the resolver at the
 * managed runtime, and no copy it tries first may exist (any entry counts, even a dangling link)
 * under git's top level or the working directory.
 */
export async function resolveGsdRun(cwd: string, home: string, env: NodeJS.ProcessEnv): Promise<GsdRunResolution> {
  if (env.RUNTIME_DIR) return { trusted: false, reason: 'RUNTIME_DIR is set, so the Open-GSD preamble would look for gsd-tools there instead of the managed runtime' };
  if (!env.CLAUDE_CONFIG_DIR || path.resolve(env.CLAUDE_CONFIG_DIR) !== path.resolve(home)) return { trusted: false, reason: 'the shell\'s CLAUDE_CONFIG_DIR is not the Open-GSD runtime NEAR AI installed' };
  if (env.CLAUDE_ENV_FILE) return { trusted: false, reason: 'CLAUDE_ENV_FILE is set, and the Open-GSD preamble would write to it' };
  const roots = [...new Set([await gitTopLevel(cwd), path.resolve(cwd)].filter((root): root is string => Boolean(root)))];
  for (const root of roots) {
    for (const candidate of PRECEDING_CANDIDATES) {
      if (await exists(path.join(root, candidate))) return { trusted: false, reason: `a gsd-tools copy in the workspace (${path.relative(cwd, path.join(root, candidate)) || candidate}) would run instead of the managed one` };
    }
  }
  if (!(await exists(path.join(home, 'gsd-core', 'bin', 'gsd-tools.cjs')))) return { trusted: false, reason: 'the managed Open-GSD runtime has no gsd-tools.cjs' };
  return { trusted: true };
}

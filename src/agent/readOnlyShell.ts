// PERF-04: shell commands that only read may run side by side. The agent's shell is one persistent session, so every Bash call used to queue behind the
// last one, even `git status` next to `grep`. A command this module calls read-only runs in its own short-lived shell, forked from the agent's at its
// current folder, so several can run in the same turn while anything that changes state keeps the serial, persistent shell.
//
// The test is strict on purpose: plain words, pipes and `&&`/`||` only, every program on a fixed list of readers, and no option that writes. Anything it
// cannot account for (redirects, substitutions, variables, `cd`, background jobs, sed, find actions) is not read-only here and runs serially as before.
// It decides only WHERE a command runs, never WHETHER: every call still goes through the same permission check.

const READERS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'stat', 'file', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'diff', 'du', 'df', 'pwd', 'echo', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'basename', 'dirname', 'realpath', 'readlink', 'tree', 'find', 'which', 'true', 'test', 'cmp', 'md5sum', 'sha256sum', 'printf']);
/** git subcommands that only read the repository. */
const GIT_READERS = new Set(['status', 'log', 'diff', 'show', 'ls-files', 'rev-parse', 'blame', 'grep', 'shortlog', 'describe', 'ls-tree', 'cat-file', 'rev-list', 'merge-base', 'branch', 'tag', 'remote']);
/** Options that make a reader write a file or run something. */
const WRITING_OPTIONS = /^(?:-o|--output(?:=.*)?|-exec|-execdir|-ok|-okdir|-delete|-fprint.*|-fls|-fprintf|--exec.*|-x|--ext-diff|--textconv|--upload-pack.*|--receive-pack.*)$/;
/** For git branch/tag/remote: only these listing options keep them read-only (no arguments that would create or delete). */
const GIT_LIST_ONLY = new Set(['branch', 'tag', 'remote']);
const GIT_LIST_OPTIONS = /^(?:-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--verbose|--contains|--merged|--no-merged|--sort=.*|--format=.*)$/;
const WORD = /^(?:[A-Za-z0-9_./:=@+,%^~-]+|'[^']*'|"[^"$`\\]*")$/;

/** Splits a command into the segments between `|`, `&&` and `||`, or undefined when it contains anything else (`;`, `&`, redirects, newlines, `$`, backticks). */
function segments(command: string): string[][] | undefined {
  if (/[;<>`$\n\r\\(){}]|(?<!&)&(?!&)/.test(command.replace(/'[^']*'/g, "''"))) return undefined;
  const parts = command.split(/\|\||&&|\|/);
  const words: string[][] = [];
  for (const part of parts) {
    const tokens = part.trim().match(/'[^']*'|"[^"]*"|[^\s'"]+/g) ?? [];
    if (!tokens.length || tokens.some((token) => !WORD.test(token))) return undefined;
    words.push(tokens);
  }
  return words;
}

/** Whether a shell command only reads, so it may run in its own shell beside others (see the module comment). */
export function isReadOnlyShellCommand(command: string): boolean {
  const text = command.trim();
  if (!text || text.length > 2_000) return false;
  const parts = segments(text);
  if (!parts) return false;
  return parts.every((words) => {
    const program = words[0];
    const rest = words.slice(1).map((word) => word.replace(/^['"]|['"]$/g, ''));
    if (rest.some((word) => WRITING_OPTIONS.test(word))) return false;
    if (program === 'git') {
      // `git -c key=value` can set a command to run (core.pager, diff.external), so it never counts as read-only.
      if (rest.includes('-c')) return false;
      const sub = rest.find((word) => !word.startsWith('-'));
      if (!sub || !GIT_READERS.has(sub) || rest.indexOf(sub) !== 0) return false;
      if (GIT_LIST_ONLY.has(sub)) return rest.slice(1).every((word) => GIT_LIST_OPTIONS.test(word));
      return true;
    }
    return READERS.has(program);
  });
}

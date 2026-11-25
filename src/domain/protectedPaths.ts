// One rule for what the agent may not write without asking, and for the folder whose contents it may not read without asking.
//
// The file tools and the shell guard used to keep two copies of the same regular expression, and neither covered the project's state folder
// (27-REVIEW BLOCKER 1): an agent with edit rights could plant a key file, a meta.json or a git hook there. The owner's invariant (2026-11-13): the
// agent may not write the state folder without asking. Pure: no I/O, no imports from src/agent, so both guards can use it.

/**
 * A relative path (forward slashes, from the project root) that always asks before a write, even after "allow edits for this run" and under
 * fully-autonomous mode:
 * - a segment that is `.git` or ends in `.git` (a bare mirror such as `vendor/mirror.git` has hooks and config that run code on the next git command);
 * - `.planning/.near-ai`, this extension's project settings;
 * - anything under `.near-ai/` except the agent's own folders, `scratch/` and `attachments/` (the state folder, its locks, hooks and keys).
 */
export const PROTECTED_WRITE = /(?:^|\/)[^/]*\.git(?:\/|$)|(?:^|\/)\.planning\/\.near-ai(?:\/|$)|(?:^|\/)\.near-ai\/(?!(?:scratch|attachments)(?:\/|$))[^/]/i;

/** The state folder as a path: `.near-ai/state`, its join siblings (`state.previous-*` and `state.adopt-*` hold an older key file) and anything under them. */
export const STATE_FOLDER_PATH = /(?:^|\/)\.near-ai\/state(?:\.(?:previous|adopt)-[^/]*)?(?:\/|$)/i;

/** The same folders named inside a command line (either slash), at a word boundary so `.near-ai/statement.md` is not one. */
export const STATE_FOLDER_TEXT = /(?<![\w.-])\.near-ai[\\/]state(?:\.(?:previous|adopt)-[^\s/\\'"`;&|)<>]*)?(?=$|[\s/\\'"`;&|)<>])/i;

const GIT_SEGMENT = /(?:^|\/)([^/]*\.git)(?:\/|$)/i;
const PLANNING_SETTINGS = /(?:^|\/)\.planning\/\.near-ai(?:\/|$)/i;

/** A relative path made comparable: forward slashes, no `./`, no `a/../b`, no trailing slash. */
export function normalizeRelative(relative: string): string {
  const parts: string[] = [];
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else parts.push('..'); continue; }
    parts.push(part);
  }
  return parts.join('/');
}

/**
 * Why a write to this relative path asks, or undefined when it does not. `shown` is how the path is named in the sentence (what the model wrote).
 * The two older sentences (.git, .planning/.near-ai) are unchanged.
 */
export function protectedWriteReason(relative: string, shown: string = relative): string | undefined {
  const normalized = normalizeRelative(relative);
  if (!PROTECTED_WRITE.test(normalized)) return undefined;
  const git = GIT_SEGMENT.exec(normalized);
  if (git) return `${shown} is inside ${git[1]}, where hooks and config run code on the next git command. Approve this write only if you expect it.`;
  if (PLANNING_SETTINGS.test(normalized)) return `${shown} is inside .planning/.near-ai, which holds this project's SovAI settings. Approve this write only if you expect it.`;
  return `${shown} is inside .near-ai, where SovAI keeps this project's saved state, keys and locks. Approve this write only if you expect it.`;
}

// 0.4.23: the key folder is off limits to agents altogether. Asking was not enough: in a real run an agent read keys/local.key with a Node script
// and decrypted the project's own encrypted chats, and in fully-autonomous mode a read of the state folder did not even ask. The extension's own
// code reads and writes these files directly, never through an agent tool, so nothing the extension does is refused by this.

/**
 * The state folder's key folder, and the key folders of its join siblings (`state.previous-*`, `state.adopt-*`): the data key (`local.key`),
 * the recovery wrap (`recovery.json`) and the sealed API key copies (`api/*.enc`). Tested against a relative or absolute path with forward slashes.
 */
export const STATE_KEYS_PATH = /(?:^|\/)\.near-ai\/state(?:\.(?:previous|adopt)-[^/]*)?\/keys(?:\/|$)/i;

/** `.near-ai`, `state` (or a sibling) and `keys` in a row, separated by slashes, quotes, commas, `+` or spaces: a path as written or joined in code. */
const STATE_KEYS_JOINED = /(?<![\w-])\.near-ai[\s'"`,+/\\]+state(?:\.(?:previous|adopt)-[^\s/\\'"`;&|)<>,]*)?(?:[\s'"`,+/\\])+keys(?![\w.-])/i;
/** `.near-ai` as a folder name. */
const NEAR_AI_FOLDER = /(?<![\w-])\.near-ai(?![\w-])/i;
/** With `.near-ai` elsewhere in the same text: `state/keys`, a key file's own name, or a glob over the state folder's subfolders. */
const STATE_KEYS_HINT = /(?<![\w.-])state[\\/]+keys(?![\w.-])|(?<![\w.-])local\.key(?![\w.-])|(?<![\w.-])recovery\.json(?![\w.-])|\.near-ai[\\/]+(?:state[^\s/\\'"`]*|\*+)[\\/]+(?:\*|k\*|keys)/i;

/**
 * Whether a command line, or the text of a script a command runs, names the state key folder. A heuristic, and an honest one: it reads text, so it
 * catches the path as written (`.near-ai/state/keys/local.key`), joined in code (`path.join('.near-ai', 'state', 'keys')`), or reached in two steps
 * (`cd .near-ai && cat state/keys/local.key`), but not a path built at run time from pieces that do not look like it (string arithmetic, base64,
 * an environment variable, a directory walk). There is no OS-level sandbox around the agent's shell, so those are not stopped by this check; the
 * key file stays mode 0600 and owned by this user, which an agent's command also is, so the file's own permissions do not stop them either. Text
 * alone cannot see the folder the persistent shell is already in; the Bash tool resolves words from there too (shellReachesStateKeys in tools.ts).
 */
export function namesStateKeys(text: string): boolean {
  return STATE_KEYS_JOINED.test(text) || (NEAR_AI_FOLDER.test(text) && STATE_KEYS_HINT.test(text));
}

/** Why an agent may not use this path or command. `shown` is how the model named it. */
export function stateKeysReason(shown: string): string {
  return `${shown.slice(0, 200)} names the project's key folder (.near-ai/state/keys), which holds the key that encrypts this project's saved chats. Agents may not read, write, list or run anything there, in any approval mode; NEAR AI manages these files itself.`;
}

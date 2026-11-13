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
  if (PLANNING_SETTINGS.test(normalized)) return `${shown} is inside .planning/.near-ai, which holds this project's NEAR AI settings. Approve this write only if you expect it.`;
  return `${shown} is inside .near-ai, where NEAR AI keeps this project's saved state, keys and locks. Approve this write only if you expect it.`;
}

// Where a run's scratch work lives (owner, 2026-11-06): "make sure everything the project is doing is being done inside the project workspace - these
// things need to be self contained and not polluting the rest of my system", and "ensure scratch files/working drafts are not committed and are cleaned
// up when done being used so projects don't grow to stupid sizes".
//
// Before this an agent wrote helper scripts to /tmp and ran them there, which put work outside the project (so a `cd /tmp && python3 verify.py` was
// held as "outside the workspace"), left something behind on the machine, and gave the project no record of what it ran.
//
// One folder, inside the project: `.near-ai/scratch/`. It is ignored by git so a draft is never committed, and it is emptied when the run ends (and
// once at start, for a run that was killed). Pure: no I/O here; the callers do the writing and the deleting.
import * as path from 'node:path';

/** The scratch folder, relative to the project root, with forward slashes for prompts and git. */
export const SCRATCH_DIR = '.near-ai/scratch';

/** The lines a project's `.gitignore` needs so scratch work is never committed. */
export const SCRATCH_IGNORE_LINES: readonly string[] = Object.freeze(['.near-ai/scratch/', '.near-ai/attachments/', '.near-ai/state/']);

/**
 * The project's state home (D-04): chats, runs, saved comparisons and the project key, shared by every editor that opens this folder. It is
 * ignored by git on its own, through an inner `.gitignore` containing `*` that is written before anything else in it; the line above is a
 * second line of defense, not the guarantee.
 */
export const STATE_DIR = '.near-ai/state';

/** The absolute state home for a project. Nothing creates it except a person's action. */
export function stateFolder(root: string): string {
  return path.join(root, '.near-ai', 'state');
}

/** The absolute scratch folder for a project. */
export function scratchFolder(root: string): string {
  return path.join(root, '.near-ai', 'scratch');
}

/**
 * The sentence a run is given about scratch work. It is deliberately short and imperative: the agent reads it every turn, and the point is that
 * nothing it makes to think with should land anywhere else.
 */
export const SCRATCH_INSTRUCTIONS = `# Scratch work
Anything you make only to think with (a helper script, a downloaded page, a temporary extract) goes in \`${SCRATCH_DIR}/\` inside this project, never in /tmp or anywhere else on the machine. That folder is ignored by git and is emptied when the run ends. Run such a file from the project root (for example \`python3 ${SCRATCH_DIR}/verify.py\`), so it runs inside the project. Delete a scratch file when you are done with it; if it turns out to be part of the work, move it where it belongs and say so.`;

/** Whether a path (absolute or relative to the project) is inside the scratch folder. */
export function isScratchPath(root: string, target: string): boolean {
  const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
  const relative = path.relative(scratchFolder(root), absolute);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * What a `.gitignore` should gain: the lines it does not already have, in order. A file whose rules already cover the folder (a bare `.near-ai/`)
 * needs nothing, so the answer is empty for a project that ignores the whole folder.
 */
export function gitignoreAdditions(current: string): string[] {
  const lines = current.split('\n').map((line) => line.trim());
  const covered = (entry: string): boolean => {
    const needed = entry.replace(/\/$/, '');
    return lines.some((line) => {
      const rule = line.replace(/^!/, '').replace(/\/$/, '');
      if (line.startsWith('!')) return false;
      return rule === needed || needed.startsWith(`${rule}/`) || rule === '.near-ai' || rule === '.near-ai/';
    });
  };
  return SCRATCH_IGNORE_LINES.filter((entry) => !covered(entry));
}

// Which paths a name in the gate covers (owner-confirmed 2026-11-16, PR #70 review). A folder name covers everything under it: `src` and `src/` cover `src/**`,
// the way a person reading "src" means the folder and what is in it. A name never covers a sibling that only shares its prefix (`srcx/...`), and it is anchored at
// the project root. The root itself (`.`, `./`, an empty name, `**`) is `**`, as it always was. A glob keeps meaning exactly what it says. Pure, with no vscode.
import { normalizeRelative } from '../protectedPaths';
import { globToRegExp } from '../glob';

const GLOB_CHARACTERS = /[*?[{]/;

/** Whether a normalised project path is a glob rather than a plain folder or file name. */
function isGlob(normalised: string): boolean {
  return GLOB_CHARACTERS.test(normalised);
}

/**
 * What a path names when it is used as a folder: `src` and `src/` are `src/**`, the project root in any form is `**`, and a path that is already a glob
 * (`src/**`, `src/*.ts`, `**`) is left as it is. A file name gets `/**` too, which covers nothing more, so a caller that cannot tell a file from a folder
 * (a Grep path) can name both the path and its contents.
 */
export function contentsOf(folder: string): string {
  const normalised = normalizeRelative(folder);
  if (normalised === '') return '**';
  return isGlob(normalised) ? normalised : `${normalised}/**`;
}

/**
 * Whether `pattern` covers `target`, both project-relative. A plain name covers itself and everything under it; a glob covers what it matches; the root
 * covers every path inside the project. A target that climbs out of the project is covered by nothing.
 */
export function coversPath(pattern: string, target: string): boolean {
  const wanted = normalizeRelative(target);
  if (wanted === '..' || wanted.startsWith('../')) return false;
  const name = normalizeRelative(pattern);
  if (name === '' || name === '**') return true;
  if (isGlob(name)) return globToRegExp(name).test(wanted);
  return wanted === name || wanted.startsWith(`${name}/`);
}

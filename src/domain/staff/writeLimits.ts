// Where staff members may write (design 10, 3.1, 3.3 and 4.2; WP-J5). Pure: no I/O, no clock, no vscode.
//
// Every staff product is a file at `.planning/staff/products/<section>/<product>.md`, and the release guard writes its verdicts under
// `.planning/staff/guard/`. Most members keep to their own files by instruction and by the single-writer rule (ownership.ts). Two members are held to
// it by the extension: the red team, which critiques and must never change a plan file, and the release guard, which gives a verdict and must never fix
// the product it judges. For them the team runtime refuses any write outside the paths below, whatever the member's instructions or a model says.
import type { StaffSectionId } from './doctrine';
import type { StaffTeamBlock } from './teamBlock';

/** The folder every staff file lives in. */
export const STAFF_FOLDER = '.planning/staff';
/** The folder the release guard writes its verdicts to (`guard/<product>-v<n>.md` in a product header's `report:`). */
export const STAFF_GUARD_FOLDER = `${STAFF_FOLDER}/guard/`;
/** The red team's one product (kind `critique`). */
export const RED_TEAM_PRODUCT = 'red-team-critique';

/** The file of a product: `.planning/staff/products/<section>/<product>.md`. */
export function staffProductPath(section: StaffSectionId, product: string): string {
  return `${STAFF_FOLDER}/products/${section}/${product}.md`;
}

/**
 * The paths a member of a staff team may write, or undefined when the extension sets no limit for that member. An entry ending in `/` is a folder (the
 * folder and everything in it); any other entry is one file. A team without a `staff:` block has no limits here.
 */
export function staffWriteLimit(block: StaffTeamBlock | undefined, member: string): readonly string[] | undefined {
  if (!block) return undefined;
  if (member === 'red-team') return [staffProductPath(block.section, RED_TEAM_PRODUCT)];
  if (member === 'release-guard') return [STAFF_GUARD_FOLDER];
  return undefined;
}

/**
 * Whether a workspace-relative path (forward slashes, already resolved: no `.` or `..` segments) is inside a write limit. Compared exactly, case and all,
 * so `Products/` is not `products/`.
 */
export function writeAllowedBy(limit: readonly string[], relativePath: string): boolean {
  if (relativePath === '' || relativePath.startsWith('/') || relativePath.split('/').some((segment) => segment === '..' || segment === '.')) return false;
  return limit.some((entry) => (entry.endsWith('/') ? relativePath.startsWith(entry) && relativePath.length > entry.length : relativePath === entry));
}

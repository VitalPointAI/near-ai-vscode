// Where staff members may write (design 10, 3.1, 3.3 and 4.2; WP-J5). Pure: no I/O, no clock, no vscode.
//
// Every staff file lives under `.planning/staff/`: a product is `.planning/staff/products/<section>/<product>.md`, and a gate's report for one version
// is beside it in `guard/` or `tradecraft/` (ledger.ts gateReportPath). Most members keep to their own files by instruction and by the single-writer rule (ownership.ts). Two members are held to
// it by the extension: the red team, which critiques and must never change a plan file, and the release guard, which gives a verdict and must never fix
// the product it judges. For them the team runtime refuses any write outside the paths below, whatever the member's instructions or a model says.
import type { StaffSectionId } from './doctrine';
import type { ProductKind } from './products';
import type { StaffTeamBlock } from './teamBlock';

/** The folder every staff file lives in. */
export const STAFF_FOLDER = '.planning/staff';
/** The folder of one section's products: `.planning/staff/products/<section>/`. */
export function staffProductFolder(section: StaffSectionId): string {
  return `${STAFF_FOLDER}/products/${section}/`;
}

/** The folder a section's release-guard reports go to (`guard/<product>-v<n>.md` beside the products, as a product header's `report:` names it). */
export function staffGuardFolder(section: StaffSectionId): string {
  return `${staffProductFolder(section)}guard/`;
}
/** The red team's one product (kind `critique`). */
export const RED_TEAM_PRODUCT = 'red-team-critique';

/** The file of a product: `.planning/staff/products/<section>/<product>.md`. */
export function staffProductPath(section: StaffSectionId, product: string): string {
  return `${staffProductFolder(section)}${product}.md`;
}

/**
 * The paths a member of a staff team may write, or undefined when the extension sets no limit for that member. An entry ending in `/` is a folder (the
 * folder and everything in it); any other entry is one file. A team without a `staff:` block has no limits here.
 */
export function staffWriteLimit(block: Pick<StaffTeamBlock, 'section'> | undefined, member: string): readonly string[] | undefined {
  if (!block) return undefined;
  if (member === 'red-team') return [staffProductPath(block.section, RED_TEAM_PRODUCT)];
  if (member === 'release-guard') return [staffGuardFolder(block.section)];
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

/**
 * The product kinds a write-limited member may register (review round 4): the red team registers only critiques, the release guard nothing. Undefined
 * for a member with no write limit, whose kind follows its products.
 */
export function staffWriteLimitKinds(block: Pick<StaffTeamBlock, 'section'> | undefined, member: string): readonly ProductKind[] | undefined {
  if (!staffWriteLimit(block, member)) return undefined;
  return member === 'red-team' ? ['critique'] : [];
}

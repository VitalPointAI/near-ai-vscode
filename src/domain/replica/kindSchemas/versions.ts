// Data schemas for the versions family (D-23, D-24, D-27; DESIGN 6.1 to 6.3). Hub-side: pure, no Yjs; it must not import kinds.ts (no import cycle).
// It may import doctrine.ts for the section ids. Every shape is closed: a key outside the list refuses the whole entry.
import { isRecord } from '../../team/validate';
import { STAFF_SECTION_IDS } from '../../staff/doctrine';
import { exactKeys, invalidAt, isBase64urlBytes, isHash, isSlug } from './shared';

// The snapshot is a state vector plus a delete set; one MiB is far more than any real document needs.
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_PINS = 32;
export const MAX_DECISIONS_SEEN = 64;
export const MAX_REASONS = 20;
export const MAX_REASON_CHARS = 500;
export const MAX_TITLE_CHARS = 120;

export const GUARD_WORDS = ['CLEARED', 'HOLD'] as const;
export const TRADECRAFT_WORDS = ['SIGN-OFF', 'NOT READY'] as const;
export const DECISION_OUTCOMES = ['approve', 'reject', 'decline'] as const;

// One line of plain text: no control characters, not blank, at most max characters (the same rule release.ts applies to reasons).
function isLine(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function reasonsProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_REASONS) return invalidAt(path);
  for (let index = 0; index < value.length; index += 1) if (!isLine(value[index], MAX_REASON_CHARS)) return invalidAt(`${path}[${index}]`);
  return undefined;
}

function hashListProblem(value: unknown, path: string, max: number): string | undefined {
  if (!Array.isArray(value) || value.length > max) return invalidAt(path);
  for (let index = 0; index < value.length; index += 1) if (!isHash(value[index])) return invalidAt(`${path}[${index}]`);
  return undefined;
}

function pinsProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_PINS) return invalidAt(path);
  for (let index = 0; index < value.length; index += 1) {
    const pin: unknown = value[index];
    if (!isRecord(pin) || !exactKeys(pin, ['product', 'hash'])) return invalidAt(`${path}[${index}]`);
    if (!isSlug(pin.product)) return invalidAt(`${path}[${index}].product`);
    if (!isHash(pin.hash)) return invalidAt(`${path}[${index}].hash`);
  }
  return undefined;
}

// The role slugs of a product: the guard and the tradecraft reviewer are never the owner and never each other (a gate never checks its own work).
function rolesProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value) || !exactKeys(value, ['owner', 'sectionLead', 'releaseGuard'], ['tradecraftReviewer'])) return invalidAt(path);
  for (const key of ['owner', 'sectionLead', 'releaseGuard', 'tradecraftReviewer']) {
    if (value[key] !== undefined && !isSlug(value[key])) return invalidAt(`${path}.${key}`);
  }
  if (value.releaseGuard === value.owner) return invalidAt(path, 'guard is the owner');
  if (value.tradecraftReviewer !== undefined && (value.tradecraftReviewer === value.owner || value.tradecraftReviewer === value.releaseGuard)) return invalidAt(path, 'tradecraft reviewer is not distinct');
  return undefined;
}

// Returns a reason, or undefined when the data is valid.
export function validateVersionsData(kind: string, data: unknown, path: string): string | undefined {
  if (!isRecord(data)) return invalidAt(path);
  switch (kind) {
    case 'product.create':
      if (!exactKeys(data, ['product', 'section', 'roles', 'title'])) return invalidAt(path);
      if (!isSlug(data.product)) return invalidAt(`${path}.product`);
      if (typeof data.section !== 'string' || !(STAFF_SECTION_IDS as readonly string[]).includes(data.section)) return invalidAt(`${path}.section`);
      if (!isLine(data.title, MAX_TITLE_CHARS)) return invalidAt(`${path}.title`);
      return rolesProblem(data.roles, `${path}.roles`);
    case 'product.owner':
      if (!exactKeys(data, ['product', 'owner'])) return invalidAt(path);
      if (!isSlug(data.product)) return invalidAt(`${path}.product`);
      return isSlug(data.owner) ? undefined : invalidAt(`${path}.owner`);
    case 'version.propose':
      if (!exactKeys(data, ['product', 'hash', 'textBlob', 'snapshot', 'pins'])) return invalidAt(path);
      if (!isSlug(data.product)) return invalidAt(`${path}.product`);
      if (!isHash(data.hash)) return invalidAt(`${path}.hash`);
      if (!isHash(data.textBlob)) return invalidAt(`${path}.textBlob`);
      if (!isBase64urlBytes(data.snapshot, MAX_SNAPSHOT_BYTES)) return invalidAt(`${path}.snapshot`);
      return pinsProblem(data.pins, `${path}.pins`);
    case 'version.verdict': {
      if (!exactKeys(data, ['product', 'hash', 'gate', 'verdict', 'reasons'])) return invalidAt(path);
      if (!isSlug(data.product)) return invalidAt(`${path}.product`);
      if (!isHash(data.hash)) return invalidAt(`${path}.hash`);
      if (data.gate !== 'guard' && data.gate !== 'tradecraft') return invalidAt(`${path}.gate`);
      const words: readonly string[] = data.gate === 'guard' ? GUARD_WORDS : TRADECRAFT_WORDS;
      if (typeof data.verdict !== 'string' || !words.includes(data.verdict)) return invalidAt(`${path}.verdict`);
      // A HOLD without reasons is a refusal of the gate machine (release.ts: reasons-required), so an empty list is valid data.
      return reasonsProblem(data.reasons, `${path}.reasons`);
    }
    case 'version.submit':
      if (!exactKeys(data, ['product', 'hash', 'decisionFor'])) return invalidAt(path);
      if (!isSlug(data.product)) return invalidAt(`${path}.product`);
      if (!isHash(data.hash)) return invalidAt(`${path}.hash`);
      return isSlug(data.decisionFor) ? undefined : invalidAt(`${path}.decisionFor`);
    case 'version.withdraw':
      if (!exactKeys(data, ['product', 'hash', 'reason', 'decisionsSeen'])) return invalidAt(path);
      if (!isSlug(data.product)) return invalidAt(`${path}.product`);
      if (!isHash(data.hash)) return invalidAt(`${path}.hash`);
      if (!isLine(data.reason, MAX_REASON_CHARS)) return invalidAt(`${path}.reason`);
      return hashListProblem(data.decisionsSeen, `${path}.decisionsSeen`, MAX_DECISIONS_SEEN);
    case 'version.decide': {
      if (!exactKeys(data, ['product', 'hash', 'outcome', 'reasons', 'decisionsSeen'])) return invalidAt(path);
      if (!isSlug(data.product)) return invalidAt(`${path}.product`);
      if (!isHash(data.hash)) return invalidAt(`${path}.hash`);
      if (typeof data.outcome !== 'string' || !(DECISION_OUTCOMES as readonly string[]).includes(data.outcome)) return invalidAt(`${path}.outcome`);
      const reasons = reasonsProblem(data.reasons, `${path}.reasons`);
      return reasons ?? hashListProblem(data.decisionsSeen, `${path}.decisionsSeen`, MAX_DECISIONS_SEEN);
    }
    case 'version.release':
      if (!exactKeys(data, ['product', 'hash', 'decisionsSeen'])) return invalidAt(path);
      if (!isSlug(data.product)) return invalidAt(`${path}.product`);
      if (!isHash(data.hash)) return invalidAt(`${path}.hash`);
      return hashListProblem(data.decisionsSeen, `${path}.decisionsSeen`, MAX_DECISIONS_SEEN);
    case 'version.supersede':
      if (!exactKeys(data, ['product', 'hash', 'byHash'])) return invalidAt(path);
      if (!isSlug(data.product)) return invalidAt(`${path}.product`);
      if (!isHash(data.hash)) return invalidAt(`${path}.hash`);
      return isHash(data.byHash) ? undefined : invalidAt(`${path}.byHash`);
    default:
      return invalidAt(`${path}.kind`);
  }
}

// Data schemas for the integrity family (DESIGN 4.4, D-12): equivocation.proof and digest.report. Hub-side: pure, no Yjs; it must not import kinds.ts
// (no import cycle). Whether a proof actually proves anything is the fold's question (equivocation.ts); the schema only checks the shapes, so a
// proof with a header changed after signing still has a valid shape and is refused later as invalid-proof, on the record.
import { isStrictBase64url } from '../../team/canonical';
import { isRecord } from '../../team/validate';
import { STREAM_ID_PATTERN, parseHeaderShape } from '../entry';
import { exactKeys, invalidAt, isDep, isHash } from './shared';

// The most heads one digest report may carry (DESIGN 4.4); a report names the entries its digest covers.
export const MAX_REPORT_HEADS = 64;
const PUBLIC_KEY_BYTES = 32;

// Returns a reason, or undefined when the data is valid.
export function validateIntegrityData(kind: string, data: unknown, path: string): string | undefined {
  if (!isRecord(data)) return invalidAt(path);
  if (kind === 'equivocation.proof') {
    if (!exactKeys(data, ['a', 'b', 'publicKey'])) return invalidAt(path);
    if (!parseHeaderShape(data.a).ok) return invalidAt(`${path}.a`);
    if (!parseHeaderShape(data.b).ok) return invalidAt(`${path}.b`);
    if (typeof data.publicKey !== 'string' || !isStrictBase64url(data.publicKey, PUBLIC_KEY_BYTES)) return invalidAt(`${path}.publicKey`);
    return undefined;
  }
  if (kind === 'digest.report') {
    if (!exactKeys(data, ['stream', 'heads', 'digest'], ['checkpoint'])) return invalidAt(path);
    if (typeof data.stream !== 'string' || !STREAM_ID_PATTERN.test(data.stream)) return invalidAt(`${path}.stream`);
    if (!Array.isArray(data.heads) || data.heads.length > MAX_REPORT_HEADS) return invalidAt(`${path}.heads`);
    for (let index = 0; index < data.heads.length; index += 1) {
      if (!isDep(data.heads[index] as unknown)) return invalidAt(`${path}.heads[${index}]`);
    }
    if (!isHash(data.digest)) return invalidAt(`${path}.digest`);
    if (data.checkpoint !== undefined && !isHash(data.checkpoint)) return invalidAt(`${path}.checkpoint`);
    return undefined;
  }
  return invalidAt(`${path}.kind`);
}

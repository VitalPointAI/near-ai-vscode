// Data schemas for the versions family. Hub-side: pure, no Yjs; it must not import kinds.ts (no import cycle).
// Owner: 30-08. Until that plan writes the schema, every kind of this family is refused (fail closed).
import { schemaPending } from './shared';

// Returns a reason, or undefined when the data is valid.
export function validateVersionsData(kind: string, _data: unknown, _path: string): string | undefined {
  return schemaPending('versions', kind);
}

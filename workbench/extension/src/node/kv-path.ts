/**
 * Where a person's secrets live in OpenBao KV v2 (D-17, D-19; T-46-25; 46-07 planning choice 1). Each secret is at
 * `users/<entity id>/<service>/<account>` inside the KV mount (API `<mount>/data/users/...`), and the service and account strings, which any
 * extension chooses, are each encoded as "u" plus base64url. An encoded segment is never empty, never "." or "..", and holds no "/", so no
 * string can leave the person's prefix; the encoding is reversible, so keys() and findCredentials() can give the names back.
 *
 * This layout is part of the Phase 47 contract: once a site stores secrets under it, changing it needs a per-site KV path migration.
 * Nothing here imports Theia.
 */
import { SECRET_STORE_TEXT } from '../common/secret-store.js';

const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENCODED = /^u[A-Za-z0-9_-]*$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * "u" + base64url of the UTF-8 bytes. A string with an unpaired surrogate has no UTF-8 form of its own (two such strings would encode
 * alike), so it is refused.
 */
export function encodeSegment(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new Error(SECRET_STORE_TEXT.badName);
  return `u${Buffer.from(value, 'utf8').toString('base64url')}`;
}

/** The string an encoded segment stands for; throws for anything encodeSegment could not have made (a foreign or altered name). */
export function decodeSegment(segment: string): string {
  if (!ENCODED.test(segment)) throw new Error('Not an encoded secret name.');
  const value = Buffer.from(segment.slice(1), 'base64url').toString('utf8');
  if (encodeSegment(value) !== segment) throw new Error('Not an encoded secret name.');
  return value;
}

/** The person's folder for one service, `users/<entity id>/<encoded service>`. */
export function serviceFolder(entityId: string, service: string): string {
  if (!ENTITY_ID.test(entityId)) throw new Error('The session has no valid entity id.');
  return `users/${entityId}/${encodeSegment(service)}`;
}

/** The secret's path inside the KV mount, `users/<entity id>/<encoded service>/<encoded account>`. */
export function secretPath(entityId: string, service: string, account: string): string {
  return `${serviceFolder(entityId, service)}/${encodeSegment(account)}`;
}

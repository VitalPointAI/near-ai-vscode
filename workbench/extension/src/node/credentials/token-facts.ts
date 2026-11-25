/**
 * What credential code may know of the sign-in token (Phase 71, D-18; research 4.1): who signed in and how recently, nothing else. Keycloak only
 * authenticates. Access attributes come only from verified credentials, so groups, roles, profile attributes or any other claim in a token change
 * no decision. This is the one place under credentials/ that reads a token's payload, and it reads exactly sub, acr, auth_time and exp; the
 * token-claims test refuses any other read. The token's signature is checked by OpenBao's jwt login, not here.
 */

/** The four facts of a sign-in token that credential code uses. */
export interface TokenFacts {
  readonly sub: string;
  readonly acr?: string;
  /** Seconds since the epoch. */
  readonly authTime?: number;
  /** Seconds since the epoch. */
  readonly exp: number;
}

/** The four claims as a token carries them, each only when present with the right type; undefined when the payload does not read. Never throws. */
export function tokenClaimsOf(jwt: string | undefined): Partial<TokenFacts> | undefined {
  const parts = jwt?.split('.');
  if (parts === undefined || parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '')) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const { sub, acr, auth_time: authTime, exp } = payload as { sub?: unknown; acr?: unknown; auth_time?: unknown; exp?: unknown };
  return Object.freeze({
    ...(typeof sub === 'string' && sub !== '' ? { sub } : {}),
    ...(typeof exp === 'number' && Number.isFinite(exp) ? { exp } : {}),
    ...(typeof acr === 'string' ? { acr } : {}),
    ...(typeof authTime === 'number' && Number.isFinite(authTime) ? { authTime } : {}),
  });
}

/** The facts of a compact JWT, or undefined when it does not read or has no sub or exp. Never throws. */
export function tokenFactsOf(jwt: string | undefined): TokenFacts | undefined {
  const claims = tokenClaimsOf(jwt);
  return claims?.sub === undefined || claims.exp === undefined ? undefined : (claims as TokenFacts);
}

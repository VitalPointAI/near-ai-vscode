// A test JWT signer on node:crypto (46-02; no JOSE library, research "Don't Hand-Roll"): an ES256 key pair, sign(claims) making a compact
// JWT with an ieee-p1363 signature, and publicKeyPem for OpenBao's jwt_validation_pubkeys. Test tooling only.
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';

export interface TestSigner {
  readonly publicKeyPem: string;
  sign(claims: Record<string, unknown>): string;
}

const part = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export function makeTestSigner(): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign(claims) {
      const input = `${part({ alg: 'ES256', typ: 'JWT' })}.${part(claims)}`;
      const signature = signBytes('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return `${input}.${signature.toString('base64url')}`;
    },
  };
}

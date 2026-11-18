// TDX quote fixtures shared by the attestation tests and the connection binding tests: a quote signed the way Intel hardware signs one, chained to a test
// CA instead of Intel's root, and the trust options that accept that CA. Nothing here reaches the network.
import { createHash, createPrivateKey, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const FIXTURES = path.resolve(__dirname, '../../../test/fixtures/tdx');
export const TEST_CHAIN = readFileSync(path.join(FIXTURES, 'test-chain.pem'), 'utf8');
export const TEST_ROOT = new X509Certificate(TEST_CHAIN.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!.at(-1)!).fingerprint256;
const TEST_PCK_KEY = createPrivateKey(readFileSync(path.join(FIXTURES, 'test-pck-key.pem')));

/** A v4 TDX quote with the given report_data, signed the way Intel hardware signs one, but chained to the test CA. */
export function testQuote(reportData: Buffer, options: { chain?: string } = {}): string {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const attestationKey = Buffer.concat([Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  const header = Buffer.alloc(48); header.writeUInt16LE(4, 0); header.writeUInt16LE(2, 2); header.writeUInt32LE(0x81, 4);
  const body = Buffer.alloc(584); reportData.copy(body, 520);
  const signed = Buffer.concat([header, body]);
  const qeAuth = Buffer.alloc(32, 9);
  const qeReport = Buffer.alloc(384); createHash('sha256').update(attestationKey).update(qeAuth).digest().copy(qeReport, 320);
  const qeSignature = sign('sha256', qeReport, { key: TEST_PCK_KEY, dsaEncoding: 'ieee-p1363' });
  const chain = Buffer.from(options.chain ?? TEST_CHAIN);
  const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
  const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const certBody = Buffer.concat([qeReport, qeSignature, u16(qeAuth.length), qeAuth, u16(5), u32(chain.length), chain]);
  const auth = Buffer.concat([sign('sha256', signed, { key: privateKey, dsaEncoding: 'ieee-p1363' }), attestationKey, u16(6), u32(certBody.length), certBody]);
  return Buffer.concat([signed, u32(auth.length), auth]).toString('hex');
}

/** Trust options that accept the test CA in place of Intel's root. */
export const TRUST = { trustedRoot: TEST_ROOT };

// TDX quote fixtures shared by the attestation tests and the connection binding tests: a quote signed the way Intel hardware signs one, chained to a test
// CA instead of Intel's root, and the trust options that accept that CA. Nothing here reaches the network.
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { keccak256 } from '../../services/attestation';

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

// ---- An EIP-191 signer for tests (secp256k1 with keccak-256), so a fake NEAR server can sign any request and response the way NEAR does ----

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
type Point = { x: bigint; y: bigint } | undefined;
const G: Point = { x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n };
const mod = (value: bigint, m: bigint): bigint => { const result = value % m; return result >= 0n ? result : result + m; };
function inverse(value: bigint, m: bigint): bigint {
  let [a, b, x, y] = [mod(value, m), m, 1n, 0n];
  while (b) { const q = a / b; [a, b] = [b, a - q * b]; [x, y] = [y, x - q * y]; }
  return mod(x, m);
}
function add(a: Point, b: Point): Point {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y, P) === 0n) return undefined;
    const slope = 3n * a.x * a.x % P * inverse(2n * a.y, P) % P;
    const x = mod(slope * slope - 2n * a.x, P);
    return { x, y: mod(slope * (a.x - x) - a.y, P) };
  }
  const slope = mod(b.y - a.y, P) * inverse(mod(b.x - a.x, P), P) % P;
  const x = mod(slope * slope - a.x - b.x, P);
  return { x, y: mod(slope * (a.x - x) - a.y, P) };
}
function multiply(point: Point, scalar: bigint): Point {
  let result: Point;
  for (let addend = point; scalar > 0n; scalar >>= 1n) { if (scalar & 1n) result = add(result, addend); addend = add(addend, addend); }
  return result;
}
const bytes32 = (value: bigint): Buffer => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');

/** A test signing key from a seed, and its Ethereum-style address (lowercase 0x hex). */
export function testSigner(seed: string): { readonly key: bigint; readonly address: string } {
  const key = mod(BigInt(`0x${createHash('sha256').update(seed).digest('hex')}`), N - 1n) + 1n;
  const point = multiply(G, key)!;
  return { key, address: `0x${keccak256(Buffer.concat([bytes32(point.x), bytes32(point.y)])).subarray(12).toString('hex')}` };
}

/** Ethereum personal_sign of `text` with `key`: r, s (low s) and v, 65 bytes as 0x hex. */
export function personalSign(text: string, key: bigint): string {
  const body = Buffer.from(text, 'utf8');
  const e = BigInt(`0x${keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${String(body.length)}`, 'utf8'), body])).toString('hex')}`) % N;
  for (;;) {
    const k = mod(BigInt(`0x${randomBytes(32).toString('hex')}`), N - 1n) + 1n;
    const point = multiply(G, k)!;
    const r = point.x % N;
    if (r === 0n) continue;
    let s = inverse(k, N) * (e + r * key) % N;
    if (s === 0n) continue;
    let recovery = Number(point.y & 1n);
    if (s > N / 2n) { s = N - s; recovery ^= 1; }
    return `0x${bytes32(r).toString('hex')}${bytes32(s).toString('hex')}${(27 + recovery).toString(16)}`;
  }
}

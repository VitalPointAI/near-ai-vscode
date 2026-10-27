import { createHash, createPublicKey, randomBytes, verify, X509Certificate, type KeyObject } from 'node:crypto';

// Per-response verification for NEAR AI Cloud, following NEAR's reference verifier
// (github.com/nearai/nearai-cloud-verifier, ts/chat_verifier.ts and ts/model_verifier.ts):
//
// 1. `GET /v1/signature/{chat_id}?model=&signing_algo=ecdsa` returns `text` ("reqhash:resphash",
//    optionally prefixed), an EIP-191 `signature`, and the `signing_address`.
// 2. The hashes must equal SHA-256 of the exact request body sent and the raw response received.
// 3. The signature must recover to `signing_address`.
// 4. `GET /v1/attestation/report?model=&nonce=&signing_algo=ecdsa&signing_address=` returns the TDX
//    quote for that key. The quote must be genuine (signed by Intel-certified hardware, chained to
//    Intel's root CA), and its report_data must hold the address (bytes 0-31) and our fresh nonce
//    (bytes 32-63); GPU evidence, when present, must echo the nonce.
//
// Not checked here: the platform's TCB status and certificate revocation (Intel collateral), which
// code the enclave runs (its measurements against NEAR's published build), and NVIDIA's verdict.
// Results say so explicitly.

/** What a completion keeps so it can be verified later. Hashes only; no prompt or answer text. */
export interface ResponseEvidence { chatId: string; requestHash: string; responseHash: string }

export interface VerificationResult {
  outcome: 'signed' | 'failed' | 'unavailable';
  summary: string;
  signingAddress?: string;
  /** Which attested component holds the signing key. */
  signer?: 'model' | 'gateway';
  checks: { requestHash?: boolean; responseHash?: boolean; signature?: boolean; genuineQuote?: boolean; addressInQuote?: boolean; nonceInQuote?: boolean; gpuNonce?: boolean };
  notChecked: string[];
}

export const NOT_CHECKED_IN_EDITOR = ['platform TCB status and certificate revocation (Intel collateral)', 'which code the enclave runs (measurements)', 'NVIDIA GPU attestation verdict'];

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Verifies one response. `get` performs an authenticated GET against the provider's /v1 base. */
export async function verifyResponse(evidence: ResponseEvidence, model: string, get: (path: string) => Promise<unknown>, options: { nonce?: string; trustedRoot?: string; now?: Date } = {}): Promise<VerificationResult> {
  const nonce = options.nonce ?? randomBytes(32).toString('hex');
  const checks: VerificationResult['checks'] = {};
  const fail = (summary: string, signingAddress?: string): VerificationResult => ({ outcome: 'failed', summary, signingAddress, checks, notChecked: NOT_CHECKED_IN_EDITOR });
  let payload: { text?: unknown; signature?: unknown; signing_address?: unknown };
  try {
    payload = await get(`/signature/${encodeURIComponent(evidence.chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`) as typeof payload;
  } catch (error) {
    return { outcome: 'unavailable', summary: `NEAR AI did not return a signature for this response (${(error as Error).message}).`, checks, notChecked: NOT_CHECKED_IN_EDITOR };
  }
  if (typeof payload?.text !== 'string' || typeof payload.signature !== 'string' || typeof payload.signing_address !== 'string') return { outcome: 'unavailable', summary: 'NEAR AI returned no signature for this response.', checks, notChecked: NOT_CHECKED_IN_EDITOR };
  const address = payload.signing_address;
  const parts = payload.text.split(':');
  if (parts.length !== 2 && parts.length !== 3) return fail('The signed text is not in the expected "request-hash:response-hash" form.', address);
  const [requestHash, responseHash] = parts.slice(-2);
  checks.requestHash = requestHash.toLowerCase() === evidence.requestHash;
  checks.responseHash = responseHash.toLowerCase() === evidence.responseHash;
  let recovered: string | undefined;
  try { recovered = recoverPersonalSignAddress(payload.text, payload.signature); } catch { recovered = undefined; }
  checks.signature = recovered !== undefined && recovered === address.toLowerCase();
  if (!checks.requestHash) return fail('The signed request hash does not match the request this editor sent.', address);
  if (!checks.responseHash) return fail('The signed response hash does not match the response this editor received.', address);
  if (!checks.signature) return fail('The signature does not match the signing address.', address);

  let report: Record<string, unknown>;
  try {
    report = await get(`/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ecdsa&signing_address=${encodeURIComponent(address)}`) as Record<string, unknown>;
  } catch (error) {
    return fail(`The response is signed, but the attestation report could not be fetched (${(error as Error).message}).`, address);
  }
  const candidates = attestationsIn(report);
  const match = candidates.find((item) => item.attestation.signing_address.toLowerCase() === address.toLowerCase());
  if (!match) {
    const seen = candidates.map((item) => `${item.role} ${item.attestation.signing_address}`).join(', ');
    return fail(`The response is signed by ${address}, but NEAR AI's attestation report has no quote for that key (report fields: ${Object.keys(report ?? {}).join(', ') || 'none'}; keys attested: ${seen || 'none'}).`, address);
  }
  const attestation = match.attestation;
  let reportData: Buffer;
  try { reportData = verifyTdxQuote(attestation.intel_quote, { trustedRoot: options.trustedRoot, now: options.now }).reportData; } catch (error) { checks.genuineQuote = false; return fail(`The response is signed, but its attestation quote is not genuine: ${(error as Error).message}.`, address); }
  checks.genuineQuote = true;
  const fingerprint = typeof attestation.tls_cert_fingerprint === 'string' ? attestation.tls_cert_fingerprint : undefined;
  const addressBytes = Buffer.from(address.replace(/^0x/i, ''), 'hex');
  const expectedFirst = fingerprint ? createHash('sha256').update(addressBytes).update(Buffer.from(fingerprint, 'hex')).digest() : Buffer.concat([addressBytes, Buffer.alloc(32 - addressBytes.length)]);
  checks.addressInQuote = reportData.subarray(0, 32).equals(expectedFirst);
  checks.nonceInQuote = reportData.subarray(32, 64).equals(Buffer.from(nonce, 'hex'));
  if (typeof attestation.nvidia_payload === 'string') {
    try { checks.gpuNonce = String((JSON.parse(attestation.nvidia_payload) as { nonce?: unknown }).nonce).toLowerCase() === nonce.toLowerCase(); } catch { checks.gpuNonce = false; }
  }
  if (!checks.addressInQuote) return fail('The TDX quote does not bind the key that signed this response.', address);
  if (!checks.nonceInQuote) return fail('The TDX quote does not contain this request\'s fresh nonce, so it may be replayed.', address);
  if (checks.gpuNonce === false) return fail('The GPU attestation does not contain this request\'s fresh nonce.', address);
  return { outcome: 'signed', summary: `Signed by ${match.role === 'gateway' ? 'NEAR AI\'s gateway key' : 'the model\'s key'} ${address}. A genuine Intel TDX quote, fresh for this check, binds that key${checks.gpuNonce ? ', with matching GPU evidence' : ''}.`, signingAddress: address, signer: match.role, checks, notChecked: NOT_CHECKED_IN_EDITOR };
}

type Attestation = Record<string, unknown> & { signing_address: string; intel_quote: string };

/**
 * Every attestation in a report that names a signing key and carries a quote: the model's
 * (`model_attestations`, or a bare report), NEAR's gateway (`gateway_attestation`), and any other
 * list NEAR adds (`all_attestations`).
 */
function attestationsIn(report: Record<string, unknown> | undefined): Array<{ role: 'model' | 'gateway'; attestation: Attestation }> {
  const usable = (item: unknown): item is Attestation => Boolean(item) && typeof (item as Attestation).signing_address === 'string' && typeof (item as Attestation).intel_quote === 'string';
  const list = (value: unknown) => (Array.isArray(value) ? value : []).filter(usable);
  if (!report) return [];
  return [
    ...list(report.model_attestations).map((attestation) => ({ role: 'model' as const, attestation })),
    ...(usable(report) ? [{ role: 'model' as const, attestation: report }] : []),
    ...(usable(report.gateway_attestation) ? [{ role: 'gateway' as const, attestation: report.gateway_attestation }] : []),
    ...list(report.all_attestations).map((attestation) => ({ role: 'model' as const, attestation }))
  ];
}

/** SHA-256 fingerprint of Intel's SGX Root CA (certificates.trustedservices.intel.com), which also roots TDX quotes. */
export const INTEL_SGX_ROOT_CA_SHA256 = '44:A0:19:6B:2B:99:F8:89:B8:E1:49:E9:5B:80:7A:35:0E:74:24:96:43:99:E8:85:A7:CB:B8:CC:FA:B6:74:D3';

export interface TdxQuote { reportData: Buffer; mrTd: Buffer }

/**
 * Checks that a TDX quote was produced by genuine Intel hardware: the quote is signed by its
 * attestation key, the Quoting Enclave's report vouches for that key and is signed by the
 * platform's PCK certificate, and the PCK certificate chains to Intel's root CA.
 * Not checked: whether the platform's TCB is current or its certificate revoked (that needs
 * Intel's collateral), and which code the TD runs (its measurements).
 */
export function verifyTdxQuote(quoteHex: string, options: { trustedRoot?: string; now?: Date } = {}): TdxQuote {
  const quote = Buffer.from(quoteHex.replace(/^0x/i, ''), 'hex');
  const read = (offset: number, length: number): Buffer => {
    if (offset < 0 || offset + length > quote.length) throw new Error('quote is truncated');
    return quote.subarray(offset, offset + length);
  };
  const version = read(0, 2).readUInt16LE(0);
  if (read(2, 2).readUInt16LE(0) !== 2) throw new Error('quote is not signed with ECDSA P-256');
  if (read(4, 4).readUInt32LE(0) !== 0x81) throw new Error('quote is not a TDX quote');
  let bodyStart = 48;
  let bodyLength = 584;
  if (version === 5) { bodyLength = read(50, 4).readUInt32LE(0); bodyStart = 54; } else if (version !== 4) throw new Error(`unsupported quote version ${version}`);
  const signedLength = bodyStart + bodyLength;
  const body = read(bodyStart, bodyLength);
  let offset = signedLength + 4;
  const signature = read(offset, 64); offset += 64;
  const attestationKey = read(offset, 64); offset += 64;
  if (read(offset, 2).readUInt16LE(0) !== 6) throw new Error('quote has no Quoting Enclave report');
  offset += 6;
  const qeReport = read(offset, 384); offset += 384;
  const qeSignature = read(offset, 64); offset += 64;
  const authLength = read(offset, 2).readUInt16LE(0); offset += 2;
  const qeAuth = read(offset, authLength); offset += authLength;
  if (read(offset, 2).readUInt16LE(0) !== 5) throw new Error('quote does not embed its PCK certificate chain');
  const chainLength = read(offset + 2, 4).readUInt32LE(0);
  const chain = read(offset + 6, chainLength).toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.map((pem) => new X509Certificate(pem)) ?? [];
  if (chain.length < 2) throw new Error('quote has an incomplete certificate chain');

  const p1363 = (key: KeyObject) => ({ key, dsaEncoding: 'ieee-p1363' as const });
  let attestationPublicKey: KeyObject;
  try { attestationPublicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: attestationKey.subarray(0, 32).toString('base64url'), y: attestationKey.subarray(32).toString('base64url') }, format: 'jwk' }); } catch { throw new Error('the quote\'s attestation key is invalid'); }
  if (!verify('sha256', read(0, signedLength), p1363(attestationPublicKey), signature)) throw new Error('the quote signature is invalid');
  if (!verify('sha256', qeReport, p1363(chain[0].publicKey), qeSignature)) throw new Error('the Quoting Enclave report signature is invalid');
  if (!createHash('sha256').update(attestationKey).update(qeAuth).digest().equals(qeReport.subarray(320, 352))) throw new Error('the Quoting Enclave report does not vouch for the quote\'s key');
  const now = options.now ?? new Date();
  for (let index = 0; index < chain.length; index += 1) {
    const cert = chain[index];
    const issuer = chain[index + 1] ?? cert;
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) throw new Error(`certificate "${cert.subject.split('\n').find((line) => line.startsWith('CN=')) ?? cert.subject}" is not valid now`);
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) throw new Error('the PCK certificate chain is broken');
  }
  if (chain[chain.length - 1].fingerprint256 !== (options.trustedRoot ?? INTEL_SGX_ROOT_CA_SHA256)) throw new Error('the certificate chain does not end at Intel\'s root CA');
  // TD report body: report_data is the last 64 bytes of the TD 1.0 layout; MRTD is at offset 136.
  return { reportData: Buffer.from(body.subarray(520, 584)), mrTd: Buffer.from(body.subarray(136, 184)) };
}

// --- EIP-191 personal_sign recovery (secp256k1 + keccak-256), dependency-free ---

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Point = { x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n };
type Point = { x: bigint; y: bigint } | undefined;

/** The lowercase 0x address that signed `message` with Ethereum's personal_sign. */
export function recoverPersonalSignAddress(message: string, signatureHex: string): string {
  const signature = Buffer.from(signatureHex.replace(/^0x/i, ''), 'hex');
  if (signature.length !== 65) throw new Error('signature must be 65 bytes');
  const r = toBigInt(signature.subarray(0, 32));
  const s = toBigInt(signature.subarray(32, 64));
  const v = signature[64];
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error('bad recovery id');
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('signature out of range');
  const body = Buffer.from(message, 'utf8');
  const digest = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8'), body]));
  const e = toBigInt(digest) % N;
  const alpha = (r * r % P * r + 7n) % P;
  let y = modPow(alpha, (P + 1n) / 4n, P);
  if (y * y % P !== alpha) throw new Error('invalid signature point');
  if ((y & 1n) !== BigInt(recovery)) y = P - y;
  const rInverse = modInverse(r, N);
  const q = add(multiply({ x: r, y }, s * rInverse % N), multiply(G, (N - e) * rInverse % N));
  if (!q) throw new Error('invalid public key');
  const publicKey = Buffer.concat([toBytes32(q.x), toBytes32(q.y)]);
  return `0x${keccak256(publicKey).subarray(12).toString('hex')}`;
}

function mod(value: bigint, m: bigint): bigint { const result = value % m; return result >= 0n ? result : result + m; }
function modPow(base: bigint, exponent: bigint, m: bigint): bigint {
  let result = 1n; base = mod(base, m);
  for (; exponent > 0n; exponent >>= 1n) { if (exponent & 1n) result = result * base % m; base = base * base % m; }
  return result;
}
function modInverse(value: bigint, m: bigint): bigint {
  let [a, b, x, y] = [mod(value, m), m, 1n, 0n];
  while (b) { const q = a / b; [a, b] = [b, a - q * b]; [x, y] = [y, x - q * y]; }
  return mod(x, m);
}
function add(a: Point, b: Point): Point {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y, P) === 0n) return undefined;
    const slope = 3n * a.x * a.x % P * modInverse(2n * a.y, P) % P;
    const x = mod(slope * slope - 2n * a.x, P);
    return { x, y: mod(slope * (a.x - x) - a.y, P) };
  }
  const slope = mod(b.y - a.y, P) * modInverse(mod(b.x - a.x, P), P) % P;
  const x = mod(slope * slope - a.x - b.x, P);
  return { x, y: mod(slope * (a.x - x) - a.y, P) };
}
function multiply(point: Point, scalar: bigint): Point {
  let result: Point;
  for (let addend = point; scalar > 0n; scalar >>= 1n) { if (scalar & 1n) result = add(result, addend); addend = add(addend, addend); }
  return result;
}
function toBigInt(bytes: Buffer): bigint { return BigInt(`0x${bytes.toString('hex') || '0'}`); }
function toBytes32(value: bigint): Buffer { return Buffer.from(value.toString(16).padStart(64, '0'), 'hex'); }

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const MASK = (1n << 64n) - 1n;
const rotl = (value: bigint, shift: number): bigint => shift === 0 ? value : ((value << BigInt(shift)) | (value >> BigInt(64 - shift))) & MASK;

/** Keccak-256 as Ethereum uses it (original padding 0x01, not SHA3's 0x06). */
export function keccak256(data: Buffer): Buffer {
  const rate = 136;
  const padded = Buffer.alloc((Math.floor(data.length / rate) + 1) * rate);
  data.copy(padded);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i += 1) state[i] ^= padded.readBigUInt64LE(offset + i * 8);
    for (const constant of ROUND_CONSTANTS) {
      const c = [0, 1, 2, 3, 4].map((x) => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]);
      for (let x = 0; x < 5; x += 1) { const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) state[y + x] ^= d; }
      const b = new Array<bigint>(25);
      for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) b[y + ((2 * x + 3 * y) % 5) * 5] = rotl(state[x + y * 5], ROTATIONS[x + y * 5]);
      for (let x = 0; x < 5; x += 1) for (let y = 0; y < 25; y += 5) state[y + x] = b[y + x] ^ (~b[y + (x + 1) % 5] & MASK & b[y + (x + 2) % 5]);
      state[0] ^= constant;
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i += 1) out.writeBigUInt64LE(state[i], i * 8);
  return out;
}

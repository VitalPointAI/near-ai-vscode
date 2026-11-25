// `site-evidence` (48.2-06, D-13, D-17, D-23): makes the site trust document and signs the operator's site files. Registered in cli.ts by
// 48.2-12 (which also signs the trust document with your site key through 48.1-17's path and installs it as the install identity).
//
//   site-evidence make-trust --site <id> --collector-key <version>:<public key file> ... --operator-key <public key file>:<purpose,purpose>:<notAfter> ...
//                            --not-after <date> [--freshness <json>] --out <trust.json>
//   site-evidence sign --kind rescan|agreements --in <payload.json> --site <id> --key <pkcs8.pem> --out <signed.json>
//   site-evidence sign --kind rescan|agreements --in <payload.json> --site <id> --public-key <key> --emit-signing-input <bytes> --out <unsigned.json>
//   site-evidence sign --unsigned <unsigned.json> --attach-signature <signature> --out <signed.json>
//
// Public keys are Ed25519: a PEM SPKI file or the raw key in base64url. A date is YYYY-MM-DD (the start of that day, UTC) or an ISO time.
// The private key is read from its path only and never printed or written. Nothing is written when a check fails; an existing --out is kept.
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { SITE_ID } from '../collectors/deploymentChecks.ts';
import {
  attachSiteSignature, makeTrustDocument, parseAgreementsPayload, parseRescanPayload, SITE_AGREEMENTS_FORMAT, SITE_AGREEMENTS_PURPOSE, SITE_RESCAN_FORMAT,
  SITE_RESCAN_PURPOSE, siteSigningInput, type UnsignedSiteFile
} from '../siteEvidence.ts';

const USAGE = 'usage: site-evidence make-trust --site <id> --collector-key <version>:<public key> ... --operator-key <public key>:<purposes>:<notAfter> ... --not-after <date> [--freshness <json>] --out <file>\n'
  + '       site-evidence sign --kind rescan|agreements --in <payload> --site <id> (--key <pkcs8.pem> | --public-key <key> --emit-signing-input <file>) --out <file>\n'
  + '       site-evidence sign --unsigned <unsigned.json> --attach-signature <signature> --out <file>\n';
const MAX_SMALL_FILE_BYTES = 64 * 1024;

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
function options(args: readonly string[], name: string): string[] {
  return args.flatMap((value, index) => (value === name && index + 1 < args.length ? [args[index + 1]!] : []));
}
function readSmall(file: string, what: string): Buffer {
  const bytes = readFileSync(file);
  if (bytes.length > MAX_SMALL_FILE_BYTES) throw new Error(`the ${what} file is larger than ${MAX_SMALL_FILE_BYTES} bytes`);
  return bytes;
}
/** An Ed25519 public key file (PEM SPKI or raw base64url) as the raw key in base64url. */
function readPublicKey(file: string): string {
  const text = readSmall(file, 'public key').toString('utf8').trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(text)) return text;
  try {
    const key = createPublicKey(text);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    return (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64url');
  } catch {
    throw new Error(`${file} is not an Ed25519 public key`);
  }
}
/** 64 raw bytes, or their base64url or base64 text. */
function readSignature(file: string): Buffer {
  const bytes = readSmall(file, 'signature');
  if (bytes.length === 64) return bytes;
  const text = bytes.toString('utf8').trim();
  if (/^[A-Za-z0-9_-]{86}$/.test(text)) return Buffer.from(text, 'base64url');
  if (/^[A-Za-z0-9+/]{86}==$/.test(text)) return Buffer.from(text, 'base64');
  throw new Error('the --attach-signature file is not a 64-byte Ed25519 signature');
}
/** YYYY-MM-DD (the start of that day, UTC) or an ISO time, as a millisecond ISO time. */
function isoDate(value: string, what: string): string {
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(at)) throw new Error(`${what} is not a date`);
  return new Date(at).toISOString();
}
/** The exchange ids of the register this package carries (compliance/hosted/exchanges.json). */
function exchangeIds(): string[] {
  const register = JSON.parse(readFileSync(new URL('../../hosted/exchanges.json', import.meta.url), 'utf8')) as { exchanges: { id: string }[] };
  return register.exchanges.map(({ id }) => id);
}
const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function makeTrust(args: readonly string[]): number {
  const site = option(args, '--site');
  const notAfter = option(args, '--not-after');
  const out = option(args, '--out');
  if (!site || !notAfter || !out) return 2;
  if (!SITE_ID.test(site)) throw new Error('--site must be a plain id');
  const collectorKeys = options(args, '--collector-key').map((value) => {
    const match = /^(\d{1,6}):(.+)$/.exec(value);
    if (!match) throw new Error('--collector-key is <version>:<public key file>');
    return { version: Number(match[1]), publicKey: readPublicKey(match[2]!) };
  });
  const until = isoDate(notAfter, '--not-after');
  const operatorKeys = options(args, '--operator-key').map((value) => {
    const parts = value.split(':');
    if (parts.length < 3) throw new Error('--operator-key is <public key file>:<purpose,purpose>:<notAfter>');
    const end = parts.pop()!;
    const purposes = parts.pop()!.split(',').filter(Boolean);
    return { publicKey: readPublicKey(parts.join(':')), purposes, notAfter: isoDate(end, 'an --operator-key validity end') };
  });
  const freshnessText = option(args, '--freshness');
  let freshness: unknown;
  if (freshnessText !== undefined) {
    try { freshness = JSON.parse(freshnessText); } catch { throw new Error('--freshness is not JSON'); }
  }
  const document = makeTrustDocument({ site, notAfter: until, collectorKeys, operatorKeys, ...(freshness !== undefined ? { freshness } : {}) });
  writeFileSync(out, text(document), { flag: 'wx' });
  return 0;
}

function sign(args: readonly string[]): number {
  const out = option(args, '--out');
  const unsignedFile = option(args, '--unsigned');
  const signatureFile = option(args, '--attach-signature');
  if (!out) return 2;
  if (unsignedFile || signatureFile) {
    if (!unsignedFile || !signatureFile || option(args, '--kind') || option(args, '--in')) return 2;
    const unsigned = JSON.parse(readSmall(unsignedFile, 'unsigned').toString('utf8')) as UnsignedSiteFile;
    if (unsigned?.purpose === SITE_RESCAN_PURPOSE) parseRescanPayload(unsigned.payload);
    else if (unsigned?.purpose === SITE_AGREEMENTS_PURPOSE) parseAgreementsPayload(unsigned.payload, exchangeIds());
    else throw new Error('this is not an unsigned site rescan or agreements file');
    writeFileSync(out, text(attachSiteSignature(unsigned, readSignature(signatureFile))), { flag: 'wx' });
    return 0;
  }
  const kind = option(args, '--kind');
  const input = option(args, '--in');
  const site = option(args, '--site');
  const key = option(args, '--key');
  const publicKeyFile = option(args, '--public-key');
  const signingInputFile = option(args, '--emit-signing-input');
  if ((kind !== 'rescan' && kind !== 'agreements') || !input || !site || (key ? publicKeyFile || signingInputFile : !(publicKeyFile && signingInputFile))) return 2;
  const body = JSON.parse(readSmall(input, 'payload').toString('utf8')) as Record<string, unknown>;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('the payload is not a JSON object');
  if (body.site !== undefined && body.site !== site) throw new Error('the payload names another site than --site');
  const format = kind === 'rescan' ? SITE_RESCAN_FORMAT : SITE_AGREEMENTS_FORMAT;
  if (body.format !== undefined && body.format !== format) throw new Error(`the payload is not a ${format} payload`);
  const payload = kind === 'rescan' ? parseRescanPayload({ ...body, format, site }) : parseAgreementsPayload({ ...body, format, site }, exchangeIds());
  const purpose = kind === 'rescan' ? SITE_RESCAN_PURPOSE : SITE_AGREEMENTS_PURPOSE;
  const signedAt = new Date().toISOString();
  if (key) {
    let privateKey;
    let publicKey: string;
    try {
      privateKey = createPrivateKey(readSmall(key, 'key').toString('utf8'));
      publicKey = (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64url');
      if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    } catch {
      throw new Error('the --key file is not an Ed25519 PKCS#8 PEM private key');
    }
    const { unsigned, bytes } = siteSigningInput(purpose, payload, publicKey, signedAt);
    writeFileSync(out, text(attachSiteSignature(unsigned, edSign(null, bytes, privateKey))), { flag: 'wx' });
    return 0;
  }
  const { unsigned, bytes } = siteSigningInput(purpose, payload, readPublicKey(publicKeyFile!), signedAt);
  writeFileSync(out, text(unsigned), { flag: 'wx' });
  writeFileSync(signingInputFile!, bytes, { flag: 'wx' });
  return 0;
}

export async function run(args: readonly string[], io: { readonly stderr?: (text: string) => void } = {}): Promise<number> {
  const stderr = io.stderr ?? ((line: string) => { process.stderr.write(line); });
  const [verb, ...rest] = args;
  try {
    const code = verb === 'make-trust' ? makeTrust(rest) : verb === 'sign' ? sign(rest) : 2;
    if (code === 2) stderr(USAGE);
    return code;
  } catch (error) {
    stderr(`site-evidence: ${(error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' ')}\n`);
    return 1;
  }
}

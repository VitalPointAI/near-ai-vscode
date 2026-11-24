// `site-export` (48-02, D-16): turns a folder collected on a site by compliance/site-export/collect.sh into a signed deployment evidence export.
//
//   site-export --sources <dir> --site <id> --key <pkcs8.pem> --out <export.json>
//   site-export --sources <dir> --site <id> --public-key <key> --emit-signing-input <bytes> --out <unsigned.json>
//   site-export --unsigned <unsigned.json> --attach-signature <signature> --out <export.json>
//
// The first form signs with an Ed25519 key file. The other two let an external signer such as an HSM sign the exact bytes of the signing input:
// the public key is a PEM SPKI file or the raw key in base64url; the signature file holds the 64 raw bytes or their base64url or base64 text.
// The private key is read from its path only, never printed or written. Nothing is written when any check fails, and an existing --out is kept.
import { createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { SITE_EXPORT_PURPOSE, SITE_ID } from '../collectors/deployment.ts';
import { signingInput } from '../signed.ts';
import { assertNoSecretText, attachSignature, buildUnsignedExport, parseUnsignedExport, rawPublicKey, readSiteFacts, signExport } from '../siteExport.ts';

export interface SiteExportIo {
  readonly stderr?: (text: string) => void;
}

const USAGE = 'usage: site-export --sources <dir> --site <id> (--key <pkcs8.pem> | --public-key <key> --emit-signing-input <file>) --out <file>\n'
  + '       site-export --unsigned <unsigned.json> --attach-signature <signature> --out <file>\n';
const MAX_KEY_FILE_BYTES = 16 * 1024;

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

function readSmall(file: string, what: string): Buffer {
  const bytes = readFileSync(file);
  if (bytes.length > MAX_KEY_FILE_BYTES) throw new Error(`the ${what} file is larger than ${MAX_KEY_FILE_BYTES} bytes`);
  return bytes;
}

/** A PEM SPKI public key or the raw 32-byte key in base64url, as the raw base64url key. */
function readPublicKey(file: string): string {
  const text = readSmall(file, 'public key').toString('utf8').trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(text)) return text;
  try {
    return rawPublicKey(createPublicKey(text));
  } catch {
    throw new Error('the --public-key file is not an Ed25519 public key');
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

const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export async function run(args: readonly string[], io: SiteExportIo = {}): Promise<number> {
  const stderr = io.stderr ?? ((line: string) => { process.stderr.write(line); });
  const out = option(args, '--out');
  const sources = option(args, '--sources');
  const site = option(args, '--site');
  const key = option(args, '--key');
  const publicKey = option(args, '--public-key');
  const signingInputFile = option(args, '--emit-signing-input');
  const unsignedFile = option(args, '--unsigned');
  const signatureFile = option(args, '--attach-signature');
  const signs = Boolean(key);
  const emits = Boolean(publicKey && signingInputFile);
  const attaches = Boolean(unsignedFile && signatureFile);
  if (!out || [signs, emits, attaches].filter(Boolean).length !== 1 || (!attaches && (!sources || !site)) || (attaches && (sources || site))) {
    stderr(USAGE);
    return 2;
  }
  try {
    if (attaches) {
      const unsigned = parseUnsignedExport(JSON.parse(readFileSync(unsignedFile!, 'utf8')));
      const envelope = attachSignature(unsigned, readSignature(signatureFile!));
      assertNoSecretText({ ...envelope });
      writeFileSync(out, text(envelope), { flag: 'wx' });
      return 0;
    }
    if (!SITE_ID.test(site!)) throw new Error('--site must be a plain id (lower-case letters, digits and . _ / @ : -)');
    const facts = readSiteFacts(sources!);
    const generatedAt = new Date().toISOString();
    if (signs) {
      let pem: string;
      let signer: string;
      try {
        pem = readSmall(key!, 'key').toString('utf8');
        signer = rawPublicKey(createPublicKey(pem));
      } catch {
        throw new Error('the --key file is not an Ed25519 PKCS#8 PEM private key');
      }
      const envelope = signExport(buildUnsignedExport(site!, generatedAt, facts, signer), pem);
      writeFileSync(out, text(envelope), { flag: 'wx' });
      return 0;
    }
    const unsigned = buildUnsignedExport(site!, generatedAt, facts, readPublicKey(publicKey!));
    const bytes = signingInput(SITE_EXPORT_PURPOSE, { ...unsigned });
    writeFileSync(out, text(unsigned), { flag: 'wx' });
    writeFileSync(signingInputFile!, bytes, { flag: 'wx' });
    return 0;
  } catch (error) {
    stderr(`site-export: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

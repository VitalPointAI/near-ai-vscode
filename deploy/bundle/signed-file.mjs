#!/usr/bin/env node
// The one signature check for every signed file that crosses between sites (D-47, D-49): the bundle manifest, revocation lists, the signed
// Keycloak user export and the PKI intermediate certificate. A file's signature is the cosign Sigstore bundle beside it, <file>.sigstore.json,
// made with your organization's key; the public key always comes from the install media, never from beside the file.
//
//   node deploy/bundle/signed-file.mjs sign <file> --key <cosign key>            (COSIGN_PASSWORD in the environment)
//   node deploy/bundle/signed-file.mjs verify <file> --public-key <cosign pub>   exit 0 only when the signature verifies
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signBlob, verifyBlob } from './lib/cosign.mjs';

/** The signature file of a signed file. */
export const signatureFile = (file) => `${file}.sigstore.json`;

/** Signs `file` with the cosign key; returns the signature file's path. */
export function signFile(file, key, { cosign } = {}) {
  if (!existsSync(file)) throw new Error(`${file} does not exist.`);
  return signBlob(file, key, { cosign, bundleFile: signatureFile(file) });
}

/** Whether `file` carries a valid signature by `publicKey` (a public key file). Returns { ok, reason }; never throws for a bad signature. */
export function verifySignedFile(file, publicKey, { cosign } = {}) {
  if (!existsSync(file)) return { ok: false, reason: `${file} does not exist` };
  if (!existsSync(signatureFile(file))) return { ok: false, reason: `${path.basename(file)} has no signature (${path.basename(signatureFile(file))} is missing)` };
  if (!publicKey || !existsSync(publicKey)) return { ok: false, reason: `the public key ${publicKey || '(none given)'} does not exist` };
  const result = verifyBlob(file, signatureFile(file), publicKey, { cosign });
  return result.ok ? result : { ok: false, reason: `${path.basename(file)}: the signature does not verify with ${path.basename(publicKey)} (${result.reason})` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file, ...rest] = process.argv.slice(2);
  const option = (flag) => { const index = rest.indexOf(flag); return index < 0 ? undefined : rest[index + 1]; };
  const usage = 'usage: signed-file.mjs sign <file> --key <cosign key> | verify <file> --public-key <cosign pub>';
  try {
    if (command === 'sign' && file && option('--key')) {
      console.log(`signed: ${signFile(file, option('--key'))}`);
    } else if (command === 'verify' && file && option('--public-key')) {
      const result = verifySignedFile(file, option('--public-key'));
      if (!result.ok) { console.error(`refused: ${result.reason}`); process.exit(1); }
      console.log(`verified: ${file}`);
    } else {
      console.error(usage);
      process.exit(command === '--help' ? 0 : 2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

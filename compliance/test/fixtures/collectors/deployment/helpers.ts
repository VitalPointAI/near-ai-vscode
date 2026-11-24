// Test-only helpers for the deployment evidence tests (48-02). Every key is generated when the test runs; no key material is in the repository.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintOf } from '../../../../src/signed.ts';
import type { CollectorContext } from '../../../../src/collectors/types.ts';

export const DEPLOYMENT_FIXTURES = path.dirname(fileURLToPath(import.meta.url));

export interface TestKey { readonly privateKeyPem: string; readonly publicKey: string; readonly fingerprint: string }

/** A fresh Ed25519 key pair, as the PKCS#8 PEM a site operator would hold and the base64url public key a trust list holds. */
export function freshKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: raw.toString('base64url'), fingerprint: fingerprintOf(raw) };
}

/** A site trust list naming the given keys, in the signers.json shape. */
export function signersText(...keys: readonly TestKey[]): string {
  return `${JSON.stringify({ signers: keys.map((key, index) => ({ name: `Fixture site operator ${index + 1}`, role: 'Site operator', publicKey: key.publicKey, fingerprint: key.fingerprint })) }, null, 2)}\n`;
}

/** The facts of a site that meets every check (facts.json), as a fresh copy a test may change. */
export function compliantFacts(): any {
  return JSON.parse(readFileSync(path.join(DEPLOYMENT_FIXTURES, 'facts.json'), 'utf8'));
}

export const tempDir =(): string => mkdtempSync(path.join(realpathSync(tmpdir()), 'near-ai-deployment-'));

/** A collector context that reads real files. */
export function fileContext(now: Date, commit: string): CollectorContext {
  return { now, commit, readFile: (file) => readFile(file, 'utf8') };
}

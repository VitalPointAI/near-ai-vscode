// Test-only: signs fixture files as cosign 3.1.4 `sign-blob --key <ECDSA P-256 key> --signing-config <empty> --bundle` does, with Node crypto,
// so the browser and container checks need no cosign binary (the workbench CI job installs none: CI never signs the workbench image). Each test
// run makes its own throwaway key pairs. deploy/test/sigstore-parity.test.mjs holds the output equal to what the pinned cosign accepts.
// It lives under workbench/test, which neither the image build context (Dockerfile.dockerignore) nor the VSIX (.vscodeignore) takes in.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/** The Sigstore bundle media type cosign 3.1.4 writes. */
const MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json';

export interface FixtureKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** The public key as cosign writes `<prefix>.pub`: an SPKI PEM. */
  readonly publicKeyPem: string;
}

/** A throwaway ECDSA P-256 key pair, the key type cosign generate-key-pair makes. */
export function fixtureKey(): FixtureKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** The key-mode Sigstore bundle cosign writes. */
export interface FixtureBundle {
  mediaType: string;
  verificationMaterial: { publicKey: { hint: string } };
  messageSignature: { messageDigest: { algorithm: 'SHA2_256'; digest: string }; signature: string };
}

/** A key-mode Sigstore bundle over `content`: the public key hint, the SHA-256 message digest and an ASN.1 DER ECDSA signature, no tlog. */
export function fixtureBundle(content: Uint8Array, key: FixtureKey): FixtureBundle {
  return {
    mediaType: MEDIA_TYPE,
    verificationMaterial: { publicKey: { hint: createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('base64') } },
    messageSignature: {
      messageDigest: { algorithm: 'SHA2_256', digest: createHash('sha256').update(content).digest('base64') },
      signature: sign('sha256', content, key.privateKey).toString('base64'),
    },
  };
}

/** Signs `file` with `key` and writes the bundle to `bundleFile` (cosign's default name `<file>.sigstore.json` when absent). */
export function signFixture(file: string, key: FixtureKey, bundleFile = `${file}.sigstore.json`): string {
  writeFileSync(bundleFile, JSON.stringify(fixtureBundle(readFileSync(file), key)));
  return bundleFile;
}

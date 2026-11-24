// The cosign calls of the bundle pipeline, with the flags spike S1 proved on cosign 3.1.4 (47-01-SUMMARY.md): key-pair signing only, an empty
// signing config instead of --tlog-upload=false (no transparency log, no timestamp authority, never keyless), and verification with
// --insecure-ignore-tlog, which skips only the transparency-log lookup, never the signature check. The binary comes from $COSIGN or PATH.
// The private key's password is read by cosign from COSIGN_PASSWORD in the environment; it is never an argument (T-47-20).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The empty signing config `cosign signing-config create` writes: no Rekor and no timestamp authority. */
export const EMPTY_SIGNING_CONFIG = Object.freeze({ mediaType: 'application/vnd.dev.sigstore.signingconfig.v0.2+json', rekorTlogConfig: {}, tsaConfig: {} });

/** The cosign binary to run: an explicit path, $COSIGN, or `cosign` on PATH. A relative path is taken from the working directory. */
export const cosignBinary = (cosign) => {
  const binary = cosign || process.env.COSIGN || 'cosign';
  return binary.includes('/') ? path.resolve(binary) : binary;
};

/** Runs cosign; returns { ok, status, stdout, stderr }. A missing binary throws a plain message. */
export function runCosign(args, { cosign, env } = {}) {
  const binary = cosignBinary(cosign);
  const run = spawnSync(binary, args, { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  if (run.error?.code === 'ENOENT') throw new Error(`cosign was not found (${binary}); set COSIGN to the cosign binary or put it on PATH.`);
  if (run.error) throw run.error;
  return { ok: run.status === 0, status: run.status, stdout: run.stdout, stderr: run.stderr.trim() };
}

/** Calls `use(file)` with a temporary empty signing config file, then removes it. */
function withSigningConfig(use) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-cosign-'));
  try {
    const file = path.join(dir, 'signing-config.json');
    writeFileSync(file, JSON.stringify(EMPTY_SIGNING_CONFIG));
    return use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fail = (what, run) => { throw new Error(`cosign ${what} failed: ${run.stderr || `exit ${run.status}`}`); };

/** Signs a file with the key; writes the Sigstore bundle to `bundleFile` (default <file>.sigstore.json). */
export function signBlob(file, key, { cosign, bundleFile = `${file}.sigstore.json` } = {}) {
  const run = withSigningConfig((config) => runCosign(['sign-blob', '--key', key, '--signing-config', config, '--bundle', bundleFile, '-y', file], { cosign }));
  if (!run.ok) fail(`sign-blob ${file}`, run);
  return bundleFile;
}

/** Whether `bundleFile` is a valid signature of `file` by the public key. Returns { ok, reason }. */
export function verifyBlob(file, bundleFile, publicKey, { cosign } = {}) {
  const run = runCosign(['verify-blob', '--key', publicKey, '--insecure-ignore-tlog', '--bundle', bundleFile, file], { cosign });
  return run.ok ? { ok: true, reason: '' } : { ok: false, reason: run.stderr || `cosign verify-blob exit ${run.status}` };
}

/** Signs an image by digest in a registry (the signature is stored there as an OCI referrer). */
export function signImage(ref, key, { cosign, allowHttp = false, env } = {}) {
  const run = withSigningConfig((config) => runCosign(['sign', '--key', key, '--signing-config', config, ...(allowHttp ? ['--allow-http-registry'] : []), '-y', ref], { cosign, env }));
  if (!run.ok) fail(`sign ${ref}`, run);
}

/** Whether the image digest in a registry carries a valid signature by the public key. Returns { ok, reason }. */
export function verifyImage(ref, publicKey, { cosign, allowHttp = false, env } = {}) {
  const run = runCosign(['verify', '--key', publicKey, '--insecure-ignore-tlog', ...(allowHttp ? ['--allow-http-registry'] : []), ref], { cosign, env });
  return run.ok ? { ok: true, reason: '' } : { ok: false, reason: run.stderr || `cosign verify exit ${run.status}` };
}

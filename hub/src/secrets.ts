// Copied from relay/src/secrets.ts and adapted for the hub (D-28). The relay's tenant keys, Teams secret and pseudonym key are not copied; the hub
// has its own four secrets, and two of them are PEM files that hold line breaks.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Redactor } from './log/redact';

// Secret custody (D-26, D-29, D-30). The hub takes every secret from an operator-supplied file and from nowhere else:
//  1. the file named by {NAME}_FILE, then
//  2. $CREDENTIALS_DIRECTORY/{lowercase name} (systemd credentials), then
//  3. /run/secrets/{lowercase name} (Compose and Docker secrets).
// A secret given as a plain environment value is refused: it shows up in docker inspect and in process listings. The hub never writes a secret
// (its keys are made by --generate-key on stdout for the operator to save), and every value is registered with the Redactor the moment it is
// read, so no later log line or error can carry it. Every SecretError message names the secret and never a value or any file content.
//
// HUB_SECRETS holds no model credential: Phase 32's hub makes no model calls and opens no outbound connection (D-62).

/** 'line' is one line of text (the hub key lines); 'pem' is a PEM file, which holds line breaks and must start with -----BEGIN followed by a space. */
export type SecretKind = 'line' | 'pem';

export interface SecretSpec {
  name: string;
  kind: SecretKind;
  required: boolean;
  description: string;
}

/** The hub's secrets. All four are needed to serve. */
export const HUB_SECRETS: readonly SecretSpec[] = [
  { name: 'HUB_TLS_CERT', kind: 'pem', required: true, description: "The hub's TLS certificate (and any chain), from your organization's CA or self-signed." },
  { name: 'HUB_TLS_KEY', kind: 'pem', required: true, description: "The private key of the hub's TLS certificate." },
  { name: 'HUB_SIGNING_KEY', kind: 'line', required: true, description: "The hub's Ed25519 signing key line, made with --generate-key signing." },
  { name: 'HUB_ENCRYPTION_KEY', kind: 'line', required: true, description: "The hub's X25519 encryption key line, made with --generate-key encryption." },
];

export class SecretError extends Error {
  readonly secretName: string;
  constructor(secretName: string, message: string) {
    super(message);
    this.name = 'SecretError';
    this.secretName = secretName;
  }
}

export interface SecretSources {
  env: NodeJS.ProcessEnv;
  /** Where Compose and Docker secrets live. Defaults to /run/secrets; tests pass a temporary directory. */
  runSecretsDir?: string;
}

const MIN_SECRET_LENGTH = 8;
export const MAX_LINE_SECRET_BYTES = 16384;
export const MAX_PEM_SECRET_BYTES = 65536;
const PEM_START = '-----BEGIN ';
const GROUP_OR_WORLD = 0o077;
// A PEM line long enough to be worth masking on its own: a log line that carried one line of a key must not show it either.
const MIN_MASKED_PEM_LINE = 16;

const maxBytesOf = (kind: SecretKind): number => (kind === 'pem' ? MAX_PEM_SECRET_BYTES : MAX_LINE_SECRET_BYTES);

/**
 * Throws for the first secret given as a plain environment value. Names are compared in any case. A name ending in _FILE is a path and allowed only
 * when what it points for is a secret name (HUB_TLS_KEY_FILE).
 */
export function refusePlainSecretEnv(env: NodeJS.ProcessEnv, specs: readonly SecretSpec[] = HUB_SECRETS): void {
  const known = new Set(specs.map((spec) => spec.name));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue;
    const upper = name.toUpperCase();
    if (upper.endsWith('_FILE') && known.has(upper.slice(0, -'_FILE'.length))) continue;
    if (known.has(upper)) {
      throw new SecretError(
        name,
        `${name} is set as a plain environment value, which shows up in docker inspect and process listings. Put the secret in a file and set ${upper}_FILE, or use a Compose or systemd secret.`,
      );
    }
  }
}

function cannotRead(name: string): SecretError {
  const uid = process.getuid?.();
  const who = uid === undefined ? "the hub's user" : `the hub's user (uid ${uid})`;
  return new SecretError(name, `${name}: the file exists but ${who} cannot read it. Give it to that user with mode 0400 or 0600.`);
}

/** Reads and checks one secret file through one opened descriptor, so what was checked is what was read. Returns undefined only for a missing file when allowMissing. */
async function readSecretFile(spec: Pick<SecretSpec, 'name' | 'kind'>, file: string, allowMissing: boolean, label: string): Promise<string | undefined> {
  const { name, kind } = spec;
  const maxBytes = maxBytesOf(kind);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK); // O_NONBLOCK: a named pipe at the path must not hang the open
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (allowMissing) return undefined;
      throw new SecretError(name, `${label}: the file it points to does not exist. Check the path.`);
    }
    if (code === 'EACCES' || code === 'EPERM') throw cannotRead(name);
    throw new SecretError(name, `${name}: the file could not be opened (${code ?? 'error'}).`);
  }
  try {
    const info = await handle.stat(); // fstat on the opened descriptor: no gap between the check and the read
    if (!info.isFile()) throw new SecretError(name, `${name}: the path is not a regular file.`);
    if ((info.mode & GROUP_OR_WORLD) !== 0) {
      throw new SecretError(name, `${name}: the file is readable or writable by group or others; run chmod 600 (or 400) on it.`);
    }
    if (info.size === 0) throw new SecretError(name, `${name}: the file is empty.`);
    if (info.size > maxBytes) throw new SecretError(name, `${name}: the file is larger than ${maxBytes} bytes.`);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new SecretError(name, `${name}: the file is larger than ${maxBytes} bytes.`);
    let value = buffer.toString('utf8', 0, bytesRead);
    if (kind === 'pem') {
      if (!value.startsWith(PEM_START)) throw new SecretError(name, `${name}: the file is not a PEM file; it must start with -----BEGIN followed by the block name.`);
      return value;
    }
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    else if (value.endsWith('\n')) value = value.slice(0, -1);
    if (/[\r\n]/.test(value)) throw new SecretError(name, `${name}: the file holds a line break inside the value; it must be one line.`);
    if (value.length < MIN_SECRET_LENGTH) {
      throw new SecretError(name, `${name}: the value is shorter than ${MIN_SECRET_LENGTH} characters.`);
    }
    return value;
  } catch (error) {
    if (error instanceof SecretError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw cannotRead(name);
    throw new SecretError(name, `${name}: the file could not be read (${code ?? 'error'}).`);
  } finally {
    await handle.close();
  }
}

/** Loads one secret from its first source that has it, or undefined when none does. */
export async function loadSecret(spec: Pick<SecretSpec, 'name' | 'kind'>, sources: SecretSources): Promise<string | undefined> {
  const { name } = spec;
  const lower = name.toLowerCase();
  const explicit = sources.env[`${name}_FILE`];
  if (explicit !== undefined && explicit !== '') {
    // An operator's typo in an explicit path must not fall through to another source.
    return readSecretFile(spec, explicit, false, `${name}_FILE`);
  }
  const credentials = sources.env.CREDENTIALS_DIRECTORY;
  if (credentials !== undefined && credentials !== '') {
    const found = await readSecretFile(spec, path.join(credentials, lower), true, name);
    if (found !== undefined) return found;
  }
  return readSecretFile(spec, path.join(sources.runSecretsDir ?? '/run/secrets', lower), true, name);
}

/** The parts of a value to register with the Redactor: the whole value, each long PEM line, and the key part of a key line (after its last colon). */
export function maskedParts(kind: SecretKind, value: string): string[] {
  const parts = new Set<string>([value]);
  if (kind === 'pem') {
    for (const line of value.split(/\r?\n/)) if (line.length >= MIN_MASKED_PEM_LINE && !line.startsWith('-----')) parts.add(line);
  } else {
    const tail = value.slice(value.lastIndexOf(':') + 1);
    if (tail.length >= MIN_SECRET_LENGTH) parts.add(tail);
  }
  return [...parts];
}

/** Loads every spec, registering each found value with the redactor at once. A missing required secret stops with its name only. */
export async function loadSecrets(
  specs: readonly SecretSpec[],
  sources: SecretSources,
  redactor: Redactor,
): Promise<ReadonlyMap<string, string>> {
  const loaded = new Map<string, string>();
  for (const spec of specs) {
    const value = await loadSecret(spec, sources);
    if (value === undefined) {
      if (spec.required) {
        throw new SecretError(spec.name, `${spec.name} is required and was not found in ${spec.name}_FILE, $CREDENTIALS_DIRECTORY or /run/secrets`);
      }
      continue;
    }
    for (const part of maskedParts(spec.kind, value)) redactor.register(spec.name, part);
    loaded.set(spec.name, value);
  }
  return loaded;
}

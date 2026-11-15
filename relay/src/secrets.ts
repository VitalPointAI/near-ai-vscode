import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { Redactor } from './log/redact';

// Secret custody (RELAY-04, D-08, D-09, D-10). The relay takes every secret from an operator-supplied file and from nowhere else:
//  1. the file named by {NAME}_FILE, then
//  2. $CREDENTIALS_DIRECTORY/{lowercase name} (systemd credentials), then
//  3. /run/secrets/{lowercase name} (Compose and Docker secrets).
// A secret given as a plain environment value is refused: it shows up in docker inspect and in process listings (D-08). Nothing a secret
// holds is ever written by the relay (D-09), and every value is registered with the Redactor the moment it is read, so no later log line or
// error can carry it. Every SecretError message names the secret and never a value or any file content.

export type SecretClass = 'teams-bot-secret' | 'tenant-near-ai-key' | 'signal-registration' | 'log-pseudonym-key';

export interface SecretClassInfo {
  description: string;
  /** 'file' secrets are read by the relay from a file; 'sidecar-volume' material lives in the sidecar's volume and the relay never reads it. */
  source: 'file' | 'sidecar-volume';
}

/** The four kinds of secret the relay's deployment holds (D-10, D-18). */
export const SECRET_CLASSES: Readonly<Record<SecretClass, SecretClassInfo>> = {
  'teams-bot-secret': {
    description: 'The Teams bot app secret, used to prove the relay is your bot to Microsoft.',
    source: 'file',
  },
  'tenant-near-ai-key': {
    description: 'A NEAR AI API key for one organization the relay serves, supplied as NEAR_AI_KEY_{TENANT} through a file.',
    source: 'file',
  },
  'signal-registration': {
    description: "The Signal registration lives in the sidecar's signal-config volume, which is itself the credential; the relay never reads it.",
    source: 'sidecar-volume',
  },
  'log-pseudonym-key': {
    description: 'The key behind the stable phone labels in logs (D-18); optional, because the relay creates its own key file when none is supplied.',
    source: 'file',
  },
};

export interface SecretSpec {
  name: string;
  secretClass: SecretClass;
  required: boolean;
}

/**
 * Secrets the relay itself knows by name. None is required in Phase 68: nothing uses the Teams secret until Phases 69 and 71, which flip
 * TEAMS_APP_SECRET to required when the Teams channel is configured.
 */
export const RELAY_SECRETS: readonly SecretSpec[] = [
  { name: 'TEAMS_APP_SECRET', secretClass: 'teams-bot-secret', required: false },
  { name: 'LOG_PSEUDONYM_KEY', secretClass: 'log-pseudonym-key', required: false },
];

/** A tenant NEAR AI key is named by the operator: NEAR_AI_KEY_ACME, NEAR_AI_KEY_TEAM_2 and so on. */
export const TENANT_KEY_NAME = /^NEAR_AI_KEY_[A-Z0-9_]{1,64}$/;

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
const MAX_SECRET_BYTES = 16384;
const GROUP_OR_WORLD = 0o077;

/** Throws for the first secret given as a plain environment value. Names ending in _FILE are paths and are allowed. */
export function refusePlainSecretEnv(env: NodeJS.ProcessEnv, specs: readonly SecretSpec[] = RELAY_SECRETS): void {
  const known = new Set(specs.map((spec) => spec.name));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue;
    if (name.endsWith('_FILE')) continue;
    if (known.has(name) || TENANT_KEY_NAME.test(name)) {
      throw new SecretError(
        name,
        `${name} is set as a plain environment value, which shows up in docker inspect and process listings. Put the secret in a file and set ${name}_FILE, or use a Compose or systemd secret.`,
      );
    }
  }
}

function cannotRead(name: string): SecretError {
  const uid = process.getuid?.();
  const who = uid === undefined ? "the relay's user" : `the relay's user (uid ${uid})`;
  return new SecretError(name, `${name}: the file exists but ${who} cannot read it. Give it to that user with mode 0400 or 0600.`);
}

/** Reads and checks one secret file through one opened descriptor, so what was checked is what was read. Returns undefined only for a missing file when allowMissing. */
async function readSecretFile(name: string, file: string, allowMissing: boolean, label: string): Promise<string | undefined> {
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
    if (info.size > MAX_SECRET_BYTES) throw new SecretError(name, `${name}: the file is larger than ${MAX_SECRET_BYTES} bytes.`);
    const buffer = Buffer.alloc(MAX_SECRET_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SECRET_BYTES) throw new SecretError(name, `${name}: the file is larger than ${MAX_SECRET_BYTES} bytes.`);
    let value = buffer.toString('utf8', 0, bytesRead);
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
export async function loadSecret(name: string, sources: SecretSources): Promise<string | undefined> {
  const lower = name.toLowerCase();
  const explicit = sources.env[`${name}_FILE`];
  if (explicit !== undefined && explicit !== '') {
    // An operator's typo in an explicit path must not fall through to another source.
    return readSecretFile(name, explicit, false, `${name}_FILE`);
  }
  const credentials = sources.env.CREDENTIALS_DIRECTORY;
  if (credentials !== undefined && credentials !== '') {
    const found = await readSecretFile(name, path.join(credentials, lower), true, name);
    if (found !== undefined) return found;
  }
  return readSecretFile(name, path.join(sources.runSecretsDir ?? '/run/secrets', lower), true, name);
}

/** Loads every spec, registering each found value with the redactor at once. A missing required secret stops with its name only. */
export async function loadSecrets(
  specs: readonly SecretSpec[],
  sources: SecretSources,
  redactor: Redactor,
): Promise<ReadonlyMap<string, string>> {
  const loaded = new Map<string, string>();
  for (const spec of specs) {
    const value = await loadSecret(spec.name, sources);
    if (value === undefined) {
      if (spec.required) {
        throw new SecretError(spec.name, `${spec.name} is required and was not found in ${spec.name}_FILE, $CREDENTIALS_DIRECTORY or /run/secrets`);
      }
      continue;
    }
    redactor.register(spec.name, value);
    loaded.set(spec.name, value);
  }
  return loaded;
}

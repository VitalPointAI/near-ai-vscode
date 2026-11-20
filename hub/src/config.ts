// Copied from relay/src/config.ts and adapted for the hub (D-28).
import path from 'node:path';
import { HUB_SECRETS } from './secrets';

// The hub reads a closed list of settings. Anything else that starts with HUB_ is a typo, and a typo of HUB_STATE_DIR must never silently fall
// back to the default directory, so it stops startup. The secret names and their NAME_FILE settings belong to the secret loader (src/secrets.ts),
// which refuses a plain secret with its own sentence, so they are left to it here. Errors name the variable and never repeat its value.

export const HUB_SETTINGS = ['HUB_HOST', 'HUB_PORT', 'HUB_STATE_DIR', 'HUB_PUBLIC_ADDRESS'] as const;

export interface HubConfig {
  host: string;
  port: number;
  stateDir: string;
  /** The address devices use to reach this hub (host or host:port), when the operator set one. */
  publicAddress: string | undefined;
}

export class ConfigError extends Error {
  variable: string;
  constructor(variable: string, reason: string) {
    super(`${variable}: ${reason}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8443;
const MAX_PUBLIC_ADDRESS = 253 + 6;

function isSecretSetting(name: string): boolean {
  return HUB_SECRETS.some((spec) => name === spec.name || name === `${spec.name}_FILE`);
}

export function loadConfig(env: NodeJS.ProcessEnv, defaults: { stateDir: string }): HubConfig {
  for (const name of Object.keys(env)) {
    if (name.startsWith('HUB_') && !(HUB_SETTINGS as readonly string[]).includes(name) && !isSecretSetting(name)) {
      throw new ConfigError(
        name,
        `unknown setting; the hub reads only ${HUB_SETTINGS.join(', ')} and the _FILE settings of ${HUB_SECRETS.map((spec) => spec.name).join(', ')}`,
      );
    }
  }

  let host = DEFAULT_HOST;
  const rawHost = env.HUB_HOST;
  if (rawHost !== undefined) {
    if (rawHost === '' || /\s/.test(rawHost)) throw new ConfigError('HUB_HOST', 'must be a non-empty host name or address without spaces');
    host = rawHost;
  }

  let port = DEFAULT_PORT;
  const rawPort = env.HUB_PORT;
  if (rawPort !== undefined) {
    if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw new ConfigError('HUB_PORT', 'must be a whole number from 0 to 65535');
    port = Number(rawPort);
  }

  let stateDir = defaults.stateDir;
  const rawStateDir = env.HUB_STATE_DIR;
  if (rawStateDir !== undefined) {
    if (!path.isAbsolute(rawStateDir)) throw new ConfigError('HUB_STATE_DIR', 'must be an absolute path');
    stateDir = rawStateDir;
  }

  let publicAddress: string | undefined;
  const rawPublic = env.HUB_PUBLIC_ADDRESS;
  if (rawPublic !== undefined && rawPublic !== '') {
    if (/[\s/\\@?#]/.test(rawPublic) || rawPublic.length > MAX_PUBLIC_ADDRESS) {
      throw new ConfigError('HUB_PUBLIC_ADDRESS', 'must be a host name or address, with an optional :port, without spaces, slashes or a scheme');
    }
    publicAddress = rawPublic;
  }

  return { host, port, stateDir, publicAddress };
}

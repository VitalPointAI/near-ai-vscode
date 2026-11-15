import path from 'node:path';

// The relay reads a closed list of settings. Anything else that starts with RELAY_ is a typo, and a typo of RELAY_STATE_DIR must never
// silently fall back to the default directory, so it stops startup. Errors name the variable and never repeat its value.

export const RELAY_SETTINGS = ['RELAY_HOST', 'RELAY_PORT', 'RELAY_STATE_DIR'] as const;

export interface RelayConfig {
  host: string;
  port: number;
  stateDir: string;
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
const DEFAULT_PORT = 8080;

export function loadConfig(env: NodeJS.ProcessEnv, defaults: { stateDir: string }): RelayConfig {
  for (const name of Object.keys(env)) {
    if (name.startsWith('RELAY_') && !(RELAY_SETTINGS as readonly string[]).includes(name)) {
      throw new ConfigError(name, `unknown setting; the relay reads only ${RELAY_SETTINGS.join(', ')}`);
    }
  }

  let host = DEFAULT_HOST;
  const rawHost = env.RELAY_HOST;
  if (rawHost !== undefined) {
    if (rawHost === '' || /\s/.test(rawHost)) throw new ConfigError('RELAY_HOST', 'must be a non-empty host name or address without spaces');
    host = rawHost;
  }

  let port = DEFAULT_PORT;
  const rawPort = env.RELAY_PORT;
  if (rawPort !== undefined) {
    if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw new ConfigError('RELAY_PORT', 'must be a whole number from 0 to 65535');
    port = Number(rawPort);
  }

  let stateDir = defaults.stateDir;
  const rawStateDir = env.RELAY_STATE_DIR;
  if (rawStateDir !== undefined) {
    if (!path.isAbsolute(rawStateDir)) throw new ConfigError('RELAY_STATE_DIR', 'must be an absolute path');
    stateDir = rawStateDir;
  }

  return { host, port, stateDir };
}

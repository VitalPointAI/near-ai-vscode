/**
 * The workbench's hosting settings (D-19, D-22, D-25). Hosted mode is chosen only by STERLING_OPENBAO_ADDR: unset or empty means local mode
 * ("this computer"), and nothing else, a missing sign-in header least of all, ever changes that. In hosted mode every setting is checked
 * here, at start, and an invalid one throws one plain sentence that begins with the setting's name; the backend prints it and exits,
 * because Retry cannot fix configuration (46-02 planning choice 3). Nothing here imports Theia.
 */

export interface LocalHostingConfig {
  readonly mode: 'local';
}

export interface HostedConfig {
  readonly mode: 'hosted';
  /** The OpenBao address without a trailing slash, for example https://openbao.example:8200. */
  readonly addr: string;
  /** The CA bundle (PEM) that signs OpenBao's certificate, from cert-manager. */
  readonly caFile?: string;
  readonly jwtMount: string;
  readonly jwtRole: string;
  readonly kvMount: string;
  readonly transitMount: string;
  /** The acr the identity provider issues after a fresh passkey or security key step-up; 46-07 refuses signing without it. */
  readonly stepUpAcr?: string;
  readonly stepUpMaxAgeSeconds: number;
  /** THEIACLOUD_SESSION_USER: the person this session was started for. */
  readonly sessionUser: string;
}

export type HostingConfig = LocalHostingConfig | HostedConfig;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const MOUNT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROLE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_MAX_AGE_SECONDS = 300;

/**
 * Checks a service address from a setting: an absolute https: URL, or http: to a loopback address only (an agent in the pod, or a test
 * server); no user name, password, query or fragment. Returns the parsed URL. 46-03 uses the same rule for its address settings.
 */
export function parseServiceAddress(value: string, setting: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${setting} must be an absolute address such as https://service.example:8200.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`${setting} must use https, or http only to a loopback address (127.0.0.1, ::1 or localhost).`);
  }
  if (url.username || url.password) throw new Error(`${setting} must not carry a user name or password.`);
  if (url.search || value.includes('?')) throw new Error(`${setting} must not carry a query.`);
  if (url.hash || value.includes('#')) throw new Error(`${setting} must not carry a fragment.`);
  return url;
}

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function mount(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = setting(env, name) ?? fallback;
  if (!MOUNT.test(value)) throw new Error(`${name} must be a mount name of lower-case letters, digits, "-" or "_" (no "/" or "..").`);
  return value;
}

export function readHostingConfig(env: NodeJS.ProcessEnv): HostingConfig {
  const rawAddr = setting(env, 'STERLING_OPENBAO_ADDR');
  if (rawAddr === undefined) return { mode: 'local' };
  const url = parseServiceAddress(rawAddr, 'STERLING_OPENBAO_ADDR');
  if (url.pathname !== '/') throw new Error('STERLING_OPENBAO_ADDR must be the server address only, with no path (the workbench adds /v1/).');
  const addr = `${url.protocol}//${url.host}`;

  const jwtRole = setting(env, 'STERLING_OPENBAO_JWT_ROLE') ?? 'sterling-workbench';
  if (!ROLE.test(jwtRole)) throw new Error('STERLING_OPENBAO_JWT_ROLE must be a role name of letters, digits, ".", "-" or "_".');

  const rawMaxAge = setting(env, 'STERLING_STEPUP_MAX_AGE_SECONDS');
  let stepUpMaxAgeSeconds = DEFAULT_MAX_AGE_SECONDS;
  if (rawMaxAge !== undefined) {
    if (!/^[0-9]{1,4}$/.test(rawMaxAge) || Number(rawMaxAge) < 1 || Number(rawMaxAge) > 3600) {
      throw new Error('STERLING_STEPUP_MAX_AGE_SECONDS must be a whole number of seconds from 1 to 3600.');
    }
    stepUpMaxAgeSeconds = Number(rawMaxAge);
  }

  const sessionUser = setting(env, 'THEIACLOUD_SESSION_USER');
  if (sessionUser === undefined) {
    throw new Error('THEIACLOUD_SESSION_USER must name the person this session was started for when STERLING_OPENBAO_ADDR is set.');
  }

  const caFile = setting(env, 'STERLING_OPENBAO_CA_FILE');
  const stepUpAcr = setting(env, 'STERLING_STEPUP_ACR');
  return {
    mode: 'hosted',
    addr,
    ...(caFile === undefined ? {} : { caFile }),
    jwtMount: mount(env, 'STERLING_OPENBAO_JWT_MOUNT', 'jwt'),
    jwtRole,
    kvMount: mount(env, 'STERLING_OPENBAO_KV_MOUNT', 'kv'),
    transitMount: mount(env, 'STERLING_OPENBAO_TRANSIT_MOUNT', 'transit'),
    ...(stepUpAcr === undefined ? {} : { stepUpAcr }),
    stepUpMaxAgeSeconds,
    sessionUser,
  };
}

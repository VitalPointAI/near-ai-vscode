/**
 * The addresses a frontend-originated backend request may reach (D-06, D-26, D-42): only the ones your organization configured.
 *
 *   STERLING_OPEN_VSX_URL     one address, or empty for none (no extension gallery is in the image; this only opens the door for one)
 *   STERLING_MODEL_SERVERS    a comma-separated list of at most 32 addresses, or empty for none
 *
 * Each address follows the shared rule (parseServiceAddress): https, or http only to a loopback address; no user name, password, query or
 * fragment; and no wildcard host. The allow list is the exact scheme://host[:port] of each address, never a pattern wider than that.
 * Nothing here contacts any address or imports Theia. In this phase these settings only feed the allow list; the organization-signed policy
 * replaces them after Phase 41.
 */
import { parseServiceAddress } from './hosting-config.js';

export interface OutboundSettings {
  readonly openVsxUrl?: URL;
  readonly modelServers: readonly URL[];
}

const MAX_MODEL_SERVERS = 32;

function address(value: string, setting: string): URL {
  const url = parseServiceAddress(value, setting);
  if (url.hostname.includes('*')) throw new Error(`${setting} must name exact hosts, never a wildcard.`);
  return url;
}

export function readOutboundSettings(env: NodeJS.ProcessEnv): OutboundSettings {
  const vsx = env.STERLING_OPEN_VSX_URL?.trim();
  if (vsx?.includes(',')) throw new Error('STERLING_OPEN_VSX_URL must be one address.');
  const openVsxUrl = vsx ? address(vsx, 'STERLING_OPEN_VSX_URL') : undefined;
  const entries = (env.STERLING_MODEL_SERVERS ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (entries.length > MAX_MODEL_SERVERS) throw new Error(`STERLING_MODEL_SERVERS must list at most ${MAX_MODEL_SERVERS} addresses.`);
  const modelServers = entries.map((entry) => address(entry, 'STERLING_MODEL_SERVERS'));
  return { ...(openVsxUrl ? { openVsxUrl } : {}), modelServers };
}

/** The exact origins of the configured addresses, each once, Open VSX first. */
export function allowedUrlPatterns(settings: OutboundSettings): string[] {
  const origins = [settings.openVsxUrl, ...settings.modelServers].filter((url): url is URL => url !== undefined).map((url) => url.origin);
  return [...new Set(origins)];
}

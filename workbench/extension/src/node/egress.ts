/**
 * The addresses a frontend-originated backend request may reach (D-06, D-26, D-42): only the ones your organization configured.
 *
 *   STERLING_OPEN_VSX_URL     one address, or empty for none (no extension gallery is in the image; this only opens the door for one)
 *   STERLING_MODEL_SERVERS    a JSON array of at most 32 address strings, such as ["https://models.example:8443/v1"]; unset, empty or
 *                             [] means none. This is the form Phase 47's site ConfigMap renders (toJson); anything else is refused.
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

/** The strings of the STERLING_MODEL_SERVERS JSON array; unset or empty is none. Never splits on commas (a URL may hold one). */
function modelServerEntries(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === 'string')) {
    throw new Error('STERLING_MODEL_SERVERS must be a JSON array of addresses, such as ["https://models.example:8443/v1"], or [] for none.');
  }
  return parsed;
}

export function readOutboundSettings(env: NodeJS.ProcessEnv): OutboundSettings {
  const vsx = env.STERLING_OPEN_VSX_URL?.trim();
  if (vsx?.includes(',')) throw new Error('STERLING_OPEN_VSX_URL must be one address.');
  const openVsxUrl = vsx ? address(vsx, 'STERLING_OPEN_VSX_URL') : undefined;
  const entries = modelServerEntries(env.STERLING_MODEL_SERVERS);
  if (entries.length > MAX_MODEL_SERVERS) throw new Error(`STERLING_MODEL_SERVERS must list at most ${MAX_MODEL_SERVERS} addresses.`);
  const modelServers = entries.map((entry) => address(entry, 'STERLING_MODEL_SERVERS'));
  return { ...(openVsxUrl ? { openVsxUrl } : {}), modelServers };
}

/** The exact origins of the configured addresses, each once, Open VSX first. */
export function allowedUrlPatterns(settings: OutboundSettings): string[] {
  const origins = [settings.openVsxUrl, ...settings.modelServers].filter((url): url is URL => url !== undefined).map((url) => url.origin);
  return [...new Set(origins)];
}

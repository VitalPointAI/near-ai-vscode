import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { checkKeys, isRecord } from '../../domain/gate/shape';
import type { NetworkFacts } from '../../domain/setup/network';
import { withCheckTimeout } from './probe';

const execFileAsync = promisify(execFile);
const READ_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 65_536;
const UNKNOWN: NetworkFacts = Object.freeze({ dnsSearch: Object.freeze([]), source: 'unknown' });
const DNS_SUFFIX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface CommandOptions {
  readonly shell: false;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly cwd: string;
  readonly windowsHide: true;
  readonly signal: AbortSignal;
}

export interface NetworkFactsDeps {
  readonly platform: string;
  readFile(path: string, options: { encoding: 'utf8'; signal: AbortSignal }): PromiseLike<string>;
  execFile(file: string, args: string[], options: CommandOptions): PromiseLike<{ stdout: string }>;
  tmpdir(): string;
}

export const WINDOWS_NETWORK_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  '$dnsSearch = @((Get-DnsClientGlobalSetting).SuffixSearchList | Where-Object { $_ })',
  "$gateways = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore |",
  "  Where-Object { $_.NextHop -ne '0.0.0.0' } | Select-Object -ExpandProperty NextHop -Unique)",
  '$gateway = if ($gateways.Count -eq 1) { $gateways[0] } else { $null }',
  '[pscustomobject]@{ dnsSearch = $dnsSearch; gateway = $gateway } | ConvertTo-Json -Compress',
].join('\n');

function ipv4(value: string): string | undefined {
  return isIP(value) === 4 && value !== '0.0.0.0' ? value : undefined;
}

function suffixes(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.toLowerCase().replace(/\.$/, ''))
    .filter((value) => value.length <= 253 && DNS_SUFFIX.test(value)))];
}

export function parseLinuxRoute(text: string): string | undefined {
  let lowest = Infinity;
  const gateways = new Set<string>();
  for (const line of text.split('\n')) {
    const [, destination, encoded, flags, , , metricText, mask] = line.trim().split(/\s+/);
    if (destination !== '00000000' || mask !== '00000000' || !/^[a-f0-9]{8}$/i.test(encoded) ||
        !/^[a-f0-9]{1,8}$/i.test(flags) || (Number.parseInt(flags, 16) & 3) !== 3 || !/^\d+$/.test(metricText)) continue;
    const metric = Number(metricText);
    if (!Number.isSafeInteger(metric) || metric > lowest) continue;
    const gateway = ipv4([...Buffer.from(encoded, 'hex')].reverse().join('.'));
    if (gateway === undefined) continue;
    if (metric < lowest) gateways.clear();
    lowest = metric;
    gateways.add(gateway);
  }
  return gateways.size === 1 ? gateways.values().next().value : undefined;
}

export function parseResolvConf(text: string): readonly string[] {
  return suffixes(text.split('\n').flatMap((line) => {
    const [directive, ...values] = line.split(/[#;]/, 1)[0].trim().split(/\s+/);
    return directive === 'search' || directive === 'domain' ? values : [];
  }));
}

export function parseDarwinRoute(text: string): string | undefined {
  const gateways = new Set([...text.matchAll(/^\s*gateway:[ \t]+(\S+)[ \t\r]*$/gm)]
    .map(([, gateway]) => ipv4(gateway)).filter((gateway) => gateway !== undefined));
  return gateways.size === 1 ? gateways.values().next().value : undefined;
}

export function parseDarwinDns(text: string): readonly string[] {
  return suffixes([...text.matchAll(/^\s*search domain\[\d+\][ \t]*:[ \t]*(\S+)[ \t\r]*$/gm)].map(([, suffix]) => suffix));
}

function facts(source: Exclude<NetworkFacts['source'], 'unknown'>, dnsSearch: readonly string[], gateway?: string): NetworkFacts {
  return dnsSearch.length === 0 && gateway === undefined ? UNKNOWN : {
    dnsSearch, source, ...(gateway === undefined ? {} : { gateway })
  };
}

export function parseWindowsNetwork(text: string): NetworkFacts {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { return UNKNOWN; }
  if (!isRecord(value) || checkKeys(value, '', ['dnsSearch'], ['gateway']) ||
      !Array.isArray(value.dnsSearch) || !value.dnsSearch.every((item): item is string => typeof item === 'string')) return UNKNOWN;
  const gateway = typeof value.gateway === 'string' ? ipv4(value.gateway) : undefined;
  if (value.gateway != null && gateway === undefined) return UNKNOWN;
  return facts('win32', suffixes(value.dnsSearch), gateway);
}

function bounded(text: string): string {
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new Error('Network facts output exceeds its limit');
  return text;
}

async function readCommand(deps: NetworkFactsDeps, absolute: string, fallback: string, args: readonly string[], options: CommandOptions): Promise<string> {
  const run = async (file: string) => {
    options.signal.throwIfAborted();
    return bounded((await deps.execFile(file, [...args], options)).stdout);
  };
  try {
    return await run(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
    return run(fallback);
  }
}

/** Read local OS configuration after the project discovery policy has authorized the attempt. */
export function readHostNetworkFacts(parent?: AbortSignal): Promise<NetworkFacts> {
  return readNetworkFacts({
    platform: process.platform, readFile, tmpdir,
    execFile: (file, args, options) => execFileAsync(file, args, { ...options, encoding: 'utf8' }),
  }, parent);
}

export async function readNetworkFacts(deps: NetworkFactsDeps, parent?: AbortSignal): Promise<NetworkFacts> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin' && deps.platform !== 'win32') return UNKNOWN;
  const reads = new AbortController();
  const operation = parent ? AbortSignal.any([parent, reads.signal]) : reads.signal;
  try {
    return await withCheckTimeout(operation, READ_TIMEOUT_MS, async (signal) => {
      if (deps.platform === 'linux') {
        const options = { encoding: 'utf8' as const, signal };
        const [route, resolver] = await Promise.all([
          deps.readFile('/proc/net/route', options), deps.readFile('/etc/resolv.conf', options)
        ]);
        return facts('linux', parseResolvConf(bounded(resolver)), parseLinuxRoute(bounded(route)));
      }

      const options: CommandOptions = {
        shell: false, timeout: READ_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, cwd: deps.tmpdir(), windowsHide: true, signal
      };
      if (deps.platform === 'darwin') {
        const [route, dns] = await Promise.all([
          readCommand(deps, '/sbin/route', 'route', ['-n', 'get', 'default'], options),
          readCommand(deps, '/usr/sbin/scutil', 'scutil', ['--dns'], options)
        ]);
        return facts('darwin', parseDarwinDns(dns), parseDarwinRoute(route));
      }

      const network = await readCommand(deps, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_NETWORK_COMMAND], options);
      return parseWindowsNetwork(network);
    });
  } catch {
    return UNKNOWN;
  } finally {
    reads.abort();
  }
}

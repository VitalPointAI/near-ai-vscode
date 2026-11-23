// Pure: IPv4 CIDR arithmetic with no network access.
export interface Cidr {
  readonly base: number;
  readonly prefix: number;
}

function addressNumber(text: string): number | undefined {
  const octets = text.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return undefined;
  return octets.reduce((address, octet) => address * 256 + Number(octet), 0);
}

function size(prefix: number): number {
  return 2 ** (32 - prefix);
}

export function parseCidr(text: string): Cidr | undefined {
  const match = /^([^/]+)\/(1[6-9]|2[0-9]|3[0-2])$/.exec(text);
  if (!match) return undefined;
  const address = addressNumber(match[1]);
  if (address === undefined) return undefined;
  const prefix = Number(match[2]);
  const block = size(prefix);
  return { base: Math.floor(address / block) * block, prefix };
}

export function cidrContains(cidr: Cidr, address: string): boolean {
  const value = addressNumber(address);
  return value !== undefined && value >= cidr.base && value < cidr.base + size(cidr.prefix);
}

export function hostCount(cidr: Cidr): number {
  return size(cidr.prefix) - (cidr.prefix < 31 ? 2 : 0);
}

export function firstUsableHost(cidr: Cidr): number {
  return cidr.base + (cidr.prefix < 31 ? 1 : 0);
}

export function* hostsOf(cidr: Cidr, cap: number): Generator<string> {
  const start = firstUsableHost(cidr);
  const end = start + Math.min(hostCount(cidr), Math.floor(cap));
  for (let address = start; address < end; address++) {
    yield [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join('.');
  }
}

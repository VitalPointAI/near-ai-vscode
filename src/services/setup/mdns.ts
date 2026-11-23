import { decodeMessage, encodeQuery } from '../../domain/setup/dnsWire';
import { ANNOUNCED_SERVICE } from '../../domain/setup/network';
import type { DiscoveryWays } from '../../domain/setup/network';
import type { ServerCandidate } from '../../domain/setup/servers';

export const MDNS_GROUP = '224.0.0.251';
export const MDNS_PORT = 5353;
export const BROWSE_WINDOW_MS = 2000;
export const MAX_ANNOUNCED = 32;
const SERVICE_NAME = `${ANNOUNCED_SERVICE}.local`;
const INSTANCE_SUFFIX = `.${SERVICE_NAME}`;
const INSTANCE_LABEL = /^(?:[^.\\]|\\[.\\])+$/;
const MAX_INSTANCE_NAME = 63;
const DNS_RESPONSE = 0x8000;
const OPCODE_OR_ERROR = 0x780f;

function dnsNameKey(name: string): string {
  return name.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

export interface DatagramLike {
  bind(port: number, callback?: () => void): void;
  send(msg: Uint8Array, port: number, address: string, callback?: (error: Error | null) => void): void;
  on(event: 'message', listener: (message: Uint8Array) => void): void;
  addListener?(event: 'error', listener: (error: Error) => void): void;
  close(): void;
  setMulticastTTL?(ttl: number): number;
  address(): { port: number };
}

export interface DiscoveryClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BrowseInput {
  readonly ways: DiscoveryWays;
  readonly createSocket: () => DatagramLike;
  readonly clock: DiscoveryClock;
  readonly windowMs?: number;
  readonly signal?: AbortSignal;
}

export async function browseAnnounced(input: BrowseInput): Promise<readonly ServerCandidate[]> {
  const { ways, createSocket, clock, signal } = input;
  const windowMs = input.windowMs ?? BROWSE_WINDOW_MS;
  if (!ways.announce || !ways.network || signal?.aborted || !Number.isFinite(windowMs) || windowMs <= 0) return [];
  const question = encodeQuery({ id: 0, questions: [{ name: SERVICE_NAME, type: 'PTR', unicastResponse: true }] });
  return new Promise(resolve => {
    const candidates: ServerCandidate[] = [];
    const instances = new Set<string>();
    const endpoints = new Set<string>();
    const deadline = clock.now() + windowMs;
    let socket: DatagramLike | undefined;
    let finished = false;
    let timer: unknown;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clock.clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      try {
        socket?.close();
      } catch {
        // A socket whose bind failed may already be closed.
      }
      resolve(candidates);
    };

    try {
      socket = createSocket();
      socket.addListener?.('error', finish);
      socket.on('message', bytes => {
        if (finished) return;
        const foundAt = clock.now();
        if (foundAt >= deadline) return finish();
        const decoded = decodeMessage(bytes);
        if (!decoded.ok) return;
        const { id, flags, answers, additionals } = decoded.message;
        if (id !== 0 || !(flags & DNS_RESPONSE) || (flags & OPCODE_OR_ERROR)) return;
        const records = [...answers, ...additionals].filter(record => record.ttl > 0);
        for (const ptr of answers) {
          if (ptr.kind !== 'ptr' || !ptr.ttl || dnsNameKey(ptr.name) !== SERVICE_NAME) continue;
          const instance = dnsNameKey(ptr.target);
          if (!instance.endsWith(INSTANCE_SUFFIX) || instances.has(instance)) continue;
          const label = ptr.target.slice(0, -INSTANCE_SUFFIX.length);
          if (!INSTANCE_LABEL.test(label)) continue;
          const srv = records.find(record => record.kind === 'srv' && dnsNameKey(record.name) === instance);
          if (srv?.kind !== 'srv' || !srv.target || srv.port === 0) continue;
          const target = dnsNameKey(srv.target);
          const address = records.find(record => (record.kind === 'a' || record.kind === 'aaaa')
            && dnsNameKey(record.name) === target);
          if (address?.kind !== 'a' && address?.kind !== 'aaaa') continue;
          const endpoint = `${address.address}:${srv.port}`;
          if (endpoints.has(endpoint)) continue;
          const name = label.replace(/\\([.\\])/g, '$1')
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_INSTANCE_NAME);
          instances.add(instance);
          endpoints.add(endpoint);
          candidates.push({
            target: { host: address.address, port: srv.port, scheme: 'https', source: 'announced' },
            foundBy: 'announced', name: name || undefined, foundAt,
          });
          if (candidates.length === MAX_ANNOUNCED) return finish();
        }
      });
      signal?.addEventListener('abort', finish, { once: true });
      timer = clock.setTimeout(finish, windowMs);
      if (signal?.aborted) return finish();
      const datagram = socket;
      datagram.bind(0, () => {
        if (finished) return;
        if (clock.now() >= deadline) return finish();
        try {
          // Keep the announcement request on the local link.
          datagram.setMulticastTTL?.(1);
          datagram.send(question, MDNS_PORT, MDNS_GROUP, error => {
            if (error) finish();
          });
        } catch {
          finish();
        }
      });
    } catch {
      finish();
    }
  });
}

import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import type { ProbeTarget } from '../../domain/setup/servers';
import { peerFingerprint } from '../connectionBinding';
import { probeOrigin, withCheckTimeout } from './probe';

export const NO_TLS_TEXT = "This server does not use an encrypted connection, so your organization's rules cannot list it.";
const PIN_TIMEOUT_MS = 3_000;

interface PinSocket {
  once(event: 'secureConnect' | 'error' | 'close', listener: () => void): unknown;
  getPeerCertificate(detailed: true): { raw?: Buffer } | undefined;
  destroy(): unknown;
}

export type TlsConnectLike = (options: Pick<ConnectionOptions, 'host' | 'port' | 'servername' | 'rejectUnauthorized'>) => PinSocket;

type PinRead = { ok: true; pin: string } | { ok: false; cause: string };
const noPin: PinRead = { ok: false, cause: NO_TLS_TEXT };

/** Collect the presented key through one handshake. The socket exposes no application data methods. */
export async function readSpkiPin(target: ProbeTarget, deps: {
  readonly connect: TlsConnectLike;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<PinRead> {
  const origin = probeOrigin(target);
  if (origin?.protocol !== 'https:') return noPin;
  const host = origin.hostname.replace(/^\[|\]$/g, '');
  try {
    const pin = await withCheckTimeout<string | undefined>(deps.signal, deps.timeoutMs ?? PIN_TIMEOUT_MS, (signal) => new Promise((resolve) => {
      // A candidate is not trusted. The caller must pin the later identification request to this key.
      const socket = deps.connect({ host, port: target.port, ...(isIP(host) === 0 ? { servername: host } : {}), rejectUnauthorized: false });
      let finished = false;
      const fail = () => finish();
      function finish(pin?: string): void {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', fail);
        socket.destroy();
        resolve(pin);
      }
      socket.once('error', fail);
      socket.once('close', fail);
      socket.once('secureConnect', () => {
        if (finished) return;
        let fingerprint: string | undefined;
        try { fingerprint = peerFingerprint(socket.getPeerCertificate(true), 'public-key-sha256'); } catch { /* No usable certificate. */ }
        finish(fingerprint);
      });
      signal.addEventListener('abort', fail, { once: true });
      if (signal.aborted) fail();
    }));
    return pin === undefined ? noPin : { ok: true, pin };
  } catch {
    return noPin;
  }
}

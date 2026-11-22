import { isLoopbackEndpointHost } from '../../domain/gate/endpoints';
import { PROBE_MAX_RESPONSE_BYTES, SIGNATURE_TIMEOUT_MS } from '../../domain/setup/servers';
import type { ProbeTarget } from '../../domain/setup/servers';

export interface ProbeAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly bytes: number;
}

export function probeOrigin(target: ProbeTarget): URL | undefined {
  const { host, port, scheme } = target;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (!/^(?:[a-z\d.-]+|\[[a-f\d:]+\])$/i.test(host)) return undefined;
  if (scheme === 'http-loopback' && (!isLoopbackEndpointHost(host) || target.tlsPin !== undefined)) return undefined;
  try {
    return new URL(`${scheme === 'http-loopback' ? 'http' : 'https'}://${host}:${port}`);
  } catch {
    return undefined;
  }
}

/** Settles on timeout even when an injected transport ignores the abort signal. */
export async function withCheckTimeout<T>(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work(signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function readProbeAnswer(response: Response, signal: AbortSignal): Promise<ProbeAnswer | undefined> {
  const { body, status } = response;
  if (body === null) return { status, bytes: 0 };
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PROBE_MAX_RESPONSE_BYTES) {
        cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks, bytes).toString('utf8').trimStart();
    if (text.startsWith('{') || text.startsWith('[')) {
      try { return { status, bytes, body: JSON.parse(text) as unknown }; } catch { /* Body is not JSON. */ }
    }
    return { status, bytes };
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export async function probeGet(
  target: ProbeTarget,
  path: string,
  deps: { fetch: typeof fetch; signal?: AbortSignal; timeoutMs?: number },
): Promise<ProbeAnswer | undefined> {
  const origin = probeOrigin(target);
  if (!origin || !path.startsWith('/')) return undefined;
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin || url.username || url.password) return undefined;
    return await withCheckTimeout(deps.signal, deps.timeoutMs ?? SIGNATURE_TIMEOUT_MS, async (signal) => {
      const response = await deps.fetch(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit', headers: { accept: 'application/json' }, signal,
      });
      return readProbeAnswer(response, signal);
    });
  } catch {
    return undefined;
  }
}

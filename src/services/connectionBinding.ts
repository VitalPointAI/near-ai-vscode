// The connection binding source (CLAS-05 as the owner amplified it, D-50): what says whether the connection a NEAR AI Cloud client uses is proven to end
// inside the private hardware its attestation names, and the transport that keeps a request on that connection. No vscode import, no new dependency.
//
// What NEAR AI Cloud exposes (researched for this release, recorded in the phase's plan 25 summary): with `include_tls_fingerprint=true`, the gateway's
// attestation carries `tls_cert_fingerprint`, the SHA-256 of the DER SubjectPublicKeyInfo of the certificate the gateway serves, and its TDX quote binds
// sha256(signing address, fingerprint) beside the caller's nonce. So a connection counts as bound only when that quote verifies and the certificate this
// computer receives on its own TLS connection has the same public key. Every request at an attested-cloud level is then sent over a connection whose
// handshake refuses any other key, whatever route (direct, or a CONNECT tunnel through a proxy) carries it: a proxy that inspects TLS can never match.
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import * as tls from 'node:tls';
import type { ConnectionBindingFact } from '../domain/gate/routing';
import { attestedTlsFingerprint } from './attestation';

export interface ConnectionBindingSource {
  /** The fact held in memory for a host, or undefined when none is. Read by the route check at decision time, so it must not touch the network (OFFL-01). */
  current(host: string): ConnectionBindingFact | undefined;
  /** Checks the binding again, out of band of any decision, and resolves with what it found. */
  refresh(host: string): Promise<ConnectionBindingFact>;
  /** Forgets a binding for a host, for example after a connection did not match it. */
  markNotBound(host: string, detail: string): void;
  /** A fetch pinned to the bound connection, when the source can give one. */
  fetchFor?(fact: ConnectionBindingFact): typeof fetch;
}

/** What a fingerprint is a hash of. NEAR AI Cloud's gateway binds the SHA-256 of the certificate's DER SubjectPublicKeyInfo (research, plan 25). */
export type FingerprintKind = 'certificate-sha256' | 'public-key-sha256';
export const NEAR_TLS_FINGERPRINT_KIND: FingerprintKind = 'public-key-sha256';

/** The longest one refresh may take, the report and the TLS check together; past it the answer is unknown. */
export const BINDING_REFRESH_TIMEOUT_MS = 5_000;

/** A fingerprint in one form: colons removed, lowercase. Undefined unless it is exactly 64 hex characters, so no other length or character ever matches. */
export function normaliseFingerprint(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const plain = text.replace(/:/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(plain) ? plain : undefined;
}

/** A connection that did not present the attested key. Thrown before any byte of the request is written. */
export class ConnectionNotBoundError extends Error {
  public constructor(message = 'The server did not present the certificate NEAR AI Cloud\'s attestation names, so nothing was sent over this connection.') {
    super(message);
    this.name = 'ConnectionNotBoundError';
  }
}

/** The fingerprint of a peer certificate, of the kind asked for, normalised. Undefined when the certificate cannot be read. */
export function peerFingerprint(cert: { raw?: Buffer; fingerprint256?: string } | undefined, kind: FingerprintKind): string | undefined {
  if (cert === undefined) return undefined;
  try {
    if (kind === 'certificate-sha256') return normaliseFingerprint(cert.fingerprint256 ?? (cert.raw ? createHash('sha256').update(cert.raw).digest('hex') : undefined));
    // Node's `pubkey` field is the bare key, not the SubjectPublicKeyInfo NEAR hashes, so the DER SPKI is taken from the certificate itself.
    if (cert.raw === undefined) return undefined;
    const spki = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spki).digest('hex');
  } catch {
    return undefined;
  }
}

/** TLS options a test's local server needs (its own CA and server name). Production passes none: the system's CAs and the URL's host name. */
export interface PinTlsOptions {
  readonly ca?: string | Buffer;
  readonly servername?: string;
}

const agents = new Map<string, https.Agent>();

function pinCheck(pin: string, kind: FingerprintKind): (host: string, cert: tls.PeerCertificate) => Error | undefined {
  return (host, cert) => {
    // The normal host name check first; only a certificate that passes it is compared with the pin.
    const usual = tls.checkServerIdentity(host, cert);
    if (usual !== undefined) return usual;
    return peerFingerprint(cert, kind) === pin ? undefined : new ConnectionNotBoundError();
  };
}

/** One keep-alive agent per fingerprint, kind and TLS options, so a pooled connection was always checked against the same pin. */
function agentFor(pin: string, kind: FingerprintKind, options: PinTlsOptions): https.Agent {
  const key = `${kind}:${pin}:${options.servername ?? ''}:${options.ca === undefined ? '' : createHash('sha256').update(options.ca).digest('hex')}`;
  let agent = agents.get(key);
  if (agent === undefined) {
    agent = new https.Agent({ keepAlive: true, maxCachedSessions: 0, checkServerIdentity: pinCheck(pin, kind), ...(options.ca === undefined ? {} : { ca: options.ca }) });
    agents.set(key, agent);
    // Keep the pool small: an old pin's agent closes its idle connections when it leaves.
    while (agents.size > 8) {
      const oldest = agents.keys().next().value as string;
      agents.get(oldest)?.destroy();
      agents.delete(oldest);
    }
  }
  return agent;
}

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * A fetch whose every TLS handshake runs the normal host name check and then refuses any certificate whose fingerprint (of `kind`) is not `fingerprint`,
 * before a byte of the request is written; the refusal is a ConnectionNotBoundError. It forwards method, headers, body and signal (an abort destroys the
 * request), and resolves a Response with the status, headers and a streamed body. The certificate check travels with the request's own options, so it holds
 * on every route Node and VS Code may give the request: a direct connection, or a CONNECT tunnel through a proxy, where TLS still runs end to end. A proxy
 * that ends TLS itself presents its own certificate and is refused. Only https URLs are sent.
 */
export function pinnedFetch(fingerprint: string, kind: FingerprintKind, options: { tls?: PinTlsOptions } = {}): typeof fetch {
  const pin = normaliseFingerprint(fingerprint);
  const tlsOptions = options.tls ?? {};
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (pin === undefined) throw new ConnectionNotBoundError('No usable fingerprint was given for this connection, so nothing was sent.');
    // One reading of the request, whatever form it came in: a Request keeps its method, headers and body, and FormData gets its boundary header.
    const prepared = new Request(input, init);
    const url = new URL(prepared.url);
    if (url.protocol !== 'https:') throw new ConnectionNotBoundError('A pinned connection is only made over https, so nothing was sent.');
    const signal = init?.signal ?? prepared.signal;
    if (signal?.aborted) throw abortError(signal);
    const body = prepared.body === null ? undefined : Buffer.from(await prepared.arrayBuffer());
    const headers: Record<string, string> = {};
    prepared.headers.forEach((value, name) => { headers[name] = value; });
    if (body !== undefined) headers['content-length'] = String(body.length);
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const servername = tlsOptions.servername ?? (isIP(hostname) === 0 ? hostname : undefined);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const request = https.request({
        protocol: 'https:',
        hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: prepared.method,
        headers,
        agent: agentFor(pin, kind, tlsOptions),
        // Also on the request itself, so the check survives an agent another layer puts in place (VS Code's proxy support replaces the agent).
        checkServerIdentity: pinCheck(pin, kind),
        ...(servername === undefined ? {} : { servername }),
        ...(tlsOptions.ca === undefined ? {} : { ca: tlsOptions.ca })
      }, (response) => {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        const status = response.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        const empty = prepared.method === 'HEAD' || status === 204 || status === 304;
        if (empty) response.resume();
        // A later abort ends the body stream too.
        const endBody = () => response.destroy(abortError(signal));
        signal?.addEventListener('abort', endBody, { once: true });
        response.once('close', () => signal?.removeEventListener('abort', endBody));
        try {
          resolve(new Response(empty ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>, { status, statusText: response.statusMessage ?? '', headers: responseHeaders }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      });
      const onAbort = () => { if (!settled) { settled = true; request.destroy(); reject(abortError(signal)); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      request.once('error', (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(error instanceof ConnectionNotBoundError ? error : (error as { cause?: unknown }).cause instanceof ConnectionNotBoundError ? (error as { cause: ConnectionNotBoundError }).cause : error);
      });
      // Written only after the handshake: Node holds the body until the socket is connected and the certificate check above has passed.
      request.end(body);
    });
  }) as typeof fetch;
}

export interface NearConnectionBindingOptions {
  /** The client's authenticated GET against its /v1 base, the one verifyResponse already goes through. */
  readonly get: (path: string, signal?: AbortSignal) => Promise<unknown>;
  /** A TEE model id from the client's cached catalog, or undefined while none is listed. Never fetches. */
  readonly teeModel: () => string | undefined;
  /** For tests: the local server's CA and server name. */
  readonly tls?: PinTlsOptions;
  readonly timeoutMs?: number;
  /** For tests: the quote's trusted root (Intel's by default) and the time it is checked at. */
  readonly trust?: { readonly trustedRoot?: string; readonly now?: () => Date };
  readonly now?: () => number;
}

const NO_TEE_MODEL_DETAIL = 'No private model is listed yet, so the attestation could not be asked for.';

/** The hostname and port a binding is about, from a URL or a bare host. Undefined when unreadable. */
function endpointOf(host: string): { readonly key: string; readonly hostname: string; readonly port: number } | undefined {
  const text = host.trim();
  if (text === '') return undefined;
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`);
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const port = url.port === '' ? 443 : Number(url.port);
    return { key: `${hostname.toLowerCase()}:${String(port)}`, hostname, port };
  } catch {
    return undefined;
  }
}

/**
 * NEAR AI Cloud's binding source for one client. `refresh` asks the gateway for a report with a new 32-byte nonce and `include_tls_fingerprint=true`, proves
 * the fingerprint with attestedTlsFingerprint, opens its own TLS connection to the host and compares the certificate's public key: all of that gives bound;
 * a mismatch or a quote that does not prove it gives not-bound; a report with no fingerprint gives unavailable; an error, no TEE model listed yet or the
 * timeout gives unknown. One refresh per host runs at a time. Facts are kept in memory only, and never hold more than the state, host, time and fingerprint.
 */
export class NearConnectionBinding implements ConnectionBindingSource {
  private readonly facts = new Map<string, ConnectionBindingFact>();
  private readonly inFlight = new Map<string, Promise<ConnectionBindingFact>>();

  public constructor(private readonly options: NearConnectionBindingOptions) {}

  public current(host: string): ConnectionBindingFact | undefined {
    const endpoint = endpointOf(host);
    return endpoint === undefined ? undefined : this.facts.get(endpoint.key);
  }

  public refresh(host: string): Promise<ConnectionBindingFact> {
    const endpoint = endpointOf(host);
    if (endpoint === undefined) return Promise.resolve({ state: 'unknown', host, checkedAt: this.now(), detail: 'The endpoint cannot be read.' });
    const running = this.inFlight.get(endpoint.key);
    if (running !== undefined) return running;
    const work = this.check(host, endpoint)
      .catch((error: unknown): ConnectionBindingFact => ({ state: 'unknown', host, checkedAt: this.now(), detail: `The check could not be made (${error instanceof Error ? error.message : 'unknown error'}).` }))
      // With no private model listed yet nothing was checked, so nothing is kept: the next route check asks again once the catalog has loaded.
      .then((fact) => { if (fact.detail !== NO_TEE_MODEL_DETAIL) this.facts.set(endpoint.key, fact); return fact; })
      .finally(() => { this.inFlight.delete(endpoint.key); });
    this.inFlight.set(endpoint.key, work);
    return work;
  }

  public markNotBound(host: string, detail: string): void {
    const endpoint = endpointOf(host);
    if (endpoint !== undefined) this.facts.set(endpoint.key, { state: 'not-bound', host, checkedAt: this.now(), detail: detail.slice(0, 200) });
  }

  public fetchFor(fact: ConnectionBindingFact): typeof fetch {
    return pinnedFetch(fact.fingerprint ?? '', NEAR_TLS_FINGERPRINT_KIND, this.options.tls === undefined ? {} : { tls: this.options.tls });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async check(host: string, endpoint: { readonly hostname: string; readonly port: number }): Promise<ConnectionBindingFact> {
    const model = this.options.teeModel();
    if (model === undefined) return { state: 'unknown', host, checkedAt: this.now(), detail: NO_TEE_MODEL_DETAIL };
    const controller = new AbortController();
    const timeoutMs = Math.max(1, this.options.timeoutMs ?? BINDING_REFRESH_TIMEOUT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ConnectionBindingFact>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ state: 'unknown', host, checkedAt: this.now(), detail: `The check did not finish within ${String(timeoutMs)} ms.` }); }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.prove(host, endpoint, model, controller.signal), timedOut]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async prove(host: string, endpoint: { readonly hostname: string; readonly port: number }, model: string, signal: AbortSignal): Promise<ConnectionBindingFact> {
    const nonce = randomBytes(32).toString('hex');
    const report = await this.options.get(`/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ecdsa&include_tls_fingerprint=true`, signal);
    const trust = this.options.trust;
    const attested = attestedTlsFingerprint(report, nonce, { ...(trust?.trustedRoot === undefined ? {} : { trustedRoot: trust.trustedRoot }), ...(trust?.now === undefined ? {} : { now: trust.now() }) });
    if (attested.state === 'absent') return { state: 'unavailable', host, checkedAt: this.now(), detail: 'NEAR AI Cloud\'s attestation names no TLS key for this endpoint.' };
    if (attested.state === 'invalid') return { state: 'not-bound', host, checkedAt: this.now(), detail: attested.reason };
    const presented = await presentedFingerprint(endpoint.hostname, endpoint.port, this.options.tls, signal);
    if (presented !== attested.fingerprint) return { state: 'not-bound', host, checkedAt: this.now(), detail: 'The certificate this computer receives is not the one NEAR AI Cloud\'s attestation names.' };
    return { state: 'bound', host, checkedAt: this.now(), fingerprint: attested.fingerprint };
  }
}

/** The public-key fingerprint of the certificate a TLS connection to the host and port presents, after the normal certificate checks. The socket is closed. */
function presentedFingerprint(hostname: string, port: number, options: PinTlsOptions | undefined, signal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError(signal)); return; }
    const servername = options?.servername ?? (isIP(hostname) === 0 ? hostname : undefined);
    const socket = tls.connect({ host: hostname, port, ...(servername === undefined ? {} : { servername }), ...(options?.ca === undefined ? {} : { ca: options.ca }) }, () => {
      const fingerprint = peerFingerprint(socket.getPeerCertificate(), NEAR_TLS_FINGERPRINT_KIND);
      socket.end();
      socket.destroy();
      resolve(fingerprint);
    });
    const onAbort = () => { socket.destroy(); reject(abortError(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('close', () => signal.removeEventListener('abort', onAbort));
    socket.once('error', (error) => { socket.destroy(); reject(error); });
  });
}

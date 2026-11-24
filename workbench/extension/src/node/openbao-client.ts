/**
 * The one OpenBao client every workbench call goes through (D-19, D-22; T-46-06, T-46-08): plain node:https (node:http only for the
 * loopback address hosting-config allows), the site's CA bundle read once from caFile, a timeout on every call, JSON in and out, the token
 * only in X-Vault-Token, and a 1 MiB cap on an answer. It never logs. Its errors carry the method, the path with any users/<id> part and
 * any entity id hidden, and the status, never a header or a body, so no token or secret can reach an error text. Nothing here imports Theia.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

export type OpenBaoErrorKind = 'unreachable' | 'refused' | 'bad-response';

export class OpenBaoError extends Error {
  constructor(
    readonly kind: OpenBaoErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenBaoError';
  }
}

export interface OpenBaoResponse {
  readonly status: number;
  /** The parsed answer; undefined for an empty answer and for 404. */
  readonly json: unknown;
}

export interface OpenBaoRequestOptions {
  readonly token?: string;
  readonly body?: unknown;
}

export interface OpenBaoClient {
  /**
   * Calls `/v1/<path>` (the path may carry a query such as `?list=true`). Resolves for 2xx and for 404 (the caller decides what a missing
   * thing means); throws OpenBaoError for anything else.
   */
  request(method: string, path: string, options?: OpenBaoRequestOptions): Promise<OpenBaoResponse>;
}

export interface OpenBaoClientOptions {
  readonly addr: string;
  readonly caFile?: string;
  /** Per call; default 5000. */
  readonly timeoutMs?: number;
}

export const DEFAULT_OPENBAO_TIMEOUT_MS = 5000;
const MAX_ANSWER_BYTES = 1024 * 1024;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The path as error texts show it: no query, users/<id> as users/…, and no entity id anywhere (person-<id>, kek-<id>). */
export function describePath(path: string): string {
  return path.split('?')[0].replace(/^\/+/, '').replace(/(^|\/)users\/[^/]+/g, '$1users/…').replace(UUID, '…');
}

export function createOpenBaoClient(options: OpenBaoClientOptions): OpenBaoClient {
  const base = new URL(options.addr);
  const secure = base.protocol === 'https:';
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENBAO_TIMEOUT_MS;
  let ca: Buffer | undefined;
  if (options.caFile !== undefined) {
    try {
      ca = readFileSync(options.caFile);
    } catch {
      throw new Error('STERLING_OPENBAO_CA_FILE names a file the workbench cannot read.');
    }
  }
  const transport = secure ? https : http;

  return {
    request(method, path, { token, body } = {}) {
      const shown = `${method} ${describePath(path)}`;
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      const headers: Record<string, string | number> = { Accept: 'application/json' };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      if (token !== undefined) headers['X-Vault-Token'] = token;
      const target = new URL(`/v1/${path.replace(/^\/+/, '')}`, base);

      return new Promise<OpenBaoResponse>((resolve, reject) => {
        let settled = false;
        const signal = AbortSignal.timeout(timeoutMs);
        const finish = (outcome: OpenBaoResponse | OpenBaoError): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          if (outcome instanceof OpenBaoError) {
            request.destroy();
            reject(outcome);
          } else {
            resolve(outcome);
          }
        };
        const unreachable = (why: string): OpenBaoError => new OpenBaoError('unreachable', `OpenBao did not answer ${shown} (${why}).`);
        const onAbort = (): void => finish(unreachable(`no answer within ${timeoutMs} ms`));
        signal.addEventListener('abort', onAbort);

        const request = transport.request(target, {
          method,
          headers,
          agent: false,
          ...(secure ? { ca, minVersion: 'TLSv1.2' as const } : {}),
        }, (response) => {
          const status = response.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ANSWER_BYTES) {
              finish(new OpenBaoError('bad-response', `OpenBao answered ${shown} with more than 1 MiB.`, status));
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => finish(unreachable('the answer was cut off')));
          response.on('end', () => {
            if (status === 404) { finish({ status, json: undefined }); return; }
            if (status === 400 || status === 401 || status === 403) {
              finish(new OpenBaoError('refused', `OpenBao refused ${shown} (status ${status}).`, status));
              return;
            }
            if (status < 200 || status > 299) {
              finish(new OpenBaoError('bad-response', `OpenBao answered ${shown} with status ${status}.`, status));
              return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (text.trim() === '') { finish({ status, json: undefined }); return; }
            try {
              finish({ status, json: JSON.parse(text) as unknown });
            } catch {
              finish(new OpenBaoError('bad-response', `OpenBao answered ${shown} with something that is not JSON.`, status));
            }
          });
        });
        // Only the error's code is kept (ECONNREFUSED, a TLS verification code): a Node error message can quote the address but never a header.
        request.on('error', (error: NodeJS.ErrnoException) => finish(unreachable(error.code ?? 'connection failed')));
        request.end(payload);
      });
    },
  };
}

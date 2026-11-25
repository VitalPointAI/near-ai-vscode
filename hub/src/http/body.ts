// Shared by the project routes (routes.ts) and the trust routes (trustRoutes.ts): the route errors and how a request body is read. Moved out of
// routes.ts unchanged (71-09), so both route files read bodies the same way: a byte cap checked before the body is read, never parsed past it.
import type http from 'node:http';
import { BASE_HEADERS, sendJson } from './server';

export const ROUTE_ERRORS = {
  'not-found': 'There is nothing at this address on the hub.',
  'method-not-allowed': 'This address does not answer that method.',
  'too-large': 'The request body is larger than this call accepts.',
  malformed: 'The request is not in a shape the hub can read.',
  'rate-limited': 'Too many calls came from this address. Wait the time the hub gives, then try again.',
  'blob-mismatch': 'The uploaded bytes do not have the hash the address names. Upload the blob again.',
  'pending-quota': 'This device has uploaded too many blobs that no entry uses yet. Send the entries that use them first.',
  'too-many-streams': 'This device or address already has as many event streams open as the hub allows. Close one, or wait the time the hub gives.',
  forbidden: 'This device is not on the access list of that part of the project.',
  'checkpoint-refused': 'A checkpoint handed back is not one this hub signed for this project, so none of them was kept.',
  internal: 'The hub could not answer this request. Try again later.',
} as const;
export type RouteError = keyof typeof ROUTE_ERRORS;

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function sendError(res: http.ServerResponse, status: number, error: RouteError, extra: Record<string, string> = {}): void {
  sendJson(res, status, JSON.stringify({ error, message: ROUTE_ERRORS[error] }), extra);
}

/** Bytes as the answer, with the project named in a header. */
export function sendBytes(res: http.ServerResponse, bytes: Buffer, project: string): void {
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'x-near-ai-project': project });
  res.end(bytes);
}

/** Refuses a body larger than cap: 413, and the connection is closed after the answer so the rest of the body is never parsed. */
function refuseTooLarge(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!res.headersSent) sendError(res, 413, 'too-large', { connection: 'close' });
  req.resume();
}

/** Reads the body with a byte cap. A declared length past the cap is refused before any byte is read; a body that grows past it is cut off. */
export function readBody(req: http.IncomingMessage, res: http.ServerResponse, cap: number): Promise<Buffer | undefined> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d{1,12}$/.test(declared) || Number(declared) > cap)) {
    refuseTooLarge(req, res);
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | undefined): void => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > cap) {
        chunks.length = 0;
        refuseTooLarge(req, res);
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks, size));
    const onError = (): void => finish(undefined);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** The body as JSON, or undefined after answering 413 or 400. */
export async function readJson(req: http.IncomingMessage, res: http.ServerResponse, cap: number): Promise<{ value: unknown } | undefined> {
  const bytes = await readBody(req, res, cap);
  if (bytes === undefined) {
    if (!res.headersSent) sendError(res, 400, 'malformed');
    return undefined;
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')) as unknown };
  } catch {
    sendError(res, 400, 'malformed');
    return undefined;
  }
}

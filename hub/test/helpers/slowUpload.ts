import tls from 'node:tls';

// A client on a slow link (WR-03): it opens its own TLS 1.3 connection, writes the request line and headers at once, then the body a chunk at a
// time with a pause between chunks, the way a constrained site link delivers a large upload. It reads the raw answer itself, so it sees a 408, a
// reset or a close exactly as the hub sends them. Bodies are fictional.

export interface SlowUpload {
  method: string;
  path: string;
  body: Buffer;
  /** Bytes per write. */
  chunkBytes: number;
  /** Milliseconds between writes. */
  everyMs: number;
  headers?: Record<string, string>;
  /** The content-length to declare; the body's own length when absent. */
  declaredLength?: number;
  /** Stop writing after this many bytes (a stalled client); the whole body when absent. */
  stopAfterBytes?: number;
}

export interface SlowUploadResult {
  /** The status of the answer, or undefined when the connection ended without one. */
  status: number | undefined;
  /** The answer's body text. */
  text: string;
  /** Body bytes written before the answer or the end of the connection. */
  sent: number;
  /** Milliseconds from the first body byte to the answer or the end of the connection. */
  elapsedMs: number;
  /** True when the connection closes within ms (true at once when it already has). */
  closesWithin(ms: number): Promise<boolean>;
}

/** Sends one request with its body trickled, and resolves with the hub's answer or the end of the connection, whichever comes first. */
export function slowUpload(port: number, upload: SlowUpload): Promise<SlowUploadResult> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
    let raw = Buffer.alloc(0);
    let sent = 0;
    let started = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const closedPromise = new Promise<void>((done) => socket.once('close', () => {
      closed = true;
      done();
    }));
    const closesWithin = async (ms: number): Promise<boolean> => {
      if (closed) return true;
      let wait: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([closedPromise.then(() => true), new Promise<boolean>((done) => { wait = setTimeout(() => done(false), ms); })]);
      } finally {
        clearTimeout(wait);
      }
    };
    const settle = (status: number | undefined, text: string): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve({ status, text, sent, elapsedMs: Date.now() - started, closesWithin });
    };
    /** The answer, once its headers and the body its content-length names have arrived. */
    const answer = (): { status: number; text: string } | undefined => {
      const end = raw.indexOf('\r\n\r\n');
      if (end < 0) return undefined;
      const head = raw.subarray(0, end).toString('latin1');
      const status = /^HTTP\/1\.1 (\d{3})/.exec(head);
      if (status === null) return undefined;
      const length = /\r\ncontent-length: *(\d+)/i.exec(head);
      const body = raw.subarray(end + 4);
      if (length !== null && body.length < Number(length[1])) return undefined;
      return { status: Number(status[1]), text: body.toString('utf8') };
    };
    socket.on('data', (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      const read = answer();
      if (read !== undefined) settle(read.status, read.text);
    });
    socket.on('error', () => undefined);
    socket.once('close', () => {
      const read = answer();
      settle(read?.status, read?.text ?? '');
    });
    socket.once('secureConnect', () => {
      const headers: Record<string, string> = {
        host: 'localhost',
        'content-length': String(upload.declaredLength ?? upload.body.length),
        ...(upload.headers ?? {}),
      };
      const lines = [`${upload.method} ${upload.path} HTTP/1.1`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), '', ''];
      socket.write(lines.join('\r\n'));
      started = Date.now();
      const limit = Math.min(upload.stopAfterBytes ?? upload.body.length, upload.body.length);
      timer = setInterval(() => {
        if (settled || socket.destroyed) {
          clearInterval(timer);
          return;
        }
        if (sent >= limit) {
          clearInterval(timer);
          return;
        }
        const chunk = upload.body.subarray(sent, Math.min(limit, sent + upload.chunkBytes));
        sent += chunk.length;
        socket.write(chunk);
      }, upload.everyMs);
    });
    socket.once('error', (error) => {
      if (started === 0) reject(error);
    });
  });
}

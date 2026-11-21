import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';

// A self-signed P-256 certificate and key for the hub tests, made at run time with openssl (D-29: the operator brings the certificate, so the tests
// make one the way the operator section says). Nothing here is committed: the files live in a temporary folder with mode 0600 and go when the test
// calls cleanup(). A missing openssl fails the test with a plain sentence; it never skips, because a skipped TLS test proves nothing.

export interface TlsFixture {
  dir: string;
  certFile: string;
  keyFile: string;
  certPem: string;
  keyPem: string;
  /** The certificate's DER bytes, to compare with what the server presents. */
  certDer: Buffer;
  cleanup(): void;
}

export function makeTlsFixture(): TlsFixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-tls-'));
  const certFile = path.join(dir, 'hub_tls_cert');
  const keyFile = path.join(dir, 'hub_tls_key');
  const run = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8' },
  );
  if (run.error !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    const code = (run.error as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? 'openssl is not installed; the hub tests need it to make a test certificate.' : `openssl could not run (${code ?? 'error'}).`);
  }
  if (run.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`openssl could not make the test certificate (exit ${run.status}).`);
  }
  chmodSync(certFile, 0o600);
  chmodSync(keyFile, 0o600);
  const certPem = readFileSync(certFile, 'utf8');
  const keyPem = readFileSync(keyFile, 'utf8');
  return {
    dir,
    certFile,
    keyFile,
    certPem,
    keyPem,
    certDer: new X509Certificate(certPem).raw,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface TlsResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  protocol: string | null;
  peerDer: Buffer;
}

export function tlsGet(port: number, target: string, options: https.RequestOptions = {}): Promise<TlsResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      { host: '127.0.0.1', port, path: target, method: 'GET', agent: false, rejectUnauthorized: false, minVersion: 'TLSv1.3', ...options },
      (response) => {
        const socket = response.socket as TLSSocket;
        const protocol = socket.getProtocol();
        const peerDer = socket.getPeerCertificate().raw;
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text, protocol, peerDer }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}


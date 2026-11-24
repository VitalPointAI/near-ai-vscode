// A test certificate authority and a server certificate for 127.0.0.1, made at run time with openssl, as hub/test/helpers/tlsFixture.ts does
// (46-02). Nothing is committed: the files live in a temporary folder and go with cleanup(). A missing openssl fails the test with a plain
// sentence; it never skips, because a skipped TLS test proves nothing.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TestCertificate {
  readonly dir: string;
  /** The CA certificate file, for STERLING_OPENBAO_CA_FILE. */
  readonly caFile: string;
  readonly caPem: string;
  readonly certPem: string;
  readonly keyPem: string;
  cleanup(): void;
}

function openssl(dir: string, args: string[]): void {
  const run = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (run.error !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    const code = (run.error as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? 'openssl is not installed; the workbench tests need it to make a test certificate.' : `openssl could not run (${code ?? 'error'}).`);
  }
  if (run.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`openssl could not make the test certificate (exit ${run.status}): ${run.stderr.trim().split('\n').pop() ?? ''}`);
  }
}

export function makeTestCertificate(): TestCertificate {
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-workbench-tls-'));
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  openssl(dir, ['req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Sterling workbench test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  openssl(dir, ['req', ...ec, '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1']);
  writeFileSync(path.join(dir, 'server.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  openssl(dir, ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'server.ext']);
  const read = (file: string): string => readFileSync(path.join(dir, file), 'utf8');
  return {
    dir,
    caFile: path.join(dir, 'ca.pem'),
    caPem: read('ca.pem'),
    certPem: read('server.pem'),
    keyPem: read('server.key'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

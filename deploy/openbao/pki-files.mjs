#!/usr/bin/env node
// The site's PKI intermediate and revocation lists by signed file (D-49, D-50). No database is shared between sites: HQ's offline root signs
// each site's intermediate in the key ceremony, outside any network, and revocation lists travel the same way.
//
//   csr                  OpenBao generates the pki_int intermediate's key and CSR (the key never leaves OpenBao); the CSR file is signed so
//                        HQ knows which site sent it. HQ's offline root signs it in the key ceremony (key ceremony runbook).
//   import-intermediate  verifies the signed certificate file, checks that the certificate is a CA certificate issued and signed by the HQ
//                        root from the install media and valid now, all before any OpenBao call or file write; then sets it as pki_int's
//                        signed intermediate, makes it the default issuer and writes the chain (intermediate then root) to --chain-out,
//                        which becomes the site's siteCaChain value (ConfigMap sterling-site-ca, 47-13).
//   export-crl           reads pki_int's revocation list and signs it.
//   import-crl           verifies a signed revocation list before writing anything, then places it at every --out path: the CRL file the
//                        smart-card flow reads when it is on (realm site file x509.crlPath) and the TLS trust folder of clients that check CRLs.
//
//   node deploy/openbao/pki-files.mjs csr --out <file> --key <cosign key> --site <site file> <OpenBao flags>
//   node deploy/openbao/pki-files.mjs import-intermediate --in <signed certificate file> --public-key <cosign pub> --root <HQ root pem>
//        --chain-out <file> <OpenBao flags>
//   node deploy/openbao/pki-files.mjs export-crl --out <file> --key <cosign key> <OpenBao flags>
//   node deploy/openbao/pki-files.mjs import-crl --in <signed CRL file> --public-key <cosign pub> --out <path> [--out <path> ...]
//   OpenBao flags: --bao <https://openbao:8200> --ca-file <site CA pem> --token-file <file>
//
// The token comes from a file and the cosign key password from COSIGN_PASSWORD, never an argument. The cosign public key and the HQ root
// certificate always come from the install media, never from beside the file. Node built-ins only.
import { X509Certificate } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signFile, signatureFile } from '../bundle/signed-file.mjs';
import { loadSite } from '../bundle/lib/render.mjs';
import { readVerified } from '../keycloak/users.mjs';
import { openbaoClient } from './apply.mjs';

export const MOUNT = 'pki_int';
/** The intermediate's key, made and kept in OpenBao. */
export const INTERMEDIATE_KEY = Object.freeze({ key_type: 'ec', key_bits: 384 });
const BASE64_LINE = /^[A-Za-z0-9+/=]+$/;

/**
 * The PEM blocks of a text as [{ label, pem }]. Refuses anything that is not a clean PEM block (text dumps, stray lines), so only what the
 * signature covered and the check understood is used. Read line by line (no nested-repetition pattern, CodeQL js/redos).
 */
export function pemBlocks(text) {
  const blocks = [];
  let open = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!open) {
      if (!line) continue;
      if (!line.startsWith('-----BEGIN ') || !line.endsWith('-----')) throw new Error('the file holds text outside a PEM block');
      open = { label: line.slice('-----BEGIN '.length, -'-----'.length), lines: [line] };
    } else if (line === `-----END ${open.label}-----`) {
      if (open.lines.length < 2) throw new Error(`the ${open.label} block is empty`);
      blocks.push({ label: open.label, pem: `${[...open.lines, line].join('\n')}\n` });
      open = null;
    } else {
      if (!BASE64_LINE.test(line)) throw new Error(`the ${open.label} block holds a line that is not base64`);
      open.lines.push(line);
    }
  }
  if (open) throw new Error(`the ${open.label} block has no end line`);
  return blocks;
}

/** The single block of `label` in a text, or an error naming what was found instead. */
function onlyBlock(text, label) {
  const blocks = pemBlocks(text);
  if (blocks.length !== 1 || blocks[0].label !== label) throw new Error(`expected one ${label} PEM block, found ${blocks.map((block) => block.label).join(', ') || 'none'}`);
  return blocks[0].pem;
}

const answer = (result, what) => {
  if (result.status >= 300) throw new Error(`${what}: OpenBao answered ${result.status} ${JSON.stringify(result.data?.errors ?? result.data)}`);
  return result.data?.data ?? null;
};

/** Writes a file through a temporary name in the same folder, so a reader never sees half of it. */
function writeWhole(file, text, mode = 0o644) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.partial`);
  try {
    writeFileSync(temporary, text, { mode });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Writes `text` to `out` and signs it; removes the unsigned file if signing fails. */
function writeSigned(out, text, key, { cosign } = {}) {
  writeWhole(out, text);
  try { signFile(out, key, { cosign }); } catch (error) { rmSync(out, { force: true }); throw error; }
  return signatureFile(out);
}

/** OpenBao makes the intermediate key and CSR; the CSR is written to `out` and signed. Returns { csr, key_id }. */
export async function requestIntermediate(bao, { out, key, siteName, cosign }) {
  if (!siteName) throw new Error('the site name is needed (from the site file).');
  const data = answer(await bao('POST', `${MOUNT}/intermediate/generate/internal`, { common_name: `Sterling ${siteName} site intermediate`, ...INTERMEDIATE_KEY }), 'generate the intermediate CSR');
  const csr = onlyBlock(data?.csr ?? '', 'CERTIFICATE REQUEST');
  writeSigned(out, csr, key, { cosign });
  return { csr, keyId: data.key_id ?? '' };
}

/** Every reason `certificate` may not become this site's intermediate under `root`; empty means it may. */
export function checkIntermediate(certificate, root, now = new Date()) {
  const problems = [];
  if (!root.ca || !root.checkIssued(root) || !root.verify(root.publicKey)) problems.push('the HQ root given is not a self-signed CA certificate');
  if (!certificate.ca) problems.push('the certificate is not a CA certificate, so it cannot be an intermediate');
  if (!certificate.checkIssued(root) || !certificate.verify(root.publicKey)) problems.push(`the certificate does not chain to the HQ root ${root.subject.replaceAll('\n', ', ')} (issuer ${certificate.issuer.replaceAll('\n', ', ')})`);
  if (new Date(certificate.validFrom) > now || new Date(certificate.validTo) <= now) problems.push(`the certificate is not valid now (${certificate.validFrom} to ${certificate.validTo})`);
  return problems;
}

const serialOf = (value) => String(value ?? '').replaceAll(':', '').toLowerCase().replace(/^0+/, '');

/**
 * Imports the signed intermediate. Returns { ok: false, reason } with no OpenBao call and no file written when the file or the chain is
 * refused, else { ok: true, issuerId, chainOut }. Throws on an OpenBao error.
 */
export async function importIntermediate(bao, { file, publicKey, rootPem, chainOut, cosign, now = new Date(), write = writeWhole }) {
  const verified = readVerified(file, publicKey, { cosign });
  if (!verified.ok) return { ok: false, reason: verified.reason };
  let certificatePem;
  let rootText;
  let certificate;
  let root;
  try {
    certificatePem = onlyBlock(verified.text, 'CERTIFICATE');
    rootText = onlyBlock(rootPem, 'CERTIFICATE');
    certificate = new X509Certificate(certificatePem);
    root = new X509Certificate(rootText);
  } catch (error) {
    return { ok: false, reason: `the certificate or the HQ root could not be read (${error.message})` };
  }
  const problems = checkIntermediate(certificate, root, now);
  if (problems.length) return { ok: false, reason: problems.join('; ') };
  answer(await bao('POST', `${MOUNT}/intermediate/set-signed`, { certificate: `${certificatePem}${rootText}` }), 'set the signed intermediate');
  // The issuer just imported is found by serial number; it must hold the key OpenBao generated for the CSR, or it cannot sign anything.
  const issuers = answer(await bao('GET', `${MOUNT}/issuers?list=true`), 'list the issuers')?.key_info ?? {};
  const serial = serialOf(certificate.serialNumber);
  const [issuerId, issuer] = Object.entries(issuers).find(([, info]) => serialOf(info.serial_number) === serial) ?? [];
  if (!issuerId) throw new Error(`OpenBao did not list the imported certificate (serial ${certificate.serialNumber}) among ${MOUNT}'s issuers.`);
  if (!issuer.key_id) throw new Error(`the certificate does not match a key ${MOUNT} generated (OpenBao holds it as issuer ${issuerId} with no key); it cannot sign. Request a new CSR with the csr command.`);
  answer(await bao('POST', `${MOUNT}/config/issuers`, { default: issuerId }), 'make the intermediate the default issuer');
  write(chainOut, `${certificatePem}${rootText}`);
  return { ok: true, issuerId, chainOut };
}

/** Reads pki_int's revocation list, writes it to `out` and signs it. Returns the CRL text. */
export async function exportCrl(bao, { out, key, cosign }) {
  const crl = onlyBlock(answer(await bao('GET', `${MOUNT}/cert/crl`), 'read the revocation list')?.certificate ?? '', 'X509 CRL');
  writeSigned(out, crl, key, { cosign });
  return crl;
}

/** Verifies a signed revocation list and places it at every path in `outs`. Returns { ok: false, reason } with nothing written on refusal. */
export function importCrl({ file, publicKey, outs, cosign, write = writeWhole }) {
  if (!outs?.length) return { ok: false, reason: 'no --out path given' };
  const verified = readVerified(file, publicKey, { cosign });
  if (!verified.ok) return { ok: false, reason: verified.reason };
  let blocks;
  try { blocks = pemBlocks(verified.text); } catch (error) { return { ok: false, reason: error.message }; }
  if (!blocks.length || blocks.some((block) => block.label !== 'X509 CRL')) return { ok: false, reason: 'the file is not a PEM revocation list (X509 CRL)' };
  const crl = blocks.map((block) => block.pem).join('');
  for (const out of outs) write(out, crl);
  return { ok: true, outs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const options = (flag) => argv.flatMap((value, index) => (value === flag && argv[index + 1] ? [argv[index + 1]] : []));
  const usage = 'usage: pki-files.mjs csr --out <file> --key <cosign key> --site <site file> <OpenBao flags>\n'
    + '       pki-files.mjs import-intermediate --in <signed certificate> --public-key <cosign pub> --root <HQ root pem> --chain-out <file> <OpenBao flags>\n'
    + '       pki-files.mjs export-crl --out <file> --key <cosign key> <OpenBao flags>\n'
    + '       pki-files.mjs import-crl --in <signed CRL> --public-key <cosign pub> --out <path> [--out <path> ...]\n'
    + '       OpenBao flags: --bao <url> --ca-file <site CA pem> --token-file <file>';
  if (!command || command === '--help' || argv.includes('--help')) { console.log(usage); process.exit(command ? 0 : 2); }
  const BAO = ['--bao', '--ca-file', '--token-file'];
  const required = { csr: ['--out', '--key', '--site', ...BAO], 'import-intermediate': ['--in', '--public-key', '--root', '--chain-out', ...BAO],
    'export-crl': ['--out', '--key', ...BAO], 'import-crl': ['--in', '--public-key', '--out'] }[command];
  try {
    const missing = required ? required.filter((flag) => !option(flag)) : [];
    if (!required || missing.length) throw new Error(`${usage}${missing.length ? `\nmissing: ${missing.join(' ')}` : ''}`);
    const bao = () => openbaoClient({ addr: option('--bao'), token: readFileSync(option('--token-file'), 'utf8').trim(), caPem: readFileSync(option('--ca-file'), 'utf8') });
    if (command === 'csr') {
      const { keyId } = await requestIntermediate(bao(), { out: option('--out'), key: option('--key'), siteName: loadSite(option('--site')).siteName });
      console.log(`wrote the signed intermediate CSR ${option('--out')} (OpenBao key ${keyId}); carry it to HQ's key ceremony`);
    } else if (command === 'import-intermediate') {
      const result = await importIntermediate(bao(), { file: option('--in'), publicKey: option('--public-key'), rootPem: readFileSync(option('--root'), 'utf8'), chainOut: option('--chain-out') });
      if (!result.ok) { console.error(`refused: ${result.reason}; nothing was changed.`); process.exit(1); }
      console.log(`imported: ${MOUNT} issuer ${result.issuerId} is the default; the chain is in ${result.chainOut}. Put it in the site's siteCaChain value (sterling-pki per-site file).`);
    } else if (command === 'export-crl') {
      await exportCrl(bao(), { out: option('--out'), key: option('--key') });
      console.log(`wrote the signed revocation list ${option('--out')}`);
    } else {
      const result = importCrl({ file: option('--in'), publicKey: option('--public-key'), outs: options('--out') });
      if (!result.ok) { console.error(`refused: ${result.reason}; nothing was written.`); process.exit(1); }
      console.log(`placed the revocation list at ${result.outs.join(', ')}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

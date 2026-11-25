// The site install preflight (D-08, D-11, D-12, D-17, D-31, D-38, D-55, D-56, D-57, D-71): every refusal that makes an unsafe install
// impossible rather than merely documented, run on the import host before anything changes. Each problem is one plain line that starts with
// its rule name (`<rule>: <message>`), so later rules (48.1-17's softhsm-signing-token) join the same list. Node built-ins only.
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkHostClock, checkTimeSettings } from './clock.mjs';
import { checkRendered } from './invariants.mjs';
import { UNPUBLISHED_DIGEST } from './locks.mjs';

const blank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
/** The non-comment lines of a YAML file in the site folder, or null when the file is absent. */
const yamlLines = (siteDir, name) => {
  const file = siteDir ? path.join(siteDir, name) : '';
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, 'utf8').split('\n').map((line) => line.replace(/(^|\s)#.*$/, '')).filter((line) => line.trim());
};

/** Whether `rpId` is the site domain or a parent of it (D-08). */
export const rpIdCovers = (rpId, domain) => typeof rpId === 'string' && typeof domain === 'string' && rpId !== ''
  && (domain === rpId || domain.endsWith(`.${rpId}`));

/**
 * The preflight. `site` is the parsed site file, `siteDir` the site's per-release folder, `manifest` the imported bundle's manifest (or null),
 * `renderAll` returns the site's own rendered releases ([{ name, yaml }]), `lock` the image lock, `lab` allows the lab exceptions, and `run`
 * is the process runner for the import host clock check (spawnSync shape). Returns { problems, notes }.
 */
export function preflight({ site, siteDir, manifest, renderAll, lock, lab = false, run } = {}) {
  const problems = [];
  const notes = [];
  const add = (rule, message) => problems.push(`${rule}: ${message}`);

  if (blank(site.requestedStorage)) add('requested-storage', 'requestedStorage is not set; every workspace volume needs a size and there is no silent default (D-11).');
  if (!['passkeys', 'hardware-only'].includes(site.signInKeys)) add('sign-in-keys', 'signInKeys must be passkeys or hardware-only (D-57).');
  if (site.signInKeys === 'hardware-only' && (!Array.isArray(site.acceptableAaguids) || site.acceptableAaguids.length === 0)) {
    add('aaguid-allowlist', 'signInKeys is hardware-only but acceptableAaguids is empty; an empty allowlist accepts every authenticator (D-31).');
  }
  if (!rpIdCovers(site.rpId, site.domain)) {
    add('rp-id', `rpId (${site.rpId || 'empty'}) must be the site domain ${site.domain} or a parent of it, the same in every site file (D-08).`);
  }
  if (site.storageProvider !== 'longhorn' && blank(site.storageEncryptionAtRest)) {
    add('storage-encryption', `storageProvider is ${site.storageProvider}, so storageEncryptionAtRest must say how the class ${site.storageClass} is encrypted at rest (D-17).`);
  }
  let keyOk = false;
  try {
    keyOk = typeof site.organizationPublicKey === 'string' && site.organizationPublicKey.includes('-----BEGIN PUBLIC KEY-----')
      && createPublicKey(site.organizationPublicKey).type === 'public';
  } catch { keyOk = false; }
  if (!keyOk) add('organization-key', 'organizationPublicKey is not a PEM public key; paste the text of your organization\'s cosign public key from the install media.');

  for (const problem of checkTimeSettings(site)) add('time-settings', problem);
  if (lab) {
    notes.push('host-clock: skipped (--lab).');
  } else if (Number.isInteger(site.time?.maxClockErrorMs) && site.time.maxClockErrorMs > 0) {
    for (const problem of checkHostClock({ run, maxClockErrorMs: site.time.maxClockErrorMs })) add('host-clock', `the import host: ${problem}`);
  }

  if (!manifest) {
    add('bundle', 'the imported bundle\'s manifest.json was not found; check and import the bundle first (install.mjs import).');
  } else if (!lab) {
    for (const item of manifest.items ?? []) {
      if (item.digest === UNPUBLISHED_DIGEST) add('unpublished-image', `${item.name} carries the unpublished placeholder digest; a production site runs published, signed images only (D-12).`);
    }
    if ((manifest.omitted ?? []).length) add('omitted-items', `the bundle leaves out ${manifest.omitted.join(', ')}; a production site installs a complete bundle (D-12).`);
  }

  const sessions = yamlLines(siteDir, 'sterling-sessions.yaml');
  if (!lab && sessions?.some((line) => /^\s*usePlaceholder:\s*["']?true["']?\s*$/.test(line))) {
    add('lab-placeholder', 'sterling-sessions.yaml turns usePlaceholder on; the placeholder session image is for the lab only (D-55).');
  }
  const openbao = yamlLines(siteDir, 'openbao.yaml');
  let softhsm = !lab && openbao?.some((line) => /^\s*lib:\s*["']?[^"']*libsofthsm2/.test(line));

  let rendered = [];
  try {
    rendered = renderAll();
  } catch (error) {
    add('render', `the site's own values do not render: ${error.message}`);
  }
  if (rendered.length) {
    for (const problem of checkRendered(rendered, { lock, registry: site.registry }).problems) add('render', problem);
    if (!lab && rendered.some(({ name, yaml }) => name === 'openbao' && /sterling\/openbao-softhsm/.test(yaml))) softhsm = true;
  }
  if (softhsm) {
    add('softhsm-seal-token', 'OpenBao is sealed with SoftHSM2 (libsofthsm2 or the sterling/openbao-softhsm image); it is test scope only. Use the site HSM\'s library or the Shamir seal (D-38).');
  }
  return { problems, notes };
}

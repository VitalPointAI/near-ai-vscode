#!/usr/bin/env node
// Offline lab render preview using the same charts, values and invariants as the site renderer.
import { createPublicKey } from 'node:crypto';
import { constants, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_LINE, checkRendered, metadataName } from '../bundle/lib/invariants.mjs';
import { UNPUBLISHED_DIGEST, readImagesLock, splitRef } from '../bundle/lib/locks.mjs';
import { isEnabled, listReleases, loadSite, renderRelease, splitDocs } from '../bundle/lib/render.mjs';
import { prepareRealm } from '../keycloak/apply.mjs';
import { labStorageOverrides, labStorageSettings, readStoragePlan, verifyLabStorage } from './storage-plan.mjs';

const LAB = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(LAB, '../..');
const REQUIRED = new Set([
  'zot', 'sterling-network', 'kyverno', 'sterling-admission', 'cert-manager', 'sterling-pki-bootstrap',
  'kubernetes-ingress', 'openbao', 'sterling-pki', 'sterling-postgres', 'sterling-keycloak-theme', 'keycloakx',
  'sterling-keycloak-realm', 'theia-cloud-crds', 'theia-cloud-base', 'theia-cloud', 'sterling-sessions', 'sterling-hub',
]);
const LAB_VALUES = new Set(['openbao', 'sterling-keycloak-realm', 'sterling-sessions', 'theia-cloud']);
const USAGE = 'Usage: node deploy/lab/render.mjs --public-key <lab-public-key.pem> [--storage-plan <budget.json>]';
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function readPublicKey(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----$/.test(text)) throw new Error();
    return createPublicKey(text).export({ type: 'spki', format: 'pem' });
  } catch {
    throw new Error('Supply one valid public PEM for the lab preview.');
  }
}

function preview(publicKey, storagePlan) {
  const defaults = readJson(path.join(LAB, 'site.lab.yaml'));
  if (defaults.registryKind !== 'zot' || defaults.storageProvider !== 'lab-static' || !Array.isArray(defaults.hubs) || defaults.hubs.length !== 1) {
    throw new Error('The lab-core preview requires Zot, lab-static storage and one hub.');
  }

  const settings = storagePlan ? labStorageSettings(defaults, storagePlan) : defaults;
  const releases = listReleases(ROOT).filter(({ name }) => REQUIRED.has(name));
  const missing = [...REQUIRED].filter((name) => !releases.some((release) => release.name === name));
  if (missing.length) throw new Error(`Required lab releases are missing: ${missing.join(', ')}.`);
  const disabled = releases.filter((release) => !isEnabled(release, settings));
  if (disabled.length) throw new Error(`Required lab releases are disabled: ${disabled.map(({ name }) => name).join(', ')}.`);

  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-lab-preview-'));
  try {
    for (const { name, site } of releases) {
      if (!site) {
        if (LAB_VALUES.has(name)) throw new Error(`The ${name} release is missing its lab values descriptor.`);
        continue;
      }
      const file = path.basename(site);
      const source = LAB_VALUES.has(name) ? path.join(LAB, 'site.lab', file) : path.join(ROOT, site);
      copyFileSync(source, path.join(scratch, file), constants.COPYFILE_EXCL);
    }

    const zot = readFileSync(path.join(scratch, 'zot.yaml'), 'utf8');
    const nodes = [...zot.matchAll(/^ {2}nodePort: (\d+)[ \t]*$/gm)];
    const port = Number(nodes[0]?.[1]);
    if (nodes.length !== 1 || port < 30000 || port > 32767) throw new Error('The Zot lab values must specify one valid bootstrap NodePort.');
    const host = `registry.${settings.domain}`;
    const registry = `${host}:${port}`;
    if (settings.registry !== host && settings.registry !== registry) throw new Error('The lab registry address must match the Zot bootstrap endpoint.');

    const siteFile = path.join(scratch, 'site.lab.yaml');
    writeFileSync(siteFile, JSON.stringify({ ...settings, registry, organizationPublicKey: publicKey }), { mode: 0o600, flag: 'wx' });
    const site = loadSite(siteFile);
    const rendered = releases.map((release) => {
      const sets = storagePlan ? labStorageOverrides(release.name, storagePlan) : [];
      const yaml = renderRelease(ROOT, release, { site, siteDir: scratch, sets });
      if (!splitDocs(yaml).length) throw new Error(`Required lab release ${release.name} rendered no resources.`);
      return { name: release.name, namespace: release.namespace, yaml };
    });
    const zotService = splitDocs(rendered.find(({ name }) => name === 'zot').yaml)
      .find((doc) => /^kind: Service$/m.test(doc) && metadataName(doc) === 'zot');
    if (!zotService || !/^  type: NodePort$/m.test(zotService) || !new RegExp(`^\\s+nodePort: ${port}$`, 'm').test(zotService)) {
      throw new Error('The rendered Zot Service does not match the lab registry NodePort.');
    }

    const lock = readImagesLock(ROOT);
    const { problems } = checkRendered(rendered, { lock, registry });
    if (problems.length) throw new Error(`Lab render invariants: ${problems.join('\n')}`);
    const realm = prepareRealm({
      site,
      realmSite: readJson(path.join(scratch, 'sterling-keycloak-realm.yaml')),
      keycloakxSite: readJson(path.join(scratch, 'keycloakx.yaml')),
    });
    if (realm.problems.length) throw new Error(`Lab realm settings: ${realm.problems.join('\n')}`);

    const unpublishedImages = new Set();
    for (const { yaml } of rendered) {
      for (const [, ref] of yaml.matchAll(IMAGE_LINE)) {
        const { digest, repository } = splitRef(ref);
        if (digest === UNPUBLISHED_DIGEST) unpublishedImages.add(repository);
      }
    }
    return {
      preview: 'lab-core',
      registry,
      releases: rendered.map(({ name }) => name),
      unpublishedImages: [...unpublishedImages].sort(),
      ...(storagePlan ? { storage: verifyLabStorage(rendered, storagePlan, site) } : {}),
      unverified: [
        'Signed lab-only OpenBao image selection and import.',
        storagePlan
          ? 'VM storage capacity and volume binding. Keep only one retained test workspace within this budget.'
          : 'VM storage capacity. Zot and Postgres use production-sized example values in this preview.',
        'Live install and admission. This report confers no install authority.',
      ],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(USAGE);
} else if (args[0] !== '--public-key' || (args.length !== 2 && !(args.length === 4 && args[2] === '--storage-plan'))) {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  let publicKey;
  try {
    publicKey = readPublicKey(args[1]);
    const storagePlan = args.length === 4 ? readStoragePlan(args[3]) : undefined;
    console.log(JSON.stringify(preview(publicKey, storagePlan), null, 2));
  } catch (error) {
    let message = error.message;
    for (const line of publicKey?.trim().split('\n') ?? []) message = message.replaceAll(line, '[public key omitted]');
    console.error(message);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// The one offline render path (D-12, D-13, D-20): every release of the site stack rendered from its descriptor, our values and one site file,
// with every image injected by digest from deploy/bundle/images.lock.json. The install script, CI and the render tests all use it. Node built-ins
// only; helm comes from $HELM or PATH and runs with empty Helm folders, so no chart repository is configured and none is ever fetched.
//
//   node deploy/bundle/lib/render.mjs --site <file> [--release <name>] [--all]   print the rendered YAML (every enabled release, or one; --all
//                                                                                 also renders releases whose enabledWhen does not match the site)
//   node deploy/bundle/lib/render.mjs --site <file> --substitute <file>         print one file with the site settings substituted
//
// Release descriptor: deploy/values/<release>.release.json, the release name being the file name. Fields: chart (a charts.lock.json name, or
// path:<directory> for a local chart), namespace, order (install order), values (our values files), site (optional per-site values file under
// deploy/values/site.example/), images (list of { lock: <image name in images.lock.json>, set: { <values path>: <part> } }, part one of ref,
// registry, repository, digest, tagAtDigest), enabledWhen (optional site-global equalities), instances (optional site-global list; the release
// renders once per item as <release>-<item.name>, the item passed as the value `instance`), secrets (optional, read by the install script), note.
//
// Site file: JSON syntax (valid YAML), parsed with JSON.parse. A values file names a setting as ${site.<dotted key>}; a token that is a whole
// double-quoted string ("${site.key}") is replaced together with its quotes by the JSON of the value (so a JSON file stays valid JSON), anywhere
// else a string is inserted as is and a list or object as JSON flow text. A setting the site file lacks, or leaves empty, stops the render with a plain
// message: required settings have no silent default (D-11). Only the settings in OPTIONAL_EMPTY may be an empty string.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARTS_LOCK, IMAGES_LOCK, readChartsLock, readImagesLock, resolveImage } from './locks.mjs';

export const VALUES_DIR = 'deploy/values';
/** The Kubernetes version charts are rendered for: RKE2 v1.37.2+rke2r1 (research, Standard Stack). */
export const KUBE_VERSION = '1.37.2';
export const IMAGE_PARTS = Object.freeze(['ref', 'registry', 'repository', 'digest', 'tagAtDigest']);
const DESCRIPTOR_FIELDS = new Set(['chart', 'namespace', 'order', 'values', 'site', 'images', 'enabledWhen', 'instances', 'secrets', 'note']);
const RELEASE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const TOKEN = /("?)\$\{site\.([A-Za-z0-9_.-]+)\}("?)/g;

/** The site settings every site file must set to a non-empty value (deploy/values/site.example.yaml ships them empty, D-11). */
export const REQUIRED_SITE_SETTINGS = Object.freeze(['siteName', 'domain', 'rpId', 'registry', 'registryKind', 'clusterCidrs.pod', 'clusterCidrs.service',
  'clusterCidrs.nodes', 'storageClass', 'requestedStorage', 'signInKeys', 'organizationPublicKey', 'stepUpAcr']);
/** The only settings an empty string is a meaningful value for (storageEncryptionAtRest is empty for the reference Longhorn class). */
export const OPTIONAL_EMPTY = new Set(['storageEncryptionAtRest']);

const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** Reads a site file (JSON syntax, which is also YAML) and refuses it when a required setting is missing or empty. */
export function loadSite(file) {
  let site;
  try {
    site = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: the site file could not be read as JSON (${error.message}).`);
  }
  const blank = REQUIRED_SITE_SETTINGS.filter((key) => isBlank(siteValue(site, key)));
  if (blank.length) {
    throw new Error(`${file}: the site setting${blank.length > 1 ? 's' : ''} ${blank.join(', ')} ${blank.length > 1 ? 'are' : 'is'} missing or empty; `
      + 'each is required and has no default (D-11). Set it in the site file (its note says what it is).');
  }
  return site;
}

/** The site setting at a dotted key, or undefined. */
export function siteValue(site, key) {
  let value = site;
  for (const part of key.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

/** Replaces every ${site.<key>} token in `text` (see the top of this file); `file` names the source in the refusal message. */
export function substituteSite(text, site, file) {
  return text.replace(TOKEN, (_whole, open, key, close) => {
    const value = siteValue(site, key);
    if (value === undefined || value === null) throw new Error(`${file}: \${site.${key}} is not set in the site file.`);
    if (isBlank(value) && !OPTIONAL_EMPTY.has(key)) throw new Error(`${file}: \${site.${key}} is empty in the site file; it is required and has no default (D-11).`);
    if (open && close) return JSON.stringify(value);
    const inserted = typeof value === 'string' ? value : JSON.stringify(value);
    return `${open}${inserted}${close}`;
  });
}

/** Splits rendered YAML into its documents (on `---` document lines), dropping empty ones. */
export function splitDocs(text) {
  return text.split(/^---[ \t]*$/m).map((doc) => doc.trim()).filter((doc) => doc && !/^(#[^\n]*\n?)*$/.test(doc));
}

/** Every release descriptor, sorted by order then name. Refuses a descriptor that is not well formed. */
export function listReleases(root) {
  const dir = path.join(root, VALUES_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.release.json')).sort() : [];
  const releases = files.map((name) => {
    const file = `${VALUES_DIR}/${name}`;
    const release = name.slice(0, -'.release.json'.length);
    let descriptor;
    try { descriptor = JSON.parse(readFileSync(path.join(root, file), 'utf8')); } catch (error) { throw new Error(`${file}: not valid JSON (${error.message}).`); }
    const unknown = Object.keys(descriptor).filter((key) => !DESCRIPTOR_FIELDS.has(key));
    const problem = !RELEASE_NAME.test(release) || release.length > 53 ? `the release name "${release}" must be lowercase letters, digits and dashes, at most 53 characters`
      : unknown.length ? `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`
        : typeof descriptor.namespace !== 'string' || !descriptor.namespace ? 'it has no namespace'
          : typeof descriptor.chart !== 'string' || !descriptor.chart ? 'it has no chart'
            : !Number.isInteger(descriptor.order) ? 'its order must be an integer'
              : !Array.isArray(descriptor.values ?? []) || !Array.isArray(descriptor.images ?? []) ? 'values and images must be lists'
                : '';
    if (problem) throw new Error(`${file}: ${problem}.`);
    return { name: release, file, images: [], values: [], ...descriptor };
  });
  return releases.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Whether the release's enabledWhen matches the site. A key the site file lacks is refused, so a typo never disables a release silently. */
export function isEnabled(release, site) {
  return Object.entries(release.enabledWhen ?? {}).every(([key, expected]) => {
    const value = siteValue(site, key);
    if (value === undefined) throw new Error(`${release.file}: enabledWhen names \${site.${key}}, which is not set in the site file.`);
    return value === expected;
  });
}

/** The releases one descriptor renders as: [{ name, instance }] (one per item of its instances list, or the release itself). */
export function expandInstances(release, site) {
  if (!release.instances) return [{ name: release.name, instance: undefined }];
  const items = siteValue(site, release.instances);
  if (!Array.isArray(items)) throw new Error(`${release.file}: instances names \${site.${release.instances}}, which must be a list in the site file.`);
  const seen = new Set();
  return items.map((item) => {
    if (!item || typeof item.name !== 'string' || !RELEASE_NAME.test(item.name)) throw new Error(`${release.file}: every item of ${release.instances} needs a lowercase name.`);
    if (seen.has(item.name)) throw new Error(`${release.file}: ${release.instances} names ${item.name} twice; two releases would have the same name.`);
    seen.add(item.name);
    return { name: `${release.name}-${item.name}`, instance: item };
  });
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The chart argument for helm: the hash-checked vendored tarball, or a local chart directory. */
function chartPath(root, release) {
  if (release.chart.startsWith('path:')) {
    const dir = path.join(root, release.chart.slice('path:'.length));
    if (!existsSync(path.join(dir, 'Chart.yaml'))) throw new Error(`${release.file}: chart ${release.chart} is not a local chart directory (no Chart.yaml).`);
    return dir;
  }
  const entry = readChartsLock(root).charts.find((chart) => chart.name === release.chart);
  if (!entry) throw new Error(`${release.file}: chart ${release.chart} is not in ${CHARTS_LOCK} and is not a path:<directory> local chart.`);
  const file = path.join(root, entry.file);
  if (!existsSync(file)) throw new Error(`${entry.file} is missing; run node deploy/charts/vendor.mjs on a connected host.`);
  if (sha256(file) !== entry.sha256) throw new Error(`${entry.file} does not match the SHA-256 in ${CHARTS_LOCK}; refusing to render it.`);
  return file;
}

/** The --set-string arguments of the descriptor's image mappings, each resolved from the image lock with the site registry. */
function imageSets(root, release, site) {
  const lock = readImagesLock(root);
  const registry = siteValue(site, 'registry');
  if (!release.images.length) return [];
  if (typeof registry !== 'string' || !registry) throw new Error(`${release.file}: \${site.registry} is not set in the site file.`);
  const args = [];
  for (const mapping of release.images) {
    const image = resolveImage(lock, mapping.lock, registry);
    if (!image) throw new Error(`${release.file}: release ${release.name} maps the image ${mapping.lock}, which is not in ${IMAGES_LOCK}.`);
    for (const [valuePath, part] of Object.entries(mapping.set ?? {})) {
      if (!IMAGE_PARTS.includes(part)) throw new Error(`${release.file}: ${valuePath} asks for the image part "${part}"; use one of ${IMAGE_PARTS.join(', ')}.`);
      if (part === 'tagAtDigest' && !image.tag) throw new Error(`${release.file}: the image ${mapping.lock} has no tag in ${IMAGES_LOCK}, so ${valuePath} cannot use tagAtDigest.`);
      const value = part === 'tagAtDigest' ? `${image.tag}@${image.digest}` : image[part];
      args.push('--set-string', `${valuePath}=${value}`);
    }
  }
  return args;
}

const resolveRelease = (root, release) => {
  if (typeof release !== 'string') return release;
  const found = listReleases(root).find((candidate) => candidate.name === release);
  if (!found) throw new Error(`There is no release ${release} (no ${VALUES_DIR}/${release}.release.json).`);
  return found;
};

/**
 * Renders one release (a descriptor from listReleases, or its name) for a site (an object, or a site file path). Returns the YAML of every
 * instance, or '' when the release's enabledWhen does not match the site and `all` is not set. Throws with a plain message on any refusal.
 */
export function renderRelease(root, release, { site, helm = process.env.HELM || 'helm', all = false } = {}) {
  const descriptor = resolveRelease(root, release);
  const settings = typeof site === 'string' ? loadSite(site) : site;
  if (!settings || typeof settings !== 'object') throw new Error('renderRelease needs a site (a site file path or its parsed settings).');
  // Every refusal comes before helm runs, so a mistake never renders a chart's upstream defaults.
  const chart = chartPath(root, descriptor);
  const enabled = isEnabled(descriptor, settings);
  const sets = imageSets(root, descriptor, settings);
  const instances = expandInstances(descriptor, settings);
  const sources = [...descriptor.values, ...(descriptor.site ? [descriptor.site] : [])];
  const texts = sources.map((file) => {
    if (!existsSync(path.join(root, file))) throw new Error(`${descriptor.file}: the values file ${file} does not exist.`);
    return { file, text: substituteSite(readFileSync(path.join(root, file), 'utf8'), settings, file) };
  });
  if (!enabled && !all) return '';
  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-render-'));
  try {
    const home = path.join(scratch, 'helm-home');
    mkdirSync(home);
    const copies = texts.map(({ file, text }, index) => {
      const copy = path.join(scratch, `${String(index).padStart(2, '0')}-${path.basename(file)}`);
      writeFileSync(copy, text);
      return copy;
    });
    const env = { ...process.env, HELM_CACHE_HOME: path.join(home, 'cache'), HELM_CONFIG_HOME: path.join(home, 'config'), HELM_DATA_HOME: path.join(home, 'data') };
    const outputs = instances.map(({ name, instance }) => {
      const args = ['template', name, chart, '--namespace', descriptor.namespace, '--include-crds', '--kube-version', KUBE_VERSION,
        ...copies.flatMap((copy) => ['-f', copy]), ...sets, ...(instance ? ['--set-json', `instance=${JSON.stringify(instance)}`] : [])];
      const run = spawnSync(helm, args, { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      if (run.error?.code === 'ENOENT') throw new Error(`helm was not found (${helm}); set HELM to the helm binary or put helm on PATH.`);
      if (run.error) throw run.error;
      if (run.status !== 0) throw new Error(`helm template ${name} failed: ${run.stderr.trim()}`);
      return run.stdout;
    });
    return outputs.join('\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Renders every release for a site: [{ name, release, yaml }] for each rendered instance, in install order. Refuses two with one name. */
export function renderSite(root, { site, helm, all = false } = {}) {
  const settings = typeof site === 'string' ? loadSite(site) : site;
  const releases = listReleases(root);
  const owner = new Map();
  for (const release of releases) {
    for (const { name } of expandInstances(release, settings)) {
      if (owner.has(name)) throw new Error(`${release.file} and ${owner.get(name)} both render a release named ${name}.`);
      owner.set(name, release.file);
    }
  }
  return releases.map((release) => ({ name: release.name, release, yaml: renderRelease(root, release, { site: settings, helm, all }) })).filter((item) => item.yaml);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const argv = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  try {
    const siteFile = option('--site');
    if (!siteFile) throw new Error('usage: render.mjs --site <file> [--release <name>] [--all] | --site <file> --substitute <file>');
    const site = loadSite(siteFile);
    const substitute = option('--substitute');
    const one = option('--release');
    const all = argv.includes('--all');
    if (substitute) {
      process.stdout.write(substituteSite(readFileSync(substitute, 'utf8'), site, substitute));
    } else if (one) {
      const release = resolveRelease(root, one);
      if (!all && !isEnabled(release, site)) throw new Error(`${release.file}: release ${one} is not enabled for this site (enabledWhen ${JSON.stringify(release.enabledWhen)}); pass --all to render it anyway.`);
      process.stdout.write(renderRelease(root, release, { site, all }));
    } else {
      for (const { yaml } of renderSite(root, { site, all })) process.stdout.write(`${yaml}\n`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

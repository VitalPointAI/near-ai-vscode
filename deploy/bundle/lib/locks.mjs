// The lock files every deploy script reads (D-12, D-13, D-20, D-21): deploy/charts/charts.lock.json (every upstream chart, vendored and hash-locked),
// deploy/bundle/images.lock.json (every image, by digest) and compliance/ci/tool-pins.json (the pinned tools). Node built-ins only; the files are
// read as JSON, never run.
//
// Image lock sections: `images` (third-party, { ref: "<host>/<repository>:<tag>@sha256:<64 hex, the linux/amd64 manifest>", component }), `built` (ours, { name:
// "sterling/<name>", image: "deploy/images/<name>/image.json", component, digest: null | "sha256:...", optional tag for a chart that joins
// repository and tag }) and `release` (published by another pipeline, { name, from, digest: null | "sha256:..." }). A site registry serves every image under `sitePath(ref)`.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CHARTS_LOCK = 'deploy/charts/charts.lock.json';
export const IMAGES_LOCK = 'deploy/bundle/images.lock.json';
export const TOOL_PINS = 'compliance/ci/tool-pins.json';
/** Stands in for the digest of an image of ours that is not published yet, so a render can still run; never accepted at install. */
export const UNPUBLISHED_DIGEST = `sha256:${'0'.repeat(64)}`;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;

const readJson = (root, file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

export function readChartsLock(root) {
  const lock = readJson(root, CHARTS_LOCK);
  if (!Array.isArray(lock.charts)) throw new Error(`${CHARTS_LOCK}: "charts" must be a list.`);
  return lock;
}

export function readImagesLock(root) {
  const lock = readJson(root, IMAGES_LOCK);
  for (const section of ['images', 'built', 'release']) if (!Array.isArray(lock[section])) throw new Error(`${IMAGES_LOCK}: "${section}" must be a list.`);
  return lock;
}

export function readToolPins(root) {
  return readJson(root, TOOL_PINS);
}

/** Splits `<host>/<repository>:<tag>@<digest>` (host, tag and digest optional). A first path part with a dot or a colon, or `localhost`, is a host. */
export function splitRef(ref) {
  const [withTag, digest = null] = ref.split('@');
  const slash = withTag.lastIndexOf('/');
  const colon = withTag.indexOf(':', slash + 1);
  const name = colon < 0 ? withTag : withTag.slice(0, colon);
  const tag = colon < 0 ? null : withTag.slice(colon + 1);
  const first = name.split('/')[0];
  const hasHost = name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  return { name, host: hasHost ? first : null, repository: hasHost ? name.slice(first.length + 1) : name, tag, digest };
}

/**
 * The repository path an image has in the site registry: the source registry host removed, the rest kept
 * (`quay.io/jetstack/cert-manager-controller:v1.21.3@sha256:...` is `jetstack/cert-manager-controller`; a built image `sterling/<name>` stays as is).
 * Spike S1 (47-01) confirmed this is the path the hauler bundle copy produces in the site registry.
 */
export function sitePath(ref) {
  return splitRef(ref).repository;
}

/** The lock name of a third-party entry: its reference without tag or digest. */
export const imageName = (entry) => splitRef(entry.ref).name;

/**
 * One image of the lock as the site registry serves it: { ref (`<registry>/<sitePath>@<digest>`), registry, repository, digest, tag, unpublished }.
 * `name` is a third-party reference without tag or digest, or the `name` of a `built` or `release` entry. Returns null when the lock has no such image.
 */
export function resolveImage(lock, name, registry) {
  const third = lock.images.find((entry) => imageName(entry) === name);
  let digest;
  let tag;
  let unpublished = false;
  if (third) {
    ({ digest, tag } = splitRef(third.ref));
  } else {
    const ours = [...lock.built, ...lock.release].find((entry) => entry.name === name);
    if (!ours) return null;
    digest = ours.digest ?? UNPUBLISHED_DIGEST;
    unpublished = ours.digest == null;
    tag = ours.tag ?? null;
  }
  const repository = sitePath(name);
  return { ref: `${registry}/${repository}@${digest}`, registry, repository, digest, tag, unpublished };
}

/** Every image of the lock as the site registry serves it (the set a rendered `image:` must come from). */
export function allImages(lock, registry) {
  const names = [...lock.images.map(imageName), ...lock.built.map((entry) => entry.name), ...lock.release.map((entry) => entry.name)];
  return names.map((name) => ({ name, ...resolveImage(lock, name, registry) }));
}

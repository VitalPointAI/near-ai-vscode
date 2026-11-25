// The registry's own images for the nodes (D-15, research Pitfall 8): the site registry cannot pull itself before it exists, so its images
// reach containerd as an image archive in each node's folder (install-node.sh copies images/*.tar into RKE2's image folder). The bundle is
// the same for every site, so the build writes a site-neutral OCI image layout (registry-images.tar, a file item under the manifest
// signature), and node-files names each image for the site's registry (io.containerd.image.name, by tag and by digest) before the archive
// goes to the nodes. The manifests and blobs are copied byte for byte, so the digests the pods ask for are the bundle's. Node built-ins and tar.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sitePath, splitRef } from './locks.mjs';

export const REGISTRY_IMAGES = 'registry-images.tar';
const SITE_PATH = 'io.sterling.site-path';

/** The lock images the registry itself runs on: component image-registry (Zot, and the Harbor set). */
export const registryImages = (lock) => lock.images.filter((entry) => entry.component === 'image-registry')
  .map((entry) => ({ path: sitePath(entry.ref), tag: splitRef(entry.ref).tag, digest: splitRef(entry.ref).digest }));

const tar = (args) => {
  const run = spawnSync('tar', args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`tar ${args[0]} failed: ${run.stderr || run.error?.message}`);
};
const blobPath = (dir, digest) => path.join(dir, 'blobs', 'sha256', digest.replace(/^sha256:/, ''));

/** Writes an OCI layout tar of `images` ([{ path, tag, digest }]) from an OCI layout store (a hauler store folder) to `file`. */
export function writeRegistryLayout(store, images, file) {
  const out = mkdtempSync(path.join(tmpdir(), 'sterling-registry-images-'));
  try {
    mkdirSync(path.join(out, 'blobs', 'sha256'), { recursive: true });
    const manifests = images.map((image) => {
      const source = blobPath(store, image.digest);
      if (!existsSync(source)) throw new Error(`${image.path}@${image.digest} is not in the store; add it by digest first.`);
      const bytes = readFileSync(source);
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (!manifest.config || !Array.isArray(manifest.layers)) throw new Error(`${image.path}@${image.digest} is not a single-platform image manifest.`);
      for (const digest of [image.digest, manifest.config.digest, ...manifest.layers.map((layer) => layer.digest)]) copyFileSync(blobPath(store, digest), blobPath(out, digest));
      return { mediaType: manifest.mediaType, digest: image.digest, size: bytes.length, platform: { architecture: 'amd64', os: 'linux' },
        annotations: { 'org.opencontainers.image.ref.name': image.tag, [SITE_PATH]: image.path } };
    });
    writeFileSync(path.join(out, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    writeFileSync(path.join(out, 'index.json'), JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests }));
    tar(['-cf', file, '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-C', out, '.']);
    return file;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Copies the site-neutral archive to `file` with every image named for `registry`, once by tag and once by digest, for containerd. */
export function nameForSite(archive, registry, file) {
  const work = mkdtempSync(path.join(tmpdir(), 'sterling-registry-images-'));
  try {
    tar(['-xf', archive, '-C', work]);
    const index = JSON.parse(readFileSync(path.join(work, 'index.json'), 'utf8'));
    const manifests = index.manifests.flatMap((entry) => {
      const where = entry.annotations?.[SITE_PATH];
      if (!where) throw new Error(`${archive}: an image has no site path; the archive was not written by the bundle build.`);
      const name = `${registry}/${where}`;
      const tag = entry.annotations['org.opencontainers.image.ref.name'];
      return [...(tag ? [`${name}:${tag}`] : []), `${name}@${entry.digest}`]
        .map((ref) => ({ ...entry, annotations: { ...entry.annotations, 'io.containerd.image.name': ref } }));
    });
    writeFileSync(path.join(work, 'index.json'), JSON.stringify({ ...index, manifests }));
    mkdirSync(path.dirname(file), { recursive: true });
    tar(['-cf', file, '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-C', work, '.']);
    return file;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

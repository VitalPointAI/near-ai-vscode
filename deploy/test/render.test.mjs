// The global render invariants (D-56): every release of the site stack, rendered offline with the CI site file, runs only digest-pinned images
// from the image lock, never pulls with Always, and contains none of the components the owner ruled out (an ACME issuer D-16, ingress-nginx D-07,
// k3s D-14, the AGPL Loki log store D-19). The vendored charts are hash-checked before anything renders (D-13, D-21). Needs helm ($HELM or PATH);
// it fails, never skips, when helm is missing. Run: env HELM=compliance/out/tools/linux-amd64/helm node scripts/run-tests.mjs deploy/test/*.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkVendored } from '../charts/vendor.mjs';
import { DIGEST, UNPUBLISHED_DIGEST, allImages, readImagesLock, splitRef } from '../bundle/lib/locks.mjs';
import { loadSite, renderSite, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';
const IMAGE_LINE = /^[ \t]*(?:-[ \t]+)?image:[ \t]*["']?([^\s"'#]+)/gm;

function helmFound() {
  const run = spawnSync(HELM, ['version', '--short'], { encoding: 'utf8' });
  return !run.error && run.status === 0;
}

test('helm is available for the render tests', () => {
  assert.ok(helmFound(), `helm was not found (${HELM}); set HELM to the helm binary (sh compliance/ci/install-tool.sh helm compliance/out/tools) or put it on PATH.`);
});

test('every vendored chart matches charts.lock.json and no unlisted tarball is present', () => {
  assert.deepEqual(checkVendored(ROOT), []);
});

test('every rendered release meets the global invariants', (t) => {
  assert.ok(helmFound(), `helm was not found (${HELM}).`);
  const lock = readImagesLock(ROOT);
  const allowed = new Map(allImages(lock, SITE.registry).map((image) => [image.ref, image]));
  const rendered = renderSite(ROOT, { site: SITE, helm: HELM, all: true });
  assert.ok(rendered.length > 0, 'no release rendered');
  let checked = 0;
  for (const { name, yaml } of rendered) {
    for (const doc of splitDocs(yaml)) {
      const kind = /^kind:[ \t]*(\S+)/m.exec(doc)?.[1] ?? '(no kind)';
      const where = `${name}: ${kind} ${/^metadata:\n(?:[ \t]+.*\n)*?[ \t]+name:[ \t]*(\S+)/m.exec(doc)?.[1] ?? ''}`;
      for (const [, ref] of doc.matchAll(IMAGE_LINE)) {
        checked += 1;
        const { name: imageName, digest } = splitRef(ref);
        assert.match(digest ?? '', DIGEST, `${where}: the image ${ref} is not pinned by a sha256 digest`);
        const image = allowed.get(`${imageName}@${digest}`);
        assert.ok(image, `${where}: the image ${ref} is not ${SITE.registry}/<sitePath>@<digest> of any entry in deploy/bundle/images.lock.json`);
        if (digest === UNPUBLISHED_DIGEST) {
          assert.ok(image.unpublished, `${where}: ${ref} uses the unpublished placeholder digest for an image that is published`);
          t.diagnostic(`${where}: ${image.name} is not published yet (placeholder digest)`);
        }
      }
      assert.doesNotMatch(doc, /imagePullPolicy:[ \t]*["']?Always/, `${where}: imagePullPolicy Always (D-20)`);
      if (/^(Cluster)?Issuer$/.test(kind)) assert.doesNotMatch(doc, /^[ \t]*acme:/m, `${where}: an ACME issuer (D-16)`);
      assert.doesNotMatch(doc, /ingress-nginx|nginx\.ingress\.kubernetes\.io/, `${where}: ingress-nginx (D-07)`);
      assert.doesNotMatch(doc, /ingressClassName:[ \t]*["']?nginx["']?[ \t]*$|kubernetes\.io\/ingress\.class:[ \t]*["']?nginx["']?[ \t]*$/m, `${where}: the nginx ingress class (D-07)`);
      assert.doesNotMatch(doc, /k3s/i, `${where}: k3s (D-14)`);
      assert.doesNotMatch(doc, /grafana\/loki/, `${where}: the Loki log store (D-19)`);
    }
  }
  assert.ok(checked > 0, 'no image: line was found in the rendered output');
});

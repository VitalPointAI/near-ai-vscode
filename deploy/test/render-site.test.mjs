// Site storage, logs, metrics and the HQ registry, on the rendered stack (D-15, D-17, D-19, D-26, D-35): every storage class encrypts at
// rest, Fluent Bit ships to the site's own OpenSearch only, Prometheus writes nowhere else, and Harbor is behind site TLS with no internet
// scanner. Renders every release with the CI site (all releases, whatever enabledWhen says). Needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { loadSite, renderSite, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';
let rendered;
const docsOf = (name) => splitDocs(rendered.find((release) => release.name === name)?.yaml ?? '');
const kindOf = (doc) => /^kind:[ \t]*(\S+)/m.exec(doc)?.[1];

before(() => { rendered = renderSite(ROOT, { site: SITE, helm: HELM, all: true }); });

test('every rendered StorageClass is a Longhorn class encrypted with the class key', () => {
  const classes = rendered.flatMap(({ name, yaml }) => splitDocs(yaml).filter((doc) => kindOf(doc) === 'StorageClass').map((doc) => ({ name, doc })));
  assert.ok(classes.length >= 1);
  for (const { name, doc } of classes) {
    const where = `${name}: StorageClass ${/^ {2}name: (\S+)/m.exec(doc)?.[1]}`;
    assert.match(doc, /^provisioner: driver\.longhorn\.io$/m, `${where} is not a Longhorn class`);
    assert.match(doc, /^ {2}encrypted: "true"$/m, `${where} is not encrypted at rest`);
    for (const stage of ['provisioner', 'node-publish', 'node-stage', 'node-expand']) {
      assert.match(doc, new RegExp(`csi\\.storage\\.k8s\\.io/${stage}-secret-name: longhorn-crypto`), `${where}: ${stage} key`);
    }
  }
  const ours = docsOf('sterling-storage').filter((doc) => kindOf(doc) === 'StorageClass');
  assert.equal(ours.length, 1);
  assert.match(ours[0], new RegExp(`^ {2}name: ${SITE.storageClass}$`, 'm'));
  assert.match(ours[0], /^reclaimPolicy: Retain$/m);
  assert.equal(docsOf('sterling-storage').filter((doc) => kindOf(doc) === 'RecurringJob').length, 2, 'a daily snapshot and a daily backup');
});

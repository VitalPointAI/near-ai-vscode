// The global render invariants (D-56), shared by CI (deploy/test/render.test.mjs) and the site install preflight (lib/preflight.mjs), so the
// site's own rendered values pass the same checks as CI's before anything is installed. Every rendered image is pinned by a sha256 digest and is
// <site registry>/<site path>@<digest> of an entry in deploy/bundle/images.lock.json; nothing pulls with Always; and none of the components the
// owner ruled out appears: an ACME issuer (D-16), ingress-nginx or its class (D-07), k3s (D-14), the AGPL Loki log store (D-19). Node built-ins.
import { DIGEST, UNPUBLISHED_DIGEST, allImages, splitRef } from './locks.mjs';
import { splitDocs } from './render.mjs';

export const IMAGE_LINE = /^[ \t]*(?:-[ \t]+)?image:[ \t]*["']?([^\s"'#]+)/gm;

/** A rendered document with the values of a Secret's top-level `data:` and `stringData:` maps removed (keys kept). Other documents are unchanged. */
export function withoutSecretValues(doc) {
  if (!/^kind:[ \t]*Secret[ \t]*$/m.test(doc)) return doc;
  let inValues = false;
  return doc.split('\n').map((line) => {
    if (/^(data|stringData):[ \t]*$/.test(line)) { inValues = true; return line; }
    if (!/^[ \t]/.test(line)) inValues = false;
    return inValues ? line.replace(/:[ \t].*$/, ':') : line;
  }).join('\n');
}

/** The `metadata.name` of a rendered document: the first indented `name:` line under a top-level `metadata:` line (line by line, no backtracking). */
export function metadataName(doc) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => /^metadata:[ \t]*$/.test(line));
  if (start < 0) return '';
  for (const line of lines.slice(start + 1)) {
    if (!/^[ \t]/.test(line)) break;
    const match = /^[ \t]+name:[ \t]*(\S+)/.exec(line);
    if (match) return match[1];
  }
  return '';
}

/**
 * Checks rendered releases ([{ name, yaml }]) against the global invariants. Returns { problems, imagesChecked, unpublished }: problems are plain
 * lines naming the release and the object; unpublished lists the objects that use the reserved placeholder digest of an unpublished image (a
 * diagnostic in CI; the preflight refuses unpublished items through the bundle manifest).
 */
export function checkRendered(rendered, { lock, registry }) {
  const allowed = new Map(allImages(lock, registry).map((image) => [image.ref, image]));
  const problems = [];
  const unpublished = [];
  let imagesChecked = 0;
  for (const { name, yaml } of rendered) {
    for (const doc of splitDocs(yaml)) {
      const kind = /^kind:[ \t]*(\S+)/m.exec(doc)?.[1] ?? '(no kind)';
      const where = `${name}: ${kind} ${metadataName(doc)}`;
      for (const [, ref] of doc.matchAll(IMAGE_LINE)) {
        imagesChecked += 1;
        const { name: imageName, digest } = splitRef(ref);
        if (!DIGEST.test(digest ?? '')) { problems.push(`${where}: the image ${ref} is not pinned by a sha256 digest`); continue; }
        const image = allowed.get(`${imageName}@${digest}`);
        if (!image) { problems.push(`${where}: the image ${ref} is not ${registry}/<sitePath>@<digest> of any entry in deploy/bundle/images.lock.json`); continue; }
        if (digest === UNPUBLISHED_DIGEST) {
          if (!image.unpublished) problems.push(`${where}: ${ref} uses the unpublished placeholder digest for an image that is published`);
          else unpublished.push(`${where}: ${image.name} is not published yet (placeholder digest)`);
        }
      }
      if (/imagePullPolicy:[ \t]*["']?Always/.test(doc)) problems.push(`${where}: imagePullPolicy Always (D-20)`);
      if (/^(Cluster)?Issuer$/.test(kind) && /^[ \t]*acme:/m.test(doc)) problems.push(`${where}: an ACME issuer (D-16)`);
      if (/ingress-nginx|nginx\.ingress\.kubernetes\.io/.test(doc)) problems.push(`${where}: ingress-nginx (D-07)`);
      if (/ingressClassName:[ \t]*["']?nginx["']?[ \t]*$|kubernetes\.io\/ingress\.class:[ \t]*["']?nginx["']?[ \t]*$/m.test(doc)) problems.push(`${where}: the nginx ingress class (D-07)`);
      // A Secret's data values are generated at random by some charts (harbor-core), so any three letters can appear in them by chance;
      // the k3s check reads everything except those values. A real k3s dependency shows up in names, images or labels, not in random data.
      if (/k3s/i.test(withoutSecretValues(doc))) problems.push(`${where}: k3s (D-14)`);
      if (/grafana\/loki/.test(doc)) problems.push(`${where}: the Loki log store (D-19)`);
    }
  }
  return { problems, imagesChecked, unpublished };
}

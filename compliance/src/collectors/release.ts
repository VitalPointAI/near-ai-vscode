import { createHash } from 'node:crypto';
import type { Observation } from '../model.ts';
import type { Collector, CollectorContext, FetchJson } from './types.ts';
import { checkRepository, collectorError, githubGet, requireFetch, segment } from './github.ts';
export interface ReleaseInput { readonly repository: string; readonly tag: string; }

const COMMIT = /^[0-9a-f]{40}$/i;
const options = { collector: 'release', permission: 'contents read' } as const;
interface Asset { readonly name?: unknown; readonly digest?: unknown; }
const sha256Of = (asset: Asset | undefined): string =>
  typeof asset?.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : '';

/** The commit a tag names. Release tags are annotated, so the ref points at a tag object that is peeled to its commit. */
async function tagCommit(fetchJson: FetchJson, repository: string, tag: string): Promise<string> {
  let object = (await githubGet(fetchJson, `/repos/${repository}/git/ref/tags/${segment(tag)}`, {}, options) as { object?: { sha?: unknown; type?: unknown } })?.object;
  for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) {
    if (typeof object.sha !== 'string' || !COMMIT.test(object.sha)) break;
    object = (await githubGet(fetchJson, `/repos/${repository}/git/tags/${object.sha}`, {}, options) as { object?: { sha?: unknown; type?: unknown } })?.object;
  }
  if (object?.type !== 'commit' || typeof object.sha !== 'string' || !COMMIT.test(object.sha)) throw collectorError('unexpected-response', 'release: tag does not name a commit');
  return object.sha.toLowerCase();
}

/**
 * Release evidence is only a tag on main whose published VSIX matches its published checksum file. GitHub's release asset API gives each
 * asset's SHA-256 digest but not its content, and release.yml writes the checksum file as exactly "<sha256>  <vsix name>\n", so the
 * checksum file's own digest must equal the SHA-256 of that line built from the VSIX's digest.
 */
export const releaseCollector: Collector<ReleaseInput> = Object.freeze({
  id: 'release',
  window: 'attestation',
  async collect(input: ReleaseInput, context: CollectorContext): Promise<Observation[]> {
    const repository = checkRepository(input?.repository, 'release');
    if (typeof input?.tag !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(input.tag)) throw collectorError('invalid-input', 'release: tag must be a version tag');
    const fetchJson = requireFetch(context.fetchJson, 'release');
    const sha = await tagCommit(fetchJson, repository, input.tag);
    const comparison = await githubGet(fetchJson, `/repos/${repository}/compare/${sha}...main`, {}, options);
    const status = (comparison as { status?: unknown })?.status;
    const onMain = status === 'identical' || status === 'behind';
    const release = await githubGet(fetchJson, `/repos/${repository}/releases/tags/${segment(input.tag)}`, {}, options);
    const assets = (release as { assets?: unknown })?.assets;
    if (!Array.isArray(assets)) throw collectorError('unexpected-response', 'release: release has no assets list');
    const named = (suffix: string): Asset | undefined => (assets as Asset[]).find((asset) => typeof asset?.name === 'string' && asset.name.endsWith(suffix));
    const vsix = named('.vsix');
    const checksum = named('.vsix.sha256');
    const digest = sha256Of(vsix);
    const expectedLine = digest && typeof vsix?.name === 'string' ? `${digest}  ${vsix.name}\n` : '';
    const checksumMatches = Boolean(expectedLine && sha256Of(checksum) && createHash('sha256').update(expectedLine).digest('hex') === sha256Of(checksum));
    return [{
      collector: 'release', subject: input.tag, passed: onMain && checksumMatches, collectedAt: context.now.toISOString(), commit: context.commit,
      ...(context.runUrl ? { runUrl: context.runUrl } : {}),
      counts: { assets: assets.length, onMain: Number(onMain), checksumMatches: Number(checksumMatches), failures: Number(!onMain) + Number(!checksumMatches) }
    }];
  }
});

// `release-evidence` (48.2-05, D-02, D-15, D-16): assembles a release's evidence folder for the image's /opt/sterling/evidence.
//
//   release-evidence --bundle <dir> --out <dir> --release <x.y.z> --built-at <ISO> --subject sha256:<64 hex>
//                    --sbom <cdx.json> --scan <grype.json> --db-status <json>
//                    (--package <tar.gz> --package-sha256 <file> | --no-package) [--road-to-production <md>] [--gaps <json>] [--commit <sha>]
//   release-evidence --no-bundle --no-package --commit <sha> --out <dir> --release ... --sbom ... --scan ... --db-status ...
//
// The bundle is verified against its own manifest first. A hotfix with no compliance package runs --no-package (and --no-bundle when it has
// no bundle either): the folder still holds the SBOM and the scan. Usage errors exit 2; a refused input exits 1 with one line and writes nothing.
import { verifyManifest } from '../manifest.ts';
import { writeReleaseEvidence } from '../releaseEvidence.ts';

const USAGE = 'usage: release-evidence (--bundle <dir> | --no-bundle --commit <sha>) (--package <tar.gz> --package-sha256 <file> | --no-package)\n'
  + '       --out <dir> --release <x.y.z> --built-at <ISO> --subject sha256:<hex> --sbom <cdx.json> --scan <grype.json> --db-status <json>\n'
  + '       [--road-to-production <md>] [--gaps <json>] [--commit <sha>]\n';

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

export async function run(args: readonly string[], io: { readonly stderr?: (text: string) => void } = {}): Promise<number> {
  const stderr = io.stderr ?? ((line: string) => { process.stderr.write(line); });
  const value = (name: string) => option(args, name);
  const noBundle = args.includes('--no-bundle');
  const noPackage = args.includes('--no-package');
  const bundleDir = value('--bundle');
  const packageFile = value('--package');
  const packageSha256 = value('--package-sha256');
  const required = ['--out', '--release', '--built-at', '--subject', '--sbom', '--scan', '--db-status'].map(value);
  const usable = required.every((item) => item !== undefined && !item.startsWith('--'))
    && (noBundle ? bundleDir === undefined && noPackage && value('--commit') !== undefined : bundleDir !== undefined)
    && (noPackage ? packageFile === undefined && packageSha256 === undefined : packageFile !== undefined && packageSha256 !== undefined);
  if (!usable) {
    stderr(USAGE);
    return 2;
  }
  const [out, release, builtAt, subject, sbom, scan, dbStatus] = required as string[];
  try {
    if (bundleDir !== undefined) {
      const verified = verifyManifest(bundleDir);
      if (!verified.ok) throw new Error(`the bundle does not verify against its manifest: ${verified.errors.join('; ')}`);
    }
    const commit = value('--commit');
    const road = value('--road-to-production');
    const gaps = value('--gaps');
    writeReleaseEvidence({
      out: out!, release: release!, builtAt: builtAt!, subject: subject!, sbom: sbom!, scan: scan!, dbStatus: dbStatus!,
      ...(bundleDir !== undefined ? { bundleDir } : {}), ...(commit !== undefined ? { commit } : {}),
      ...(packageFile !== undefined && packageSha256 !== undefined ? { packageFile, packageSha256 } : {}),
      ...(road !== undefined ? { roadToProduction: road } : {}), ...(gaps !== undefined ? { gaps } : {}),
    });
    return 0;
  } catch (error) {
    stderr(`release-evidence: ${(error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' ')}\n`);
    return 1;
  }
}

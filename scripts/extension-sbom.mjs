// The extension's own SBOM: every third-party package it ships (vendor/manifest.json, written by
// vendor-libs.mjs), checked on OSV.dev. Writes sbom.cdx.json, which goes into the VSIX, and fails
// on a high or critical vulnerability in shipped code. Build-only tools are not shipped and are
// not listed; `npm audit` covers them.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { queryOsv } = require(path.join(root, 'dist', 'security', 'osv.js'));
const { cycloneDx, scanSummary } = require(path.join(root, 'dist', 'security', 'scan.js'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'vendor', 'manifest.json'), 'utf8'));

const components = manifest.map((entry) => ({ ecosystem: 'npm', name: entry.name, version: entry.version, purl: entry.purl, source: entry.path }));
const packages = await queryOsv(components);
const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
for (const finding of packages) for (const vuln of finding.vulnerabilities) counts[vuln.severity] += 1;
const report = { scannedAt: new Date().toISOString(), components, runtimes: [], packages, runtimeFindings: [], lockfiles: ['vendor/manifest.json'], notes: [], errors: [], counts, sbomWritten: true };
const bom = cycloneDx(report, `${pkg.publisher}.${pkg.name}`, { name: 'scripts/extension-sbom.mjs', version: pkg.version });
bom.metadata.component = { type: 'application', 'bom-ref': 'project', name: pkg.name, version: pkg.version, publisher: pkg.publisher };
bom.components = bom.components.map((component) => ({ ...component, licenses: [{ expression: manifest.find((entry) => entry.purl === component.purl)?.license ?? 'NOASSERTION' }] }));
// The bundled map data the COP map draws (media/map/globe/DATA.json): CycloneDX data components with their source, terms, credit and the hash of
// the source file the tiles were made from. The synthetic IRON LANTERN pack is the extension's own (MIT) and is listed too.
const globe = JSON.parse(readFileSync(path.join(root, 'media', 'map', 'globe', 'DATA.json'), 'utf8'));
for (const set of globe.sets) {
  bom.components.push({
    type: 'data', 'bom-ref': `data:${set.id}`, name: set.name, description: `Map tiles z${set.generator.minzoom}-${set.generator.maxzoom} in media/map/globe/${set.id}/. Credit: ${set.credit}.`,
    licenses: [{ license: { name: set.terms.slice(0, 500) } }], hashes: [{ alg: 'SHA-256', content: set.sourceSha256 }],
    externalReferences: [{ type: 'distribution', url: set.sourceUrl }, { type: 'website', url: set.page }]
  });
}
bom.components.push({ type: 'data', 'bom-ref': 'data:iron-lantern-synthetic', name: 'IRON LANTERN synthetic terrain, imagery and weather pack', description: 'Generated from a seed by scripts/generate-env-pack.mjs (resources/staff/env/iron-lantern/); not a real place.', licenses: [{ license: { id: 'MIT' } }] });
writeFileSync(path.join(root, 'sbom.cdx.json'), `${JSON.stringify(bom, null, 2)}\n`);
console.log(scanSummary(report));
if (counts.critical || counts.high) { console.error('Release blocked: shipped code has a high or critical vulnerability. Upgrade it and rebuild.'); process.exit(1); }

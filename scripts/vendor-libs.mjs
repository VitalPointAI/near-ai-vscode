// Copies the third-party code the extension runs into vendor/, which ships in the VSIX (the
// extension is packaged without node_modules), and writes vendor/manifest.json, from which the
// extension's own SBOM is built. Run as part of `npm run compile`. Every source is a pinned
// devDependency.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');
// Some packages do not export package.json, so locate them by folder rather than through require.
const packageDir = (name) => path.join(root, 'node_modules', name);
const version = (name) => JSON.parse(readFileSync(path.join(packageDir(name), 'package.json'), 'utf8')).version;
const manifest = [];

function copy(name, files, target, license, extra = {}) {
  const dir = path.join(vendor, target);
  mkdirSync(dir, { recursive: true });
  for (const [from, to] of files) copyFileSync(path.join(packageDir(name), from), path.join(dir, to ?? path.basename(from)));
  manifest.push({ name, version: version(name), license, purl: `pkg:npm/${name.replace('@', '%40')}@${version(name)}`, path: `vendor/${target}`, ...extra });
}

copy('pdfjs-dist', [['legacy/build/pdf.min.mjs'], ['legacy/build/pdf.worker.min.mjs'], ['LICENSE']], 'pdfjs', 'Apache-2.0');
copy('@resvg/resvg-wasm', [['index.js', 'resvg.js'], ['index_bg.wasm', 'resvg.wasm']], 'resvg', 'MPL-2.0');
writeFileSync(path.join(vendor, 'resvg', 'NOTICE'), 'resvg-wasm (https://github.com/yisibl/resvg-js), unmodified.\nThis Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy\nof the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.\n');
copy('imagetracerjs', [['imagetracer_v1.2.6.js', 'imagetracer.js'], ['LICENSE']], 'imagetracer', 'Unlicense');
copy('dejavu-fonts-ttf', [['ttf/DejaVuSans.ttf'], ['ttf/DejaVuSans-Bold.ttf'], ['LICENSE']], 'fonts', 'Bitstream-Vera AND LicenseRef-Arev-Fonts');

/**
 * Bundles an entry and its dependencies into one CommonJS file under vendor/<target>, with
 * LICENSES.txt and manifest rows for exactly the packages esbuild included (nested copies too).
 */
async function bundle(entry, target, file, main) {
  mkdirSync(path.join(vendor, target), { recursive: true });
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true, legalComments: 'none', metafile: true, outfile: path.join(vendor, target, file), logLevel: 'error' });
  const dirs = [...new Set(Object.keys(result.metafile.inputs).map((input) => /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1]).filter(Boolean))].sort();
  const licenses = [];
  for (const dir of dirs) {
    const meta = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    const licenseFile = readdirSync(path.join(root, dir)).find((name) => /^(?:licen[cs]e|copying)/i.test(name));
    licenses.push(`== ${meta.name} ${meta.version} ==\n${licenseFile ? readFileSync(path.join(root, dir, licenseFile), 'utf8') : `${meta.license} (the package ships no license file)`}`);
    manifest.push({ name: meta.name, version: meta.version, license: typeof meta.license === 'string' ? meta.license : 'see LICENSES.txt', purl: `pkg:npm/${meta.name.replace('@', '%40')}@${meta.version}`, path: `vendor/${target}`, ...(meta.name === main ? {} : { bundledIn: main }) });
  }
  writeFileSync(path.join(vendor, target, 'LICENSES.txt'), licenses.join('\n\n'));
}

await bundle(require.resolve('pptxgenjs'), 'pptxgenjs', 'pptxgen.cjs', 'pptxgenjs');
await bundle(path.join(root, 'scripts', 'entries', 'mcp-client.mjs'), 'mcp', 'mcp-client.cjs', '@modelcontextprotocol/sdk');

writeFileSync(path.join(vendor, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

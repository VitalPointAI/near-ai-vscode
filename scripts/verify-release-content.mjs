import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const vsixPath = resolve(root, `${packageJson.name}-${packageJson.version}.vsix`);

function fail(message) {
  console.error(`Release content verification failed: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(vsixPath)) {
  fail(`expected package ${vsixPath} does not exist`);
  process.exit();
}

let entries;
try {
  entries = execFileSync('unzip', ['-Z1', vsixPath], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
} catch (error) {
  try {
    entries = listZipCentralDirectory(vsixPath);
  } catch (fallbackError) {
    fail(`could not list ${vsixPath} with the local unzip tool or ZIP parser: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    process.exit();
  }
}

function listZipCentralDirectory(file) {
  const archive = readFileSync(file);
  const minimumEndRecord = 22;
  const searchStart = Math.max(0, archive.length - 65_557);
  let endRecord = -1;
  for (let offset = archive.length - minimumEndRecord; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { endRecord = offset; break; }
  }
  if (endRecord < 0) throw new Error('ZIP end-of-central-directory record was not found');
  const directorySize = archive.readUInt32LE(endRecord + 12);
  const directoryOffset = archive.readUInt32LE(endRecord + 16);
  const entries = [];
  let offset = directoryOffset;
  const end = directoryOffset + directorySize;
  while (offset < end) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error(`invalid ZIP central-directory record at byte ${offset}`);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push(archive.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end || entries.length === 0) throw new Error('ZIP central-directory bounds were invalid');
  return entries;
}

const entrySet = new Set(entries);
const required = [
  'extension/package.json',
  'extension/readme.md',
  'extension/SECURITY.md',
  'extension/LICENSE.txt',
  'extension/media/near-ai-vscode-icon-128.png',
  'extension/media/near-ai-vscode-icon.svg',
  'extension/dist/extension.js',
  'extension/media/chat/chat.js',
  'extension/media/chat/chat.css',
  'extension/media/chat/markdown.js',
  'extension/media/chat/tables.js',
  'extension/media/chat/pending.js',
  'extension/media/chat/composer.js',
  'extension/media/chat/setup.js',
  'extension/docs/marketplace/near-ai-chat.png',
  'extension/docs/marketplace/near-ai-commands.png',
  'extension/docs/marketplace/near-ai-approval.png',
  'extension/vendor/pdfjs/pdf.min.mjs',
  'extension/vendor/pdfjs/pdf.worker.min.mjs',
  'extension/vendor/pdfjs/LICENSE',
  'extension/vendor/resvg/resvg.js',
  'extension/vendor/resvg/resvg.wasm',
  'extension/vendor/resvg/NOTICE',
  'extension/vendor/imagetracer/imagetracer.js',
  'extension/vendor/imagetracer/LICENSE',
  'extension/vendor/pptxgenjs/pptxgen.cjs',
  'extension/vendor/pptxgenjs/LICENSES.txt',
  'extension/vendor/fonts/DejaVuSans.ttf',
  'extension/vendor/fonts/DejaVuSans-Bold.ttf',
  'extension/vendor/fonts/LICENSE',
  'extension/vendor/manifest.json',
  'extension/vendor/mcp/mcp-client.cjs',
  'extension/vendor/mcp/LICENSES.txt',
  'extension/media/shared/base.css',
  'extension/media/activity/activity.js',
  'extension/media/activity/activity.css',
  'extension/media/mcp/mcp.js',
  'extension/media/mcp/mcp.css',
  'extension/media/onboarding/onboarding.css',
  'extension/media/tools/tools.js',
  'extension/media/tools/tools.css',
  'extension/media/teams/teams.js',
  'extension/media/teams/teams.css',
  'extension/media/compare/compare.js',
  'extension/media/compare/compare.css',
  // The Staff Room page and the COP map component; declutter.js is the SVG maps' shared label placement, which both maps need.
  'extension/media/staff/declutter.js',
  'extension/media/staff/layerDrawer.js',
  'extension/media/staff/copMap.js',
  'extension/media/staff/copMap.css',
  'extension/media/staffRoom/staffMap.js',
  'extension/media/staffRoom/staffRoom.js',
  'extension/media/staffRoom/staffRoom.css',
  'extension/resources/benchmark/execution/execute-plan/task.json',
  'extension/resources/benchmark/execution/issue-fix/hidden/report.test.js',
  'extension/resources/benchmark/execution/spec-implement/start/SPEC.md',
  // The staff teams' starter scenario, read at run time by NEAR AI: Load Staff Exercise Scenario and the staff setup.
  'extension/resources/staff/scenarios/iron-lantern.json',
  // The starter scenario's synthetic terrain and weather pack, read by the COP map (src/staff/envPack.ts).
  'extension/resources/staff/env/iron-lantern/manifest.json',
  'extension/resources/staff/env/iron-lantern/dem.json',
  'extension/resources/staff/env/iron-lantern/coastline.geojson',
  'extension/resources/staff/env/iron-lantern/weather.json',
  // Pack version 2 and the globe (the COP map's imagery, 3D terrain and topographic bases): land cover, the tile indexes and the data record.
  'extension/resources/staff/env/iron-lantern/landcover.geojson',
  'extension/resources/staff/env/iron-lantern/tiles/index.json',
  'extension/media/map/globe/index.json',
  'extension/media/map/globe/DATA.json',
  'extension/sbom.cdx.json',
  'extension/docs/marketplace/near-ai-workflow.png'
];
const missing = required.filter((entry) => !entrySet.has(entry));
if (missing.length > 0) fail(`required entries are missing: ${missing.join(', ')}`);

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) files.push(...walk(path));
    else if (item.isFile()) files.push(path);
  }
  return files;
}

const runtimeJavaScript = walk(resolve(root, 'dist'))
  .filter((file) => file.endsWith('.js'))
  .filter((file) => !relative(root, file).startsWith('dist/test/'));
if (runtimeJavaScript.length === 0) fail('no compiled runtime JavaScript files were found under dist');
const missingRuntime = runtimeJavaScript
  .map((file) => `extension/${relative(root, file).replaceAll('\\', '/')}`)
  .filter((entry) => !entrySet.has(entry));
if (missingRuntime.length > 0) fail(`compiled runtime JavaScript is missing: ${missingRuntime.join(', ')}`);

const forbiddenPatterns = [
  /^extension\/(?:\.codex|\.agents|\.planning|\.github|\.claude)(?:\/|$)/,
  /^extension\/(?:src|test|scripts|node_modules)(?:\/|$)/,
  /^extension\/relay(?:\/|$)/,
  /^extension\/\.dockerignore$/,
  /^extension\/dist\/test(?:\/|$)/,
  /\.map$/,
  /(?:^|\/)\.[^/]+\.tsbuildinfo$/,
  /(?:^|\/)[^/]+\.ts$/,
  /^extension\/(?:tsconfig\.json|package-lock\.json|\.gitignore)$/,
  /^extension\/resources\/benchmark\/.*\/reference(?:\/|$)/,
  /^extension\/\.git(?:-real)?(?:\/|$)/,
  /^extension\/media\/shared\/layout-probe\.js$/
];
const forbidden = entries.filter((entry) => forbiddenPatterns.some((pattern) => pattern.test(entry)));
if (forbidden.length > 0) fail(`development or source artifacts are present: ${forbidden.join(', ')}`);

// The COP map's vendored libraries (media/vendor/VENDORED.json): every recorded file must be in the
// package with exactly the bytes whose SHA-256 the manifest records, so a substituted copy cannot ship.
// src/test/staffCopSymbols.test.ts checks the same hashes on the working tree.
const vendored = JSON.parse(readFileSync(resolve(root, 'media/vendor/VENDORED.json'), 'utf8'));
const vendoredFiles = Object.entries(vendored.files ?? {});
if (vendoredFiles.length === 0) fail('media/vendor/VENDORED.json records no files');
for (const [file, hash] of vendoredFiles) {
  const entry = `extension/media/vendor/${file}`;
  if (!entrySet.has(entry)) { fail(`vendored file is missing from the package: ${entry}`); continue; }
  let bytes;
  try {
    bytes = execFileSync('unzip', ['-p', vsixPath, entry], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    fail(`could not read ${entry} from the package to check its hash: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== hash) fail(`vendored file ${entry} does not match its recorded hash (${actual} != ${hash})`);
}

// The map tiles: every tile each packaged index lists is in the package with the size and hash the index records, and nothing unlisted is.
const tileFolders = ['extension/media/map/globe', 'extension/resources/staff/env/iron-lantern/tiles'];
const scratch = mkdtempSync(resolve(tmpdir(), 'near-vsix-tiles-'));
try {
  execFileSync('unzip', ['-q', vsixPath, ...tileFolders.map((folder) => `${folder}/*`), '-d', scratch], { cwd: root });
  for (const folder of tileFolders) {
    const index = JSON.parse(readFileSync(resolve(scratch, folder, 'index.json'), 'utf8'));
    const listed = new Set([`${folder}/index.json`, `${folder}/DATA.json`]);
    for (const [setId, set] of Object.entries(index.sets)) for (const [path, bytes, sha] of set.tiles) {
      const entry = `${folder}/${setId}/${path}.${set.format}`;
      listed.add(entry);
      let data;
      try { data = readFileSync(resolve(scratch, entry)); } catch { fail(`packaged tile ${entry} is missing`); continue; }
      if (data.length !== bytes || createHash('sha256').update(data).digest('hex') !== sha) fail(`packaged tile ${entry} does not match its index`);
    }
    const strays = entries.filter((entry) => entry.startsWith(`${folder}/`) && !entry.endsWith('/') && !listed.has(entry));
    if (strays.length) fail(`files in ${folder} that no index lists: ${strays.slice(0, 5).join(', ')}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

// The size gate (research note on the map tiles, section 6): the package stays at most 14 MiB and 4,000 files.
const VSIX_MAX_BYTES = 14 * 1024 * 1024;
const VSIX_MAX_ENTRIES = 4000;
const vsixBytes = statSync(vsixPath).size;
if (vsixBytes > VSIX_MAX_BYTES) fail(`the package is ${vsixBytes} bytes, over the ${VSIX_MAX_BYTES}-byte gate`);
if (entries.length > VSIX_MAX_ENTRIES) fail(`the package has ${entries.length} entries, over the ${VSIX_MAX_ENTRIES}-entry gate`);

if (packageJson.main !== './dist/extension.js') fail(`package.json main must remain ./dist/extension.js, got ${packageJson.main}`);

if (process.exitCode) process.exit();
console.log(`Release content verified: ${entries.length} entries (${(vsixBytes / 1048576).toFixed(2)} MiB), ${runtimeJavaScript.length} runtime JavaScript files, and ${required.length} required release assets.`);

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
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
  'extension/docs/marketplace/near-ai-chat.png',
  'extension/docs/marketplace/near-ai-commands.png',
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
  /^extension\/(?:\.codex|\.agents|\.planning)(?:\/|$)/,
  /^extension\/(?:src|test|scripts|node_modules)(?:\/|$)/,
  /^extension\/dist\/test(?:\/|$)/,
  /\.map$/,
  /(?:^|\/)\.[^/]+\.tsbuildinfo$/,
  /(?:^|\/)[^/]+\.ts$/,
  /^extension\/(?:tsconfig\.json|package-lock\.json|\.gitignore)$/,
  /^extension\/\.git(?:-real)?(?:\/|$)/
];
const forbidden = entries.filter((entry) => forbiddenPatterns.some((pattern) => pattern.test(entry)));
if (forbidden.length > 0) fail(`development or source artifacts are present: ${forbidden.join(', ')}`);

if (packageJson.main !== './dist/extension.js') fail(`package.json main must remain ./dist/extension.js, got ${packageJson.main}`);

if (process.exitCode) process.exit();
console.log(`Release content verified: ${entries.length} entries, ${runtimeJavaScript.length} runtime JavaScript files, and ${required.length} required release assets.`);

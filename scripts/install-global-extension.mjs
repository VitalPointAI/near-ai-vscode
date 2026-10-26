import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const vsix = resolve(root, `${manifest.name}-${manifest.version}.vsix`);
if (!existsSync(vsix)) {
  console.error(`Missing ${vsix}. Run npm run verify:release first.`);
  process.exit(1);
}

for (const executable of ['code-server', 'code', 'codium']) {
  try {
    execFileSync(executable, ['--install-extension', vsix, '--force'], { cwd: root, stdio: 'inherit' });
    console.log(`Installed ${manifest.publisher}.${manifest.name} ${manifest.version} through ${executable}.`);
    console.log('The extension is global for that code-server/VS Code profile and is available across its projects.');
    process.exit(0);
  } catch {
    // Try the next supported VS Code-compatible CLI.
  }
}

console.error('No code-server, code, or codium CLI was available in this environment.');
console.error('Run this from the code-server host after packaging:');
console.error(`  code-server --install-extension ${vsix} --force`);
process.exit(2);

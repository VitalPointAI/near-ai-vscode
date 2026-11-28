import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const [output, ...rest] = process.argv.slice(2);
if (!output || rest.length !== 0 || !process.env.TMPDIR || !path.isAbsolute(process.env.TMPDIR) ||
    realpathSync(output) !== realpathSync(process.env.TMPDIR) ||
    path.relative(root, realpathSync(output)).split(path.sep)[0] !== '..') {
  throw new Error('The hub fixture build requires its isolated scratch directory.');
}
const requireFromHub = createRequire(path.join(root, 'hub', 'package.json'));
const { build } = requireFromHub('esbuild');
const version = JSON.parse(readFileSync(path.join(root, 'hub', 'package.json'), 'utf8')).version;
await build({
  absWorkingDir: root,
  tsconfig: 'hub/tsconfig.json',
  entryPoints: {
    'hub-smoke': 'loadtest/hub-driver/hub.integration.ts',
    'hub-worker': 'loadtest/hub-driver/driver.ts'
  },
  outdir: output,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  define: { __HUB_VERSION__: JSON.stringify(version) }
});

// Copies pdf.js (a devDependency) into vendor/pdfjs, which ships in the VSIX: the extension is
// packaged without node_modules. Run as part of `npm run compile`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve('pdfjs-dist/package.json'));
const target = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'vendor', 'pdfjs');
mkdirSync(target, { recursive: true });
for (const file of ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs', 'LICENSE']) copyFileSync(path.join(pkg, file), path.join(target, path.basename(file)));

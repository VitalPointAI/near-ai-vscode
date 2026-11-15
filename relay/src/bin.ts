// Guard entry (D-02). It checks the Node version first and only then loads the app, so an older Node prints one plain sentence instead of
// failing on a module it does not have. The app path sits in a variable so neither tsc nor esbuild follows it into the bundle.
import { checkNodeVersion } from './nodeVersion';

const refusal = checkNodeVersion(process.versions.node);
if (refusal) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}

const entry = './app.mjs';
const app = (await import(entry)) as { main(argv: readonly string[]): Promise<void> };
try {
  await app.main(process.argv.slice(2));
} catch {
  // No output path exists before the redacting logger (D-11); a failed start is an exit code only.
  process.exit(1);
}
